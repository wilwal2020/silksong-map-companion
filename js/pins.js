// Pin management: DOM markers over the map canvas, hover cards with the
// attached environment screenshot, dragging (with a confirm step), filtering.

import { categories, catById } from './categories.js';

// re-export so existing importers keep working
export { catById };

// Where a hover card is allowed to sit: clear of the app toolbar at the top,
// and a hair off every other edge.
const CARD_TOP = 60, CARD_MARGIN = 12;

// How tall the picture inside a card may be before the card would hang off the
// bottom of the window. The deck and buttons below it don't scale with the
// picture, so they come off the budget first. Both the zoom ceiling and the
// card's own layout go through this, so a picture can never be the reason the
// card doesn't fit — it gives up height instead.
function imgRoom(card, img) {
  const chrome = Math.max(0, card.offsetHeight - img.offsetHeight);
  return Math.max(120, window.innerHeight - CARD_TOP - CARD_MARGIN - chrome);
}

// inline action-row icons (crisp at any size, currentColor-tinted)
export const SVG = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.4l3.2 3.2L13 4.6"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4L3 6.6l3 2.6"/><path d="M3 6.6h6.2a3.4 3.4 0 0 1 0 6.8H6"/></svg>',
  cam: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.2h2.2l1-1.4h3.6l1 1.4H14v7.2H2z"/><circle cx="8" cy="8.6" r="2.4"/></svg>',
  pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.4 2.6l2 2L6 12l-2.6.6L4 10z"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"/></svg>',
  camBig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h3l1.4-2h7.2L16 8h5v11H3z"/><circle cx="12" cy="13" r="3.4"/></svg>',
  mcCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg>',
  mcCross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  xmark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

// Where a persistent pin may be anchored. It is kept as a FRACTION of the
// window (so resizing keeps it in the same corner rather than pushing it off
// the edge), but the anchor is clamped in pixels first: a pin dragged past an
// edge — or under the toolbar — could never be reached again, since there is
// no panning that would bring it back.
const PIN_EDGE = 24;
const clampAnchor = (px, py) => ({
  x: Math.max(PIN_EDGE, Math.min(window.innerWidth - PIN_EDGE, px)),
  y: Math.max(CARD_TOP, Math.min(window.innerHeight - PIN_EDGE, py)),
});
export function fixedAnchor(px, py) {
  const p = clampAnchor(px, py);
  return { fx: p.x / window.innerWidth, fy: p.y / window.innerHeight };
}

// ---------------------------------------------------------------- edge grid

// Persistent pins live in a ring of cells around the rim of the screen, so a
// row of them lines up instead of scattering. The ring is laid inside what is
// left of the window once the two fixed panels are taken off it...
const GRID_FRAME = ['#toolbar', '#cat-bar'];
// ...and then every cell that would sit under a floating control is dropped,
// so a pin can never land on top of a button. Keep this in step with the
// chrome in index.html: a widget missing from here is a widget pins cover.
const GRID_AVOID = ['#map-opacity', '#bg-tool', '#shot-slot', '#held-shot', '#paste-hint',
  '#empty-hint', '#place-bar', '#place-tools', '#spinner', '#toasts'];
const CELL = 46;       // one snap cell — a shade roomier than the 38px marker
const GRID_GAP = 7;    // breathing room from the rim and from the chrome

const onScreen = el => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
const overlaps = (a, b, pad) =>
  a.x < b.right + pad && a.x + CELL > b.left - pad &&
  a.y < b.bottom + pad && a.y + CELL > b.top - pad;

export class PinGrid {
  constructor(layer) {
    this.layer = layer;    // the pin layer — the grid is slipped in behind it
    this.el = null;
    this.cells = [];       // { key, x, y, el } — x/y are the cell's CENTRE
    this.band = null;      // where the pointer counts as "over the grid"
    this.shown = false;
    this._stale = true;
    this._target = null;
    // a resized window is a different grid — a stale one would put pins under
    // the chrome, or (when it had no room to exist) refuse them altogether
    window.addEventListener('resize', () => {
      this._stale = true;
      if (this.shown) this.build();
    });
  }

  // The usable rectangle: the window, less the toolbar along the top and the
  // sidebar down the left, since neither ever moves out of the way.
  _frame() {
    let left = 0, top = 0;
    for (const sel of GRID_FRAME) {
      const el = document.querySelector(sel);
      if (!onScreen(el)) continue;
      const r = el.getBoundingClientRect();
      // whichever edge it is pinned to is the one it eats into
      if (r.width >= window.innerWidth - 1) top = Math.max(top, r.bottom);
      else left = Math.max(left, r.right);
    }
    return { left: left + GRID_GAP, top: top + GRID_GAP,
      right: window.innerWidth - GRID_GAP, bottom: window.innerHeight - GRID_GAP };
  }

