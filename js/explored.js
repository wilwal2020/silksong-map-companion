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
//
// All of that is calibrated on Silksong's map. Games added by hand switch it
// off (`fadeBackground = false`) and composite their screenshots untouched —
// only the snip edge is feathered.

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

// Per-pixel alpha factors (0-255) for the content-halo look: 255 on drawn map
// content AND inside enclosed rooms, falling linearly to 0 within FADE_PX of
// them. "Background" is a flood from the screenshot's border: everything the
// flood can reach fades to black, everything else is kept. The flood is
// blocked by the screenshot's own outlines and — when a reference is
// supplied — by the reference map's room positions, so it can never slip
// through a doorway opening into a room and black out that room's interior.
// Only already-pasted pixels are ever kept; the reference can block the
// flood but can never add content of its own.
//
// `refShot` (optional, same W×H grid): 1 where the REFERENCE map has content
// at that pixel's map position.
function contentFade(d, opaque, W, H, fadePx, refShot = null) {
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
  // close dashed outlines with a small blur + threshold
  const mc = document.createElement('canvas');
  mc.width = W; mc.height = H;
  mc.getContext('2d').putImageData(md, 0, 0);
  const bc = document.createElement('canvas');
  bc.width = W; bc.height = H;
  const bx = bc.getContext('2d', { willReadFrequently: true });
  bx.filter = 'blur(2px)';
  bx.drawImage(mc, 0, 0);
  const bd = bx.getImageData(0, 0, W, H).data;
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < mask.length; p++) if (bd[p * 4 + 3] > 80) mask[p] = 1;

  // flood the reachable background from the border; with a reference it may
  // only travel over reference void, so it can never slip through a doorway
  // opening into a room's interior
  const seen = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  let head = 0, tail = 0;
  const push = p => {
    if (seen[p] || mask[p] || (refShot && refShot[p])) return;
    seen[p] = 1; q[tail++] = p;
  };
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

  // keep sources: drawn strokes + whatever the flood couldn't reach. Because
  // the flood is blocked by both the screenshot's own outlines and the
  // reference's room positions, every enclosed room interior stays kept —
  // only the void the screenshot border can actually reach fades to black.
  const src = new Uint8Array(W * H);
  for (let p = 0; p < src.length; p++) src[p] = seen[p] ? 0 : 1;

  const dt = chamferDT(src, W, H, fadePx, false);
  const cap = fadePx * 3;
  const f = new Uint8Array(W * H);
  for (let p = 0; p < f.length; p++) f[p] = 255 - ((255 * dt[p] / cap) | 0);
  return f;
}

// Prepare a screenshot for compositing: keep content and enclosed room
// interiors opaque, fade the background halo, and feather the snip edge —
// by true distance to the nearest transparent pixel, so freeform
// (non-rectangular) snips get the same soft edge a rectangular one does.
// `refContent` + `mapRect`: reference content mask (composite resolution)
// and where this paste lands, so contentFade can tell cut-through-a-room
// from open-to-the-void at the snip boundary.
// `fadeBg = false` composites the screenshot exactly as it is (only the snip
// edge is feathered): the fade decides what counts as "background" from
// Silksong's own look, and there's no telling what another game's map is
// supposed to look like.
function prepPaste(bitmap, refContent = null, mapRect = null, scale = 1, fadeBg = true) {
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
  // resample the reference content mask into shot space
  let refShot = null;
  if (fadeBg && refContent && mapRect) {
    refShot = new Uint8Array(W * H);
    const kx = mapRect.w * scale / W, ky = mapRect.h * scale / H;
    const rx0 = mapRect.x * scale, ry0 = mapRect.y * scale;
    for (let y = 0; y < H; y++) {
      const my = (ry0 + y * ky) | 0;
      if (my < 0 || my >= refContent.H) continue;
      const row = y * W, mrow = my * refContent.W;
      for (let x = 0; x < W; x++) {
        const mx = (rx0 + x * kx) | 0;
        if (mx >= 0 && mx < refContent.W && refContent.m[mrow + mx]) refShot[row + x] = 1;
      }
    }
  }
  const edge = Math.round(Math.min(W, H) * 0.06);
  const rim = edge > 0 ? chamferDT(trans, W, H, edge, true) : null;
  const fade = fadeBg ? contentFade(d, opaque, W, H, FADE_PX, refShot) : null;
  const cap = edge * 3;
  for (let p = 0; p < opaque.length; p++) {
    const i = p * 4;
    if (!d[i + 3]) continue;
    let a = d[i + 3];
    if (fade) {
      // fade the background toward BLACK: darken colour alongside the alpha
      // drop, so the void reads as clean black instead of a lingering brown
      // vignette tint. Kept content (fade 255) is untouched.
      const k = fade[p];
      d[i] = (d[i] * k / 255) | 0;
      d[i + 1] = (d[i + 1] * k / 255) | 0;
      d[i + 2] = (d[i + 2] * k / 255) | 0;
      a = a * k / 255;
    }
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

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// trace a map-coordinate polygon as a path in composite pixels
function tracePath(ctx, pts, s, dx, dy) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x * s + dx, pts[0].y * s + dy);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * s + dx, pts[i].y * s + dy);
  ctx.closePath();
}

// summed-area table over a 0/1 mask, so "how much content is under this
// rectangle" is four lookups instead of a scan
function summedArea(m, W, H) {
  const S = W + 1;
  const sat = new Int32Array(S * (H + 1));
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      run += m[y * W + x];
      sat[(y + 1) * S + x + 1] = sat[y * S + x + 1] + run;
    }
  }
  return sat;
}
function satSum(sat, W, H, x, y, w, h) {
  const S = W + 1;
  const x0 = Math.max(0, Math.min(W, x)), y0 = Math.max(0, Math.min(H, y));
  const x1 = Math.max(0, Math.min(W, x + w)), y1 = Math.max(0, Math.min(H, y + h));
  return sat[y1 * S + x1] - sat[y0 * S + x1] - sat[y1 * S + x0] + sat[y0 * S + x0];
}

// How far a growing world may go. Not a design limit so much as a memory one:
// the composite is a real canvas, and every map pixel is four bytes of it.
const MAX_WORLD_SIDE = 12000;
const MAX_WORLD_PIXELS = 48e6;   // ~190 MB at one canvas pixel per map pixel

