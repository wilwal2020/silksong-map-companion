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

// Find the best placement for `shot` (an ImageBitmap of a pasted screenshot)
// on the reference map. mode: 'map' (zoomed-in screenshot) or 'full' (whole
// map). Returns { x, y, w, h, score } in full map coordinates for the
// complete screenshot, or null.
export function locate(shot, mapImage, mode, onProgress) {
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
      w.postMessage({ type: 'locate', shot: copy, mode }, [copy]);
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
        bestBlob = { area, fx: (sx / area) / W, fy: (sy / area) / H };
      }
    }
  }
  return bestBlob ? { fx: bestBlob.fx, fy: bestBlob.fy } : null;
}

// For full-map updates: build an alpha mask of which parts of the screenshot
// are explored rooms (anything that differs from the dominant background
// color) so the fog only reveals rooms you have actually been to.
export function computeExploredMask(shot) {
  // high enough resolution that thin text strokes and room corners survive
  const W = Math.min(1200, shot.width);
  const scale = W / shot.width;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Math.round(shot.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(shot, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  // dominant color via coarse quantization (5 bits per channel)
  const hist = new Map();
  for (let i = 0; i < d.length; i += 16) {
    const key = (d[i] >> 3 << 10) | (d[i + 1] >> 3 << 5) | (d[i + 2] >> 3);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let bgKey = 0, bgCount = -1;
  for (const [k, v] of hist) if (v > bgCount) { bgCount = v; bgKey = k; }
  const bg = [(bgKey >> 10 & 31) << 3, (bgKey >> 5 & 31) << 3, (bgKey & 31) << 3];

  const TH = 40 * 40;
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - bg[0], dg = d[i + 1] - bg[1], db = d[i + 2] - bg[2];
    const on = dr * dr + dg * dg + db * db > TH;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = on ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);

  // blur + generous re-threshold: closes gaps and slightly dilates, so
  // text, room corners and thin outlines are fully included in the reveal
  const c2 = document.createElement('canvas');
  c2.width = c.width; c2.height = c.height;
  const ctx2 = c2.getContext('2d');
  ctx2.filter = 'blur(4px)';
  ctx2.drawImage(c, 0, 0);
  const img2 = ctx2.getImageData(0, 0, c2.width, c2.height);
  const d2 = img2.data;
  for (let i = 3; i < d2.length; i += 4) d2[i] = d2[i] > 55 ? 255 : 0;
  ctx2.putImageData(img2, 0, 0);
  return c2;
}
