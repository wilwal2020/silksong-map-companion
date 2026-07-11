// Screenshot-to-map matching, delegated to a Web Worker (js/matchworker.js)
// so the multi-scale OpenCV template matching never freezes the UI. Both
// images are reduced to edge maps in the worker — room outlines survive the
// style differences between the in-game map and the reference — then the
// screenshot is slid across the reference at a range of scales.

let worker = null;
let workerInit = null;
let busy = Promise.resolve();

function getWorker(mapImage) {
  if (workerInit) return workerInit;
  worker = new Worker('js/matchworker.js');
  workerInit = (async () => {
    const ref = await createImageBitmap(mapImage);
    const ready = new Promise((resolve, reject) => {
      const onMsg = e => {
        if (e.data.type === 'ready') { cleanup(); resolve(); }
        else if (e.data.type === 'error') { cleanup(); reject(new Error(e.data.message)); }
      };
      const cleanup = () => worker.removeEventListener('message', onMsg);
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', ev => { cleanup(); reject(new Error(ev.message || 'worker failed')); }, { once: true });
    });
    worker.postMessage({ type: 'init', ref }, [ref]);
    await ready;
    return worker;
  })();
  workerInit.catch(() => { worker = null; workerInit = null; }); // allow retry
  return workerInit;
}

// The player marker (white Hornet icon) is drawn ON the map, so its height
// is a fixed number of map-pixels regardless of screenshot resolution or
// in-game zoom. Calibrated against real screenshots: marker ≈ 43.8 map px.
export const MARKER_MAP_HEIGHT = 43.8;

// Find the best placement for `shot` (an ImageBitmap of a pasted screenshot)
// on the reference map. mode: 'map' (zoomed-in screenshot) or 'full' (whole
// map). `hint` = expected map-px per screenshot-px, if known. Returns
// { x, y, w, h, score, z, ratio } in full map coordinates, or null.
export function locate(shot, mapImage, mode, onProgress, hint = null) {
  const run = busy.then(async () => {
    const w = await getWorker(mapImage);
    const copy = await createImageBitmap(shot); // transferred; caller keeps `shot`
    return new Promise((resolve, reject) => {
      const onMsg = e => {
        const m = e.data;
        if (m.type === 'progress') { if (onProgress) onProgress(m.f); }
        else if (m.type === 'result') { cleanup(); resolve(m.rect); }
        else if (m.type === 'error') { cleanup(); reject(new Error(m.message)); }
      };
      const cleanup = () => w.removeEventListener('message', onMsg);
      w.addEventListener('message', onMsg);
      w.postMessage({ type: 'locate', shot: copy, mode, hint }, [copy]);
    });
  });
  busy = run.catch(() => {});
  return run;
}

// Sub-pixel polish of an already-applied placement (background pass): given
// the rect the paste landed on, returns a corrected rect with quality metrics
// ({ startPx, dPx, moved, dScale, inlier }), or null when there is nothing to
// align to / no convincing fit. Shares the busy-chain with locate() so it
// never interleaves with a foreground search.
export function refinePlacement(shot, mapImage, rect, mode) {
  const run = busy.then(async () => {
    const w = await getWorker(mapImage);
    const copy = await createImageBitmap(shot); // transferred; caller keeps `shot`
    return new Promise((resolve, reject) => {
      const onMsg = e => {
        const m = e.data;
        if (m.type === 'result') { cleanup(); resolve(m.rect); }
        else if (m.type === 'error') { cleanup(); reject(new Error(m.message)); }
      };
      const cleanup = () => w.removeEventListener('message', onMsg);
      w.addEventListener('message', onMsg);
      w.postMessage({
        type: 'refine', shot: copy, mode,
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      }, [copy]);
    });
  });
  busy = run.catch(() => {});
  return run;
}

