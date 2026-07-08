// Pin management: DOM markers over the map canvas, hover cards with the
// attached environment screenshot, dragging (with a confirm step), filtering.

import { categories, catById } from './categories.js';

// re-export so existing importers keep working
export { catById };

// is point p inside triangle a-b-c? (sign test)
function inTriangle(p, a, b, c) {
  const s = (u, v, w) => (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
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
      if (this._stickyCard && !this._stickyCard.contains(e.target)
          && !e.target.closest('.pin')) {
        this._hideCard(this._stickyCardPin, true);
      }
    });

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
    const pin = entry.el.getBoundingClientRect();
    if (x >= pin.left - 4 && x <= pin.right + 4 && y >= pin.top - 4 && y <= pin.bottom + 4) return true;
    const card = entry.card.getBoundingClientRect();
    const pad = 8;
    if (x >= card.left - pad && x <= card.right + pad && y >= card.top - pad && y <= card.bottom + pad) return true;
    // triangle from the pin centre out to the card's near vertical edge
    const cx = (pin.left + pin.right) / 2, cy = (pin.top + pin.bottom) / 2;
    const ex = card.left >= cx ? card.left : card.right;
    return inTriangle({ x, y }, { x: cx, y: cy },
      { x: ex, y: card.top - pad }, { x: ex, y: card.bottom + pad });
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
    this.handlers.onPinsChanged?.();
  }

  removeAll() {
    for (const id of [...this.pins.keys()]) this.remove(id);
  }

  select(id) {
    this.selectedId = id;
    for (const [pid, e] of this.pins) e.el.classList.toggle('selected', pid === id);
  }

  // ring flash on a pin (e.g. a screenshot just landed in it)
  flashPin(id) {
    this._playIco(id, 'pin-flash');
  }

  // celebratory burst when a pin is checked off
  flashDone(id) {
    this._playIco(id, 'pin-doneburst');
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

  syncPositions() {
    for (const e of this.pins.values()) {
      const p = this.view.mapToScreen(e.data.x, e.data.y);
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
  }

  _wire(entry) {
    const el = entry.el;
    let downX = 0, downY = 0, moved = false, dragging = false, origin = null;

    el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      dragging = true; moved = false;
      // keep the original spot across repeated nudges while a move is pending
      origin = entry.pendingMove || { x: entry.data.x, y: entry.data.y };
      downX = e.clientX; downY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (!dragging) {
        // plain hover: make sure the card is up even if pointerenter was missed
        if (!this.suppressHover && !entry.pendingMove && !entry.card) this._showCard(entry, false);
        return;
      }
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < 5) return;
      moved = true;
      this._hideCard(entry);
      const m = this.view.screenToMap(e.clientX, e.clientY);
      entry.data.x = m.x; entry.data.y = m.y;
      this.syncPositions();
    });
    el.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        this._beginMoveConfirm(entry, origin);
      } else if (!this.suppressHover) {
        this.select(entry.data.id);
        this._showCard(entry, true);
      }
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

  // ---- move confirmation (✓ keep / ✗ put back) ----------------------------

  _beginMoveConfirm(entry, origin) {
    entry.pendingMove = origin;
    if (!entry.moveEl) {
      const wrap = document.createElement('div');
      wrap.className = 'move-confirm';
      const ok = document.createElement('button');
      ok.className = 'mc-btn mc-ok'; ok.textContent = '✓';
      ok.title = 'Keep the new position';
      const no = document.createElement('button');
      no.className = 'mc-btn mc-no'; no.textContent = '✗';
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
    entry.pendingMove = null;
    if (entry.moveEl) { entry.moveEl.remove(); entry.moveEl = null; }
    this.handlers.onChange(entry.data);
  }

  _cancelMove(entry) {
    const o = entry.pendingMove;
    entry.pendingMove = null;
    if (o) { entry.data.x = o.x; entry.data.y = o.y; }
    if (entry.moveEl) { entry.moveEl.remove(); entry.moveEl = null; }
    this.syncPositions();
  }

  _positionMoveConfirm(entry) {
    if (!entry.moveEl) return;
    const p = this.view.mapToScreen(entry.data.x, entry.data.y);
    entry.moveEl.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  // ---- hover / detail card ------------------------------------------------

  _showCard(entry, sticky) {
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

    if (d.img) {
      if (!entry.imgUrl) entry.imgUrl = URL.createObjectURL(d.img);
      const img = document.createElement('img');
      img.className = 'env';
      img.src = entry.imgUrl;
      img.addEventListener('load', () => this._positionCard(entry));
      img.addEventListener('click', () => this.handlers.onLightbox(entry.imgUrl));
      card.appendChild(img);
    } else {
      const no = document.createElement('div');
      no.className = 'no-env';
      no.textContent = 'No area screenshot yet — paste one right here (Ctrl+V) while hovering.';
      // hovering this square makes the pin an explicit paste target; the id
      // is read back via a live :hover query at paste time (event-based
      // tracking went stale when the card moved under a zoom/pan)
      no.dataset.pinId = d.id;
      card.appendChild(no);
    }

    const head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML = `<span class="cat">${cat.icon} ${cat.label}</span>`;
    card.appendChild(head);

    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = d.note || '';
    card.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    mk(d.done ? '↩ undo' : '✓ done', 'Mark this spot as dealt with', () => {
      d.done = !d.done;
      const justDone = d.done;
      this.handlers.onChange(d);
      this.update(d);
      if (justDone) this.flashDone(d.id); // celebrate checking it off
    });
    mk('📷', 'Attach / replace the area screenshot (paste after clicking)', () => {
      this.handlers.onRequestAttach(d);
    });
    mk('✎', 'Edit category & note', () => this.handlers.onEdit(d));
    mk('🗑', 'Delete pin', () => this.handlers.onDelete(d));
    card.appendChild(actions);

    // hide is driven by the safe-zone tracker (_trackHover), not a plain
    // pointerleave, so a diagonal move to a button doesn't drop the card

    this.layer.appendChild(card);
    return card;
  }
}
