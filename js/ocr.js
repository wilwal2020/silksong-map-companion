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

// black-text-on-white, upscaled so small labels are legible to the OCR.
// Text = notably brighter than its OWN local surroundings — a fixed global
// threshold either misses dim labels (unexplored-area names) or floods
// solid room fills into huge black blobs that break OCR segmentation.
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

  // local background: the shot heavily downscaled and stretched back up
  const bs = document.createElement('canvas');
  bs.width = Math.max(1, Math.round(shot.width / 8));
  bs.height = Math.max(1, Math.round(shot.height / 8));
  bs.getContext('2d').drawImage(shot, 0, 0, bs.width, bs.height);
  const bc = document.createElement('canvas');
  bc.width = W; bc.height = H;
  const bctx = bc.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(bs, 0, 0, W, H);
  const b = bctx.getImageData(0, 0, W, H).data;

  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const blum = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    const v = (lum > 55 && lum - blum > 20) ? 0 : 255;
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

const STOP = new Set(['the', 'of', 'and', 'a', 'to']);
function words(s) { return ((s || '').toLowerCase().match(/[a-z]{2,}/g) || []).filter(w => !STOP.has(w)); }

// how well a screenshot label string matches a reference area name, comparing
// word by word (so "Rest" matches "Pilgrim's Rest", "Fields" matches "Far
// Fields", etc.)
// Word pairing: exact equality is worth full weight; containment only counts
// when the lengths are comparable — "home" inside "mosshome" is NOT a match
// (that one placed a Halfway Home screenshot at Mosshome), "pilgrims" inside
// "pilgrim's" is.
function wordHit(c, l) {
  if (c === l && l.length >= 3) return 1;
  if (c.length >= 4 && l.length >= 4 && (c.includes(l) || l.includes(c))
      && Math.min(c.length, l.length) / Math.max(c.length, l.length) >= 0.67) return 0.7;
  return 0;
}
function matchScore(candText, labelName) {
  const cw = words(candText), lw = words(labelName);
  if (!cw.length || !lw.length) return 0;
  if (cw.join('') === lw.join('')) return 1; // exact, ignoring spaces/stopwords
  let matched = 0, strong = false, candHits = 0;
  for (const l of lw) {
    let hit = 0;
    for (const c of cw) {
      const h = wordHit(c, l);
      hit = Math.max(hit, h);
      if (h === 1 && l.length >= 5) strong = true; // exact long word — not containment
    }
    matched += hit;
  }
  for (const c of cw) if (lw.some(l => wordHit(c, l) > 0)) candHits++;
  if (!matched) return dice(cw.join(''), lw.join(''));
  const frac = matched / lw.length;      // share of the label's words seen
  const candFrac = candHits / cw.length; // share of the read text that fits
  return Math.max(strong ? 0.85 : 0, 0.55 + 0.45 * frac) * (0.75 + 0.25 * candFrac);
}

