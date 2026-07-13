// The explored map: a full-map-resolution canvas that accumulates the actual
// pasted screenshots at their matched positions. Nothing is drawn from the
// reference map — you see exactly what you screenshotted, so it can never show
// more (or less) than what was really on your in-game map.
//
// Compositing look: map CONTENT (room outlines/fills, text, markers) is kept
// at full opacity while the screenshot's own background tint fades out over a
// soft halo around the content. Backgrounds are what made seams visible —
// each screenshot carries a slightly different vignette — so removing them
// makes overlapping pastes read as one continuous map. The outer edge (rect
// OR freeform snip shape) is additionally feathered by true distance to the
// nearest transparent pixel / border.

// how far (px) the background fades out around drawn content
const FADE_PX = 14;

// Chamfer distance transform (3/4 weights, thirds of a pixel) to the nearest
// source pixel; capped at capPx. If borderIsSource, outside the canvas also
// counts as a source (used for the edge feather).
function chamferDT(source, W, H, capPx, borderIsSource) {
  const CAP = capPx * 3;
  const dt = new Uint16Array(W * H);
  for (let p = 0; p < dt.length; p++) dt[p] = source[p] ? 0 : CAP;
  const B = borderIsSource ? 0 : CAP;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const p = row + x;
      if (!dt[p]) continue;
      const l = x > 0 ? dt[p - 1] : B;
      const u = y > 0 ? dt[p - W] : B;
      const ul = x > 0 && y > 0 ? dt[p - W - 1] : B;
      const ur = y > 0 && x < W - 1 ? dt[p - W + 1] : B;
      const v = Math.min(dt[p], l + 3, u + 3, ul + 4, ur + 4);
      dt[p] = v > CAP ? CAP : v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    const row = y * W;
    for (let x = W - 1; x >= 0; x--) {
      const p = row + x;
      if (!dt[p]) continue;
      const r = x < W - 1 ? dt[p + 1] : B;
      const d2 = y < H - 1 ? dt[p + W] : B;
      const dl = x > 0 && y < H - 1 ? dt[p + W - 1] : B;
      const dr = x < W - 1 && y < H - 1 ? dt[p + W + 1] : B;
      const v = Math.min(dt[p], r + 3, d2 + 3, dl + 4, dr + 4);
      dt[p] = v > CAP ? CAP : v;
    }
  }
  return dt;
}

// Coarse local background estimate from OPAQUE pixels only. The plain
// downscale trick (worker's binaryContentMask) breaks here: transparent
// regions — a freeform snip's surround, the composite's unexplored void —
// would drag the estimate toward black and make the background tint itself
// read as "content".
function coarseBackground(d, opaque, W, H) {
  const B = 20;
  const bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  const sum = new Float64Array(bw * bh * 3);
  const cnt = new Uint32Array(bw * bh);
  for (let y = 0; y < H; y++) {
    const by = (y / B) | 0;
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!opaque[p]) continue;
      const b = by * bw + ((x / B) | 0), i = p * 4;
      sum[b * 3] += d[i]; sum[b * 3 + 1] += d[i + 1]; sum[b * 3 + 2] += d[i + 2];
      cnt[b]++;
    }
  }
  let gr = 0, gg = 0, gb = 0, gn = 0;
  for (let b = 0; b < cnt.length; b++) {
    if (cnt[b]) { gr += sum[b * 3]; gg += sum[b * 3 + 1]; gb += sum[b * 3 + 2]; gn += cnt[b]; }
  }
  if (gn) { gr /= gn; gg /= gn; gb /= gn; }
  const small = new ImageData(bw, bh);
  for (let b = 0; b < cnt.length; b++) {
    const i = b * 4, n = cnt[b];
    small.data[i] = n ? sum[b * 3] / n : gr;
    small.data[i + 1] = n ? sum[b * 3 + 1] / n : gg;
    small.data[i + 2] = n ? sum[b * 3 + 2] / n : gb;
    small.data[i + 3] = 255;
  }
  const sc = document.createElement('canvas');
  sc.width = bw; sc.height = bh;
  sc.getContext('2d').putImageData(small, 0, 0);
  const uc = document.createElement('canvas');
  uc.width = W; uc.height = H;
  const ux = uc.getContext('2d', { willReadFrequently: true });
  ux.imageSmoothingEnabled = true;
  ux.drawImage(sc, 0, 0, W, H);
  return ux.getImageData(0, 0, W, H).data;
}

