/**
 * audio/engine/render-cache.js — Render-Cache für gerenderte Varianten (Phase 18c)
 *
 * Hält fertig gerenderte Varianten eines Sound-Slots (Quelle + Effektkette + Abspielparameter) im Speicher.
 * Gerendert wird ausschließlich über renderSlotOffline() aus renderPipeline.js, also über denselben Pipeline-Code
 * wie Live, Vorschau und Export (Invariante 2). Nicht persistiert, nur Laufzeit.
 * P18: kein Konsument. Erster Konsument ist P19; bis dahin ändert dieses Modul nichts am Klang.
 *
 * Variantenschlüssel: `${sourceKey}|${sampleRate}|${kanäle}|${geteilterHall}|${Klangparameter}`
 *   - sourceKey = `slot.id@rev` (source-registry.js). Ohne Kennung wird gerendert, aber nicht gespeichert
 *     (ein Positionsschlüssel wäre nach Umordnen falsch).
 *   - Klangparameter = stabile JSON-Form (Schlüssel sortiert) aus
 *       Sound ohne `slots` und `curSlot`  (u. a. effects in Pipeline-Form, pitch, vol, loop, fade, playback)
 *       Slot  ohne `data`, `id`, `rev`    (u. a. trimStart/trimEnd, fadeIn/fadeOut)
 *     Bewusst großzügig: unbekannte Felder gehen mit ein (AE-18). Ein Feld zu viel kostet höchstens einen Fehlschlag,
 *     ein Feld zu wenig ergäbe einen falschen Treffer. Trim geht nur hier ein, nicht in die Revision (E3).
 *   - Der volle Text dient als Schlüssel (kein Kurz-Hash, also keine Kollisionen).
 *
 * Revision: Eine neue Revision ergibt einen neuen Schlüssel. Zusätzlich verwirft dieses Modul die Varianten eines
 * ausgemusterten Schlüssels sofort (Entscheidung B, 18c): Anmeldung bei source-registry.js onSourceRetired() beim Laden;
 * die Registry meldet bumpRev() und beim Speichern weggefallene Schlüssel. Positionsschlüssel kommen nie vor (s. oben).
 *
 * Speicher: LRU mit Byte-Deckel (Länge × Kanäle × 4 Byte). Deckel ≈ 64 MB Desktop, ≈ 24 MB Mobil.
 * Eine einzelne Variante über dem Deckel wird gerendert und zurückgegeben, aber nicht gespeichert.
 */

import { APP } from '../../core/state.js';
import { sourceKey, bufferFor, onSourceRetired } from './source-registry.js';
import { getOrDecodeBuffer } from '../../audioCache.js';
import { renderSlotOffline, OFFLINE_RENDER_CHANNELS } from '../../renderPipeline.js';
import { asPipelineEffects } from '../../fx-model.js';
import { actx } from '../context.js';

const MB = 1024 * 1024;
export const VARIANT_CAP_DESKTOP = 64 * MB;
export const VARIANT_CAP_MOBILE  = 24 * MB;

/** Mobilgerät? userAgentData.mobile, sonst grober Zeiger (Touch als Hauptbedienung). Ohne Browser-Umgebung: nein. */
function _isMobile() {
  try {
    const m = globalThis.navigator?.userAgentData?.mobile;
    if (typeof m === 'boolean') return m;
    return !!globalThis.matchMedia?.('(pointer: coarse)').matches;
  } catch { return false; }
}

let _cap = null;   // null = automatisch (Desktop/Mobil)
/** Aktiver Deckel in Byte. */
export function variantCap() { return _cap ?? (_isMobile() ? VARIANT_CAP_MOBILE : VARIANT_CAP_DESKTOP); }
/** Deckel festlegen (Byte); null = wieder automatisch. Verdrängt sofort bis unter den neuen Deckel. */
export function setVariantCap(bytes) {
  _cap = Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  _evict();
}

// ─── Speicher ─────────────────────────────────────────────────

/** key → { src, buf, bytes }. Einfügereihenfolge der Map = LRU-Reihenfolge (ältester zuerst). */
const _entries = new Map();
/** key → { src, promise } laufender Renders (gleichzeitige Anfragen teilen sich ein Promise). */
const _inflight = new Map();
let _bytes = 0, _hits = 0, _misses = 0, _evictions = 0;

const _sizeOf = buf => buf.length * buf.numberOfChannels * 4;

function _remove(key) {
  const e = _entries.get(key); if (!e) return;
  _entries.delete(key); _bytes -= e.bytes;
}

function _evict() {
  const cap = variantCap();
  for (const key of _entries.keys()) {
    if (_bytes <= cap) break;
    _remove(key); _evictions++;
  }
}

function _store(key, src, buf) {
  const bytes = _sizeOf(buf);
  if (bytes > variantCap()) return;          // einzeln zu groß: nicht speichern
  _remove(key);
  _entries.set(key, { src, buf, bytes }); _bytes += bytes;
  _evict();
}

