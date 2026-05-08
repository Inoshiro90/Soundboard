/**
 * db.js — IndexedDB wrapper (Phase 3)
 *
 * Stores audio blobs (base64 strings) separately from the profile state.
 * Key schema: "audio:{soundId}:{slotIndex}"
 *
 * Migration from localStorage:
 *   - On first open, scans all slots for slot.data that look like base64/data-URI
 *   - Writes them to IDB, sets slot.data = 'idb' (sentinel)
 *   - Saves updated profiles to localStorage without the big audio strings
 *
 * Falls back to in-memory Map if IDB is unavailable (private browsing, etc.)
 */

const DB_NAME    = 'SoundboardPro';
const DB_VERSION = 1;
const STORE      = 'audio';

let _db    = null;
let _ready = false;
const _mem = new Map(); // fallback when IDB is blocked

// ─── OPEN ────────────────────────────────────────────────────

export function openDB() {
  return new Promise((resolve, reject) => {
    if (_ready) { resolve(_db); return; }

    if (!('indexedDB' in window)) { _ready = true; resolve(null); return; }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };

    req.onsuccess = e => {
      _db    = e.target.result;
      _ready = true;
      resolve(_db);
    };

    req.onerror = () => {
      console.warn('IDB unavailable — using in-memory fallback');
      _ready = true;
      resolve(null);
    };

    req.onblocked = () => {
      console.warn('IDB blocked — using in-memory fallback');
      _ready = true;
      resolve(null);
    };
  });
}

// ─── CRUD ────────────────────────────────────────────────────

export async function idbGet(key) {
  const db = await openDB();
  if (!db) return _mem.get(key) ?? null;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => resolve(null);
  });
}

export async function idbSet(key, value) {
  const db = await openDB();
  if (!db) { _mem.set(key, value); return; }
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => resolve(); // non-fatal
  });
}

export async function idbDelete(key) {
  const db = await openDB();
  if (!db) { _mem.delete(key); return; }
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = resolve;
  });
}

export async function idbGetAll() {
  const db = await openDB();
  if (!db) return Object.fromEntries(_mem);
  return new Promise(resolve => {
    const result = {};
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = e => {
      const cur = e.target.result;
      if (cur) { result[cur.key] = cur.value; cur.continue(); }
      else resolve(result);
    };
    req.onerror = () => resolve(result);
  });
}

// ─── AUDIO KEY HELPER ─────────────────────────────────────────

/** Same format as bk() in utils.js */
export function audioKey(soundId, slotIdx) {
  return `${soundId}:${slotIdx}`;
}

// ─── SENTINEL ────────────────────────────────────────────────

/** slot.data value that indicates "audio is in IDB, not inline" */
export const IDB_SENTINEL = 'idb';

/** Returns true if slot.data is the IDB sentinel (new format) */
export function isIdbRef(data) {
  return data === IDB_SENTINEL;
}

/** Returns true if slot.data looks like base64 / data-URI (old format) */
export function isBase64Data(data) {
  if (!data || typeof data !== 'string') return false;
  if (data === IDB_SENTINEL) return false;
  // Base64 strings are long; data URIs start with "data:"
  return data.length > 100;
}

// ─── MIGRATION ───────────────────────────────────────────────

/**
 * Migrates all inline base64 audio from profiles into IDB.
 * Called once on app start after profiles are loaded.
 * Modifies profiles in-place; caller must call save() afterwards.
 *
 * @param {object[]} profiles  APP.profiles
 * @returns {number}           Number of slots migrated
 */
export async function migrateAudioToIdb(profiles) {
  await openDB();
  let count = 0;

  for (const prof of profiles) {
    for (const item of (prof.items || [])) {
      if (item.type !== 'sound') continue;
      for (let i = 0; i < (item.slots || []).length; i++) {
        const sl = item.slots[i];
        if (!sl || !isBase64Data(sl.data)) continue;
        const key = audioKey(item.id, i);
        await idbSet(key, sl.data);
        sl.data = IDB_SENTINEL; // replace inline data with sentinel
        count++;
      }
    }
  }

  return count;
}

// ─── LOAD AUDIO FOR DECODING ──────────────────────────────────

/**
 * Retrieves base64 audio from IDB for a given slot.
 * Returns null if not found.
 */
export async function getSlotAudio(soundId, slotIdx) {
  const key = audioKey(soundId, slotIdx);
  return await idbGet(key);
}

/**
 * Saves base64 audio to IDB for a given slot.
 * Also updates slot.data sentinel in-place.
 */
export async function setSlotAudio(soundId, slotIdx, base64, slot) {
  const key = audioKey(soundId, slotIdx);
  await idbSet(key, base64);
  if (slot) slot.data = IDB_SENTINEL;
}

/**
 * Deletes audio from IDB for a given slot.
 */
export async function deleteSlotAudio(soundId, slotIdx) {
  await idbDelete(audioKey(soundId, slotIdx));
}
