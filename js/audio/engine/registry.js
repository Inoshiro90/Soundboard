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
 *   { def:[…], tapList:true }               Tap-Liste des Multi-Tap-Delays (14b): {on, time, level, panorama, feedback} je Tap (schema.js normalizeDelayTap)
 *   { def:[…], pointList:true }             Kurvenpunkte des Waveshapers (15b): {x, y} je Punkt (schema.js normalizeShaperPoint)
 *
 * `ui` (Modul): `{ generated: true }` — das Formular erzeugt das Modul aus dieser Registry (ui/effects/, Phase 8); es gibt kein handgeschriebenes
 *   Effekt-HTML mehr. (`enabledId` entfiel mit dem Abbau des alten Formulars; Suite 09 prüft, dass jedes Modul `generated` ist.)
 * `ui` (Parameter, optional): `{ hidden?, min?, max?, step?, scale?:'lin'|'log', digits?, percent?, display?, signed?, unit?, options?, emptyLabel?, showIf? }`
 *   (showIf `{ feld: [Werte…] }`, Phase 13e: Regler nur sichtbar, wenn ALLE genannten Felder desselben Moduls einen der Werte haben; der Wert bleibt erhalten) (percent: Daten 0…1, Anzeige 0…100 %; display `{factor,unit}`: andere Anzeigeeinheit, z. B. s → ms; signed: „+“ bei positiven Werten; options: Beschriftungen einer Aufzählung) — Darstellung im Regler. Fehlt `ui`, wird der
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
import { DISTORTION_LEGACY_MODES, DISTORTION_V2_MODES, DIST_DRIVE_RANGE, DIST_BIAS_RANGE, WS_DEFAULT_POINTS, TAPE_BASE_DELAY_S, TAPE_WOW_MAX_S, TAPE_FLUTTER_MAX_S } from './distortion-curves.js';
export { WS_POINTS_MAX, WS_POINT_RANGES, WS_DEFAULT_POINTS } from './distortion-curves.js';
import { CRUSHER_BITS_RANGE, CRUSHER_RATE_RANGE } from '../dsp-lib/crusher.js';

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
/** P11a: Dynamik im Worklet `dynamics` — Schätzwert, solange M-1 es nicht gemessen hat (Suite 13). */
const DYNAMICS_WORKLET_POINTS = 5;
const dynamicsCost = () => ({ base: DYNAMICS_WORKLET_POINTS, measured: false, estimate: 'dynamics' });
// Limiter mit Lookahead (Phase 11b): Worklet plus Verzögerungsleitung; Schätzwert bis M-1 für das Worklet `dynamics` vorliegt.
// Phase 11e: 3 Kompressoren (je 12,5, gemessen) + 9 Biquads der LR4-Weiche (je ≈ 1); mit Parallelanteil (mix < 1) je Band ein Delay (+2). Schätzwert bis M-1.
const multibandCost = p => ({ base: 3 * 12.5 + 9 + ((p?.mix ?? 1) < 1 ? 6 : 0), measured: false, estimate: 'multiband' });
const limiterCost = () => ({ base: DYNAMICS_WORKLET_POINTS + 1, measured: false, estimate: 'dynamics' });
/** Phase 12: Modulationsmodule mit LFO-Wellenform aus PeriodicWave, Kanaltrennung und Gains — Schätzwerte bis M-1 (`estimate: 'modulation'`). */
const tremoloCost = p => (p?.stereo === 'on' ? { base: 3, measured: false, estimate: 'modulation' } : { base: 2, measured: true });
const autoPanCost = () => ({ base: 4, measured: false, estimate: 'modulation' });
/** Chorus-Stimmen (12b): 1 im Altmodus, 3 im Ensemble, sonst `voices`. */
/** K3: höchstens CHORUS_MAX_VOICES Stimmen (vorher 4; Daten 1–4 unverändert). */
export const CHORUS_MAX_VOICES = 8;
export const chorusVoices = p => (p?.mode === 'ensemble' ? 3 : Math.max(1, Math.min(CHORUS_MAX_VOICES, Math.round(Number(p?.voices) || 1))));
export const chorusIsMulti = p => p?.mode === 'ensemble' || chorusVoices(p) > 1;
const chorusCost = p => (chorusIsMulti(p) ? { base: 4 * chorusVoices(p) + 2, measured: false, estimate: 'modulation' } : { base: 4, measured: true });
const vibratoCost = () => ({ base: 4, measured: false, estimate: 'modulation' });
/** Phaser (12d): Worklet `delayline` (Koeffizienten je Sample) — Schätzwert wächst mit der Stufenzahl. */
const phaserCost = p => ({ base: 4 + Math.max(2, Math.min(12, Number(p?.stages) || 4)) / 2, measured: false, estimate: 'delayline' });
/** Phase 13a: Stereo-Module (Kanalmatrix aus Gains; Breite mit Kurzverzögerung, Bass-Mono + 2 Biquads LR4 und Allpass) — Schätzwerte bis M-1 (`estimate: 'stereo'`). */
const utilityCost = () => ({ base: 2, measured: false, estimate: 'stereo' });
const widthCost = p => ({ base: 4 + (p?.bassMono === 'on' ? 3 : 0), measured: false, estimate: 'stereo' });
/** Phase 13b: Mid/Side (2 × 3 Biquads + Gains), Stereo-Shaper (LR4-Dreibandweiche 9 Biquads + 2 Allpässe für die Mitte + Gains) — Schätzwerte. */
const midSideCost = () => ({ base: 8, measured: false, estimate: 'stereo' });
const stereoShaperCost = () => ({ base: 13, measured: false, estimate: 'stereo' });
/** Phase 13c: Haas (2 Verzögerungen + 2 Gains hinter dem Hochmischer) — Schätzwert. */
const haasCost = () => ({ base: 3, measured: false, estimate: 'stereo' });
/** Phase 13f: Doppler (Hochmischer, 1 Verzögerung, 1 Biquad, 2 Gains; Automation ohne Knoten) — Schätzwert. */
const dopplerCost = () => ({ base: 4, measured: false, estimate: 'stereo' });
/**
 * Delay v2 (Phase 14a) — eine Wahrheit für Registry, Engine und Tests.
 * Neutralwerte: lowCut = 20 Hz und highCut = 20 kHz heißen „aus“, modDepth = 0 heißt „keine Modulation“.
 */
export const DELAY_MODES = ['mono', 'stereo', 'pingpong', 'multitap'];
export const DELAY_MODE_LABELS = { mono: 'Mono (ein Echo)', stereo: 'Stereo (Zeit je Seite)', pingpong: 'Ping-Pong (abwechselnd L/R)', multitap: 'Multi-Tap (mehrere Echos)' };
/**
 * Multi-Tap (Phase 14b): Liste `taps` je { on, time (s), level (0–1, linear), panorama (−1 … +1), feedback (0–0,95) } (+ unbekannte Felder bleiben, AE-18).
 * Die Engine baut die ersten DELAY_TAPS_MAX_BUILD Taps, die Daten behalten bis DELAY_TAPS_MAX_KEEP (wie die PEQ-Bänder).
 */
export const DELAY_TAPS_MAX_BUILD = 8;
export const DELAY_TAPS_MAX_KEEP = 16;
export const DELAY_TAP_RANGES = { time: [0.01, 2], level: [0, 1], panorama: [-1, 1], feedback: [0, 0.95] };
export const DELAY_DEFAULT_TAPS = [
  { on: true, time: 0.15, level: 0.8, panorama: -0.6, feedback: 0 },
  { on: true, time: 0.3, level: 0.6, panorama: 0.6, feedback: 0 },
  { on: true, time: 0.45, level: 0.4, panorama: 0, feedback: 0 }
];
/** Indizes der gebauten Taps (die ersten DELAY_TAPS_MAX_BUILD Einträge, davon die eingeschalteten). */
export const delayActiveTaps = p => (Array.isArray(p?.taps) ? p.taps : []).slice(0, DELAY_TAPS_MAX_BUILD).map((t, i) => [t, i]).filter(([t]) => t && typeof t === 'object' && t.on !== false);
export const DELAY_LOWCUT_OFF = 20;
export const DELAY_HIGHCUT_OFF = 20000;
export const DELAY_MOD_MAX_MS = 10;
/** Kleinste Verzögerung in der Engine (s); liegt bei allen üblichen Abtastraten über 128 Samples (Rückkopplungszyklus, Plan P14). */
export const DELAY_MIN_S = 0.01;
/** Größte Schleifenverstärkung (Rückkopplung + Kreuz-Rückkopplung), damit sich nichts aufschaukelt. */
export const DELAY_MAX_LOOP_GAIN = 0.95;
const _fin = (v, d) => (Number.isFinite(v) ? v : d);
const _clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
/** Gültiger Modus (unbekannt → mono, wie die Schemaklemmung). */
export const delayMode = p => (DELAY_MODES.includes(p?.mode) ? p.mode : 'mono');
/** true = bisheriges Delay (Modus mono, alle neuen Felder neutral): Engine baut den unveränderten Graphen, Tail wie bisher. */
export function delayIsLegacy(p) {
  return delayMode(p) === 'mono' && !(_fin(p?.lowCut, DELAY_LOWCUT_OFF) > DELAY_LOWCUT_OFF) && !(_fin(p?.highCut, DELAY_HIGHCUT_OFF) < DELAY_HIGHCUT_OFF) && !(_fin(p?.modDepth, 0) > 0);
}
/** Rückkopplung und Kreuz-Rückkopplung (Stereo) nach der Begrenzung: Summe ≤ DELAY_MAX_LOOP_GAIN (beide gleich skaliert). */
export function delayLoopGains(p) {
  const fb = _clamp(0, 0.95, _fin(p?.feedback, 0.35));
  const x = delayMode(p) === 'stereo' ? _clamp(0, 0.95, _fin(p?.crossFeedback, 0)) : 0;
  const s = fb + x > DELAY_MAX_LOOP_GAIN ? DELAY_MAX_LOOP_GAIN / (fb + x) : 1;
  return { fb: fb * s, cross: x * s };
}
/**
 * Nachklang (s). Bisheriges Delay: unveränderte Formel (höchstens 60 Wiederholungen, höchstens 10 s). Sonst (Entscheidung B, P14):
 * Zeit · ⌈ln 0,001 / ln g⌉ mit der Schleifenverstärkung g (Stereo: fb + cross, längere Seite), zuzüglich Modulationstiefe; Grenze nur die 30 s des Exports.
 */
