/**
 * audio/fx-pipeline.js — Vier-Stufen-Audio-Pipeline (Quelle → Medium → Umgebung → Hörer)
 *
 * ZENTRALE INVARIANTE
 *   Die vom Benutzer definierte Reihenfolge der Layer ist die verbindliche Reihenfolge der Audioverarbeitung.
 *   Das Ergebnis jedes Layers ist die Eingabe des unmittelbar folgenden Layers.
 *   Es gibt bewusst KEINE Optimierung, die Layer zusammenfasst, umordnet, überspringt oder verschmilzt
 *   (insbesondere kein Pitch-Coalescing, kein Zusammenführen von Presets).
 *
 * Datenmodell (effects.v === 2), eine Instanz je Sound / Ambient-Track / Musik-Track:
 *   {
 *     v: 2, enabled: bool,                       // Master: false → Originalaudio (Pipeline entfällt)
 *     stages: {
 *       source | medium | environment | listener: {
 *         enabled: bool,                         // Stufe an/aus — deaktiviert wird sie nur aus der Kette entfernt
 *         layers: [{ id, presetId|null, enabled, params, stageAuto? }]   // Array-Reihenfolge = Verarbeitungsreihenfolge
 *       }
 *     },
 *     legacy?:  { preset }                                      // Herkunft bei migrierten v1-Daten (nur Diagnose)
 *   }
 *   Das Modell enthält ausschließlich die vier Stufen. Hüllkurve (Envelope), Pan/Ausgang und Analyzer sind
 *   KEINE Bestandteile mehr; alte Werte werden beim Laden verworfen (normalizePipelineStructure ist wiederholbar).
 *   Layer-Typen: presetId !== null → Preset-Layer (params = Snapshot, ggf. angepasst);
 *                presetId === null → manueller Layer (eigene Einstellungen). Ein Preset darf beliebig oft
 *                vorkommen: Identität eines Layers ist seine `id`, nicht seine `presetId`.
 *
 * Dieses Modul ist bis auf buildPipelineGraph()/connectPipeline() rein (kein AudioContext) und in Node testbar.
 */

import { uid } from '../utils.js';
import { defaultEffects } from './effect-graph.js';
import { ensurePitchWorkletFor } from './context.js';
import { PipelineRuntime } from './engine/runtime.js';
import { MODULE_KEYS, MODULES, REMOVED_KEYS, moduleTail } from './engine/registry.js';
import { describeSend } from './engine/reverb-hub.js';
import {
  fillLayerParams, sparsifyParams, splitLayerParams, effectiveActiveKeys, stageScores, addToBag, cleanX, inheritX, isUnsafeKey, readRev
} from './engine/schema.js';

export { fillLayerParams, sparsifyParams };

export const PIPELINE_VERSION = 2;

/** Reihenfolge der inhaltlichen Stufen. */
export const STAGE_ORDER = ['source', 'medium', 'environment', 'listener'];

export const PIPELINE_STAGES = {
  source:      { label: 'Quelle',    icon: 'speech', order: 1, hint: 'Klangcharakter der Schallquelle (z. B. Monster, Besessenheit)' },
  medium:      { label: 'Medium',    icon: 'speaker', order: 2, hint: 'Übertragungsweg zwischen Quelle und Hörer (z. B. Gegensprechanlage, Panzertür)' },
  environment: { label: 'Umgebung',  icon: 'landmark', order: 3, hint: 'Akustischer Raum (z. B. Höhle, Tunnel)' },
  listener:    { label: 'Hörer',     icon: 'ear', order: 4, hint: 'Wahrnehmung beim Hörer selbst (z. B. Tinnitus, Schwindel)' }
};

export function isStageKey(k) { return STAGE_ORDER.includes(k); }

/**
 * Module, die ein Layer enthalten kann — abgeleitet aus der Registry (audio/engine/registry.js, AE-01′); nicht von Hand
 * pflegen. Envelope, Pan und Analyzer gehören NICHT in einen Layer.
 */