// Per-pixel keep factor (0-255): 255 on drawn map content — anything notably
// brighter than the local background tint: room outlines, fills, text, the
// player marker — falling to 0 within FADE_PX of it. Everything else is
// background and fades away, so each screenshot's own dark vignette drops to
// black and abutting/overlapping pastes read as one continuous map.
//
// Dark room interiors fade too. That is deliberate: a dark interior is
// indistinguishable from the black fog it sits in, so blacking it out looks
// identical — and the bright outline that defines every room's shape is
// always kept. Trying to tell "explored dark interior" from "unexplored
// background" by pixel value is unreliable (they are the same colour) and
// made rooms clear unpredictably; keeping only what is visibly drawn is
// simple and never wrong.
function contentFade(d, opaque, W, H, fadePx) {
  const bg = coarseBackground(d, opaque, W, H);
  const md = new ImageData(W, H);
  for (let p = 0; p < W * H; p++) {
    if (!opaque[p]) continue;
    const i = p * 4;
    const dr = d[i] - bg[i], dg = d[i + 1] - bg[i + 1], db = d[i + 2] - bg[i + 2];
    if (dr * dr + dg * dg + db * db > 1800) {
      md.data[i] = md.data[i + 1] = md.data[i + 2] = md.data[i + 3] = 255;
    }
  }
  // close dashed outlines with a small blur + threshold so room bodies read
  // as one shape, not a dotted ring
  const mc = document.createElement('canvas');
  mc.width = W; mc.height = H;
  mc.getContext('2d').putImageData(md, 0, 0);
  const bc = document.createElement('canvas');
  bc.width = W; bc.height = H;
  const bx = bc.getContext('2d', { willReadFrequently: true });
  bx.filter = 'blur(2px)';
  bx.drawImage(mc, 0, 0);
  const bd = bx.getImageData(0, 0, W, H).data;
  const src = new Uint8Array(W * H);
  for (let p = 0; p < src.length; p++) if (bd[p * 4 + 3] > 80) src[p] = 1;

  const dt = chamferDT(src, W, H, fadePx, false);
  const cap = fadePx * 3;
  const f = new Uint8Array(W * H);
  for (let p = 0; p < f.length; p++) f[p] = 255 - ((255 * dt[p] / cap) | 0);
  return f;
}

