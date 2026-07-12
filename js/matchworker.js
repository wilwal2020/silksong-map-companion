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
//               { type:'refine', shot: ImageBitmap, rect, mode } — sub-pixel
//               polish of an already-applied placement (background pass)
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
let refFill = null;   // full-res binary "reference has content here" mask

// full-resolution fill mask of the reference: the arbiter for the one-sided
// overlap verification ("does what the screenshot shows land on rooms?")
function ensureRefFill() {
  if (refFill) return refFill;
  const W = refBitmap.width, H = refBitmap.height;
  const d = bitmapToImageData(refBitmap, W, H).data;
  refFill = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < refFill.length; i += 4, p++) {
    refFill[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) > 14 ? 1 : 0;
  }
  return refFill;
}

// the fill mask dilated ~3px, for fillRefine's fill-sanity check ONLY (the
// edge/boundary masks must stay undilated). Some regions (e.g. Wormways)
// draw rooms as thin outlines with black interiors — there the undilated
// fill is a 2px-wide target and a correct placement scored 0.44 against the
// 0.5 gate; 3px of tolerance lifts correct spots to 0.65+ while genuinely
// void neighbourhoods stay near 0.3.
let refFillDil = null;
function ensureRefFillDil() {
  if (refFillDil) return refFillDil;
  const W = refBitmap.width, H = refBitmap.height;
  let f = new Uint8Array(ensureRefFill());
  for (let pass = 0; pass < 3; pass++) {
    const d2 = new Uint8Array(f);
    for (let p = 0; p < f.length; p++) {
      if (f[p]) continue;
      const x = p % W;
      if ((x > 0 && f[p - 1]) || (x < W - 1 && f[p + 1])
          || (p >= W && f[p - W]) || (p < W * (H - 1) && f[p + W])) d2[p] = 1;
    }
    f = d2;
  }
  refFillDil = f;
  return refFillDil;
}

// reference content BOUNDARIES: sparse, structural, and the thing that
// actually discriminates one room layout from another (fill overlap alone
// accepts any roomy neighborhood)
let refEdgeRaw = null;
function ensureRefEdgeRaw() {
  if (refEdgeRaw) return refEdgeRaw;
  const fill = ensureRefFill();
  const W = refBitmap.width, H = refBitmap.height;
  const e = new Uint8Array(W * H);
  for (let p = 0; p < e.length; p++) {
    if (!fill[p]) continue;
    const x = p % W;
    if ((x > 0 && !fill[p - 1]) || (x < W - 1 && !fill[p + 1])
        || (p >= W && !fill[p - W]) || (p < W * (H - 1) && !fill[p + W])) e[p] = 1;
  }
  refEdgeRaw = e;
  return refEdgeRaw;
}

// the same boundaries dilated ~2px — tolerance for the coarse fillRefine
let refEdge = null;
function ensureRefEdge() {
  if (refEdge) return refEdge;
  const W = refBitmap.width, H = refBitmap.height;
  let e = new Uint8Array(ensureRefEdgeRaw());
  for (let pass = 0; pass < 2; pass++) {
    const d2 = new Uint8Array(e);
    for (let p = 0; p < e.length; p++) {
      if (e[p]) continue;
      const x = p % W;
      if ((x > 0 && e[p - 1]) || (x < W - 1 && e[p + 1])
          || (p >= W && e[p - W]) || (p < W * (H - 1) && e[p + W])) d2[p] = 1;
    }
    e = d2;
  }
  refEdge = e;
  return refEdge;
}

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
// vignetted in-game backgrounds where a single dominant color fails.
// Returns both the cleaned mask (closed + room interiors filled) and the raw
// threshold mask (individual letters survive there — used for text search).
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
  const raw = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < raw.length; i += 4, p++) {
    const dr = d[i] - b[i], dg = d[i + 1] - b[i + 1], db = d[i + 2] - b[i + 2];
    raw[p] = (dr * dr + dg * dg + db * db > TH) ? 255 : 0;
  }

  // close dashed outlines, then fill room interiors so rooms are solid
  const mask = new Uint8Array(raw);
  const m = new cv.Mat(H, W, cv.CV_8UC1);
  m.data.set(mask);
  cv.GaussianBlur(m, m, new cv.Size(5, 5), 0);
  cv.threshold(m, m, 80, 255, cv.THRESH_BINARY);
  mask.set(m.data);
  m.delete();
  fillEnclosed(mask, W, H);
  return { mask, raw };
}

// connected components of a binary mask, with size filters
function componentsOf(mask, W, H, minH, maxH, minArea) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let top = 0, area = 0, sx = 0, sy = 0;
    let minX = W, maxX = 0, minY = H, maxY = 0;
    stack[top++] = s; seen[s] = 1;
    while (top > 0) {
      const p = stack[--top];
      const x = p % W, y = (p / W) | 0;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (p >= W && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[top++] = p - W; }
      if (p < W * (H - 1) && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[top++] = p + W; }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    // letters sometimes merge into wide blobs (serif fonts, anti-aliasing) —
    // keep runs up to ~6 letter-heights wide and weight them accordingly
    if (h >= minH && h <= maxH && w <= maxH * 6 && area >= minArea) {
      out.push({ x: minX, y: minY, w, h, cx: sx / area, cy: sy / area, area });
    }
  }
  return out;
}

