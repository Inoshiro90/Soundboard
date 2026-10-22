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
 * `ui` (Modul): `{ generated: true }` — das Formular erzeugt das Modul aus dieser Registry (ui/effects/, Phase 8); es gibt kein handgeschriebenes
 *   Effekt-HTML mehr. (`enabledId` entfiel mit dem Abbau des alten Formulars; Suite 09 prüft, dass jedes Modul `generated` ist.)
 * `ui` (Parameter, optional): `{ hidden?, min?, max?, step?, scale?:'lin'|'log', digits?, percent?, display?, signed?, unit?, options?, emptyLabel? }` (percent: Daten 0…1, Anzeige 0…100 %; display `{factor,unit}`: andere Anzeigeeinheit, z. B. s → ms; signed: „+“ bei positiven Werten; options: Beschriftungen einer Aufzählung) — Darstellung im Regler. Fehlt `ui`, wird der
 *   Bereich aus `range` abgeleitet (ui/effects/control-math.js resolveParamUi). Der UI-Bereich darf ENGER sein als `range`
 *   (Option b, Phase 8: bildet die Bereiche des alten Formulars ab; Datenwerte außerhalb bleiben erhalten). `hidden:true` =
 *   kein Regler, der Wert wird beim Bearbeiten unverändert mitgeführt. Die Datenbereiche (`range`) bleiben die alleinige Grundlage der Importklemmung.
 * `stageHint`: Beitrag zum Stufenvorschlag (suggestStageForParams): { stage, weight } oder Funktion(params) → { stage, weight } | null.
 *   Module ohne Hinweis (Wah-Wah, Tremolo, Spatial) tragen nicht zum Vorschlag bei.
 * `layerOrder`: kanonische Position INNERHALB eines Layers (E8, identisch zu _collectSegments() in effect-graph.js;
 *   pitchShift sitzt als eigener Knoten am Layer-Kopf, spatial am Layer-Ende). Die Reihenfolge ZWISCHEN Layern
 *   bestimmt der Nutzer (Invariante des Pipeline-Modells).
 * `cost`: Kostenpunkte je Voice (AE-13′), `measured:true` seit M-1 (Phase 3a, Suite 13). Einheit: 1 Punkt = Rechenzeit eines
 *   Tiefpass-Biquads. Messbasis: 16 parallele Instanzen im Offline-Render, Chrome 155 und Firefox 158 (Windows) [S];
 *   je Modul gilt das Maximum beider Engines (konservativ). Die absolute Kapazität in Punkten bestimmt die Kalibrierung
 *   (engine/calibrate.js), nicht diese Tabelle. Safari/iOS/Android sind nicht gemessen [H].
 * `workletModules`: IDs aus engine/worklets.js (Worklet-Registry, Phase 5), die das Modul braucht; `needsWorklet` bleibt als Kurzform.
 * `tail(params)`: Nachklang in Sekunden (derselbe Wert wie estimateTail() in fx-pipeline.js, getestet).
 */

import { IR_IMPULSE_NAMES, getIRDuration } from '../ir-data.js';

/** Schlüssel, die frühere Versionen kannten und das Pipeline-Modell bewusst NICHT mehr trägt (Backup: `…:pre-pipeline`). */
export const REMOVED_KEYS = ['envelope', 'pan', 'output', 'analyzer'];

/** Aktuelle Schema-Revision (AE-19). `effects.rev` fehlt ⇒ 1. Migrationen innerhalb von v:2 hängen sich in schema.js ein. */
export const CURRENT_REV = 1;

const ALL_CONSUMERS = { sound: true, ambient: true, music: true, noise: true };
const c = (base, extra) => ({ base, measured: true, ...(extra || {}) });

