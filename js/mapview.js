// Pan/zoom canvas viewer. Draws: black fog -> explored screenshots ->
// (optional) placement overlay for a screenshot being positioned. `mapImage`
// is used only for its dimensions (the reference map is never displayed).

import { contrastMask } from './explored.js';

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// "Reveal map" mask tuning. The mask is built on a 1/MASK_DIV copy of your map
// (small enough to process quickly, big enough to keep room outlines).
// DILATE_* widen it well past your actual pixels — that slack is what keeps
// slightly misaligned pastes from glowing along their borders.
const MASK_DIV = 4;
const DILATE_PX = 14;
const DILATE_PASSES = 3;

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

    // ghost: a pasted screenshot shown floating while it's being located,
    // then flown into place (see showGhost / flyGhostTo / settleGhost)
    this.ghost = null;
    this._ghostRaf = 0;
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // "Reveal map": fill the unexplored gaps with the reference map
    this.debugReveal = false;
    this._revealCache = null;   // reference with explored punched out
    this._revealDirty = true;

    // how strongly YOUR explored map is drawn (the opacity slider). The reveal
    // overlay ignores this, so it stays fully readable over a dimmed map.
    this.mapOpacity = 1;

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

  setPlacement(p) {
    this.placement = p;
    this.canvas.classList.toggle('placing', !!p);
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

  // the explored composite changed, so the punched-out reference is stale
  invalidateReveal() { this._revealDirty = true; }

  // The reference map with everywhere you've already mapped erased from it.
  //
  // Two things this must survive, both learned the hard way:
  //   * Alpha is not "visited". A paste covers its whole rectangle and the
  //     background fade leaves big dark regions opaque, so masking by alpha
  //     erased ground you'd never explored.
  //   * Pixel-differencing is not "visited" either. Your screenshots don't
  //     match the reference in colour OR position, so every slightly
  //     misaligned room border rang like an unexplored area.
  //
  // So ask a blunter, binary question — did your map draw any INK near here?
  // Crucially the answer must be RELATIVE, not an absolute brightness: the
  // in-game background is a brown vignette, not black, so any fixed threshold
  // low enough to be useful also swallows every area a screenshot merely
  // covered — which is what made pastes blank the whole reveal. contrastMask
  // (the same test the alignment matcher uses) compares each pixel with its
  // LOCAL background instead, so flat vignette reads as empty however bright
  // it is, while outlines and text read as ink however dim.
  //
  // The mask is then dilated generously, and that slack absorbs misalignment:
  // being a few pixels out no longer uncovers a rim of reference along every
  // border you have actually explored.
  //
  // Built from the explored map at FULL strength, so the opacity slider can't
  // affect it. Cached — only pastes / clears / cleans dirty it.
  _revealLayer() {
    if (this._revealCache && !this._revealDirty) return this._revealCache;
    const W = this.map.width, H = this.map.height;

    const mw = Math.max(1, Math.ceil(W / MASK_DIV)), mh = Math.max(1, Math.ceil(H / MASK_DIV));
    const sc = document.createElement('canvas');
    sc.width = mw; sc.height = mh;
    const sx = sc.getContext('2d', { willReadFrequently: true });
    sx.imageSmoothingEnabled = true;
    sx.drawImage(this.explored.canvas, 0, 0, mw, mh);

    const { m } = contrastMask(sc);            // 1 where YOUR map drew ink
    const md = sx.createImageData(mw, mh);     // ink -> an alpha-only stencil
    for (let p = 0; p < m.length; p++) if (m[p]) md.data[p * 4 + 3] = 255;
    sx.putImageData(md, 0, 0);

    // 2. reference, then erase the inked areas — blurred and stamped a few
    //    times so the soft edge firms up into a real, wide dilation
    const c = this._revealCache || document.createElement('canvas');
    c.width = W; c.height = H;                              // also clears it
    const x = c.getContext('2d');
    x.drawImage(this.map, 0, 0, W, H);
    x.globalCompositeOperation = 'destination-out';
    x.filter = `blur(${DILATE_PX}px)`;
    for (let i = 0; i < DILATE_PASSES; i++) x.drawImage(sc, 0, 0, W, H);
    x.filter = 'none';
    x.globalCompositeOperation = 'source-over';

    this._revealCache = c;
    this._revealDirty = false;
    return c;
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
    // positions, over the black fog. The reference map is never drawn (it is
    // only used to work out where a screenshot goes) — no spoilers.
    ctx.globalAlpha = this.mapOpacity;
    ctx.drawImage(this.explored.canvas, 0, 0, this.map.width, this.map.height);
    ctx.globalAlpha = 1;

    // "Reveal map": the reference with everywhere you've mapped erased out of
    // it, painted straight over the top. Where you HAVE explored the layer is
    // transparent, so your own screenshots show through untouched; everywhere
    // else it paints the real map over whatever the screenshot happened to
    // cover that ground with. Blending ('lighten') was no good here — a
    // screenshot's background vignette is often brighter than the reference's
    // room outlines, so it simply won out and the reveal vanished. Replacing
    // is right anyway: that vignette covers ground you never explored.
    // Unaffected by the opacity slider, so turning your own map down leaves
    // the unvisited places at full strength.
    if (this.debugReveal) {
      ctx.drawImage(this._revealLayer(), 0, 0, this.map.width, this.map.height);
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
        this._clampView();
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
        this._clampView();
      }
      this.requestRender();
    }, { passive: false });
  }
}
