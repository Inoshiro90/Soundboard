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
import { defaultEffects, buildLayerChain, buildTerminalPanner, buildPitchNode } from './effect-graph.js';
import { ensurePitchWorkletFor } from './context.js';
import { getIRDuration } from './ir-data.js';

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

/** Module, die ein Layer enthalten kann. Envelope, Pan und Analyzer gehören NICHT in einen Layer. */
export const LAYER_PARAM_KEYS = [
  'lowpass', 'highpass', 'notch', 'wahwah',
  'reverb', 'delay', 'chorus', 'flanger', 'tremolo',
  'eq', 'eq10', 'compressor', 'limiter', 'distortion', 'ringmod',
  'pitchShift', 'irReverb', 'spatial', 'noiseGate'
];

const clone = x => JSON.parse(JSON.stringify(x));

// ─── LAYER-PARAMETER ─────────────────────────────────────────

/** Vollständiges Parameterobjekt (alle LAYER_PARAM_KEYS) aus einem sparsamen/teilweisen. Deterministisch. */
export function fillLayerParams(params) {
  const def = defaultEffects();
  const src = (params && typeof params === 'object') ? params : {};
  const out = {};
  for (const key of LAYER_PARAM_KEYS) {
    if (key === 'eq10') {
      const bands = Array.isArray(src.eq10?.bands) ? src.eq10.bands.slice(0, 10) : def.eq10.bands.slice();
      while (bands.length < 10) bands.push(0);
      out.eq10 = { ...def.eq10, ...(src.eq10 || {}), bands };
      continue;
    }
    out[key] = { ...def[key], ...(src[key] || {}) };
  }
  return out;
}

/** Sparsame Form für die Speicherung: nur aktive Module (Defaults werden bei fillLayerParams() ergänzt). */
export function sparsifyParams(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const key of LAYER_PARAM_KEYS) {
    const m = params[key];
    if (m && typeof m === 'object' && m.enabled === true) out[key] = clone(m);
  }
  return out;
}

export function hasActiveModules(params) {
  if (!params) return false;
  return LAYER_PARAM_KEYS.some(k => params[k]?.enabled === true);
}

/** Vergleichsform: gefüllte Parameter, nur aktive Module, stabile Schlüsselreihenfolge. */
export function activeSignature(params) {
  const full = fillLayerParams(params);
  const act = {};
  for (const k of LAYER_PARAM_KEYS) if (full[k].enabled) act[k] = full[k];
  return JSON.stringify(act);
}

/** True, wenn ein Preset-Layer von seinem Katalog-Preset abweicht („angepasst“). Manuelle Layer: false. */
export function isLayerModified(layer, presetEffects) {
  if (!layer || !layer.presetId || !presetEffects) return false;
  return activeSignature(layer.params) !== activeSignature(presetEffects);
}

// ─── STRUKTUR ────────────────────────────────────────────────

export function newLayerId() { return 'ly_' + uid(); }

