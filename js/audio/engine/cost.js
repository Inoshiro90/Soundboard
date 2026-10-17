/**
 * audio/engine/cost.js — Kostenmodell (AE-13′, Phase 3a): Kostenpunkte einer Voice bzw. eines Plans. REIN, ohne AudioContext,
 * damit VoiceManager, Kalibrierung und Tests es ohne Audio nutzen können.
 * ----------------------------------------------------------------------------------------------------------------------
 * Einheit: 1 Punkt = Rechenzeit eines Tiefpass-Biquads (Registry, Messung M-1). Die Kapazität in Punkten kommt aus der
 * Kalibrierung (calibrate.js).
 *
 * Gezählt wird, was die Engine TATSÄCHLICH baut: aktive, nicht überlagerte Module (B-02) und Pitch nur mit Halbtönen ≠ 0.
 *
 * Geteilter Hall (AE-17, Phase 3b): Ist `send` gesetzt (Ergebnis von sendEligibility), zählt der Hall NICHT je Voice, sondern
 * einmal je Hub (`hub.points`); je Voice bleibt nur `SEND_VOICE_POINTS` (Gain-Knoten) [S Chrome: 16 geteilte Voices ≈ 1 Faltung].
 * Wer mehrere Voices summiert, ruft `sumCosts` auf: gleiche `hub.irKey` zählen einmal.
 *
 * Degradation (`degrade`, AE-16): { oversample: 'none'|'2x'|'4x' (Obergrenze), equalPower: bool (HRTF → Equal-Power), irMax: Sekunden }.
 * Sie senkt nur die SCHÄTZUNG; angewandt wird sie im Graph-Aufbau (spätere Schritte von P3a).
 */
import { moduleCost, convolverPoints } from './registry.js';
import { effectiveActiveKeys } from './schema.js';
import { getIRDuration } from '../ir-data.js';

/** Rest-Kosten einer Voice, die ihren Hall an einen Hub sendet (Send-Gain, Dry-Gain, Stand-in) [S Chrome: ≈ 0,3 je Voice]. */
export const SEND_VOICE_POINTS = 0.3;
/** Equal-Power-Panner statt HRTF [H]: Größenordnung eines StereoPanners, nicht gemessen. */
export const EQUALPOWER_POINTS = 1;

const OVERSAMPLE_ORDER = ['none', '2x', '4x'];
const OVERSAMPLE_POINTS = { none: 1, '2x': 5, '4x': 10 };

/** Klingende Module eines Schritts (wie fx-pipeline `_soundingKeys`): aktiv, nicht überlagert, Pitch nur mit Halbtönen ≠ 0. */
export function soundingKeys(params) {
  return effectiveActiveKeys(params).filter(k => k !== 'pitchShift' || (params.pitchShift.enabled && params.pitchShift.semitones));
}

/** IR-Länge (s) des Hall-Moduls `key` mit den Parametern `p`. */
export function reverbSeconds(key, p) {
  if (key === 'irReverb') return Math.min(getIRDuration(p?.impulse ?? null), Number.isFinite(p?.irMax) ? p.irMax : Infinity);   // irMax: bereits degradierter Plan
  if (key === 'reverb') return Number(p?.duration ?? 2.2) || 0;
  return 0;
}

function _moduleCost(key, p, degrade) {
  let base = moduleCost(key, p).base || 0;
  if (key === 'spatial' && p?.equalPower) base = Math.min(base, EQUALPOWER_POINTS);                    // bereits degradierter Plan
  if (key === 'irReverb' && Number.isFinite(p?.irMax)) base = convolverPoints(reverbSeconds(key, p));    // desgleichen
  if (!degrade) return base;
  if (key === 'distortion' && degrade.oversample) {
    const cur = p?.oversample ?? '4x';
    const cap = OVERSAMPLE_ORDER.indexOf(degrade.oversample), have = OVERSAMPLE_ORDER.indexOf(cur);
    if (cap >= 0 && have > cap) base = OVERSAMPLE_POINTS[degrade.oversample];
  }
  if (key === 'spatial' && degrade.equalPower) base = Math.min(base, EQUALPOWER_POINTS);
  if ((key === 'irReverb' || key === 'reverb') && Number.isFinite(degrade.irMax)) {
    const s = reverbSeconds(key, p);
    if (s > degrade.irMax) base = convolverPoints(degrade.irMax);
  }
  return base;
}

/**
 * Kosten eines Plans (eine Voice).
 * @param {object} plan   resolvePlan(effects)
 * @param {object} [o]    { send: Ergebnis von sendEligibility(plan) | null, degrade }
 * @returns {{points:number, parts:{step:number,key:string,points:number}[], hub:{irKey:string,points:number}|null, measured:boolean}}
 *   points = Kosten dieser Voice OHNE den gemeinsamen Hub; hub = einmalige Hub-Kosten (nur bei `send`).
 */
export function planCost(plan, { send = null, degrade = null } = {}) {
  const parts = [];
  let hub = null;
  let measured = true;
  (plan?.steps || []).forEach(step => {
    for (const key of soundingKeys(step.params)) {
      const isSendReverb = send && step.index === send.step && key === send.key;
      if (isSendReverb) {
        const secs = Math.min(reverbSeconds(key, step.params[key]), degrade && Number.isFinite(degrade.irMax) ? degrade.irMax : Infinity);
        hub = { irKey: send.irKey, points: convolverPoints(secs) };
        parts.push({ step: step.index, key, points: SEND_VOICE_POINTS });
        continue;
      }
      const c = moduleCost(key, step.params[key]);
      if (!c.measured) measured = false;
      parts.push({ step: step.index, key, points: _moduleCost(key, step.params[key], degrade) });
    }
  });
  const points = parts.reduce((s, p) => s + p.points, 0);
  return { points, parts, hub, measured };
}

/**
 * Summe mehrerer Voice-Kosten: Voice-Punkte addiert, jeder Hub (gleicher `irKey`) einmal.
 * Eingabe: Ergebnisse von planCost (oder { points, hub }-Objekte).
 */
export function sumCosts(costs) {
  let voices = 0; const hubs = new Map();
  for (const c of costs) {
    voices += c.points || 0;
    if (c.hub) hubs.set(c.hub.irKey, Math.max(hubs.get(c.hub.irKey) || 0, c.hub.points));
  }
  let hubPoints = 0; for (const v of hubs.values()) hubPoints += v;
  return { points: voices + hubPoints, voicePoints: voices, hubPoints, hubs: hubs.size };
}

/**
 * Kosten, die das Entfernen EINER Voice aus der Summe spart (Grundlage für die Auswahl „welche weg“):
 * Voice-Punkte plus Hub-Punkte, wenn sie der letzte Nutzer des Hubs ist.
 */
export function releaseSavings(cost, allCosts) {
  let s = cost.points || 0;
  if (cost.hub && !allCosts.some(o => o !== cost && o.hub && o.hub.irKey === cost.hub.irKey)) s += cost.hub.points;
  return s;
}
