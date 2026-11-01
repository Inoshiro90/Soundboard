/**
 * audio/engine/distortion-curves.js — Kurvenbibliothek der Verzerrung v2 (Phase 15a). REIN (kein AudioContext, in Node testbar).
 * ------------------------------------------------------------------------------------------------------------------------
 * Die bisherigen Modi softClip/hardClip/bitcrush bleiben in effect-graph.js (`_buildDistortionCurve`, 513 Punkte) und werden hier NICHT
 * berührt (Goldens 03/04 bit-gleich). Diese Datei beschreibt nur die neuen Modi.
 *
 * Kurve eines neuen Modus: Eingang x ∈ [−1, 1] (WaveShaper-Bereich), u = D · x + bias mit D = 10^(drive/20),
 *   y(x) = comp · (f(u) − f(bias))
 * - `f(bias)` wird abgezogen: Stille bleibt exakt 0 (ungerade Punktzahl, x = 0 liegt auf einer Stützstelle, vgl. N-01).
 * - `comp` = Pegelkompensation: gleicher Effektivwert wie der Eingang für das Referenzsignal DIST_COMP_REF (siehe distortionCompensation).
 * - Asymmetrische Modi (Tube, Fuzz) und jeder Bias ≠ 0 erzeugen einen Gleichanteil im Signal → DC-Blocker im Builder (distortionNeedsDcBlock).
 * Phase 15b: `tape` (weiche Arcustangens-Kennlinie; Höhenabsenkung und Wow/Flutter baut effect-graph.js) und `waveshaper` (Kennlinie aus den
 * Kurvenpunkten `points`, monoton-kubisch interpoliert nach Fritsch–Carlson: läuft exakt durch die Punkte, ohne Überschwingen).
 */

/** Bisherige Modi (eigene Kurvenformel in effect-graph.js, unverändert). */
export const DISTORTION_LEGACY_MODES = ['softClip', 'hardClip', 'bitcrush'];
/** Neue Modi (15a). Ein Modus kommt erst zusammen mit seinem Builder in die Liste (ungültige Enum-Werte werden beim Import zum Standard). */
export const DISTORTION_V2_MODES = ['saturation', 'tube', 'overdrive', 'fuzz', 'fold', 'tape', 'waveshaper'];
/** Stützstellen der neuen Kurven (ungerade: x = 0 exakt auf Index (N − 1)/2). Bei Drive 40 dB ist ein Schritt in u ≈ 0,024. */
export const DIST_CURVE_POINTS = 8193;
/** Drive-Bereich (dB) und Bias-Bereich (Einheit von u). */
export const DIST_DRIVE_RANGE = [0, 40];
export const DIST_BIAS_RANGE = [-1, 1];
/** Tube: innerer Arbeitspunkt (asymmetrische Kennlinie → gerade Harmonische). */
export const TUBE_BETA = 0.35;
/** Fuzz: innere Verstärkung und negative Begrenzung (asymmetrisch, nahezu Rechteck). */
export const FUZZ_GAIN = 5;
export const FUZZ_NEG = 0.6;

const _schetzen = a => (a < 1 / 3 ? 2 * a : a < 2 / 3 ? (3 - (2 - 3 * a) ** 2) / 3 : 1);
/** Kennlinien f(u) der neuen Modi. Steigung bei u = 0 ist 1 (außer Fuzz: FUZZ_GAIN), die Pegelkompensation gleicht das aus. */
const SHAPES = {
  saturation: u => Math.tanh(u),
  tube: u => Math.tanh(u + TUBE_BETA) - Math.tanh(TUBE_BETA),
  // Overdrive: weiche quadratische Knie-Kennlinie nach Schetzen (symmetrisch, linear bis |u| = 2/3, Sättigung ab 4/3)
  overdrive: u => Math.sign(u) * _schetzen(Math.abs(u) / 2),
  fuzz: u => (u >= 0 ? Math.tanh(FUZZ_GAIN * u) : FUZZ_NEG * Math.tanh(FUZZ_GAIN * u / FUZZ_NEG)),
  // Foldback (Dreieck): |u| ≤ 1 linear, darüber an ±1 gespiegelt
  fold: u => { const v = (((u + 1) % 4) + 4) % 4; return v < 2 ? v - 1 : 3 - v; },
  // Tape (15b): Arcustangens — sättigt langsamer als tanh (weicher, „komprimierend“), symmetrisch
  tape: u => (2 / Math.PI) * Math.atan(Math.PI * u / 2)
};