// group letter-sized components into horizontal text lines (area names)
function textBoxesFrom(mask, W, H, minLh, maxLh) {
  const comps = componentsOf(mask, W, H, minLh, maxLh, Math.max(8, minLh))
    .sort((a, b) => a.cx - b.cx);
  const chains = [];
  for (const c of comps) {
    let bestChain = null;
    for (const ch of chains) {
      const lh = ch.lh;
      if (Math.abs(c.cy - ch.cy) <= lh * 0.6 && c.x - ch.right <= lh * 2.0 && c.x - ch.right > -lh) {
        if (!bestChain || ch.right > bestChain.right) bestChain = ch;
      }
    }
    if (bestChain) {
      bestChain.comps.push(c);
      bestChain.right = Math.max(bestChain.right, c.x + c.w);
      bestChain.cy = bestChain.cy * 0.7 + c.cy * 0.3;
      bestChain.lh = bestChain.lh * 0.7 + c.h * 0.3;
    } else {
      chains.push({ comps: [c], right: c.x + c.w, cy: c.cy, lh: c.h });
    }
  }
  const boxes = [];
  for (const ch of chains) {
    let minX = 1e9, maxX = 0, minY = 1e9, maxY = 0;
    const hs = [];
    let weight = 0; // merged multi-letter blobs count as several letters
    for (const c of ch.comps) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x + c.w);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y + c.h);
      hs.push(c.h);
      weight += Math.min(8, Math.max(1, Math.round(c.w / (0.75 * c.h))));
    }
    if (weight < 4) continue;
    hs.sort((a, b) => a - b);
    const lh = hs[hs.length >> 1];
    const w = maxX - minX, h = maxY - minY;
    if (w < lh * 2.5 || h > lh * 2.2) continue;
    boxes.push({ x: minX, y: minY, w, h, lh, n: weight });
  }
  return boxes.sort((a, b) => (b.n * b.lh) - (a.n * a.lh));
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

// ---- area-name labels, auto-extracted from the reference map ----
// Each label is text drawn at a fixed map position and size; matching one in
// a screenshot yields identity + position + scale in a single step.
let refTexts = null; // [{ x, y, w, h, lh, mat }] in map px, mat = gray crop

function ensureRefTexts(cv) {
  if (refTexts) return refTexts;
  const W = refBitmap.width, H = refBitmap.height;
  const id = bitmapToImageData(refBitmap, W, H);
  const d = id.data;
  const bin = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < bin.length; i += 4, p++) {
    bin[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) > 55 ? 255 : 0;
  }
  const boxes = textBoxesFrom(bin, W, H, 12, 55);
  const srcFull = cv.matFromImageData(id);
  const grayFull = new cv.Mat();
  cv.cvtColor(srcFull, grayFull, cv.COLOR_RGBA2GRAY);
  srcFull.delete();
  refTexts = boxes.slice(0, 60).map(b => {
    const pad = Math.round(b.lh * 0.25);
    const x0 = Math.max(0, b.x - pad), y0 = Math.max(0, b.y - pad);
    const x1 = Math.min(W, b.x + b.w + pad), y1 = Math.min(H, b.y + b.h + pad);
    const roi = grayFull.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
    const mat = roi.clone();
    roi.delete();
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, lh: b.lh, mat };
  });
  grayFull.delete();
  return refTexts;
}

// text-specific mask: pixels clearly BRIGHTER than their fine-grained local
// neighbourhood. Thin letter strokes pop out of an ~8px local mean even when
// the label sits right next to bright room shapes (where the coarse
// background model absorbs them); solid room fills don't.
function textMask(shot, W, H) {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(shot, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;

  const bs = new OffscreenCanvas(Math.max(1, Math.round(W / 8)), Math.max(1, Math.round(H / 8)));
  bs.getContext('2d').drawImage(shot, 0, 0, bs.width, bs.height);
  const bc = new OffscreenCanvas(W, H);
  const bctx = bc.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(bs, 0, 0, W, H);
  const b = bctx.getImageData(0, 0, W, H).data;

  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const blum = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    mask[p] = (lum - blum > 18) ? 255 : 0;
  }
  return mask;
}

