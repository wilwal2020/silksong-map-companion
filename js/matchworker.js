// Web Worker: OpenCV.js template matching off the main thread.
// Messages in:  { type:'init', ref: ImageBitmap }
//               { type:'locate', shot: ImageBitmap, mode: 'map'|'full' }
// Messages out: { type:'ready' } | { type:'progress', f } |
//               { type:'result', rect|null } | { type:'error', message }

const REF_W = 1000;   // coarse search resolution
const REF_W2 = 2200;  // refinement resolution

let cvReadyResolve;
// IMPORTANT: never resolve this promise WITH the cv object — opencv.js exposes
// a non-compliant thenable (the Emscripten Module itself) and letting a real
// promise adopt it hangs forever. Resolve with no value; read self.cv after.
const cvReady = new Promise(r => (cvReadyResolve = r));

self.Module = { onRuntimeInitialized: () => cvReadyResolve() };
try {
  importScripts('../vendor/opencv.js');
  if (self.cv && typeof self.cv.then === 'function') {
    self.cv.then(m => { self.cv = m; cvReadyResolve(); });
  } else if (self.cv && self.cv.Mat) {
    cvReadyResolve();
  }
} catch (e) {
  self.postMessage({ type: 'error', message: 'Could not load OpenCV: ' + e.message });
}

async function getCV() {
  await cvReady;
  // belt & braces: wait until the bindings are actually registered
  for (let i = 0; i < 400 && !(self.cv && self.cv.Mat); i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  if (!self.cv || !self.cv.Mat) throw new Error('OpenCV failed to initialize');
  // strip the fake `then` so returning cv from async functions can't adopt it
  if (typeof self.cv.then === 'function') { try { delete self.cv.then; } catch (e) {} }
  return self.cv;
}

let refEdges = null, refScale = 0;   // coarse
let refEdges2 = null, refScale2 = 0; // fine
let refBitmap = null;

function bitmapToImageData(bmp, w, h, crop = { l: 0, t: 0, r: 0, b: 0 }) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  const sx = bmp.width * crop.l, sy = bmp.height * crop.t;
  const sw = bmp.width * (1 - crop.l - crop.r), sh = bmp.height * (1 - crop.t - crop.b);
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function toEdges(cv, imageData, dilatePx, normalize = false) {
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  if (normalize) {
    // in-game map screenshots are dark and low-contrast — stretch the range
    // so Canny finds the room outlines
    cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
  }
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 60, 180);
  if (dilatePx > 0) {
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(dilatePx, dilatePx));
    cv.dilate(edges, edges, kernel);
    kernel.delete();
  }
  src.delete(); gray.delete();
  return edges; // CV_8U
}

function ensureRefs(cv) {
  if (!refEdges) {
    refScale = REF_W / refBitmap.width;
    refEdges = toEdges(cv, bitmapToImageData(refBitmap, REF_W, refBitmap.height * refScale), 3);
  }
  if (!refEdges2) {
    const w2 = Math.min(REF_W2, refBitmap.width);
    refScale2 = w2 / refBitmap.width;
    refEdges2 = toEdges(cv, bitmapToImageData(refBitmap, w2, refBitmap.height * refScale2), 3);
  }
}

function matchAt(cv, ref, tmpl) {
  const result = new cv.Mat();
  cv.matchTemplate(ref, tmpl, result, cv.TM_CCOEFF_NORMED);
  const mm = cv.minMaxLoc(result);
  result.delete();
  return { score: mm.maxVal, x: mm.maxLoc.x, y: mm.maxLoc.y };
}

