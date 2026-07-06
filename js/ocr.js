// Area-name OCR: read the region name(s) printed on a map screenshot and
// look them up in the reference label table (assets/labels.json) to get an
// exact placement. This is far more reliable than shape-correlating tiny,
// low-resolution text, and when several names are visible it derives scale
// from the distance BETWEEN them, which keeps big multi-area screenshots from
// drifting out of alignment.

const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

let workerPromise = null;
let labelsPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (self.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the text reader (offline?)'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    await loadScript(TESSERACT_SRC);
    return self.Tesseract.createWorker('eng');
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

export function loadLabels() {
  if (!labelsPromise) {
    labelsPromise = fetch('assets/labels.json')
      .then(r => r.json())
      .then(j => j.labels || [])
      .catch(() => []);
  }
  return labelsPromise;
}

// black-text-on-white, upscaled so small labels are legible to the OCR
function preprocess(shot) {
  const scale = Math.min(4, Math.max(1.6, 1900 / shot.width));
  const W = Math.round(shot.width * scale), H = Math.round(shot.height * scale);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(shot, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const v = lum > 85 ? 0 : 255; // bright text -> black on white
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return { canvas: c, scale };
}

function norm(s) { return (s || '').toLowerCase().replace(/[^a-z]/g, ''); }

function bigrams(s) {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
function dice(a, b) {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const ga = bigrams(a), gb = bigrams(b);
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

// how well a screenshot label string matches a reference area name
function matchScore(candNorm, labelName) {
  const ln = norm(labelName);
  if (!candNorm || candNorm.length < 3) return 0;
  if (candNorm === ln) return 1;
  // a distinctive whole word contained on either side is a strong signal
  const stop = new Set(['the', 'of', 'and']);
  const candTokens = candNorm.match(/[a-z]{3,}/g) || [candNorm];
  const labelTokens = ln.match(/[a-z]{3,}/g) || [ln];
  for (const ct of candTokens) {
    if (ct.length < 4 || stop.has(ct)) continue;
    for (const lt of labelTokens) {
      if (lt.length < 4 || stop.has(lt)) continue;
      if (ct === lt || (ct.length >= 5 && lt.includes(ct)) || (lt.length >= 5 && ct.includes(lt))) {
        return 0.9;
      }
    }
  }
  if (ln.length >= 5 && candNorm.length >= 5 && (ln.includes(candNorm) || candNorm.includes(ln))) return 0.85;
  return dice(candNorm, ln);
}

// OCR the shot and return candidate name lines in SHOT pixels
async function readLabels(shot) {
  const worker = await getWorker();
  const { canvas, scale } = preprocess(shot);
  const { data } = await worker.recognize(canvas);
  const words = (data.words || [])
    .map(w => ({
      t: (w.text || '').replace(/[^A-Za-z']/g, ''),
      c: w.confidence,
      x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale,
      x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale,
    }))
    .filter(w => w.t.length >= 2 && w.c >= 55 && (w.y1 - w.y0) >= 6 && (w.y1 - w.y0) <= shot.height * 0.2);

  // group into lines (similar baseline, horizontally adjacent)
  words.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const w of words) {
    const h = w.y1 - w.y0, cy = (w.y0 + w.y1) / 2;
    let line = null;
    for (const l of lines) {
      if (Math.abs(cy - l.cy) <= l.h * 0.7 && w.x0 - l.x1 <= l.h * 3 && w.x0 - l.x1 > -l.h) { line = l; break; }
    }
    if (line) {
      line.text += ' ' + w.t;
      line.x0 = Math.min(line.x0, w.x0); line.x1 = Math.max(line.x1, w.x1);
      line.y0 = Math.min(line.y0, w.y0); line.y1 = Math.max(line.y1, w.y1);
      line.cy = (line.cy + cy) / 2; line.h = (line.h + h) / 2;
    } else {
      lines.push({ text: w.t, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, cy, h });
    }
  }
  return lines.map(l => ({
    text: l.text,
    cx: (l.x0 + l.x1) / 2,
    cy: (l.y0 + l.y1) / 2,
    h: l.y1 - l.y0,
  }));
}

// median helper
const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Locate a screenshot on the map by its area-name label(s).
// Returns a rect { x, y, w, h, score, z, ratio, via:'ocr' } in map px, or null.
export async function ocrLocate(shot, { full = false, scaleHint = null, lockedScale = null, onStatus } = {}) {
  const labels = await loadLabels();
  if (!labels.length) return null;
  if (onStatus) onStatus('Reading the area name…');

  const cands = await readLabels(shot);
  if (!cands.length) return null;

  // best reference label for each candidate line
  const matches = [];
  for (const c of cands) {
    const cn = norm(c.text);
    let best = null;
    for (const lb of labels) {
      const s = matchScore(cn, lb.name);
      if (!best || s > best.s) best = { s, lb };
    }
    if (best && best.s >= 0.62) {
      matches.push({ c, lb: best.lb, s: best.s });
    }
  }
  if (!matches.length) return null;

  // keep the single best match per reference label (avoid duplicates)
  const byLabel = new Map();
  for (const m of matches) {
    const prev = byLabel.get(m.lb.name);
    if (!prev || m.s > prev.s) byLabel.set(m.lb.name, m);
  }
  const uniq = [...byLabel.values()];

  // Every screenshot is at the same in-game zoom, so the scale is a single
  // GLOBAL value reused for every paste (positions vary, scale doesn't). It's
  // established once from the best source and only recalibrated by a full-map
  // paste, whose names are far enough apart to give the exact ratio.
  let kDist = null;
  if (uniq.length >= 2) {
    const ks = [];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = uniq[i], b = uniq[j];
        const shotD = Math.hypot(a.c.cx - b.c.cx, a.c.cy - b.c.cy);
        const mapD = Math.hypot(a.lb.x - b.lb.x, a.lb.y - b.lb.y);
        if (shotD > 40) ks.push(mapD / shotD); // far-apart names only
      }
    }
    if (ks.length) kDist = median(ks);
  }
  const kHeight = uniq[0].c.h > 0 ? uniq[0].lb.h / uniq[0].c.h : null;
  const hint = scaleHint > 0 ? scaleHint : null;
  const locked = lockedScale > 0 ? lockedScale : null;

  // what scale (if any) this paste should store as the new global
  let establishScale = null;
  if (full && kDist) establishScale = kDist;      // full map recalibrates exactly
  else if (!locked) establishScale = kDist || hint || kHeight; // first time
  const k = establishScale != null ? establishScale : locked;
  if (!(k > 0) || k < 0.03 || k > 60) return null;

  // offset = map coord of shot pixel (0,0), consensus across labels
  const oxs = uniq.map(m => m.lb.x - m.c.cx * k);
  const oys = uniq.map(m => m.lb.y - m.c.cy * k);
  const ox = median(oxs), oy = median(oys);

  // reject if the labels disagree badly on the offset (a bad match set)
  if (uniq.length >= 2) {
    const spread = Math.max(
      Math.max(...oxs) - Math.min(...oxs),
      Math.max(...oys) - Math.min(...oys),
    );
    if (spread > shot.width * k * 0.25) return null;
  }

  const bestScore = Math.max(...uniq.map(m => m.s));
  return {
    x: ox,
    y: oy,
    w: shot.width * k,
    h: shot.height * k,
    score: bestScore,
    z: 99,
    // multiple names cross-check each other → apply; a lone name is confirmed
    ratio: uniq.length >= 2 ? 0.4 : 0.9,
    establishScale,
    via: 'ocr',
    names: uniq.map(m => m.lb.name),
  };
}
