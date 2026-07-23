// Games. Silksong is built in: it ships with a reference map, so pastes are
// located automatically (OCR + shape matching). Any game you add yourself is
// "custom" — there is no reference map to match against, so screenshots are
// positioned by hand on an empty world of the size you pick. Everything else
// (pins, your own pin types, notes, pictures, undo, export) works the same.

import { store } from './store.js';

export const BUILTIN_GAME = {
  id: 'silksong', name: 'Silksong', icon: '🪡', builtin: true,
};

// How big a custom game's world is. Screenshots are pasted at their own pixel
// size, so this is really "how much map can fit" — the explored composite is a
// canvas of exactly these dimensions, so bigger costs memory.
export const WORLD_SIZES = [
  { id: 'small',  label: 'Small',  w: 2400, h: 1600, hint: 'a short game' },
  { id: 'medium', label: 'Medium', w: 3600, h: 2400, hint: 'most games' },
  { id: 'large',  label: 'Large',  w: 5200, h: 3400, hint: 'a sprawling world' },
];

export const DEFAULT_SIZE = 'medium';

let custom = [];   // [{ id, name, icon, w, h, created }]

export function allGames() { return [BUILTIN_GAME, ...custom]; }
export function gameById(id) { return allGames().find(g => g.id === id) || BUILTIN_GAME; }

export async function loadGames() {
  const saved = await store.getGlobal('games');
  custom = Array.isArray(saved) ? saved : [];
  return allGames();
}

function persist() { return store.putGlobal('games', custom); }

export async function createGame({ name, icon, w, h }) {
  const g = {
    id: 'g_' + crypto.randomUUID().slice(0, 8),
    name: name.trim() || 'New game',
    icon: icon || '🎮',
    w, h,
    created: Date.now(),
  };
  custom.push(g);
  await persist();
  return g;
}

export async function updateGame(id, patch) {
  custom = custom.map(g => (g.id === id ? { ...g, ...patch, id } : g));
  await persist();
  return gameById(id);
}

// Forget a custom game entirely: its list entry, its pins and all of its
// saved state (map, view, pin types, calibration).
export async function removeGame(id) {
  custom = custom.filter(g => g.id !== id);
  await persist();
  await store.clearGameData(id);
}

export async function currentGameId() {
  return (await store.getGlobal('currentGame')) || BUILTIN_GAME.id;
}
export function setCurrentGameId(id) { return store.putGlobal('currentGame', id); }
