/**
 * audio/engine/reverse-reverb.js — Wet-Signal des Reverse-Halls (Phase 19e)
 *
 * Erster Konsument des Render-Caches (P18c, AE-10). Für jedes klingende `reverb`-Modul im Modus `reverse` wird das Signal x am Eingang
 * des Moduls offline gerendert (Teil-Render `untilStep`, R3: derselbe Pipeline-Code wie Live/Vorschau/Export, ohne Fades/Lautstärke/Loop)
 * und daraus das Wet-Signal berechnet:
 *
 *     wet = reverse( conv( reverse(x), IR ) )        Länge L + M − 1   (L = Länge von x, M = Länge der IR)
 *
 * Die IR ist dieselbe wie beim Modus `room` (ir-data.js getGenericIR, geseedet → deterministisch), gefaltet mit einem ConvolverNode wie
 * live (Normalisierung wie dort: Altdaten Standard, neue Synthese `normalize = false`, ir-synth.js reverbNormalize). Im Ergebnis gehört der Hall zum Eingangssample n zu Index n + M − 1: Dort endet der Anstieg,
 * er beginnt bis zu M − 1 Samples davor. Das Modul (effect-graph.js `_buildReverseReverb`) spielt den Buffer so ab, dass dieser Punkt auf
 * den um `preRoll` verzögerten trockenen Einsatz fällt.
 *
 * Gespeichert wird nur das Wet-Signal (Render-Cache `derive`), unter dem Schlüssel des Teil-Renders + IR-Signatur. Eine neue Revision der
 * Quelle verwirft es wie jede Variante (Entscheidung B, 18c); geänderte Parameter vor dem Hall oder an der IR ergeben einen neuen Schlüssel.
 * `amount` und `preRoll` gehen NICHT ein (wirken live).
 *
 * Dieses Modul wird nur bei Bedarf dynamisch geladen (renderPipeline.js), Pläne ohne Reverse-Hall bleiben unberührt.
 *
 * P19e-2: Live und Vorschau (F4 = b: wie Live) nehmen nur, was schon im Cache liegt (`wait: false`); fehlt eine Variante, spielt der
 * Sound trocken (F2 = b) und die Variante wird im Hintergrund angefordert. Hintergrund-Render (F3 = a): nach dem Speichern des Sounds,
 * bei einem Fehlschlag beim Abspielen und nach dem App-Start (ab der ersten Nutzeraktion, vorher gibt es keinen AudioContext) für die
 * Sounds des aktiven Profils. Aufträge laufen nacheinander (höchstens einer gleichzeitig), doppelte Anforderungen werden zusammengefasst.
 * Slots ohne Kennung (`id`) werden nicht vorgerendert (ohne Kennung speichert der Cache nichts).
 */

import { renderVariantFor, peekPrefixVariant, prefixKeyFor } from './render-cache.js';
import { reverseTargets, resolvePlan } from '../fx-pipeline.js';
import { asPipelineEffects } from '../../fx-model.js';
import { CItems } from '../../core/state.js';
import { sourceKey, bufferFor } from './source-registry.js';
import { getOrDecodeBuffer } from '../../audioCache.js';
import { actx, hasAudioContext } from '../context.js';
import { reverbIRSig } from './registry.js';
import { getGenericIR } from '../ir-data.js';
import { reverbNormalize } from '../ir-synth.js';   // Nachbesserung 19a Teil 2
import { outputFor } from './output.js';   // einzige Ausgangsstelle (P4); im Offline-Context = destination

/** Kennung des abgeleiteten Ergebnisses im Render-Cache (Version der Berechnung). */
export const REVERSE_TAG = 'reverseWet1';

/** Wet-Buffer → IR-Länge in Samples (für den Startpunkt). Bleibt am Buffer-Objekt hängen, solange der Cache es hält. */
const _irSamples = new WeakMap();

const _tag = p => `${REVERSE_TAG}:${reverbIRSig(p)}`;

/** Kanäle eines Buffers in einen neuen Buffer des Contexts `ctx` umgekehrt kopieren. */
function _reversedCopy(ctx, buf) {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).slice().reverse());
  return out;
}