export const LAYER_PARAM_KEYS = MODULE_KEYS.slice();

const clone = x => JSON.parse(JSON.stringify(x));

// ─── LAYER-PARAMETER ─────────────────────────────────────────

export function hasActiveModules(params) {
  if (!params) return false;
  return LAYER_PARAM_KEYS.some(k => params[k]?.enabled === true);
}

/**
 * Vergleichsform: gefüllte Parameter, nur KLINGENDE Module (aktiv und nicht von einem Vorrangmodul derselben
 * Exklusivgruppe überlagert, B-02), stabile Schlüsselreihenfolge. Dadurch gelten Layer mit und ohne ein überlagertes,
 * nie gebautes Modul als gleich (wichtig für „angepasst“ nach der klangneutralen Preset-Datenkorrektur, Phase 2).
 */
export function activeSignature(params) {
  const full = fillLayerParams(params);
  const act = {};
  for (const k of effectiveActiveKeys(full)) act[k] = full[k];
  return JSON.stringify(act);
}

/** True, wenn ein Preset-Layer von seinem Katalog-Preset abweicht („angepasst“). Manuelle Layer: false. */
export function isLayerModified(layer, presetEffects) {
  if (!layer || !layer.presetId || !presetEffects) return false;
  return activeSignature(layer.params) !== activeSignature(presetEffects);
}

// ─── STRUKTUR ────────────────────────────────────────────────

export function newLayerId() { return 'ly_' + uid(); }

export function makeLayer({ presetId = null, params = {}, enabled = true, stageAuto = false, id, x } = {}) {
  const { sparse, x: ux } = splitLayerParams(params);
  const layer = { id: id || newLayerId(), presetId: presetId || null, enabled: enabled !== false, params: sparse };
  if (stageAuto) layer.stageAuto = true;
  const bag = cleanX({ ...inheritX(x), modules: addToBag(addToBag({}, inheritX(x).modules), ux?.modules) });
  if (bag) layer.x = bag;
  return layer;
}

export function defaultPipelineEffects() {
  const stages = {};
  for (const k of STAGE_ORDER) stages[k] = { enabled: true, layers: [] };
  return {
    v: PIPELINE_VERSION,
    enabled: false,
    stages
  };
}

/**
 * Strukturelle Normalisierung eines v2-Objekts (ohne Zahlen-Klemmung der Parameter — die macht
 * presets.js normalizeEffectsV2() zusätzlich). Garantiert: alle vier Stufen vorhanden, layers ist ein Array,
 * jeder Layer hat eine EINDEUTIGE id (doppelte/fehlende ids werden neu vergeben — die Reihenfolge bleibt),
 * Layer-Parameter enthalten nur Registry-Module.
 *
 * Datenerhalt (AE-18): Unbekanntes wird nicht verworfen, sondern im Erweiterungsbeutel `x` mitgeführt
 * (effects.x: Zusatzfelder, unbekannte Stufen, Rettungsanker legacyV1; layer.x: unbekannte Module/Zusatzfelder).
 * Bewusst verworfen werden nur die entfernten Schlüssel (REMOVED_KEYS: Hüllkurve, Pan, Ausgang, Analyzer).
 * Revision (AE-19): `rev` bleibt nur erhalten, wenn ≠ 1 (fehlend = 1); neuere Revisionen bleiben unangetastet.
 */
const _KNOWN_TOP = new Set(['v', 'enabled', 'stages', 'legacy', 'rev', 'x', 'legacyV1']);
const _KNOWN_STAGE = new Set(['enabled', 'layers']);
const _KNOWN_LAYER = new Set(['id', 'presetId', 'enabled', 'params', 'stageAuto', 'x']);

