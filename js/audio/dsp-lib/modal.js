/**
 * audio/dsp-lib/modal.js — Rechenkern des Moduls `modal` (Phase 21d): parallele Bandpass-Biquads (Moden), reine Funktionen ohne Web Audio.
 * -------------------------------------------------------------------------------------------------------------------------------------
 * Der Graph (effect-graph.js _buildModal) baut die Moden aus nativen BiquadFilterNodes vom Typ 'bandpass'. Deren Koeffizienten stehen in
 * der Web-Audio-Spezifikation fest (Audio-EQ-Cookbook, Bandpass mit 0 dB im Gipfel; Q linear):
 *   w0 = 2π f / sr, α = sin(w0) / (2 Q), a0 = 1 + α
 *   b0 = α / a0, b1 = 0, b2 = −α / a0, a1 = −2 cos(w0) / a0, a2 = (1 − α) / a0
 * Die Pole liegen bei r · e^(±i w0') mit r² = a2 = (1 − α) / (1 + α). Die Hüllkurve der Impulsantwort fällt wie rⁿ; für RT60 = T (s) gilt
 * r = 10^(−3 / (T · sr)) und damit α = (1 − r²) / (1 + r²), Q = sin(w0) / (2 α) — exakt, ohne Näherung Q ≈ π f T / ln 1000.
 *
 * Pegelkompensation: Leistungsverstärkung der ganzen Bank für weißes Rauschen = Energie der summierten Impulsantwort Σ gₖ hₖ, in
 * geschlossener Form über Partialbrüche (je Mode ein Polpaar) einschließlich aller Kreuzterme (nah beieinander liegende Moden sind
 * korreliert). Kein Simulationsfenster, Rechenzeit ≈ 16² · 4 komplexe Terme.
 *
 * Weicher Limiter: dieselbe Kennlinie wie im Kamm-Kern (combSoft: linear bis ±1, darüber 1 + tanh(v − 1), Grenze ±2). Nativ als WaveShaper:
 * Eingang × 1/MODAL_LIMIT_SCALE (in die Modenpegel eingerechnet), Kurve über ±MODAL_LIMIT_SCALE, Ausgang × MODAL_LIMIT_SCALE. Die Stützstellen
 * liegen so, dass ±1 genau auf einer Stützstelle liegt: im Bereich |v| ≤ 1 ist die Kurve eine Gerade und die Interpolation exakt.
 */

import { combSoft } from './combbank.js';

/** Vorskalierung des Limiters (Kurve deckt ±8 ab; darüber steht combSoft bei 1 + tanh(7) ≈ 2). */
export const MODAL_LIMIT_SCALE = 8;
/** Stützstellen der Limiter-Kurve: 2 · 8 · 256 + 1 → Schrittweite 1/256 im Signalmaß, ±1 auf Index 2048 ± 256. */
export const MODAL_CURVE_POINTS = 2 * MODAL_LIMIT_SCALE * 256 + 1;

/** Polradius für RT60 = rt60 (s). */
export const modalPoleRadius = (rt60, sr) => Math.pow(10, -3 / (rt60 * sr));

/**
 * Koeffizienten einer Mode (Frequenz f in Hz, Nachklang rt60 in s) wie der native Bandpass sie bildet.
 * @returns {{ Q:number, b0:number, b2:number, a1:number, a2:number, r:number, w0:number }}
 */
export function modalSection(f, rt60, sr) {
  const r = modalPoleRadius(rt60, sr), w0 = 2 * Math.PI * f / sr;
  const alpha = (1 - r * r) / (1 + r * r);
  const Q = Math.sin(w0) / (2 * alpha);
  const a0 = 1 + alpha;
  return { Q, b0: alpha / a0, b2: -alpha / a0, a1: -2 * Math.cos(w0) / a0, a2: (1 - alpha) / a0, r, w0 };
}

/** Koeffizienten aus (f, Q) — so rechnet die Engine, wenn der Graph Frequenz und Q als AudioParam setzt. */
export function bandpassFromQ(f, Q, sr) {
  const w0 = 2 * Math.PI * f / sr, alpha = Math.sin(w0) / (2 * Q), a0 = 1 + alpha;
  return { b0: alpha / a0, b2: -alpha / a0, a1: -2 * Math.cos(w0) / a0, a2: (1 - alpha) / a0 };
}

// Komplexe Zahlen als [re, im].
const cMul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cDiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };

/**
 * Partialbruchzerlegung h[n] = d · δ[n] + R₁ p₁ⁿ + R₂ p₂ⁿ (n ≥ 0) einer Bandpass-Sektion (b0, b2 = −b0, a1, a2).
 * Mit w = z⁻¹: H = b0 (1 − w²) / ((1 − p₁ w)(1 − p₂ w)); d = −b0 / (p₁ p₂), Rᵢ = b0 (1 − pᵢ⁻²) / (1 − pⱼ / pᵢ).
 * Pole konjugiert komplex (Moden, Q > 0,5) oder reell (sehr breite Sektion); ein exakter Doppelpol wird minimal getrennt.
 */
