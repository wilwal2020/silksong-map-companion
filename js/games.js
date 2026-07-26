// Games. Silksong is built in: it ships with a reference map, so pastes are
// located automatically (OCR + shape matching). Any game you add yourself is
// "custom" — there is no reference map to match against, so screenshots are
// positioned by hand on an empty world of the size you pick. Everything else
// (pins, your own pin types, notes, pictures, undo, export) works the same.

import { store } from './store.js';

export const BUILTIN_GAME = {
  id: 'silksong', name: 'Silksong', icon: '🪡', builtin: true,
};

// A custom game's world has no size you choose. It starts here and grows to
// fit whatever you paste: asking up front never worked, because nobody knows
// how big a game's map is until they have mapped it, and the answer could not
// be changed afterwards. `w`/`h` on a game record are just how far it has
// grown so far.
export const START_SIZE = { w: 3600, h: 2400 };

let custom = [];   // [{ id, name, icon, w, h, created }]

export function allGames() { return [BUILTIN_GAME, ...custom]; }
export function gameById(id) { return allGames().find(g => g.id === id) || BUILTIN_GAME; }

export async function loadGames() {
  const saved = await store.getGlobal('games');
  custom = Array.isArray(saved) ? saved : [];
  return allGames();
}

function persist() { return store.putGlobal('games', custom); }

export async function createGame({ name, icon }) {
  const g = {
    id: 'g_' + crypto.randomUUID().slice(0, 8),
    name: name.trim() || 'New game',
    icon: icon || '🎮',
    w: START_SIZE.w, h: START_SIZE.h,
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
