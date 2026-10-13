/**
 * audio/engine/registry.js — Modul-Registry (AE-01′): die EINZIGE Beschreibung der Layer-Module.
 * ----------------------------------------------------------------------------------------------
 * Aus dieser Tabelle leiten sich ab: LAYER_PARAM_KEYS, PRESET_EFFECT_KEYS, NUM_RANGES, defaultEffects(),
 * Normalisierung/Validierung (schema.js), Exklusivregeln, Nachklang (tail) und – ab Phase 3a – das Kostenmodell.
 *
 * Datenmodell (AE-02′): Die Pipeline (effects.v === 2, Quelle → Medium → Umgebung → Hörer) ist das Datenmodell.
 * Ein Layer trägt `params = { <modulKey>: { enabled, …Parameter } }`. Neue Module = neue Einträge HIER (und ihr Builder
 * in effect-graph.js). Die Reihenfolge der Einträge ist die Reihenfolge von LAYER_PARAM_KEYS und von defaultEffects()
 * und darf nicht umsortiert werden (defaultEffects() muss byte-identisch bleiben).
 *
 * Parameter-Spezifikation (`params[feld]`):
 *   { def, range:[min,max], unit, label }   Zahl, beim Import geklemmt (Bereiche = bisherige NUM_RANGES)
 *   { def, raw:true,  unit, label }         Zahl OHNE Importklemmung (bisheriges Verhalten; die Engine klemmt selbst)
 *   { def, enum:[…],  label }               Auswahl; ungültig → Default
 *   { def:null, impulse:true }              IR-Name (IR_IMPULSE_NAMES) oder null
 *   { def:[0×10], bands:true }              10 EQ-Bänder: Zahl (Gain) oder {freq, gain, Q}
 *
 * `ui.enabledId`: ID des Ein-/Aus-Schalters im (noch handgeschriebenen) Formular fragments/modals/sound-fx-pipeline.html.
 *   Entfällt mit der schema-generierten UI (Phase 8); bis dahin prüft ein Test, dass jedes Modul seinen Schalter hat.
 * `stageHint`: Beitrag zum Stufenvorschlag (suggestStageForParams): { stage, weight } oder Funktion(params) → { stage, weight } | null.
 *   Module ohne Hinweis (Wah-Wah, Tremolo, Spatial) tragen nicht zum Vorschlag bei.
 * `layerOrder`: kanonische Position INNERHALB eines Layers (E8, identisch zu _collectSegments() in effect-graph.js;
 *   pitchShift sitzt als eigener Knoten am Layer-Kopf, spatial am Layer-Ende). Die Reihenfolge ZWISCHEN Layern
 *   bestimmt der Nutzer (Invariante des Pipeline-Modells).
 * `cost`: Kostenpunkte je Voice (AE-13′). ACHTUNG: `measured:false` — Startwerte aus dem Plan, KEINE Messung;
 *   verbindlich erst nach M-1 (Phase 3a).
 * `tail(params)`: Nachklang in Sekunden (derselbe Wert wie estimateTail() in fx-pipeline.js, getestet).
 */

import { IR_IMPULSE_NAMES, getIRDuration } from '../ir-data.js';

/** Schlüssel, die frühere Versionen kannten und das Pipeline-Modell bewusst NICHT mehr trägt (Backup: `…:pre-pipeline`). */
export const REMOVED_KEYS = ['envelope', 'pan', 'output', 'analyzer'];

/** Aktuelle Schema-Revision (AE-19). `effects.rev` fehlt ⇒ 1. Migrationen innerhalb von v:2 hängen sich in schema.js ein. */
export const CURRENT_REV = 1;

const ALL_CONSUMERS = { sound: true, ambient: true, music: true, noise: true };
const c = (base, extra) => ({ base, measured: false, ...(extra || {}) });

const filterQ = (def, range) => ({ def, range, label: 'Güte (Q)' });