/**
 * Wet-Signal aus dem Teil-Render `x` (AudioBuffer) und den Hall-Parametern `p`: reverse(conv(reverse(x), IR)). Zwei Kanäle wie live
 * (die Hall-IR ist stereo). Rein offline.
 * @returns {Promise<AudioBuffer>}
 */
export async function renderReverseWet(x, p) {
  const sr = x.sampleRate;
  const probe = new OfflineAudioContext(2, 1, sr);
  const M = getGenericIR(probe, p).length;
  const off = new OfflineAudioContext(2, x.length + M - 1, sr);
  const src = off.createBufferSource();
  src.buffer = _reversedCopy(off, x);
  const conv = off.createConvolver();
  conv.normalize = reverbNormalize(p);   // Nachbesserung 19a Teil 2: wie live, vor `buffer`
  conv.buffer = getGenericIR(off, p);
  src.connect(conv); conv.connect(outputFor(off, 'export'));
  src.start(0);
  const y = await off.startRendering();
  for (let c = 0; c < y.numberOfChannels; c++) y.getChannelData(c).reverse();
  _irSamples.set(y, M);
  return y;
}

/** IR-Länge (Samples) eines Wet-Buffers aus renderReverseWet oder null. */
export const reverseIRSamples = buf => _irSamples.get(buf) ?? null;

/**
 * Varianten aller Reverse-Hall-Module eines Plans.
 * @param {object} plan   aufgelöster Plan (vor der Degradation)
 * @param {object} s      Sound (effects in beliebiger Form; der Plan wird daraus je Modul neu aufgelöst, s. render-cache.js)
 * @param {object} slot   Slot mit Kennung (`id`, `rev`); ohne Kennung wird gerendert, aber nicht gespeichert
 * @param {AudioBuffer} buffer  dekodiertes, ungetrimmtes Quellmaterial
 * @param {{ wait?: boolean }} [o]  wait: fehlende Varianten rendern und abwarten (Export); sonst nur, was im Cache liegt
 * @returns {Promise<Map<string, {buffer: AudioBuffer, irSamples: number, sig: string, key: string|null, stale: boolean, mods: Set}>>}
 *   layerId → Variante (fehlende fehlen). `out.missing` = Anzahl fehlender Varianten. `stale`/`mods` s. markStaleReverse().
 */
export async function reverseVariantsFor(plan, s, slot, buffer, { wait = false } = {}) {
  const out = new Map();
  out.missing = 0;
  for (const t of reverseTargets(plan)) {
    const p = plan.steps.find(st => st.index === t.step).params[t.key];
    const until = { step: t.step, key: t.key };
    let wet = null;
    try {
      wet = wait
        ? await renderVariantFor(s, slot, buffer, { untilStep: until, derive: { tag: _tag(p), fn: x => renderReverseWet(x, p) } })
        : peekPrefixVariant(s, slot, buffer.sampleRate, until, _tag(p));
    } catch (e) { console.warn('[audio] Reverse-Hall: Variante konnte nicht gerendert werden — nur trocken', e); }
    const irSamples = wet ? reverseIRSamples(wet) : null;
    if (wet && irSamples) out.set(t.layerId, { buffer: wet, irSamples, sig: reverbIRSig(p), key: prefixKeyFor(s, slot, buffer.sampleRate, until, _tag(p)), stale: false, mods: new Set() });
    else out.missing++;
  }
  return out;
}

/** Schlüssel der Variante je Reverse-Modul (layerId → Schlüssel) für einen Sound-Stand. */
function _keysFor(plan, s, slot, sampleRate) {
  const out = new Map();
  for (const t of reverseTargets(plan)) {
    const p = plan.steps.find(st => st.index === t.step).params[t.key];
    out.set(t.layerId, prefixKeyFor(s, slot, sampleRate, { step: t.step, key: t.key }, _tag(p)));
  }
  return out;
}

/**
 * P19e-2: Vorschau-Update (F4 = b). Passt eine laufende Variante nicht mehr zum neuen Stand (Module davor, IR, Trim …), verstummt ihr
 * Wet-Signal bis zum nächsten Start (`stale`); die Module der Variante (auch nach einem Neubau) übernehmen das sofort (geglättet).
 * @returns {number} Anzahl neu verstummter Varianten
 */