export function sectionParts(s) {
  const re = -s.a1 / 2, disc = re * re - s.a2;
  let p1, p2;
  if (disc < 0) { const im = Math.sqrt(-disc); p1 = [re, im]; p2 = [re, -im]; }
  else { const q = Math.max(Math.sqrt(disc), 1e-9); p1 = [re + q, 0]; p2 = [re - q, 0]; }
  const res = (pi, pj) => {
    const inv = cDiv([1, 0], pi), inv2 = cMul(inv, inv), ratio = cDiv(pj, pi);
    return cMul([s.b0, 0], cDiv([1 - inv2[0], -inv2[1]], [1 - ratio[0], -ratio[1]]));
  };
  return { d: -s.b0 / s.a2, R: [res(p1, p2), res(p2, p1)], p: [p1, p2] };
}

/**
 * Leistungsverstärkung der Bank für weißes Rauschen: ‖Σ gₖ hₖ‖² (geschlossene Form, mono).
 * @param {{ section:object, g:number }[]} modes  — Sektion (modalSection/bandpassFromQ) und linearer Pegel je Mode (0 = aus)
 */
export function modalPowerGain(modes) {
  const parts = modes.filter(m => m.g !== 0).map(m => ({ g: m.g, ...sectionParts(m.section) }));
  let e = 0;
  for (const j of parts) {
    const sj0 = j.R[0][0] + j.R[1][0];
    for (const k of parts) {
      const sk0 = k.R[0][0] + k.R[1][0];
      let ip = j.d * k.d + j.d * sk0 + k.d * sj0;
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
        const pp = cMul(j.p[a], k.p[b]);
        ip += cDiv(cMul(j.R[a], k.R[b]), [1 - pp[0], -pp[1]])[0];
      }
      e += j.g * k.g * ip;
    }
  }
  return Math.max(0, e);
}

let _curve = null;
/** Kurve des WaveShapers (Float32Array, MODAL_CURVE_POINTS Werte): u ∈ [−1, 1] → combSoft(8 u) / 8. Einmal erzeugt, geteilt. */
export function modalLimiterCurve() {
  if (_curve) return _curve;
  const n = MODAL_CURVE_POINTS, c = new Float32Array(n), S = MODAL_LIMIT_SCALE;
  for (let i = 0; i < n; i++) { const u = (2 * i) / (n - 1) - 1; c[i] = combSoft(S * u) / S; }
  return (_curve = c);
}

/**
 * Referenzrechnung des ganzen Modulsignals in doppelter Genauigkeit (für Tests „Pipeline = Kern“): statische Kernwerte, kein Gleiten.
 * kernel = modalKernel(q, sr) aus der Registry ({ modes: [{ f, Q, gain, group }], width, mix, out }); Eingang Stereo (xL, xR) — eine Mono-Quelle
 * kommt im Graphen als L = R = x/√2 an (StereoPanner bei pan 0 am Moduleingang).
 * Signalweg wie im Graphen: Mode i → Gruppe i % 2 → Panorama (Gruppe 0: L √(1+w), R √(1−w); Gruppe 1 umgekehrt) → Limiter → × 8 · mix · out;
 * trocken × (1 − mix) · out.
 */
export function modalReference(kernel, xL, xR, sr) {
  const n = xL.length, w = kernel.width, S = MODAL_LIMIT_SCALE;
  const pan = [[Math.sqrt(1 + w), Math.sqrt(1 - w)], [Math.sqrt(1 - w), Math.sqrt(1 + w)]];
  const accL = new Float64Array(n), accR = new Float64Array(n);
  kernel.modes.forEach((m, i) => {
    if (!m.gain) return;
    const s = bandpassFromQ(m.f, m.Q, sr), pg = pan[m.group];
    for (const [x, acc, pc] of [[xL, accL, pg[0]], [xR, accR, pg[1]]]) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let t = 0; t < n; t++) {
        const xi = x[t], y = s.b0 * xi + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
        x2 = x1; x1 = xi; y2 = y1; y1 = y;
        acc[t] += pc * m.gain * y;
      }
    }
  });
  const wet = S * kernel.mix * kernel.out, dry = (1 - kernel.mix) * kernel.out;
  const L = new Float64Array(n), R = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    L[t] = dry * xL[t] + wet * combSoft(S * accL[t]) / S;
    R[t] = dry * xR[t] + wet * combSoft(S * accR[t]) / S;
  }
  return { L, R };
}
