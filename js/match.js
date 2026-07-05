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

// Binary "something is drawn here" mask against a LOCAL background estimate
// (the screenshot heavily downscaled and stretched back). A single dominant
// color fails on the in-game map's bright, vignetted backgrounds; comparing
// each pixel to its local surroundings is robust to gradients and lighting.
export function contentMaskData(shot, W) {
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

  fillEnclosed(mask, W, H);
  return { mask, W, H };
}

export function computeExploredMask(shot) {
  // high enough resolution that thin text strokes and room corners survive
  const { mask, W, H } = contentMaskData(shot, Math.min(1200, shot.width));
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  const id = ctx.createImageData(W, H);
  for (let p = 0; p < mask.length; p++) {
    const o = p * 4;
    id.data[o] = id.data[o + 1] = id.data[o + 2] = 255;
    id.data[o + 3] = mask[p];
  }
  ctx.putImageData(id, 0, 0);
  return out;
}