// try to identify an area-name label in the screenshot; returns
// { k, mapX, mapY, shotBX, shotBY, score } — a shot-base-px point that
// corresponds to a map point, plus the implied scale — or null
function tryLabelMatch(cv, shot, baseW, baseH) {
  const texts = ensureRefTexts(cv);
  if (!texts.length) return null;
  const cands = textBoxesFrom(textMask(shot, baseW, baseH), baseW, baseH, 8, 70).slice(0, 5);
  if (!cands.length) return null;

  const id = bitmapToImageData(shot, baseW, baseH);
  const src = cv.matFromImageData(id);
  const shotGray = new cv.Mat();
  cv.cvtColor(src, shotGray, cv.COLOR_RGBA2GRAY);
  src.delete();

  const H0 = 26; // normalized letter height for comparison
  let best = null;

  for (const c of cands) {
    const sc = H0 / c.lh;
    const padC = Math.round(c.lh * 0.6);
    const cx0 = Math.max(0, c.x - padC), cy0 = Math.max(0, c.y - padC);
    const cx1 = Math.min(baseW, c.x + c.w + padC), cy1 = Math.min(baseH, c.y + c.h + padC);
    const cRoi = shotGray.roi(new cv.Rect(cx0, cy0, cx1 - cx0, cy1 - cy0));
    const candN = new cv.Mat();
    cv.resize(cRoi, candN, new cv.Size(
      Math.max(8, Math.round((cx1 - cx0) * sc)),
      Math.max(8, Math.round((cy1 - cy0) * sc))), 0, 0, cv.INTER_AREA);
    cRoi.delete();
    // equalize sharpness: reference labels are small and blurry, in-game
    // text is crisp — without this, identical text correlates poorly
    cv.GaussianBlur(candN, candN, new cv.Size(5, 5), 0);

    for (const t of texts) {
      const kImplied = t.lh / c.lh; // NB: in map px per shot-BASE px
      if (kImplied < 0.3 || kImplied > 1.8) continue;
      const st = H0 / t.lh;
      // letter-height measurement is ±1px noisy; over a long word a few
      // percent of size error misaligns the glyphs — try size variants
      for (const ss of [0.93, 1.0, 1.075]) {
        const refN = new cv.Mat();
        cv.resize(t.mat, refN, new cv.Size(
          Math.max(8, Math.round(t.w * st * ss)),
          Math.max(8, Math.round(t.h * st * ss))), 0, 0, cv.INTER_AREA);
        cv.GaussianBlur(refN, refN, new cv.Size(5, 5), 0);

        let m = null, mode = null;
        if (refN.cols <= candN.cols && refN.rows <= candN.rows) {
          m = matchAt(cv, candN, refN); mode = 'refInCand';
        } else if (candN.cols <= refN.cols && candN.rows <= refN.rows) {
          m = matchAt(cv, refN, candN); mode = 'candInRef';
        }
        if (m && (!best || m.score > best.score)) {
          best = { score: m.score, mode, loc: { x: m.x, y: m.y }, c, t, sc, st: st * ss, cx0, cy0 };
        }
        if (self.__labelDebug && m) {
          if (!c.__dbgBest || m.score > c.__dbgBest.score) {
            c.__dbgBest = { score: +m.score.toFixed(3), mode, ss, t: { x: t.x, y: t.y, w: t.w, h: t.h, lh: t.lh } };
          }
        }
        refN.delete();
      }
    }
    candN.delete();
  }
  shotGray.delete();

  // 0.5-0.6 produced false identifications on real screenshots — require a
  // solid match, the room-structure verification confirms it afterwards
  if (self.__labelDebug) {
    self.postMessage({
      type: 'labeldebug',
      cands: cands.map(c => ({ x: c.x, y: c.y, w: c.w, h: c.h, lh: +c.lh.toFixed(1), n: c.n, best: c.__dbgBest || null })),
      best: best ? { score: +best.score.toFixed(3), mode: best.mode, t: { x: best.t.x, y: best.t.y, w: best.t.w, lh: best.t.lh }, c: { x: best.c.x, y: best.c.y, lh: +best.c.lh.toFixed(1) } } : null,
      refCount: texts.length,
      refNearMarrow: texts.filter(t => t.y > 1950 && t.y < 2200 && t.x > 1100 && t.x < 2100)
        .map(t => ({ x: t.x, y: t.y, w: t.w, h: t.h, lh: t.lh })),
    });
  }

  if (!best || best.score < 0.62) return null;

  // reconstruct the correspondence between a shot-base point and a map point
  const { mode, loc, c, t, sc, st, cx0, cy0 } = best;
  let shotBX, shotBY, mapX, mapY;
  if (mode === 'refInCand') {
    // ref label (origin t.x,t.y in map px) found inside the candidate crop
    shotBX = cx0 + loc.x / sc; shotBY = cy0 + loc.y / sc;
    mapX = t.x; mapY = t.y;
  } else {
    // candidate crop found inside the ref label
    shotBX = cx0; shotBY = cy0;
    mapX = t.x + loc.x / st; mapY = t.y + loc.y / st;
  }
  return { k: sc / st, mapX, mapY, shotBX, shotBY, score: best.score };
}