/** Faltung (ConvolverNode): Punkte = CONVOLVER_BASE + CONVOLVER_PER_SECOND × IR-Sekunden. Linearer Fit an M-1 (Chrome: 0,35 s → 19, 3,5 s → 167, 5 s → 224; Firefox ≈ 60 % davon) [S]. */
export const CONVOLVER_BASE = 4;
export const CONVOLVER_PER_SECOND = 44;
export const convolverPoints = seconds => CONVOLVER_BASE + CONVOLVER_PER_SECOND * Math.max(0, Number(seconds) || 0);

const filterQ = (def, range, ui) => ({ def, range, label: 'Güte (Q)', ...(ui ? { ui } : {}) });
/** Tief-/Hochpass: Q ist hier die Resonanz in dB (BiquadFilterNode-Semantik für lowpass/highpass), nicht die lineare Güte. */
const filterQdB = (def, range, ui) => ({ def, range, unit: 'dB', label: 'Resonanz', ...(ui ? { ui } : {}) });
/** P10: Flankensteilheit (Zahl als Text, weil das Auswahlfeld Strings liefert) und Mix – Defaults = Altverhalten (eine Stufe, kein Dry-Pfad). */
const SLOPE_OPTIONS = { '12': '12 dB/Okt.', '24': '24 dB/Okt.', '48': '48 dB/Okt.' };
const slopeParam = () => ({ def: '12', enum: ['12', '24', '48'], label: 'Flankensteilheit', ui: { options: SLOPE_OPTIONS } });
const mixParam = () => ({ def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } });
/** Biquad-Stufen je Flankensteilheit (Kosten-Näherung: 1 Punkt je Stufe; Dry-Pfad und Gains vernachlässigt). */
export const slopeStages = p => ({ '48': 4, '24': 2 })[String(p?.slope ?? '12')] ?? 1;
const stageCost = p => ({ base: slopeStages(p), measured: true });
/** Bandpass (10b): Flankensteilheit je Seite 6/12/24 dB/Okt. = 1/2/4 gleiche Biquads (Q wird so skaliert, dass die −3-dB-Bandbreite gleich bleibt). */
const BANDPASS_SLOPE_OPTIONS = { '6': '6 dB/Okt. je Flanke', '12': '12 dB/Okt. je Flanke', '24': '24 dB/Okt. je Flanke' };
const bandpassSlopeParam = () => ({ def: '6', enum: ['6', '12', '24'], label: 'Flankensteilheit', ui: { options: BANDPASS_SLOPE_OPTIONS } });
export const bandpassStages = p => ({ '24': 4, '12': 2 })[String(p?.slope ?? '6')] ?? 1;
const bandpassCost = p => ({ base: bandpassStages(p), measured: true });