export function normalizePipelineStructure(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    v: PIPELINE_VERSION,
    enabled: src.enabled === true,
    stages: {}
  };
  const rev = readRev(src);
  if (rev !== 1) out.rev = rev;
  if (src.legacy && typeof src.legacy === 'object') out.legacy = clone(src.legacy);

  // Erweiterungsbeutel (bestehender Beutel zuerst, neu gefundenes Unbekanntes überschreibt gleichnamige Einträge)
  const xin = inheritX(src.x);
  const xTop = {}, xStages = {}, xStageFields = {};
  for (const [k, v] of Object.entries(src)) {
    if (_KNOWN_TOP.has(k) || REMOVED_KEYS.includes(k) || isUnsafeKey(k)) continue;
    xTop[k] = v;
  }
  if (src.stages && typeof src.stages === 'object') {
    for (const [k, v] of Object.entries(src.stages)) if (!isStageKey(k) && !isUnsafeKey(k)) xStages[k] = v;
  }

  const seen = new Set();
  for (const k of STAGE_ORDER) {
    const st = src.stages?.[k];
    const layers = [];
    if (st && typeof st === 'object') {
      const extra = {};
      for (const [f, v] of Object.entries(st)) if (!_KNOWN_STAGE.has(f) && !isUnsafeKey(f)) extra[f] = v;
      if (Object.keys(extra).length) xStageFields[k] = extra;
    }
    for (const l of (Array.isArray(st?.layers) ? st.layers : [])) {
      if (!l || typeof l !== 'object') continue;
      let id = (typeof l.id === 'string' && l.id) ? l.id : null;
      if (!id || seen.has(id)) id = newLayerId();
      seen.add(id);
      const { sparse, x: ux } = splitLayerParams(l.params);
      const layer = {
        id,
        presetId: (typeof l.presetId === 'string' && l.presetId) ? l.presetId : null,
        enabled: l.enabled !== false,
        params: sparse
      };
      if (l.stageAuto === true) layer.stageAuto = true;
      const lx = inheritX(l.x), lf = {};
      for (const [f, v] of Object.entries(l)) if (!_KNOWN_LAYER.has(f) && !isUnsafeKey(f)) lf[f] = v;
      const lbag = cleanX({ modules: addToBag(addToBag({}, lx.modules), ux?.modules), fields: addToBag(addToBag({}, lx.fields), lf) });
      if (lbag) layer.x = lbag;
      layers.push(layer);
    }
    out.stages[k] = { enabled: st ? st.enabled !== false : true, layers };
  }

  const legacyV1 = src.legacyV1 !== undefined ? src.legacyV1 : xin.legacyV1;
  const xbag = cleanX({
    fields: addToBag(addToBag({}, xin.fields), xTop),
    stages: addToBag(addToBag({}, xin.stages), xStages),
    stageFields: addToBag(addToBag({}, xin.stageFields), xStageFields),
    ...(legacyV1 !== undefined && legacyV1 !== null ? { legacyV1: (() => { try { return JSON.parse(JSON.stringify(legacyV1)); } catch (e) { return undefined; } })() } : {})
  });
  if (xbag) out.x = xbag;
  return out;
}

// ─── REINE BEARBEITUNGS-OPERATIONEN (Draft/UI/Tests) ────────────────────────
// Alle arbeiten direkt am übergebenen Effekt-Objekt und ändern NUR, was der Name sagt.

export function findLayer(effects, layerId) {
  for (const stage of STAGE_ORDER) {
    const idx = (effects.stages[stage].layers).findIndex(l => l.id === layerId);
    if (idx >= 0) return { stage, index: idx, layer: effects.stages[stage].layers[idx] };
  }
  return null;
}

/** Hängt einen Layer ans Ende der Stufe (oder an `index`). Dasselbe Preset darf beliebig oft vorkommen. */
export function addLayer(effects, stage, layerInit, index) {
  if (!isStageKey(stage)) throw new Error('Unbekannte Stufe: ' + stage);
  const layer = makeLayer(layerInit);
  const arr = effects.stages[stage].layers;
  if (Number.isInteger(index) && index >= 0 && index <= arr.length) arr.splice(index, 0, layer); else arr.push(layer);
  return layer;
}

export function removeLayer(effects, layerId) {
  const f = findLayer(effects, layerId);
  if (!f) return false;
  effects.stages[f.stage].layers.splice(f.index, 1);
  return true;
}

