/**
 * audioCache.js — Zentraler Audio Buffer Cache (Phase 5 Bugfix)
 *
 * Problem: APP.audioBuffers[key] wird direkt überall zugegriffen —
 *   - keine Fehlerbehandlung
 *   - kein IDB-Fallback
 *   - doppeltes Decoding möglich
 *   - AudioContext vor User-Gesture
 *
 * Lösung: getOrDecodeBuffer() als einzige öffentliche Schnittstelle.
 *
 * Decode-Garantien:
 *   1. Nie doppelt dekodieren (pending-Map verhindert Race Conditions)
 *   2. Immer .slice(0) vor decodeAudioData
 *   3. IDB-Fallback für Sentinel-Slots
 *   4. Fehler werden geloggt und null zurückgegeben (kein throw)
 */

import { APP }   from './state.js';
import { bk }    from './utils.js';
import { idbGet, audioKey, IDB_SENTINEL } from './db.js';

/** In-flight decode promises: key → Promise<AudioBuffer|null> */
const _pending = new Map();

/**
 * Returns an AudioBuffer for a given sound/slot, decoding if necessary.
 *
 * @param {string}     soundId
 * @param {number}     slotIdx
 * @param {string}     slotData  — slot.data (base64, 'idb', or null)
 * @param {AudioContext} ctx     — must be provided (not auto-created here)
 * @returns {Promise<AudioBuffer|null>}
 */
export async function getOrDecodeBuffer(soundId, slotIdx, slotData, ctx) {
  const key = bk(soundId, slotIdx);

  // 1. Already in cache
  const cached = APP.audioBuffers[key];
  if (cached) return cached;

  // 2. Already decoding — wait for the same promise
  if (_pending.has(key)) return _pending.get(key);

  // 3. No data available
  if (!slotData || !ctx) return null;

  // 4. Start decode
  const promise = _decode(key, soundId, slotIdx, slotData, ctx);
  _pending.set(key, promise);

  try {
    const buf = await promise;
    return buf;
  } finally {
    _pending.delete(key);
  }
}

async function _decode(key, soundId, slotIdx, slotData, ctx) {
  try {
    // Resolve base64 string: either inline or from IDB
    let b64 = slotData;

    if (slotData === IDB_SENTINEL || slotData === 'idb') {
      b64 = await idbGet(audioKey(soundId, slotIdx));
      if (!b64) {
        console.warn(`[audioCache] IDB miss: ${key}`);
        return null;
      }
    }

    if (!b64 || typeof b64 !== 'string' || b64.length < 10) return null;

    // base64 → ArrayBuffer
    const binary = atob(b64);
    const arr    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);

    // Always use .slice(0) to avoid detached-buffer errors
    const decoded = await ctx.decodeAudioData(arr.buffer.slice(0));
    APP.audioBuffers[key] = decoded;
    return decoded;

  } catch (err) {
    console.error(`[audioCache] Decode failed for ${key}:`, err.message || err);
    return null;
  }
}

/**
 * Pre-warm cache for all slots of a sound.
 * Skips slots that are already cached or have no data.
 * Non-blocking — returns immediately.
 */
export function prewarmSound(sound, ctx) {
  if (!ctx || !sound?.slots) return;
  sound.slots.forEach((sl, i) => {
    if (!sl?.data) return;
    const key = bk(sound.id, i);
    if (APP.audioBuffers[key]) return;
    getOrDecodeBuffer(sound.id, i, sl.data, ctx).catch(() => {});
  });
}

/**
 * Drop a specific buffer from cache (e.g. after destructive edit).
 */
export function invalidateBuffer(soundId, slotIdx) {
  delete APP.audioBuffers[bk(soundId, slotIdx)];
}

/**
 * Clear entire cache. Use on reset.
 */
export function clearBufferCache() {
  Object.keys(APP.audioBuffers).forEach(k => delete APP.audioBuffers[k]);
}
