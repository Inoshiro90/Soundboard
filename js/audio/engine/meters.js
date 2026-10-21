/**
 * audio/engine/meters.js — Stereo-Peak-Meter-Logik (Phase 6), rein und ohne DOM/AudioContext
 *
 * Eingabe sind lineare Spitzenwerte je Kanal (aus `bus.readPeaks()`), Ausgabe Anzeigewerte in dBFS mit Peak-Hold und
 * Clip-Hold. Die Ballistik entspricht der des Trim-Meters (ui/meters.js): neuer Peak sofort, nach der Haltezeit klingt
 * der gehaltene Wert mit 20 dB/s ab. „Clip“ = Pegel ≥ Ceiling (vor dem Begrenzer, Entscheidung d), wird CLIP_HOLD_MS gehalten.
 */
import { CEILING } from './buses.js';

export const METER_FLOOR_DB = -60;      // Anzeigebereich −60 … 0 dBFS
export const PEAK_HOLD_MS = 1500;
export const CLIP_HOLD_MS = 2000;
export const FALL_DB_PER_S = 20;

/** Linear → dBFS (0 → −Infinity). */
export function toDb(x) { return x > 0 ? 20 * Math.log10(x) : -Infinity; }

/** Anzeige-Anteil 0..1 für einen dB-Wert (−60 … 0 dBFS linear abgebildet). */
export function dbToFraction(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** Größter Betrag in einem Sample-Feld. */
export function peakOf(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > p) p = a; }
  return p;
}

/**
 * Zustand eines Stereo-Meters.
 * `update(peakL, peakR, nowMs)` liefert { dbL, dbR, holdL, holdR, clip, clipL, clipR } (dBFS bzw. Wahrheitswerte).
 */
export function createMeterState({ ceiling = CEILING, peakHoldMs = PEAK_HOLD_MS, clipHoldMs = CLIP_HOLD_MS, fall = FALL_DB_PER_S } = {}) {
  let holdL = -Infinity, holdR = -Infinity, atL = 0, atR = 0, lastT = null, clipUntil = 0, clipLUntil = 0, clipRUntil = 0;
  const hold = (h, at, db, now, dt) => {
    if (db >= h) return [db, now];
    if (now - at > peakHoldMs) return [Math.max(db, h - fall * dt), at];
    return [h, at];
  };
  return {
    update(peakL, peakR, nowMs) {
      const dt = lastT == null ? 0 : Math.max(0, (nowMs - lastT) / 1000); lastT = nowMs;
      const dbL = toDb(peakL), dbR = toDb(peakR);
      [holdL, atL] = hold(holdL, atL, dbL, nowMs, dt);
      [holdR, atR] = hold(holdR, atR, dbR, nowMs, dt);
      if (peakL >= ceiling) clipLUntil = nowMs + clipHoldMs;
      if (peakR >= ceiling) clipRUntil = nowMs + clipHoldMs;
      clipUntil = Math.max(clipLUntil, clipRUntil);
      return { dbL, dbR, holdL, holdR, clip: nowMs < clipUntil, clipL: nowMs < clipLUntil, clipR: nowMs < clipRUntil };
    },
    reset() { holdL = holdR = -Infinity; atL = atR = 0; lastT = null; clipUntil = clipLUntil = clipRUntil = 0; }
  };
}

/** Text für Anzeige/Screenreader, z. B. „L −6,0 dB · R −12,3 dB“ bzw. „Clip“. */
export function meterText(s) {
  const f = v => Number.isFinite(v) ? v.toFixed(1).replace('.', ',').replace('-', '−') + ' dB' : '−∞ dB';
  return `L ${f(s.dbL)} · R ${f(s.dbR)}` + (s.clip ? ' · Clip' : '');
}