/** Verschiebt einen Layer INNERHALB seiner Stufe von `from` nach `to` (Zielindex nach dem Herausnehmen). */
export function moveLayer(effects, stage, from, to) {
  const arr = effects.stages[stage]?.layers;
  if (!arr || from < 0 || from >= arr.length) return false;
  const t = Math.max(0, Math.min(arr.length - 1, to));
  if (t === from) return false;
  const [l] = arr.splice(from, 1);
  arr.splice(t, 0, l);
  return true;
}

/** Kopie direkt hinter dem Original — eigene id, unabhängige Parameter. */
export function duplicateLayer(effects, layerId) {
  const f = findLayer(effects, layerId);
  if (!f) return null;
  const copy = makeLayer({ presetId: f.layer.presetId, params: clone(f.layer.params), enabled: f.layer.enabled });
  effects.stages[f.stage].layers.splice(f.index + 1, 0, copy);
  return copy;
}

// ─── PLAN ────────────────────────────────────────────────────

/**
 * Fähigkeiten je Ziel (Live/Export/Ambient/Musik/Noise-Preview). Der Plan selbst ist für alle Ziele gleich;
 * nur diese Flags unterscheiden, was ein Ziel technisch ausführen kann.
 *   pitch: 'worklet' = Pitch-Worklet pro Layer (Reihenfolge bleibt erhalten) | 'none' = Pitch wird nicht ausgeführt
 */
export const TARGET_CAPS = {
  sound:   { pitch: 'worklet' },
  ambient: { pitch: 'worklet' },
  music:   { pitch: 'worklet' },
  noise:   { pitch: 'worklet' }
};

/**
 * Löst ein v2-Effektobjekt in eine geordnete Schrittliste auf. REIN, ohne AudioContext.
 *   steps       = alle aktiven Layer in exakt der Reihenfolge Quelle → Medium → Umgebung → Hörer, innerhalb
 *                 einer Stufe in Array-Reihenfolge. Deaktivierte Stufen/Layer entfallen (kein Ersatz-Zustand).
 *   needsPanner = true, sobald mindestens ein aktiver Schritt existiert: rein technischer Stereo-Abschluss
 *                 (Pan 0, Mono→Stereo wie bisher), KEIN Pipeline-Schritt und nicht einstellbar.
 */
export function resolvePlan(effects) {
  if (!effects || effects.v !== PIPELINE_VERSION) {
    throw new TypeError('resolvePlan: v2-Effektobjekt erwartet (v1-Daten zuerst migrieren: fx-model.js ensureEffectsV2)');
  }
  const steps = [];
  if (effects.enabled) {
    for (const stage of STAGE_ORDER) {
      const st = effects.stages[stage];
      if (!st || !st.enabled) continue;
      st.layers.forEach((layer, layerIndex) => {
        if (!layer.enabled) return;
        const params = fillLayerParams(layer.params);
        steps.push({
          index: steps.length, stage, layerId: layer.id, layerIndex, presetId: layer.presetId,
          params, active: hasActiveModules(params)
        });
      });
    }
  }
  const needsPanner = effects.enabled && steps.some(s => s.active);
  return {
    v: PIPELINE_VERSION,
    steps,
    needsPanner,
    hasPitch: steps.some(s => s.params.pitchShift.enabled && s.params.pitchShift.semitones),
    /** Lesbare Reihenfolge für Tests/Diagnose, z. B. ['source:monster', 'source:manual', 'medium:radio'] */
    sequence: steps.map(s => `${s.stage}:${s.presetId || 'manual'}`)
  };
}

/**
 * Geschätzte Nachklingdauer (Sekunden) der Kette, SCHATTENBLIND: Hall/IR/Delay aller aktiven Module je Schritt, summiert.
 * Die Werte kommen seit Phase 4 aus der Registry (`tail()` je Modul) — keine zweite Formel mehr. Überlagerte Module (z. B. Hall
 * unter einem IR-Hall) zählen hier noch mit; für die tatsächliche Dauer siehe planTailSeconds().
 */
