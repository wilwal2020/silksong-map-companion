// Web Worker: OpenCV.js screenshot-to-map matching off the main thread.
//
// Strategy: raw-pixel edge detection drowns in the in-game map's canvas
// texture and color grading. Instead, both sides are reduced to CONTENT
// MASKS — "is something drawn here or is it background?" — and the
// boundaries of those masks are template-matched. That is invariant to the
// style differences between an in-game screenshot (tinted, textured, icons)
// and the clean reference map, and it lets room outlines AND area-name text
// act as alignment features.
//
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
  for (let i = 0; i < 400 && !(self.cv && self.cv.Mat); i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  if (!self.cv || !self.cv.Mat) throw new Error('OpenCV failed to initialize');
  // strip the fake `then` so returning cv from async functions can't adopt it
  if (typeof self.cv.then === 'function') { try { delete self.cv.then; } catch (e) {} }
  return self.cv;
}

let refBitmap = null;
let refMask1 = null;  // prepped reference at REF_W
let refMask2 = null;  // prepped reference at REF_W2
let refScale1 = 0, refScale2 = 0;

function bitmapToImageData(bmp, w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// fill regions fully enclosed by content (room interiors): flood from the
// border through non-content; unreached non-content is inside a room
function fillEnclosed(mask, W, H) {
  const seen = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  let head = 0, tail = 0;
  const push = p => { if (!mask[p] && !seen[p]) { seen[p] = 1; q[tail++] = p; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (head < tail) {
    const p = q[head++];
    const x = p % W;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (p >= W) push(p - W);
    if (p < W * (H - 1)) push(p + W);
  }
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] && !seen[p]) mask[p] = 255;
  }
  return mask;
}

// binary "something is drawn here" mask against a LOCAL background estimate
// (the shot heavily downscaled and stretched back) — robust to the bright,
// vignetted in-game backgrounds where a single dominant color fails
function binaryContentMask(cv, shot, W, H) {
  const id = bitmapToImageData(shot, W, H);
  const d = id.data;

  const bs = new OffscreenCanvas(Math.max(1, Math.round(W / 20)), Math.max(1, Math.round(H / 20)));
  bs.getContext('2d').drawImage(shot, 0, 0, bs.width, bs.height);
  const bc = new OffscreenCanvas(W, H);
  const bctx = bc.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(bs, 0, 0, W, H);
  const b = bctx.getImageData(0, 0, W, H).data;

  const TH = 1800;
  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    const dr = d[i] - b[i], dg = d[i + 1] - b[i + 1], db = d[i + 2] - b[i + 2];
    mask[p] = (dr * dr + dg * dg + db * db > TH) ? 255 : 0;
  }

  // close dashed outlines, then fill room interiors so rooms are solid
  const m = new cv.Mat(H, W, cv.CV_8UC1);
  m.data.set(mask);
  cv.GaussianBlur(m, m, new cv.Size(5, 5), 0);
  cv.threshold(m, m, 80, 255, cv.THRESH_BINARY);
  mask.set(m.data);
  m.delete();
  fillEnclosed(mask, W, H);
  return mask;
}

// crop a region of a Uint8Array mask into a cv 8UC1 Mat
function maskToMat(cv, mask, stride, rect) {
  const m = new cv.Mat(rect.h, rect.w, cv.CV_8UC1);
  for (let y = 0; y < rect.h; y++) {
    const off = (rect.y + y) * stride + rect.x;
    m.data.set(mask.subarray(off, off + rect.w), y * rect.w);
  }
  return m;
}

// binary mask -> matchable image: boundaries of the drawn content, blurred
// for tolerance (gradient normalizes "outlined rooms" in the screenshot vs
// "filled rooms" on the reference to the same thing: content borders)
function prepMask(cv, bin) {
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  cv.morphologyEx(bin, bin, cv.MORPH_GRADIENT, k);
  k.delete();
  cv.GaussianBlur(bin, bin, new cv.Size(5, 5), 0);
  return bin;
}

function scaledTemplate(cv, tmplBase, tw, th) {
  const r = new cv.Mat();
  cv.resize(tmplBase, r, new cv.Size(tw, th), 0, 0, cv.INTER_AREA);
  // low threshold: thin room outlines average down to faint values when the
  // template shrinks a lot — a high cutoff made them vanish entirely
  cv.threshold(r, r, 20, 255, cv.THRESH_BINARY);
  return prepMask(cv, r);
}

// empty border around the reference (12% of its width) so a template as big
// as the whole map still fits, and content near the map edges can match
const PAD_FRAC = 0.12;

function refMaskAt(cv, width) {
  const sc = width / refBitmap.width;
  const id = bitmapToImageData(refBitmap, width, refBitmap.height * sc);
  const src = cv.matFromImageData(id);
  const g = new cv.Mat();
  cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
  src.delete();
  cv.threshold(g, g, 14, 255, cv.THRESH_BINARY);
  prepMask(cv, g);
  const pad = Math.round(width * PAD_FRAC);
  const padded = new cv.Mat();
  cv.copyMakeBorder(g, padded, pad, pad, pad, pad, cv.BORDER_CONSTANT, new cv.Scalar(0));
  g.delete();
  return padded;
}