export const MODULES = [
  { key: 'lowpass', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxLpEnabled' }, family: 'filter', label: 'Tiefpass', layerOrder: 20, consumers: ALL_CONSUMERS, cost: c(1),
    params: { frequency: { def: 20000, range: [20, 20000], unit: 'Hz', label: 'Grenzfrequenz' }, Q: filterQ(0.7, [0.1, 20]) } },
  { key: 'highpass', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxHpEnabled' }, family: 'filter', label: 'Hochpass', layerOrder: 10, consumers: ALL_CONSUMERS, cost: c(1),
    params: { frequency: { def: 20, range: [20, 20000], unit: 'Hz', label: 'Grenzfrequenz' }, Q: filterQ(0.7, [0.1, 20]) } },
  { key: 'notch', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxNotchEnabled' }, family: 'filter', label: 'Notch (Kerbfilter)', layerOrder: 30, consumers: ALL_CONSUMERS, cost: c(1),
    params: { frequency: { def: 50, range: [20, 20000], unit: 'Hz', label: 'Frequenz' }, Q: filterQ(10, [0.5, 30]) } },
  { key: 'wahwah', ui: { enabledId: 'fxWahwahEnabled' }, family: 'filter', label: 'Wah-Wah', layerOrder: 40, consumers: ALL_CONSUMERS, cost: c(3),
    params: {
      frequency: { def: 800, range: [100, 5000], unit: 'Hz', label: 'Mittenfrequenz' },
      depth: { def: 0.7, range: [0, 1], label: 'Tiefe' },
      rate: { def: 2, range: [0.1, 10], unit: 'Hz', label: 'Rate' },
      resonance: { def: 5, range: [1, 20], label: 'Resonanz' }
    } },
  { key: 'reverb', stageHint: p => ((p?.duration ?? 0) >= 1.5 ? { stage: 'environment', weight: 2 } : null), ui: { enabledId: 'fxRevEnabled' }, family: 'space', label: 'Hall (algorithmisch)', layerOrder: 110, consumers: ALL_CONSUMERS,
    cost: p => ({ base: 3 + (p?.duration ?? 2.2), measured: false }), degrade: { irLength: true },
    tail: p => p?.duration ?? 2.2,
    params: {
      amount: { def: 0.35, range: [0, 1], label: 'Anteil (Wet)' },
      duration: { def: 2.2, range: [0.05, 10], unit: 's', label: 'Dauer' },
      decay: { def: 2.0, range: [0.1, 10], label: 'Abklingen' }
    } },
  { key: 'delay', stageHint: p => ((p?.time ?? 0) >= 0.12 ? { stage: 'environment', weight: 1 } : null), ui: { enabledId: 'fxDelEnabled' }, family: 'space', label: 'Echo (Delay)', layerOrder: 120, consumers: ALL_CONSUMERS, cost: c(2),
    tail: p => {
      const time = Math.max(0.01, p?.time ?? 0.22);
      const fb = Math.max(0, Math.min(0.95, p?.feedback ?? 0.35));
      const repeats = fb > 0 ? Math.min(60, Math.ceil(Math.log(0.001) / Math.log(fb))) : 1;
      return Math.min(10, time * repeats);
    },
    params: {
      time: { def: 0.22, range: [0, 2], unit: 's', label: 'Zeit' },
      feedback: { def: 0.35, range: [0, 0.95], label: 'Rückkopplung' },
      wet: { def: 0.35, range: [0, 1], label: 'Anteil (Wet)' }
    } },
  { key: 'chorus', stageHint: { stage: 'source', weight: 1 }, ui: { enabledId: 'fxChorusEnabled' }, family: 'modulation', label: 'Chorus', layerOrder: 90, consumers: ALL_CONSUMERS, cost: c(3),
    params: {
      baseDelay: { def: 15, range: [1, 40], unit: 'ms', label: 'Grundverzögerung' },
      depth: { def: 8, range: [0, 20], unit: 'ms', label: 'Tiefe' },
      rate: { def: 0.8, range: [0.01, 10], unit: 'Hz', label: 'Rate' },
      mix: { def: 0.3, range: [0, 1], label: 'Mix' }
    } },
  { key: 'flanger', stageHint: { stage: 'source', weight: 1 }, ui: { enabledId: 'fxFlangerEnabled' }, family: 'modulation', label: 'Flanger', layerOrder: 100, consumers: ALL_CONSUMERS, cost: c(3),
    params: {
      baseDelay: { def: 2, range: [0.5, 10], unit: 'ms', label: 'Grundverzögerung' },
      depth: { def: 1.5, range: [0, 10], unit: 'ms', label: 'Tiefe' },
      rate: { def: 0.2, range: [0.01, 10], unit: 'Hz', label: 'Rate' },
      feedback: { def: 0.5, range: [0, 0.95], label: 'Rückkopplung' },
      mix: { def: 0.5, range: [0, 1], label: 'Mix' }
    } },
  { key: 'tremolo', ui: { enabledId: 'fxTremoloEnabled' }, family: 'modulation', label: 'Tremolo', layerOrder: 130, consumers: ALL_CONSUMERS, cost: c(2),
    params: {
      rate: { def: 5, range: [0.1, 20], unit: 'Hz', label: 'Rate' },
      depth: { def: 0.5, range: [0, 1], label: 'Tiefe' },
      waveform: { def: 'sine', enum: ['sine', 'triangle', 'square'], label: 'Wellenform' }
    } },
  { key: 'eq', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxEqEnabled' }, family: 'eq', label: '3-Band-EQ', layerOrder: 50, consumers: ALL_CONSUMERS, cost: c(3),
    params: {
      low: { def: 0, range: [-18, 18], unit: 'dB', label: 'Tiefen' },
      mid: { def: 0, range: [-18, 18], unit: 'dB', label: 'Mitten' },
      high: { def: 0, range: [-18, 18], unit: 'dB', label: 'Höhen' }
    } },
  { key: 'eq10', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxEq10Enabled' }, family: 'eq', label: '10-Band-EQ', layerOrder: 50, consumers: ALL_CONSUMERS, cost: c(10),
    params: { bands: { def: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bands: true, label: 'Bänder' } } },
  { key: 'compressor', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxCompEnabled' }, family: 'dynamics', label: 'Kompressor', layerOrder: 60, consumers: ALL_CONSUMERS, cost: c(2),
    params: {
      threshold: { def: -24, range: [-60, 0], unit: 'dB', label: 'Schwelle' },
      knee: { def: 30, range: [0, 40], unit: 'dB', label: 'Knie' },
      ratio: { def: 12, range: [1, 20], label: 'Verhältnis' },
      attack: { def: 0.003, range: [0, 1], unit: 's', label: 'Attack' },
      release: { def: 0.25, range: [0, 1], unit: 's', label: 'Release' }
    } },
  { key: 'limiter', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxLimEnabled' }, family: 'dynamics', label: 'Limiter', layerOrder: 60, consumers: ALL_CONSUMERS, cost: c(2),
    params: {
      threshold: { def: -1, range: [-24, 0], unit: 'dB', label: 'Schwelle' },
      knee: { def: 0, raw: true, unit: 'dB', label: 'Knie' },
      ratio: { def: 20, raw: true, label: 'Verhältnis' },
      attack: { def: 0.001, raw: true, unit: 's', label: 'Attack' },
      release: { def: 0.08, raw: true, unit: 's', label: 'Release' }
    } },
  { key: 'distortion', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxDistEnabled' }, family: 'distortion', label: 'Verzerrung', layerOrder: 70, consumers: ALL_CONSUMERS,
    cost: p => ({ base: ({ none: 1, '2x': 2, '4x': 4 })[p?.oversample ?? '4x'] ?? 4, measured: false }), degrade: { oversample: true },
    // mode: softClip (Standard), hardClip oder bitcrush. Presets ohne „mode“-Feld fallen über den switch-default in
    // _buildDistortionCurve() auf softClip zurück — kein Migrationsschritt nötig.
    params: {
      mode: { def: 'softClip', enum: ['softClip', 'hardClip', 'bitcrush'], label: 'Modus' },
      amount: { def: 40, range: [0, 100], label: 'Stärke' },
      oversample: { def: '4x', enum: ['none', '2x', '4x'], label: 'Oversampling' }
    } },
  { key: 'ringmod', stageHint: { stage: 'source', weight: 2 }, ui: { enabledId: 'fxRingmodEnabled' }, family: 'distortion', label: 'Ringmodulation', layerOrder: 80, consumers: ALL_CONSUMERS, cost: c(2),
    params: {
      frequency: { def: 440, range: [20, 5000], unit: 'Hz', label: 'Trägerfrequenz' },
      mix: { def: 1, range: [0, 1], label: 'Mix' }
    } },
  { key: 'pitchShift', stageHint: { stage: 'source', weight: 2 }, ui: { enabledId: 'fxPitchEnabled' }, family: 'voice', label: 'Tonhöhe', layerOrder: 0, consumers: ALL_CONSUMERS, needsWorklet: true, cost: c(3),
    params: { semitones: { def: 0, range: [-24, 24], unit: 'Halbtöne', label: 'Halbtöne' } } },
  { key: 'irReverb', stageHint: { stage: 'environment', weight: 3 }, ui: { enabledId: 'fxIrEnabled' }, family: 'space', label: 'Hall (Impulsantwort)', layerOrder: 110, consumers: ALL_CONSUMERS,
    cost: p => ({ base: 3 + getIRDuration(p?.impulse ?? null), measured: false }), degrade: { irLength: true },
    tail: p => getIRDuration(p?.impulse ?? null),
    params: {
      impulse: { def: null, impulse: true, label: 'Raum' },
      wet: { def: 0.35, range: [0, 1], label: 'Anteil (Wet)' }
    } },
  { key: 'spatial', ui: { enabledId: 'fxSpatialEnabled' }, family: 'position', label: 'Räumliche Position (3D)', layerOrder: 150, consumers: ALL_CONSUMERS, cost: c(3), degrade: { hrtf: true },
    params: {
      x: { def: 0, range: [-1000, 1000], label: 'X' },
      y: { def: 0, range: [-1000, 1000], label: 'Y' },
      z: { def: -1, range: [-1000, 1000], label: 'Z' },
      rolloff: { def: 1, range: [0, 10], label: 'Rolloff' },
      maxDistance: { def: 10000, range: [1, 100000], label: 'Max. Distanz' },
      refDistance: { def: 1, range: [0, 1000], label: 'Referenzdistanz' },
      coneInnerAngle: { def: 360, range: [0, 360], unit: '°', label: 'Kegel innen' },
      coneOuterAngle: { def: 360, range: [0, 360], unit: '°', label: 'Kegel außen' },
      coneOuterGain: { def: 0, range: [0, 1], label: 'Kegel-Restpegel' }
    } },
  // attack/release: Compressor-Näherung (siehe _collectSegments). Presets ohne diese Felder funktionieren unverändert,
  // da die Engine sie mit `?? 5`/`?? 150` defaultet. (B-03: ersetzt in Phase 11 durch ein echtes Gate.)
  { key: 'noiseGate', stageHint: { stage: 'medium', weight: 1 }, ui: { enabledId: 'fxNoiseGateEnabled' }, family: 'dynamics', label: 'Noise Gate', layerOrder: 140, consumers: ALL_CONSUMERS, cost: c(2),
    params: {
      threshold: { def: -50, range: [-100, 0], unit: 'dB', label: 'Schwelle' },
      attack: { def: 5, range: [0, 1000], unit: 'ms', label: 'Attack' },
      release: { def: 150, range: [0, 2000], unit: 'ms', label: 'Release' }
    } }
];