export function estimateTail(plan) {
  let sum = 0;
  for (const s of plan.steps) {
    let t = 0;
    for (const k of ['irReverb', 'reverb', 'delay']) if (s.params[k]?.enabled) t = Math.max(t, moduleTail(k, s.params[k]));
    sum += t;
  }
  return Math.min(30, sum);
}

/**
 * Nachklingdauer der TATSÄCHLICH klingenden Module (überlagerte zählen nicht) aus den Registry-`tail()`-Werten (Phase 4).
 * REIN, ohne AudioContext. Gleicher Wert wie `PipelineRuntime.tailSeconds()` einer statisch gebauten Pipeline OHNE Send —
 * bei sendfähigem Hall liegt der Nachhall im Hub und die Runtime meldet nur die Ketten-Restzeit; der Export braucht aber die
 * volle Dauer inklusive Hall und nimmt deshalb diesen Wert.
 */
export function planTailSeconds(plan) {
  let sum = 0;
  for (const s of plan.steps) {
    let t = 0;
    for (const k of effectiveActiveKeys(s.params)) t = Math.max(t, moduleTail(k, s.params[k]));
    sum += t;
  }
  return Math.min(30, sum);
}

/** Export-Tail: mindestens 3,5 s sobald Effekte aktiv waren, bei langen Ketten mehr (Registry-`tail()` der klingenden Module, Phase 4). */
export function exportTailSeconds(plan) {
  if (!plan.steps.some(s => s.active)) return 0;
  return Math.min(30, Math.max(3.5, planTailSeconds(plan) + 0.5));
}

/** Heuristik für automatische Stufenzuordnung (User-Presets/ungelabelte Alt-Effekte). Gleichstand → Medium. */
export function suggestStageForParams(params) {
  // Punkte je Stufe stammen aus den `stageHint`s der Registry (audio/engine/registry.js) — keine Modulliste hier.
  const { source, medium, environment } = stageScores(params);
  if (source > medium && source >= environment) return 'source';
  if (environment > medium && environment > source) return 'environment';
  return 'medium';
}

// ─── GETEILTER REVERB-SEND (Phase 3b, AE-17) ─────────────────

const _LAYER_ORDER = Object.fromEntries(MODULES.map(m => [m.key, m.layerOrder]));

/** Klingende Module eines Schritts: aktiv, nicht überlagert (B-02); Pitch nur mit Halbtönen ≠ 0 (sonst wird kein Knoten gebaut). */
function _soundingKeys(params) {
  return effectiveActiveKeys(params).filter(k => k !== 'pitchShift' || (params.pitchShift.enabled && params.pitchShift.semitones));
}

/**
 * Ist der Hall des Plans sendfähig? REIN (ohne AudioContext). Alle Bedingungen müssen gelten:
 *   1. Das klingende Hall-Modul (irReverb vor reverb) gehört zum LETZTEN klingenden Schritt — danach kein Layer mit klingendem Modul.
 *   2. Im selben Layer folgt nach dem Hall kein klingendes Modul (Delay, Tremolo, Noise-Gate, Spatial; kanonische Layer-Reihenfolge).
 * (Die dritte Bedingung — Einstellung „Geteilt“ und Hub-Dienst — prüft der Aufrufer.)
 * @returns {{step:number, key:string, wet:number, irKey:string, getIR:Function}|null}
 */
export function sendEligibility(plan) {
  if (!plan || !plan.needsPanner) return null;
  let last = -1;
  plan.steps.forEach((s, i) => { if (_soundingKeys(s.params).length) last = i; });
  if (last < 0) return null;
  const step = plan.steps[last];
  const keys = _soundingKeys(step.params);
  const rev = keys.find(k => k === 'irReverb' || k === 'reverb');
  if (!rev) return null;
  if (keys.some(k => _LAYER_ORDER[k] > _LAYER_ORDER[rev])) return null;
  const d = describeSend(rev, step.params[rev]);
  return d ? { step: step.index, ...d } : null;
}