export function delayTailSeconds(p) {
  if (delayIsLegacy(p)) {
    const time = Math.max(0.01, p?.time ?? 0.22);
    const fb = Math.max(0, Math.min(0.95, p?.feedback ?? 0.35));
    const repeats = fb > 0 ? Math.min(60, Math.ceil(Math.log(0.001) / Math.log(fb))) : 1;
    return Math.min(10, time * repeats);
  }
  const t = v => _clamp(DELAY_MIN_S, 2, _fin(v, 0.22));
  const mode = delayMode(p), { fb, cross } = delayLoopGains(p);
  const depthS = _clamp(0, DELAY_MOD_MAX_MS, _fin(p?.modDepth, 0)) / 1000;
  if (mode === 'multitap') {
    // je Tap: Zeit · Wiederholungen der eigenen Rückkopplung; das längste zählt
    let m = 0;
    for (const [tp] of delayActiveTaps(p)) {
      const g = _clamp(0, 0.95, _fin(tp.feedback, 0));
      m = Math.max(m, t(tp.time) * (g > 0 ? Math.ceil(Math.log(0.001) / Math.log(g)) : 1));
    }
    return Math.min(30, m + depthS);
  }
  const T = mode === 'stereo' ? Math.max(t(p?.timeL), t(p?.timeR ?? 0.33)) : t(p?.time);
  const g = fb + cross;
  const repeats = g > 0 ? Math.ceil(Math.log(0.001) / Math.log(g)) : 1;
  return Math.min(30, T * repeats + depthS);
}
/** Multiband-Delay (14c): Bänder in Weichen-Reihenfolge; Feldnamen <band>Time/Feedback/Level. */
export const DMB_BANDS = ['low', 'mid', 'high'];
/** Weichenfrequenzen (Hz), geklemmt; die obere liegt immer mindestens eine Oktave über der unteren. */
export function delayMultibandCross(p) {
  const f1 = _clamp(40, 1000, _fin(p?.crossLow, 300));
  return [f1, Math.max(2 * f1, _clamp(1000, 12000, _fin(p?.crossHigh, 3000)))];
}
/** Werte eines Bandes, geklemmt wie in der Engine: { time (s, ≥ DELAY_MIN_S), feedback, level }. */
export function delayMultibandBand(p, b) {
  const d = { low: [0.3, 0.4], mid: [0.2, 0.3], high: [0.12, 0.2] }[b];
  return { time: _clamp(DELAY_MIN_S, 2, _fin(p?.[b + 'Time'], d[0])), feedback: _clamp(0, 0.95, _fin(p?.[b + 'Feedback'], d[1])), level: _clamp(0, 1, _fin(p?.[b + 'Level'], 1)) };
}
/** Nachklang: längste Bandfahne (Zeit · ⌈ln 0,001 / ln fb⌉), stumme Bänder zählen nicht; höchstens 30 s. */
export function delayMultibandTail(p) {
  let m = 0;
  for (const b of DMB_BANDS) {
    const v = delayMultibandBand(p, b);
    if (!(v.level > 0)) continue;
    m = Math.max(m, v.time * (v.feedback > 0 ? Math.ceil(Math.log(0.001) / Math.log(v.feedback)) : 1));
  }
  return Math.min(30, m);
}
/** Kosten: bisheriges Delay gemessen (4); erweiterte Graphen Schätzwert aus der Knotenzahl (M-1 steht aus). */
const delayCost = p => {
  if (delayIsLegacy(p)) return { base: 4, measured: true };
  const m = delayMode(p);
  if (m === 'multitap') return { base: 3 + 7 * delayActiveTaps(p).length, measured: false, estimate: 'delay' };   // Hochmischer/Summe + je Tap Delay, 2 Biquads, Pegel, Panner, Rückkopplung, Sättigung
  return { base: m === 'mono' ? 8 : m === 'stereo' ? 16 : 15, measured: false, estimate: 'delay' };
};
/**
 * Verzerrung v2 (Phase 15a) — eine Wahrheit für Registry, Engine und Tests.
 * Bisherige Modi (softClip/hardClip/bitcrush) mit neutralen neuen Feldern (Ton 20 kHz = offen, Ausgang 0 dB, Mix 100 %) = bisherige Verzerrung
 * (ein WaveShaper, bit-gleich). Drive und Bias gelten nur für die neuen Modi; in den bisherigen Modi wirkt weiter „Stärke“ (amount).
 */
export const DISTORTION_MODES = [...DISTORTION_LEGACY_MODES, ...DISTORTION_V2_MODES];
export const DISTORTION_MODE_LABELS = {
  softClip: 'Weich (Sättigung)', hardClip: 'Hart (Clipping)', bitcrush: 'Bitcrush (Lo-Fi)',
  saturation: 'Sättigung (warm, symmetrisch)', tube: 'Röhre (gerade Obertöne)', overdrive: 'Overdrive (Knie)', fuzz: 'Fuzz (fast Rechteck)', fold: 'Foldback (Faltung)',
  tape: 'Tape (Band, Wow/Flutter)', waveshaper: 'Waveshaper (eigene Kurve)'
};
export const DISTORTION_TONE_OFF = 20000;
/** Gültiger Modus (unbekannt → softClip, wie die Schemaklemmung und der switch-default der bisherigen Kurve). */
export const distortionMode = p => (DISTORTION_MODES.includes(p?.mode) ? p.mode : 'softClip');
/** true = bisherige Verzerrung: bisheriger Modus und Ton/Ausgang/Mix neutral. */
export function distortionIsLegacy(p) {
  return DISTORTION_LEGACY_MODES.includes(distortionMode(p)) && !(_fin(p?.tone, DISTORTION_TONE_OFF) < DISTORTION_TONE_OFF)
    && _fin(p?.output, 0) === 0 && !(_fin(p?.mix, 1) < 1);
}
const OS_POINTS = { none: 1, '2x': 5, '4x': 10 };
/** Kosten: bisherige Verzerrung gemessen (je Oversampling); erweitert Schätzwert: WaveShaper + Ton-Tiefpass + DC-Blocker + Dry-Verzögerung + Gains. */
const distortionCost = p => {
  const os = OS_POINTS[p?.oversample ?? '4x'] ?? 10;
  if (distortionIsLegacy(p)) return { base: os, measured: true };
  // Tape (15b) zusätzlich: Höhen-Tiefpass, modulierte Verzögerung, 2 Oszillatoren, 2 Gains
  return { base: os + 4 + (distortionMode(p) === 'tape' ? 4 : 0), measured: false, estimate: 'distortion' };
};
/**
 * Crusher (Phase 15c): Werte für Worklet und Ersatzgraph, geklemmt — eine Wahrheit für Engine und Tests.
 * bits ganzzahlig 1–16; rate = Zielrate in Hz (≥ Samplerate: keine Reduktion); jitter, mix 0…1.
 */
export const crusherValues = q => ({
  bits: Math.round(_clamp(CRUSHER_BITS_RANGE[0], CRUSHER_BITS_RANGE[1], _fin(q?.bits, 8))),
  rate: _clamp(CRUSHER_RATE_RANGE[0], CRUSHER_RATE_RANGE[1], _fin(q?.targetRate, 8000)),
  jitter: _clamp(0, 1, _fin(q?.jitter, 0)),
  mix: _clamp(0, 1, _fin(q?.mix, 1))
});
/**
 * Frequenzschieber (Phase 16): Werte für den Graphen, geklemmt — eine Wahrheit für Engine und Tests.
 * shift in Hz (−1000 … +1000; negativ = nach unten), mix 0…1.
 */
export const FREQ_SHIFT_RANGE = [-1000, 1000];
/** Phase 16b: Stereo-Spreizung (Hz; links +, rechts −) und Rückkopplung (Anteil, ≤ 0,9 — die Schleife hat Verstärkung 1, s. effect-graph.js). */
export const FREQ_SHIFT_SPREAD_RANGE = [0, 200];
export const FREQ_SHIFT_FEEDBACK_MAX = 0.9;
/** Verzögerung in der Rückkopplungsschleife: genau ein Render-Quantum (128 Samples; Mindestwert für Zyklen in Chromium, Entscheidung A aus P14). */
export const FREQ_SHIFT_LOOP_SAMPLES = 128;
/** Schutzfilter in der Schleife (Hz): Hoch-/Tiefpass 2. Ordnung, weil das Hilbert-Paar nahe 0 Hz und Nyquist versagt (Verstärkung bis √2). */
export const FREQ_SHIFT_LOOP_HP = 25;
export const FREQ_SHIFT_LOOP_LP = 18000;
/** Einblendung der Rückkopplung beim Aufbau (Zeitkonstante, s; Phasenende 16): Die Einsatz-Transiente der Hilbert-Filter läuft so nicht voll durch die Schleife (20 ms: Klickmaß 1,27, 40 ms: 1,16 [S Chromium 153]). */
export const FREQ_SHIFT_LOOP_FADE_S = 0.04;
export const freqShiftValues = q => ({
  shift: _clamp(FREQ_SHIFT_RANGE[0], FREQ_SHIFT_RANGE[1], _fin(q?.shift, 100)),
  mix: _clamp(0, 1, _fin(q?.mix, 1)),
  spread: _clamp(FREQ_SHIFT_SPREAD_RANGE[0], FREQ_SHIFT_SPREAD_RANGE[1], _fin(q?.stereoSpread, 0)),
  feedback: _clamp(0, FREQ_SHIFT_FEEDBACK_MAX, _fin(q?.feedback, 0))
});
/** Strukturelle Signatur (16b): Spreizung > 0 (zweikanalig, vier Oszillatoren) und Rückkopplung > 0 (Schleife) — Wechsel = Neubau mit Überblendung. */
export const freqShiftSig = q => { const v = freqShiftValues(q); return `${v.spread > 0 ? 's' : '-'}${v.feedback > 0 ? 'f' : '-'}`; };
/**
 * Nachklang (16b): Umläufe der Schleife bis −60 dB plus das Ausschwingen des Hilbert-Paars nahe 0 Hz (Pole bis |z| = 0,9988 → FREQ_SHIFT_RING_S).
 * Je Umlauf 2 × 128 Samples bei 44,1 kHz (längster Fall): Chromium verzögert jeden nativen Rückkopplungszyklus um weitere 128 Samples (bekannt,
 * Entscheidung A P14, nicht ausgeglichen). Gemessen bei 90 % [S]: −60 dB nach ≤ 0,34 s (Node) bzw. ≤ 0,41 s (Chromium 153). Ohne Rückkopplung 0 (wie 16a).
 */
