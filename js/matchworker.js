// Web Worker: OpenCV.js template matching off the main thread.
// Messages in:  { type:'init', ref: ImageBitmap }
//               { type:'locate', shot: ImageBitmap, mode: 'map'|'full' }
// Messages out: { type:'ready' } | { type:'progress', f } |
//               { type:'result', rect|null } | { type:'error', message }

const REF_W = 1000;

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

let refEdges = null;
let refScale = 0;
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

function toEdges(cv, imageData, dilatePx) {
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
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

async function locate(shot, mode) {
  const cv = await getCV();

  if (!refEdges) {
    refScale = REF_W / refBitmap.width;
    const id = bitmapToImageData(refBitmap, REF_W, refBitmap.height * refScale);
    refEdges = toEdges(cv, id, 3);
  }

  const crop = mode === 'full'
    ? { l: 0.03, t: 0.03, r: 0.03, b: 0.03 }
    : { l: 0.06, t: 0.08, r: 0.06, b: 0.08 };
  const cropW = 1 - crop.l - crop.r;
  const aspect = (shot.height * (1 - crop.t - crop.b)) / (shot.width * cropW);

  const [lo, hi] = mode === 'full' ? [0.55, 1.0] : [0.12, 0.45];
  const steps = mode === 'full' ? 8 : 12;
  const widths = [];
  for (let i = 0; i < steps; i++) widths.push(REF_W * (lo + (i / (steps - 1)) * (hi - lo)));

  let best = null;
  for (let i = 0; i < widths.length; i++) {
    const tw = Math.round(widths[i]);
    const th = Math.round(tw * aspect);
    if (tw >= refEdges.cols || th >= refEdges.rows || tw < 24 || th < 24) {
      self.postMessage({ type: 'progress', f: (i + 1) / widths.length });
      continue;
    }
    const tmpl = toEdges(cv, bitmapToImageData(shot, tw, th, crop), 2);
    const result = new cv.Mat();
    cv.matchTemplate(refEdges, tmpl, result, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(result);
    if (!best || mm.maxVal > best.score) {
      best = { score: mm.maxVal, mx: mm.maxLoc.x, my: mm.maxLoc.y, tw };
    }
    tmpl.delete(); result.delete();
    self.postMessage({ type: 'progress', f: (i + 1) / widths.length });
  }

  if (!best) return null;

  const t = best.tw / (shot.width * cropW); // shot px -> ref px
  const k = t / refScale;                   // shot px -> map px
  return {
    x: best.mx / refScale - shot.width * crop.l * k,
    y: best.my / refScale - shot.height * crop.t * k,
    w: shot.width * k,
    h: shot.height * k,
    score: best.score,
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