async function locate(shot, mode) {
  const cv = await getCV();
  ensureRefs(cv);

  const crop = mode === 'full'
    ? { l: 0.03, t: 0.03, r: 0.03, b: 0.03 }
    : { l: 0.06, t: 0.08, r: 0.06, b: 0.08 };
  const cropW = 1 - crop.l - crop.r;
  const aspect = (shot.height * (1 - crop.t - crop.b)) / (shot.width * cropW);

  // ---- pass 1: coarse multi-scale search over the whole map ----
  const [lo, hi] = mode === 'full' ? [0.55, 1.02] : [0.10, 0.50];
  const steps = mode === 'full' ? 9 : 14;
  const widths = [];
  for (let i = 0; i < steps; i++) widths.push(REF_W * (lo + (i / (steps - 1)) * (hi - lo)));

  let best = null;
  for (let i = 0; i < widths.length; i++) {
    const tw = Math.round(widths[i]);
    const th = Math.round(tw * aspect);
    if (tw < 24 || th < 24 || tw >= refEdges.cols || th >= refEdges.rows) {
      self.postMessage({ type: 'progress', f: 0.7 * (i + 1) / steps });
      continue;
    }
    const tmpl = toEdges(cv, bitmapToImageData(shot, tw, th, crop), 2, true);
    const m = matchAt(cv, refEdges, tmpl);
    tmpl.delete();
    if (!best || m.score > best.score) best = { score: m.score, mx: m.x, my: m.y, tw, th };
    self.postMessage({ type: 'progress', f: 0.7 * (i + 1) / steps });
  }
  if (!best) return null;

  // ---- pass 2: refine scale & position at higher resolution ----
  // search a tight window around the coarse hit with fine scale steps —
  // this is what nails the exact zoom level of the screenshot
  const up = refScale2 / refScale;
  const cx2 = (best.mx + best.tw / 2) * up;
  const cy2 = (best.my + best.th / 2) * up;
  let fine = null;
  const ks = [0.90, 0.935, 0.965, 0.985, 1.0, 1.015, 1.035, 1.065, 1.10];
  for (let i = 0; i < ks.length; i++) {
    const tw2 = Math.round(best.tw * up * ks[i]);
    const th2 = Math.round(tw2 * aspect);
    const padX = Math.round(tw2 * 0.35), padY = Math.round(th2 * 0.35);
    const x0 = Math.max(0, Math.round(cx2 - tw2 / 2 - padX));
    const y0 = Math.max(0, Math.round(cy2 - th2 / 2 - padY));
    const x1 = Math.min(refEdges2.cols, Math.round(cx2 + tw2 / 2 + padX));
    const y1 = Math.min(refEdges2.rows, Math.round(cy2 + th2 / 2 + padY));
    if (tw2 < 24 || th2 < 24 || tw2 > x1 - x0 || th2 > y1 - y0) {
      self.postMessage({ type: 'progress', f: 0.7 + 0.3 * (i + 1) / ks.length });
      continue;
    }
    const roi = refEdges2.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
    const tmpl = toEdges(cv, bitmapToImageData(shot, tw2, th2, crop), 2, true);
    const m = matchAt(cv, roi, tmpl);
    roi.delete(); tmpl.delete();
    if (!fine || m.score > fine.score) {
      fine = { score: m.score, mx: x0 + m.x, my: y0 + m.y, tw: tw2 };
    }
    self.postMessage({ type: 'progress', f: 0.7 + 0.3 * (i + 1) / ks.length });
  }

  // map back to full map coordinates for the complete (uncropped) screenshot
  const pick = fine || { score: best.score, mx: best.mx * up, my: best.my * up, tw: best.tw * up };
  const t = pick.tw / (shot.width * cropW); // shot px -> ref2 px
  const k = t / refScale2;                  // shot px -> map px
  return {
    x: pick.mx / refScale2 - shot.width * crop.l * k,
    y: pick.my / refScale2 - shot.height * crop.t * k,
    w: shot.width * k,
    h: shot.height * k,
    score: pick.score,
  };
}

self.onmessage = async e => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      refBitmap = msg.ref;
      await getCV();
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'locate') {
      const rect = await locate(msg.shot, msg.mode);
      msg.shot.close?.();
      self.postMessage({ type: 'result', rect });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