// Side of the centred patch the sub-pixel stage judges on. Which fraction of a
// pixel fits best is a local question — a patch this size answers it as well as
// the whole footprint would, for a fraction of the redrawing.
const SUB_WINDOW = 384;

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
    this.refImage = null; // reference map, set by app; guides the bg fade
    this._refKeep = null;
    // Fade each paste's background to black on the way in. Tuned entirely on
    // Silksong's map (dark void, bright outlines) — for a game we know
    // nothing about, guessing which pixels are "background" would be
    // vandalism, so those composite exactly as screenshotted.
    this.fadeBackground = true;
  }

  // Make room for `rect`, with `pad` of clear ground around it, growing the
  // composite if it doesn't fit. Returns how far everything already on the
  // canvas had to move: growing at the left or top shifts every existing
  // pixel, and the caller moves the pins and the view by the same amount.
  //
  // Shifting rather than carrying an origin is deliberate. An origin would
  // spare the pins but would have to be subtracted at every single place that
  // turns a map coordinate into a canvas one — the aligner alone does that in
  // five places — and one missed subtraction is a bug that only appears once
  // somebody's map has grown leftwards. This way map coordinates stay exactly
  // what they always were: canvas pixels divided by `scale`.
  grow(rect, pad = 400) {
    const s = this.scale;
    const want = {
      l: Math.max(0, Math.ceil(pad - rect.x)),
      t: Math.max(0, Math.ceil(pad - rect.y)),
      r: Math.max(0, Math.ceil(rect.x + rect.w + pad - this.mapW)),
      b: Math.max(0, Math.ceil(rect.y + rect.h + pad - this.mapH)),
    };
    if (!want.l && !want.t && !want.r && !want.b) return { dx: 0, dy: 0, grew: false };

    // spend whatever headroom is left, nearest side first
    const roomW = Math.max(0, Math.min(MAX_WORLD_SIDE, MAX_WORLD_PIXELS / this.mapH) - this.mapW);
    const roomH = Math.max(0, Math.min(MAX_WORLD_SIDE, MAX_WORLD_PIXELS / this.mapW) - this.mapH);
    const dx = Math.min(want.l, roomW);
    const addR = Math.min(want.r, roomW - dx);
    const dy = Math.min(want.t, roomH);
    const addB = Math.min(want.b, roomH - dy);
    const capped = (dx < want.l) || (addR < want.r) || (dy < want.t) || (addB < want.b);
    const newW = Math.round(this.mapW + dx + addR);
    const newH = Math.round(this.mapH + dy + addB);
    if (newW === this.mapW && newH === this.mapH) return { dx: 0, dy: 0, grew: false, capped };

    const c = document.createElement('canvas');
    c.width = Math.round(newW * s);
    c.height = Math.round(newH * s);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(this.canvas, Math.round(dx * s), Math.round(dy * s));
    this.canvas = c;
    this.ctx = x;
    this.mapW = newW;
    this.mapH = newH;
    this._refKeep = null;      // the reference mask was cut to the old size
    this._changed();
    return { dx: Math.round(dx), dy: Math.round(dy), grew: true, capped };
  }

  // The reference map is NEVER displayed — the background fade only uses it
  // to tell whether a snip edge cuts through a room (keep the sliced room's
  // interior) or opens to the void (fade). It can never add anything.
  setReference(img) { this.refImage = img; this._refKeep = null; }

  // lazy reference content mask at composite resolution
  _refContentMask() {
    if (this._refKeep || !this.refImage) return this._refKeep;
    const W = this.canvas.width, H = this.canvas.height;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.drawImage(this.refImage, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;
    const m = new Uint8Array(W * H);
    for (let p = 0; p < m.length; p++) {
      const i = p * 4;
      if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 > 14) m[p] = 1;
    }
    this._refKeep = { m, W, H };
    return this._refKeep;
  }

  // composite a screenshot at map-rect (x, y, w, h), newest on top
  paste(bitmap, x, y, w, h) {
    const p = prepPaste(bitmap, this._refContentMask(), { x, y, w, h }, this.scale,
      this.fadeBackground);
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

  // Line a hand-placed screenshot up with what's already on the map. Purely
  // image-based — no reference map, no reading of names — so it works for any
  // game.
  //
  // MOVES ONLY, never resizes: every screenshot of a given game is taken at
  // the same in-game zoom, so the size is already right and only the position
  // is in question. That buys a much finer search — the passes below step the
  // offset down to single composite pixels instead of spending the budget on
  // scales that can't be wrong.
  //
  // The search stays around where you dropped the screenshot (a window of
  // `pad` × its size), and keeps the offset whose drawn lines overlap the
  // existing composite best: Jaccard over the paste's footprint, so a dense
  // patch of map can't win just by being dense. Returns a corrected rect with
  // its `score`, or null when there's nothing nearby to line up against.
  //
  // `pad` (multiples of the screenshot's size) is how far off the drop can be
  // and still be found. It is deliberately generous: a paste that lands
  // outside the window doesn't align badly, it doesn't align at all — which
  // reads as "it failed, but it works once I drag it closer". Widening it is
  // affordable because each pass is sized by its TEMPLATE (see `tw`), not by
  // the window, so a bigger search area no longer means a blurrier match.
  // `bound` — { lo, hi } as multiples of the size you set — is a hard limit on
  // the size that may come back, for when the CALLER has been told which way
  // the size is wrong. The ladder alone cannot enforce it: its rungs are
  // one-sided, but the fine climb that follows reaches ±25% in either
  // direction, so pressing "smaller" on a screenshot that was actually too
  // small used to hand back a BIGGER one.
  autoAlign(bitmap, rect, { pad = 1.6, scales = null, bound = null } = {}) {
    const s = this.scale;
    const bmp = canvasOf(bitmap.width, bitmap.height);
    bmp.getContext('2d').drawImage(bitmap, 0, 0);

    const padPx = Math.max(rect.w, rect.h) * pad;
    // Every size is tried around the drop's CENTRE, so a bigger or smaller
    // guess grows symmetrically instead of pinning one corner and dragging
    // the whole search window off to one side.
    const c0 = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const sizeAt = k => ({ w: rect.w * k, h: rect.h * k });
    const originAt = z => ({ x: c0.x - z.w / 2, y: c0.y - z.h / 2 });

    // One search over ±winMap map px around `center`, for a footprint of size
    // `z`. `tw` is how wide the screenshot itself is rendered for this pass —
    // that alone sets the resolution, so the window can grow without
    // coarsening the template. The region examined is only ever the footprint
    // plus that window, so a refinement pass stays cheap however wide the
    // first sweep was.
    const pass = (z, tw, center, winMap, wantPts, topK = 1) => {
      // whole composite pixels, so the last (1:1) pass lands the paste on an
      // exact pixel rather than the region's own fractional origin
      const reg = {
        x: Math.round((center.x - winMap) * s), y: Math.round((center.y - winMap) * s),
        w: Math.round((z.w + 2 * winMap) * s), h: Math.round((z.h + 2 * winMap) * s),
      };
      const f = Math.min(1, tw / (z.w * s)); // reduced px per composite px
      const rw = Math.max(24, Math.round(reg.w * f));
      const rh = Math.max(24, Math.round(reg.h * f));
      const ec = canvasOf(rw, rh);
      const ex = ec.getContext('2d', { willReadFrequently: true });
      ex.imageSmoothingEnabled = true;
      // a source rect reaching past the composite's edge is clipped in step
      // with the destination, so this stays aligned at the map borders
      ex.drawImage(this.canvas, reg.x, reg.y, reg.w, reg.h, 0, 0, rw, rh);
      const E = contrastMask(ec);
      // Nothing here to line up with. An absolute floor, NOT a share of the
      // region: the region grows with the search window, so a density test
      // would quietly stop finding matches exactly as the window widens.
      // Weak-but-present evidence is the caller's business — it scores low
      // and the caller's threshold rejects it.
      if (E.n < 40) return [];
      const sat = summedArea(E.m, rw, rh);

      const pw = Math.round(z.w * s * f), ph = Math.round(z.h * s * f);
      if (pw < 12 || ph < 12) return [];
      const nc = canvasOf(pw, ph);
      const nx = nc.getContext('2d', { willReadFrequently: true });
      nx.imageSmoothingEnabled = true;
      nx.drawImage(bmp, 0, 0, pw, ph);
      const N = contrastMask(nc);
      if (N.n < 40) return [];
      // sample the shot's content points — a few hundred is plenty and keeps
      // the inner loop cheap
      const stride = Math.max(1, Math.ceil(N.n / wantPts));
      const px = [], py = [];
      let seen = 0;
      for (let p = 0; p < N.m.length; p++) {
        if (!N.m[p] || (seen++ % stride)) continue;
        px.push(p % pw); py.push((p / pw) | 0);
      }
      if (!px.length) return [];
      const back = N.n / px.length;             // sampled hits -> full count
      const bx = Math.round((center.x * s - reg.x) * f);
      const by = Math.round((center.y * s - reg.y) * f);
      const R = Math.max(2, Math.round(winMap * s * f));

      // How much existing map has to sit under the footprint before `cover`
      // is worth believing. Deliberately absolute — a share of the FOOTPRINT,
      // floored — so it doesn't move with how much brand-new ground the
      // screenshot happens to add.
      const EV = Math.max(50, pw * ph * 0.008);

      // What share of the screenshot counts as content at all. A map is mostly
      // empty; a photograph is not. This is what any position would agree with
      // by chance, and `lift` below measures the agreement against it.
      const density = N.n / Math.max(1, pw * ph);

      // Scan outward from the drop in rings rather than row by row: a good
      // score found near the middle prunes most of the outer ground, and when
      // two spots tie the nearer one is already the incumbent.
      //
      // The sweep keeps the top few SPATIALLY DISTINCT peaks, not just the
      // winner. At the coarse resolution a correct fit that only clips the
      // existing map is not reliably the highest peak — refining each
      // candidate and judging them on the evidence then settles it, which
      // costs almost nothing because a refinement pass only looks at the
      // footprint.
      const found = [];
      const sep = Math.max(3, Math.round(pw * 0.3));
      let topJ = 0;                              // best Jaccard so far (prune only)
      const consider = (dx, dy) => {
        const ox = bx + dx, oy = by + dy;
        // Four table lookups say how much existing content is under the
        // footprint at all. Empty ground is rejected without touching a
        // single point, which is most of a wide window on a sparse map.
        const ecnt = satSum(sat, rw, rh, ox, oy, pw, ph);
        if (ecnt < EV * 0.15) return;
        // The Jaccard bound (score <= ecnt / N.n) prunes the rest, but
        // LOOSELY. A correct fit whose screenshot is mostly ground the map
        // hasn't got yet scores low on Jaccard by construction, so the tight
        // bound this used to apply threw away exactly the placements the
        // search is here to find.
        if (ecnt <= topJ * N.n * 0.25) return;
        let inter = 0;
        for (let i = 0; i < px.length; i++) {
          const X = px[i] + ox, Y = py[i] + oy;
          if (X < 0 || X >= rw || Y < 0 || Y >= rh) continue;
          if (E.m[Y * rw + X]) inter++;
        }
        if (!inter) return;
        const est = inter * back;
        const score = est / (N.n + ecnt - est);
        if (score > topJ) topJ = score;
        // How much of the map that IS under the footprint got matched —
        // recall against the existing composite, and nothing else. Jaccard
        // alone falls with the overlap AREA, so a correct match that only
        // clips the existing map scores no better than junk in a dense
        // region; this asks "of what was there to agree with, how much
        // agreed" and stays high however much brand-new ground the
        // screenshot brings with it.
        //
        // Dividing by `ecnt` alone is what makes it safe: measuring against
        // the SHOT's content instead (min(N.n, ecnt)) turns any saturated
        // patch of map into a perfect match, because nearly every point of
        // the shot lands on something lit. Here a dense patch inflates the
        // denominator and scores badly, which is the whole point.
        const cover = Math.min(1, est / Math.max(1, ecnt));
        // Evidence-weighted cover — the ranking signal. `cover` is what says
        // "this fits", and it holds up however much new ground the shot adds;
        // but it also climbs as the overlap shrinks, so a sliver of map that
        // happens to agree would win outright. The saturating evidence term
        // discounts exactly those and leaves a real overlap untouched.
        const evidence = Math.min(1, ecnt / EV);
        const cand = {
          score, f, ox, oy, w: z.w, h: z.h,
          x: (ox / f + reg.x) / s, y: (oy / f + reg.y) / s,
          cover, evidence, density, fit: cover * evidence,
          overlap: Math.min(ecnt, N.n) / N.n,
        };
        // one entry per neighbourhood — keep the best of each.
        //
        // Ranking stays on the overlap score. `cover` is the better question
        // to ask of ONE candidate ("did this fit?"), but it is a poor way to
        // choose BETWEEN them: it climbs as the overlap shrinks, so whichever
        // candidate hangs furthest off the edge of the map tends to win it.
        // The score's weakness — it sags when the screenshot brings a lot of
        // new ground — is handled where it belongs, at the accept gate.
        const near = found.find(c => Math.abs(c.ox - ox) < sep && Math.abs(c.oy - oy) < sep);
        if (near) {
          if (score > near.score) Object.assign(near, cand);
          return;
        }
        found.push(cand);
        found.sort((a, b) => b.score - a.score);
        if (found.length > topK) found.length = topK;
      };
      consider(0, 0);
      for (let r = 1; r <= R; r++) {
        for (let d = -r; d <= r; d++) { consider(d, -r); consider(d, r); }
        for (let d = -r + 1; d <= r - 1; d++) { consider(-r, d); consider(r, d); }
      }
      found.sort((a, b) => b.score - a.score);
      return found;
    };

    // A small template sweeps the whole window, then each refinement only has
    // to cover the previous pass's pixel size — so the window collapses as
    // fast as the resolution climbs, and the last pass works in whole
    // composite pixels.
    // One step up in resolution is enough to separate candidates; only the
    // survivor is worth taking all the way down to single pixels.
    const step = (c, tw, pts) =>
      c.f >= 1 ? c
        : (pass({ w: c.w, h: c.h }, tw, { x: c.x, y: c.y }, 2 / (c.f * s), pts)[0] || c);

    // Weigh candidate SIZES against each other on the same footing.
    //
    // Every measure taken inside `pass` is computed at that candidate's own
    // resolution — the template is always ~240px wide, whatever patch of map
    // it stands for — which makes those numbers useless for comparing sizes.
    // A footprint small enough to sit wholly inside the revealed patch
    // explains everything under it and scores a perfect `cover`, so when the
    // screenshot brings a lot of new ground the search happily shrinks it
    // onto the one patch it can explain and abandons the right answer.
    //
    // This re-measures a candidate at a FIXED resolution in map pixels, and
    // reports `mass`: how much existing map it actually accounts for. A
    // shrunken footprint explains less of it, so it can no longer win by
    // covering less ground perfectly.
    const fm = Math.min(1, 240 / (rect.w * s));   // reduced px per composite px
    const measure = c => {
      const rw = Math.max(8, Math.round(c.w * s * fm));
      const rh = Math.max(8, Math.round(c.h * s * fm));
      const ec = canvasOf(rw, rh);
      const ex = ec.getContext('2d', { willReadFrequently: true });
      ex.imageSmoothingEnabled = true;
      ex.drawImage(this.canvas, Math.round(c.x * s), Math.round(c.y * s),
        Math.round(c.w * s), Math.round(c.h * s), 0, 0, rw, rh);
      const E = contrastMask(ec);
      const nc = canvasOf(rw, rh);
      const nx = nc.getContext('2d', { willReadFrequently: true });
      nx.imageSmoothingEnabled = true;
      nx.drawImage(bmp, 0, 0, rw, rh);
      const N = contrastMask(nc);
      let inter = 0;
      for (let p = 0; p < E.m.length; p++) if (E.m[p] && N.m[p]) inter++;
      // `jac` is the overlap score again, but taken HERE, at the fixed
      // resolution — which is what makes it comparable between sizes when the
      // one computed inside a pass is not. It is the balanced judge of "does
      // this size agree": too big leaves screenshot content unexplained, too
      // small leaves map content out, and both cost.
      const union = N.n + E.n - inter;
      return {
        mass: inter,
        cover: E.n ? Math.min(1, inter / E.n) : 0,
        jac: union > 0 ? inter / union : 0,
      };
    };

    // One candidate size, searched properly: a fine local look around the
    // drop, at a resolution that can actually judge — not the coarse sweep's
    // verdict on it. The user aimed deliberately, so the answer is usually
    // within a nudge of the drop, and an 84px-wide template is far too blunt
    // to confirm that: on a wide screenshot whose overlap with the map is a
    // small strip, the correct spot doesn't reliably surface in the sweep at
    // all. Then the wide sweep, for when the drop really is a long way off.
    const atSize = z => {
      const org = originAt(z);
      const localWin = Math.max(60, Math.max(z.w, z.h) * 0.16);
      const local = pass(z, 240, org, localWin, 600, 3);
      const coarse = pass(z, 84, org, padPx, 300, 8);
      return [...local, ...coarse.map(c => step(c, 240, 600))];
    };

    // Choosing WHERE at a fixed size and choosing WHAT SIZE are different
    // questions, and the same number cannot answer both.
    //
    // Where: the overlap score. Cover would hand it to whichever candidate
    // hangs furthest off the edge of the map (see the note in `consider`).
    //
    // What size: how much existing map the candidate explains, re-measured at
    // one fixed resolution (see `measure`). Neither the overlap score nor
    // cover can compare sizes — both are computed at the candidate's own
    // resolution, so a smaller footprint comes out magnified and flatters
    // itself.
    const dist = c => Math.hypot(c.x + c.w / 2 - c0.x, c.y + c.h / 2 - c0.y);
    // Among positions that are all about as good, keep the one nearest to
    // where it was dropped: placing it right and having it jump somewhere
    // else is the worst thing this can do, and repetitive map corridors make
    // near-ties common. A genuinely better spot still wins, since it has to
    // be only slightly worse than the best to count as a tie at all.
    const pickPos = pool => {
      if (!pool.length) return null;
      const top = Math.max(...pool.map(c => c.score));
      return pool.filter(c => c.score >= top * 0.85).sort((a, b) => dist(a) - dist(b))[0];
    };
    // Sizes are judged on how much map they explain, but only among those
    // that actually fit where they sit — otherwise the biggest footprint
    // would win every time just by swallowing more ground. The preference
    // for the size you set is deliberately gentle: it breaks a genuine tie
    // and nothing more, or the ladder would be for show.
    // Every size decision, kept for the log. Which gate rejected the size that
    // should have won is the one thing you need to know when this comes out
    // wrong, and `cands` below cannot tell you: it carries the numbers a pass
    // computed at its own resolution, not the ones that actually choose.
    const sizeLog = [];
    const pickSize = pool => {
      if (!pool.length) return null;
      const rated = pool.map(c => ({ c, m: measure(c) }));
      // Agreement is judged RELATIVELY, against the best on offer, not against
      // a fixed bar. With a small overlap nothing reaches a fixed one, and
      // falling back to ranking on `mass` alone hands it to the largest
      // footprint every time — coincidental matches grow with area, so the
      // biggest size wins on size. Sizes that agree materially worse than the
      // best are out; among what is left, the one that explains the most map
      // wins, which is what stops the search shrinking onto one patch.
      //
      // The gate is `jac`, not `cover`: cover only asks how much of the map
      // was explained, which a too-large footprint can satisfy while leaving
      // most of the screenshot hanging unmatched.
      const bestJac = Math.max(...rated.map(r => r.m.jac));
      const use = rated.filter(r => r.m.jac >= bestJac * 0.85);
      const top = Math.max(...use.map(r => r.m.mass));
      const dev = r => Math.abs(Math.log(r.c.w / rect.w)) * 0.25
        + dist(r.c) / Math.max(1, rect.w);
      const won = top <= 0 ? use[0]
        : use.filter(r => r.m.mass >= top * 0.9).sort((a, b) => dev(a) - dev(b))[0];
      sizeLog.push(rated
        .sort((a, b) => a.c.w - b.c.w)
        .map(r => ({
          k: +(r.c.w / rect.w).toFixed(3),
          jac: +r.m.jac.toFixed(3), mass: r.m.mass, cover: +r.m.cover.toFixed(3),
          dev: +dev(r).toFixed(3),
          // where it dropped out, if it did
          out: r.m.jac < bestJac * 0.85 ? 'jac'
            : (top > 0 && r.m.mass < top * 0.9) ? 'mass' : null,
          won: r === won,
        })));
      return won.c;
    };

    // With no ladder this is exactly the old translation-only search: one
    // size, the one the user set.
    const ladder = scales && scales.length ? scales : [1];
    // Whether the size may move at all — which is not the same as having more
    // than one rung. A ladder of exactly one rung is a caller saying "try this
    // size, and only this one": it still has to be SEARCHED at that size and
    // then settled finely, where before both were keyed off `ladder.length > 1`
    // and a single rung quietly fell through to searching the size you set.
    const canResize = !!(scales && scales.length);
    const judged = [];
    let best = null;
    if (ladder.length > 1) {
      // Two stages, because running the full search at every rung is what
      // makes a WIDE ladder unaffordable — and a wide ladder is the whole
      // point. A game that lets you change the map zoom changes it in big
      // steps, so the answer is regularly half or double the size you set,
      // not a few percent off it.
      //
      // Stage 1: a cheap small-template probe at every size, only to find
      // which sizes are worth a proper look.
      const probes = [];
      for (const k of ladder) {
        const z = sizeAt(k);
        const c = pickPos(pass(z, 120, originAt(z), padPx, 300, 3));
        // measured at a fixed resolution, never by the pass's own numbers
        if (c) probes.push({ k, ...measure(c) });
      }
      // Shortlisted on AGREEMENT, not on how much map they cover.
      //
      // This used to rank on `mass`, and mass climbs with the footprint's area
      // — so on a map with plenty already on it the four largest rungs took
      // every place on the shortlist and the correct smaller size never got a
      // proper look. It was not a near miss: with the true size at 0.6 the
      // sizes that reached stage 2 were 1, 1.32, 1.52, 1.74 and 2.
      //
      // `jac` is the measure that survives being compared across sizes, which
      // is exactly what this stage does — too big leaves the screenshot
      // unexplained, too small leaves the map out, and both cost. It is also
      // the gate `pickSize` applies later, so the two stages now agree about
      // what makes a size worth considering. Mass still decides between the
      // survivors down there, where they are all plausible and the question is
      // which explains the most.
      probes.sort((a, b) => b.jac - a.jac);
      const keep = new Set(probes.slice(0, 4).map(p => p.k));
      keep.add(1);              // the size you set always gets a proper run
      // Stage 2: the real search, at the few sizes that look promising.
      const winners = [];
      for (const k of keep) {
        const all = atSize(sizeAt(k));
        judged.push(...all);
        const wnr = pickPos(all.filter(c => c && c.fit !== undefined));
        if (wnr) winners.push(wnr);
      }
      best = pickSize(winners);
    } else {
      judged.push(...atSize(sizeAt(ladder[0])));
      best = pickPos(judged.filter(c => c && c.fit !== undefined));
    }
    const usable = judged.filter(c => c && c.fit !== undefined);
    if (!best) return null;

    // Now climb to the right size at full resolution. The first bracket is
    // wide on purpose: the stage-1 probe is cheap and its ranking of sizes is
    // rough, so the rung that was actually right is regularly not among the
    // ones it kept — starting narrow would strand the search next to the
    // answer. Later rounds close in on the last couple of percent, which is
    // the difference between a seam and a blur.
    // The size the caller will accept, in composite px — a half-pixel of slack,
    // so a size sitting exactly on the limit survives. Everything downstream of
    // the ladder has to honour it, including the sub-pixel polish: it reaches
    // only 0.4%, but 0.4% the wrong way still turns "make it smaller" into a
    // bigger number on screen.
    const loW = bound ? rect.w * bound.lo - 0.5 : -Infinity;
    const hiW = bound ? rect.w * bound.hi + 0.5 : Infinity;
    if (canResize) {
      const inBound = c => c && c.fit !== undefined && c.w >= loW && c.w <= hiW;
      const rounds = [
        { ks: [0.8, 0.89, 1.13, 1.25], win: 0.12 },
        { ks: [0.93, 0.965, 1.036, 1.075], win: 0.07 },
        { ks: [0.97, 0.985, 1.015, 1.03], win: 0.05 },
      ];
      for (const { ks, win } of rounds) {
        const around = [best];
        for (const k of ks) {
          const z = { w: best.w * k, h: best.h * k };
          if (z.w < loW || z.w > hiW) continue;
          const wm = Math.max(30, Math.max(z.w, z.h) * win);
          const org = { x: best.x + (best.w - z.w) / 2, y: best.y + (best.h - z.h) / 2 };
          around.push(...pass(z, 240, org, wm, 600, 1));
        }
        const b2 = pickSize(around.filter(inBound));
        if (b2) best = b2;
      }
    }

    best = step(best, 620, 600);
    best = step(best, Infinity, 600);

    // ...and then settle the last pixel on the pixels themselves. The mask
    // search cannot see this far; `polish` compares the two pictures directly
    // and keeps whichever nudge comes out darkest where they overlap. The
    // do-nothing candidate is in its search, so it can only ever agree with
    // what is already here or improve on it.
    let tuned = null;
    try {
      const pk = [1, 0.996, 0.998, 1.002, 1.004]
        .filter(k => best.w * k >= loW && best.w * k <= hiW);
      tuned = this.polish(bmp, { x: best.x, y: best.y, w: best.w, h: best.h },
        pk.length ? { scales: pk } : { scales: [1] });
    } catch { tuned = null; }
    const out = tuned || best;

    // is this spot actually better than its neighbours, or would anywhere do?
    let sharp = null;
    try {
      sharp = this.distinctness(bmp, { x: out.x, y: out.y, w: out.w, h: out.h });
    } catch { sharp = null; }

    return {
      x: out.x, y: out.y, w: out.w, h: out.h,
      score: best.score, cover: best.cover, evidence: best.evidence,
      density: best.density, sharp: sharp ? +sharp.sharp.toFixed(3) : null,
      fit: best.fit, overlap: best.overlap, scale: out.w / rect.w,
      // what the final pixel-level pass changed, if anything
      polish: tuned
        ? { dx: tuned.dx, dy: tuned.dy, k: tuned.k, diff: +tuned.diff.toFixed(2) }
        : null,
      // how each size was judged, round by round, and which gate threw out the
      // ones that lost — this is what to read when it settles on a size that
      // is plainly not the one that fits
      sizes: sizeLog,
      // what else was in the running — this call is hard to reason about
      // from the outside, and the choice between candidates is where it goes
      // wrong when it goes wrong
      cands: usable.map(c => ({
        dx: Math.round(c.x - rect.x), dy: Math.round(c.y - rect.y),
        k: +(c.w / rect.w).toFixed(3),
        score: +c.score.toFixed(3), cover: +c.cover.toFixed(3),
        ev: +c.evidence.toFixed(2), fit: +c.fit.toFixed(3),
      })),
    };
  }

  // Final polish, on the ACTUAL PIXELS rather than a contrast mask.
  //
  // Everything before this matches structure: outlines reduced to black and
  // white, which is what makes the search robust enough to find a screenshot
  // anywhere on the map. It is also blunt — a mask pixel counts the same
  // whether the line under it is dead on or a pixel out, so the answer comes
  // back right to about a pixel and stops there. That last pixel is the
  // difference between a seam you can see and one you can't.
  //
  // So this asks the question the Difference view asks: slide it a little each
  // way, squeeze it by a hair, and keep whichever version comes out darkest
  // where the two overlap. Only where the composite actually has something —
  // ground the screenshot is the first to see has nothing to be wrong against,
  // and counting it would just reward sliding off into the dark.
  polish(bitmap, rect, { reach = 2, scales = [1, 0.996, 0.998, 1.002, 1.004] } = {}) {
    const s = this.scale;
    const R = Math.max(1, Math.round(reach * s));
    const fw = Math.round(rect.w * s), fh = Math.round(rect.h * s);
    if (fw < 24 || fh < 24) return null;

    // Sample a bounded number of points, spread over the whole footprint. Full
    // resolution matters here — this is a sub-pixel question and downscaling
    // would blur away the very thing being measured — so it is the COUNT that
    // is capped, not the size.
    const WANT = 20000;
    const stride = Math.max(1, Math.round(Math.sqrt((fw * fh) / WANT)));

    // the composite around one candidate size, read back once
    const prep = k => {
      const kw = Math.round(fw * k), kh = Math.round(fh * k);
      if (kw < 24 || kh < 24) return null;
      // keep the centre still, so a scale tweak doesn't smuggle in a shift
      const kx = Math.round(rect.x * s + (fw - kw) / 2);
      const ky = Math.round(rect.y * s + (fh - kh) / 2);
      const ew = kw + 2 * R + 2, eh = kh + 2 * R + 2;
      const ec = canvasOf(ew, eh);
      const ex = ec.getContext('2d', { willReadFrequently: true });
      // a source rect reaching past the composite's edge is clipped in step
      // with the destination, so this stays aligned at the map borders
      ex.drawImage(this.canvas, kx - R, ky - R, ew, eh, 0, 0, ew, eh);
      return { k, kw, kh, kx, ky, ew, E: ex.getImageData(0, 0, ew, eh).data };
    };

    // The screenshot drawn with a FRACTIONAL offset baked into the draw, which
    // is how this gets below a whole pixel: the canvas resamples it a quarter
    // of a pixel over, and that resampled version is what gets compared. Whole
    // steps can only ever land within half a pixel of right, and half a pixel
    // of blur is exactly what makes a seam visible.
    const shotAt = (p, fx, fy) => {
      const c = canvasOf(p.kw + 1, p.kh + 1);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingEnabled = true;
      x.drawImage(bitmap, fx, fy, p.kw, p.kh);
      return x.getImageData(0, 0, p.kw + 1, p.kh + 1).data;
    };

    // mean |difference| of that shot buffer against the composite, with the
    // shot's top-left at whole-pixel offset (ix, iy) from the candidate origin
    const score = (p, S, ix, iy) => {
      const SW = p.kw + 1;
      let wsum = 0, dsum = 0;
      // the outermost row and column carry only part of a resampled pixel
      for (let y = 1; y < p.kh; y += stride) {
        const erow = (y + R + iy) * p.ew + R + ix;
        const srow = y * SW;
        for (let x = 1; x < p.kw; x += stride) {
          const ei = (erow + x) * 4;
          const a = p.E[ei + 3];
          if (a < 24) continue;                // nothing there to be wrong against
          const si = (srow + x) * 4;
          if (S[si + 3] < 24) continue;
          const el = p.E[ei] * 0.299 + p.E[ei + 1] * 0.587 + p.E[ei + 2] * 0.114;
          const sl = S[si] * 0.299 + S[si + 1] * 0.587 + S[si + 2] * 0.114;
          const w = a / 255;                   // faded rim pixels count for less
          wsum += w;
          dsum += w * Math.abs(el - sl);
        }
      }
      return wsum < 200 ? null : dsum / wsum;  // too little overlap to judge by
    };

    // whole pixels first, across every candidate size
    let best = null;
    for (const k of scales) {
      const p = prep(k);
      if (!p) continue;
      const S0 = shotAt(p, 0, 0);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const diff = score(p, S0, dx, dy);
          if (diff != null && (!best || diff < best.diff)) best = { diff, p, ox: dx, oy: dy };
        }
      }
    }
    if (!best) return null;

    // ...then close in on the fraction, at the size that won.
    //
    // Judged on a centred window rather than the whole footprint: which
    // fraction of a pixel fits best is a local question, and the answer over a
    // 384px patch is the answer over all of it — while re-rendering the whole
    // screenshot sixteen times to find out is most of what this costs.
    const P = best.p;
    const sw = Math.min(P.kw - 2, SUB_WINDOW), sh = Math.min(P.kh - 2, SUB_WINDOW);
    if (sw >= 24 && sh >= 24) {
      const ax = Math.floor((P.kw - sw) / 2), ay = Math.floor((P.kh - sh) / 2);
      const wStride = Math.max(1, Math.round(Math.sqrt((sw * sh) / WANT)));
      // the same fractional draw as above, but only the middle of it kept
      const winAt = (fx, fy) => {
        const c = canvasOf(sw, sh);
        const x = c.getContext('2d', { willReadFrequently: true });
        x.imageSmoothingEnabled = true;
        x.drawImage(bitmap, fx - ax, fy - ay, P.kw, P.kh);
        return x.getImageData(0, 0, sw, sh).data;
      };
      const winScore = (S, ix, iy) => {
        let wsum = 0, dsum = 0;
        for (let y = 0; y < sh; y += wStride) {
          const erow = (y + ay + R + iy) * P.ew + ax + R + ix;
          const srow = y * sw;
          for (let x = 0; x < sw; x += wStride) {
            const ei = (erow + x) * 4;
            const a = P.E[ei + 3];
            if (a < 24) continue;
            const si = (srow + x) * 4;
            if (S[si + 3] < 24) continue;
            const el = P.E[ei] * 0.299 + P.E[ei + 1] * 0.587 + P.E[ei + 2] * 0.114;
            const sl = S[si] * 0.299 + S[si + 1] * 0.587 + S[si + 2] * 0.114;
            const w = a / 255;
            wsum += w;
            dsum += w * Math.abs(el - sl);
          }
        }
        return wsum < 200 ? null : dsum / wsum;
      };
      // the incumbent has to be re-measured on the window too, or it would be
      // compared against scores from a different set of pixels
      let cur = { ox: best.ox, oy: best.oy };
      cur.diff = winScore(winAt(0, 0), cur.ox, cur.oy);
      if (cur.diff != null) {
        // Two rounds of a shrinking ring settle it to an eighth of a pixel,
        // which is well past anything the eye picks out of a seam.
        for (const step of [0.5, 0.25]) {
          let round = cur;
          for (const dy of [-step, 0, step]) {
            for (const dx of [-step, 0, step]) {
              if (!dx && !dy) continue;
              const ox = cur.ox + dx, oy = cur.oy + dy;
              if (Math.abs(ox) > R || Math.abs(oy) > R) continue;
              const ix = Math.floor(ox), iy = Math.floor(oy);
              const diff = winScore(winAt(ox - ix, oy - iy), ix, iy);
              if (diff != null && diff < round.diff) round = { diff, ox, oy };
            }
          }
          cur = round;
        }
        best = { diff: best.diff, p: P, ox: cur.ox, oy: cur.oy };
      }
    }

    const p = best.p;
    return {
      diff: best.diff, dx: best.ox, dy: best.oy, k: p.k,
      x: (p.kx + best.ox) / s, y: (p.ky + best.oy) / s, w: p.kw / s, h: p.kh / s,
    };
  }

  // Does this fit DEPEND on being here? — the guard against agreeing by
  // accident.
  //
  // Every measure up to now asks how well the screenshot matches at the spot
  // that was found, and a picture with content nearly everywhere answers well
  // wherever it lands: a photo of a room is a wash of texture, so whatever map
  // is under it is "explained" by something. Asked only how good the fit is,
  // such a picture matches perfectly, anywhere on the map.
  //
  // What separates it from a real screenshot is not how well the winner
  // scores but how badly its NEIGHBOURS do. Shift a real map screenshot a good
  // way off and the lines stop meeting: the difference jumps. Shift a wash of
  // texture and nothing changes, because nothing was ever lining up. So this
  // compares the chosen spot against the same measure a stride away in eight
  // directions, and reports how much better being in the right place made it.
  distinctness(bitmap, rect, { reach = 30 } = {}) {
    const s = this.scale;
    const D = Math.max(6, Math.round(reach * s));
    const kw = Math.round(rect.w * s), kh = Math.round(rect.h * s);
    if (kw < 24 || kh < 24) return null;
    const kx = Math.round(rect.x * s), ky = Math.round(rect.y * s);
    const ew = kw + 2 * D, eh = kh + 2 * D;
    const ec = canvasOf(ew, eh);
    const ex = ec.getContext('2d', { willReadFrequently: true });
    ex.drawImage(this.canvas, kx - D, ky - D, ew, eh, 0, 0, ew, eh);
    const E = ex.getImageData(0, 0, ew, eh).data;
    const sc = canvasOf(kw, kh);
    const sx = sc.getContext('2d', { willReadFrequently: true });
    sx.imageSmoothingEnabled = true;
    sx.drawImage(bitmap, 0, 0, kw, kh);
    const S = sx.getImageData(0, 0, kw, kh).data;
    const stride = Math.max(1, Math.round(Math.sqrt((kw * kh) / 20000)));

    const at = (dx, dy) => {
      let wsum = 0, dsum = 0;
      for (let y = 0; y < kh; y += stride) {
        const erow = (y + D + dy) * ew + D + dx, srow = y * kw;
        for (let x = 0; x < kw; x += stride) {
          const ei = (erow + x) * 4;
          const a = E[ei + 3];
          if (a < 24) continue;
          const si = (srow + x) * 4;
          if (S[si + 3] < 24) continue;
          const el = E[ei] * 0.299 + E[ei + 1] * 0.587 + E[ei + 2] * 0.114;
          const sl = S[si] * 0.299 + S[si + 1] * 0.587 + S[si + 2] * 0.114;
          const wt = a / 255;
          wsum += wt;
          dsum += wt * Math.abs(el - sl);
        }
      }
      return wsum < 200 ? null : dsum / wsum;
    };

    const here = at(0, 0);
    if (here == null) return null;
    const away = [];
    for (const [dx, dy] of [[D, 0], [-D, 0], [0, D], [0, -D], [D, D], [-D, -D], [D, -D], [-D, D]]) {
      const v = at(dx, dy);
      if (v != null) away.push(v);
    }
    if (!away.length) return null;
    away.sort((a, b) => a - b);
    // the median of the neighbours, so one that happens to also line up (a
    // corridor repeating, say) doesn't speak for all eight
    const near = away[away.length >> 1];
    return { here, near, sharp: near > 0 ? Math.max(0, (near - here) / near) : 0 };
  }

  // Lift the part of the composite inside a map-coordinate polygon: hand it
  // back as its own canvas (everything outside the loop transparent) and cut
  // it out of the composite, so it can be moved and stamped down elsewhere.
  // Two areas of a game that turn out to connect need the map to be
  // rearrangeable, not just addable-to — see the lasso.
  liftRegion(pts) {
    const s = this.scale;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    // whole composite pixels: nothing is resampled on the way out or back
    const bx = Math.floor(x0 * s), by = Math.floor(y0 * s);
    const bw = Math.max(1, Math.ceil(x1 * s) - bx), bh = Math.max(1, Math.ceil(y1 * s) - by);

    const sel = canvasOf(bw, bh);
    const sx = sel.getContext('2d', { willReadFrequently: true });
    sx.save();
    tracePath(sx, pts, s, -bx, -by);
    sx.clip();
    sx.drawImage(this.canvas, -bx, -by);
    sx.restore();

    const cx = this.ctx;
    cx.save();
    tracePath(cx, pts, s, 0, 0);
    cx.globalCompositeOperation = 'destination-out';
    cx.fillStyle = '#000';
    cx.fill();
    cx.restore();
    this._changed();

    // a small alpha mask of the cut-out shape: dragging an irregular piece
    // should only grab the piece, not its whole bounding box
    const MW = Math.max(1, Math.min(160, bw));
    const MH = Math.max(1, Math.round(MW * bh / bw));
    const mc = canvasOf(MW, MH);
    const mx = mc.getContext('2d', { willReadFrequently: true });
    mx.imageSmoothingEnabled = true;
    mx.drawImage(sel, 0, 0, MW, MH);
    const md = mx.getImageData(0, 0, MW, MH).data;
    const mask = new Uint8Array(MW * MH);
    let solid = 0;
    for (let i = 0; i < mask.length; i++) if (md[i * 4 + 3] > 8) { mask[i] = 1; solid++; }

    return {
      canvas: sel,
      rect: { x: bx / s, y: by / s, w: bw / s, h: bh / s },
      mask: { w: MW, h: MH, data: mask },
      coverage: solid / mask.length,
    };
  }

  // Draw a canvas straight onto the composite — no background fade, no edge
  // feather. This is map that was already composited once; it's being moved,
  // not pasted, so it must come back down exactly as it was lifted.
  stamp(img, x, y, w, h) {
    const s = this.scale;
    this.ctx.drawImage(img, x * s, y * s, w * s, h * s);
    this._changed();
  }

  // Apply the content-halo fade to the composite as it stands: keeps rooms /
  // text / markers, fades every screenshot's own background tint away. For
  // maps built before background fading existed (or after many overlapping
  // pastes), this removes the visible rectangular seams in one go.
  cleanBackground() {
    const W = this.canvas.width, H = this.canvas.height;
    const img = this.ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const opaque = new Uint8Array(W * H);
    for (let p = 0; p < opaque.length; p++) if (d[p * 4 + 3] > 8) opaque[p] = 1;
    const ref = this._refContentMask(); // same resolution as the composite
    const fade = contentFade(d, opaque, W, H, FADE_PX, ref && ref.m);
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
  // Move a snapshot to match a world that grew after it was taken. Growing at
  // the left or top slides every pixel, and an undo state that predates the
  // growth would otherwise put the old map back in the wrong place.
  shiftSnapshot(snap, dx, dy) {
    if (!dx && !dy && snap.width === this.canvas.width && snap.height === this.canvas.height) return snap;
    const s = this.scale;
    const old = canvasOf(snap.width, snap.height);
    old.getContext('2d').putImageData(snap, 0, 0);
    const c = canvasOf(this.canvas.width, this.canvas.height);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(old, Math.round(dx * s), Math.round(dy * s));
    return x.getImageData(0, 0, c.width, c.height);
  }
  restore(snap) {
    // the world may have grown since the snapshot was taken; the margin it
    // gained was empty then and goes back to empty now
    if (snap.width !== this.canvas.width || snap.height !== this.canvas.height) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
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
    // at natural size, NOT stretched to the canvas: a growing world is saved
    // at whatever size it had reached, and stretching it to a canvas that has
    // since changed would silently rescale the whole map
    this.ctx.drawImage(img, 0, 0);
    img.close();
    this._changed();
  }
}
