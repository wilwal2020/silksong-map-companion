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
  autoAlign(bitmap, rect, { pad = 0.3 } = {}) {
    const s = this.scale;
    const bmp = canvasOf(bitmap.width, bitmap.height);
    bmp.getContext('2d').drawImage(bitmap, 0, 0);

    // work inside a window around the current placement — wide enough to
    // absorb a rough drop, small enough that the search stays instant
    const padPx = Math.max(rect.w, rect.h) * pad;
    // whole composite pixels, so the last (1:1) pass lands the paste on an
    // exact pixel rather than the search window's own fractional origin
    const reg = {
      x: Math.round((rect.x - padPx) * s), y: Math.round((rect.y - padPx) * s),
      w: Math.round((rect.w + 2 * padPx) * s), h: Math.round((rect.h + 2 * padPx) * s),
    };

    // one search over ±winMap map px around `center`, at reduced width DW
    const pass = (DW, center, winMap) => {
      const f = Math.min(1, DW / reg.w);        // reduced px per composite px
      const rw = Math.max(24, Math.round(reg.w * f));
      const rh = Math.max(24, Math.round(reg.h * f));
      const ec = canvasOf(rw, rh);
      const ex = ec.getContext('2d', { willReadFrequently: true });
      ex.imageSmoothingEnabled = true;
      // a source rect reaching past the composite's edge is clipped in step
      // with the destination, so this stays aligned at the map borders
      ex.drawImage(this.canvas, reg.x, reg.y, reg.w, reg.h, 0, 0, rw, rh);
      const E = contrastMask(ec);
      if (E.n < rw * rh * 0.008) return null;   // nothing here to line up with
      const sat = summedArea(E.m, rw, rh);

      const pw = Math.round(rect.w * s * f), ph = Math.round(rect.h * s * f);
      if (pw < 12 || ph < 12) return null;
      const nc = canvasOf(pw, ph);
      const nx = nc.getContext('2d', { willReadFrequently: true });
      nx.imageSmoothingEnabled = true;
      nx.drawImage(bmp, 0, 0, pw, ph);
      const N = contrastMask(nc);
      if (N.n < 40) return null;
      // sample the shot's content points — a few hundred is plenty and keeps
      // the inner loop cheap
      const stride = Math.max(1, Math.ceil(N.n / 500));
      const px = [], py = [];
      let seen = 0;
      for (let p = 0; p < N.m.length; p++) {
        if (!N.m[p] || (seen++ % stride)) continue;
        px.push(p % pw); py.push((p / pw) | 0);
      }
      if (!px.length) return null;
      const back = N.n / px.length;             // sampled hits -> full count
      const bx = Math.round((center.x * s - reg.x) * f);
      const by = Math.round((center.y * s - reg.y) * f);
      const R = Math.max(2, Math.round(winMap * s * f));

      let best = null;
      for (let dy = -R; dy <= R; dy++) {
        const oy = by + dy;
        for (let dx = -R; dx <= R; dx++) {
          const ox = bx + dx;
          let inter = 0;
          for (let i = 0; i < px.length; i++) {
            const X = px[i] + ox, Y = py[i] + oy;
            if (X < 0 || X >= rw || Y < 0 || Y >= rh) continue;
            if (E.m[Y * rw + X]) inter++;
          }
          if (!inter) continue;
          const est = inter * back;
          const ecnt = satSum(sat, rw, rh, ox, oy, pw, ph);
          const score = est / (N.n + ecnt - est);
          if (!best || score > best.score) {
            best = { score, f, x: (ox / f + reg.x) / s, y: (oy / f + reg.y) / s };
          }
        }
      }
      return best;
    };

    // coarse, then two refinements: each pass only has to cover the previous
    // one's pixel size, so the window shrinks as the resolution grows
    let best = null, center = { x: rect.x, y: rect.y }, win = padPx, lastF = 0;
    for (const DW of [260, 700, 1500]) {
      if (lastF >= 1) break;                    // already at composite pixels
      const r = pass(DW, center, win);
      if (!r) break;
      best = r;
      center = { x: r.x, y: r.y };
      win = 2 / (r.f * s);                      // 2 px of the pass just done
      lastF = r.f;
    }
    if (!best) return null;
    return { x: best.x, y: best.y, w: rect.w, h: rect.h, score: best.score };
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