/**
 * Modulgruppen, in denen die Engine pro Layer NUR EIN Modul baut (B-02). Reihenfolge = Vorrang (erstes aktives gewinnt).
 * Das Engine-Verhalten ist unverändert (else-if in _collectSegments); die Gruppen machen die Regel sichtbar/prüfbar.
 */
export const EXCLUSIVE_GROUPS = [
  { id: 'reverbKind', label: 'Hall', members: ['irReverb', 'reverb'] },
  { id: 'eqKind', label: 'Equalizer', members: ['eq10', 'eq'] },
  { id: 'dynamicsKind', label: 'Dynamik', members: ['limiter', 'compressor'] }
];

// ─── ABGELEITETES ────────────────────────────────────────────

export const MODULE_KEYS = MODULES.map(m => m.key);
export const MODULE_BY_KEY = Object.fromEntries(MODULES.map(m => [m.key, m]));
export { IR_IMPULSE_NAMES };

/** Bereiche für die Importklemmung: { 'lowpass.frequency': [20, 20000], … } (ersetzt das handgepflegte NUM_RANGES). */
export const NUM_RANGES = (() => {
  const out = {};
  for (const m of MODULES) for (const [f, s] of Object.entries(m.params)) if (s.range) out[`${m.key}.${f}`] = s.range;
  return out;
})();