// ─── Waveshaper: Kurvenpunkte (15b) ──────────────────────────────────────────────────────────
/** Punkte je { x (Eingang −1 … +1), y (Ausgang −1 … +1) } (+ unbekannte Felder bleiben, AE-18). Bis WS_POINTS_MAX werden erhalten UND benutzt. */
export const WS_POINTS_MAX = 16;
export const WS_POINT_RANGES = { x: [-1, 1], y: [-1, 1] };
/** Standard: weiche S-Kurve (symmetrisch). */
export const WS_DEFAULT_POINTS = [
  { x: -1, y: -0.8 }, { x: -0.4, y: -0.55 }, { x: 0, y: 0 }, { x: 0.4, y: 0.55 }, { x: 1, y: 0.8 }
];
/**
 * Stützpunkte für die Engine: gültige Objekte, geklemmt, nach x sortiert, gleiche x zusammengefasst (der erste gewinnt).
 * Weniger als 2 Punkte → Gerade y = x (Durchgang). Die DATEN bleiben unverändert (Reihenfolge, Duplikate).
 */
export function waveshaperKnots(points) {
  const list = (Array.isArray(points) ? points : []).filter(p => p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y))
    .slice(0, WS_POINTS_MAX).map(p => [_clamp(-1, 1, p.x), _clamp(-1, 1, p.y)]);
  const seen = new Set(), k = [];
  for (const q of list.sort((a, b) => a[0] - b[0])) { if (seen.has(q[0])) continue; seen.add(q[0]); k.push(q); }
  return k.length >= 2 ? k : [[-1, -1], [1, 1]];
}
/** Monoton-kubische Interpolation (Fritsch–Carlson) durch die Stützpunkte; außerhalb des ersten/letzten Punkts konstant. */
export function waveshaperFunction(points) {
  const k = waveshaperKnots(points), n = k.length, X = k.map(q => q[0]), Y = k.map(q => q[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((Y[i + 1] - Y[i]) / (X[i + 1] - X[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return u => {
    const x = _clamp(-1, 1, u);
    if (x <= X[0]) return Y[0];
    if (x >= X[n - 1]) return Y[n - 1];
    let i = 0; while (i < n - 2 && x > X[i + 1]) i++;
    const h = X[i + 1] - X[i], t = (x - X[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * Y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * Y[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
/** Punktliste ungerade-symmetrisch (f(−u) = −f(u))? Dann braucht der Waveshaper ohne Bias keinen DC-Blocker. */
export function waveshaperIsOdd(points) {
  const f = waveshaperFunction(points);
  for (let i = 0; i <= 64; i++) { const u = i / 64; if (Math.abs(f(u) + f(-u)) > 1e-9) return false; }
  return true;
}
const _shapeOf = (mode, points) => (mode === 'waveshaper' ? waveshaperFunction(points) : SHAPES[mode] || null);

export const distortionIsV2Mode = mode => DISTORTION_V2_MODES.includes(mode);
const _fin = (v, d) => (Number.isFinite(v) ? v : d);
const _clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
export const distortionDrive = p => _clamp(DIST_DRIVE_RANGE[0], DIST_DRIVE_RANGE[1], _fin(p?.drive, 12));
export const distortionBias = p => _clamp(DIST_BIAS_RANGE[0], DIST_BIAS_RANGE[1], _fin(p?.bias, 0));
/** Modi mit asymmetrischer Kennlinie; mit Bias ≠ 0 ist jeder Modus asymmetrisch. */
export const DISTORTION_ASYM_MODES = ['tube', 'fuzz'];
export const distortionNeedsDcBlock = (mode, bias, points) => DISTORTION_ASYM_MODES.includes(mode) || bias !== 0 || (mode === 'waveshaper' && !waveshaperIsOdd(points));

/** Referenz der Pegelkompensation: drei Sinusperioden mit den Spitzen DIST_COMP_REF_PEAKS (≈ −18/−12/−6 dBFS), je 256 Stützstellen. */
export const DIST_COMP_REF_PEAKS = [0.125, 0.25, 0.5];
const _REF = (() => { const n = 256, a = []; for (const pk of DIST_COMP_REF_PEAKS) for (let i = 0; i < n; i++) a.push(pk * Math.sin(2 * Math.PI * (i + 0.5) / n)); return Float64Array.from(a); })();

/**
 * Pegelkompensation (linear): Effektivwert des Referenzsinus durch Effektivwert der verzerrten Referenz (ohne Gleichanteil, den entfernt der DC-Blocker).
 * Damit bleibt der Ausgangspegel über den ganzen Drive-Bereich nahe am Eingangspegel (Test: ±3 dB).
 */
export function distortionCompensation(mode, driveDb, bias = 0, points = null) {
  const f = _shapeOf(mode, points);
  if (!f) return 1;
  const D = 10 ** (driveDb / 20), f0 = f(bias);
  let m = 0, s = 0, si = 0;
  const ys = _REF.map(x => f(_clamp(-1, 1, x) * D + bias) - f0);
  for (const y of ys) m += y;
  m /= ys.length;
  for (let i = 0; i < ys.length; i++) { s += (ys[i] - m) ** 2; si += _REF[i] ** 2; }
  return s > 0 ? Math.sqrt(si / s) : 1;
}

/** Kurve eines neuen Modus (Float32Array, DIST_CURVE_POINTS Punkte) samt Kompensation. Unbekannter Modus → null. `points` nur für `waveshaper`. */
export function buildDistortionCurveV2(mode, driveDb, bias = 0, points = null) {
  const f = _shapeOf(mode, points);
  if (!f) return null;
  const n = DIST_CURVE_POINTS, h = (n - 1) / 2, curve = new Float32Array(n);
  const D = 10 ** (driveDb / 20), f0 = f(bias), comp = distortionCompensation(mode, driveDb, bias, points);
  for (let i = 0; i < n; i++) {
    const x = (i - h) / h;                               // x(h) = 0 exakt
    curve[i] = comp * (f(D * x + bias) - f0);
  }
  curve[h] = 0;
  return curve;
}

/** Kennlinie als Funktion (für Tests, Dokumentation und die Kurvenvorschau der Oberfläche). */
export const distortionShape = (mode, points = null) => _shapeOf(mode, points);

// ─── Tape (15b): feste Höhenabsenkung und Wow/Flutter (Mikro-Vibrato über eine modulierte Verzögerung) ─────────────────
export const TAPE_HF_HZ = 9000;                 // Tiefpass hinter der Kennlinie (Bandkopf-/Bandverluste), Butterworth
export const TAPE_BASE_DELAY_S = 0.002;         // Grundverzögerung des Vibratos (≥ größte Auslenkung); der Dry-Pfad wartet mit
export const TAPE_WOW_HZ = 0.7, TAPE_WOW_MAX_S = 0.0015;        // Wow 100 %: ±1,5 ms bei 0,7 Hz ≈ ±0,66 % Tonhöhe
export const TAPE_FLUTTER_HZ = 7.3, TAPE_FLUTTER_MAX_S = 0.0001; // Flutter 100 %: ±0,1 ms bei 7,3 Hz ≈ ±0,46 % Tonhöhe
/** Größte relative Tonhöhenabweichung (Anteil) bei Wow/Flutter w, f ∈ [0, 1]: 2π · (Rate · Auslenkung) je LFO, Summe als Obergrenze. */
export const tapePitchDeviation = (w, f) => 2 * Math.PI * (TAPE_WOW_HZ * TAPE_WOW_MAX_S * w + TAPE_FLUTTER_HZ * TAPE_FLUTTER_MAX_S * f);
