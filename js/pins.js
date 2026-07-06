// Pin management: DOM markers over the map canvas, hover cards with the
// attached environment screenshot, dragging (with a confirm step), filtering.

import { categories, catById } from './categories.js';

// re-export so existing importers keep working
export { catById };

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
    this._stickyCard = null;

    document.addEventListener('pointerdown', e => {
      if (this._stickyCard && !this._stickyCard.contains(e.target)
          && !e.target.closest('.pin')) {
        this._hideCard(this._stickyCardPin, true);
      }
    });
  }

  add(data, { select = false } = {}) {
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

  setAwaiting(id) {
    this.awaitingId = id;
    for (const [pid, e] of this.pins) e.el.classList.toggle('awaiting', pid === id);
  }

  // pin that an "area screenshot" paste should attach to
  attachTarget() {
    return this.awaitingId || this.selectedId;
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
        if (!entry.pendingMove && !entry.card) this._showCard(entry, false);
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
      } else {
        this.select(entry.data.id);
        this._showCard(entry, true);
      }
    });

    el.addEventListener('pointerenter', () => {
      clearTimeout(entry._leaveTimer);
      if (!entry.pendingMove) this._showCard(entry, false);
    });
    el.addEventListener('pointerleave', () => {
      clearTimeout(entry._leaveTimer);
      entry._leaveTimer = setTimeout(() => {
        // keep it open if the pointer is back on the pin or over the card
        if (entry.card && !entry.card.matches(':hover') && !el.matches(':hover')
            && this._stickyCard !== entry.card) {
          this._hideCard(entry);
        }
      }, 240);
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
    if (sticky) { this._stickyCard = entry.card; this._stickyCardPin = entry; }
    this._positionCard(entry);
  }

  _hideCard(entry, force = false) {
    if (!entry || !entry.card) return;
    if (this._stickyCard === entry.card && !force) return;
    if (this._stickyCard === entry.card) { this._stickyCard = null; this._stickyCardPin = null; }
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
    card.style.transform = `translate(${x}px, ${y}px)`;
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
      no.textContent = 'No area screenshot yet — click 📷 then paste one.';
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
      this.handlers.onChange(d);
      this.update(d);
    });
    mk('📷', 'Attach / replace the area screenshot (paste after clicking)', () => {
      this.handlers.onRequestAttach(d);
    });
    mk('✎', 'Edit category & note', () => this.handlers.onEdit(d));
    mk('🗑', 'Delete pin', () => this.handlers.onDelete(d));
    card.appendChild(actions);

    card.addEventListener('pointerleave', () => {
      if (this._stickyCard !== card) this._hideCard(entry);
    });

    this.layer.appendChild(card);
    return card;
  }
}
