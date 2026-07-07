// Pan/zoom canvas viewer. Draws: black fog -> explored screenshots ->
// (optional) placement overlay for a screenshot being positioned. `mapImage`
// is used only for its dimensions (the reference map is never displayed).

export class MapView {
  constructor(canvas, mapImage, explored) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = mapImage;
    this.explored = explored;

    this.scale = 0.2;
    this.ox = 0;
    this.oy = 0;

    // placement overlay: { img, x, y, w } in map coords (h from aspect)
    this.placement = null;

    // debug: overlay the reference map to check alignment
    this.debugReveal = false;

    this.onViewChanged = null;
    this._raf = 0;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
    this._attachInput();
    this.fitToScreen();
  }

  fitToScreen() {
    const pad = 40;
    const sw = this.canvas.clientWidth - pad, sh = this.canvas.clientHeight - pad;
    this.scale = Math.min(sw / this.map.width, sh / this.map.height);
    this.minScale = this.scale * 0.5;
    this.maxScale = 4;
    this.ox = (this.canvas.clientWidth - this.map.width * this.scale) / 2;
    this.oy = (this.canvas.clientHeight - this.map.height * this.scale) / 2;
    this.requestRender();
  }

  screenToMap(px, py) {
    return { x: (px - this.ox) / this.scale, y: (py - this.oy) / this.scale };
  }
  mapToScreen(x, y) {
    return { x: x * this.scale + this.ox, y: y * this.scale + this.oy };
  }

  centerOn(x, y, scale) {
    if (scale) this.scale = Math.min(this.maxScale, Math.max(this.minScale, scale));
    this.ox = this.canvas.clientWidth / 2 - x * this.scale;
    this.oy = this.canvas.clientHeight / 2 - y * this.scale;
    this.requestRender();
  }

  setPlacement(p) {
    this.placement = p;
    this.canvas.classList.toggle('placing', !!p);
    this.requestRender();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
      if (this.onViewChanged) this.onViewChanged();
    });
  }

  render() {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);

    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.ox, dpr * this.oy);
    ctx.imageSmoothingQuality = 'high';

    // debug overlay: the reference map, faint, UNDER the explored composite,
    // so you can see how your pastes line up with it
    if (this.debugReveal) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.map, 0, 0, this.map.width, this.map.height);
      ctx.globalAlpha = 1;
    }

    // the explored map: your pasted screenshots composited at their matched
    // positions, over the black fog. The reference map is never drawn (it is
    // only used to work out where a screenshot goes) — no spoilers.
    ctx.drawImage(this.explored.canvas, 0, 0, this.map.width, this.map.height);

    // debug: also draw the reference OVER the pastes, faint, so the room
    // outlines can be compared directly on top of what you pasted
    if (this.debugReveal) {
      ctx.globalAlpha = 0.4;
      ctx.drawImage(this.map, 0, 0, this.map.width, this.map.height);
      ctx.globalAlpha = 1;
    }

    // subtle bounds so you can tell where the world map area is
    ctx.strokeStyle = 'rgba(216, 220, 237, 0.08)';
    ctx.lineWidth = 2 / this.scale;
    ctx.strokeRect(0, 0, this.map.width, this.map.height);

    if (this.placement) {
      const p = this.placement;
      const h = p.w * (p.img.height / p.img.width);
      ctx.globalAlpha = 0.65;
      ctx.drawImage(p.img, p.x, p.y, p.w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#e0c37e';
      ctx.lineWidth = 2 / this.scale;
      ctx.strokeRect(p.x, p.y, p.w, h);
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.requestRender();
  }

  _attachInput() {
    const c = this.canvas;
    let dragging = false, lastX = 0, lastY = 0;

    c.addEventListener('pointerdown', e => {
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
      c.classList.add('panning');
    });

    c.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (this.placement && !this.placement.locked) {
        this.placement.x += dx / this.scale;
        this.placement.y += dy / this.scale;
      } else {
        this.ox += dx;
        this.oy += dy;
      }
      this.requestRender();
    });

    const endDrag = e => {
      dragging = false;
      c.classList.remove('panning');
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0012);
      if (this.placement && !this.placement.locked) {
        // resize the placement around its center
        const p = this.placement;
        const h = p.w * (p.img.height / p.img.width);
        const cx = p.x + p.w / 2, cy = p.y + h / 2;
        p.w = Math.max(60, p.w * factor);
        const nh = p.w * (p.img.height / p.img.width);
        p.x = cx - p.w / 2; p.y = cy - nh / 2;
      } else {
        const ns = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
        const k = ns / this.scale;
        this.ox = e.clientX - (e.clientX - this.ox) * k;
        this.oy = e.clientY - (e.clientY - this.oy) * k;
        this.scale = ns;
      }
      this.requestRender();
    }, { passive: false });
  }
}