function ensureRefs(cv) {
  if (!refMask1) {
    refScale1 = REF_W / refBitmap.width;
    refMask1 = refMaskAt(cv, REF_W);
  }
  if (!refMask2) {
    const w2 = Math.min(REF_W2, refBitmap.width);
    refScale2 = w2 / refBitmap.width;
    refMask2 = refMaskAt(cv, w2);
  }
}

// peak + the correlation map's own statistics: z = (max - mean) / std is
// comparable ACROSS template scales, unlike raw NCC (small templates peak
// high by chance, large ones accumulate weight — both misrank)
function matchAt(cv, ref, tmpl) {
  const result = new cv.Mat();
  cv.matchTemplate(ref, tmpl, result, cv.TM_CCOEFF_NORMED);
  const mm = cv.minMaxLoc(result);
  const mean = new cv.Mat(), std = new cv.Mat();
  cv.meanStdDev(result, mean, std);
  const z = std.data64F[0] > 1e-6 ? (mm.maxVal - mean.data64F[0]) / std.data64F[0] : 0;
  mean.delete(); std.delete(); result.delete();
  return { score: mm.maxVal, x: mm.maxLoc.x, y: mm.maxLoc.y, z };
}

async function locate(shot, mode, hint) {
  // hint = expected map-px per screenshot-px (from the player marker's size
  // or a previously confirmed match); collapses the search to position-only
  const cv = await getCV();
  ensureRefs(cv);

  const baseW = Math.min(1400, shot.width);
  const baseH = Math.round(shot.height * baseW / shot.width);
  const mask = binaryContentMask(cv, shot, baseW, baseH);

  // sanity: a map screenshot is structure over background — if nearly the
  // whole frame is "content", this is not a map screenshot
  let denseCount = 0;
  for (let p = 0; p < mask.length; p++) if (mask[p]) denseCount++;
  if (denseCount / mask.length > 0.85) return null;

  // decide which part of the screenshot to match with
  let rect;
  if (mode === 'full') {
    // crop to the drawn content's bounding box — a full-map screenshot has
    // big empty background margins that would otherwise break the scale search
    let minX = baseW, maxX = -1, minY = baseH, maxY = -1;
    for (let y = 0; y < baseH; y++) {
      for (let x = 0; x < baseW; x++) {
        if (mask[y * baseW + x]) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX - minX < 60 || maxY - minY < 60) return null; // nothing drawn
    const pad = Math.round(baseW * 0.015);
    rect = {
      x: Math.max(0, minX - pad),
      y: Math.max(0, minY - pad),
      w: Math.min(baseW, maxX + pad) - Math.max(0, minX - pad),
      h: Math.min(baseH, maxY + pad) - Math.max(0, minY - pad),
    };
  } else {
    // fixed margins to trim HUD / window borders
    rect = {
      x: Math.round(baseW * 0.06), y: Math.round(baseH * 0.08),
      w: Math.round(baseW * 0.88), h: Math.round(baseH * 0.84),
    };
  }

  const tmplBase = maskToMat(cv, mask, baseW, rect);
  const aspect = rect.h / rect.w;

  // ---- pass 1: coarse multi-scale search over the whole map ----
  // with a scale hint the band is narrow (position search, basically) and
  // small regions are matched against the high-res reference for detail;
  // without a hint, a wide geometric sweep over the low-res reference
  let coarseRef = refMask1;
  let coarseScale = refScale1;
  const widths = [];
  let steps;
  if (hint && mode === 'map') {
    const croppedMapW = (rect.w / baseW) * shot.width * hint.k; // map px
    let tw2pred = croppedMapW * refScale2;
    if (tw2pred <= 480) { coarseRef = refMask2; coarseScale = refScale2; }
    const pred = croppedMapW * coarseScale;
    // marker-derived hints are accurate within ~3%; learned-scale hints
    // less so (the in-game map can be zoomed between sessions)
    const [blo, bhi] = hint.tight ? [0.93, 1.09] : [0.85, 1.18];
    steps = hint.tight ? 5 : 7;
    for (let i = 0; i < steps; i++) {
      widths.push(pred * blo * Math.pow(bhi / blo, i / (steps - 1)));
    }
  } else {
    const [lo, hi] = mode === 'full' ? [0.35, 1.05] : [0.05, 0.55];
    steps = mode === 'full' ? 13 : 20;
    for (let i = 0; i < steps; i++) {
      widths.push(mode === 'full'
        ? REF_W * (lo + (i / (steps - 1)) * (hi - lo))
        : REF_W * lo * Math.pow(hi / lo, i / (steps - 1)));
    }
  }

  let best = null;
  for (let i = 0; i < steps; i++) {
    const tw = Math.round(widths[i]);
    const th = Math.round(tw * aspect);
    if (tw < 24 || th < 24 || tw >= coarseRef.cols || th >= coarseRef.rows) {
      self.postMessage({ type: 'progress', f: 0.7 * (i + 1) / steps });
      continue;
    }
    const tmpl = scaledTemplate(cv, tmplBase, tw, th);
    const m = matchAt(cv, coarseRef, tmpl);
    tmpl.delete();
    if (!best || m.z > best.z) best = { z: m.z, score: m.score, mx: m.x, my: m.y, tw, th };
    self.postMessage({ type: 'progress', f: 0.7 * (i + 1) / steps });
  }
  if (!best) { tmplBase.delete(); return null; }

  // ---- distinctiveness: a genuine match has ONE dominant peak; suppress a
  // window around the best hit and compare against the runner-up. Random or
  // ambiguous content produces many rival peaks -> ratio near 1.
  let ratio = 1;
  {
    const tmpl = scaledTemplate(cv, tmplBase, best.tw, best.th);
    const result = new cv.Mat();
    cv.matchTemplate(coarseRef, tmpl, result, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(result);
    const sx = Math.max(0, mm.maxLoc.x - Math.round(best.tw * 0.4));
    const sy = Math.max(0, mm.maxLoc.y - Math.round(best.th * 0.4));
    const sw = Math.min(result.cols - sx, Math.round(best.tw * 0.8));
    const sh = Math.min(result.rows - sy, Math.round(best.th * 0.8));
    if (sw > 0 && sh > 0) {
      const roi = result.roi(new cv.Rect(sx, sy, sw, sh));
      roi.setTo(new cv.Scalar(-1));
      roi.delete();
    }
    const mm2 = cv.minMaxLoc(result);
    ratio = mm.maxVal > 0 ? Math.max(0, mm2.maxVal) / mm.maxVal : 1;
    tmpl.delete(); result.delete();
  }

  // ---- pass 2: refine scale & position at higher resolution ----
  const up = refScale2 / coarseScale;
  const cx2 = (best.mx + best.tw / 2) * up;
  const cy2 = (best.my + best.th / 2) * up;
  let fine = null;
  // with a trusted scale hint the coarse scale is already near-exact — keep
  // the refinement from drifting away from it
  const ks = (hint && hint.tight && mode === 'map')
    ? [0.95, 0.975, 1.0, 1.025, 1.05]
    : [0.86, 0.89, 0.92, 0.95, 0.975, 1.0, 1.025, 1.05, 1.08, 1.11, 1.145];
  for (let i = 0; i < ks.length; i++) {
    const tw2 = Math.round(best.tw * up * ks[i]);
    const th2 = Math.round(tw2 * aspect);
    const padX = Math.round(tw2 * 0.35), padY = Math.round(th2 * 0.35);
    const x0 = Math.max(0, Math.round(cx2 - tw2 / 2 - padX));
    const y0 = Math.max(0, Math.round(cy2 - th2 / 2 - padY));
    const x1 = Math.min(refMask2.cols, Math.round(cx2 + tw2 / 2 + padX));
    const y1 = Math.min(refMask2.rows, Math.round(cy2 + th2 / 2 + padY));
    if (tw2 < 24 || th2 < 24 || tw2 > x1 - x0 || th2 > y1 - y0) {
      self.postMessage({ type: 'progress', f: 0.7 + 0.3 * (i + 1) / ks.length });
      continue;
    }
    const roi = refMask2.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
    const tmpl = scaledTemplate(cv, tmplBase, tw2, th2);
    const m = matchAt(cv, roi, tmpl);
    roi.delete(); tmpl.delete();
    // within the refine window scales are near-identical — raw score is fair
    if (!fine || m.score > fine.score) {
      fine = { score: m.score, mx: x0 + m.x, my: y0 + m.y, tw: tw2 };
    }
    self.postMessage({ type: 'progress', f: 0.7 + 0.3 * (i + 1) / ks.length });
  }
  tmplBase.delete();

  // map back to full map coordinates for the complete (uncropped) screenshot
  // (match coordinates are in the PADDED reference frame — subtract the pad;
  // PAD2 = PAD1 * up exactly, so coarse->fine coordinate scaling stays valid)
  const pad2 = Math.round(Math.min(REF_W2, refBitmap.width) * PAD_FRAC);
  const pick = fine || { score: best.score, mx: best.mx * up, my: best.my * up, tw: best.tw * up };
  const cl = rect.x / baseW, ct = rect.y / baseH, cwf = rect.w / baseW;
  const t = pick.tw / (shot.width * cwf); // shot px -> ref2 px
  const k = t / refScale2;                // shot px -> map px
  return {
    x: (pick.mx - pad2) / refScale2 - shot.width * cl * k,
    y: (pick.my - pad2) / refScale2 - shot.height * ct * k,
    w: shot.width * k,
    h: shot.height * k,
    score: pick.score,
    z: best.z, // peak height in std-devs of the coarse correlation map
    ratio,     // runner-up peak / best peak — lower is more trustworthy
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
      const rect = await locate(msg.shot, msg.mode, msg.hint || null);
      msg.shot.close?.();
      self.postMessage({ type: 'result', rect });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