// ─── Schlüssel ────────────────────────────────────────────────

/** JSON mit sortierten Objektschlüsseln (gleicher Inhalt = gleicher Text, unabhängig von der Reihenfolge). */
function _stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(_stable).join(',')}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${_stable(v[k])}`).join(',')}}`;
}

const _omit = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !keys.includes(k)));

/** Klangparameter einer Variante als stabiler Text (s. Kopfkommentar). */
export function variantParams(sound, slot) {
  const s = _omit(sound, ['slots', 'curSlot']);
  s.effects = asPipelineEffects(sound?.effects);   // Pipeline-Form, wie sie gerendert wird
  return _stable({ sound: s, slot: _omit(slot, ['data', 'id', 'rev']) });
}

/** Variantenschlüssel oder null (Slot ohne Kennung). */
export function variantKey(sound, slot, { sampleRate, channels = OFFLINE_RENDER_CHANNELS, sharedReverb = true } = {}) {
  const sk = sourceKey(slot);
  if (!sk) return null;
  return `${sk}|${sampleRate}|${channels}|${sharedReverb ? 1 : 0}|${variantParams(sound, slot)}`;
}

// ─── Öffentliche Schnittstelle ────────────────────────────────

/** Gespeicherte Variante oder null (zählt als Treffer bzw. Fehlschlag und frischt die LRU-Position auf). */
export function getVariant(key) {
  const e = key ? _entries.get(key) : null;
  if (!e) { _misses++; return null; }
  _entries.delete(key); _entries.set(key, e);   // ans Ende = zuletzt benutzt
  _hits++;
  return e.buf;
}

/**
 * Gerenderte Variante eines Slots (aus dem Cache oder frisch gerendert).
 * @param {object} sound
 * @param {number} slotIdx
 * @param {{ buffer?: AudioBuffer, sharedReverb?: boolean }} [opts]
 *   buffer: dekodiertes Quellmaterial (sonst Laufzeit-Cache bzw. Dekodieren über audioCache)
 *   sharedReverb: Standard wie der Einzel-Export (globale Einstellung reverbShare)
 * @returns {Promise<AudioBuffer|null>}
 */
export async function renderVariant(sound, slotIdx, opts = {}) {
  const slot = sound?.slots?.[slotIdx];
  if (!slot || !slot.data) return null;
  const sharedReverb = opts.sharedReverb ?? (APP.globalSettings?.reverbShare !== false);
  const channels = OFFLINE_RENDER_CHANNELS;

  let buffer = opts.buffer || bufferFor(sound, slotIdx);
  if (!buffer) buffer = await getOrDecodeBuffer(sound.id, slotIdx, slot.data, actx(), slot);
  if (!buffer) return null;

  const key = variantKey(sound, slot, { sampleRate: buffer.sampleRate, channels, sharedReverb });
  const hit = getVariant(key);
  if (hit) return hit;
  if (key && _inflight.has(key)) return _inflight.get(key).promise;

  // Momentaufnahme: Änderungen am Sound während des Renders dürfen das Ergebnis nicht unter dem alten Schlüssel ablegen.
  const snapSound = JSON.parse(JSON.stringify({ ...sound, slots: undefined }));
  const snapSlot  = JSON.parse(JSON.stringify({ ...slot, data: undefined }));
  const job = { src: sourceKey(slot), promise: null };
  job.promise = (async () => {
    try {
      const out = await renderSlotOffline(snapSound, snapSlot, buffer, { channels, sharedReverb });
      // Nur speichern, wenn der Auftrag noch gültig ist (nicht durch dropVariantsFor/clearVariants abgeräumt).
      if (out && key && _inflight.get(key) === job) _store(key, job.src, out);
      return out;
    } finally {
      if (key && _inflight.get(key) === job) _inflight.delete(key);
    }
  })();
  if (key) _inflight.set(key, job);
  return job.promise;
}

/** Alle Varianten einer Quelle (`id@rev`) verwerfen, auch laufende Renders (deren Ergebnis wird nicht gespeichert). */
export function dropVariantsFor(srcKey) {
  if (!srcKey) return;
  for (const [k, e] of [..._entries]) if (e.src === srcKey) _remove(k);
  for (const [k, j] of [..._inflight]) if (j.src === srcKey) _inflight.delete(k);
}

// Entscheidung B (18c): ausgemusterte Quellen sofort abräumen.
onSourceRetired(dropVariantsFor);

/** Gesamten Render-Cache leeren (Zähler bleiben). */
export function clearVariants() {
  _entries.clear(); _inflight.clear(); _bytes = 0;
}

/** Zustand für Tests und Diagnose. */
export function variantStats() {
  return { entries: _entries.size, bytes: _bytes, cap: variantCap(), inflight: _inflight.size, hits: _hits, misses: _misses, evictions: _evictions };
}