const cloneDef = v => (Array.isArray(v) ? v.slice() : v);

/** Frisches Default-Objekt EINES Moduls ({ enabled:false, …Parameter }), Schlüsselreihenfolge wie bisher. */
export function defaultModule(key) {
  const m = MODULE_BY_KEY[key];
  if (!m) return null;
  const o = { enabled: false };
  for (const [f, s] of Object.entries(m.params)) o[f] = cloneDef(s.def);
  return o;
}

/** Vollständiges Default-Effektobjekt (flaches Format, wie defaultEffects()): { enabled:false, preset:null, …Module }. */
export function defaultModules() {
  const o = { enabled: false, preset: null };
  for (const m of MODULES) o[m.key] = defaultModule(m.key);
  return o;
}

/** Nachklang eines Moduls in Sekunden (0, wenn das Modul keinen hat). */
export function moduleTail(key, params) {
  const m = MODULE_BY_KEY[key];
  return m && typeof m.tail === 'function' ? m.tail(params) : 0;
}

/** Kostenpunkte eines Moduls für die gegebenen Parameter: { base, measured }. */
export function moduleCost(key, params) {
  const m = MODULE_BY_KEY[key];
  if (!m) return { base: 0, measured: false };
  return typeof m.cost === 'function' ? m.cost(params) : { ...m.cost };
}
