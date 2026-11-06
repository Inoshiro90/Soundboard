/**
 * audio/engine/render-cache.js — Render-Cache für gerenderte Varianten (Phase 18c)
 *
 * Hält fertig gerenderte Varianten eines Sound-Slots (Quelle + Effektkette + Abspielparameter) im Speicher.
 * Gerendert wird ausschließlich über renderSlotOffline() aus renderPipeline.js, also über denselben Pipeline-Code
 * wie Live, Vorschau und Export (Invariante 2). Nicht persistiert, nur Laufzeit.
 * P18: kein Konsument. Erster Konsument ist P19e (Reverse-Hall, reverse-reverb.js).
 *
 * P19e (R3): Vertrag `untilStep` = Teil-Render bis VOR ein Modul (fx-pipeline.js prefixPlan): das Signal, das live am Eingang des Moduls
 * anliegt — ohne Fades, Lautstärke und Loop (die sitzen live hinter der Pipeline, B3). Optional `derive` = { tag, fn(prefixBuffer) }:
 * gespeichert wird dann nur das abgeleitete Ergebnis (z. B. das Wet-Signal des Reverse-Halls), nicht der Teil-Render selbst.
 * Schlüssel eines Teil-Renders: `${sourceKey}|${sampleRate}|${kanäle}|until|${Teil-Plan + Klangparameter}[|${tag}]`. Der Teil-Plan ersetzt
 * die Effekte (Module hinter dem Schnitt gehen nicht ein); Fades, Lautstärke und Loop gehen nicht ein (sie wirken nicht auf den Teil-Render).
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
import { resolvePlan, prefixPlan } from '../fx-pipeline.js';   // P19e
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

// ─── P19e: Teil-Render (untilStep) ────────────────────────────

/** Felder, die beim Teil-Render nicht wirken (live hinter der Pipeline) und deshalb weder gerendert noch in den Schlüssel gehen. */
export const PREFIX_OMIT_SOUND = ['vol', 'fade', 'playback', 'loop'];
export const PREFIX_OMIT_SLOT  = ['fadeIn', 'fadeOut', 'fadeInCurve', 'fadeOutCurve'];

/** Momentaufnahme für den Teil-Render: Fades, Lautstärke und Loop neutral (B3). */
function _prefixSnap(sound, slot) {
  const snapSound = JSON.parse(JSON.stringify({ ...sound, slots: undefined }));
  const snapSlot  = JSON.parse(JSON.stringify({ ...slot, data: undefined }));
  snapSound.vol = 1; snapSound.fade = false; snapSound.loop = false; delete snapSound.playback;
  snapSlot.fadeIn = 0; snapSlot.fadeOut = 0;
  return { snapSound, snapSlot };
}

/** Parameter eines Schritts ohne ausgeschaltete Module (`{ enabled: false, … }`); alles andere bleibt (AE-18). */
const _soundingParams = params => Object.fromEntries(Object.entries(params || {}).filter(([, v]) => !(v && typeof v === 'object' && v.enabled === false)));

/** Klangparameter eines Teil-Renders als stabiler Text: Teil-Plan statt Effekten, ohne Fades/Lautstärke/Loop. */
export function prefixParams(sound, slot, prefix) {
  return _stable({
    sound: _omit(sound, ['slots', 'curSlot', 'effects', ...PREFIX_OMIT_SOUND]),
    slot: _omit(slot, ['data', 'id', 'rev', ...PREFIX_OMIT_SLOT]),
    // Ausgeschaltete Module wirken nicht → ihre Werte gehen nicht ein (sonst änderten z. B. `amount`/`preRoll` des Halls selbst den Schlüssel).
    // Die Layer-Kennung geht nicht ein (gleicher Inhalt = gleicher Klang); Stufe und Reihenfolge schon.
    prefix: { until: prefix.until, tempo: prefix.tempo || null, steps: prefix.steps.map(st => ({ stage: st.stage, params: _soundingParams(st.params) })) }
  });
}

