// Pan/zoom canvas viewer. Draws: black fog -> explored screenshots ->
// (optional) placement overlay for a screenshot being positioned. `world` is
// used only for its dimensions ({ width, height }) — a custom game has no map
// image at all. `reference`, when a game has one, is the full map: never drawn
// except by the "Reveal map" comparison toggle.

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class MapView {
  constructor(canvas, world, explored, reference = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = world;
    this.reference = reference;
    this.explored = explored;

    this.scale = 0.2;
    this.ox = 0;
    this.oy = 0;

    // placement overlay: { img, x, y, w } in map coords (h from aspect)
    this.placement = null;

    // lasso: { pts, drawing, resolve } while a loop is being drawn
    this.lasso = null;

    // ghost: a pasted screenshot shown floating while it's being located,
    // then flown into place (see showGhost / flyGhostTo / settleGhost)
    this.ghost = null;
    this._ghostRaf = 0;
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // "Reveal map": lay the full world map over yours to compare them
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

  // keep the world in view: the map can't be dragged fully off-screen. When the
  // map is bigger than the viewport it must cover it (no black gaps); when it's
  // smaller it stays inside. A modest overscroll margin keeps panning from
  // feeling like it hits a wall.
  _clampView() {
    const vw = this.canvas.clientWidth, vh = this.canvas.clientHeight;
    const mw = this.map.width * this.scale, mh = this.map.height * this.scale;
    const mx = Math.min(vw, mw) * 0.3, my = Math.min(vh, mh) * 0.3;
    const loX = Math.min(0, vw - mw) - mx, hiX = Math.max(0, vw - mw) + mx;
    const loY = Math.min(0, vh - mh) - my, hiY = Math.max(0, vh - mh) + my;
    this.ox = Math.min(hiX, Math.max(loX, this.ox));
    this.oy = Math.min(hiY, Math.max(loY, this.oy));
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

  // ---- lasso: draw a loop around part of the map --------------------------

  // Resolves with the loop's points (map coords) once it's drawn, or null if
  // it was cancelled or too small to mean anything.
  captureLasso() {
    return new Promise(resolve => {
      this.lasso = { pts: [], drawing: false, resolve };
      this.canvas.classList.add('lassoing');
      this.requestRender();
    });
  }

  cancelLasso() {
    const l = this.lasso;
    if (!l) return;
    this._endLasso();
    l.resolve(null);
  }

  _endLasso() {
    this.lasso = null;
    this.canvas.classList.remove('lassoing');
    this.requestRender();
  }

  _finishLasso() {
    const l = this.lasso;
    if (!l) return;
    const pts = l.pts;
    this._endLasso();
    // a stray click isn't a selection
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const tiny = pts.length < 3 || (x1 - x0) * this.scale < 12 || (y1 - y0) * this.scale < 12;
    l.resolve(tiny ? null : pts);
  }

  _drawLasso(ctx) {
    const l = this.lasso;
    if (!l || l.pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(l.pts[0].x, l.pts[0].y);
    for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i].x, l.pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(224,195,126,.13)';
    ctx.fill();
    ctx.strokeStyle = '#e0c37e';
    ctx.lineWidth = 2 / this.scale;
    ctx.setLineDash([9 / this.scale, 6 / this.scale]);
    ctx.stroke();
    ctx.restore();
  }

  // ---- manual placement: drag the screenshot where it belongs -------------

  // p = { img, x, y, w } in map coords (height follows the image's aspect).
  // Custom games have no reference map to match against, so this is how a
  // paste gets positioned: drag it, Shift+scroll to resize.
  setPlacement(p) {
    this.placement = p;
    this.canvas.classList.toggle('placing', !!p);
    if (p && this.onPlacementChanged) this.onPlacementChanged(this.placementRect());
    this.requestRender();
  }

  placementRect() {
    const p = this.placement;
    if (!p) return null;
    return { x: p.x, y: p.y, w: p.w, h: p.w * (p.img.height / p.img.width) };
  }

  // Announce a discrete change to the placement BEFORE it happens, with the
  // rect as it stands — that's what an undo needs to put back. `kind` lets
  // the app treat a continuous gesture (a scroll-resize) as one step.
  _beginEdit(kind) {
    if (this.onPlacementEdit && this.placement) this.onPlacementEdit(kind, this.placementRect());
  }

  // move it to an exact rect (used by auto-align and by undo). `record:false`
  // for an undo itself — putting a position back isn't a new step.
  setPlacementRect(r, { record = true } = {}) {
    const p = this.placement;
    if (!p) return;
    if (record) this._beginEdit('set');
    p.x = r.x; p.y = r.y; p.w = r.w;
    this._placementChanged();
  }

  // grow/shrink around a screen point (the cursor, or the image's centre)
  scalePlacement(factor, anchorScreen = null) {
    const p = this.placement;
    if (!p || p.locked) return;
    this._beginEdit('resize');
    const h = p.w * (p.img.height / p.img.width);
    const a = anchorScreen
      ? this.screenToMap(anchorScreen.x, anchorScreen.y)
      : { x: p.x + p.w / 2, y: p.y + h / 2 };
    const k = Math.max(0.02 / (p.w || 1), factor);
    p.x = a.x + (p.x - a.x) * k;
    p.y = a.y + (p.y - a.y) * k;
    p.w = Math.max(30, p.w * k);
    this._placementChanged();
  }

  movePlacement(dx, dy) {
    const p = this.placement;
    if (!p || p.locked) return;
    p.x += dx; p.y += dy;
    this._placementChanged();
  }

  // Arrow-key nudge. Unlike a drag this SNAPS to whole map pixels first:
  // dragging leaves the placement on a fraction of a pixel, and stepping by
  // whole pixels from a fraction keeps that fraction forever — you can step
  // past the right spot again and again without ever landing on it. Rounding
  // first means the first press puts you on the grid the map itself is drawn
  // on, and from there every position is reachable exactly.
  nudgePlacement(dx, dy) {
    const p = this.placement;
    if (!p || p.locked) return;
    this._beginEdit('nudge');
    p.x = Math.round(p.x) + dx;
    p.y = Math.round(p.y) + dy;
    this._placementChanged();
  }

  // difference view on/off (see render) — returns the new state
  togglePlacementDiff(on) {
    const p = this.placement;
    if (!p) return false;
    p.diff = on === undefined ? !p.diff : !!on;
    this.requestRender();
    return p.diff;
  }

  // is this screen point on the thing being positioned? A lassoed piece
  // carries an alpha `mask` of its shape, so the empty corners of its
  // bounding box still pan the map instead of grabbing it.
  _overPlacement(px, py) {
    const p = this.placement;
    if (!p || p.locked) return false;
    const m = this.screenToMap(px, py);
    const h = p.w * (p.img.height / p.img.width);
    if (!(m.x >= p.x && m.x <= p.x + p.w && m.y >= p.y && m.y <= p.y + h)) return false;
    const mk = p.mask;
    if (!mk) return true;
    const mx = Math.min(mk.w - 1, Math.max(0, Math.floor((m.x - p.x) / p.w * mk.w)));
    const my = Math.min(mk.h - 1, Math.max(0, Math.floor((m.y - p.y) / h * mk.h)));
    return !!mk.data[my * mk.w + mx];
  }

  _placementChanged() {
    if (this.onPlacementChanged) this.onPlacementChanged(this.placementRect());
    this.requestRender();
  }

  // ---- paste ghost: float, fly into place, settle -----------------------

  // Show the pasted screenshot floating, screen-anchored (stays put while the
  // map pans behind it), gently pulsing to signal "working". `screenW` is its
  // width in screen px.
  showGhost(img, screenW) {
    this.ghost = {
      img, screenW, aspect: img.height / img.width,
      x: 0, y: 0, w: 0, phase: 'processing',
    };
    this._syncProcessing();
    this._loop();
  }

  // where a screen-anchored ghost sits right now, in map coords
  _syncProcessing() {
    const g = this.ghost;
    if (!g) return;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    g.w = g.screenW / this.scale;
    const h = g.w * g.aspect;
    const c = this.screenToMap(cw / 2, ch / 2);
    g.x = c.x - g.w / 2;
    g.y = c.y - h / 2;
  }

  // the ghost's current on-screen rect (so a view recenter can keep it put)
  ghostScreenRect() {
    const g = this.ghost;
    if (!g) return null;
    const s = this.mapToScreen(g.x, g.y);
    return { sx: s.x, sy: s.y, sw: g.w * this.scale };
  }
  // re-anchor the ghost so it occupies `r` (a prior ghostScreenRect) under
  // the current view — keeps it visually still across a centerOn
  setGhostFromScreenRect(r) {
    const g = this.ghost;
    if (!g || !r) return;
    const m = this.screenToMap(r.sx, r.sy);
    g.w = r.sw / this.scale;
    g.x = m.x; g.y = m.y;
  }

  // fly the ghost from where it floats to a final map rect
  flyGhostTo(rect, dur = 620) {
    const g = this.ghost;
    if (!g) return Promise.resolve();
    if (this.reduceMotion) {
      g.phase = 'landed'; g.x = rect.x; g.y = rect.y; g.w = rect.w;
      this.requestRender();
      return Promise.resolve();
    }
    return new Promise(res => {
      g.phase = 'flying';
      g.from = { x: g.x, y: g.y, w: g.w };
      g.to = { x: rect.x, y: rect.y, w: rect.w };
      g.t = 0; g.t0 = performance.now(); g.dur = dur; g.onDone = res;
      this._loop();
    });
  }

  // a bright flash + gold glow over the just-composited paste, then clear
  settleGhost(dur = 460) {
    const g = this.ghost;
    if (!g) return Promise.resolve();
    if (this.reduceMotion) { this.clearGhost(); return Promise.resolve(); }
    return new Promise(res => {
      g.phase = 'settle'; g.noImg = true; g.t = 0; g.t0 = performance.now();
      g.dur = dur; g.onDone = res;
      this._loop();
    });
  }

  // shake + fade: the paste couldn't be placed
  rejectGhost(dur = 520) {
    const g = this.ghost;
    if (!g) return Promise.resolve();
    if (this.reduceMotion) { this.clearGhost(); return Promise.resolve(); }
    return new Promise(res => {
      g.phase = 'reject'; g.t = 0; g.t0 = performance.now(); g.dur = dur; g.onDone = res;
      this._loop();
    });
  }

  clearGhost() {
    this.ghost = null;
    if (this._ghostRaf) { cancelAnimationFrame(this._ghostRaf); this._ghostRaf = 0; }
    this.requestRender();
  }

  _loop() {
    if (this._ghostRaf) return;
    const step = now => {
      this._ghostRaf = 0;
      const g = this.ghost;
      if (!g) return;
      if (g.phase === 'processing') {
        this._syncProcessing();
      } else if (g.phase === 'flying' || g.phase === 'settle' || g.phase === 'reject') {
        g.t = Math.min(1, (now - g.t0) / g.dur);
        if (g.phase === 'flying') {
          const e = easeInOut(g.t);
          g.x = g.from.x + (g.to.x - g.from.x) * e;
          g.y = g.from.y + (g.to.y - g.from.y) * e;
          g.w = g.from.w + (g.to.w - g.from.w) * e;
        }
        if (g.t >= 1) {
          const done = g.onDone; g.onDone = null;
          if (g.phase === 'flying') g.phase = 'landed';
          else { this.render(); this.clearGhost(); done && done(); return; }
          this.render();
          done && done();
          return; // landed: hold the frame, stop the loop until settle
        }
      }
      this.render();
      const cur = this.ghost;
      if (cur && cur.phase !== 'landed') this._ghostRaf = requestAnimationFrame(step);
    };
    this._ghostRaf = requestAnimationFrame(step);
  }

  _drawGhost(ctx) {
    const g = this.ghost;
    const h = g.w * g.aspect;
    const s = this.scale;
    const gold = (a, blur) => {
      ctx.strokeStyle = `rgba(224,195,126,${a})`;
      ctx.lineWidth = 2.4 / s;
      ctx.shadowColor = 'rgba(224,195,126,.85)';
      ctx.shadowBlur = blur / s;
    };
    ctx.save();
    if (g.phase === 'processing') {
      const now = performance.now();
      const pulse = 1 + 0.022 * Math.sin(now / 360);
      const glow = 0.5 + 0.5 * Math.sin(now / 360);
      const cx = g.x + g.w / 2, cy = g.y + h / 2;
      const w = g.w * pulse, hh = h * pulse;
      ctx.globalAlpha = 0.93;
      ctx.drawImage(g.img, cx - w / 2, cy - hh / 2, w, hh);
      ctx.globalAlpha = 1;
      gold(0.5 + 0.4 * glow, 12 + 8 * glow);
      ctx.strokeRect(cx - w / 2, cy - hh / 2, w, hh);
    } else if (g.phase === 'flying') {
      const e = g.t;
      ctx.globalAlpha = 0.9 + 0.1 * e;
      ctx.drawImage(g.img, g.x, g.y, g.w, h);
      ctx.globalAlpha = 1;
      gold(0.55 * (1 - e) + 0.15, 12 * (1 - e) + 3);
      ctx.strokeRect(g.x, g.y, g.w, h);
    } else if (g.phase === 'landed') {
      ctx.drawImage(g.img, g.x, g.y, g.w, h);
    } else if (g.phase === 'settle') {
      const a = 1 - g.t;
      ctx.globalAlpha = 0.32 * a;
      ctx.fillStyle = '#fff';
      ctx.fillRect(g.x, g.y, g.w, h);
      ctx.globalAlpha = 1;
      gold(0.7 * a, 22 * a);
      ctx.lineWidth = (2 + 6 * a) / s;
      ctx.strokeRect(g.x, g.y, g.w, h);
    } else if (g.phase === 'reject') {
      const a = 1 - g.t;
      const shake = Math.sin(g.t * Math.PI * 6) * a * 15 / s;
      ctx.globalAlpha = 0.9 * a;
      ctx.drawImage(g.img, g.x + shake, g.y, g.w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = `rgba(192,57,43,${0.8 * a})`;
      ctx.lineWidth = 2.5 / s;
      ctx.shadowColor = 'rgba(192,57,43,.75)';
      ctx.shadowBlur = 14 * a / s;
      ctx.strokeRect(g.x + shake, g.y, g.w, h);
    }
    ctx.restore();
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

    // the explored map: your pasted screenshots composited at their matched
    // positions, over the black fog.
    ctx.drawImage(this.explored.canvas, 0, 0, this.map.width, this.map.height);

    // "Reveal map": the full world map laid straight over the top, opaque.
    // Both maps live on the same canvas, so they share one opacity and
    // toggling the button flicks cleanly between your map and the real one —
    // the differences jump out of the flicker. Deliberately dumb: every
    // attempt to detect explored-vs-unexplored automatically (alpha masks,
    // pixel differencing, dilated ink masks) broke on real screenshots, which
    // match the reference in neither colour nor alignment.
    if (this.debugReveal && this.reference) {
      ctx.drawImage(this.reference, 0, 0, this.map.width, this.map.height);
    }

    // subtle bounds so you can tell where the world map area is
    ctx.strokeStyle = 'rgba(216, 220, 237, 0.08)';
    ctx.lineWidth = 2 / this.scale;
    ctx.strokeRect(0, 0, this.map.width, this.map.height);

    if (this.placement) {
      const p = this.placement;
      const h = p.w * (p.img.height / p.img.width);
      if (p.diff) {
        // Difference view: the screenshot is XOR-ed against the map under it,
        // so whatever already matches cancels to black. Nudge it until the
        // overlap goes dark and it's exactly right — far more precise than
        // eyeballing two overlaid pictures.
        ctx.globalCompositeOperation = 'difference';
        ctx.drawImage(p.img, p.x, p.y, p.w, h);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        // see-through enough to line up against what's underneath, solid
        // enough to still read as the screenshot you're holding
        ctx.globalAlpha = 0.7;
        ctx.drawImage(p.img, p.x, p.y, p.w, h);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = '#e0c37e';
      ctx.lineWidth = 2 / this.scale;
      ctx.strokeRect(p.x, p.y, p.w, h);
      // corner ticks — they read as "grab me" and make small misalignments
      // against the existing map easy to eyeball
      const t = Math.min(p.w, h) * 0.09;
      ctx.lineWidth = 3.5 / this.scale;
      ctx.beginPath();
      for (const [cx, cy, sx, sy] of [
        [p.x, p.y, 1, 1], [p.x + p.w, p.y, -1, 1],
        [p.x, p.y + h, 1, -1], [p.x + p.w, p.y + h, -1, -1],
      ]) {
        ctx.moveTo(cx + sx * t, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * t);
      }
      ctx.stroke();
    }

    if (this.lasso) this._drawLasso(ctx);

    if (this.ghost) this._drawGhost(ctx);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this._clampView();
    this.requestRender();
  }

  _attachInput() {
    const c = this.canvas;
    let dragging = false, movingPlacement = false, lastX = 0, lastY = 0;

    c.addEventListener('pointerdown', e => {
      // drawing a lasso takes over the drag entirely — no panning, no moving
      if (this.lasso) {
        this.lasso.drawing = true;
        this.lasso.pts = [this.screenToMap(e.clientX, e.clientY)];
        c.setPointerCapture(e.pointerId);
        this.requestRender();
        return;
      }
      dragging = true;
      // dragging ON the screenshot moves it; dragging anywhere else still
      // pans the map, so you can always look around mid-placement
      movingPlacement = this._overPlacement(e.clientX, e.clientY);
      if (movingPlacement) this._beginEdit('drag'); // the whole drag is one step
      lastX = e.clientX; lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
      c.classList.add('panning');
    });

    c.addEventListener('pointermove', e => {
      if (this.lasso) {
        if (!this.lasso.drawing) return;
        const m = this.screenToMap(e.clientX, e.clientY);
        const last = this.lasso.pts[this.lasso.pts.length - 1];
        // thin the trail out — a point every few screen pixels is plenty
        if (Math.hypot(m.x - last.x, m.y - last.y) * this.scale >= 3) {
          this.lasso.pts.push(m);
          this.requestRender();
        }
        return;
      }
      if (!dragging) {
        // cursor tells you which of the two drags you'd get
        if (this.placement) c.classList.toggle('over-placement', this._overPlacement(e.clientX, e.clientY));
        return;
      }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (movingPlacement) {
        this.movePlacement(dx / this.scale, dy / this.scale);
        return;
      }
      this.ox += dx;
      this.oy += dy;
      this._clampView();
      this.requestRender();
    });

    const endDrag = e => {
      if (this.lasso && this.lasso.drawing) { this._finishLasso(); return; }
      dragging = false;
      movingPlacement = false;
      c.classList.remove('panning');
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0012);
      if (this.placement && !this.placement.locked && (e.shiftKey || e.altKey)) {
        // Shift+scroll resizes the screenshot around the cursor; a plain
        // scroll keeps zooming the map, so the view never gets stuck
        this.scalePlacement(factor, { x: e.clientX, y: e.clientY });
      } else {
        const ns = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
        const k = ns / this.scale;
        this.ox = e.clientX - (e.clientX - this.ox) * k;
        this.oy = e.clientY - (e.clientY - this.oy) * k;
        this.scale = ns;
        this._clampView();
      }
      this.requestRender();
    }, { passive: false });
  }
}