// peak + the correlation map's own statistics: z = (max - mean) / std is
// comparable ACROSS template scales, unlike raw NCC (small templates peak
// high by chance, large ones accumulate weight — both misrank)
// refine scale & position around a predicted spot in refMask2 (padded)
// coordinates: cx2/cy2 = predicted center, twCenter = predicted template
// width, ks = scale multipliers to try. Returns { score, mx, my, tw } or null.
function refinePass(cv, tmplBase, aspect, cx2, cy2, twCenter, ks, progressFrom) {
  let fine = null;
  for (let i = 0; i < ks.length; i++) {
    const tw2 = Math.round(twCenter * ks[i]);
    const th2 = Math.round(tw2 * aspect);
    const padX = Math.round(tw2 * 0.35), padY = Math.round(th2 * 0.35);
    const x0 = Math.max(0, Math.round(cx2 - tw2 / 2 - padX));
    const y0 = Math.max(0, Math.round(cy2 - th2 / 2 - padY));
    const x1 = Math.min(refMask2.cols, Math.round(cx2 + tw2 / 2 + padX));
    const y1 = Math.min(refMask2.rows, Math.round(cy2 + th2 / 2 + padY));
    if (tw2 < 24 || th2 < 24 || tw2 > x1 - x0 || th2 > y1 - y0) {
      self.postMessage({ type: 'progress', f: progressFrom + (1 - progressFrom) * (i + 1) / ks.length });
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
    self.postMessage({ type: 'progress', f: progressFrom + (1 - progressFrom) * (i + 1) / ks.length });
  }
  return fine;
}

// Refine an OCR-predicted placement by ONE-SIDED overlap of the screenshot's
// content BOUNDARIES on the reference's (dilated) boundaries. One-sided
// because the screenshot shows only a subset of the reference's rooms
// (partial exploration, dashed outlines); boundaries rather than fills
// because edges are what discriminate one room layout from another — fill
// overlap alone accepts any roomy neighborhood. A fill sanity check on top
// rejects placements whose rooms hang over reference void.
function fillRefine(mask, raw, baseW, baseH, crop, hint, mode, exclude = []) {
  const fill = ensureRefFillDil();
  const edge = ensureRefEdge();
  const RW = refBitmap.width, RH = refBitmap.height;
  const kMap0 = hint.rect.w / baseW; // predicted map px per shot-base px
  const ks = hint.spread === 'wide'
    ? Array.from({ length: 15 }, (_, i) => 0.6 * Math.pow(1.6 / 0.6, i / 14))
    : hint.spread === 'narrow'
      ? [0.985, 1.0, 1.015]
      : [0.93, 0.965, 1.0, 1.035, 1.07];

  // Boundary points of the shot's content mask, restricted to the trimmed
  // crop (skips HUD borders). Fill points for the sanity check come from the
  // RAW threshold mask (actual drawn strokes), NOT the enclosure-filled mask:
  // on wide shots the explored corridors can enclose big unexplored pockets,
  // and fillEnclosed marks those as "interior" — junk points that land on
  // reference void and sank a correct 4-name placement below the gate.
  // fill-sanity points must be MAP ink only: strokes inside an excluded box
  // (a matched area-name label, the player marker) are overlay ink drawn on
  // the map — they land on reference void even at the correct spot, and on a
  // small cropped shot they dominate the strokes and sink fillOv below the
  // gate at the right placement (test28: tiny Wormways crop, marker = 29% of
  // frame height). Label text stays in the EDGE points (it lines up with the
  // reference's own label text), but the marker leaves those too: it exists
  // nowhere on the reference, so its edges only pull the search off target.
  const inBox = (x, y, list) => {
    for (const b of list) if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) return true;
    return false;
  };
  const exMarker = exclude.filter(b => b.kind === 'marker');
  const epts = [], fpts = [];
  for (let y = crop.y + 1; y < crop.y + crop.h - 1; y++) {
    const row = y * baseW;
    for (let x = crop.x + 1; x < crop.x + crop.w - 1; x++) {
      const p = row + x;
      if (raw[p] && ((x ^ y) & 3) === 0 && !inBox(x, y, exclude)) fpts.push(x, y); // sparse stroke sample
      if (!mask[p]) continue;
      if (!mask[p - 1] || !mask[p + 1] || !mask[p - baseW] || !mask[p + baseW]) {
        if (!inBox(x, y, exMarker)) epts.push(x, y);
      }
    }
  }
  let estride = 1;
  while (epts.length / (2 * estride) > 7000) estride++;
  const eN = Math.floor(epts.length / 2 / estride);
  if (eN < 200) return null;

  const cx = hint.rect.x + hint.rect.w / 2;
  const cy = hint.rect.y + (hint.rect.w * baseH / baseW) / 2;
  // search window in map px; the wide-window retry covers OCR anchors that
  // landed further off (junk words glued to a line, truncated names)
  const R = Math.max(60, hint.rect.w * 0.12) * (hint.wideWindow ? 2.5 : 1);
  const step = hint.wideWindow ? 4 : 3;

  const edgeOvAt = (X0, Y0, k) => {
    let inter = 0, n = 0;
    for (let i = 0; i < epts.length; i += 2 * estride) {
      const mx = (X0 + epts[i] * k) | 0, my = (Y0 + epts[i + 1] * k) | 0;
      n++;
      if (mx >= 0 && mx < RW && my >= 0 && my < RH && edge[my * RW + mx]) inter++;
    }
    return inter / n;
  };
  const fillOvAt = (X0, Y0, k) => {
    if (!fpts.length) return 1;
    let inter = 0, n = 0;
    for (let i = 0; i < fpts.length; i += 2) {
      const mx = (X0 + fpts[i] * k) | 0, my = (Y0 + fpts[i + 1] * k) | 0;
      n++;
      if (mx >= 0 && mx < RW && my >= 0 && my < RH && fill[my * RW + mx]) inter++;
    }
    return inter / n;
  };

  let best = null;
  const cands = [];
  for (let ki = 0; ki < ks.length; ki++) {
    const k = kMap0 * ks[ki];
    const bx = cx - baseW * k / 2, by = cy - baseH * k / 2;
    for (let dy = -R; dy <= R; dy += step) {
      for (let dx = -R; dx <= R; dx += step) {
        const ov = edgeOvAt(bx + dx, by + dy, k);
        cands.push({ ov, X0: bx + dx, Y0: by + dy, k, ki });
        if (!best || ov > best.ov) best = { ov, X0: bx + dx, Y0: by + dy, k, ki };
      }
    }
    self.postMessage({ type: 'progress', f: 0.9 * (ki + 1) / ks.length });
  }
  if (!best) return null;

  // In corridor-dense regions the dilated edge mask is near chance-level
  // everywhere, so the top EDGE candidate can sit over reference void while
  // the correct spot scores marginally lower (test28: wrong local max ov
  // 0.628 / fillOv 0.43 vs correct spot fillOv 0.7). When the winner fails
  // fill sanity, fall back through the spatially-distinct runners-up that
  // score nearly as well and take the first that passes.
  let rerank = null;
  if (fillOvAt(best.X0, best.Y0, best.k) < 0.5) {
    cands.sort((a, b) => b.ov - a.ov);
    const picked = [];
    for (const c of cands) {
      if (c.ov < best.ov - 0.1 || picked.length >= 60) break;
      if (picked.some(p => p.ki === c.ki && Math.abs(p.X0 - c.X0) < 9 && Math.abs(p.Y0 - c.Y0) < 9)) continue;
      c.fillOv = fillOvAt(c.X0, c.Y0, c.k);
      picked.push(c);
      // candidates arrive in descending ov, so the first passer wins
      if (c.fillOv >= 0.5) { best = c; break; }
    }
    if (hint.debug) rerank = picked.map(c => ({ ov: +c.ov.toFixed(3), fillOv: +c.fillOv.toFixed(3), dx: Math.round(c.X0), dy: Math.round(c.Y0), ki: c.ki }));
  }

  // 1px polish around the coarse best
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const ov = edgeOvAt(best.X0 + dx, best.Y0 + dy, best.k);
      if (ov > best.ov) best = { ...best, ov, X0: best.X0 + dx, Y0: best.Y0 + dy };
    }
  }

  // a best at the extreme of a real scale sweep is unconfirmable
  if (ks.length >= 5 && (best.ki === 0 || best.ki === ks.length - 1)) return null;

  // chance level: how much dilated reference edge there is under the
  // placement anyway (in dense regions a random spot still hits some)
  let refN = 0, refHit = 0;
  for (let y = crop.y; y < crop.y + crop.h; y += 4) {
    for (let x = crop.x; x < crop.x + crop.w; x += 4) {
      const mx = (best.X0 + x * best.k) | 0, my = (best.Y0 + y * best.k) | 0;
      if (mx >= 0 && mx < RW && my >= 0 && my < RH) { refN++; if (edge[my * RW + mx]) refHit++; }
    }
  }
  const refFrac = refN ? refHit / refN : 1;
  const lift = (best.ov - refFrac) / Math.max(0.05, 1 - refFrac);
  const fillOv = fillOvAt(best.X0, best.Y0, best.k);
  // calibrated on real shots: correct placements score ov 0.46-0.52 with
  // lift 0.30-0.37; wrong-neighborhood placements 0.25-0.38 with lift ≤0.17
  if (best.ov < (mode === 'full' ? 0.4 : 0.45) || lift < 0.25 || fillOv < 0.5) {
    return hint.debug ? { fail: true, ov: +best.ov.toFixed(3), refFrac: +refFrac.toFixed(3), lift: +lift.toFixed(3), fillOv: +fillOv.toFixed(3), k: +best.k.toFixed(4), ki: best.ki, nE: eN, rerank } : null;
  }

  return {
    x: best.X0,
    y: best.Y0,
    w: baseW * best.k,
    h: baseH * best.k,
    score: best.ov,
    z: 99,
    ratio: 0.4,
    via: 'refine',
    lift: +lift.toFixed(3),
    fillOv: +fillOv.toFixed(3),
  };
}