/** Schlüssel eines Teil-Renders oder null (Slot ohne Kennung). `tag` unterscheidet abgeleitete Ergebnisse. */
export function prefixVariantKey(sound, slot, untilStep, { sampleRate, channels = OFFLINE_RENDER_CHANNELS, tag = '' } = {}) {
  const sk = sourceKey(slot);
  if (!sk) return null;
  const prefix = prefixPlan(resolvePlan(asPipelineEffects(sound?.effects)), untilStep);
  return `${sk}|${sampleRate}|${channels}|until|${prefixParams(sound, slot, prefix)}${tag ? '|' + tag : ''}`;
}

/** Gemeinsamer Ablauf: Treffer → zurück; laufender Auftrag → teilen; sonst rendern und (falls gültig) speichern. */
function _cached(key, src, run) {
  const hit = getVariant(key);
  if (hit) return Promise.resolve(hit);
  if (key && _inflight.has(key)) return _inflight.get(key).promise;
  const job = { src, promise: null };
  job.promise = (async () => {
    try {
      const out = await run();
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
  let buffer = opts.buffer || bufferFor(sound, slotIdx);
  if (!buffer) buffer = await getOrDecodeBuffer(sound.id, slotIdx, slot.data, actx(), slot);
  if (!buffer) return null;
  return renderVariantFor(sound, slot, buffer, opts);
}

/**
 * P19e: wie renderVariant, aber mit Slot und dekodiertem Buffer statt Slot-Index (Aufrufer: renderPipeline.js, der Slot-Index ist dort
 * nicht bekannt, B1). Der Slot braucht kein `data`.
 * @param {{ sharedReverb?: boolean, untilStep?: {step:number, key:string}, derive?: { tag: string, fn: (AudioBuffer) => Promise<AudioBuffer|null> } }} [opts]
 *   untilStep: Teil-Render bis vor das Modul (s. Kopfkommentar). derive: nur mit untilStep; gespeichert wird das Ergebnis von fn.
 */
export async function renderVariantFor(sound, slot, buffer, opts = {}) {
  if (!slot || !buffer) return null;
  const channels = OFFLINE_RENDER_CHANNELS;
  const src = sourceKey(slot);
  if (opts.untilStep) {
    const { snapSound, snapSlot } = _prefixSnap(sound, slot);
    const tag = opts.derive?.tag || '';
    const key = prefixVariantKey(snapSound, snapSlot, opts.untilStep, { sampleRate: buffer.sampleRate, channels, tag });
    return _cached(key, src, async () => {
      const pre = await renderSlotOffline(snapSound, snapSlot, buffer, { channels, sharedReverb: false, untilStep: opts.untilStep });
      if (!pre || !opts.derive) return pre;
      return opts.derive.fn(pre);
    });
  }
  const sharedReverb = opts.sharedReverb ?? (APP.globalSettings?.reverbShare !== false);
  const key = variantKey(sound, slot, { sampleRate: buffer.sampleRate, channels, sharedReverb });
  // Momentaufnahme: Änderungen am Sound während des Renders dürfen das Ergebnis nicht unter dem alten Schlüssel ablegen.
  const snapSound = JSON.parse(JSON.stringify({ ...sound, slots: undefined }));
  const snapSlot  = JSON.parse(JSON.stringify({ ...slot, data: undefined }));
  return _cached(key, src, () => renderSlotOffline(snapSound, snapSlot, buffer, { channels, sharedReverb }));
}

/** P19e: Schlüssel, unter dem renderVariantFor(…, { untilStep, derive: { tag } }) speichert (gleiche Momentaufnahme), oder null. */
export function prefixKeyFor(sound, slot, sampleRate, untilStep, tag = '') {
  const { snapSound, snapSlot } = _prefixSnap(sound, slot);
  return prefixVariantKey(snapSound, snapSlot, untilStep, { sampleRate, tag });
}

/** P19e: gespeicherte Variante eines Teil-Renders ohne zu rendern (Live: nur Cache) oder null. */
export function peekPrefixVariant(sound, slot, sampleRate, untilStep, tag = '') {
  return getVariant(prefixKeyFor(sound, slot, sampleRate, untilStep, tag));
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
