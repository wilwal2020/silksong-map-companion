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

    for (const t of texts) {
      const kImplied = t.lh / c.lh; // NB: in map px per shot-BASE px
      if (kImplied < 0.3 || kImplied > 1.8) continue;
      const st = H0 / t.lh;
      const refN = new cv.Mat();
      cv.resize(t.mat, refN, new cv.Size(
        Math.max(8, Math.round(t.w * st)),
        Math.max(8, Math.round(t.h * st))), 0, 0, cv.INTER_AREA);

      let m = null, mode = null;
      if (refN.cols <= candN.cols && refN.rows <= candN.rows) {
        m = matchAt(cv, candN, refN); mode = 'refInCand';
      } else if (candN.cols <= refN.cols && candN.rows <= refN.rows) {
        m = matchAt(cv, refN, candN); mode = 'candInRef';
      }
      if (m && (!best || m.score > best.score)) {
        best = { score: m.score, mode, loc: { x: m.x, y: m.y }, c, t, sc, st, cx0, cy0 };
      }
      refN.delete();
    }
    candN.delete();
  }
  shotGray.delete();

  // 0.5-0.6 produced false identifications on real screenshots — require a
  // solid match, the room-structure verification confirms it afterwards
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
      const fineL = refinePass(cv, tmplBase, aspect, cxp, cyp, twp,
        [0.955, 0.98, 1.0, 1.02, 1.045], 0.2);
      // correct label hits verify at 0.25-0.40 on real screenshots; a wrong
      // one measured 0.14 — require solid room agreement (zoomed-out full
      // maps have thin outlines, so their verification runs weaker)
      if (fineL && fineL.score >= (mode === 'full' ? 0.12 : 0.18)) {
        tmplBase.delete();
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
  const fine = refinePass(cv, tmplBase, aspect, cx2, cy2, best.tw * up, ks, 0.7);
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