export function makeLayer({ presetId = null, params = {}, enabled = true, stageAuto = false, id } = {}) {
  const layer = { id: id || newLayerId(), presetId: presetId || null, enabled: enabled !== false, params: sparsifyParams(params) };
  if (stageAuto) layer.stageAuto = true;
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
 * unbekannte Stufen werden verworfen, Layer-Parameter enthalten nur LAYER_PARAM_KEYS.
 */
export function normalizePipelineStructure(raw) {
  const def = defaultPipelineEffects();
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    v: PIPELINE_VERSION,
    enabled: src.enabled === true,
    stages: {}
  };
  if (src.legacy && typeof src.legacy === 'object') out.legacy = clone(src.legacy);

  const seen = new Set();
  for (const k of STAGE_ORDER) {
    const st = src.stages?.[k];
    const layers = [];
    for (const l of (Array.isArray(st?.layers) ? st.layers : [])) {
      if (!l || typeof l !== 'object') continue;
      let id = (typeof l.id === 'string' && l.id) ? l.id : null;
      if (!id || seen.has(id)) id = newLayerId();
      seen.add(id);
      const layer = {
        id,
        presetId: (typeof l.presetId === 'string' && l.presetId) ? l.presetId : null,
        enabled: l.enabled !== false,
        params: sparsifyParams(l.params)
      };
      if (l.stageAuto === true) layer.stageAuto = true;
      layers.push(layer);
    }
    out.stages[k] = { enabled: st ? st.enabled !== false : true, layers };
  }
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

/** Geschätzte Nachklingdauer (Sekunden) der Kette: Hall/IR-Längen und Delay-Abklingen je Schritt summiert. */
export function estimateTail(plan) {
  let sum = 0;
  for (const s of plan.steps) {
    const p = s.params;
    let t = 0;
    if (p.irReverb.enabled) t = Math.max(t, getIRDuration(p.irReverb.impulse));
    if (p.reverb.enabled)   t = Math.max(t, p.reverb.duration ?? 2.2);
    if (p.delay.enabled) {
      const time = Math.max(0.01, p.delay.time ?? 0.22);
      const fb = Math.max(0, Math.min(0.95, p.delay.feedback ?? 0.35));
      const repeats = fb > 0 ? Math.min(60, Math.ceil(Math.log(0.001) / Math.log(fb))) : 1;
      t = Math.max(t, Math.min(10, time * repeats));
    }
    sum += t;
  }
  return Math.min(30, sum);
}

/** Export-Tail: bisher fest 3,5 s sobald Effekte aktiv waren — jetzt mindestens das, bei langen Ketten mehr. */
export function exportTailSeconds(plan) {
  if (!plan.steps.some(s => s.active)) return 0;
  return Math.min(30, Math.max(3.5, estimateTail(plan) + 0.5));
}

/** Heuristik für automatische Stufenzuordnung (User-Presets/ungelabelte Alt-Effekte). Gleichstand → Medium. */
export function suggestStageForParams(params) {
  const p = fillLayerParams(params);
  let source = 0, medium = 0, environment = 0;
  if (p.pitchShift.enabled) source += 2;
  if (p.ringmod.enabled)    source += 2;
  if (p.chorus.enabled)     source += 1;
  if (p.flanger.enabled)    source += 1;
  for (const k of ['highpass', 'lowpass', 'notch', 'distortion', 'compressor', 'limiter', 'noiseGate', 'eq', 'eq10']) if (p[k].enabled) medium += 1;
  if (p.irReverb.enabled)  environment += 3;
  if (p.reverb.enabled && (p.reverb.duration ?? 0) >= 1.5) environment += 2;
  if (p.delay.enabled && (p.delay.time ?? 0) >= 0.12)      environment += 1;
  if (source > medium && source >= environment) return 'source';
  if (environment > medium && environment > source) return 'environment';
  return 'medium';
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
 * @returns {{input:AudioNode|null, output:AudioNode|null, detuneSemitones:number, skippedPitch:number,
 *            dispose:()=>void}}
 *   input/output = null, wenn die Pipeline leer ist (Aufrufer verbindet dann die Quelle direkt).
 *   detuneSemitones: nur gesetzt, wenn ein Pitch-Worklet für diesen Schritt nicht verfügbar war (Notbehelf
 *   über src.detune, Reihenfolge dann NICHT garantiert; Console-Warnung). skippedPitch: vom Ziel nicht ausgeführte Pitch-Schritte.
 */
export function buildPipelineGraph(ctx, plan, { numChannels = 2, caps = TARGET_CAPS.sound } = {}) {
  const track = [];      // gestartete Quellen (LFO/Träger) → dispose() stoppt sie
  const nodes = [];      // Verbindungsknoten → dispose() trennt sie
  let input = null, tail = null, detuneSemitones = 0, skippedPitch = 0;

  const link = seg => {
    if (!seg) return;
    nodes.push(seg.input, seg.output);
    if (!input) input = seg.input; else tail.connect(seg.input);
    tail = seg.output;
  };

  for (const step of plan.steps) {
    const ps = step.params.pitchShift;
    if (ps.enabled && ps.semitones) {
      if (caps.pitch === 'worklet') {
        const n = buildPitchNode(ctx, ps, numChannels);
        if (n) link(n);
        else {
          detuneSemitones += ps.semitones;
          console.warn('[pipeline] Pitch-Worklet nicht verfügbar — Notbehelf über detune (Reihenfolge nicht garantiert)');
        }
      } else skippedPitch++;
    }
    link(buildLayerChain(ctx, step.params, { track }));
  }
  if (input && plan.needsPanner) link(buildTerminalPanner(ctx, 0));

  const dispose = () => {
    for (const s of track) { try { s.stop(); } catch (e) { /* bereits gestoppt */ } }
    for (const n of nodes) { try { n.disconnect(); } catch (e) { /* bereits getrennt */ } }
    track.length = 0; nodes.length = 0;
  };
  return { input, output: tail, detuneSemitones, skippedPitch, dispose };
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
