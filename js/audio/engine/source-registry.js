/**
 * audio/engine/source-registry.js — Quellen-Identität (Phase 18b)
 *
 * Einzige Stelle, die weiß, unter welchem Schlüssel der dekodierte Buffer einer Audioquelle liegt.
 *
 * Schlüssel im Laufzeit-Cache (APP.audioBuffers):
 *   - Sound-Slot mit Kennung:  `${slot.id}@${rev}`  (sourceKey; rev fehlt = 0)
 *   - ohne Kennung (Altbestand, Ambient-Datei, Testdaten): `${ownerId}_${idx}` (positionKey, Format des früheren bk())
 *   Ambient-Dateien bleiben bewusst beim Positionsschlüssel (file.id, 0): file.id ist dort bereits stabil (Plan P18 Nr. 2).
 *   Musik (track.id) läuft über Blob-URL/<audio>, nicht über diesen Cache (E2).
 *
 * IndexedDB bleibt positionsbezogen (`soundId:slotIdx`, audioKey in db.js); Format und Verschiebelogik
 * (normalizeSlotAudioStorage, _idbSlot) sind unverändert. idbKeyFor() ist nur die benannte Brücke dorthin.
 *
 * Revision (slot.rev): steigt, wenn sich der Audioinhalt ändert (destruktive Bearbeitung, Undo/Redo, Ersetzen der Datei).
 * Trim ändert die Revision nicht (E3). Eine neue Revision ergibt einen neuen Schlüssel; bumpRev() entfernt den alten Eintrag.
 *
 * Ausgemusterte Quellen (P18c): Wird ein Schlüssel `id@rev` ungültig (bumpRev, Speichern ohne diesen Schlüssel), meldet die
 * Registry ihn an angemeldete Abnehmer (onSourceRetired). render-cache.js meldet sich beim Laden an und verwirft die Varianten
 * sofort (Entscheidung B). Bewusst als Abnehmerliste statt Import: kein Import-Zyklus, und die Registry lädt die Render-Pipeline
 * nicht mit.
 *
 * Entwurfspuffer des Editors (früher APP.audioBuffers['_ed_N'], positionsbezogen): hängen jetzt am Slot-OBJEKT der
 * Arbeitskopie (WeakMap). Umordnen, Entfernen und verspätet fertige Bulk-Imports brauchen damit keinen Abgleich mehr.
 */

import { APP } from '../../core/state.js';
import { audioKey } from '../../db.js';

// ─── Schlüssel ────────────────────────────────────────────────

/** Gültige Revision einer Quelle: ganze Zahl > 0, sonst 0 (wie normalizeSourceRev in storage/normalization.js). */
export function sourceRev(entity) {
  const r = entity?.rev;
  return Number.isInteger(r) && r > 0 ? r : 0;
}

/** `id@rev` oder null, wenn die Quelle (noch) keine Kennung hat. */
export function sourceKey(entity) {
  return entity?.id ? `${entity.id}@${sourceRev(entity)}` : null;
}

/** Positionsschlüssel (Format des früheren bk()): Rückfall für Quellen ohne Kennung und für Ambient-Dateien. */
export function positionKey(ownerId, idx) {
  return `${ownerId}_${idx}`;
}

/** Cache-Schlüssel eines Sound-Slots: Kennung vor Position. */
export function slotCacheKey(ownerId, idx, slot = null) {
  return sourceKey(slot) ?? positionKey(ownerId, idx);
}

/** Cache-Schlüssel einer Ambient-Dateivariante (file.id, fester Index 0). */
export function ambientFileCacheKey(fileId) {
  return positionKey(fileId, 0);
}

/** IndexedDB-Schlüssel (unverändert positionsbezogen, s. db.js). */
export function idbKeyFor(ownerId, idx) {
  return audioKey(ownerId, idx);
}

// ─── Ausgemusterte Quellen (P18c) ─────────────────────────────

const _retiredListeners = new Set();

/** Abnehmer für ungültig gewordene Quellschlüssel (`id@rev`) anmelden. Gibt eine Abmeldefunktion zurück. */
export function onSourceRetired(fn) {
  if (typeof fn !== 'function') return () => {};
  _retiredListeners.add(fn);
  return () => _retiredListeners.delete(fn);
}

function _retire(key) {
  if (!key) return;
  for (const fn of _retiredListeners) { try { fn(key); } catch (e) { console.warn('[source-registry] onSourceRetired:', e); } }
}

// ─── Laufzeit-Cache ───────────────────────────────────────────

export function cachedBuffer(key) { return (key && APP.audioBuffers[key]) || null; }
export function setCachedBuffer(key, buf) { if (key && buf) APP.audioBuffers[key] = buf; }
export function dropCachedBuffer(key) { if (key) delete APP.audioBuffers[key]; }

/** Gecachter Buffer für Slot `idx` eines Sounds (synchron, ohne Dekodieren; Dekodieren: audioCache.getOrDecodeBuffer). */
export function bufferFor(sound, idx) {
  return cachedBuffer(slotCacheKey(sound?.id, idx, sound?.slots?.[idx]));
}