export const FREQ_SHIFT_RING_S = 0.25;
const freqShiftTail = p => { const g = freqShiftValues(p).feedback; return g > 0 ? Math.ceil(3 / -Math.log10(g)) * 2 * FREQ_SHIFT_LOOP_SAMPLES / 44100 + FREQ_SHIFT_RING_S : 0; };
/** Kosten (16b, Schätzwerte bis M-1): Kern 4 (2 IIR 8. Ordnung, 2 Oszillatoren, Gains); Spreizung +2 (2 Oszillatoren, Gains, Splitter/Merger); Rückkopplung +2,5 (Dry-Pfad-IIR, Delay, 2 Schutz-Biquads). */
const freqShiftCost = p => { const v = freqShiftValues(p); return { base: 4 + (v.spread > 0 ? 2 : 0) + (v.feedback > 0 ? 2.5 : 0), measured: false, estimate: 'freqShift' }; };
/**
 * Tonhöhe v2 (Phase 17b): Algorithmen. `legacy` = bisheriges Grain-Worklet `pitch` (Standard, Entscheidung C: `defaultEffects()` und alle
 * Altdaten klingen unverändert), `music` = Phasenvocoder im Worklet `stft`,
 * `voice` (17c) = WSOLA im selben Worklet (Zeitbereich, geringere Latenz und CPU).
 */
export const PITCH_ALGORITHMS = ['legacy', 'music', 'voice'];
export const PITCH_ALGORITHM_LABELS = { legacy: 'Klassisch (Grain)', music: 'Musik (Phasenvocoder)', voice: 'Stimme (WSOLA)' };
/** Latenz des Phasenvocoders in Samples (FFT-Größe, fest unabhängig von der Abtastrate, Entscheidung F; dsp-lib/pitch-pv.js PV_SIZE). */
export const PITCH_PV_LATENCY = 2048;
/** Latenz von `voice` in Samples (dsp-lib/pitch-wsola.js WSOLA_LATENCY = 1024 + 256 + 64, fest unabhängig von Faktor und Abtastrate). */
export const PITCH_VOICE_LATENCY = 1344;
export const pitchAlgorithm = q => (PITCH_ALGORITHMS.includes(q?.algorithm) ? q.algorithm : 'legacy');
/**
 * Halbtöne + Cent (geklemmt wie das Schema: ±24 Halbtöne, ±100 Cent). Bei `legacy` zählen Cent NICHT (Nutzer 2026-10-31, ersetzt D für Cent):
 * das Grain-Verfahren setzt kleine Faktoren kaum um, Cent ist dort ausgeblendet — ein verdeckter Wert soll nicht wirken.
 */
export const pitchSemitonesTotal = q => _clamp(-24, 24, _fin(q?.semitones, 0)) + (pitchAlgorithm(q) === 'legacy' ? 0 : _clamp(-100, 100, _fin(q?.cents, 0)) / 100);
/**
 * Werte für Worklet und Notbehelf: factor = 2^(Halbtöne/12), mix 0…1 (Cent und Mix bei `legacy` ohne Wirkung).
 * Phase 17d: `formantFactor` = 2^(Formant/12), nur bei `music` (Phasenvocoder; bei `legacy` und `voice` ausgeblendet und ohne Wirkung → 1).
 * Der Formant wirkt zusätzlich zur Mitführung der Hüllkurve durch die Tonhöhe: Formant 0 = Klang wie in 17b/17c.
 */
export const pitchValues = q => {
  const st = pitchSemitonesTotal(q);
  return { algorithm: pitchAlgorithm(q), semitones: st, factor: Math.pow(2, st / 12), mix: _clamp(0, 1, _fin(q?.mix, 1)), formantFactor: pitchAlgorithm(q) === 'music' ? Math.pow(2, _clamp(-12, 12, _fin(q?.formant, 0)) / 12) : 1 };
};
/**
 * Baut die Runtime einen Pitch-Knoten? EINE Regel für fx-pipeline (hasPitch, klingende Module), runtime (Signatur, Aufbau) und cost.js:
 * eingeschaltet UND (Halbtöne + Cent ≠ 0 ODER Algorithmus ≠ `legacy`). Für `legacy` genau die bisherige Bedingung (Halbtöne ≠ 0; Cent zählen dort nicht).
 * Ein v2-Algorithmus läuft auch bei Faktor 1 (Mix und später Formant wirken; Latenz bleibt beim Durchfahren von 0 gleich).
 */
export const pitchActive = q => !!(q && q.enabled && (pitchSemitonesTotal(q) !== 0 || pitchAlgorithm(q) !== 'legacy'));
/** Latenz (Samples) je Algorithmus: `music` 2048, `voice` 1344; das Legacy-Worklet deklariert keine. */
/**
 * Phase 17e: Hinweiszeile der Karte „Tonhöhe“ (`ui.info`): Verzögerung des gewählten Algorithmus; bei `legacy` keine. Angabe in Samples
 * mit Spanne für 48/44,1 kHz (die Abtastrate des Audiokontexts ist der Oberfläche nicht bekannt).
 */
const pitchInfo = q => {
  const n = pitchAlgorithm(q) === 'music' ? PITCH_PV_LATENCY : pitchAlgorithm(q) === 'voice' ? PITCH_VOICE_LATENCY : 0;
  return n ? `Verzögerung: ${n} Samples (≈ ${Math.round(n / 48)}–${Math.round(n / 44.1)} ms)` : null;
};
const pitchLatency = q => (!pitchActive(q) ? 0 : pitchAlgorithm(q) === 'music' ? PITCH_PV_LATENCY : pitchAlgorithm(q) === 'voice' ? PITCH_VOICE_LATENCY : 0);
/** Kosten: `legacy` gemessen 28 (P0/M-1); `music` und `voice` Schätzwert gleicher Höhe bis zur Messung in 17e (`voice` ≈ 1 % Echtzeit je Kanal [S Node, Prototyp]). */
const pitchCost = q => (pitchAlgorithm(q) === 'music' ? { base: 28, measured: false, estimate: 'stft' } : pitchAlgorithm(q) === 'voice' ? { base: 28, measured: false, estimate: 'wsola' } : { base: 28, measured: true });
/** Ringmodulation (15c): Trägerformen; `sine` = bisheriger Graph. */
export const RINGMOD_WAVEFORMS = ['sine', 'square', 'triangle', 'sawtooth'];
/** Nachklang: nur Tape (Vibrato-Verzögerung, Grund + größte Auslenkung); sonst 0 wie bisher. */
const distortionTail = p => (distortionMode(p) === 'tape' ? TAPE_BASE_DELAY_S + TAPE_WOW_MAX_S + TAPE_FLUTTER_MAX_S : 0);
/** Doppler (13f): Schallgeschwindigkeit (m/s) und größte Verzögerung (s, Entscheidung B; weiter weg „parkt“ die Quelle). */
export const DOPPLER_C = 343;
export const DOPPLER_MAX_DELAY_S = 2;
/**
 * Nachklang des Dopplers (s): größte Verzögerung der Bahn, Anteil Tonhöhe · (d_max − d_min)/c, höchstens DOPPLER_MAX_DELAY_S. Bei Dauer relativ zur
 * Clip-Dauer ist die Bahnlänge hier unbekannt → Obergrenze. Ohne Tonhöhenanteil keine Verzögerung.
 */
