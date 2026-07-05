// The explored map: a full-map-resolution canvas that accumulates the actual
// pasted screenshots at their matched positions. Nothing is drawn from the
// reference map — you see exactly what you screenshotted, so the reveal can
// never show more (or less) than what was really on your in-game map.
//
// Each screenshot is soft-keyed against its own background before compositing,
// so the dark cloth background around the rooms fades into the black fog
// instead of tiling as visible rectangles. Edges are feathered so successive
// overlapping pastes blend rather than leaving hard seams.

// Turn a screenshot into an RGBA canvas whose alpha keys out the background:
// transparent where it matches the screenshot's dominant (background) colour,
// opaque over the drawn rooms/text/markers, with a feathered outer edge.
export function keyScreenshot(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  // dominant (background) colour via coarse quantization
  const hist = new Map();
  for (let i = 0; i < d.length; i += 16) {
    const key = (d[i] >> 3 << 10) | (d[i + 1] >> 3 << 5) | (d[i + 2] >> 3);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let bgKey = 0, bgCount = -1;
  for (const [k, v] of hist) if (v > bgCount) { bgCount = v; bgKey = k; }
  const bg = [(bgKey >> 10 & 31) << 3, (bgKey >> 5 & 31) << 3, (bgKey & 31) << 3];

  // colour-distance key: fully transparent at/under D0, opaque over D1
  const D0 = 16, D1 = 42;
  const edge = Math.round(Math.min(W, H) * 0.05); // feather margin at the rim
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      const dr = d[i] - bg[0], dg = d[i + 1] - bg[1], db = d[i + 2] - bg[2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      let a = dist <= D0 ? 0 : dist >= D1 ? 1 : (dist - D0) / (D1 - D0);
      // feather the rectangle rim
      if (edge > 0) {
        const m = Math.min(x, y, W - 1 - x, H - 1 - y);
        if (m < edge) a *= m / edge;
      }
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
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

  // composite a keyed screenshot at map-rect (x, y, w, h) in map coords
  paste(bitmap, x, y, w, h) {
    const keyed = keyScreenshot(bitmap);
    const s = this.scale;
    this.ctx.drawImage(keyed, x * s, y * s, w * s, h * s);
    this._changed();
  }

  // Stitch alignment: the matcher places each screenshot independently
  // against the reference, so two overlapping pastes can be slightly off in
  // both position AND scale. When a new paste's rect overlaps already-
  // composited content, brute-force the small scale + translation that best
  // lines the new screenshot's content up with what is already there, and
  // return the corrected rect.
  refineAlignment(bitmap, rect) {
    const s = this.scale;
    const rxE = rect.x * s, ryE = rect.y * s, rwE = rect.w * s, rhE = rect.h * s;
    const DW = 280;
    const f = DW / rwE;                 // reduced px per explored px
    const DH = Math.max(1, Math.round(rhE * f));
    if (DH < 16) return rect;

    // existing composite content over the rect region -> binary mask
    const ecan = document.createElement('canvas');
    ecan.width = DW; ecan.height = DH;
    const ectx = ecan.getContext('2d', { willReadFrequently: true });
    ectx.imageSmoothingEnabled = true;
    ectx.drawImage(this.canvas, rxE, ryE, rwE, rhE, 0, 0, DW, DH);
    const ed = ectx.getImageData(0, 0, DW, DH).data;
    const E = new Uint8Array(DW * DH);
    let eN = 0;
    for (let p = 0; p < E.length; p++) if (ed[p * 4 + 3] > 50) { E[p] = 1; eN++; }
    if (eN < DW * DH * 0.03) return rect; // negligible overlap — trust matcher

    const keyed = keyScreenshot(bitmap);
    const ncan = document.createElement('canvas');
    ncan.width = DW; ncan.height = DH;
    const nctx = ncan.getContext('2d', { willReadFrequently: true });
    nctx.imageSmoothingEnabled = true;

    const cx0 = DW / 2, cy0 = DH / 2;
    const scales = [0.965, 0.98, 0.99, 1.0, 1.01, 1.02, 1.035];
    const R = Math.min(16, Math.max(4, Math.round(40 * s * f))); // ±~40 map px
    let best = { score: -1, m: 1, dx: 0, dy: 0 };

    for (const m of scales) {
      // render the new content scaled by m about the grid centre
      nctx.clearRect(0, 0, DW, DH);
      const w2 = DW * m, h2 = DH * m;
      nctx.drawImage(keyed, cx0 - w2 / 2, cy0 - h2 / 2, w2, h2);
      const nd = nctx.getImageData(0, 0, DW, DH).data;
      // pack content pixel coords for a tight inner loop
      const ix = [], iy = [];
      for (let y = 0; y < DH; y++) {
        const row = y * DW;
        for (let x = 0; x < DW; x++) if (nd[(row + x) * 4 + 3] > 50) { ix.push(x); iy.push(y); }
      }
      if (ix.length < DW * DH * 0.03) continue;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          let inter = 0;
          for (let k = 0; k < ix.length; k++) {
            const ex = ix[k] + dx, ey = iy[k] + dy;
            if (ex < 0 || ex >= DW || ey < 0 || ey >= DH) continue;
            if (E[ey * DW + ex]) inter++;
          }
          // tie-break toward no change (m=1, zero shift) for stability
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
