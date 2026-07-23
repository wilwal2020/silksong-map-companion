// IndexedDB persistence: pins (with their screenshot blobs) + meta
// (fog mask blob, view state).
//
// Everything is scoped to the game you're looking at: meta keys get a
// `g:<gameId>:` prefix and every pin carries its game id. Silksong — for a
// long time the only game — deliberately keeps the plain, unprefixed keys and
// its pins have no game field at all, so saves made before custom games
// existed load exactly as they did.

const DB_NAME = 'silksong-map-companion';
const DB_VERSION = 1;

const BUILTIN_GAME_ID = 'silksong';
// meta keys that belong to the app, not to any one game
const GLOBAL_KEYS = new Set(['games', 'currentGame']);

let gameId = BUILTIN_GAME_ID;
export function setStoreGame(id) { gameId = id || BUILTIN_GAME_ID; }

const scoped = k => (gameId === BUILTIN_GAME_ID ? k : `g:${gameId}:${k}`);
const gameOfKey = k => {
  const m = /^g:([^:]+):/.exec(String(k));
  return m ? m[1] : BUILTIN_GAME_ID;
};
const gameOfPin = p => p.game || BUILTIN_GAME_ID;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

// one read request wrapped as a promise
function read(store, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const req = fn(db.transaction(store).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const allPinsRaw = () => read('pins', s => s.getAll()).then(r => r || []);
const allMetaKeys = () => read('meta', s => s.getAllKeys()).then(r => r || []);

export const store = {
  async getAllPins() {
    return (await allPinsRaw()).filter(p => gameOfPin(p) === gameId);
  },
  // the game stamp is written here so callers never have to think about it
  putPin(pin) { return tx('pins', 'readwrite', s => s.put({ ...pin, game: gameId })); },
  deletePin(id) { return tx('pins', 'readwrite', s => s.delete(id)); },
  async clearPins() {
    const mine = await this.getAllPins();
    return tx('pins', 'readwrite', s => { for (const p of mine) s.delete(p.id); });
  },

  getMeta(key) { return read('meta', s => s.get(scoped(key))); },
  putMeta(key, val) { return tx('meta', 'readwrite', s => s.put(val, scoped(key))); },
  // only this game's keys — another game's save (and the app-wide game list)
  // must survive a reset
  async clearMeta() {
    const keys = (await allMetaKeys())
      .filter(k => !GLOBAL_KEYS.has(k) && gameOfKey(k) === gameId);
    return tx('meta', 'readwrite', s => { for (const k of keys) s.delete(k); });
  },

  // app-wide state (the game list, which game is open) — never scoped
  getGlobal(key) { return read('meta', s => s.get(key)); },
  putGlobal(key, val) { return tx('meta', 'readwrite', s => s.put(val, key)); },

  // wipe one game completely (used when a custom game is deleted)
  async clearGameData(id) {
    const pins = (await allPinsRaw()).filter(p => gameOfPin(p) === id);
    await tx('pins', 'readwrite', s => { for (const p of pins) s.delete(p.id); });
    const keys = (await allMetaKeys())
      .filter(k => !GLOBAL_KEYS.has(k) && gameOfKey(k) === id);
    await tx('meta', 'readwrite', s => { for (const k of keys) s.delete(k); });
  },
};