  // (Re)compute the cells. Cheap enough to run every time the grid is shown,
  // which is what keeps it honest about chrome that comes and goes.
  build() {
    const f = this._frame();
    const w = f.right - f.left, h = f.bottom - f.top;
    const cols = Math.floor(w / CELL), rows = Math.floor(h / CELL);
    this.cells = [];
    this.band = null;
    this._stale = false;
    if (cols < 3 || rows < 3) { this._render(); return; }   // no room for a ring
    // centre the ring in the free space so it hugs both rims evenly
    const ox = f.left + (w - cols * CELL) / 2, oy = f.top + (h - rows * CELL) / 2;
    const blockers = GRID_AVOID.map(s => document.querySelector(s))
      .filter(onScreen).map(el => el.getBoundingClientRect());
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        // the ring only — the middle of the screen stays clear for the map
        if (cx > 0 && cx < cols - 1 && cy > 0 && cy < rows - 1) continue;
        const x = ox + cx * CELL, y = oy + cy * CELL;
        if (blockers.some(b => overlaps({ x, y }, b, GRID_GAP))) continue;
        this.cells.push({ key: `${cx},${cy}`, x: x + CELL / 2, y: y + CELL / 2 });
      }
    }
    // over the grid = inside the free space but outside the hole in the middle
    this.band = {
      left: f.left, top: f.top, right: f.right, bottom: f.bottom,
      hole: { left: ox + CELL, top: oy + CELL,
        right: ox + (cols - 1) * CELL, bottom: oy + (rows - 1) * CELL },
    };
    this._render();
  }

  _render() {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.id = 'pin-grid';
      // behind every marker, in front of the map: a pin always sits on top of
      // the cell it is dropping into
      this.layer.parentNode.insertBefore(this.el, this.layer);
    }
    this.el.textContent = '';
    for (const c of this.cells) {
      const d = document.createElement('div');
      d.className = 'pg-cell';
      d.style.left = (c.x - CELL / 2) + 'px';
      d.style.top = (c.y - CELL / 2) + 'px';
      d.style.width = d.style.height = CELL + 'px';
      c.el = d;
      this.el.appendChild(d);
    }
  }

  // is this point over the grid — i.e. out at the rim rather than on the map?
  contains(px, py) {
    this.ensure();
    const b = this.band;
    if (!b) return false;
    if (px < b.left || px > b.right || py < b.top || py > b.bottom) return false;
    const h = b.hole;
    return !(px > h.left && px < h.right && py > h.top && py < h.bottom);
  }

  // the closest cell nothing is standing in; falls back to the closest cell of
  // all, so a full grid still snaps somewhere rather than dropping the gesture
  nearest(px, py, taken = new Set()) {
    let best = null, bestD = Infinity, any = null, anyD = Infinity;
    for (const c of this.cells) {
      const d = (c.x - px) ** 2 + (c.y - py) ** 2;
      if (d < anyD) { anyD = d; any = c; }
      if (!taken.has(c.key) && d < bestD) { bestD = d; best = c; }
    }
    return best || any;
  }

  // there are cells to snap to even when nothing has asked to see them
  ensure() {
    if (this._stale) this.build();
  }

  show() {
    this.build();
    this.shown = true;
    this.el.classList.add('on');
  }

  hide() {
    this.shown = false;
    this.highlight(null);
    if (this.el) this.el.classList.remove('on');
  }

  // light up the cell a pin is about to drop into
  highlight(cell) {
    if (this._target && this._target.el) this._target.el.classList.remove('target');
    this._target = cell || null;
    if (cell && cell.el) cell.el.classList.add('target');
  }
}

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
    this.grid = new PinGrid(layer);   // where persistent pins snap

    document.addEventListener('pointerdown', e => {
      this.lastPlacedId = null; // any click means the user has moved on
      if (e.target.closest('.pin, .move-confirm')) return;
      // Off the pin / move UI this may be a click that dismisses the selection
      // and an unconfirmed move — or it may be a pan/drag of the map, which must
      // NOT abandon a move in progress. Defer to pointerup: only a click (little
      // to no movement) dismisses; a pan leaves the move and selection alone.
      const sx = e.clientX, sy = e.clientY, target = e.target;
      const cleanup = () => {
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', cleanup);
      };
      const onUp = ev => {
        cleanup();
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) >= 6) return; // a pan — keep everything
        this.cancelPendingMove();
        if (this.selectedId) this.deselect();
        if (this._stickyCard && !this._stickyCard.contains(target)) {
          this._hideCard(this._stickyCardPin, true);
        }
      };
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', cleanup);
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
    const entry = { data, el, ico, card: null, imgUrl: null, moveEl: null, pendingMove: null };
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

  // Selecting a pin "arms" it for moving: it gets the .selected class, which
  // makes it gently breathe (see CSS) to signal it can now be dragged to a new
  // spot. There's no separate drag handle — you grab the breathing pin itself.
  select(id) {
    if (this.selectedId !== id) this.cancelPendingMove();
    this.selectedId = id;
    for (const [pid, e] of this.pins) e.el.classList.toggle('selected', pid === id);
  }

  deselect() {
    this.selectedId = null;
    for (const e of this.pins.values()) e.el.classList.remove('selected');
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
    const p = this.screenPos(entry.data);
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
      if (!visible && e.card) this._hideCard(e, true);
    }
  }

  // Where a pin sits on screen. An ordinary pin is a point on the MAP, so it
  // pans and zooms with it. A persistent pin is nailed to the SCREEN instead —
  // held as a fraction of the window rather than a pixel offset, so resizing
  // the window keeps it in the same corner rather than pushing it off the edge.
  // Shrinking the window can carry an anchor under the toolbar or off an edge,
  // so the clamp applies on the way out too — the fraction it was saved at is
  // kept, ready for when there's room again.
  screenPos(d) {
    if (!d.fixed) return this.view.mapToScreen(d.x, d.y);
    return clampAnchor((d.fx ?? 0.5) * window.innerWidth, (d.fy ?? 0.5) * window.innerHeight);
  }

  // Which grid cells already have a persistent pin standing in them, so the
  // next one snaps beside them rather than on top. Worked out from where the
  // pins actually are (they store a fraction of the window, not a cell), which
  // keeps them right even after the grid has been rebuilt at a new size.
  takenCells(exceptId = null) {
    this.grid.ensure();
    const taken = new Set();
    for (const e of this.pins.values()) {
      if (!e.data.fixed || e.data.id === exceptId) continue;
      const p = this.screenPos(e.data);
      const c = this.grid.nearest(p.x, p.y);
      if (c && Math.hypot(c.x - p.x, c.y - p.y) <= CELL / 2) taken.add(c.key);
    }
    return taken;
  }

  // the cell a persistent pin would land in from this screen point
  snapCell(px, py, exceptId = null) {
    return this.grid.nearest(px, py, this.takenCells(exceptId));
  }

  syncPositions() {
    for (const e of this.pins.values()) {
      const p = this.screenPos(e.data);
      e.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (e.card) this._positionCard(e);
      if (e.moveEl) this._positionMoveConfirm(e);
    }
  }

  _decorate(entry) {
    const cat = catById(entry.data.cat);
    entry.ico.textContent = cat.icon;
    entry.el.style.setProperty('--pc', cat.color || '#9e2b25');
    // no native title tooltip — the hover card carries the info
    entry.el.classList.toggle('done', !!entry.data.done);
    // square, and above the map pins: a persistent pin belongs to the screen
    entry.el.classList.toggle('fixed', !!entry.data.fixed);
  }

  _wire(entry) {
    const el = entry.el;
    let downX = 0, downY = 0, moved = false, down = false, dragging = false, sx = 0, sy = 0;
    let origin = null;   // where the drag started, in the pin's own coordinates

    // First click on a pin selects it — it starts breathing to show it's now
    // movable. From then on (while selected, or while a move is pending its
    // ✓/✗) grabbing the pin and dragging repositions it directly; there's no
    // separate handle. A drag on an un-selected pin is ignored, so a pin is
    // never nudged by accident before you've armed it.
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      down = true; moved = false;
      downX = e.clientX; downY = e.clientY;
      dragging = entry.el.classList.contains('selected') || !!entry.pendingMove;
      if (dragging) {
        // a persistent pin is dragged in screen pixels (it has no map spot to
        // divide by the zoom), an ordinary one in map coordinates
        const p = this.screenPos(entry.data);
        sx = entry.data.fixed ? p.x : entry.data.x;
        sy = entry.data.fixed ? p.y : entry.data.y;
        origin = this._posOf(entry.data);
      }
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', e => {
      if (!down) {
        // hover shows the preview card — but not for the armed pin: while it's
        // selected it only breathes (with its ✕), no card in the way
        if (!this.suppressHover && !entry.pendingMove && !entry.card
            && this.selectedId !== entry.data.id) this._showCard(entry, false);
        return;
      }
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) >= 5) {
        moved = true;
        if (dragging) {
          entry.el.classList.add('moving');  // lift it and pause the breathing
          this._hideMoveConfirm(entry);      // tuck any ✓/✗ away while dragging
          this._hideCard(entry, true);       // and drop the card so it's unobstructed
          // a pin is over the grid now, so the grid shows itself
          if (entry.data.fixed) this.grid.show();
        }
      }
      if (dragging && moved) {
        if (entry.data.fixed) {
          // it doesn't follow the cursor freely — it steps from cell to cell,
          // so a row of persistent pins lines up instead of scattering
          const cell = this.snapCell(sx + (e.clientX - downX), sy + (e.clientY - downY),
            entry.data.id);
          this.grid.highlight(cell);
          Object.assign(entry.data, cell
            ? fixedAnchor(cell.x, cell.y)
            : fixedAnchor(sx + (e.clientX - downX), sy + (e.clientY - downY)));
        } else {
          entry.data.x = sx + (e.clientX - downX) / this.view.scale;
          entry.data.y = sy + (e.clientY - downY) / this.view.scale;
        }
        this.syncPositions();
      }
    });
    el.addEventListener('pointerup', e => {
      if (!down) return;
      down = false;
      try { el.releasePointerCapture(e.pointerId); } catch {}
      this.grid.hide();
      if (dragging && moved) {
        entry.el.classList.remove('moving');
        // a nudge during a pending move just re-pops its ✓/✗; the first drag
        // off the armed pin opens the confirm, remembering where it started
        if (entry.pendingMove) this._showMoveConfirm(entry);
        else this._beginMoveConfirm(entry, origin);
        return;
      }
      if (moved || this.suppressHover) return; // a stray drag on an un-armed pin
      // a plain click arms the pin for moving (it breathes, with a ✕ to exit)
      // and deliberately shows NO card, so the map stays clear while you move it
      this._hideCard(entry, true);
      this.select(entry.data.id);
    });

    el.addEventListener('pointerenter', () => {
      if (this.suppressHover) return;
      this.hoveredId = entry.data.id;
      if (entry.data.id !== this.lastPlacedId) this.lastPlacedId = null; // moved to another pin
      if (!entry.pendingMove && this.selectedId !== entry.data.id) this._showCard(entry, false);
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

  // ---- move confirmation (✓ keep / ✗ put back) ----------------------------

  // a pin's position, in whichever pair of numbers that pin actually uses, so
  // "put it back" and Ctrl+Z work the same for both kinds
  _posOf(d) {
    return d.fixed ? { fx: d.fx, fy: d.fy } : { x: d.x, y: d.y };
  }

  _restorePos(d, o) {
    if (!o) return;
    if ('fx' in o) { d.fx = o.fx; d.fy = o.fy; }
    else { d.x = o.x; d.y = o.y; }
  }

  _beginMoveConfirm(entry, origin) {
    entry.pendingMove = origin;
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
      // ✗ puts the pin back AND exits the click/armed state (stops breathing)
      no.addEventListener('click', e => { e.stopPropagation(); this._cancelMove(entry); this.deselect(); });
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
    this.deselect();   // confirming the spot drops the selection, so it stops breathing
  }

  _cancelMove(entry) {
    const o = entry.pendingMove;
    entry.pendingMove = null;
    this._restorePos(entry.data, o);
    if (entry.moveEl) { entry.moveEl.remove(); entry.moveEl = null; }
    this.syncPositions();
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
        this._restorePos(e.data, this._lastMove.from);
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
    const p = this.screenPos(entry.data);
    entry.moveEl.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  // hide/re-pop the ✓/✗ while the pin is being nudged directly (pending move)
  _hideMoveConfirm(entry) {
    if (entry.moveEl) entry.moveEl.style.display = 'none';
  }

  _showMoveConfirm(entry) {
    if (!entry.moveEl) { if (entry.pendingMove) this._beginMoveConfirm(entry, entry.pendingMove); return; }
    entry.moveEl.style.display = '';
    this._positionMoveConfirm(entry);
    entry.moveEl.style.animation = 'none';
    void entry.moveEl.offsetWidth;           // replay the fade-in pop
    entry.moveEl.style.animation = '';
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
    entry.cardSide = null;   // the next opening picks its side afresh
  }

  _positionCard(entry) {
    const p = this.screenPos(entry.data);
    const card = entry.card;
    if (!card) return;
    const margin = CARD_MARGIN;
    // Give the picture only the height that leaves the card on screen. Without
    // this a tall portrait shot overflowed the bottom at the card's NORMAL
    // width, before any zooming — there was no size it could be clamped to,
    // because the overflow was the picture's own aspect.
    const env = card.querySelector('img.env');
    if (env) env.style.maxHeight = imgRoom(card, env) + 'px';
    const w = card.offsetWidth || 320, h = card.offsetHeight;
    // Which side of the pin the card sits on is settled ONCE per opening.
    // Deciding it afresh on every zoom step made the card jump across the pin
    // the moment it outgrew the room on one side — and jump back on the next
    // notch, since the flip changed which side the room was on. Zooming now
    // only ever slides it; it never changes sides under you.
    if (entry.cardSide == null) {
      entry.cardSide = (p.x + 18 + w + margin > window.innerWidth) ? 'left' : 'right';
    }
    let x = entry.cardSide === 'left' ? p.x - w - 24 : p.x + 18;
    let y = p.y - 20;
    // Then keep it on screen regardless: once it is wider than the room beside
    // the pin, neither side fits and it has to overlap the pin instead.
    x = Math.max(margin, Math.min(x, window.innerWidth - w - margin));
    y = Math.max(CARD_TOP, Math.min(y, window.innerHeight - h - margin));
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
      img.title = 'Scroll to zoom · click to open';
      img.addEventListener('load', () => this._positionCard(entry));
      img.addEventListener('click', () => this.handlers.onLightbox(entry.imgUrl));
      // Scroll over the picture to enlarge it in place — the whole card grows
      // with the image, so you can read detail without opening the lightbox.
      //
      // The ceiling is whatever the window can actually hold, rather than a
      // fixed 760px: the picture is the point of the card, so it should be
      // able to fill the screen. Height is the binding constraint most of the
      // time, and the deck and buttons below don't scale with the picture, so
      // they come off the budget before what's left is turned back into a
      // width through the image's own aspect.
      const BASE_W = 320;
      let zoomW = BASE_W;
      const maxZoomW = () => {
        const aspect = (img.naturalWidth && img.naturalHeight)
          ? img.naturalWidth / img.naturalHeight : 16 / 9;
        return Math.max(BASE_W, Math.min(
          window.innerWidth - 2 * CARD_MARGIN,      // as wide as the window allows
          imgRoom(card, img) * aspect));            // ...or as tall, whichever binds
      };
      img.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
        // a third bigger per notch, so two or three flicks fill the screen.
        // The old step was a flat number of pixels per unit of delta, which
        // crawled — and crawled relatively slower the bigger the picture got,
        // exactly when you want it to move. Normalised the same way as the
        // map's zoom, since one notch is 120 in some browsers, 3 "lines" in
        // others, and split across several events on a high-resolution wheel.
        const notches = e.deltaY / (e.deltaMode === 0 ? 120 : 3);
        zoomW = Math.max(BASE_W, Math.min(maxZoomW(), zoomW * Math.pow(1.35, -notches)));
        card.style.width = zoomW + 'px';
        this._positionCard(entry);
      }, { passive: false });
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

    // the frosted deck: category always, plus the note whenever there is one.
    // The note lives here (not inside the paste square) so it can't overflow
    // the fixed-size square when the pin has no screenshot yet.
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
    if (d.note) {
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
      if (entry.card) { this._refreshCard(entry, { animateImg: true }); this._celebrateImage(entry); }
    } else {
      this.update(entry.data);
    }
    this.applyFilter();
    this.handlers.onPinsChanged?.();
  }

  // a satisfying landing when a picture drops into an open card: the pin marker
  // flashes its ring, the card gives an accent-glow pulse, and a light sweeps
  // once across the fresh screenshot
  _celebrateImage(entry) {
    this.flashPin(entry.data.id);
    if (this.view.reduceMotion) return;
    const card = entry.card;
    if (!card) return;
    card.classList.add('env-landed');
    card.addEventListener('animationend', () => card.classList.remove('env-landed'), { once: true });
    const imgWrap = card.querySelector('.pc-img.has-env');
    if (imgWrap) {
      const shine = document.createElement('div');
      shine.className = 'env-shine';
      imgWrap.appendChild(shine);
      const drop = () => shine.remove();
      shine.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, 900);
    }
  }
}