// ─── Slot-Verweise (E1: Timeline-Clips, Undo-Einträge) ────────

/** Sound über alle Profile (nicht nur das aktive). */
export function findSoundById(soundId) {
  for (const prof of APP.profiles || []) {
    const s = (prof.items || []).find(x => x.id === soundId && x.type === 'sound');
    if (s) return s;
  }
  return null;
}

/**
 * Aktueller Index eines Slot-Verweises. Mit Kennung: Position dieser Kennung (−1, wenn der Slot nicht mehr existiert).
 * Ohne Kennung (ältere Einträge): Rückfall auf den gespeicherten Index.
 */
export function resolveSlotIndex(sound, slotId, slotIdx) {
  const slots = sound?.slots || [];
  if (slotId) return slots.findIndex(sl => sl?.id === slotId);
  const i = Number.isInteger(slotIdx) ? slotIdx : 0;
  return i >= 0 && i < slots.length ? i : -1;
}

/** Gecachter Buffer für einen Verweis (soundId, slotId, slotIdx). */
export function bufferForRef(soundId, slotId, slotIdx) {
  const sound = findSoundById(soundId);
  if (!sound) return cachedBuffer(positionKey(soundId, slotIdx ?? 0));   // Sound unbekannt: früheres Verhalten
  const idx = resolveSlotIndex(sound, slotId, slotIdx);
  return idx < 0 ? null : bufferFor(sound, idx);
}

// ─── Revision ─────────────────────────────────────────────────

/** Revision +1 (Audioinhalt geändert). Entfernt den Cache-Eintrag der alten Revision. Gibt die neue Revision zurück. */
export function bumpRev(slot) {
  if (!slot) return 0;
  const old = sourceKey(slot);
  dropCachedBuffer(old);
  _retire(old);   // P18c: abgeleitete Varianten der alten Revision sofort verwerfen
  slot.rev = sourceRev(slot) + 1;
  return slot.rev;
}

/**
 * Ersetzen der Datei eines Slots: das neue Slot-Objekt übernimmt die Kennung des alten, Revision +1.
 * Ohne Kennung am alten Slot bleibt das neue Objekt ohne (Kennung vergibt der Speicherpfad, P18a).
 */
export function inheritIdentity(next, prev) {
  if (next && prev?.id) { next.id = prev.id; next.rev = sourceRev(prev) + 1; }
  return next;
}

// ─── Speichern eines Sounds ───────────────────────────────────

/**
 * Laufzeit-Cache nach dem Speichern eines Sounds abgleichen (statt ihn für den Sound komplett zu leeren).
 *   - Slot mit unveränderter Kennung UND Revision: Eintrag bleibt (Umordnen ändert den Schlüssel nicht).
 *   - Schlüssel, die nach dem Speichern nicht mehr vorkommen (entfernter Slot, alte Revision): Eintrag entfällt,
 *     abgeleitete Varianten im Render-Cache ebenso (P18c, onSourceRetired).
 *   - Neue Schlüssel (neuer Slot, neue Revision): ein evtl. vorhandener älterer Eintrag wird verworfen.
 *   - Liegt für den Slot ein Entwurfspuffer vor, wird er unter dem neuen Schlüssel abgelegt.
 * @param {string} soundId
 * @param {Array} oldSlots    Slots vor dem Speichern (leer bei neuem Sound)
 * @param {Array} newSlots    gespeicherte Slots
 * @param {Array} draftSlots  Arbeitskopie (APP.editSlots), gleicher Index wie newSlots
 */
export function syncLiveCacheAfterSave(soundId, oldSlots, newSlots, draftSlots = []) {
  const oldKeys = new Set((oldSlots || []).map((sl, i) => slotCacheKey(soundId, i, sl)));
  const newKeys = new Set((newSlots || []).map((sl, i) => slotCacheKey(soundId, i, sl)));
  oldKeys.forEach(k => { if (!newKeys.has(k)) { dropCachedBuffer(k); _retire(k); } });   // P18c: auch Varianten
  (newSlots || []).forEach((sl, i) => {
    const k = slotCacheKey(soundId, i, sl);
    if (!oldKeys.has(k)) dropCachedBuffer(k);
    setCachedBuffer(k, draftBuffer(draftSlots?.[i]));
  });
}

// ─── Entwurfspuffer (Editor-Arbeitskopie APP.editSlots) ───────

let _drafts = new WeakMap();

export function draftBuffer(slot) { return (slot && typeof slot === 'object' && _drafts.get(slot)) || null; }
export function setDraftBuffer(slot, buf) { if (slot && typeof slot === 'object' && buf) _drafts.set(slot, buf); }
export function dropDraftBuffer(slot) { if (slot && typeof slot === 'object') _drafts.delete(slot); }
/** Alle Entwurfspuffer verwerfen (Öffnen eines Editors). */
export function clearDraftBuffers() { _drafts = new WeakMap(); }