// Find the player marker (the white Hornet icon) in a map screenshot.
// Returns { fx, fy } as fractions of the screenshot size, or null.
// Strategy: the marker is the biggest compact near-white blob — room borders
// are thin (low fill ratio) and text/icons are much smaller.
export function detectPlayerMarker(shot) {
  const W = Math.min(800, shot.width);
  const scale = W / shot.width;
  const H = Math.max(1, Math.round(shot.height * scale));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(shot, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;

  const bin = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < bin.length; i += 4, p++) {
    bin[p] = (d[i] > 205 && d[i + 1] > 205 && d[i + 2] > 205) ? 1 : 0;
  }

  // connected components via BFS
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let bestBlob = null;
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0, sx = 0, sy = 0;
    let minX = W, maxX = 0, minY = H, maxY = 0;
    while (top > 0) {
      const p = stack[--top];
      const x = p % W, y = (p / W) | 0;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && bin[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < W - 1 && bin[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && bin[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[top++] = p - W; }
      if (y < H - 1 && bin[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[top++] = p + W; }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    const aspectOk = bw / bh > 0.4 && bw / bh < 1.4;
    const sizeOk = area > 120 && area < 6000 && bh < H * 0.25;
    if (sizeOk && aspectOk && fill > 0.4) {
      if (!bestBlob || area > bestBlob.area) {
        bestBlob = { area, fx: (sx / area) / W, fy: (sy / area) / H, bh };
      }
    }
  }
  if (!bestBlob) return null;
  return {
    fx: bestBlob.fx,
    fy: bestBlob.fy,
    // marker height in ORIGINAL screenshot pixels — the marker is drawn on
    // the map, so its size reveals the in-game zoom level
    h: bestBlob.bh / scale,
  };
}

// For full-map updates: build an alpha mask of which parts of the screenshot
// are explored rooms (anything that differs from the dominant background
// color) so the fog only reveals rooms you have actually been to.
// Fill regions that are fully enclosed by content (room interiors): flood
// from the image border through non-content; whatever non-content remains
// unreached is inside a room and becomes content.
export function fillEnclosed(mask, W, H) {
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

// Fill enclosed interiors, but treat the frame border as open ONLY where the
// reference map also has background there. Rooms cut off by the screenshot
// edge stay "closed" (their interior maps onto reference room content), so
// they get filled instead of staying hollow.
function fillEnclosedRefAware(mask, W, H, refBg) {
  const seen = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  let head = 0, tail = 0;
  const push = p => { if (!mask[p] && !seen[p]) { seen[p] = 1; q[tail++] = p; } };
  const seed = p => { if (!mask[p] && refBg[p]) push(p); };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
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

// Binary "something is drawn here" mask against a LOCAL background estimate
// (the screenshot heavily downscaled and stretched back). A single dominant
// color fails on the in-game map's bright, vignetted backgrounds; comparing
// each pixel to its local surroundings is robust to gradients and lighting.
export function contentMaskData(shot, W, fill = true) {
  const H = Math.round(shot.height * W / shot.width);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(shot, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;

  // background = shot at ~1/20 scale, stretched back up (a huge cheap blur)
  const bs = document.createElement('canvas');
  bs.width = Math.max(1, Math.round(W / 20));
  bs.height = Math.max(1, Math.round(H / 20));
  bs.getContext('2d').drawImage(shot, 0, 0, bs.width, bs.height);
  const bc = document.createElement('canvas');
  bc.width = W; bc.height = H;
  const bctx = bc.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(bs, 0, 0, W, H);
  const b = bctx.getImageData(0, 0, W, H).data;

  const TH = 1800; // squared color distance to local background
  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    const dr = d[i] - b[i], dg = d[i + 1] - b[i + 1], db = d[i + 2] - b[i + 2];
    mask[p] = (dr * dr + dg * dg + db * db > TH) ? 255 : 0;
  }

  // close small gaps (dashed outlines of partially explored rooms) then fill
  // the enclosed room interiors so rooms are solid, not outline-only
  const cm = document.createElement('canvas');
  cm.width = W; cm.height = H;
  const cmCtx = cm.getContext('2d', { willReadFrequently: true });
  const id = cmCtx.createImageData(W, H);
  for (let p = 0; p < mask.length; p++) id.data[p * 4 + 3] = mask[p];
  cmCtx.putImageData(id, 0, 0);
  const c2 = document.createElement('canvas');
  c2.width = W; c2.height = H;
  const ctx2 = c2.getContext('2d', { willReadFrequently: true });
  ctx2.filter = 'blur(3px)';
  ctx2.drawImage(cm, 0, 0);
  const d2 = ctx2.getImageData(0, 0, W, H).data;
  for (let p = 0; p < mask.length; p++) mask[p] = d2[p * 4 + 3] > 80 ? 255 : 0;

  if (fill) fillEnclosed(mask, W, H);
  return { mask, W, H };
}

// Reveal mask for a placed screenshot: content mask with room interiors
// filled using the reference map as the arbiter of what's really background
// (fixes hollow rooms cut off at the screenshot edge), then slightly dilated
// so room border lines are fully, crisply included.
function maskToAlphaCanvas(mask, W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(W, H);
  for (let p = 0; p < mask.length; p++) {
    const o = p * 4;
    id.data[o] = id.data[o + 1] = id.data[o + 2] = 255;
    id.data[o + 3] = mask[p];
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// dilate a binary mask by roughly `px` using canvas blur + low threshold
function dilateMask(mask, W, H, px, thr = 30) {
  const c1 = maskToAlphaCanvas(mask, W, H);
  const c2 = document.createElement('canvas');
  c2.width = W; c2.height = H;
  const ctx2 = c2.getContext('2d', { willReadFrequently: true });
  ctx2.filter = `blur(${Math.max(1, Math.round(px * 0.7))}px)`;
  ctx2.drawImage(c1, 0, 0);
  const d = ctx2.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let p = 0; p < out.length; p++) out[p] = d[p * 4 + 3] > thr ? 255 : 0;
  return out;
}

// remove small isolated blobs (icon fragments, vignette noise) that would
// otherwise pull the reveal into empty areas
function dropSmallComponents(mask, W, H, minArea) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const member = new Int32Array(W * H);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let top = 0, n = 0;
    stack[top++] = s; seen[s] = 1;
    while (top > 0) {
      const p = stack[--top];
      member[n++] = p;
      const x = p % W;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (p >= W && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[top++] = p - W; }
      if (p < W * (H - 1) && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[top++] = p + W; }
    }
    if (n < minArea) for (let i = 0; i < n; i++) mask[member[i]] = 0;
  }
}

// Reveal mask for a placed screenshot.
//
// The screenshot decides WHERE, the reference decides WHAT (its own crisp
// room shapes, fills and labels). Room interiors look like background to
// local analysis, so they are detected directly instead: a pixel counts as
// explored fill when it differs from the screenshot's GLOBAL background
// color AND the reference has a room there. With interiors detected
// directly, only a small halo is needed around borders (to close dashed
// outlines), which also keeps the reveal from bleeding through doorways.
export function computeExploredMask(shot, rect, mapImage) {
  const baseW = Math.min(1200, shot.width);
  const { mask, W, H } = contentMaskData(shot, baseW, false);
  dropSmallComponents(mask, W, H, 60);

  // --- reference, sampled on an EXPANDED crop so rooms cut by the
  // screenshot edge are still closed shapes, then cut back to the grid ---
  const padX = Math.round(W * 0.15), padY = Math.round(H * 0.15);
  const eW = W + 2 * padX, eH = H + 2 * padY;
  const mppx = rect.w / W; // map px per mask px
  const rc = document.createElement('canvas');
  rc.width = eW; rc.height = eH;
  const rctx = rc.getContext('2d', { willReadFrequently: true });
  rctx.drawImage(mapImage,
    rect.x - padX * mppx, rect.y - padY * mppx,
    rect.w + 2 * padX * mppx, rect.h + 2 * padY * mppx,
    0, 0, eW, eH);
  const rd = rctx.getImageData(0, 0, eW, eH).data;
  const refFilledE = new Uint8Array(eW * eH);
  for (let i = 0, p = 0; p < refFilledE.length; i += 4, p++) {
    refFilledE[p] = (rd[i] * 0.299 + rd[i + 1] * 0.587 + rd[i + 2] * 0.114) > 26 ? 255 : 0;
  }
  fillEnclosed(refFilledE, eW, eH); // room interiors become part of the rooms
  const refFilled = new Uint8Array(W * H);
  const refBg = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = refFilledE[(y + padY) * eW + (x + padX)];
      refFilled[y * W + x] = v;
      refBg[y * W + x] = v ? 0 : 1;
    }
  }

  // --- direct interior detection: differs from the shot's global
  // background AND inside a reference room ---
  const sc = document.createElement('canvas');
  sc.width = W; sc.height = H;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(shot, 0, 0, W, H);
  const sd = sctx.getImageData(0, 0, W, H).data;
  const hist = new Map();
  for (let i = 0; i < sd.length; i += 16) {
    const key = (sd[i] >> 3 << 10) | (sd[i + 1] >> 3 << 5) | (sd[i + 2] >> 3);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let bgKey = 0, bgCount = -1;
  for (const [k, v] of hist) if (v > bgCount) { bgCount = v; bgKey = k; }
  const gb = [(bgKey >> 10 & 31) << 3, (bgKey >> 5 & 31) << 3, (bgKey & 31) << 3];
  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    if (mask[p] || !refFilled[p]) continue;
    const dr = sd[i] - gb[0], dg = sd[i + 1] - gb[1], db = sd[i + 2] - gb[2];
    if (dr * dr + dg * dg + db * db > 1600) mask[p] = 255;
  }

  // --- small halo (closes dashed outlines without doorway bleed), fill
  // what becomes enclosed, then reveal = zone ∩ reference rooms ---
  const zone = dilateMask(mask, W, H, 11, 55);
  fillEnclosedRefAware(zone, W, H, refBg);
  const final = new Uint8Array(W * H);
  for (let p = 0; p < final.length; p++) {
    final[p] = (zone[p] && refFilled[p]) ? 255 : 0;
  }
  return maskToAlphaCanvas(final, W, H);
}
