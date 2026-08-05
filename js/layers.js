// Map layers. A game's map is not always one flat sheet: plenty of them draw
// an upper and a lower floor, an interior, or a dream version of the same
// ground, and those maps OVERLAP — the same spot on the screen is two places
// at once. One composite can't hold that; each new paste would simply paint
// over the last.
//
// So the map is a stack of layers instead. Every layer is its own composite of
// pasted screenshots with its own pins, and they all share ONE coordinate
// space — a point on layer two is the same point on layer one, which is what
// makes lining them up against each other meaningful in the first place. The
// layer you're on is drawn on top at full strength and the rest are dimmed
// behind it (MapView.render), so you can still see what you're aligning to.
//
// Layer one is the BASE layer, and it keeps the plain, unprefixed `fog` key
// every save has always used — a map made before layers existed opens as its
// base layer with nothing to migrate, and stays readable by a build without
// them. That's the same trick store.js plays for Silksong's own keys.

import { store } from './store.js';
import { Explored, MIN_DETAIL } from './explored.js';

export { MIN_DETAIL };

export const BASE_LAYER_ID = 'base';

// Not a hard rule so much as an honest one: every layer is a full-size canvas
// held in memory (see MAX_CANVAS_PIXELS in explored.js), and they are all drawn
// on every frame. Halving the detail is what buys room back — see setDetail.
export const MAX_LAYERS = 8;

export const fogKey = id => (id === BASE_LAYER_ID ? 'fog' : `fog:${id}`);

// which layer a pin belongs to — a pin saved before layers existed is on the
// base layer, which is exactly where it has always been drawn
export const pinLayer = d => d.layer || BASE_LAYER_ID;

export class LayerStack {
  // `onCreate(explored, layer)` lets the app wire up each layer's persistence
  // and look (the background fade, the reference map) as it comes into being —
  // a layer added an hour from now needs the same treatment as one loaded at
  // startup, and doing it here is the only way to be sure it gets it.
  constructor(onCreate = null) {
    this.list = [];               // [{ id, name, explored }], base first
    this.currentId = BASE_LAYER_ID;
    this.onCreate = onCreate;
  }

  get count() { return this.list.length; }
  get current() { return this.find(this.currentId) || this.list[0]; }
  get explored() { return this.current.explored; }
  find(id) { return this.list.find(l => l.id === id) || null; }
  // the composite of one layer, falling back to the open one for an id that no
  // longer exists (a layer deleted out from under an operation in flight)
  exploredOf(id) { const l = this.find(id); return l ? l.explored : this.explored; }
  indexOf(id) { return this.list.findIndex(l => l.id === id); }

  // How finely every layer is stored: canvas pixels per map pixel. One layer
  // cannot differ from another — they are drawn into the same coordinate space
  // and a paste has to land the same way on whichever one is open.
  get detail() { return this.list.length ? this.list[0].explored.scale : 1; }

  _spawn(def, w, h, detail) {
    const layer = { id: def.id, name: def.name, explored: new Explored(w, h, detail) };
    this.onCreate?.(layer.explored, layer);
    return layer;
  }

  // Read the saved definitions and each layer's composite. `world` is only the
  // starting size — a growable world's real size comes from the blobs, exactly
  // as it did when there was one composite.
  async load(world, detail = 1) {
    const saved = await store.getMeta('layers');
    const defs = (Array.isArray(saved) ? saved : []).filter(d => d && d.id);
    // the base layer always exists, and always comes first
    if (!defs.some(d => d.id === BASE_LAYER_ID)) {
      defs.unshift({ id: BASE_LAYER_ID, name: 'Layer 1' });
    }
    this.list = defs.map(d => this._spawn(d, world.width, world.height, detail));
    for (const l of this.list) {
      const blob = await store.getMeta(fogKey(l.id));
      if (blob) await l.explored.loadFromBlob(blob);
    }
    const cur = await store.getMeta('currentLayer');
    this.currentId = this.find(cur) ? cur : BASE_LAYER_ID;
    return this.list;
  }

  // only the names and order are saved here; the pixels are one blob per layer
  persist() {
    return store.putMeta('layers', this.list.map(l => ({ id: l.id, name: l.name })));
  }

  select(id) {
    if (!this.find(id)) return false;
    this.currentId = id;
    store.putMeta('currentLayer', id);
    return true;
  }

  // `id` is only ever passed by an import, which has to put a backup's layers
  // back under the ids its pins were saved with.
  async add(name = '', id = null) {
    if (this.list.length >= MAX_LAYERS || (id && this.find(id))) return null;
    const base = this.list[0].explored;
    const layer = this._spawn(
      { id: id || 'l_' + crypto.randomUUID().slice(0, 8), name: name || `Layer ${this.list.length + 1}` },
      base.mapW, base.mapH, base.scale);
    this.list = [...this.list, layer];
    await this.persist();
    return layer;
  }

  async rename(id, name) {
    const l = this.find(id);
    if (!l || !name) return false;
    l.name = name;
    await this.persist();
    return true;
  }

  // The base layer can't be removed: it is the layer every pre-layers save is,
  // and the one the plain `fog` key belongs to. There is always a map.
  async remove(id) {
    if (id === BASE_LAYER_ID || !this.find(id)) return false;
    this.list = this.list.filter(l => l.id !== id);
    if (this.currentId === id) this.select(BASE_LAYER_ID);
    await this.persist();
    await store.putMeta(fogKey(id), null);
    return true;
  }

  // Growing the world happens to EVERY layer at once. They share one
  // coordinate space, and a layer left at the old size would be a map whose
  // pixels have quietly stopped meaning the same places. The inputs are
  // identical and so is the answer, so any one of them can report the shift.
  grow(rect, pad) {
    let out = { dx: 0, dy: 0, grew: false };
    for (const l of this.list) out = l.explored.grow(rect, pad);
    return out;
  }

  // Redraw every layer at a coarser detail. All of them together, always: they
  // share one coordinate space, and a paste landing on a finer layer than the
  // one beside it would line up against neither.
  //
  // Returns false when there is nothing to do, so the caller can say so rather
  // than claim it shrank something it didn't.
  setDetail(next) {
    if (!(next > 0) || next > 1 || next < MIN_DETAIL || next === this.detail) return false;
    let did = false;
    for (const l of this.list) did = l.explored.resample(next) || did;
    return did;
  }

  // Has anything at all been pasted, on any layer? Every layer is asked, not
  // just up to the first with something on it: the answers are what the
  // renderer reads to skip an empty layer, and a short-circuit would leave the
  // rest unanswered.
  isBlank() { return this.list.map(l => l.explored.isBlank()).every(Boolean); }

  // back to a single empty base layer (Reset). The extra layers' fog blobs go
  // with the rest of the game's keys in store.clearMeta.
  async reset() {
    this.list = this.list.filter(l => l.id === BASE_LAYER_ID);
    this.list[0].explored.clear();
    this.currentId = BASE_LAYER_ID;
    await this.persist();
  }
}
