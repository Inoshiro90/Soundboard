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

// ─── SLOT-REORDER NORMALIZATION (Bugfix: Slot-Reordering + IDB) ────
//
// IDB speichert Audio positionsbezogen ("soundId:slotIndex"). Die
// Sound-Editor-Arbeitskopie (APP.editSlots) kann aber per Drag-and-Drop
// umsortiert werden, OHNE dass sich dabei die physische IDB-Position
// der zugehörigen Audiodaten mitbewegt. Ohne diese Funktion bliebe nach
// einem Reorder + Speichern die Audiodatei unter dem ALTEN numerischen
// Index liegen, während die Slot-Metadaten (Name etc.) bereits die NEUE
// Reihenfolge zeigen → Slot X würde nach einem Reload plötzlich Slot Ys
// Audio abspielen.
//
// Jedes Slot-Objekt trägt während der Bearbeitung ein internes Feld
// `_idbSlot`: den Index, unter dem seine Audiodaten AKTUELL physisch in
// IDB liegen (gesetzt beim Laden aus einem bestehenden Sound bzw. beim
// Schreiben neuer/ersetzter Audiodaten). Da `_idbSlot` eine Eigenschaft
// des Objekts ist (nicht des Arrays), wandert es bei einem Drag-and-Drop
// automatisch mit dem Slot mit — dadurch lässt sich beim Speichern immer
// eindeutig bestimmen, ob und wohin Audiodaten in IDB verschoben werden
// müssen. `_idbSlot` wird vor dem Persistieren aus dem Slot entfernt
// (siehe events.js) und ist NICHT Teil des gespeicherten Datenmodells —
// das bestehende "soundId:slotIndex"-Schema bleibt unverändert.
//
// Ablauf (sicher auch bei Vertauschungen/Rotationen mehrerer Slots):
//   Phase 1: ALLE benötigten Quell-Audiodaten zuerst lesen (bevor
//            irgendetwas geschrieben wird) — verhindert, dass ein noch
//            benötigter alter Eintrag durch einen anderen Move
//            überschrieben wird, bevor er gelesen wurde.
//   Phase 2: Alle Zielpositionen schreiben.
//   Phase 3: Verwaiste alte Positionen (die keinem finalen Slot mehr
//            entsprechen) aufräumen, begrenzt auf den bekannten
//            ehemaligen Wertebereich (kein unbegrenzter DB-Scan nötig).
//
/**
 * @param {string} soundId
 * @param {Array}  slots            — finale Slot-Reihenfolge (APP.editSlots-artig),
 *                                    jedes Element optional mit `_idbSlot`.
 * @param {number} [previousSlotCount=0] — Anzahl Slots, die der Sound VOR
 *                                    dieser Bearbeitung persistiert hatte
 *                                    (0 bei einem neuen Sound), für die
 *                                    Aufräum-Grenze in Phase 3.
 */
export async function normalizeSlotAudioStorage(soundId, slots, previousSlotCount = 0) {
  const finalCount = slots.length;

  // Phase 1 + 2: nur Slots verschieben, deren Audio aktuell NICHT bereits
  // an ihrer finalen Position liegt.
  const moves = [];
  slots.forEach((sl, to) => {
    const from = sl?._idbSlot;
    if (from === undefined || from === null) return; // keine persistierten Audiodaten für diesen Slot
    if (from !== to) moves.push({ from, to });
  });

  if (moves.length) {
    const cache = new Map();
    for (const { from } of moves) {
      if (!cache.has(from)) cache.set(from, await idbGet(audioKey(soundId, from)));
    }
    for (const { from, to } of moves) {
      const data = cache.get(from);
      if (data != null) await idbSet(audioKey(soundId, to), data);
    }
  }

  // Phase 3: verwaiste alte Positionen aufräumen (z.B. entfernte Slots,
  // oder Positionen, die durch einen Move freigezogen wurden und von
  // keinem finalen Slot mehr referenziert werden).
  let maxOld = previousSlotCount;
  slots.forEach(sl => {
    const from = sl?._idbSlot;
    if (typeof from === 'number' && from + 1 > maxOld) maxOld = from + 1;
  });
  for (let k = finalCount; k < maxOld; k++) {
    await idbDelete(audioKey(soundId, k));
  }
}
