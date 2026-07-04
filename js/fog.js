// Fog of war. Keeps a half-resolution "revealed" mask (white = revealed) and
// builds a darkness overlay canvas from it that the map view composites on top
// of the map image.

export class Fog {
  constructor(mapW, mapH, maskScale = 0.5) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.maskScale = maskScale;

    this.mask = document.createElement('canvas');
    this.mask.width = Math.round(mapW * maskScale);
    this.mask.height = Math.round(mapH * maskScale);
    this.maskCtx = this.mask.getContext('2d');

    this.dark = document.createElement('canvas');
    this.dark.width = this.mask.width;
    this.dark.height = this.mask.height;
    this.darkCtx = this.dark.getContext('2d');

    this.onChange = null; // set by app for persistence
    this.rebuild();
  }

  // Reveal a rectangle given in full map coordinates, with feathered edges.
  revealRect(x, y, w, h, feather = 40) {
    const s = this.maskScale;
    const ctx = this.maskCtx;
    ctx.save();
    ctx.filter = `blur(${Math.max(2, feather * s)}px)`;
    ctx.fillStyle = '#fff';
    // inset a little so the blur doesn't reveal past the true edges
    const inset = feather * s * 0.5;
    ctx.fillRect(x * s + inset, y * s + inset, w * s - inset * 2, h * s - inset * 2);
    ctx.restore();
    this.rebuild();
  }

  // Reveal using an arbitrary alpha mask canvas, mapped onto the rectangle
  // (x, y, w, h) in full map coordinates. Used for full-map updates where only
  // explored rooms should be revealed.
  revealMask(maskCanvas, x, y, w, h) {
    const s = this.maskScale;
    const ctx = this.maskCtx;
    ctx.save();
    ctx.filter = 'blur(2px)';
    ctx.drawImage(maskCanvas, x * s, y * s, w * s, h * s);
    ctx.restore();
    this.rebuild();
  }

  clear() {
    this.maskCtx.clearRect(0, 0, this.mask.width, this.mask.height);
    this.rebuild();
  }

  rebuild() {
    const ctx = this.darkCtx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.dark.width, this.dark.height);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, this.dark.width, this.dark.height);
    // punch holes where the mask is revealed
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(this.mask, 0, 0);
    ctx.restore();
    if (this.onChange) this.onChange();
  }

  async toBlob() {
    return new Promise(res => this.mask.toBlob(res, 'image/png'));
  }

  async loadFromBlob(blob) {
    const img = await createImageBitmap(blob);
    this.maskCtx.clearRect(0, 0, this.mask.width, this.mask.height);
    this.maskCtx.drawImage(img, 0, 0, this.mask.width, this.mask.height);
    img.close();
    this.rebuild();
  }
}