// Prepare a screenshot for compositing: keep drawn content, fade the
// background to black, and feather the snip edge — by true distance to the
// nearest transparent pixel, so freeform (non-rectangular) snips get the
// same soft edge a rectangular one does. In the faded band the colour is
// darkened toward black alongside the alpha drop, so the transition reads as
// clean black instead of a lingering brown vignette tint.
function prepPaste(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const opaque = new Uint8Array(W * H);
  const trans = new Uint8Array(W * H);
  for (let p = 0; p < opaque.length; p++) {
    if (d[p * 4 + 3] > 8) opaque[p] = 1; else trans[p] = 1;
  }
  const edge = Math.round(Math.min(W, H) * 0.06);
  const rim = edge > 0 ? chamferDT(trans, W, H, edge, true) : null;
  const fade = contentFade(d, opaque, W, H, FADE_PX);
  const cap = edge * 3;
  for (let p = 0; p < opaque.length; p++) {
    const i = p * 4;
    if (!d[i + 3]) continue;
    const k = fade[p];
    d[i] = (d[i] * k / 255) | 0;
    d[i + 1] = (d[i + 1] * k / 255) | 0;
    d[i + 2] = (d[i + 2] * k / 255) | 0;
    let a = d[i + 3] * k / 255;
    if (rim && rim[p] < cap) a = a * rim[p] / cap;
    d[i + 3] = a | 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Binary "content" mask (room outlines / text / markers) of a canvas, from
// local contrast — a pixel notably brighter than its coarse local mean. Works
// on the opaque composite and on a raw screenshot alike, so the two can be
// aligned to each other. Returns { m: Uint8Array, n: count }.
function contrastMask(cnv) {
  const W = cnv.width, H = cnv.height;
  const d = cnv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const bw = Math.max(1, W >> 3), bh = Math.max(1, H >> 3);
  const bc = document.createElement('canvas');
  bc.width = bw; bc.height = bh;
  bc.getContext('2d').drawImage(cnv, 0, 0, bw, bh);
  const uc = document.createElement('canvas');
  uc.width = W; uc.height = H;
  const ux = uc.getContext('2d', { willReadFrequently: true });
  ux.imageSmoothingEnabled = true;
  ux.drawImage(bc, 0, 0, W, H);
  const bd = ux.getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  let n = 0;
  for (let p = 0; p < m.length; p++) {
    const i = p * 4;
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const blum = bd[i] * 0.299 + bd[i + 1] * 0.587 + bd[i + 2] * 0.114;
    if (lum - blum > 10 || lum > 95) { m[p] = 1; n++; }
  }
  return { m, n };
}

export class Explored {
  constructor(mapW, mapH, scale = 1) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.scale = scale;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(mapW * scale);
    this.canvas.height = Math.round(mapH * scale);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.ctx.imageSmoothingQuality = 'high';
    this.onChange = null; // set by app for persistence / rerender
  }

  // composite a screenshot at map-rect (x, y, w, h), newest on top
  paste(bitmap, x, y, w, h) {
    const p = prepPaste(bitmap);
    const s = this.scale;
    this.ctx.drawImage(p, x * s, y * s, w * s, h * s);
    this._changed();
  }

  // Stitch alignment: all screenshots share one in-game zoom and are locked
  // to a single scale, so overlapping pastes differ only by translation.
  // When the new rect overlaps existing content, brute-force the small shift
  // that best lines the new screenshot's outlines up with the composite, and
  // return the corrected rect so the seam is continuous.
  // `maxShift` (map px) caps the search: reference-aligned pastes only need
  // a few-pixel nudge to stitch seamlessly, and a tight cap keeps them from
  // being dragged toward an older, worse-placed paste.
  refineAlignment(bitmap, rect, { maxShift = 45 } = {}) {
    const s = this.scale;
    const rxE = rect.x * s, ryE = rect.y * s, rwE = rect.w * s, rhE = rect.h * s;
    const DW = 320;
    const f = DW / rwE;                 // reduced px per explored px
    const DH = Math.max(1, Math.round(rhE * f));
    if (DH < 16) return rect;

    // existing composite content over the rect region
    const ecan = document.createElement('canvas');
    ecan.width = DW; ecan.height = DH;
    const ectx = ecan.getContext('2d', { willReadFrequently: true });
    ectx.imageSmoothingEnabled = true;
    ectx.drawImage(this.canvas, rxE, ryE, rwE, rhE, 0, 0, DW, DH);
    const E = contrastMask(ecan);
    if (E.n < DW * DH * 0.02) return rect; // negligible overlap — trust matcher

    const bmpCanvas = document.createElement('canvas');
    bmpCanvas.width = bitmap.width; bmpCanvas.height = bitmap.height;
    bmpCanvas.getContext('2d').drawImage(bitmap, 0, 0);

    const ncan = document.createElement('canvas');
    ncan.width = DW; ncan.height = DH;
    const nctx = ncan.getContext('2d', { willReadFrequently: true });
    nctx.imageSmoothingEnabled = true;

    // translation-only search — scale is locked, so pure shift lines them up
    nctx.clearRect(0, 0, DW, DH);
    nctx.drawImage(bmpCanvas, 0, 0, DW, DH);
    const N = contrastMask(ncan);
    if (N.n < DW * DH * 0.02) return rect;
    const ix = [], iy = [];
    for (let p = 0; p < N.m.length; p++) if (N.m[p]) { ix.push(p % DW); iy.push((p / DW) | 0); }

    const R = Math.min(24, Math.max(2, Math.round(maxShift * s * f)));
    let best = { score: -1, dx: 0, dy: 0 };
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        let inter = 0;
        for (let k = 0; k < ix.length; k++) {
          const ex = ix[k] + dx, ey = iy[k] + dy;
          if (ex < 0 || ex >= DW || ey < 0 || ey >= DH) continue;
          if (E.m[ey * DW + ex]) inter++;
        }
        if (inter > best.score || (inter === best.score && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) {
          best = { score: inter, dx, dy };
        }
      }
    }

    return { ...rect, x: rect.x + best.dx / (f * s), y: rect.y + best.dy / (f * s) };
  }

  // Apply the content fade to the composite as it stands: keeps drawn rooms /
  // text / markers, fades every screenshot's background to black. For maps
  // built before background fading existed (or after many overlapping pastes),
  // this removes the visible rectangular seams in one go.
  cleanBackground() {
    const W = this.canvas.width, H = this.canvas.height;
    const img = this.ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const opaque = new Uint8Array(W * H);
    for (let p = 0; p < opaque.length; p++) if (d[p * 4 + 3] > 8) opaque[p] = 1;
    const fade = contentFade(d, opaque, W, H, FADE_PX);
    for (let p = 0; p < opaque.length; p++) {
      const i = p * 4;
      if (!d[i + 3]) continue;
      const k = fade[p];
      d[i] = (d[i] * k / 255) | 0;
      d[i + 1] = (d[i + 1] * k / 255) | 0;
      d[i + 2] = (d[i + 2] * k / 255) | 0;
      d[i + 3] = (d[i + 3] * k / 255) | 0;
    }
    this.ctx.putImageData(img, 0, 0);
    this._changed();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._changed();
  }

  // undo support: cheap pixel snapshot / restore
  snapshot() {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }
  restore(snap) {
    this.ctx.putImageData(snap, 0, 0);
    this._changed();
  }

  // has anything been pasted? cheap: downscale the composite and look for any
  // opaque pixel. Called on change (paste/clear/undo/load), never per-frame.
  isBlank() {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(this.canvas, 0, 0, s, s);
    const d = x.getImageData(0, 0, s, s).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  }

  _changed() { if (this.onChange) this.onChange(); }

  async toBlob() {
    return new Promise(res => this.canvas.toBlob(res, 'image/png'));
  }

  async loadFromBlob(blob) {
    const img = await createImageBitmap(blob);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    img.close();
    this._changed();
  }
}