export function dopplerTailSeconds(p) {
  const k = Math.max(0, Math.min(1, Number.isFinite(p?.pitchAmount) ? p.pitchAmount : 1));
  if (!(k > 0)) return 0;
  if (p?.motionUnit === 'relative') return DOPPLER_MAX_DELAY_S;
  const v = Number.isFinite(p?.speed) ? p.speed : 20, dmin = Number.isFinite(p?.minDistance) ? p.minDistance : 5;
  const cl = Math.max(0, Math.min(1, Number.isFinite(p?.closest) ? p.closest : 0.5)), len = Number.isFinite(p?.motionTime) ? p.motionTime : 4;
  const x = v * len * Math.max(cl, 1 - cl);
  return Math.min(DOPPLER_MAX_DELAY_S, k * (Math.hypot(dmin, x) - dmin) / DOPPLER_C);
}
/** Mid/Side-EQ (13b): Bänder je Kanal (Mitte, Seite) — eine Wahrheit für Registry, Engine und Tests. */
export const MS_EQ_DEF = { LowGain: 0, LowFreq: 200, PeakGain: 0, PeakFreq: 1000, PeakQ: 0.7, HighGain: 0, HighFreq: 5000 };
const msEqParams = (ch, name) => ({
  [`${ch}LowGain`]: { def: 0, range: [-18, 18], unit: 'dB', label: `${name}: Tiefen-Shelf`, ui: { min: -18, max: 18, step: 0.5, signed: true } },
  [`${ch}LowFreq`]: { def: 200, range: [20, 1000], unit: 'Hz', label: `${name}: Tiefen-Shelf Frequenz`, ui: { min: 20, max: 1000, step: 5, scale: 'log', digits: 0 } },
  [`${ch}PeakGain`]: { def: 0, range: [-18, 18], unit: 'dB', label: `${name}: Glocke`, ui: { min: -18, max: 18, step: 0.5, signed: true } },
  [`${ch}PeakFreq`]: { def: 1000, range: [50, 15000], unit: 'Hz', label: `${name}: Glocke Frequenz`, ui: { min: 50, max: 15000, step: 10, scale: 'log', digits: 0 } },
  [`${ch}PeakQ`]: { def: 0.7, range: [0.1, 10], label: `${name}: Glocke Güte (Q)`, ui: { min: 0.1, max: 10, step: 0.1, digits: 1 } },
  [`${ch}HighGain`]: { def: 0, range: [-18, 18], unit: 'dB', label: `${name}: Höhen-Shelf`, ui: { min: -18, max: 18, step: 0.5, signed: true } },
  [`${ch}HighFreq`]: { def: 5000, range: [1000, 20000], unit: 'Hz', label: `${name}: Höhen-Shelf Frequenz`, ui: { min: 1000, max: 20000, step: 50, scale: 'log', digits: 0 } }
});
/** Feste Verzögerung der Dekorrelation (komplementärer Kammfilter L = M + a·M(t−τ), R = M − a·M(t−τ); Kerben im Abstand 1/τ ≈ 91 Hz). */
export const WIDTH_DECOR_DELAY_S = 0.011;
/** Vibrato (12b): Verzögerungsamplitude (s) für eine Spitzenabweichung `cents` bei Rate `f` (Sinus: 2π·f·A, Dreieck: 4·f·A = 2^(c/1200) − 1). */
export const VIBRATO_MAX_SWING = 0.2;
export function vibratoSwing(cents, f, shape = 'sine') {
  const dev = Math.pow(2, Math.max(0, Number(cents) || 0) / 1200) - 1, ff = Math.max(0.1, Number(f) || 5);
  const a = shape === 'triangle' ? dev / (4 * ff) : dev / (2 * Math.PI * ff);
  return Math.min(VIBRATO_MAX_SWING, a);
}
/** LFO-Formen der Phase-12-Module (modsources.js LFO_SHAPES); Sample&Hold erst mit P20. */
const LFO_WAVE_OPTIONS = { sine: 'Sinus', triangle: 'Dreieck', square: 'Rechteck', saw: 'Sägezahn' };
const lfoWaveParam = () => ({ def: 'sine', enum: ['sine', 'triangle', 'square', 'saw'], label: 'Wellenform', ui: { options: LFO_WAVE_OPTIONS } });

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
  // Phase 14a (additiv): Modi mono (Standard = bisheriges Delay) | stereo | pingpong, Low-/High-Cut und Schutzsättigung in der Rückkopplung,
  // Modulation der Verzögerung. Mono mit neutralen neuen Feldern (delayIsLegacy) baut exakt den bisherigen Graphen.
  { key: 'delay', stageHint: p => ((p?.time ?? 0) >= 0.12 ? { stage: 'environment', weight: 1 } : null), ui: { generated: true }, family: 'space', label: 'Echo (Delay)', layerOrder: 120, consumers: ALL_CONSUMERS, cost: delayCost,
    tail: p => delayTailSeconds(p),
    params: {
      mode: { def: 'mono', enum: DELAY_MODES, label: 'Modus', ui: { options: DELAY_MODE_LABELS } },
      time: { def: 0.22, range: [0, 2], unit: 's', label: 'Zeit', ui: { min: 0.01, max: 2, step: 0.01, showIf: { mode: ['mono', 'pingpong'] } } },
      feedback: { def: 0.35, range: [0, 0.95], label: 'Rückkopplung', ui: { min: 0, max: 0.95, step: 0.01, percent: true, showIf: { mode: ['mono', 'stereo', 'pingpong'] } } },
      wet: { def: 0.35, range: [0, 1], label: 'Anteil (Wet)', ui: { min: 0, max: 0.95, step: 0.01, percent: true } },
      timeL: { def: 0.22, range: [0, 2], unit: 's', label: 'Zeit links', ui: { min: 0.01, max: 2, step: 0.01, showIf: { mode: ['stereo'] } } },
      timeR: { def: 0.33, range: [0, 2], unit: 's', label: 'Zeit rechts', ui: { min: 0.01, max: 2, step: 0.01, showIf: { mode: ['stereo'] } } },
      crossFeedback: { def: 0, range: [0, 0.95], label: 'Kreuz-Rückkopplung', ui: { min: 0, max: 0.95, step: 0.01, percent: true, showIf: { mode: ['stereo'] } } },
      lowCut: { def: DELAY_LOWCUT_OFF, range: [DELAY_LOWCUT_OFF, 2000], unit: 'Hz', label: 'Low-Cut (je Wiederholung)', ui: { min: 20, max: 2000, step: 5, scale: 'log', digits: 0 } },
      highCut: { def: DELAY_HIGHCUT_OFF, range: [500, DELAY_HIGHCUT_OFF], unit: 'Hz', label: 'High-Cut (je Wiederholung)', ui: { min: 500, max: 20000, step: 50, scale: 'log', digits: 0 } },
      modRate: { def: 0.5, range: [0.05, 5], unit: 'Hz', label: 'Modulation: Rate', ui: { min: 0.05, max: 5, step: 0.05 } },
      modDepth: { def: 0, range: [0, DELAY_MOD_MAX_MS], unit: 'ms', label: 'Modulation: Tiefe', ui: { min: 0, max: DELAY_MOD_MAX_MS, step: 0.1, digits: 1 } },
      taps: { def: DELAY_DEFAULT_TAPS, tapList: true, label: 'Taps', ui: { showIf: { mode: ['multitap'] } } }      // Phase 14b
    } },
  { key: 'chorus', stageHint: { stage: 'source', weight: 1 }, ui: { generated: true }, family: 'modulation', label: 'Chorus', layerOrder: 90, consumers: ALL_CONSUMERS, cost: chorusCost,
    params: {
      baseDelay: { def: 15, range: [1, 40], unit: 'ms', label: 'Grundverzögerung', ui: { min: 5, max: 40, step: 0.5 } },
      depth: { def: 8, range: [0, 20], unit: 'ms', label: 'Tiefe', ui: { min: 0, max: 20, step: 0.5 } },
      rate: { def: 0.8, range: [0.01, 10], unit: 'Hz', label: 'Rate', ui: { min: 0.01, max: 10, step: 0.01 } },
      mix: { def: 0.3, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      // Phase 12b (additiv): Stimmen und Stereo-Verteilung, Ensemble als Modus (3 Stimmen). voices 1 + mode 'chorus' (Standard, auch bei
      // fehlenden Feldern) = Graph wie bisher; `spread` wirkt erst ab 2 Stimmen bzw. im Ensemble.
      voices: { def: 1, range: [1, 8], label: 'Stimmen', ui: { min: 1, max: 8, step: 1, digits: 0 } },   // K3: 1–8 (vorher 1–4)
      spread: { def: 0, range: [0, 1], label: 'Stereo-Verteilung', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      mode: { def: 'chorus', enum: ['chorus', 'ensemble'], label: 'Modus', ui: { options: { chorus: 'Chorus', ensemble: 'Ensemble (3 Stimmen)' } } },
      // K3 (additiv): Anteil des schnellen 6-Hz-LFO an der Tiefe im Ensemble (Beschriftung „Schimmern“; Feldname bewusst nicht „shimmer“, das ist in Tests der Name eines unbekannten Zukunftsmoduls). Standard 0,12 = bisheriger fester Wert (bit-gleich); live.
      fastShare: { def: 0.12, range: [0, 0.5], label: 'Schimmern', ui: { min: 0, max: 0.5, step: 0.01, percent: true, showIf: { mode: ['ensemble'] } } }
    } },
  // Phase 12c: Flanger im Worklet `delayline` (sample-genaue Rückkopplung ohne die 128-Sample-Klemmung von Node/Firefox, B-14; Entscheidung E1:
  // in allen Motoren). Ohne Worklet: bisheriger nativer Graph (Fallback 'native', `phase` wirkt dort nicht).
  { key: 'flanger', stageHint: { stage: 'source', weight: 1 }, ui: { generated: true }, family: 'modulation', label: 'Flanger', layerOrder: 100, consumers: ALL_CONSUMERS,
    cost: () => ({ base: 7, measured: false, estimate: 'delayline' }), workletModules: ['delayline'],
    params: {
      baseDelay: { def: 2, range: [0.5, 10], unit: 'ms', label: 'Grundverzögerung', ui: { min: 0.5, max: 5, step: 0.1 } },
      depth: { def: 1.5, range: [0, 10], unit: 'ms', label: 'Tiefe', ui: { min: 0, max: 10, step: 0.1 } },
      rate: { def: 0.2, range: [0.01, 10], unit: 'Hz', label: 'Rate', ui: { min: 0.01, max: 10, step: 0.01 } },
      feedback: { def: 0.5, range: [0, 0.95], label: 'Rückkopplung', ui: { min: 0, max: 0.95, step: 0.01, percent: true } },
      mix: { def: 0.5, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      // Phase 12c (additiv): LFO-Form (Sinus = bisher; Rechteck/Säge bewusst nicht: Sprünge der Verzögerung knacken) und L/R-Versatz (E3, Standard 0 = mono).
      waveform: { def: 'sine', enum: ['sine', 'triangle'], label: 'Wellenform', ui: { options: { sine: 'Sinus', triangle: 'Dreieck' } } },
      phase: { def: 0, range: [0, 180], unit: '°', label: 'Phasenversatz L/R', ui: { min: 0, max: 180, step: 1 } }
    } },
  { key: 'tremolo', ui: { generated: true }, family: 'modulation', label: 'Tremolo', layerOrder: 130, consumers: ALL_CONSUMERS, cost: tremoloCost,
    params: {
      rate: { def: 5, range: [0.1, 20], unit: 'Hz', label: 'Rate', ui: { min: 0.1, max: 20, step: 0.1 } },
      depth: { def: 0.5, range: [0, 1], label: 'Tiefe', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      waveform: { def: 'sine', enum: ['sine', 'triangle', 'square'], label: 'Wellenform', ui: { options: { sine: 'Sinus', triangle: 'Dreieck', square: 'Rechteck' } } },
      // Phase 12a (additiv): Stereo-Tremolo mit L/R-Versatz. `stereo: 'off'` (Standard, auch bei fehlendem Feld) = Graph wie bisher; `phase` wirkt nur bei 'on'.
      stereo: { def: 'off', enum: ['off', 'on'], label: 'Stereo', ui: { options: { off: 'Aus (L = R)', on: 'Ein (L/R versetzt)' } } },
      phase: { def: 90, range: [0, 180], unit: '°', label: 'Phasenversatz L/R', ui: { min: 0, max: 180, step: 1 } }
    } },
  { key: 'eq', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'eq', label: '3-Band-EQ', layerOrder: 50, consumers: ALL_CONSUMERS, cost: c(3),
    params: {
      low: { def: 0, range: [-18, 18], unit: 'dB', label: 'Tiefen', ui: { min: -18, max: 18, step: 1, signed: true } },
      mid: { def: 0, range: [-18, 18], unit: 'dB', label: 'Mitten', ui: { min: -18, max: 18, step: 1, signed: true } },
      high: { def: 0, range: [-18, 18], unit: 'dB', label: 'Höhen', ui: { min: -18, max: 18, step: 1, signed: true } }
    } },
  { key: 'eq10', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'eq', label: '10-Band-EQ', layerOrder: 50, consumers: ALL_CONSUMERS, cost: c(12),
    params: { bands: { def: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bands: true, label: 'Bänder', ui: { gain: { min: -18, max: 18, step: 1 }, q: { min: 0.3, max: 10, step: 0.1, def: 1.4 } } } } },
  { key: 'compressor', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Kompressor', layerOrder: 60, consumers: ALL_CONSUMERS,
    // Mit Parallelanteil (mix < 1) kommt ein Delay als zeitgleicher Dry-Pfad dazu (+2 Punkte, Schätzwert bis M-1 ihn misst).
    cost: p => ((p?.mix ?? 1) < 1 ? { base: 14.5, measured: false, estimate: 'compressor+delay' } : { base: 12.5, measured: true }),
    params: {
      threshold: { def: -24, range: [-60, 0], unit: 'dB', label: 'Schwelle', ui: { min: -60, max: 0, step: 1 } },
      knee: { def: 30, range: [0, 40], unit: 'dB', label: 'Knie', ui: { min: 0, max: 40, step: 1 } },
      ratio: { def: 12, range: [1, 20], label: 'Verhältnis', ui: { min: 1, max: 20, step: 0.5, unit: ':1' } },
      attack: { def: 0.003, range: [0, 1], unit: 's', label: 'Attack', ui: { min: 0.0001, max: 0.5, step: 0.001, display: { factor: 1000, unit: 'ms' } } },
      release: { def: 0.25, range: [0, 1], unit: 's', label: 'Release', ui: { min: 0.01, max: 1, step: 0.01, display: { factor: 1000, unit: 'ms' } } },
      makeup: { def: 0, range: [-12, 24], unit: 'dB', label: 'Makeup', ui: { min: -12, max: 24, step: 0.5 } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  { key: 'limiter', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Limiter', layerOrder: 60, consumers: ALL_CONSUMERS, cost: limiterCost, workletModules: ['dynamics'],
    // Phase 11b: Lookahead-Spitzenbegrenzer (Worklet `dynamics`, Modus 2). `threshold` bleibt der Schlüssel und ist das Ceiling (Altdaten gültig).
    // Ohne Worklet fällt der Graph auf die bisherige Kompressor-Näherung zurück (knee/ratio/attack, daher weiter vorhanden).
    tail: p => Math.min(20, Math.max(1, p?.lookahead ?? 5)) / 1000,
    latencySamples: (p, sr = 48000) => Math.min(Math.ceil(sr * 0.02), Math.max(1, Math.round(Math.min(20, Math.max(1, p?.lookahead ?? 5)) / 1000 * sr))),
    params: {
      threshold: { def: -1, range: [-24, 0], unit: 'dB', label: 'Ceiling', ui: { min: -20, max: 0, step: 0.5 } },
      knee: { def: 0, raw: true, unit: 'dB', label: 'Knie', ui: { hidden: true } },
      ratio: { def: 20, raw: true, label: 'Verhältnis', ui: { hidden: true } },
      attack: { def: 0.001, raw: true, unit: 's', label: 'Attack', ui: { hidden: true } },
      release: { def: 0.08, raw: true, unit: 's', label: 'Release', ui: { min: 0.01, max: 1, step: 0.01, display: { factor: 1000, unit: 'ms' } } },
      inputGain: { def: 0, range: [-12, 24], unit: 'dB', label: 'Eingangsverstärkung', ui: { min: -12, max: 24, step: 0.5 } },
      lookahead: { def: 5, range: [1, 20], unit: 'ms', label: 'Lookahead (Latenz)', ui: { min: 1, max: 20, step: 0.5 } }
    } },
  { key: 'distortion', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'distortion', label: 'Verzerrung', layerOrder: 70, consumers: ALL_CONSUMERS,
    cost: distortionCost, degrade: { oversample: true }, tail: p => distortionTail(p),
    // mode: softClip (Standard), hardClip oder bitcrush. Presets ohne „mode“-Feld fallen über den switch-default in
    // _buildDistortionCurve() auf softClip zurück — kein Migrationsschritt nötig.
    // Phase 15a (additiv): neue Modi saturation/tube/overdrive/fuzz/fold (Kurven: engine/distortion-curves.js) mit Drive und Bias; für alle Modi
    // Ton (Tiefpass nach der Kurve), Ausgang und Mix. Standardwerte der neuen Felder = bisheriges Verhalten (distortionIsLegacy).
    params: {
      mode: { def: 'softClip', enum: DISTORTION_MODES, label: 'Modus', ui: { options: DISTORTION_MODE_LABELS, suggest: { when: DISTORTION_V2_MODES, set: { oversample: '2x' }, onlyIf: { oversample: ['4x'] } } } },
      amount: { def: 40, range: [0, 100], label: 'Stärke', ui: { min: 0, max: 100, step: 1, showIf: { mode: DISTORTION_LEGACY_MODES } } },
      oversample: { def: '4x', enum: ['none', '2x', '4x'], label: 'Oversampling', ui: { options: { none: 'Kein', '2x': '2×', '4x': '4×' } } },
      drive: { def: 12, range: DIST_DRIVE_RANGE, unit: 'dB', label: 'Drive', ui: { min: 0, max: 40, step: 0.5, showIf: { mode: DISTORTION_V2_MODES } } },
      bias: { def: 0, range: DIST_BIAS_RANGE, label: 'Asymmetrie (Bias)', ui: { min: -1, max: 1, step: 0.01, percent: true, signed: true, showIf: { mode: DISTORTION_V2_MODES } } },
      tone: { def: DISTORTION_TONE_OFF, range: [500, DISTORTION_TONE_OFF], unit: 'Hz', label: 'Ton (Höhen)', ui: { min: 500, max: 20000, step: 50, scale: 'log', digits: 0 } },
      output: { def: 0, range: [-24, 12], unit: 'dB', label: 'Ausgang', ui: { min: -24, max: 12, step: 0.5, signed: true } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      // Phase 15b (additiv): Tape — Wow (langsames Leiern, 0,7 Hz) und Flutter (schnelles Flattern, 7,3 Hz) als Anteil der größten Auslenkung; live.
      wow: { def: 0.2, range: [0, 1], label: 'Wow (Leiern)', ui: { min: 0, max: 1, step: 0.01, percent: true, showIf: { mode: ['tape'] } } },
      flutter: { def: 0.15, range: [0, 1], label: 'Flutter (Flattern)', ui: { min: 0, max: 1, step: 0.01, percent: true, showIf: { mode: ['tape'] } } },
      // Phase 15b: Kurvenpunkte des Waveshapers (Punkt-Tabelle mit Vorschau, ui/effects/distortion-points.js)
      curvePoints: { def: WS_DEFAULT_POINTS, pointList: true, label: 'Kurvenpunkte', ui: { showIf: { mode: ['waveshaper'] } } }
    } },
  { key: 'ringmod', stageHint: { stage: 'source', weight: 2 }, ui: { generated: true }, family: 'distortion', label: 'Ringmodulation', layerOrder: 80, consumers: ALL_CONSUMERS, cost: c(2.5),
    params: {
      frequency: { def: 440, range: [20, 5000], unit: 'Hz', label: 'Trägerfrequenz', ui: { min: 20, max: 5000, step: 1, scale: 'log', digits: 0 } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      // Phase 15c (additiv): Trägerform; Standard Sinus = bisheriger Graph. Wechsel = Neubau mit Überblendung (die Form springt sonst hörbar).
      waveform: { def: 'sine', enum: RINGMOD_WAVEFORMS, label: 'Trägerform', ui: { options: { sine: 'Sinus', square: 'Rechteck', triangle: 'Dreieck', sawtooth: 'Sägezahn' } } }
    } },
  { key: 'pitchShift', stageHint: { stage: 'source', weight: 2 }, ui: { generated: true, info: pitchInfo, enableSet: { algorithm: 'voice' } }, family: 'voice', label: 'Tonhöhe', layerOrder: 0, consumers: ALL_CONSUMERS, needsWorklet: true, workletModules: ['pitch', 'stft'], cost: pitchCost,
    // Phase 17b/17c: Nachklang = Latenz des Algorithmus bei 22,05 kHz (längster Fall), damit der Export das verzögerte Ende nicht abschneidet.
    tail: p => pitchLatency(p) / 22050,
    latencySamples: p => pitchLatency(p),
    params: {
      semitones: { def: 0, range: [-24, 24], unit: 'Halbtöne', label: 'Halbtöne', ui: { min: -12, max: 12, step: 1, signed: true } },
      // Phase 17b (additiv): Feinstimmung und Mix (beide nur v2-Algorithmen, bei `legacy` ausgeblendet und ohne Wirkung) und Algorithmus (Standard `legacy`, Entscheidung C).
      cents: { def: 0, range: [-100, 100], unit: 'Cent', label: 'Cent', ui: { min: -100, max: 100, step: 1, signed: true, showIf: { algorithm: ['music', 'voice'] } } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true, showIf: { algorithm: ['music', 'voice'] } } },
      // Phase 17d (additiv): Formant (Spektralhüllkurve) in Halbtönen, nur bei `music`; seit 17e in der Anzeige zwischen Mix und Algorithmus; 0 = Hüllkurve wandert wie bisher mit der Tonhöhe.
      formant: { def: 0, range: [-12, 12], unit: 'Halbtöne', label: 'Formant', ui: { min: -12, max: 12, step: 0.5, signed: true, showIf: { algorithm: ['music'] } } },
      algorithm: { def: 'legacy', enum: PITCH_ALGORITHMS, label: 'Algorithmus', ui: { options: PITCH_ALGORITHM_LABELS } }
    } },
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
      x: { def: 0, range: [-1000, 1000], label: 'X (links ↔ rechts)', ui: { min: -50, max: 50, step: 0.1 } },
      y: { def: 0, range: [-1000, 1000], label: 'Y (unten ↔ oben)', ui: { min: -50, max: 50, step: 0.1 } },
      z: { def: -1, range: [-1000, 1000], label: 'Z (vorn ↔ hinten)', ui: { min: -50, max: 50, step: 0.1 } },
      rolloff: { def: 1, range: [0, 10], label: 'Rolloff', ui: { min: 0, max: 5, step: 0.1 } },
      maxDistance: { def: 10000, range: [1, 100000], label: 'Max. Distanz', ui: { min: 1, max: 10000, step: 1, scale: 'log', digits: 0 } },
      refDistance: { def: 1, range: [0, 1000], label: 'Referenzdistanz', ui: { min: 0, max: 100, step: 0.1, digits: 1 } },
      coneInnerAngle: { def: 360, range: [0, 360], unit: '°', label: 'Kegel innen', ui: { min: 0, max: 360, step: 1, digits: 0 } },
      coneOuterAngle: { def: 360, range: [0, 360], unit: '°', label: 'Kegel außen', ui: { min: 0, max: 360, step: 1, digits: 0 } },
      coneOuterGain: { def: 0, range: [0, 1], label: 'Kegel-Restpegel', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      // K2: Reglerbereich der Positionen ±50 m (vorher ±10 m; Daten ±1000 m unverändert).
      // Phase 13e (Spatial v2, additiv): Modelle, Ausrichtung des Kegels, Bewegung Start (x/y/z) → Ziel (toX/toY/toZ) über die Zeitbasis (13d).
      // Standardwerte = bisheriges Verhalten (HRTF, inverse, feste Ausrichtung +X, keine Bewegung). Die Bewegungsfelder erscheinen nur bei
      // Bewegung ≠ Aus (`ui.showIf`, module-card.js). `maxDistance` wirkt in allen Distanzmodellen (Entscheidung A: eigene Begrenzung des Abstands).
      panningModel: { def: 'HRTF', enum: ['HRTF', 'equalpower'], label: 'Panning-Modell', ui: { options: { HRTF: 'HRTF (3D, Kopfhörer)', equalpower: 'Equal-Power (einfaches Panorama)' } } },
      distanceModel: { def: 'inverse', enum: ['inverse', 'linear', 'exponential'], label: 'Distanzmodell', ui: { options: { inverse: 'Invers (natürlich)', linear: 'Linear (bis Max. Distanz still)', exponential: 'Exponentiell' } } },
      facing: { def: 'fixed', enum: ['fixed', 'motion'], label: 'Kegel zeigt', ui: { options: { fixed: 'fest nach rechts (+X)', motion: 'in Fahrtrichtung (Start → Ziel)' } } },
      motion: { def: 'off', enum: ['off', 'once', 'loop'], label: 'Bewegung', ui: { options: { off: 'Aus', once: 'Einmal je Start', loop: 'Je Durchlauf (Loop)' } } },
      toX: { def: 0, range: [-1000, 1000], label: 'Ziel X (links ↔ rechts)', ui: { min: -50, max: 50, step: 0.1, showIf: { motion: ['once', 'loop'] } } },
      toY: { def: 0, range: [-1000, 1000], label: 'Ziel Y (unten ↔ oben)', ui: { min: -50, max: 50, step: 0.1, showIf: { motion: ['once', 'loop'] } } },
      toZ: { def: -1, range: [-1000, 1000], label: 'Ziel Z (vorn ↔ hinten)', ui: { min: -50, max: 50, step: 0.1, showIf: { motion: ['once', 'loop'] } } },
      motionUnit: { def: 'seconds', enum: ['seconds', 'relative'], label: 'Dauer angeben', ui: { options: { seconds: 'in Sekunden', relative: 'als Anteil der Clip-Dauer' }, showIf: { motion: ['once', 'loop'] } } },
      motionTime: { def: 2, range: [0.05, 600], unit: 's', label: 'Dauer', ui: { min: 0.05, max: 60, step: 0.05, scale: 'log', digits: 2, showIf: { motion: ['once', 'loop'], motionUnit: ['seconds'] } } },
      motionShare: { def: 1, range: [0.01, 1], label: 'Dauer (Anteil)', ui: { min: 0.01, max: 1, step: 0.01, percent: true, showIf: { motion: ['once', 'loop'], motionUnit: ['relative'] } } },
      curve: { def: 'linear', enum: ['linear', 'easeIn', 'easeOut', 'easeInOut'], label: 'Verlauf', ui: { options: { linear: 'Gleichmäßig', easeIn: 'Beschleunigen', easeOut: 'Abbremsen', easeInOut: 'Weich (an- und abschwellend)' }, showIf: { motion: ['once', 'loop'] } } }
    } },
  // P11a: echtes Gate (Worklet `dynamics`, Rechenkern dsp-lib/dynamics.js; B-03 behoben). Der Schlüssel bleibt `noiseGate` (Entscheidung A):
  // keine Rev-Migration, Alt-Daten und Presets bleiben gültig. Presets ohne die neuen Felder (3 Built-ins setzen nur `threshold`)
  // bekommen die Defaults unten. attack/release in ms (wie bisher); hold/range/hysteresis/scHp seit P11a.
  { key: 'noiseGate', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Noise Gate', layerOrder: 140, consumers: ALL_CONSUMERS, cost: dynamicsCost, workletModules: ['dynamics'], needsWorklet: true,
    params: {
      threshold: { def: -50, range: [-100, 0], unit: 'dB', label: 'Schwelle', ui: { min: -80, max: -10, step: 1 } },
      attack: { def: 5, range: [0, 1000], unit: 'ms', label: 'Attack', ui: { min: 0, max: 100, step: 1 } },
      release: { def: 150, range: [0, 2000], unit: 'ms', label: 'Release', ui: { min: 5, max: 1500, step: 5 } },
      hold: { def: 50, range: [0, 2000], unit: 'ms', label: 'Hold', ui: { min: 0, max: 500, step: 5 } },
      range: { def: -80, range: [-100, 0], unit: 'dB', label: 'Absenkung', ui: { min: -80, max: 0, step: 1 } },
      hysteresis: { def: 3, range: [0, 24], unit: 'dB', label: 'Hysterese', ui: { min: 0, max: 12, step: 0.5 } },
      scHp: { def: 20, range: [20, 2000], unit: 'Hz', label: 'Sidechain-Hochpass', ui: { min: 20, max: 2000, step: 10, scale: 'log', digits: 0 } }
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
    params: { bands: { def: PEQ_DEFAULT_BANDS, bandList: true, label: 'Bänder' } } },
  // Expander (11a): Abwärts-Expander im Worklet `dynamics`. Liegt direkt hinter dem Noise Gate (Legacy-Gate sitzt am Layer-Ende, E8).
  { key: 'expander', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Expander', layerOrder: 141, consumers: ALL_CONSUMERS, cost: dynamicsCost, workletModules: ['dynamics'], needsWorklet: true,
    params: {
      threshold: { def: -40, range: [-100, 0], unit: 'dB', label: 'Schwelle', ui: { min: -80, max: -10, step: 1 } },
      ratio: { def: 2, range: [1, 20], unit: ':1', label: 'Verhältnis', ui: { min: 1, max: 10, step: 0.1, digits: 1 } },
      range: { def: -40, range: [-100, 0], unit: 'dB', label: 'Max. Absenkung', ui: { min: -80, max: 0, step: 1 } },
      attack: { def: 5, range: [0, 1000], unit: 'ms', label: 'Attack', ui: { min: 0, max: 100, step: 1 } },
      release: { def: 150, range: [0, 2000], unit: 'ms', label: 'Release', ui: { min: 5, max: 1500, step: 5 } },
      scHp: { def: 20, range: [20, 2000], unit: 'Hz', label: 'Sidechain-Hochpass', ui: { min: 20, max: 2000, step: 10, scale: 'log', digits: 0 } }
    } },
  // Phase 11d: Transient Shaper (Worklet `dynamics`, Modus 3). Hüllkurvendifferenz, pegelunabhängig, keine Latenz; attack = sustain = 0 ist bit-genau neutral.
  { key: 'transient', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Transient Shaper', layerOrder: 65, consumers: ALL_CONSUMERS, cost: dynamicsCost, workletModules: ['dynamics'], needsWorklet: true,
    params: {
      attack: { def: 0, range: [-12, 12], unit: 'dB', label: 'Anschlag', ui: { min: -12, max: 12, step: 0.5 } },
      sustain: { def: 0, range: [-12, 12], unit: 'dB', label: 'Ausklang', ui: { min: -12, max: 12, step: 0.5 } },
      sensitivity: { def: 0.5, range: [0, 1], label: 'Empfindlichkeit', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      release: { def: 150, range: [20, 500], unit: 'ms', label: 'Release', ui: { min: 20, max: 500, step: 5 } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  // Phase 11e: Multiband-Kompressor — LR4-Weiche (engine/crossover.js, 3 Bänder) und je Band ein nativer Kompressor mit Makeup.
  // Rein nativ (kein Worklet). Alle Bänder haben dieselbe Kompressor-Vorverzögerung, bleiben also zeitgleich; `mix` wirkt je Band
  // (Dry-Pfad = Verzögerung, wie beim Kompressor), so summiert sich der unbearbeitete Anteil phasenrichtig über dieselbe Weiche.
  { key: 'multiband', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'dynamics', label: 'Multiband-Kompressor', layerOrder: 66, consumers: ALL_CONSUMERS,
    cost: multibandCost,
    params: {
      crossLow: { def: 200, range: [40, 800], unit: 'Hz', label: 'Weiche Tiefen/Mitten', ui: { min: 40, max: 800, step: 5, scale: 'log', digits: 0 } },
      crossHigh: { def: 2500, range: [1000, 12000], unit: 'Hz', label: 'Weiche Mitten/Höhen', ui: { min: 1000, max: 12000, step: 50, scale: 'log', digits: 0 } },
      lowThreshold: { def: -24, range: [-60, 0], unit: 'dB', label: 'Tiefen: Schwelle', ui: { min: -60, max: 0, step: 1 } },
      lowRatio: { def: 3, range: [1, 20], label: 'Tiefen: Verhältnis', ui: { min: 1, max: 20, step: 0.5, unit: ':1' } },
      lowAttack: { def: 0.01, range: [0, 1], unit: 's', label: 'Tiefen: Attack', ui: { min: 0.0001, max: 0.5, step: 0.001, display: { factor: 1000, unit: 'ms' } } },
      lowRelease: { def: 0.25, range: [0, 1], unit: 's', label: 'Tiefen: Release', ui: { min: 0.01, max: 1, step: 0.01, display: { factor: 1000, unit: 'ms' } } },
      lowMakeup: { def: 0, range: [-12, 24], unit: 'dB', label: 'Tiefen: Makeup', ui: { min: -12, max: 24, step: 0.5 } },
      midThreshold: { def: -24, range: [-60, 0], unit: 'dB', label: 'Mitten: Schwelle', ui: { min: -60, max: 0, step: 1 } },
      midRatio: { def: 3, range: [1, 20], label: 'Mitten: Verhältnis', ui: { min: 1, max: 20, step: 0.5, unit: ':1' } },
      midAttack: { def: 0.01, range: [0, 1], unit: 's', label: 'Mitten: Attack', ui: { min: 0.0001, max: 0.5, step: 0.001, display: { factor: 1000, unit: 'ms' } } },
      midRelease: { def: 0.25, range: [0, 1], unit: 's', label: 'Mitten: Release', ui: { min: 0.01, max: 1, step: 0.01, display: { factor: 1000, unit: 'ms' } } },
      midMakeup: { def: 0, range: [-12, 24], unit: 'dB', label: 'Mitten: Makeup', ui: { min: -12, max: 24, step: 0.5 } },
      highThreshold: { def: -24, range: [-60, 0], unit: 'dB', label: 'Höhen: Schwelle', ui: { min: -60, max: 0, step: 1 } },
      highRatio: { def: 3, range: [1, 20], label: 'Höhen: Verhältnis', ui: { min: 1, max: 20, step: 0.5, unit: ':1' } },
      highAttack: { def: 0.01, range: [0, 1], unit: 's', label: 'Höhen: Attack', ui: { min: 0.0001, max: 0.5, step: 0.001, display: { factor: 1000, unit: 'ms' } } },
      highRelease: { def: 0.25, range: [0, 1], unit: 's', label: 'Höhen: Release', ui: { min: 0.01, max: 1, step: 0.01, display: { factor: 1000, unit: 'ms' } } },
      highMakeup: { def: 0, range: [-12, 24], unit: 'dB', label: 'Höhen: Makeup', ui: { min: -12, max: 24, step: 0.5 } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  // Phase 12a: Auto-Pan — eigene Gains statt StereoPannerNode (Entscheidung 12a): Mitte/Seite-Breite der Quelle, dann je Kanal √2·cos/√2·sin des
  // Panwinkels (LFO·Tiefe über eine WaveShaper-Kurve). Konstante Leistung für Mono- und Stereoquellen, Mitte = Pegel wie hinter jedem kanalerhaltenden Modul (Mono: L = R = −3,01 dB, M-3).
  // Eine Mono-Quelle wird hier bewusst stereo (Zweck des Moduls). Ohne Worklet, ohne Latenz.
  { key: 'autoPan', ui: { generated: true }, family: 'modulation', label: 'Auto-Pan', layerOrder: 132, consumers: ALL_CONSUMERS, cost: autoPanCost,
    params: {
      rate: { def: 0.5, range: [0.01, 20], unit: 'Hz', label: 'Rate', ui: { min: 0.01, max: 10, step: 0.01 } },
      depth: { def: 1, range: [0, 1], label: 'Tiefe', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      waveform: lfoWaveParam(),
      phase: { def: 0, range: [0, 360], unit: '°', label: 'Startphase', ui: { min: 0, max: 360, step: 1 } },
      width: { def: 1, range: [0, 1], label: 'Stereobreite der Quelle', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  // Phase 12b: Vibrato — modulierte Verzögerung (nativ). `depth` = Spitzenabweichung der Tonhöhe in Cent (Entscheidung E2); die Wellenform
  // beschreibt die Verzögerung: Sinus → weiches Vibrato, Dreieck → Tonhöhe springt zwischen ±depth (Triller-artig). Rechteck/Säge sind hier
  // bewusst nicht wählbar (Sprünge der Verzögerung = Knackser). Mix 1 = reines Vibrato; darunter entsteht ein Chorus-artiger Anteil.
  { key: 'vibrato', stageHint: { stage: 'source', weight: 1 }, ui: { generated: true }, family: 'modulation', label: 'Vibrato', layerOrder: 104, consumers: ALL_CONSUMERS, cost: vibratoCost,
    params: {
      rate: { def: 5, range: [0.1, 20], unit: 'Hz', label: 'Rate', ui: { min: 0.1, max: 14, step: 0.1 } },
      depth: { def: 20, range: [0, 100], unit: 'ct', label: 'Tiefe', ui: { min: 0, max: 100, step: 1, digits: 0 } },
      waveform: { def: 'sine', enum: ['sine', 'triangle'], label: 'Wellenform', ui: { options: { sine: 'Sinus', triangle: 'Dreieck (springt)' } } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  // Phase 12d: Phaser — Kette aus stages/2 Allpass-Biquads (Q 0,5 = je zwei Allpässe 1. Ordnung, also stages/2 Kerben), Mittenfrequenz exponentiell
  // vom LFO bewegt (depth 1 = ± 2 Oktaven). Worklet `delayline` (Modus 1) mit sample-genauer Rückkopplung; ohne Worklet: native Allpass-Kette ohne
  // Rückkopplung (Fallback 'native'). Mix 0,5 = tiefste Kerben.
  { key: 'phaser', stageHint: { stage: 'source', weight: 1 }, ui: { generated: true }, family: 'modulation', label: 'Phaser', layerOrder: 102, consumers: ALL_CONSUMERS, cost: phaserCost,
    workletModules: ['delayline'],
    params: {
      rate: { def: 0.5, range: [0.01, 10], unit: 'Hz', label: 'Rate', ui: { min: 0.01, max: 10, step: 0.01 } },
      depth: { def: 0.7, range: [0, 1], label: 'Tiefe', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      feedback: { def: 0, range: [-0.9, 0.9], label: 'Rückkopplung', ui: { min: -0.9, max: 0.9, step: 0.01, percent: true, signed: true } },   // K2: Anzeige −90 … +90 % (Daten −0,9 … +0,9)
      stages: { def: 4, range: [2, 12], label: 'Stufen', ui: { min: 2, max: 12, step: 2, digits: 0 } },
      center: { def: 800, range: [100, 8000], unit: 'Hz', label: 'Mittenfrequenz', ui: { min: 100, max: 8000, step: 10, scale: 'log', digits: 0 } },
      mix: { def: 0.5, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  // ── Phase 13 (Stereo & Spatial): Module zwischen Expander (141) und Spatial (150); in keinem Built-in aktiv ──
  // Phase 13a: Stereobreite über Mitte/Seite. Breite in Prozent (0 = mono, 100 = unverändert, 200 = doppelte Seite); die Mono-Summe (L + R)/2 hängt
  // nicht von der Breite ab. `decorrelate` erzeugt aus der Mitte eine künstliche Seite (komplementäre Kurzverzögerung, Entscheidung C): nur so wird
  // eine Mono-Quelle breiter (ihre Seite ist 0); die Mono-Summe bleibt dabei unverändert. Bass-Mono: Seite unterhalb `bassFreq` über LR4 entfernt.
  { key: 'width', ui: { generated: true }, family: 'stereo', label: 'Stereobreite', layerOrder: 144, consumers: ALL_CONSUMERS, cost: widthCost,
    params: {
      width: { def: 100, range: [0, 200], unit: '%', label: 'Breite', ui: { min: 0, max: 200, step: 1, digits: 0 } },
      center: { def: 0, range: [-24, 12], unit: 'dB', label: 'Center-Pegel', ui: { min: -24, max: 12, step: 0.5, signed: true } },
      decorrelate: { def: 0, range: [0, 1], label: 'Mono-Verbreiterung (Dekorrelation)', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      bassMono: { def: 'off', enum: ['off', 'on'], label: 'Bass-Mono', ui: { options: { off: 'Aus', on: 'Ein' } } },
      bassFreq: { def: 120, range: [40, 500], unit: 'Hz', label: 'Bass-Mono bis', ui: { min: 40, max: 500, step: 5, scale: 'log', digits: 0 } }
    } },
  // Phase 13a: Utility — Panorama (Entscheidung B: `pan` kehrt als Feld dieses Moduls zurück; als Layer-Schlüssel bleibt es entfernt), Phase
  // invertieren, Mono-Summe, L/R tauschen. Eine 2×2-Kanalmatrix, alle Regler live (Schalter blenden über die Glättung um, ≈ 45 ms).
  { key: 'utility', ui: { generated: true }, family: 'stereo', label: 'Utility (Panorama, Phase, Mono)', layerOrder: 147, consumers: ALL_CONSUMERS, cost: utilityCost,
    params: {
      pan: { def: 0, range: [-1, 1], label: 'Panorama', ui: { min: -1, max: 1, step: 0.01, digits: 2, signed: true } },
      // Panorama-Gesetz (13a, freigegeben: beide mit Schalter). balance: je Kanal √2·cos/√2·sin (wie Auto-Pan, konstante Leistung, Gegenkanal wird leiser);
      // stereo: Formel des StereoPannerNode für zwei Kanäle (Gegenkanal wird auf die Zielseite hinübergemischt, bei korreliertem Inhalt bis +3 dB).
      panMode: { def: 'balance', enum: ['balance', 'stereo'], label: 'Panorama-Modus', ui: { options: { balance: 'Balance (gleiche Leistung)', stereo: 'Verschieben (wie StereoPanner)' } } },
      invert: { def: 'none', enum: ['none', 'left', 'right', 'both'], label: 'Phase invertieren', ui: { options: { none: 'Aus', left: 'Links', right: 'Rechts', both: 'Beide' } } },
      mono: { def: 'off', enum: ['off', 'on'], label: 'Mono-Summe', ui: { options: { off: 'Aus', on: 'Ein (L = R)' } } },
      swap: { def: 'off', enum: ['off', 'on'], label: 'L/R tauschen', ui: { options: { off: 'Aus', on: 'Ein' } } }
    } },
  // Phase 13b: Mid/Side — Mitte und Seite getrennt: Pegel und je ein EQ (Tiefen-Shelf, Glocke, Höhen-Shelf). Standard = Nulltest. Deckt den Mid/Side-EQ ab (Masterliste #13).
  { key: 'midSide', ui: { generated: true }, family: 'stereo', label: 'Mid/Side (Pegel, EQ)', layerOrder: 143, consumers: ALL_CONSUMERS, cost: midSideCost,
    params: {
      midGain: { def: 0, range: [-24, 12], unit: 'dB', label: 'Mitte: Pegel', ui: { min: -24, max: 12, step: 0.5, signed: true } },
      sideGain: { def: 0, range: [-24, 12], unit: 'dB', label: 'Seite: Pegel', ui: { min: -24, max: 12, step: 0.5, signed: true } },
      ...msEqParams('mid', 'Mitte'),
      ...msEqParams('side', 'Seite')
    } },
  // Phase 13b: Stereo-Shaper — Breite in drei Bändern (LR4-Weiche aus 11e auf der Seite, passender Allpass auf der Mitte). Bänder summieren flach.
  { key: 'stereoShaper', ui: { generated: true }, family: 'stereo', label: 'Stereo-Shaper (Breite in 3 Bändern)', layerOrder: 145, consumers: ALL_CONSUMERS, cost: stereoShaperCost,
    params: {
      crossLow: { def: 200, range: [40, 800], unit: 'Hz', label: 'Weiche Tiefen/Mitten', ui: { min: 40, max: 800, step: 5, scale: 'log', digits: 0 } },
      crossHigh: { def: 2500, range: [1000, 12000], unit: 'Hz', label: 'Weiche Mitten/Höhen', ui: { min: 1000, max: 12000, step: 50, scale: 'log', digits: 0 } },
      lowWidth: { def: 100, range: [0, 200], unit: '%', label: 'Tiefen: Breite', ui: { min: 0, max: 200, step: 1, digits: 0 } },
      midWidth: { def: 100, range: [0, 200], unit: '%', label: 'Mitten: Breite', ui: { min: 0, max: 200, step: 1, digits: 0 } },
      highWidth: { def: 100, range: [0, 200], unit: '%', label: 'Höhen: Breite', ui: { min: 0, max: 200, step: 1, digits: 0 } }
    } },
  // Phase 13c: Haas — ein Kanal wird um 1–35 ms verzögert (ohne Rückkopplung); die Ortung folgt dem früheren Kanal. `side` = wohin der Klang wandert
  // (verzögert wird der Gegenkanal), `level` = Pegel des verzögerten Kanals. Alle Regler live (Zeitänderung gleitet über ≈ 0,45 s, Seitenwechsel ebenso).
  { key: 'haas', ui: { generated: true }, family: 'stereo', label: 'Haas (Laufzeit-Stereo)', layerOrder: 146, consumers: ALL_CONSUMERS, cost: haasCost,
    params: {
      time: { def: 15, range: [1, 35], unit: 'ms', label: 'Verzögerung', ui: { min: 1, max: 35, step: 0.1, digits: 1 } },
      side: { def: 'right', enum: ['left', 'right'], label: 'Klang wandert nach', ui: { options: { left: 'Links', right: 'Rechts' } } },
      level: { def: 0, range: [-24, 6], unit: 'dB', label: 'Pegel verzögerter Kanal', ui: { min: -24, max: 6, step: 0.5, signed: true } }
    } },
  // Phase 13f: Doppler — Vorbeifahrt auf einer Geraden im Abstand `minDistance` (Entscheidung A: eigenständig, nicht an Spatial gekoppelt).
  // Tonhöhe über die Laufzeit (Entscheidung C: exakte Sendezeit, Doppler-Faktor c/(c + v_r)), dazu Abstandspegel, Luftdämpfung (Tiefpass)
  // und Panorama; jeder Anteil skalierbar. Zeitpunkt der größten Nähe `closest` (0 = nur Entfernen, 1 = nur Herankommen). Bewegung über die
  // Zeitbasis (13d) wie Spatial; Standard = einmal über die ganze Clip-Dauer (Entscheidung D). Verzögerung höchstens DOPPLER_MAX_DELAY_S
  // (Entscheidung B: weiter weg „parkt“ die Quelle). Alle Regler live (die Bahn wird ab „jetzt“ neu geplant).
  { key: 'doppler', ui: { generated: true }, family: 'stereo', label: 'Doppler (Vorbeifahrt)', layerOrder: 148, consumers: ALL_CONSUMERS, cost: dopplerCost,
    tail: p => dopplerTailSeconds(p),
    params: {
      direction: { def: 'leftToRight', enum: ['leftToRight', 'rightToLeft'], label: 'Richtung', ui: { options: { leftToRight: 'Links → rechts', rightToLeft: 'Rechts → links' } } },
      speed: { def: 20, range: [1, 150], unit: 'm/s', label: 'Geschwindigkeit', ui: { min: 1, max: 150, step: 0.5, scale: 'log', digits: 1 } },
      minDistance: { def: 5, range: [0.5, 100], unit: 'm', label: 'Nächste Distanz', ui: { min: 0.5, max: 100, step: 0.1, scale: 'log', digits: 1 } },
      closest: { def: 0.5, range: [0, 1], label: 'Größte Nähe bei', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      motion: { def: 'once', enum: ['once', 'loop'], label: 'Vorbeifahrt', ui: { options: { once: 'Einmal je Start', loop: 'Je Durchlauf (Loop)' } } },
      motionUnit: { def: 'relative', enum: ['seconds', 'relative'], label: 'Dauer angeben', ui: { options: { seconds: 'in Sekunden', relative: 'als Anteil der Clip-Dauer' } } },
      motionTime: { def: 4, range: [0.05, 600], unit: 's', label: 'Dauer', ui: { min: 0.05, max: 60, step: 0.05, scale: 'log', digits: 2, showIf: { motionUnit: ['seconds'] } } },
      motionShare: { def: 1, range: [0.01, 1], label: 'Dauer (Anteil)', ui: { min: 0.01, max: 1, step: 0.01, percent: true, showIf: { motionUnit: ['relative'] } } },
      pitchAmount: { def: 1, range: [0, 1], label: 'Anteil Tonhöhe', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      levelAmount: { def: 1, range: [0, 1], label: 'Anteil Pegel (Abstand)', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      airAmount: { def: 0.5, range: [0, 1], label: 'Luftdämpfung (Tiefpass)', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      panAmount: { def: 1, range: [0, 1], label: 'Anteil Panorama', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  // Phase 14c: Multiband-Delay — LR4-Dreibandweiche (engine/crossover.js, wie der Multiband-Kompressor), je Band eine Echoschleife mit eigener Zeit,
  // Rückkopplung und Pegel (Delay → Rückkopplung → Schutzsättigung). Kanalerhaltend wie das Mono-Delay (Mono bleibt mono), keine Exklusivgruppe,
  // sitzt direkt hinter `delay` (layerOrder 121, vor dem Tremolo). Alle Regler live.
  { key: 'delayMultiband', stageHint: p => (Math.max(...DMB_BANDS.map(b => p?.[b + 'Time'] ?? 0)) >= 0.12 ? { stage: 'environment', weight: 1 } : null), ui: { generated: true }, family: 'space', label: 'Multiband-Delay (3 Bänder)', layerOrder: 121, consumers: ALL_CONSUMERS,
    cost: () => ({ base: 22, measured: false, estimate: 'delay' }),   // Weiche 9 Biquads + Summe, je Band Delay, Rückkopplung, Sättigung, Pegel
    tail: p => delayMultibandTail(p),
    params: {
      crossLow: { def: 300, range: [40, 1000], unit: 'Hz', label: 'Weiche Tiefen/Mitten', ui: { min: 40, max: 1000, step: 5, scale: 'log', digits: 0 } },
      crossHigh: { def: 3000, range: [1000, 12000], unit: 'Hz', label: 'Weiche Mitten/Höhen', ui: { min: 1000, max: 12000, step: 50, scale: 'log', digits: 0 } },
      lowTime: { def: 0.3, range: [0, 2], unit: 's', label: 'Tiefen: Zeit', ui: { min: 0.01, max: 2, step: 0.01 } },
      lowFeedback: { def: 0.4, range: [0, 0.95], label: 'Tiefen: Rückkopplung', ui: { min: 0, max: 0.95, step: 0.01, percent: true } },
      lowLevel: { def: 1, range: [0, 1], label: 'Tiefen: Pegel', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      midTime: { def: 0.2, range: [0, 2], unit: 's', label: 'Mitten: Zeit', ui: { min: 0.01, max: 2, step: 0.01 } },
      midFeedback: { def: 0.3, range: [0, 0.95], label: 'Mitten: Rückkopplung', ui: { min: 0, max: 0.95, step: 0.01, percent: true } },
      midLevel: { def: 1, range: [0, 1], label: 'Mitten: Pegel', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      highTime: { def: 0.12, range: [0, 2], unit: 's', label: 'Höhen: Zeit', ui: { min: 0.01, max: 2, step: 0.01 } },
      highFeedback: { def: 0.2, range: [0, 0.95], label: 'Höhen: Rückkopplung', ui: { min: 0, max: 0.95, step: 0.01, percent: true } },
      highLevel: { def: 1, range: [0, 1], label: 'Höhen: Pegel', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      wet: { def: 0.35, range: [0, 1], label: 'Anteil (Wet)', ui: { min: 0, max: 0.95, step: 0.01, percent: true } }
    } },
  // Phase 15c: Bitcrusher mit echter Sample-Rate-Reduktion im Worklet `crusher` (B-21; Rechenkern audio/dsp-lib/crusher.js). Ohne Worklet: native
  // Quantisierungskurve OHNE Sample-Rate-Reduktion (Fallback 'native', Ereignis sb:fx-fallback). Sitzt hinter der Verzerrung, vor der Ringmodulation
  // (layerOrder 75). Alle Regler live. Die bisherige Verzerrung im Modus `bitcrush` bleibt unverändert (Entscheidung B, P15).
  { key: 'crusher', stageHint: { stage: 'medium', weight: 1 }, ui: { generated: true }, family: 'distortion', label: 'Bitcrusher / Sample-Rate', layerOrder: 75, consumers: ALL_CONSUMERS,
    needsWorklet: true, workletModules: ['crusher'], cost: () => ({ base: 3, measured: false, estimate: 'crusher' }),
    params: {
      bits: { def: 8, range: CRUSHER_BITS_RANGE, unit: 'Bit', label: 'Bittiefe', ui: { min: 1, max: 16, step: 1, digits: 0 } },
      targetRate: { def: 8000, range: CRUSHER_RATE_RANGE, unit: 'Hz', label: 'Sample-Rate (Ziel)', ui: { min: 200, max: 48000, step: 10, scale: 'log', digits: 0 } },
      jitter: { def: 0, range: [0, 1], label: 'Jitter', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } }
    } },
  // Phase 16a: Frequenzschieber (Einseitenband, nativ, AE-06): IIR-Hilbert-Paar (engine/hilbert.js, je Pfad ein IIRFilterNode 8. Ordnung) liefert I/Q,
  // zwei Oszillatoren (cos/sin) mit gemeinsamer Frequenz = `shift` (negativ = nach unten, live auch durch 0) und zwei Multiplikatoren.
  // Dry-Pfad = I-Pfad (Entscheidung B, P16): bei Shift 0 sind Dry und Wet deckungsgleich, Mix ohne Auslöschung; Betrag flach, Phase allpassverschoben.
  // Sitzt direkt hinter der Ringmodulation (layerOrder 82, Entscheidung A). Shift/Mix live; 16b: Spreizung/Rückkopplung live, nur 0 ↔ > 0 = Neubau.
  { key: 'freqShift', stageHint: { stage: 'source', weight: 2 }, ui: { generated: true }, family: 'distortion', label: 'Frequenzverschiebung', layerOrder: 82, consumers: ALL_CONSUMERS,
    cost: p => freqShiftCost(p), tail: p => freqShiftTail(p),
    params: {
      shift: { def: 100, range: FREQ_SHIFT_RANGE, unit: 'Hz', label: 'Verschiebung', ui: { min: -1000, max: 1000, step: 1, signed: true, digits: 0 } },
      mix: { def: 1, range: [0, 1], label: 'Mix', ui: { min: 0, max: 1, step: 0.01, percent: true } },
      // Phase 16b (additiv): Spreizung — links Verschiebung + Spreizung, rechts − Spreizung; > 0 macht eine Mono-Quelle zweikanalig. Rückkopplung über 128 Samples
      // (Mindestverzögerung, ≈ 2,7 ms bei 48 kHz): jeder Umlauf verschiebt erneut (Barber-Pole/Spiralklang). 0 ↔ > 0 jeweils Neubau, sonst live.
      stereoSpread: { def: 0, range: FREQ_SHIFT_SPREAD_RANGE, unit: 'Hz', label: 'Stereo-Spreizung', ui: { min: 0, max: 200, step: 1, digits: 0 } },
      feedback: { def: 0, range: [0, FREQ_SHIFT_FEEDBACK_MAX], label: 'Rückkopplung', ui: { min: 0, max: FREQ_SHIFT_FEEDBACK_MAX, step: 0.01, percent: true } }
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

/** Latenz eines Moduls in Samples (Lookahead-Module; sonst 0). */
export function moduleLatency(key, params, sampleRate = 48000) {
  const m = MODULE_BY_KEY[key];
  return m && typeof m.latencySamples === 'function' ? m.latencySamples(params, sampleRate) : 0;
}

/** Kostenpunkte eines Moduls für die gegebenen Parameter: { base, measured }. */
export function moduleCost(key, params) {
  const m = MODULE_BY_KEY[key];
  if (!m) return { base: 0, measured: false };
  return typeof m.cost === 'function' ? m.cost(params) : { ...m.cost };
}
