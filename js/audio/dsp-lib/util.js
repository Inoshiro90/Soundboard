/**
 * audio/dsp-lib/util.js — Kleine, reine DSP-Hilfen (Phase 5).
 * Regeln für die gesamte dsp-lib: keine DOM-/AudioContext-Zugriffe, keine Allokation in Audio-Schleifen,
 * nur statische Importe untereinander (die Dateien werden auch von AudioWorklet-Modulen importiert, Plan §5.4).
 */

/** Unterhalb dieser Größe werden Zustandswerte auf 0 gesetzt (Denormal-Schutz in Rückkopplungen). */
export const DENORMAL_FLOOR = 1e-20;

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** NaN/Inf → 0 (Schutz am Eingang eines Prozessors). */
export const finiteOr0 = x => (Number.isFinite(x) ? x : 0);

/** Denormale und Winzwerte auf 0 setzen. */
export const flush = x => (x > -DENORMAL_FLOOR && x < DENORMAL_FLOOR ? 0 : x);

export const dbToLin = db => Math.pow(10, db / 20);

/** Linear → dB; Werte ≤ 0 ergeben `floorDb` statt -Infinity. */
export const linToDb = (lin, floorDb = -120) => (lin > 0 ? Math.max(floorDb, 20 * Math.log10(lin)) : floorDb);
