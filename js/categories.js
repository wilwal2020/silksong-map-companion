// Pin categories: the built-in set plus user-defined custom types, with a
// persisted display order. Each category carries a colour so pins read
// clearly against the map and types stay distinguishable.

export const BUILTIN = [
  { id: 'door',    icon: '🔒', label: 'Locked door',                 color: '#e0655e' },
  { id: 'wall',    icon: '🧱', label: 'Breakable / suspicious wall', color: '#c9a45c' },
  { id: 'ability', icon: '🕷️', label: 'Need ability / tool',         color: '#a78bfa' },
  { id: 'item',    icon: '✨', label: 'Item / collectible',          color: '#e6c86e' },
  { id: 'npc',     icon: '👤', label: 'NPC / quest',                 color: '#6cc1e0' },
  { id: 'vendor',  icon: '💰', label: 'Vendor',                      color: '#6fce9b' },
  { id: 'bench',   icon: '🪑', label: 'Bench',                       color: '#9aa7bd' },
  { id: 'boss',    icon: '💀', label: 'Boss / danger',               color: '#d0483f' },
  { id: 'other',   icon: '❓', label: 'Other',                       color: '#9aa0b0' },
];

let custom = [];   // [{ id, icon, label, color, custom:true }]
let order = [];    // [id, ...] — preferred display order

function base() { return [...BUILTIN, ...custom]; }

// full category list in the user's chosen order (unordered ones appended)
export function categories() {
  const map = new Map(base().map(c => [c.id, c]));
  const out = [];
  for (const id of order) {
    if (map.has(id)) { out.push(map.get(id)); map.delete(id); }
  }
  for (const c of map.values()) out.push(c);
  return out;
}

export function catById(id) {
  return base().find(c => c.id === id) || BUILTIN[BUILTIN.length - 1];
}

export function customCategories() { return custom.slice(); }
export function isCustom(id) { return custom.some(c => c.id === id); }

export function setCustomCategories(list) {
  custom = Array.isArray(list) ? list.map(c => ({ ...c, custom: true })) : [];
}
export function addCustomCategory(cat) {
  custom.push({ ...cat, custom: true });
  // only append to an explicit order; an empty order means "natural order",
  // which already places new custom types after the built-ins
  if (order.length && !order.includes(cat.id)) order.push(cat.id);
}
export function removeCustomCategory(id) {
  custom = custom.filter(c => c.id !== id);
  order = order.filter(o => o !== id);
}

export function setOrder(list) { order = Array.isArray(list) ? list.slice() : []; }
export function currentOrder() { return categories().map(c => c.id); }