/** Parametrischer EQ (10d): Bandtypen, Grenzen und Standardbänder — eine Wahrheit für Schema, Engine und UI. */
export const PEQ_TYPES = ['bell', 'lowShelf', 'highShelf', 'lowCut', 'highCut', 'bandPass', 'notch'];
export const PEQ_TYPE_LABELS = { bell: 'Glocke', lowShelf: 'Low-Shelf', highShelf: 'High-Shelf', lowCut: 'Low-Cut (Hochpass)', highCut: 'High-Cut (Tiefpass)', bandPass: 'Bandpass', notch: 'Notch' };
export const PEQ_MAX_BUILD = 8;       // so viele Bänder baut die Engine
export const PEQ_MAX_KEEP = 16;       // so viele bleiben in den Daten erhalten (AE-18: nichts verwerfen), Bänder ab dem 9. werden nicht gebaut
export const PEQ_RANGES = { freq: [20, 20000], gain: [-24, 24], Q: [0.1, 18] };
/** Welche Felder ein Typ benutzt (Shelves ignorieren Q, Cut/BandPass/Notch ignorieren Gain). */
export const peqGainUsed = type => type === 'bell' || type === 'lowShelf' || type === 'highShelf';
export const peqQUsed = type => type !== 'lowShelf' && type !== 'highShelf';
export const PEQ_DEFAULT_BANDS = [
  { on: true, type: 'lowShelf', freq: 100, gain: 0, Q: 0.7 },
  { on: true, type: 'bell', freq: 400, gain: 0, Q: 1 },
  { on: true, type: 'bell', freq: 2500, gain: 0, Q: 1 },
  { on: true, type: 'highShelf', freq: 8000, gain: 0, Q: 0.7 }
];
/** Aktive (gebaute) Bänder: höchstens PEQ_MAX_BUILD, ausgeschaltete zählen nicht. */
export const peqActiveBands = p => (Array.isArray(p?.bands) ? p.bands : []).slice(0, PEQ_MAX_BUILD).filter(b => b && b.on !== false);
const peqCost = p => ({ base: Math.max(1, peqActiveBands(p).length), measured: true });   // 1 Biquad je Band (gemessener Einheitswert)
/** Steuerquelle der Wah-/Auto-Filter-Module (P10c): LFO (Rate) oder Hüllkurve des Moduleingangs (Worklet `envfollower`; ohne Worklet läuft der LFO). */
const CONTROL_SOURCE_OPTIONS = { lfo: 'LFO (Rate)', envelope: 'Hüllkurve (Lautstärke)' };
const controlSourceParam = def => ({ def, enum: ['lfo', 'envelope'], label: 'Steuerung', ui: { options: CONTROL_SOURCE_OPTIONS } });
const sensitivityParam = () => ({ def: 0.5, range: [0, 1], label: 'Empfindlichkeit', ui: { min: 0, max: 1, step: 0.01, percent: true } });
/** Kosten: Basis (gemessen) + Hüllkurven-Worklet (Schätzwert 3 Punkte, „leichtes Worklet“, bis zur Messung nicht gemessen). */
export const ENVELOPE_WORKLET_POINTS = 3;
const envCost = base => p => (p?.source === 'envelope' ? { base: base + ENVELOPE_WORKLET_POINTS, measured: false, estimate: 'envfollower' } : { base, measured: true });

