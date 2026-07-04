// Pin management: DOM markers over the map canvas, hover cards with the
// attached environment screenshot, dragging, filtering.

export const CATEGORIES = [
  { id: 'door',    icon: '🔒', label: 'Locked door' },
  { id: 'wall',    icon: '🧱', label: 'Breakable / suspicious wall' },
  { id: 'ability', icon: '🕷️', label: 'Need ability / tool' },
  { id: 'item',    icon: '✨', label: 'Item / collectible' },
  { id: 'npc',     icon: '👤', label: 'NPC / quest' },
  { id: 'vendor',  icon: '💰', label: 'Vendor' },
  { id: 'bench',   icon: '🪑', label: 'Bench' },
  { id: 'boss',    icon: '💀', label: 'Boss / danger' },
  { id: 'other',   icon: '❓', label: 'Other' },
];

export function catById(id) {
  return CATEGORIES.find(c => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}

export class PinManager {
  constructor(layer, view, handlers) {
    this.layer = layer;
    this.view = view;
    this.handlers = handlers; // { onChange, onEdit, onDelete, onRequestAttach, onLightbox }
    this.pins = new Map();     // id -> { data, el, card, imgUrl }
    this.filter = new Set(CATEGORIES.map(c => c.id));
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
    const entry = { data, el, card: null, imgUrl: null };
    this.pins.set(data.id, entry);
    this.layer.appendChild(el);
    this._decorate(entry);
    this._wire(entry);
    if (select) this.select(data.id);
    this.syncPositions();
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
  }

  remove(id) {
    const entry = this.pins.get(id);
    if (!entry) return;
    if (entry.imgUrl) URL.revokeObjectURL(entry.imgUrl);
    if (entry.card) entry.card.remove();
    entry.el.remove();
    this.pins.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    if (this.awaitingId === id) this.awaitingId = null;
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
      if (!visible && e.card) this._hideCard(e, true);
    }
  }

  syncPositions() {
    for (const e of this.pins.values()) {
      const p = this.view.mapToScreen(e.data.x, e.data.y);
      e.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (e.card) this._positionCard(e);
    }
  }

  _decorate(entry) {
    const cat = catById(entry.data.cat);
    entry.el.textContent = cat.icon;
    entry.el.title = cat.label + (entry.data.note ? ' — ' + entry.data.note : '');
    entry.el.classList.toggle('done', !!entry.data.done);
  }

  _wire(entry) {
    const el = entry.el;
    let downX = 0, downY = 0, moved = false, dragging = false;

    el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      dragging = true; moved = false;
      downX = e.clientX; downY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < 5) return;
      moved = true;
      const m = this.view.screenToMap(e.clientX, e.clientY);
      entry.data.x = m.x; entry.data.y = m.y;
      this.syncPositions();
    });
    el.addEventListener('pointerup', e => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        this.handlers.onChange(entry.data);
      } else {
        this.select(entry.data.id);
        this._showCard(entry, true);
      }
    });

    el.addEventListener('pointerenter', () => this._showCard(entry, false));
    el.addEventListener('pointerleave', () => {
      setTimeout(() => {
        if (entry.card && !entry.card.matches(':hover') && this._stickyCard !== entry.card) {
          this._hideCard(entry);
        }
      }, 120);
    });
  }

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
    const w = 300, margin = 12;
    let x = p.x + 24, y = p.y - 20;
    if (x + w + margin > window.innerWidth) x = p.x - w - 24;
    y = Math.max(60, Math.min(y, window.innerHeight - card.offsetHeight - margin));
    card.style.transform = `translate(${x}px, ${y}px)`;
  }

  _buildCard(entry) {
    const d = entry.data;
    const cat = catById(d.cat);
    const card = document.createElement('div');
    card.className = 'pin-card';

    if (d.img) {
      if (!entry.imgUrl) entry.imgUrl = URL.createObjectURL(d.img);
      const img = document.createElement('img');
      img.className = 'env';
      img.src = entry.imgUrl;
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