// Chamfer distance transform to the nearest reference boundary, full map
// resolution, 3/4 integer weights (3 units = 1px), clamped at 30px. Built
// once (~20MB, a couple hundred ms) the first time a precise refine runs.
let refDT = null;
function ensureRefDT() {
  if (refDT) return refDT;
  const raw = ensureRefEdgeRaw();
  const W = refBitmap.width, H = refBitmap.height;
  const CAP = 3 * 30;
  const dt = new Uint16Array(W * H).fill(CAP);
  for (let p = 0; p < dt.length; p++) if (raw[p]) dt[p] = 0;
  for (let y = 0; y < H; y++) {          // forward pass
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const p = row + x;
      let d = dt[p];
      if (x > 0 && dt[p - 1] + 3 < d) d = dt[p - 1] + 3;
      if (y > 0) {
        if (dt[p - W] + 3 < d) d = dt[p - W] + 3;
        if (x > 0 && dt[p - W - 1] + 4 < d) d = dt[p - W - 1] + 4;
        if (x < W - 1 && dt[p - W + 1] + 4 < d) d = dt[p - W + 1] + 4;
      }
      dt[p] = d;
    }
  }
  for (let y = H - 1; y >= 0; y--) {     // backward pass
    const row = y * W;
    for (let x = W - 1; x >= 0; x--) {
      const p = row + x;
      let d = dt[p];
      if (x < W - 1 && dt[p + 1] + 3 < d) d = dt[p + 1] + 3;
      if (y < H - 1) {
        if (dt[p + W] + 3 < d) d = dt[p + W] + 3;
        if (x < W - 1 && dt[p + W + 1] + 4 < d) d = dt[p + W + 1] + 4;
        if (x > 0 && dt[p + W - 1] + 4 < d) d = dt[p + W - 1] + 4;
      }
      dt[p] = d;
    }
  }
  refDT = dt;
  return refDT;
}

