/**
 * audio/engine/hilbert.js — IIR-Hilbert-Paar für den Frequenzschieber (Phase 16, Modul `freqShift`). Rein (kein AudioContext), in Node testbar.
 *
 * Zwei Allpass-Pfade nach Olli Niemitalo („Hilbert transform IIR filter“), je vier Sektionen 2. Ordnung in z⁻²:
 *     H_a(z) = (a² − z⁻²) / (1 − a²·z⁻²)
 * Pfad 1 (I) ist zusätzlich um ein Sample verzögert. Die Phasendifferenz der beiden Pfade beträgt über fast das ganze Band 90° (Fehler < 0,7°
 * zwischen ≈ 0,0003·fs und ≈ 0,4997·fs, s. hilbertPhaseError). Die Koeffizienten sind normierte Frequenzen, also für jede Abtastrate gültig.
 *
 * Phase 16 (Entscheidung „zusammengefasst“, 2026-10-31): Je Pfad werden die vier Sektionen zu EINEM Filter 8. Ordnung ausmultipliziert
 * (ein IIRFilterNode je Pfad statt vier). Gleiche Übertragungsfunktion; gemessen gleiche Bildunterdrückung [S Node, Chromium 153],
 * Kosten ≈ 2 statt ≈ 9 Biquad-Äquivalente. Die Pole liegen auf |z| = a (≤ 0,9988); die Engines rechnen IIRFilterNode in double.
 */

/** Koeffizienten a (nicht quadriert) nach Niemitalo. Pfad 1 = I (mit einem Sample Verzögerung), Pfad 2 = Q. */
export const HILBERT_A = Object.freeze({
  i: Object.freeze([0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737]),
  q: Object.freeze([0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278])
});

/** Polynommultiplikation (Koeffizienten in z⁻¹, Index = Potenz). */
function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) r[i + j] += p[i] * q[j];
  return r;
}

/** Einzelne Sektionen eines Pfads: [{ feedforward, feedback }] (Pfad 'i': Verzögerung in der ersten Sektion). */
export function hilbertSections(path) {
  const A = HILBERT_A[path === 'q' ? 'q' : 'i'];
  return A.map((a, k) => {
    const a2 = a * a;
    const ff = [a2, 0, -1];
    return { feedforward: path !== 'q' && k === 0 ? [0, ...ff] : ff, feedback: [1, 0, -a2] };
  });
}

/** Zusammengefasster Pfad (8. Ordnung; Pfad 'i' mit 10 Vorwärtskoeffizienten wegen der Verzögerung): { feedforward, feedback }. */
const _merged = new Map();
export function hilbertPath(path) {
  const key = path === 'q' ? 'q' : 'i';
  if (_merged.has(key)) return _merged.get(key);
  let ff = [1], fb = [1];
  for (const a of HILBERT_A[key]) { const a2 = a * a; ff = polyMul(ff, [a2, 0, -1]); fb = polyMul(fb, [1, 0, -a2]); }
  if (key === 'i') ff = [0, ...ff];
  const out = Object.freeze({ feedforward: Object.freeze(ff), feedback: Object.freeze(fb) });
  _merged.set(key, out);
  return out;
}

/** Phase (rad) eines Pfads bei normierter Frequenz fn = f/fs (0 … 0,5). */
function pathPhase(path, fn) {
  const { feedforward: b, feedback: a } = hilbertPath(path);
  const w = 2 * Math.PI * fn;
  const ev = c => { let re = 0, im = 0; for (let k = 0; k < c.length; k++) { re += c[k] * Math.cos(w * k); im -= c[k] * Math.sin(w * k); } return [re, im]; };
  const [br, bi] = ev(b), [ar, ai] = ev(a);
  return Math.atan2(bi, br) - Math.atan2(ai, ar);
}

/**
 * Abweichung der Phasendifferenz I − Q von 90° in Grad bei f (Hz) und Abtastrate fs. Daraus folgt die rechnerische Bildunterdrückung
 * (Spiegelfrequenz relativ zum Nutzsignal): 20·log10(tan(|Fehler|/2)).
 */
export function hilbertPhaseError(f, fs) {
  let d = (pathPhase('q', f / fs) - pathPhase('i', f / fs)) * 180 / Math.PI;
  d = ((d % 360) + 360) % 360;              // 0 … 360
  return Math.abs(d - 90) < Math.abs(d - 270) ? d - 90 : d - 270;
}
export function hilbertImageRejectionDb(f, fs) {
  const e = Math.abs(hilbertPhaseError(f, fs)) * Math.PI / 180;
  return 20 * Math.log10(Math.max(1e-12, Math.tan(e / 2)));
}