// ─── EXECUTOR ────────────────────────────────────────────────

/** Lädt, falls nötig, das Pitch-Worklet im Ziel-Context (muss vor buildPipelineGraph() fertig sein). */
export async function preparePipelineContext(ctx, plan, caps = TARGET_CAPS.sound) {
  if (plan.hasPitch && caps.pitch === 'worklet') await ensurePitchWorkletFor(ctx);
}

/**
 * Baut die Pipeline als EINE strikt serielle Knotenkette:
 *   [Pitch₁] → Kette₁ → [Pitch₂] → Kette₂ → … → [terminaler Panner]
 * Je Schritt (= je Layer-Instanz) ein eigener Pitch-Knoten und eine eigene Kette; es wird nichts
 * zusammengefasst, umsortiert oder übersprungen. Ein Layer ohne aktive Module reicht durch.
 *
 * Seit Phase 3 ist das eine FASSADE über `PipelineRuntime` (engine/runtime.js): derselbe Aufbau, zusätzlich Handles für
 * Live-Update/Überblendung/Tail/Kosten. Ohne `live` fügt die Runtime keine Knoten hinzu (bit-gleich zu Phase 2).
 *
 * @param {object} [o] { numChannels, caps, live (Ein-/Ausgangs-Gain + swapTo), bypassable (Bypass-Hülle je Modul), xfade,
 *                       shareReverb (Phase 3b: Hall über den Hub; Rückgabe `send` ≠ null → Aufrufer hängt reverb-hub.attachSend an) }
 * @returns {{input:AudioNode|null, output:AudioNode|null, detuneSemitones:number, skippedPitch:number,
 *            dispose:()=>void, runtime:PipelineRuntime, update:Function, tailSeconds:()=>number, cost:Function}}
 *   input/output = null, wenn die Pipeline leer ist (Aufrufer verbindet dann die Quelle direkt) — im Live-Modus nie null.
 *   detuneSemitones: nur gesetzt, wenn ein Pitch-Worklet für diesen Schritt nicht verfügbar war (Notbehelf
 *   über src.detune, Reihenfolge dann NICHT garantiert; Console-Warnung). skippedPitch: vom Ziel nicht ausgeführte Pitch-Schritte.
 */
export function buildPipelineGraph(ctx, plan, { numChannels = 2, caps = TARGET_CAPS.sound, live = false, bypassable = false, xfade, shareReverb = false } = {}) {
  // Geteilter Reverb (Phase 3b): nur statisch (nicht live/bypassable) und nur, wenn der Aufrufer ihn ausdrücklich verlangt.
  const send = (shareReverb && !live && !bypassable) ? sendEligibility(plan) : null;
  const rt = new PipelineRuntime(ctx, plan, { numChannels, caps, live, bypassable, xfade, send });
  return {
    send: rt.send,
    input: rt.input, output: rt.output,
    detuneSemitones: rt.detuneSemitones, skippedPitch: rt.skippedPitch,
    dispose: () => rt.dispose(),
    runtime: rt,
    update: p => rt.update(p),
    tailSeconds: () => rt.tailSeconds(),
    cost: () => rt.cost()
  };
}

/**
 * Hängt `src → Pipeline → dest` an (Ambient, Musik, Noise-Preview). Async, weil das Pitch-Worklet pro
 * Context geladen werden muss. `plan`/`graph` im Ergebnis für Tail/Dispose.
 */
export async function connectPipeline(ctx, src, plan, dest, { caps = TARGET_CAPS.ambient, numChannels = 2 } = {}) {
  await preparePipelineContext(ctx, plan, caps);
  const graph = buildPipelineGraph(ctx, plan, { numChannels, caps });
  if (graph.detuneSemitones && src.detune) { try { src.detune.value = graph.detuneSemitones * 100; } catch (e) { /* Worklet-Knoten */ } }
  if (graph.input) { src.connect(graph.input); graph.output.connect(dest); }
  else src.connect(dest);
  return { plan, graph, tailSeconds: estimateTail(plan), dispose: graph.dispose };
}