// OCR the shot and return candidate name lines in SHOT pixels
async function readLabels(shot) {
  const worker = await getWorker();
  const { canvas, scale } = preprocess(shot);
  const { data } = await worker.recognize(canvas);
  const all = (data.words || [])
    .map(w => ({
      t: (w.text || '').replace(/[^A-Za-z']/g, ''),
      c: w.confidence,
      x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale,
      x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale,
    }))
    .filter(w => w.t.length >= 2 && (w.y1 - w.y0) >= 6 && (w.y1 - w.y0) <= shot.height * 0.2);
  const words = all.filter(w => w.c >= 55);
  const weak = all.filter(w => w.c >= 25 && w.c < 55);

  // group into lines (similar baseline, horizontally adjacent)
  words.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const w of words) {
    const h = w.y1 - w.y0, cy = (w.y0 + w.y1) / 2;
    let line = null;
    for (const l of lines) {
      if (Math.abs(cy - l.cy) > l.h * 0.7) continue;
      // adjacent on EITHER side — y-sorting can visit "Lake" before "Craw",
      // and a right-only join then splits one name into two lines
      const gapR = w.x0 - l.x1, gapL = l.x0 - w.x1;
      if ((gapR <= l.h * 3 && gapR > -l.h) || (gapL <= l.h * 3 && gapL > -l.h)) { line = l; break; }
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

  // rescue: a low-confidence word sitting on an accepted line's baseline and
  // directly extending it is almost certainly part of the same name (the
  // stylized first word often scores low — "Bone" in "Bone Bottom" hit 45).
  // Without it the line's centre shifts and drags the placement with it.
  let attached = true;
  while (attached) {
    attached = false;
    for (let i = weak.length - 1; i >= 0; i--) {
      const w = weak[i];
      const h = w.y1 - w.y0, cy = (w.y0 + w.y1) / 2;
      for (const l of lines) {
        const lh = l.h;
        const gapR = w.x0 - l.x1, gapL = l.x0 - w.x1;
        if (Math.abs(cy - l.cy) > lh * 0.7) continue;
        if (!((gapR <= lh * 3 && gapR > -lh) || (gapL <= lh * 3 && gapL > -lh))) continue;
        l.text = w.x0 >= l.x0 ? l.text + ' ' + w.t : w.t + ' ' + l.text;
        l.x0 = Math.min(l.x0, w.x0); l.x1 = Math.max(l.x1, w.x1);
        l.y0 = Math.min(l.y0, w.y0); l.y1 = Math.max(l.y1, w.y1);
        l.cy = (l.cy + cy) / 2; l.h = (l.h + h) / 2;
        weak.splice(i, 1);
        attached = true;
        break;
      }
    }
  }

  return lines.map(l => ({
    text: l.text,
    cx: (l.x0 + l.x1) / 2,
    cy: (l.y0 + l.y1) / 2,
    h: l.y1 - l.y0,
    // a name touching the screenshot edge is likely truncated — its centre
    // is shifted, which poisons any scale/offset derived from it
    cut: l.x0 <= 2 || l.x1 >= shot.width - 2 || l.y0 <= 2 || l.y1 >= shot.height - 2,
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
  console.debug('[silksong-map] OCR lines:', cands.map(c => `"${c.text}" @${Math.round(c.cx)},${Math.round(c.cy)}${c.cut ? ' (cut)' : ''}`));
  if (!cands.length) return null;

  // best reference label for each candidate line; a line whose best and
  // runner-up are different labels with near-equal scores is ambiguous
  // ("Lake" alone fits Craw Lake AND Pale Lake) and must not place anything
  const matches = [];
  for (const c of cands) {
    let best = null, second = null;
    for (const lb of labels) {
      const s = matchScore(c.text, lb.name);
      if (!best || s > best.s) { second = best; best = { s, lb }; }
      else if (!second || s > second.s) second = { s, lb };
    }
    if (!best || best.s < 0.62) continue;
    if (second && second.lb.name !== best.lb.name && second.s >= best.s - 0.05) {
      console.debug('[silksong-map] ambiguous name dropped:', c.text, '→', best.lb.name, 'vs', second.lb.name);
      continue;
    }
    matches.push({ c, lb: best.lb, s: best.s });
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
  // one similarity fit (single scale + offset) over all clean name anchors —
  // with 3+ names this is overdetermined and pins scale and offset far
  // better than pairwise medians. Truncated (edge-cut) names are excluded:
  // their centres are shifted. Needs adequate spread between the names.
  const anchors = uniq.filter(m => !m.c.cut);
  let kDist = null, lsFit = null;
  if (anchors.length >= 2) {
    let cxm = 0, cym = 0, lxm = 0, lym = 0;
    for (const m of anchors) { cxm += m.c.cx; cym += m.c.cy; lxm += m.lb.x; lym += m.lb.y; }
    const n = anchors.length;
    cxm /= n; cym /= n; lxm /= n; lym /= n;
    let num = 0, den = 0;
    for (const m of anchors) {
      num += (m.c.cx - cxm) * (m.lb.x - lxm) + (m.c.cy - cym) * (m.lb.y - lym);
      den += (m.c.cx - cxm) ** 2 + (m.c.cy - cym) ** 2;
    }
    // den for two names d apart is d²/2 — this is the old >150px pair rule
    if (den >= 11000 && num > 0) {
      kDist = num / den;
      lsFit = { ox: lxm - kDist * cxm, oy: lym - kDist * cym };
    }
  }
  const kHeight = uniq[0].c.h > 0 ? uniq[0].lb.h / uniq[0].c.h : null;
  const hint = scaleHint > 0 ? scaleHint : null;
  const locked = lockedScale > 0 ? lockedScale : null;

  // what scale (if any) this paste should store as the new global, and how
  // trustworthy the source is (the content refiner widens its search band
  // for weak sources)
  let k = null, establishScale = null, scaleSource = 'locked';
  if (full && kDist) { k = establishScale = kDist; scaleSource = 'dist'; }
  else if (locked) {
    k = locked;
    // a stale locked scale (resolution change, old bad calibration) loses
    // to the player marker, which is accurate within ~3%
    if (hint && Math.abs(locked / hint - 1) > 0.08) { k = hint; scaleSource = 'marker'; }
  } else {
    if (kDist) { k = establishScale = kDist; scaleSource = 'dist'; }
    else if (hint) { k = establishScale = hint; scaleSource = 'marker'; }
    else if (kHeight) { k = establishScale = kHeight; scaleSource = 'height'; }
  }
  if (!(k > 0) || k < 0.03 || k > 60) return null;

  // offset = map coord of shot pixel (0,0): the least-squares offset when
  // the fit supplied the scale, otherwise a consensus across labels
  // (preferring names that are fully inside the frame)
  const use = anchors.length ? anchors : uniq;
  const oxs = use.map(m => m.lb.x - m.c.cx * k);
  const oys = use.map(m => m.lb.y - m.c.cy * k);
  let ox = median(oxs), oy = median(oys);
  if (lsFit && k === kDist) { ox = lsFit.ox; oy = lsFit.oy; }

  // reject if the labels disagree badly on the offset (a bad match set)
  if (use.length >= 2) {
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
    scaleSource,
    via: 'ocr',
    names: uniq.map(m => m.lb.name),
  };
}
