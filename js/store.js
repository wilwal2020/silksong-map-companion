// IndexedDB persistence: pins (with their screenshot blobs) + meta
// (fog mask blob, view state).

const DB_NAME = 'silksong-map-companion';
const DB_VERSION = 1;

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

export const store = {
  async getAllPins() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('pins').objectStore('pins').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
  putPin(pin) { return tx('pins', 'readwrite', s => s.put(pin)); },
  deletePin(id) { return tx('pins', 'readwrite', s => s.delete(id)); },
  clearPins() { return tx('pins', 'readwrite', s => s.clear()); },

  async getMeta(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('meta').objectStore('meta').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  putMeta(key, val) { return tx('meta', 'readwrite', s => s.put(val, key)); },
  clearMeta() { return tx('meta', 'readwrite', s => s.clear()); },
};
