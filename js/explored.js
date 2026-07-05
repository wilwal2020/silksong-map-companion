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
  // against the reference, so two overlapping pastes can be a few pixels
  // apart. When a new paste's rect overlaps already-composited content,
  // brute-force a small translation that best lines the new screenshot's
  // content up with what is already there, and return the nudged rect.
  refineAlignment(bitmap, rect) {
    const s = this.scale;
    const rxE = rect.x * s, ryE = rect.y * s, rwE = rect.w * s, rhE = rect.h * s;
    const DW = 220;
    const f = DW / rwE;                 // reduced px per explored px
    const DH = Math.max(1, Math.round(rhE * f));
    if (DH < 12) return rect;

    const toContent = (drawFn) => {
      const c = document.createElement('canvas');
      c.width = DW; c.height = DH;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingEnabled = true;
      drawFn(cx);
      const dd = cx.getImageData(0, 0, DW, DH).data;
      const m = new Uint8Array(DW * DH);
      let n = 0;
      for (let p = 0; p < m.length; p++) if (dd[p * 4 + 3] > 50) { m[p] = 1; n++; }
      return { m, n };
    };

    // existing composite content over the rect region
    const E = toContent(cx => cx.drawImage(this.canvas, rxE, ryE, rwE, rhE, 0, 0, DW, DH));
    if (E.n < DW * DH * 0.04) return rect; // negligible overlap — trust matcher

    // new screenshot content (keyed)
    const keyed = keyScreenshot(bitmap);
    const N = toContent(cx => cx.drawImage(keyed, 0, 0, DW, DH));
    if (N.n < DW * DH * 0.04) return rect;

    const R = Math.min(14, Math.max(3, Math.round(45 * s * f))); // ±~45 map px
    let best = { score: -1, dx: 0, dy: 0 };
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        let inter = 0;
        for (let y = 0; y < DH; y++) {
          const ey = y + dy;
          if (ey < 0 || ey >= DH) continue;
          const nrow = y * DW, erow = ey * DW;
          for (let x = 0; x < DW; x++) {
            if (!N.m[nrow + x]) continue;
            const ex = x + dx;
            if (ex < 0 || ex >= DW) continue;
            if (E.m[erow + ex]) inter++;
          }
        }
        // prefer the smallest shift among near-equal scores (stability)
        if (inter > best.score || (inter === best.score && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) {
          best = { score: inter, dx, dy };
        }
      }
    }
    return { ...rect, x: rect.x + best.dx / (f * s), y: rect.y + best.dy / (f * s) };
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
