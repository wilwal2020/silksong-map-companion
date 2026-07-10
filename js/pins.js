// Pin management: DOM markers over the map canvas, hover cards with the
// attached environment screenshot, dragging (with a confirm step), filtering.

import { categories, catById } from './categories.js';

// re-export so existing importers keep working
export { catById };

// inline action-row icons (crisp at any size, currentColor-tinted)
export const SVG = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.4l3.2 3.2L13 4.6"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4L3 6.6l3 2.6"/><path d="M3 6.6h6.2a3.4 3.4 0 0 1 0 6.8H6"/></svg>',
  cam: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.2h2.2l1-1.4h3.6l1 1.4H14v7.2H2z"/><circle cx="8" cy="8.6" r="2.4"/></svg>',
  pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.4 2.6l2 2L6 12l-2.6.6L4 10z"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"/></svg>',
  camBig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h3l1.4-2h7.2L16 8h5v11H3z"/><circle cx="12" cy="13" r="3.4"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/></svg>',
  mcCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg>',
  mcCross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  xmark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

// convex hull (Andrew's monotone chain) of a set of points
function convexHull(pts) {
  pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// is point p inside the convex polygon? (all edge cross-products same sign)
function pointInConvex(p, poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export class PinManager {
  constructor(layer, view, handlers) {
    this.layer = layer;
    this.view = view;
    // { onChange, onEdit, onDelete, onRequestAttach, onLightbox, onPinsChanged }
    this.handlers = handlers;
    this.pins = new Map();     // id -> { data, el, ico, card, imgUrl, moveEl, pendingMove }
    this.filter = new Set(categories().map(c => c.id));
    this.showDone = true;
    this.selectedId = null;
    this.awaitingId = null;    // pin waiting for its area screenshot
    this.hoveredId = null;     // pin currently under the pointer (paste target)
    this.suppressHover = false; // don't open cards (e.g. while placing a pin)
    this.lastPlacedId = null;  // just-placed pin, excluded from paste-attach
    this._stickyCard = null;
    this._hoverCardEntry = null; // pin whose card is open from a plain hover

    document.addEventListener('pointerdown', e => {
      this.lastPlacedId = null; // any click means the user has moved on
      const onPin = e.target.closest('.pin');
      const onMoveUI = e.target.closest('.move-confirm, .move-handle');
      // interacting anywhere off the pin / move UI (a button, the map, a
      // paste elsewhere) abandons an unconfirmed move and drops the selection
      if (!onPin && !onMoveUI) {
        this.cancelPendingMove();
        if (this.selectedId) this.deselect();
      }
      if (this._stickyCard && !this._stickyCard.contains(e.target) && !onPin) {
        this._hideCard(this._stickyCardPin, true);
      }
    });
    this._lastMove = null; // { id, from } — last confirmed move, for Ctrl+Z

    // a hover card stays open while the pointer is over the pin, over the
    // card, or inside the triangle bridging the two — so a diagonal move
    // toward a card button never drops it
    document.addEventListener('pointermove', e => this._trackHover(e.clientX, e.clientY));
  }

  _trackHover(x, y) {
    this._lastX = x; this._lastY = y;
    const entry = this._hoverCardEntry;
    if (!entry || !entry.card || this._stickyCard === entry.card) return;
    if (this._inSafeZone(entry, x, y)) return;
    this._hideCard(entry);
    if (this.hoveredId === entry.data.id) this.hoveredId = null;
  }

  _inSafeZone(entry, x, y) {
    // safe = anywhere inside the convex hull that wraps BOTH the pin and its
    // card (plus a little padding). This keeps the whole corridor between them
    // wide — including right next to the pin — so a diagonal move toward a
    // card button never slips out, while moving away from the card exits it.
    const pad = 16;
    const rects = [entry.el.getBoundingClientRect(), entry.card.getBoundingClientRect()];
    const corners = [];
    for (const r of rects) {
      corners.push(
        { x: r.left - pad, y: r.top - pad }, { x: r.right + pad, y: r.top - pad },
        { x: r.right + pad, y: r.bottom + pad }, { x: r.left - pad, y: r.bottom + pad });
    }
    return pointInConvex({ x, y }, convexHull(corners));
  }

  add(data, { select = false, pop = false } = {}) {
    const el = document.createElement('div');
    el.className = 'pin';
    const ico = document.createElement('span');
    ico.className = 'pin-ico';
    el.appendChild(ico);
    const entry = { data, el, ico, card: null, imgUrl: null, moveEl: null, moveHandle: null, pendingMove: null };
    this.pins.set(data.id, entry);
    this.layer.appendChild(el);
    this._decorate(entry);
    this._wire(entry);
    if (select) this.select(data.id);
    if (pop) {
      ico.classList.add('pin-pop');
      ico.addEventListener('animationend', () => ico.classList.remove('pin-pop'), { once: true });
    }
    this.syncPositions();
    this.handlers.onPinsChanged?.();
    return entry;
  }

  update(data) {
    const entry = this.pins.get(data.id);
    if (!entry) return;
    entry.data = data;
    if (entry.imgUrl) { URL.revokeObjectURL(entry.imgUrl); entry.imgUrl = null; }
    if (entry.card) { entry.card.remove(); entry.card = null; }
    this._decorate(entry);
    this.applyFilter();
    this.handlers.onPinsChanged?.();
  }

  remove(id) {
    const entry = this.pins.get(id);
    if (!entry) return;
    if (entry.imgUrl) URL.revokeObjectURL(entry.imgUrl);
    if (entry.card) entry.card.remove();
    if (entry.moveEl) entry.moveEl.remove();
    if (entry.moveHandle) entry.moveHandle.remove();
    entry.el.remove();
    this.pins.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    if (this.awaitingId === id) this.awaitingId = null;
    if (this._lastMove && this._lastMove.id === id) this._lastMove = null;
    this.handlers.onPinsChanged?.();
  }

  removeAll() {
    for (const id of [...this.pins.keys()]) this.remove(id);
  }

  select(id) {
    if (this.selectedId !== id) this.cancelPendingMove();
    this.selectedId = id;
    for (const [pid, e] of this.pins) e.el.classList.toggle('selected', pid === id);
    this._syncMoveHandles();
  }

  deselect() {
    this.selectedId = null;
    for (const e of this.pins.values()) e.el.classList.remove('selected');
    this._syncMoveHandles();
  }

  // ring flash on a pin (e.g. a screenshot just landed in it)
  flashPin(id) {
    this._playIco(id, 'pin-flash');
  }

  // celebratory burst when a pin is checked off — an expanding green ring
  // laid over the pin-layer (independent of the pin's dimmed done styling,
  // and visible even if "show done" hides the pin itself)
  flashDone(id) {
    const e = this.pins.get(id);
    if (!e) return;
    this._playIco(id, 'pin-doneburst');
    this._doneRing(e);
  }

  _doneRing(entry) {
    const p = this.view.mapToScreen(entry.data.x, entry.data.y);
    const ring = document.createElement('div');
    ring.className = 'done-burst';
    ring.style.left = p.x + 'px';
    ring.style.top = p.y + 'px';
    this.layer.appendChild(ring);
    ring.addEventListener('animationend', () => ring.remove(), { once: true });
  }

  // fade+shrink the marker out, then run cb (which finally hides it)
  _animateOut(entry, cb) {
    if (this.view.reduceMotion) { cb(); return; }
    const el = entry.el;
    let fired = false;
    const finish = () => {
      if (fired) return;
      fired = true;
      el.removeEventListener('animationend', finish);
      el.classList.remove('leaving');
      cb();
    };
    el.classList.add('leaving');
    el.addEventListener('animationend', finish);
    setTimeout(finish, 450);
  }

  _playIco(id, cls) {
    const e = this.pins.get(id);
    if (!e) return;
    e.ico.classList.remove(cls);
    void e.ico.offsetWidth; // restart the animation if it's already running
    e.ico.classList.add(cls);
    e.ico.addEventListener('animationend', () => e.ico.classList.remove(cls), { once: true });
  }

  setAwaiting(id) {
    this.awaitingId = id;
    for (const [pid, e] of this.pins) e.el.classList.toggle('awaiting', pid === id);
  }

  // pin that an "area screenshot" paste should attach to
  attachTarget() {
    return this.awaitingId || this.selectedId;
  }

  // pin currently under the pointer — a plain paste while hovering a pin
  // attaches the image straight to it. Only a live hover counts (not a pin
  // whose card is merely open from an earlier click), so pasting a fresh map
  // screenshot isn't hijacked by the last pin you looked at.
  pasteTarget() {
    if (this.hoveredId && this.hoveredId !== this.lastPlacedId && this.pins.has(this.hoveredId)) {
      return this.hoveredId;
    }
    return null;
  }

  applyFilter() {
    for (const e of this.pins.values()) {
      const visible = this.filter.has(e.data.cat) && (this.showDone || !e.data.done);
      e.el.style.display = visible ? '' : 'none';
      if (e.moveEl) e.moveEl.style.display = visible ? '' : 'none';
      if (e.moveHandle) e.moveHandle.style.display = visible ? '' : 'none';
      if (!visible && e.card) this._hideCard(e, true);
    }
  }

  syncPositions() {
    for (const e of this.pins.values()) {
      const p = this.view.mapToScreen(e.data.x, e.data.y);
      e.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (e.card) this._positionCard(e);
      if (e.moveEl) this._positionMoveConfirm(e);
      if (e.moveHandle) this._positionMoveHandle(e);
    }
  }

  _decorate(entry) {
    const cat = catById(entry.data.cat);
    entry.ico.textContent = cat.icon;
    entry.el.style.setProperty('--pc', cat.color || '#9e2b25');
    // no native title tooltip — the hover card carries the info
    entry.el.classList.toggle('done', !!entry.data.done);
  }

  _wire(entry) {
    const el = entry.el;
    let downX = 0, downY = 0, moved = false, down = false;

    // the pin itself is no longer draggable — a plain click selects it, which
    // reveals the move handle; dragging the pin does nothing
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      down = true; moved = false;
      downX = e.clientX; downY = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', e => {
      if (!down) {
        if (!this.suppressHover && !entry.card) this._showCard(entry, false);
        return;
      }
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) >= 5) moved = true;
    });
    el.addEventListener('pointerup', e => {
      if (!down) return;
      down = false;
      try { el.releasePointerCapture(e.pointerId); } catch {}
      if (moved || this.suppressHover) return; // a drag on the pin is ignored
      this.select(entry.data.id);
      this._showCard(entry, true);
    });

    el.addEventListener('pointerenter', () => {
      if (this.suppressHover) return;
      this.hoveredId = entry.data.id;
      if (entry.data.id !== this.lastPlacedId) this.lastPlacedId = null; // moved to another pin
      if (!entry.pendingMove) this._showCard(entry, false);
    });
    el.addEventListener('pointerleave', () => {
      // the card's lifetime is governed by the safe-zone tracker; here we only
      // stop treating this pin as the paste target once we're clear of its zone
      if (this.hoveredId === entry.data.id
          && !(entry.card && this._inSafeZone(entry, this._lastX ?? -1, this._lastY ?? -1))) {
        this.hoveredId = null;
      }
    });
  }

  // ---- move handle: appears on the selected pin, drag it to reposition -----

  _syncMoveHandles() {
    for (const [pid, e] of this.pins) {
      const show = pid === this.selectedId && !e.pendingMove && e.el.style.display !== 'none';
      if (show) this._showMoveHandle(e); else this._hideMoveHandle(e);
    }
  }

  _showMoveHandle(entry) {
    if (!entry.moveHandle) {
      const h = document.createElement('div');
      h.className = 'move-handle';
      h.title = 'Drag to move this pin';
      h.innerHTML = SVG.move;
      this._wireMoveHandle(entry, h);
      this.layer.appendChild(h);
      entry.moveHandle = h;
    }
    this._positionMoveHandle(entry);
  }

  _hideMoveHandle(entry) {
    if (entry.moveHandle) { entry.moveHandle.remove(); entry.moveHandle = null; }
  }

  _positionMoveHandle(entry) {
    if (!entry.moveHandle) return;
    const p = this.view.mapToScreen(entry.data.x, entry.data.y);
    entry.moveHandle.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  _wireMoveHandle(entry, h) {
    let sx = 0, sy = 0, startX = 0, startY = 0, active = false, moved = false;
    let offX = 0, offY = 0, glideStart = 0, last = null;
    const GLIDE = 190;                          // ms for the pin to rise under the cursor
    const ease = t => 1 - Math.pow(1 - t, 3);   // easeOutCubic

    // put the pin under the cursor, closing the grab-time gap as the glide runs
    const apply = e => {
      const t = glideStart ? ease(Math.min(1, (performance.now() - glideStart) / GLIDE)) : 1;
      entry.data.x = sx + ((e.clientX - startX) - offX * t) / this.view.scale;
      entry.data.y = sy + ((e.clientY - startY) - offY * t) / this.view.scale;
      this.syncPositions();
    };
    const tick = () => {
      if (!active || !glideStart) return;
      if (last) apply(last);
      if (performance.now() - glideStart < GLIDE) requestAnimationFrame(tick);
      else glideStart = 0;
    };

    h.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      active = true; moved = false; last = e;
      startX = e.clientX; startY = e.clientY;
      sx = entry.data.x; sy = entry.data.y;   // where the move started (for ✗ / undo)
      // the handle floats above the pin — glide the pin up so it ends directly
      // under the cursor, so letting go leaves it right where you can grab again
      const p = this.view.mapToScreen(sx, sy);
      offX = p.x - startX; offY = p.y - startY;
      try { h.setPointerCapture(e.pointerId); } catch {}
      h.classList.add('dragging');
      this._hideCard(entry, true);
      if (Math.hypot(offX, offY) > 1) { glideStart = performance.now(); requestAnimationFrame(tick); }
      else glideStart = 0;
    });
    h.addEventListener('pointermove', e => {
      if (!active) return;
      last = e;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) >= 4) moved = true;
      apply(e);
    });
    h.addEventListener('pointerup', e => {
      if (!active) return;
      active = false; glideStart = 0; last = null;
      try { h.releasePointerCapture(e.pointerId); } catch {}
      h.classList.remove('dragging');
      if (moved) {
        this._beginMoveConfirm(entry, { x: sx, y: sy });
      } else {
        // only the pick-up glide happened, no drag — ease the pin back home
        entry.data.x = sx; entry.data.y = sy;
        this._glidePinBack(entry);
      }
    });
  }

  // ease a pin (and its move handle) to its current data position with a
  // one-shot CSS transition — used when a handle grab is released without a drag
  _glidePinBack(entry) {
    const els = [entry.el, entry.moveHandle].filter(Boolean);
    for (const el of els) el.style.transition = 'transform .18s cubic-bezier(.2,.8,.25,1)';
    this.syncPositions();
    const clear = () => { for (const el of els) el.style.transition = ''; };
    entry.el.addEventListener('transitionend', clear, { once: true });
    setTimeout(clear, 260);
  }

  // ---- move confirmation (✓ keep / ✗ put back) ----------------------------

  _beginMoveConfirm(entry, origin) {
    entry.pendingMove = origin;
    this._hideMoveHandle(entry);
    if (!entry.moveEl) {
      const wrap = document.createElement('div');
      wrap.className = 'move-confirm';
      const ok = document.createElement('button');
      ok.className = 'mc-btn mc-ok'; ok.innerHTML = SVG.mcCheck;
      ok.title = 'Keep the new position';
      const no = document.createElement('button');
      no.className = 'mc-btn mc-no'; no.innerHTML = SVG.mcCross;
      no.title = 'Put it back';
      for (const b of [ok, no]) b.addEventListener('pointerdown', e => e.stopPropagation());
      ok.addEventListener('click', e => { e.stopPropagation(); this._commitMove(entry); });
      no.addEventListener('click', e => { e.stopPropagation(); this._cancelMove(entry); });
      wrap.append(ok, no);
      this.layer.appendChild(wrap);
      entry.moveEl = wrap;
    }
    this._positionMoveConfirm(entry);
  }

  _commitMove(entry) {
    const from = entry.pendingMove;
    entry.pendingMove = null;
    if (entry.moveEl) { entry.moveEl.remove(); entry.moveEl = null; }
    if (from) this._lastMove = { id: entry.data.id, from };
    this.handlers.onChange(entry.data);
    this._syncMoveHandles();
  }

  _cancelMove(entry) {
    const o = entry.pendingMove;
    entry.pendingMove = null;
    if (o) { entry.data.x = o.x; entry.data.y = o.y; }
    if (entry.moveEl) { entry.moveEl.remove(); entry.moveEl = null; }
    this.syncPositions();
    this._syncMoveHandles();
  }

  // abandon any unconfirmed move (revert the pin). Called when the user
  // interacts elsewhere — a button, a paste, a click off the pin.
  cancelPendingMove() {
    for (const e of this.pins.values()) if (e.pendingMove) this._cancelMove(e);
  }

  // Ctrl+Z for pin placement: an unconfirmed move reverts; otherwise the last
  // confirmed move is put back. Returns true if it handled the undo.
  undoLastMove() {
    for (const e of this.pins.values()) {
      if (e.pendingMove) { this._cancelMove(e); return true; }
    }
    if (this._lastMove) {
      const e = this.pins.get(this._lastMove.id);
      if (e) {
        e.data.x = this._lastMove.from.x; e.data.y = this._lastMove.from.y;
        this.syncPositions();
        this.handlers.onChange(e.data);
      }
      this._lastMove = null;
      return true;
    }
    return false;
  }

  _positionMoveConfirm(entry) {
    if (!entry.moveEl) return;
    const p = this.view.mapToScreen(entry.data.x, entry.data.y);
    entry.moveEl.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  // ---- hover / detail card ------------------------------------------------

  _showCard(entry, sticky) {
    // only ever one card visible — drop any other pin's card first (a stray
    // hover card from a nearby pin would otherwise get orphaned/stuck)
    if (this._hoverCardEntry && this._hoverCardEntry !== entry) {
      this._hideCard(this._hoverCardEntry);
    }
    if (this._stickyCard && this._stickyCard !== entry.card) {
      this._hideCard(this._stickyCardPin, true);
    }
    if (!entry.card) entry.card = this._buildCard(entry);
    if (sticky) { this._stickyCard = entry.card; this._stickyCardPin = entry; this._hoverCardEntry = null; }
    else this._hoverCardEntry = entry; // a plain hover — safe-zone tracker owns it
    this._positionCard(entry);
  }

  _hideCard(entry, force = false) {
    if (!entry || !entry.card) return;
    if (this._stickyCard === entry.card && !force) return;
    if (this._stickyCard === entry.card) { this._stickyCard = null; this._stickyCardPin = null; }
    if (this._hoverCardEntry === entry) this._hoverCardEntry = null;
    entry.card.remove();
    entry.card = null;
  }

  _positionCard(entry) {
    const p = this.view.mapToScreen(entry.data.x, entry.data.y);
    const card = entry.card;
    if (!card) return;
    const w = card.offsetWidth || 320, margin = 12;
    let x = p.x + 18, y = p.y - 20;
    if (x + w + margin > window.innerWidth) x = p.x - w - 24;
    x = Math.max(margin, x);
    y = Math.max(60, Math.min(y, window.innerHeight - card.offsetHeight - margin));
    // position via left/top so `transform` stays free for the entrance pop,
    // and grow the card from the side nearest the pin
    card.style.left = x + 'px';
    card.style.top = y + 'px';
    card.style.transformOrigin = (x < p.x ? 'right' : 'left') + ' top';
  }

  _buildCard(entry) {
    const d = entry.data;
    const cat = catById(d.cat);
    const card = document.createElement('div');
    card.className = 'pin-card';
    card.style.setProperty('--pc', cat.color || '#9e2b25');

    const thread = document.createElement('div');
    thread.className = 'pc-thread';
    card.appendChild(thread);

    // the screenshot area (or, when empty, a dashed well with the paste hint)
    const imgWrap = document.createElement('div');
    imgWrap.className = 'pc-img';
    if (d.img) {
      imgWrap.classList.add('has-env');
      if (!entry.imgUrl) entry.imgUrl = URL.createObjectURL(d.img);
      const img = document.createElement('img');
      img.className = 'env';
      img.src = entry.imgUrl;
      img.alt = '';
      img.addEventListener('load', () => this._positionCard(entry));
      img.addEventListener('click', () => this.handlers.onLightbox(entry.imgUrl));
      imgWrap.appendChild(img);
      // ✕ to remove the picture — hovering dims the image; it takes two clicks
      // to confirm, and moving off the image resets the confirmation
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pc-del-img';
      del.title = 'Remove this picture';
      del.setAttribute('aria-label', 'Remove this picture');
      del.innerHTML = SVG.xmark;
      let armed = false;
      del.addEventListener('pointerenter', () => imgWrap.classList.add('del-hover'));
      del.addEventListener('pointerleave', () => imgWrap.classList.remove('del-hover'));
      del.addEventListener('click', e => {
        e.stopPropagation();
        if (!armed) { armed = true; imgWrap.classList.add('del-armed'); return; }
        if (entry.imgUrl) { URL.revokeObjectURL(entry.imgUrl); entry.imgUrl = null; }
        d.img = null;
        this.handlers.onChange(d);
        this._refreshCard(entry);
      });
      imgWrap.addEventListener('pointerleave', () => { armed = false; imgWrap.classList.remove('del-armed'); });
      imgWrap.appendChild(del);
    } else {
      // the whole image square is the paste target; routePaste reads
      // .pin-card .no-env:hover + dataset.pinId at paste time
      imgWrap.classList.add('no-env');
      imgWrap.dataset.pinId = d.id;
      const well = document.createElement('div');
      well.className = 'pc-well';
      if (d.note) {
        const wn = document.createElement('div');
        wn.className = 'pc-well-note';
        wn.textContent = d.note;
        well.appendChild(wn);
      }
      const wc = document.createElement('span');
      wc.className = 'wc';
      wc.innerHTML = SVG.camBig;
      const wt = document.createElement('span');
      wt.className = 'wt';
      wt.innerHTML = `<b>${d.note ? 'Add a picture' : 'No picture yet'}</b><br>`
        + 'Hover here and press <span class="pc-kbd">Ctrl</span> <span class="pc-kbd">V</span>';
      well.append(wc, wt);
      imgWrap.appendChild(well);
    }

    // the frosted deck: category always; the note too when there's a screenshot
    const deck = document.createElement('div');
    deck.className = 'pc-deck';
    const head = document.createElement('div');
    head.className = 'pc-head';
    const ico = document.createElement('span');
    ico.className = 'pc-ico';
    ico.textContent = cat.icon;
    const catName = document.createElement('span');
    catName.className = 'pc-cat';
    catName.textContent = cat.label;
    head.append(ico, catName);
    deck.appendChild(head);
    if (d.img && d.note) {
      const note = document.createElement('div');
      note.className = 'pc-note';
      note.textContent = d.note;
      deck.appendChild(note);
    }
    card.appendChild(imgWrap);
    // the deck rides below the screenshot so the whole image stays visible
    card.appendChild(deck);

    // footer bar: wide primary Done + quiet Replace / Edit / Delete
    const acts = document.createElement('div');
    acts.className = 'pc-acts';
    const done = document.createElement('button');
    done.className = 'pc-done' + (d.done ? ' is-done' : '');
    done.innerHTML = (d.done ? SVG.undo : SVG.check)
      + `<span>${d.done ? 'Undo' : 'Done'}</span>`;
    done.addEventListener('click', () => {
      d.done = !d.done;
      const justDone = d.done;
      this.handlers.onChange(d);
      if (justDone && !this.showDone) {
        // about to be filtered out — ring, close the card, then fade the
        // marker out before applyFilter removes it (no instant pop)
        this._doneRing(entry);
        this._hideCard(entry, true);
        this._animateOut(entry, () => this.update(d));
      } else {
        this.update(d);
        if (justDone) this.flashDone(d.id);
      }
    });
    acts.appendChild(done);
    const sec = (icon, label, title, fn, del) => {
      const b = document.createElement('button');
      b.className = 'pc-sec' + (del ? ' del' : '');
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = icon + `<span>${label}</span>`;
      b.addEventListener('click', fn);
      acts.appendChild(b);
    };
    sec(SVG.pen, 'Edit', 'Edit category & note', () => this.handlers.onEdit(d));
    sec(SVG.trash, 'Delete', 'Delete pin', () => this.handlers.onDelete(d), true);
    card.appendChild(acts);

    // hide is driven by the safe-zone tracker (_trackHover), not a plain
    // pointerleave, so a diagonal move to a button doesn't drop the card

    this.layer.appendChild(card);
    return card;
  }

  // rebuild an already-open card in place (e.g. after its picture changed)
  // without the entrance pop, preserving whether it's sticky or a hover card
  _refreshCard(entry, { animateImg = false } = {}) {
    if (!entry.card) return;
    const wasSticky = this._stickyCard === entry.card;
    const wasHover = this._hoverCardEntry === entry;
    entry.card.remove();
    entry.card = null;
    const card = this._buildCard(entry);   // appends to the layer
    card.classList.add('no-pop');
    if (animateImg) card.querySelector('img.env')?.classList.add('env-insert');
    entry.card = card;
    if (wasSticky) { this._stickyCard = card; this._stickyCardPin = entry; }
    if (wasHover) this._hoverCardEntry = entry;
    this._positionCard(entry);
  }

  // a paste onto an empty pin: keep the card open and slide the picture in,
  // rather than closing the card and flying the image into the marker
  async insertImage(entry) {
    this._decorate(entry);
    if (entry.card) {
      // decode the picture up front so the card grows to its final height in a
      // single step — otherwise the image pops in a frame late and the reveal
      // animation runs against a reflowing card, which reads as choppy
      if (entry.data.img && !entry.imgUrl) entry.imgUrl = URL.createObjectURL(entry.data.img);
      if (entry.imgUrl) { try { const im = new Image(); im.src = entry.imgUrl; await im.decode(); } catch {} }
      if (entry.card) this._refreshCard(entry, { animateImg: true });
    } else {
      this.update(entry.data);
    }
    this.applyFilter();
    this.handlers.onPinsChanged?.();
  }
}