export function markStaleReverse(variants, plan, s, slot, sampleRate) {
  if (!(variants instanceof Map) || !variants.size) return 0;
  const now = _keysFor(plan, s, slot, sampleRate);
  let n = 0;
  for (const [layerId, v] of variants) {
    if (v.stale || now.get(layerId) === v.key) continue;
    v.stale = true; n++;
    for (const refresh of v.mods) { try { refresh(); } catch (e) { /* Modul bereits entsorgt */ } }
  }
  return n;
}

// ─── Hintergrund-Render (F3 = a) ──────────────────────────────

const _queue = [];
const _queued = new Set();
let _running = false;
/** Zähler für Tests und Diagnose. */
export const REVERSE_BG_STATS = { requested: 0, merged: 0, done: 0, failed: 0, skipped: 0 };

/** Hat der Sound mindestens ein klingendes Reverse-Hall-Modul? */
export function soundHasReverse(s) {
  try { return reverseTargets(resolvePlan(asPipelineEffects(s?.effects))).length > 0; } catch (e) { return false; }
}

const _later = fn => (typeof globalThis.requestIdleCallback === 'function' ? globalThis.requestIdleCallback(() => fn(), { timeout: 1000 }) : setTimeout(fn, 0));

async function _drain() {
  if (_running) return;
  _running = true;
  try {
    while (_queue.length) {
      const job = _queue.shift();
      _queued.delete(job.id);
      await new Promise(r => _later(r));   // Leerlauf abwarten: Wiedergabe und Bedienung haben Vorrang
      try {
        const plan = resolvePlan(asPipelineEffects(job.s.effects));   // Stand zum Zeitpunkt des Renders
        if (!reverseTargets(plan).length) { REVERSE_BG_STATS.skipped++; continue; }
        let buffer = job.buffer;
        if (!buffer && job.idx != null) buffer = bufferFor(job.s, job.idx);
        if (!buffer && job.idx != null && hasAudioContext() && job.slot?.data) buffer = await getOrDecodeBuffer(job.s.id, job.idx, job.slot.data, actx(), job.slot);
        if (!buffer) { REVERSE_BG_STATS.skipped++; continue; }
        await reverseVariantsFor(plan, job.s, job.slot, buffer, { wait: true });
        REVERSE_BG_STATS.done++;
      } catch (e) { REVERSE_BG_STATS.failed++; console.warn('[audio] Reverse-Hall: Hintergrund-Render fehlgeschlagen', e); }
    }
  } finally { _running = false; }
}

/**
 * Variante(n) eines Slots im Hintergrund rendern. `buffer` optional (sonst Laufzeit-Cache bzw. Dekodieren, nur mit AudioContext).
 * @returns {Promise<void>} erfüllt, wenn die Warteschlange leer ist (für Tests; Aufrufer warten sonst nicht)
 */
export function requestReverse(s, slot, { buffer = null, idx = null } = {}) {
  const sk = sourceKey(slot);
  if (!s || !sk) { REVERSE_BG_STATS.skipped++; return Promise.resolve(); }
  const id = `${s.id}|${sk}`;
  REVERSE_BG_STATS.requested++;
  if (_queued.has(id)) { REVERSE_BG_STATS.merged++; const j = _queue.find(q => q.id === id); if (j) { j.s = s; j.slot = slot; j.buffer = buffer || j.buffer; } }
  else { _queued.add(id); _queue.push({ id, s, slot, buffer, idx }); }
  return _drain();
}

/** Alle Slots eines Sounds mit Reverse-Hall vorrendern (nach dem Speichern). */
export function warmSound(s) {
  if (!soundHasReverse(s)) return Promise.resolve();
  return Promise.all((s.slots || []).map((slot, idx) => (slot?.data ? requestReverse(s, slot, { idx }) : null))).then(() => {});
}

/** Sounds des aktiven Profils mit Reverse-Hall vorrendern (nach dem App-Start, ab der ersten Nutzeraktion). */
export function warmActiveProfile() {
  const items = (CItems() || []).filter(x => x?.type === 'sound' && soundHasReverse(x));
  return Promise.all(items.map(warmSound)).then(() => {});
}