// Final sub-pixel alignment of an ALREADY APPLIED placement. The regular
// refine paths quantize — 3px translation grid, 1.5% scale steps, ~2px
// dilated edges — which leaves a visible couple-pixel / sub-percent error.
// This pass minimizes the mean chamfer distance from the screenshot's
// content boundaries to the nearest reference boundary, coordinate-descending
// to ~0.1px translation and ~0.03% scale. It runs in the background after
// the paste has landed, so it can afford the precision.
async function preciseRefine(shot, rect0, mode) {
  const cv = await getCV();
  const baseW = Math.min(1600, shot.width);
  const baseH = Math.round(shot.height * baseW / shot.width);
  const { mask } = binaryContentMask(cv, shot, baseW, baseH);

  let crop;
  if (mode === 'full') {
    let minX = baseW, maxX = -1, minY = baseH, maxY = -1;
    for (let y = 0; y < baseH; y++) {
      const row = y * baseW;
      for (let x = 0; x < baseW; x++) {
        if (mask[row + x]) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX - minX < 60 || maxY - minY < 60) return null;
    crop = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  } else {
    crop = {
      x: Math.round(baseW * 0.06), y: Math.round(baseH * 0.08),
      w: Math.round(baseW * 0.88), h: Math.round(baseH * 0.84),
    };
  }

  // The mask's blur+threshold step dilates strokes outward by ~0.6px, which
  // would bias the fit toward shrinking the scale. A fractional erosion
  // (blur + high threshold) cancels that, and smooths boundary jitter too.
  const em = new cv.Mat(baseH, baseW, cv.CV_8UC1);
  em.data.set(mask);
  cv.GaussianBlur(em, em, new cv.Size(3, 3), 0);
  cv.threshold(em, em, 190, 255, cv.THRESH_BINARY);
  const bmask = Uint8Array.from(em.data);
  em.delete();

  // boundary points of the shot's drawn content (the alignment features)
  const pts = [];
  for (let y = crop.y + 1; y < crop.y + crop.h - 1; y++) {
    const row = y * baseW;
    for (let x = crop.x + 1; x < crop.x + crop.w - 1; x++) {
      const p = row + x;
      if (bmask[p] && (!bmask[p - 1] || !bmask[p + 1] || !bmask[p - baseW] || !bmask[p + baseW])) {
        pts.push(x, y);
      }
    }
  }
  let stride = 1;
  while (pts.length / (2 * stride) > 9000) stride++;
  if (pts.length / (2 * stride) < 300) return { fail: 'pts', n: pts.length / 2 }; // unexplored / nothing to align

  const dt = ensureRefDT();
  const W = refBitmap.width, H = refBitmap.height;
  const k0 = rect0.w / baseW;                       // map px per base px, as placed
  const acx = crop.x + crop.w / 2, acy = crop.y + crop.h / 2;
  const ax = rect0.x + acx * k0, ay = rect0.y + acy * k0; // scale anchor, map px

  const DMAX = 8; // px clamp — shot-only content (player marker, icons) can't dominate
  const distAt = (px, py, k, ox, oy) => {
    const mx = ax + ox + (px - acx) * k;
    const my = ay + oy + (py - acy) * k;
    if (mx < 1 || my < 1 || mx >= W - 2 || my >= H - 2) return DMAX;
    const x0 = mx | 0, y0 = my | 0, fx = mx - x0, fy = my - y0, o = y0 * W + x0;
    const d = ((dt[o] * (1 - fx) + dt[o + 1] * fx) * (1 - fy)
             + (dt[o + W] * (1 - fx) + dt[o + W + 1] * fx) * fy) / 3;
    return d > DMAX ? DMAX : d;
  };
  const evalOn = (arr, st, s, ox, oy) => {
    const k = k0 * s;
    let sum = 0, inl = 0, m = 0;
    for (let i = 0; i < arr.length; i += 2 * st) {
      const d = distAt(arr[i], arr[i + 1], k, ox, oy);
      m++;
      sum += d;
      if (d <= 1.5) inl++;
    }
    return { c: sum / m, inl: inl / m };
  };
  const evalAt = (s, ox, oy) => evalOn(pts, stride, s, ox, oy);
  const descend = (arr, st, from, steps, sLo, sHi) => {
    let b = { ...from, ...evalOn(arr, st, from.s, from.ox, from.oy) };
    for (const [ts, ss] of steps) {
      for (let guard = 0; guard < 40; guard++) {
        let moved = false;
        for (const [ds, dox, doy] of [[0, ts, 0], [0, -ts, 0], [0, 0, ts], [0, 0, -ts], [ss, 0, 0], [-ss, 0, 0]]) {
          const s = b.s + ds;
          if (s < sLo || s > sHi) continue;
          const r = evalOn(arr, st, s, b.ox + dox, b.oy + doy);
          if (r.c < b.c - 1e-4) {
            b = { s, ox: b.ox + dox, oy: b.oy + doy, ...r };
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
    return b;
  };

  const start = evalAt(1, 0, 0);
  // the placement was already verified once — if its boundaries mostly miss
  // reference structure here, there is nothing trustworthy to align to;
  // better to leave it than drag it onto the nearest wrong rooms
  if (start.inl < 0.2 && start.c > 5) return { fail: 'start', c: +start.c.toFixed(3), inl: +start.inl.toFixed(3) };

  let best = { s: 1, ox: 0, oy: 0, ...start };
  // coarse grid: ±12px translation (covers undoing a stitch nudge), scale ±2.5%
  for (const s of [0.975, 0.98, 0.985, 0.99, 0.995, 1, 1.005, 1.01, 1.015, 1.02, 1.025]) {
    for (let oy = -12; oy <= 12; oy += 3) {
      for (let ox = -12; ox <= 12; ox += 3) {
        const r = evalAt(s, ox, oy);
        if (r.c < best.c) best = { s, ox, oy, ...r };
      }
    }
  }
  // coordinate descent down to sub-pixel / sub-0.1% scale
  best = descend(pts, stride, best,
    [[1.5, 0.004], [0.6, 0.0015], [0.25, 0.0006], [0.1, 0.00025]], 0.97, 1.03);

  // correct placements on real shots land around inl 0.3-0.5 (style mismatch
  // between the in-game and reference renderings caps it well below 1)
  if (best.inl < 0.22) return { fail: 'best', c: +best.c.toFixed(3), inl: +best.inl.toFixed(3), s: best.s, ox: best.ox, oy: best.oy }; // never landed convincingly on structure

  // Trimmed rounds: junk points — the player marker, HUD icons, content the
  // reference draws differently — sit at the DMAX clamp and dilute the cost,
  // leaving the scale axis especially shallow (two runs from different seeds
  // disagreed by >1%). Re-descend on only the points that currently land on
  // reference structure; re-select once so points can (re)join as the fit
  // sharpens. Descent on the trimmed subset, metrics always on ALL points.
  for (let round = 0; round < 2; round++) {
    const kb = k0 * best.s;
    const sel = [];
    for (let i = 0; i < pts.length; i += 2 * stride) {
      if (distAt(pts[i], pts[i + 1], kb, best.ox, best.oy) <= 4) sel.push(pts[i], pts[i + 1]);
    }
    if (sel.length / 2 < 200) break;
    const b = descend(sel, 1, best,
      [[0.6, 0.0015], [0.25, 0.0006], [0.1, 0.00025]], 0.965, 1.035);
    const full = evalAt(b.s, b.ox, b.oy);
    best = { s: b.s, ox: b.ox, oy: b.oy, ...full };
  }
  const k = k0 * best.s;
  return {
    x: ax + best.ox - acx * k,
    y: ay + best.oy - acy * k,
    w: baseW * k,
    h: baseH * k,
    via: 'precise',
    startPx: +start.c.toFixed(3),   // mean boundary distance before…
    dPx: +best.c.toFixed(3),        // …and after, in map px
    inlier: +best.inl.toFixed(3),
    moved: +Math.hypot(best.ox, best.oy).toFixed(2),
    dScale: +(best.s - 1).toFixed(5),
  };
}

// After a ladder search, walk the scale in shrinking sub-percent steps —
// the ladder's 2-3% quantization leaves multi-pixel edge error on big pastes.
function polishScale(cv, tmplBase, aspect, fine, progressFrom) {
  let best = fine;
  for (const step of [0.008, 0.003]) {
    const cx2 = best.mx + best.tw / 2;
    const cy2 = best.my + best.tw * aspect / 2;
    const r = refinePass(cv, tmplBase, aspect, cx2, cy2, best.tw,
      [1 - step, 1, 1 + step], progressFrom);
    if (r && r.score > best.score) best = r;
  }
  return best;
}

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
  const { mask, raw } = binaryContentMask(cv, shot, baseW, baseH);

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
  const pad2 = Math.round(Math.min(REF_W2, refBitmap.width) * PAD_FRAC);

  // how much room structure the screenshot actually contains — computed
  // early so the refine-only path can tell "verification failed" apart
  // from "there is nothing here to verify against" (unexplored area)
  let structCount0 = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const row = y * baseW;
    for (let x = rect.x; x < rect.x + rect.w; x++) if (mask[row + x]) structCount0++;
  }
  const structFrac0 = structCount0 / Math.max(1, rect.w * rect.h);

  // ---- refine-only: the caller already knows roughly where this shot goes
  // (an OCR'd area name) — snap that prediction onto the reference content.
  // OCR bounding boxes are only approximate (dropped words, names cut off at
  // the screenshot edge), so position AND scale are re-derived here.
  // `hint.spread` says how far the caller's scale guess may be off:
  // 'narrow' = content-verified global scale (position only), 'wide' = weak
  // guess (letter-height ratio).
  if (hint && hint.rect) {
    tmplBase.delete();
    if (structFrac0 < 0.035) {
      // an unexplored (near-black) shot has nothing to correlate — tell the
      // caller so it can keep the OCR placement instead of distrusting it
      return { sparse: true };
    }
    // overlay-ink boxes (matched labels, player marker) come in shot px;
    // bring them into base px for fillRefine's fill-sanity sampling
    const bf = baseW / shot.width;
    const exclude = (hint.exclude || []).map(b => ({
      x0: b.x0 * bf, y0: b.y0 * bf, x1: b.x1 * bf, y1: b.y1 * bf, kind: b.kind,
    }));
    // one-sided fill overlap instead of edge correlation: robust in dense
    // regions where the screenshot shows only a subset of the reference's
    // rooms. The returned rect covers the full base frame, which IS the
    // full shot (base is just the shot resized) — no coordinate mapping.
    return fillRefine(mask, raw, baseW, baseH, rect, hint, mode, exclude);
  }

  const structFrac = structFrac0;

  // ---- pass 0: area-name labels — identity + position + scale in one ----
  // (also the workhorse for full-map screenshots: zoomed-out room outlines
  // are too thin for the mask matcher, but the labels stay readable)
  {
    const lbl = tryLabelMatch(cv, shot, baseW, baseH);
    self.postMessage({ type: 'progress', f: 0.2 });
    if (lbl) {
      const kB = lbl.k; // map px per shot-BASE px
      const x0map = lbl.mapX - lbl.shotBX * kB;
      const y0map = lbl.mapY - lbl.shotBY * kB;
      const twp = rect.w * kB * refScale2;
      const cxp = (x0map + (rect.x + rect.w / 2) * kB) * refScale2 + pad2;
      const cyp = (y0map + (rect.y + rect.h / 2) * kB) * refScale2 + pad2;
      let fineL = refinePass(cv, tmplBase, aspect, cxp, cyp, twp,
        [0.955, 0.98, 1.0, 1.02, 1.045], 0.2);
      if (fineL) fineL = polishScale(cv, tmplBase, aspect, fineL, 0.6);
      // correct label hits verify at 0.25-0.40 on real screenshots; a wrong
      // one measured 0.14 — require solid room agreement (zoomed-out full
      // maps have thin outlines, so their verification runs weaker). A
      // borderline verify only counts when the label identification itself
      // was emphatic (a false label match squeaked by at verify 0.19).
      const verified = fineL && fineL.score >= (mode === 'full' ? 0.12 : 0.18)
        && (fineL.score >= 0.25 || lbl.score >= 0.75);

      // ...but an unexplored area has almost no room structure to verify
      // against, so trust a confident label on its own there
      const sparse = structFrac < 0.035;

      if (verified || (sparse && lbl.score >= 0.70)) {
        tmplBase.delete();
        if (verified) {
          const cl = rect.x / baseW, ct = rect.y / baseH, cwf = rect.w / baseW;
          const tt = fineL.tw / (shot.width * cwf);
          const kk = tt / refScale2;
          return {
            x: (fineL.mx - pad2) / refScale2 - shot.width * cl * kk,
            y: (fineL.my - pad2) / refScale2 - shot.height * ct * kk,
            w: shot.width * kk,
            h: shot.height * kk,
            score: fineL.score,
            z: 99,
            ratio: 0.4, // a verified label identification is near-certain
            via: 'label',
            labelScore: lbl.score,
          };
        }
        // unexplored area: place straight from the label's own geometry.
        // Auto-apply only when the identification is very strong; otherwise
        // return it "plausible" so the app asks the user to confirm.
        const kk = kB * baseW / shot.width; // map px per shot px
        return {
          x: x0map,
          y: y0map,
          w: shot.width * kk,
          h: shot.height * kk,
          score: lbl.score,
          z: 99,
          ratio: lbl.score >= 0.80 ? 0.4 : 0.9,
          via: 'label',
          labelScore: lbl.score,
          unverified: true,
        };
      }
    }
  }

  // ---- pass 1: coarse multi-scale search over the whole map ----
  // with a scale hint the band is narrow (position search, basically) and
  // small regions are matched against the high-res reference for detail;
  // without a hint, a wide geometric sweep over the low-res reference
  let coarseRef = refMask1;
  let coarseScale = refScale1;
  const widths = [];
  let steps;
  if (hint) {
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
  // with a trusted scale hint the coarse scale is already near-exact — keep
  // the refinement from drifting away from it
  const ks = (hint && hint.tight)
    ? [0.95, 0.975, 1.0, 1.025, 1.05]
    : [0.86, 0.89, 0.92, 0.95, 0.975, 1.0, 1.025, 1.05, 1.08, 1.11, 1.145];
  let fine = refinePass(cv, tmplBase, aspect, cx2, cy2, best.tw * up, ks, 0.7);
  if (fine) fine = polishScale(cv, tmplBase, aspect, fine, 0.9);
  tmplBase.delete();

  // map back to full map coordinates for the complete (uncropped) screenshot
  // (match coordinates are in the PADDED reference frame — subtract the pad;
  // PAD2 = PAD1 * up exactly, so coarse->fine coordinate scaling stays valid)
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
    if (msg.type === 'debug') {
      self.__labelDebug = !!msg.on;
    } else if (msg.type === 'init') {
      refBitmap = msg.ref;
      await getCV();
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'locate') {
      const rect = await locate(msg.shot, msg.mode, msg.hint || null);
      msg.shot.close?.();
      self.postMessage({ type: 'result', rect });
    } else if (msg.type === 'refine') {
      const rect = await preciseRefine(msg.shot, msg.rect, msg.mode);
      msg.shot.close?.();
      self.postMessage({ type: 'result', rect });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
