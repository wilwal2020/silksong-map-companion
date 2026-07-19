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

  const bin = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < bin.length; i += 4, p++) {
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const blum = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    bin[p] = (lum > 55 && lum - blum > 20) ? 1 : 0;
  }

  // despeckle: dotted/dashed room outlines binarize into a sea of specks
  // that drowns the OCR's segmentation — drop components far smaller than a
  // letter. Scale-aware but capped: at low upscale factors serif letters
  // fragment into pieces a fixed cutoff would eat, while at high factors an
  // uncapped 16·scale² also ate letter fragments ("Halfway Home" vanished)
  const minSpeck = Math.min(60, Math.round(16 * scale * scale));
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const member = new Int32Array(4096);
  const comps = []; // letter-sized components kept — candidates for crop-OCR
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || seen[s]) continue;
    let top = 0, n = 0, overflow = false;
    let minX = W, maxX = 0, minY = H, maxY = 0;
    stack[top++] = s; seen[s] = 1;
    while (top > 0) {
      const p = stack[--top];
      if (n < member.length) member[n] = p; else overflow = true;
      n++;
      const x = p % W, y = (p / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && bin[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < W - 1 && bin[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (p >= W && bin[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[top++] = p - W; }
      if (p < W * (H - 1) && bin[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[top++] = p + W; }
    }
    if (!overflow && n < minSpeck) {
      for (let i = 0; i < n; i++) bin[member[i]] = 0;
    } else if (comps.length < 4000) {
      const w = maxX - minX + 1, h = maxY - minY + 1;
      // letters, but also whole-label blobs (letters fused with a decorative
      // underline become one wide component — still worth crop-reading)
      if (h >= 8 * scale && h <= 50 * scale && w <= h * 20 && n >= h * 1.2) {
        comps.push({ x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 });
      }
    }
  }

  for (let i = 0, p = 0; p < bin.length; i += 4, p++) {
    d[i] = d[i + 1] = d[i + 2] = bin[p] ? 0 : 255; // text black on white
  }
  ctx.putImageData(id, 0, 0);
  return { canvas: c, scale, comps };
}

// Second-chance OCR: whole-image recognition regularly skips a perfectly
// legible label (fickle page segmentation), but the letters are easy to FIND
// geometrically — letter-sized shapes in a row. Any such chain that the full
// passes didn't read gets cropped, blown up and OCR'd alone as a single text
// line, which sidesteps segmentation entirely.
async function cropOcr(worker, canvas, scale, comps, have) {
  comps.sort((a, b) => a.x0 - b.x0);
  const chains = [];
  for (const c of comps) {
    const h = c.y1 - c.y0, cy = (c.y0 + c.y1) / 2;
    let bc = null;
    for (const ch of chains) {
      if (Math.abs(cy - ch.cy) <= ch.lh * 0.6 && c.x0 - ch.x1 <= ch.lh * 2 && c.x0 - ch.x1 > -ch.lh) {
        if (!bc || ch.x1 > bc.x1) bc = ch;
      }
    }
    if (bc) {
      bc.n++;
      bc.x1 = Math.max(bc.x1, c.x1);
      bc.y0 = Math.min(bc.y0, c.y0); bc.y1 = Math.max(bc.y1, c.y1);
      bc.cy = bc.cy * 0.7 + cy * 0.3; bc.lh = bc.lh * 0.7 + h * 0.3;
    } else {
      chains.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, cy, lh: h, n: 1 });
    }
  }
  const cands = chains
    .filter(ch => (ch.n >= 2 || (ch.x1 - ch.x0) >= ch.lh * 2.5)
      && (ch.x1 - ch.x0) >= ch.lh * 2 && (ch.y1 - ch.y0) <= ch.lh * 2.2)
    .sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))
    .slice(0, 8);

  const out = [];
  for (const ch of cands) {
    // already read confidently by a full pass? skip the crop
    const covered = have.some(w => {
      if (w.c < 55) return false;
      const wx0 = w.x0 * scale, wx1 = w.x1 * scale, wy0 = w.y0 * scale, wy1 = w.y1 * scale;
      const ix = Math.min(ch.x1, wx1) - Math.max(ch.x0, wx0);
      const iy = Math.min(ch.y1, wy1) - Math.max(ch.y0, wy0);
      return ix > 0 && iy > 0 && ix * iy > 0.4 * (ch.x1 - ch.x0) * (ch.y1 - ch.y0);
    });
    if (covered) continue;
    const pad = Math.round(ch.lh * 0.6);
    const bx0 = Math.max(0, ch.x0 - pad), by0 = Math.max(0, ch.y0 - pad);
    const bw = Math.min(canvas.width, ch.x1 + pad) - bx0;
    const bh = Math.min(canvas.height, ch.y1 + pad) - by0;
    if (bw < 12 || bh < 8) continue;
    const u = Math.max(1, Math.min(3, 48 / ch.lh));
    const cc = document.createElement('canvas');
    cc.width = Math.round(bw * u); cc.height = Math.round(bh * u);
    const cctx = cc.getContext('2d', { willReadFrequently: true });
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(canvas, bx0, by0, bw, bh, 0, 0, cc.width, cc.height);
    // strip decorative underline strokes fused to the label: in the lower
    // part of the crop, whiten horizontal black runs far wider than any
    // letter stroke ("CHORAL CHAMBERS" read as "CORAL LIAM" through them)
    {
      const iid = cctx.getImageData(0, 0, cc.width, cc.height);
      const px = iid.data;
      const maxRun = Math.round(ch.lh * u * 1.1);
      for (let y = Math.round(cc.height * 0.55); y < cc.height; y++) {
        let run = 0;
        for (let x = 0; x <= cc.width; x++) {
          const black = x < cc.width && px[(y * cc.width + x) * 4] < 128;
          if (black) { run++; continue; }
          if (run > maxRun) {
            for (let i = x - run; i < x; i++) {
              const o = (y * cc.width + i) * 4;
              px[o] = px[o + 1] = px[o + 2] = 255;
            }
          }
          run = 0;
        }
      }
      cctx.putImageData(iid, 0, 0);
    }
    await worker.setParameters({ tessedit_pageseg_mode: '7' }); // single line
    const { data } = await worker.recognize(cc);
    console.debug('[silksong-map] crop read:', JSON.stringify((data.text || '').trim()),
      '@' + Math.round(bx0 / scale) + ',' + Math.round(by0 / scale),
      (data.words || []).map(w => Math.round(w.confidence)).join(','));
    for (const w of (data.words || [])) {
      out.push({
        t: (w.text || '').replace(/[^A-Za-z']/g, ''),
        c: w.confidence,
        crop: true, // read in isolation — trustworthy at lower confidence
        x0: (bx0 + w.bbox.x0 / u) / scale, y0: (by0 + w.bbox.y0 / u) / scale,
        x1: (bx0 + w.bbox.x1 / u) / scale, y1: (by0 + w.bbox.y1 / u) / scale,
      });
    }
  }
  return out;
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
function wordHit(c, l, allowFrag) {
  if (c === l && l.length >= 3) return 1;
  if (c.length >= 4 && l.length >= 4 && (c.includes(l) || l.includes(c))
      && Math.min(c.length, l.length) / Math.max(c.length, l.length) >= 0.67) return 0.7;
  // short OCR fragments ("Bel" or "ay" from a mangled "Bellway") are weak
  // but real evidence — counted only when another word of the label already
  // matched exactly, so they act as tie-breakers, never as identifications
  if (allowFrag) {
    if (c.length >= 3 && l.length > c.length && l.startsWith(c)) return 0.4;
    if (c.length >= 2 && l.length > c.length && (l.startsWith(c) || l.endsWith(c))) return 0.3;
  }
  return 0;
}
function matchScore(candText, labelName) {
  const cw = words(candText), lw = words(labelName);
  if (!cw.length || !lw.length) return 0;
  if (cw.join('') === lw.join('')) return 1; // exact, ignoring spaces/stopwords
  const allowFrag = lw.some(l => cw.some(c => c === l && l.length >= 3));
  let matched = 0, strong = false, candHits = 0;
  for (const l of lw) {
    let hit = 0;
    for (const c of cw) {
      const h = wordHit(c, l, allowFrag);
      hit = Math.max(hit, h);
      if (h === 1 && l.length >= 5) strong = true; // exact long word — not containment
    }
    matched += hit;
  }
  for (const c of cw) if (lw.some(l => wordHit(c, l, allowFrag) > 0)) candHits++;
  // whole-string similarity as a floor: heavily garbled reads ("tadel Spr"
  // for Citadel Spa) fail word pairing but are unmistakable as a string
  const whole = dice(cw.join(''), lw.join(''));
  if (!matched) return whole;
  const frac = matched / lw.length;      // share of the label's words seen
  const candFrac = candHits / cw.length; // share of the read text that fits
  return Math.max(whole, Math.max(strong ? 0.85 : 0, 0.55 + 0.45 * frac) * (0.75 + 0.25 * candFrac));
}

// OCR the shot and return candidate name lines in SHOT pixels.
// Tesseract's page segmentation is fickle on map imagery: automatic layout
// sometimes discards a clearly legible label that sparse-text mode finds,
// and vice versa — so run BOTH and union the words (dedupe by overlap).
// `labels` (the reference name table) is only a lexicon here: crop reads
// sometimes come back confidence 0 despite being letter-perfect ("WORMWAYS"
// read exactly, scored 0), and a read that exactly spells a real area name
// is self-validating — the odds of noise doing that are nil.
async function readLabels(shot, labels = []) {
  const worker = await getWorker();
  const { canvas, scale, comps } = preprocess(shot);
  const raw = [];
  for (const psm of ['11', '3']) { // SPARSE_TEXT, then AUTO
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(canvas);
    raw.push(...(data.words || []));
  }
  // max height: labels are a fixed size ON THE MAP, so in a small snip a
  // perfectly normal name is a big fraction of the frame — a purely relative
  // cap silently dropped those labels and small snips never got a name match.
  // The absolute floor keeps any plausibly label-sized text in play.
  const maxH = Math.max(shot.height * 0.2, 60);
  const sizeOk = w => w.t.length >= 2 && (w.y1 - w.y0) >= 6 && (w.y1 - w.y0) <= maxH;
  const mapped = raw
    .map(w => ({
      t: (w.text || '').replace(/[^A-Za-z']/g, ''),
      c: w.confidence,
      x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale,
      x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale,
    }))
    .filter(sizeOk);
  // crop-OCR any geometric text chain the full passes missed
  mapped.push(...(await cropOcr(worker, canvas, scale, comps, mapped)).filter(sizeOk));
  // union: two reads of the same word overlap heavily — keep the more
  // confident one, with a bonus for isolated crop reads (cleaner context:
  // a full-pass "CORAL" must not beat the crop's correct "CHORAL")
  const all = [];
  for (const w of mapped.sort((a, b) => (b.c + (b.crop ? 10 : 0)) - (a.c + (a.crop ? 10 : 0)))) {
    const dup = all.some(v => {
      const ix = Math.min(w.x1, v.x1) - Math.max(w.x0, v.x0);
      const iy = Math.min(w.y1, v.y1) - Math.max(w.y0, v.y0);
      if (ix <= 0 || iy <= 0) return false;
      const inter = ix * iy;
      const area = Math.min((w.x1 - w.x0) * (w.y1 - w.y0), (v.x1 - v.x0) * (v.y1 - v.y0));
      return inter > area * 0.5;
    });
    if (!dup) all.push(w);
  }
  // lexicon of ≥4-letter reference-name words for the confidence rescue
  const lex = new Set();
  for (const lb of labels) {
    for (const t of ((lb.name || '').toLowerCase().match(/[a-z]{4,}/g) || [])) lex.add(t);
  }
  const lexHit = w => {
    const t = (w.t || '').toLowerCase().replace(/[^a-z]/g, '');
    return t.length >= 4 && lex.has(t);
  };
  const strong = w => w.c >= 55 || (w.crop && (w.c >= 28 || lexHit(w)));
  const words = all.filter(strong);
  const weak = all.filter(w => w.c >= 25 && !strong(w));

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
      line.words.push(w);
      line.x0 = Math.min(line.x0, w.x0); line.x1 = Math.max(line.x1, w.x1);
      line.y0 = Math.min(line.y0, w.y0); line.y1 = Math.max(line.y1, w.y1);
      line.cy = (line.cy + cy) / 2; line.h = (line.h + h) / 2;
    } else {
      lines.push({ text: w.t, words: [w], x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, cy, h });
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
        l.words.push(w);
        l.x0 = Math.min(l.x0, w.x0); l.x1 = Math.max(l.x1, w.x1);
        l.y0 = Math.min(l.y0, w.y0); l.y1 = Math.max(l.y1, w.y1);
        l.cy = (l.cy + cy) / 2; l.h = (l.h + h) / 2;
        weak.splice(i, 1);
        attached = true;
        break;
      }
    }
  }

  // merge stacked two-line names — some labels render on two lines in game
  // ("Citadel" over "Spa") while the reference table has one centre for both
  let didMerge = true;
  while (didMerge) {
    didMerge = false;
    outer:
    for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines.length; j++) {
        if (i === j) continue;
        const a = lines[i], b = lines[j];
        if (b.y0 < a.y0) continue; // treat each pair once, a on top
        const lh = Math.max(a.h, b.h);
        const gap = b.y0 - a.y1;
        if (gap > lh || gap < -lh * 0.3) continue;
        const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (overlapX < 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) continue;
        a.text += ' ' + b.text;
        a.words.push(...b.words);
        a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1);
        a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1);
        a.cy = (a.y0 + a.y1) / 2; a.h = (a.h + b.h) / 2;
        lines.splice(j, 1);
        didMerge = true;
        break outer;
      }
    }
  }

  return lines.map(l => ({
    text: l.text,
    words: l.words,
    x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1,
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

  const cands = await readLabels(shot, labels);
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
    // anchor on only the words that actually matched the label — OCR junk
    // glued onto the line ("MID SF OD NG CHORAL CHAMBERS") shifts the line
    // centre far enough to push the refine window off target
    let anchor = c;
    const lw = words(best.lb.name);
    const hitWords = (c.words || []).filter(w => {
      const t = (w.t || '').toLowerCase().replace(/[^a-z]/g, '');
      return t && lw.some(l => wordHit(t, l, true) > 0);
    });
    if (hitWords.length && hitWords.length < (c.words || []).length) {
      const x0 = Math.min(...hitWords.map(w => w.x0)), x1 = Math.max(...hitWords.map(w => w.x1));
      const y0 = Math.min(...hitWords.map(w => w.y0)), y1 = Math.max(...hitWords.map(w => w.y1));
      anchor = { ...c, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    }
    matches.push({ c: anchor, lb: best.lb, s: best.s });
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
    // shot-px boxes of the matched name lines. Label text (and its decorative
    // underline, hence the downward padding) is ink drawn ON the map, not map
    // content — content verifiers can exclude it from their checks
    textBoxes: uniq.map(m => {
      const lh = Math.max(1, m.c.y1 - m.c.y0);
      return {
        x0: m.c.x0 - lh * 0.3, y0: m.c.y0 - lh * 0.2,
        x1: m.c.x1 + lh * 0.3, y1: m.c.y1 + lh,
      };
    }),
  };
}