export const MODULES = [
  { key: 'lowpass', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'filter', label: 'Tiefpass', layerOrder: 20, consumers: ALL_CONSUMERS, cost: stageCost,
    params: { frequency: { def: 20000, range: [20, 20000], unit: 'Hz', label: 'Grenzfrequenz', ui: { min: 100, max: 20000, step: 50, scale: 'log', digits: 0 } }, Q: filterQdB(0.7, [0.1, 20], { min: 0.1, max: 10, step: 0.1, digits: 1 }), slope: slopeParam(), mix: mixParam() } },
  { key: 'highpass', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'filter', label: 'Hochpass', layerOrder: 10, consumers: ALL_CONSUMERS, cost: stageCost,
    params: { frequency: { def: 20, range: [20, 20000], unit: 'Hz', label: 'Grenzfrequenz', ui: { min: 20, max: 5000, step: 10, scale: 'log', digits: 0 } }, Q: filterQdB(0.7, [0.1, 20], { min: 0.1, max: 10, step: 0.1, digits: 1 }), slope: slopeParam(), mix: mixParam() } },
  { key: 'notch', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'filter', label: 'Notch (Kerbfilter)', layerOrder: 30, consumers: ALL_CONSUMERS, cost: c(1),
    params: { frequency: { def: 50, range: [20, 20000], unit: 'Hz', label: 'Frequenz', ui: { min: 20, max: 2000, step: 1, scale: 'log', digits: 0 } }, Q: filterQ(10, [0.5, 30], { min: 0.5, max: 30, step: 0.5, digits: 1 }),
      depth: { def: 1, range: [0, 1], label: 'Tiefe', ui: { min: 0, max: 1, step: 0.01, percent: true } } } },
  { key: 'wahwah', ui: { generated: true }, family: 'filter', label: 'Wah-Wah', layerOrder: 40, consumers: ALL_CONSUMERS, cost: envCost(4), workletModules: ['envfollower'] /* nur bei source = 'envelope' (worklets.js) */,
    params: {
      frequency: { def: 800, range: [100, 5000], unit: 'Hz', label: 'Mittenfrequenz', ui: { min: 100, max: 5000, step: 10, scale: 'log', digits: 0 } },
      depth: { def: 0.7, range: [0, 1], label: 'Tiefe', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      rate: { def: 2, range: [0.1, 10], unit: 'Hz', label: 'Rate', ui: { min: 0.1, max: 10, step: 0.1 } },
      resonance: { def: 5, range: [1, 20], label: 'Resonanz', ui: { min: 1, max: 20, step: 0.5 } },
      source: controlSourceParam('lfo'),
      sensitivity: sensitivityParam()
    } },
  { key: 'reverb', stageHint: p => ((p?.duration ?? 0) >= 1.5 ? { stage: 'environment', weight: 2 } : null), ui: { generated: true }, family: 'space', label: 'Hall (algorithmisch)', layerOrder: 110, consumers: ALL_CONSUMERS,
    cost: p => ({ base: convolverPoints(p?.duration ?? 2.2), measured: true }), degrade: { irLength: true },
    tail: p => p?.duration ?? 2.2,
    params: {
      amount: { def: 0.35, range: [0, 1], label: 'Anteil (Wet)', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      duration: { def: 2.2, range: [0.05, 10], unit: 's', label: 'Dauer', ui: { min: 0.1, max: 10, step: 0.1 } },
      decay: { def: 2.0, range: [0.1, 10], label: 'Abklingen', ui: { min: 0.1, max: 6, step: 0.1 } }
    } },
  { key: 'delay', stageHint: p => ((p?.time ?? 0) >= 0.12 ? { stage: 'environment', weight: 1 } : null), ui: { generated: true }, family: 'space', label: 'Echo (Delay)', layerOrder: 120, consumers: ALL_CONSUMERS, cost: c(4),
    tail: p => {
      const time = Math.max(0.01, p?.time ?? 0.22);
      const fb = Math.max(0, Math.min(0.95, p?.feedback ?? 0.35));
      const repeats = fb > 0 ? Math.min(60, Math.ceil(Math.log(0.001) / Math.log(fb))) : 1;
      return Math.min(10, time * repeats);
    },
    params: {
      time: { def: 0.22, range: [0, 2], unit: 's', label: 'Zeit', ui: { min: 0.01, max: 2, step: 0.01 } },
      feedback: { def: 0.35, range: [0, 0.95], label: 'Rückkopplung', ui: { min: 0, max: 0.95, step: 0.01, percent: true } },
      wet: { def: 0.35, range: [0, 1], label: 'Anteil (Wet)', ui: { min: 0, max: 0.95, step: 0.01, percent: true } }
    } },
  { key: 'chorus', stageHint: { stage: 'source', weight: 1 }, ui: { generated: true }, family: 'modulation', label: 'Chorus', layerOrder: 90, consumers: ALL_CONSUMERS, cost: c(4),
    params: {
      baseDelay: { def: 15, range: [1, 40], unit: 'ms', label: 'Grundverzögerung', ui: { min: 5, max: 40, step: 0.5 } },
      depth: { def: 8, range: [0, 20], unit: 'ms', label: 'Tiefe', ui: { min: 0, max: 20, step: 0.5 } },
      rate: { def: 0.8, range: [0.01, 10], unit: 'Hz', label: 'Rate', ui: { min: 0.01, max: 10, step: 0.01 } },
      mix: { def: 0.3, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  { key: 'flanger', stageHint: { stage: 'source', weight: 1 }, ui: { generated: true }, family: 'modulation', label: 'Flanger', layerOrder: 100, consumers: ALL_CONSUMERS, cost: c(7),
    params: {
      baseDelay: { def: 2, range: [0.5, 10], unit: 'ms', label: 'Grundverzögerung', ui: { min: 0.5, max: 5, step: 0.1 } },
      depth: { def: 1.5, range: [0, 10], unit: 'ms', label: 'Tiefe', ui: { min: 0, max: 10, step: 0.1 } },
      rate: { def: 0.2, range: [0.01, 10], unit: 'Hz', label: 'Rate', ui: { min: 0.01, max: 10, step: 0.01 } },
      feedback: { def: 0.5, range: [0, 0.95], label: 'Rückkopplung', ui: { min: 0, max: 0.95, step: 0.01, percent: true } },
      mix: { def: 0.5, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  { key: 'tremolo', ui: { generated: true }, family: 'modulation', label: 'Tremolo', layerOrder: 130, consumers: ALL_CONSUMERS, cost: c(2),
    params: {
      rate: { def: 5, range: [0.1, 20], unit: 'Hz', label: 'Rate', ui: { min: 0.1, max: 20, step: 0.1 } },
      depth: { def: 0.5, range: [0, 1], label: 'Tiefe', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      waveform: { def: 'sine', enum: ['sine', 'triangle', 'square'], label: 'Wellenform', ui: { options: { sine: 'Sinus', triangle: 'Dreieck', square: 'Rechteck' } } }
    } },
  { key: 'eq', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'eq', label: '3-Band-EQ', layerOrder: 50, consumers: ALL_CONSUMERS, cost: c(3),
    params: {
      low: { def: 0, range: [-18, 18], unit: 'dB', label: 'Tiefen', ui: { min: -18, max: 18, step: 1, signed: true } },
      mid: { def: 0, range: [-18, 18], unit: 'dB', label: 'Mitten', ui: { min: -18, max: 18, step: 1, signed: true } },
      high: { def: 0, range: [-18, 18], unit: 'dB', label: 'Höhen', ui: { min: -18, max: 18, step: 1, signed: true } }
    } },
  { key: 'eq10', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'eq', label: '10-Band-EQ', layerOrder: 50, consumers: ALL_CONSUMERS, cost: c(12),
    params: { bands: { def: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bands: true, label: 'Bänder', ui: { gain: { min: -18, max: 18, step: 1 }, q: { min: 0.3, max: 10, step: 0.1, def: 1.4 } } } } },
  { key: 'compressor', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Kompressor', layerOrder: 60, consumers: ALL_CONSUMERS, cost: c(12.5),
    params: {
      threshold: { def: -24, range: [-60, 0], unit: 'dB', label: 'Schwelle', ui: { min: -60, max: 0, step: 1 } },
      knee: { def: 30, range: [0, 40], unit: 'dB', label: 'Knie', ui: { min: 0, max: 40, step: 1 } },
      ratio: { def: 12, range: [1, 20], label: 'Verhältnis', ui: { min: 1, max: 20, step: 0.5, unit: ':1' } },
      attack: { def: 0.003, range: [0, 1], unit: 's', label: 'Attack', ui: { min: 0.0001, max: 0.5, step: 0.001, display: { factor: 1000, unit: 'ms' } } },
      release: { def: 0.25, range: [0, 1], unit: 's', label: 'Release', ui: { min: 0.01, max: 1, step: 0.01, display: { factor: 1000, unit: 'ms' } } }
    } },
  { key: 'limiter', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Limiter', layerOrder: 60, consumers: ALL_CONSUMERS, cost: c(16),
    params: {
      threshold: { def: -1, range: [-24, 0], unit: 'dB', label: 'Schwelle', ui: { min: -20, max: 0, step: 0.5 } },
      knee: { def: 0, raw: true, unit: 'dB', label: 'Knie', ui: { hidden: true } },
      ratio: { def: 20, raw: true, label: 'Verhältnis', ui: { hidden: true } },
      attack: { def: 0.001, raw: true, unit: 's', label: 'Attack', ui: { hidden: true } },
      release: { def: 0.08, raw: true, unit: 's', label: 'Release', ui: { hidden: true } }
    } },
  { key: 'distortion', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'distortion', label: 'Verzerrung', layerOrder: 70, consumers: ALL_CONSUMERS,
    cost: p => ({ base: ({ none: 1, '2x': 5, '4x': 10 })[p?.oversample ?? '4x'] ?? 10, measured: true }), degrade: { oversample: true },
    // mode: softClip (Standard), hardClip oder bitcrush. Presets ohne „mode“-Feld fallen über den switch-default in
    // _buildDistortionCurve() auf softClip zurück — kein Migrationsschritt nötig.
    params: {
      mode: { def: 'softClip', enum: ['softClip', 'hardClip', 'bitcrush'], label: 'Modus', ui: { options: { softClip: 'Weich (Sättigung)', hardClip: 'Hart (Clipping)', bitcrush: 'Bitcrush (Lo-Fi)' } } },
      amount: { def: 40, range: [0, 100], label: 'Stärke', ui: { min: 0, max: 100, step: 1 } },
      oversample: { def: '4x', enum: ['none', '2x', '4x'], label: 'Oversampling', ui: { options: { none: 'Kein', '2x': '2×', '4x': '4×' } } }
    } },
  { key: 'ringmod', stageHint: { stage: 'source', weight: 2 }, ui: { generated: true }, family: 'distortion', label: 'Ringmodulation', layerOrder: 80, consumers: ALL_CONSUMERS, cost: c(2.5),
    params: {
      frequency: { def: 440, range: [20, 5000], unit: 'Hz', label: 'Trägerfrequenz', ui: { min: 20, max: 5000, step: 1, scale: 'log', digits: 0 } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  { key: 'pitchShift', stageHint: { stage: 'source', weight: 2 }, ui: { generated: true }, family: 'voice', label: 'Tonhöhe', layerOrder: 0, consumers: ALL_CONSUMERS, needsWorklet: true, workletModules: ['pitch'], cost: c(28),
    params: { semitones: { def: 0, range: [-24, 24], unit: 'Halbtöne', label: 'Halbtöne', ui: { min: -12, max: 12, step: 1, signed: true } } } },
  { key: 'irReverb', stageHint: { stage: 'environment', weight: 3 }, ui: { generated: true }, family: 'space', label: 'Hall (Impulsantwort)', layerOrder: 110, consumers: ALL_CONSUMERS,
    cost: p => ({ base: convolverPoints(getIRDuration(p?.impulse ?? null)), measured: true }), degrade: { irLength: true },
    tail: p => getIRDuration(p?.impulse ?? null),
    params: {
      impulse: { def: null, impulse: true, label: 'Raum', ui: { emptyLabel: 'Standard', options: {
        small_room: '📦 Kleiner Raum', hallway: '🏢 Flur', bathroom: '🚿 Badezimmer', tight_room: '🔲 Enges Zimmer', cave: '🏔️ Höhle',
        tunnel: '🚇 Tunnel', cathedral: '⛪ Kathedrale', huge_hall: '🏛️ Riesiger Saal', plate: '🪩 Plate' } } },
      wet: { def: 0.35, range: [0, 1], label: 'Anteil (Wet)', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  { key: 'spatial', ui: { generated: true }, family: 'position', label: 'Räumliche Position (3D)', layerOrder: 150, consumers: ALL_CONSUMERS, cost: c(4), degrade: { hrtf: true },
    params: {
      x: { def: 0, range: [-1000, 1000], label: 'X (links ↔ rechts)', ui: { min: -10, max: 10, step: 0.1 } },
      y: { def: 0, range: [-1000, 1000], label: 'Y (unten ↔ oben)', ui: { min: -10, max: 10, step: 0.1 } },
      z: { def: -1, range: [-1000, 1000], label: 'Z (vorn ↔ hinten)', ui: { min: -10, max: 10, step: 0.1 } },
      rolloff: { def: 1, range: [0, 10], label: 'Rolloff', ui: { min: 0, max: 5, step: 0.1 } },
      maxDistance: { def: 10000, range: [1, 100000], label: 'Max. Distanz', ui: { hidden: true } },
      refDistance: { def: 1, range: [0, 1000], label: 'Referenzdistanz', ui: { hidden: true } },
      coneInnerAngle: { def: 360, range: [0, 360], unit: '°', label: 'Kegel innen', ui: { hidden: true } },
      coneOuterAngle: { def: 360, range: [0, 360], unit: '°', label: 'Kegel außen', ui: { hidden: true } },
      coneOuterGain: { def: 0, range: [0, 1], label: 'Kegel-Restpegel', ui: { hidden: true } }
    } },
  // attack/release: Compressor-Näherung (siehe _collectSegments). Presets ohne diese Felder funktionieren unverändert,
  // da die Engine sie mit `?? 5`/`?? 150` defaultet. (B-03: ersetzt in Phase 11 durch ein echtes Gate.)
  { key: 'noiseGate', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Noise Gate', layerOrder: 140, consumers: ALL_CONSUMERS, cost: c(17.5),
    params: {
      threshold: { def: -50, range: [-100, 0], unit: 'dB', label: 'Schwelle', ui: { min: -80, max: -10, step: 1 } },
      attack: { def: 5, range: [0, 1000], unit: 'ms', label: 'Attack', ui: { hidden: true } },
      release: { def: 150, range: [0, 2000], unit: 'ms', label: 'Release', ui: { hidden: true } }
    } },
  // ── P10 (Schritt 10b): neue Module stehen am ENDE der Liste (Reihenfolge in defaultEffects()); die Position im Layer bestimmt layerOrder ──
  { key: 'bandpass', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'filter', label: 'Bandpass', layerOrder: 35, consumers: ALL_CONSUMERS, cost: bandpassCost,
    params: { frequency: { def: 1000, range: [20, 20000], unit: 'Hz', label: 'Mittenfrequenz', ui: { min: 50, max: 15000, step: 10, scale: 'log', digits: 0 } }, Q: filterQ(1, [0.1, 30], { min: 0.3, max: 20, step: 0.1, digits: 1 }), slope: bandpassSlopeParam(), mix: mixParam() } },
  // Auto-Filter (10c): Filter, dessen Grenzfrequenz von LFO oder Hüllkurve des Eingangs gesteuert wird (Modulation in Cent, also musikalisch exponentiell)
  { key: 'autoFilter', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'filter', label: 'Auto-Filter', layerOrder: 45, consumers: ALL_CONSUMERS, cost: envCost(3), workletModules: ['envfollower'],
    params: {
      filterType: { def: 'lowpass', enum: ['lowpass', 'bandpass', 'highpass'], label: 'Filtertyp', ui: { options: { lowpass: 'Tiefpass', bandpass: 'Bandpass', highpass: 'Hochpass' } } },
      source: controlSourceParam('envelope'),
      frequency: { def: 600, range: [50, 10000], unit: 'Hz', label: 'Grundfrequenz', ui: { min: 50, max: 10000, step: 10, scale: 'log', digits: 0 } },
      depth: { def: 0.7, range: [0, 1], label: 'Tiefe', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      rate: { def: 2, range: [0.1, 10], unit: 'Hz', label: 'Rate (LFO)', ui: { min: 0.1, max: 10, step: 0.1 } },
      resonance: { def: 3, range: [0.5, 20], label: 'Resonanz (Q)', ui: { min: 0.5, max: 20, step: 0.5 } },
      sensitivity: sensitivityParam()
    } },
  // Parametrischer EQ (10d): bis zu 8 Bänder (Glocke, Shelves, Cuts, Bandpass, Notch), Daten als Bänderliste mit Objekten { on, type, freq, gain, Q }
  { key: 'paramEq', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'eq', label: 'Parametrischer EQ', layerOrder: 52, consumers: ALL_CONSUMERS, cost: peqCost,
    params: { bands: { def: PEQ_DEFAULT_BANDS, bandList: true, label: 'Bänder' } } }
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

const cloneDef = v => (Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? { ...x } : x)) : v);   // Bänderlisten (P10d) enthalten Objekte

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
