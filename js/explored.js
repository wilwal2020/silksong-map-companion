// The explored map: a full-map-resolution canvas that accumulates the actual
// pasted screenshots at their matched positions. Nothing is drawn from the
// reference map — you see exactly what you screenshotted, so it can never show
// more (or less) than what was really on your in-game map.
//
// Each new screenshot is composited OPAQUELY on top of the previous ones, with
// only its outer rim feathered. Opaque means overlapping pastes never let the
// layers beneath show through, so slightly-misaligned overlaps can't
// accumulate doubled/ghosted outlines; the newest (best-aligned) paste always
// wins the overlap, and the feathered rim keeps the seam soft.

// Prepare a screenshot for compositing: full opacity in the interior, alpha
// ramped to zero over a rim margin so the rectangle edge blends into whatever
// is behind it (fog or an earlier paste).
function prepPaste(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const edge = Math.round(Math.min(W, H) * 0.06);
  if (edge > 0) {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const m = Math.min(x, y, W - 1 - x, H - 1 - y);
        if (m < edge) d[(y * W + x) * 4 + 3] = Math.round(255 * m / edge);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
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

  // composite a screenshot at map-rect (x, y, w, h), opaque, newest on top
  paste(bitmap, x, y, w, h) {
    const p = prepPaste(bitmap);
    const s = this.scale;
    this.ctx.drawImage(p, x * s, y * s, w * s, h * s);
    this._changed();
  }

  // Stitch alignment: the matcher places each screenshot independently
  // against the reference, so an overlapping paste can be slightly off in both
  // position and scale. When the new rect overlaps existing content,
  // brute-force the small scale + translation that best lines the new
  // screenshot's outlines up with the composite, and return the corrected
  // rect so the seam is continuous.
  refineAlignment(bitmap, rect) {
    const s = this.scale;
    const rxE = rect.x * s, ryE = rect.y * s, rwE = rect.w * s, rhE = rect.h * s;
    const DW = 280;
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

    const cx0 = DW / 2, cy0 = DH / 2;
    const scales = [0.965, 0.98, 0.99, 1.0, 1.01, 1.02, 1.035];
    const R = Math.min(16, Math.max(4, Math.round(40 * s * f))); // ±~40 map px
    let best = { score: -1, m: 1, dx: 0, dy: 0 };

    for (const m of scales) {
      nctx.clearRect(0, 0, DW, DH);
      const w2 = DW * m, h2 = DH * m;
      nctx.drawImage(bmpCanvas, cx0 - w2 / 2, cy0 - h2 / 2, w2, h2);
      const N = contrastMask(ncan);
      if (N.n < DW * DH * 0.02) continue;
      // pack content pixel coords for a tight inner loop
      const ix = [], iy = [];
      for (let p = 0; p < N.m.length; p++) if (N.m[p]) { ix.push(p % DW); iy.push((p / DW) | 0); }
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          let inter = 0;
          for (let k = 0; k < ix.length; k++) {
            const ex = ix[k] + dx, ey = iy[k] + dy;
            if (ex < 0 || ex >= DW || ey < 0 || ey >= DH) continue;
            if (E.m[ey * DW + ex]) inter++;
          }
          const cost = Math.abs(m - 1) * 60 + Math.hypot(dx, dy);
          if (inter > best.score ||
              (inter === best.score && cost < (Math.abs(best.m - 1) * 60 + Math.hypot(best.dx, best.dy)))) {
            best = { score: inter, m, dx, dy };
          }
        }
      }
    }

    const dxMap = best.dx / (f * s), dyMap = best.dy / (f * s);
    const ccx = rect.x + rect.w / 2, ccy = rect.y + rect.h / 2;
    const nw = rect.w * best.m, nh = rect.h * best.m;
    return { ...rect, w: nw, h: nh, x: ccx - nw / 2 + dxMap, y: ccy - nh / 2 + dyMap };
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
