/**
 * audio/dsp-lib/delayline.js — Rechenkern des Worklets `delayline` (Phase 12c): Kurzzeit-Verzögerung mit Bruchteil-Samples und
 * sample-genauer Rückkopplung. Grund (B-14, Plan §6.4): Web Audio klemmt Verzögerungen in Rückkopplungszyklen in Node und Firefox auf
 * 128 Samples (2,67 ms bei 48 kHz) [S]; ein Flanger braucht 0,1–2 ms. Chrome klemmt nicht [S]. Entscheidung E1: Worklet in allen Motoren.
 *
 * Modus 0 = Flanger (12c). Signalfluss wie der bisherige native Flanger (effect-graph.js `_buildModulatedDelay`), nur ohne Klemmung:
 *   y[n] = Leseposition n − D(n) (Hermite-Interpolation, 4 Punkte)
 *   Puffer[n] = x[n] + fb · y[n]
 *   out[n] = (1 − mix) · x[n] + mix · y[n]
 *   D(n) = baseDelay + depth · LFO(φ + c · phase/360), geklemmt auf [MIN_DELAY_SAMPLES, Puffer − 4]
 * LFO-Formen: 0 Sinus (wie der bisherige Oszillator, Start bei Phase 0), 1 Dreieck (startet bei 0 steigend, wie Sinus).
 * Kanal c (0 = links, 1 = rechts) läuft um c · phase Grad voraus (Entscheidung E3).
 * Parameter werden je Sample geglättet (einpolig, 10 ms); beim ersten Block gelten die Zielwerte sofort (kein Einschwingen beim Start).
 *
 * Modus 1 = Phaser (12d), Klasse `Phaser`: Kette aus K = stages/2 Allpass-Biquads (RBJ, Q = 0,5 → doppelter reeller Pol = zwei Allpässe erster
 * Ordnung je Biquad; dieselbe Formel wie BiquadFilterNode 'allpass', damit der native Fallback gleich klingt), Rückkopplung vom Kettenausgang
 * mit einem Sample Verzögerung:
 *   u[n] = x[n] + fb · c[n−1];  c = AP^K(u);  out = (1 − mix) · x + mix · c
 *   Mittenfrequenz f(n) = center · 2^(2 · depth · LFO(φ))  (depth 1 = ± 2 Oktaven, LFO Sinus), geklemmt auf 20 Hz … 0,45 · sr
 * Regeln der dsp-lib: keine Allokation in process(), keine DOM-/AudioContext-Zugriffe.
 */
import { finiteOr0, flush } from './util.js';

export const DL_MODE_FLANGER = 0;
export const DL_MODE_PHASER = 1;
export const PHASER_MAX_BIQUADS = 6;   // stages 12
export const PHASER_Q = 0.5;
/** Kleinste Verzögerung in Samples: die Hermite-Interpolation liest bis Position n − D + 2, die muss vor dem aktuellen Sample liegen. */
export const MIN_DELAY_SAMPLES = 3;
const SMOOTH_S = 0.01;

/** LFO-Wert −1 … +1 für Phase ph ∈ [0, 1). shape 1 = Dreieck (0 → +1 → −1 → 0), sonst Sinus. */
export function lfoValue(shape, ph) {
  if (shape === 1) return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
  return Math.sin(2 * Math.PI * ph);
}

export class DelayLine {
  /**
   * @param {number} sr Abtastrate
   * @param {number} channels höchstens so viele Kanäle werden verarbeitet (weitere bleiben still)
   * @param {number} maxDelaySec größte Verzögerung (Puffergröße)
   */
  constructor(sr, channels = 2, maxDelaySec = 0.05) {
    this.sr = sr;
    let size = 1; while (size < Math.ceil(maxDelaySec * sr) + 8) size <<= 1;
    this.size = size; this.mask = size - 1;
    this.bufs = Array.from({ length: channels }, () => new Float32Array(size));
    this.w = 0;
    this.phase = 0;                    // LFO-Phase 0 … 1
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sr));
    this.s = null;                     // geglättete Parameter (Samples bzw. linear)
  }

  reset() { for (const b of this.bufs) b.fill(0); this.w = 0; this.phase = 0; this.s = null; }

  /**
   * @param {Float32Array[]} inp Eingangskanäle (fehlend = Stille, z. B. Nachklang)
   * @param {Float32Array[]} out Ausgangskanäle
   * @param {number} n Samples
   * @param {{baseDelay:number, depth:number, rate:number, feedback:number, mix:number, shape:number, phase:number}} p  Zeiten in Sekunden, phase in Grad
   */
  process(inp, out, n, p) {
    const sr = this.sr, mask = this.mask, maxD = this.size - 4;
    const tb = finiteOr0(p.baseDelay) * sr, td = finiteOr0(p.depth) * sr;
    const tf = Math.max(-0.99, Math.min(0.99, finiteOr0(p.feedback))), tm = Math.max(0, Math.min(1, finiteOr0(p.mix)));
    const tp = Math.max(0, Math.min(360, finiteOr0(p.phase))) / 360;
    if (!this.s) this.s = { b: tb, d: td, f: tf, m: tm, o: tp };
    const s = this.s, k = this.k, shape = p.shape | 0;
    const inc = Math.max(0, finiteOr0(p.rate)) / sr;
    const nch = Math.min(out.length, this.bufs.length);
    let w = this.w, ph = this.phase;
    for (let i = 0; i < n; i++) {
      s.b += (tb - s.b) * k; s.d += (td - s.d) * k; s.f += (tf - s.f) * k; s.m += (tm - s.m) * k; s.o += (tp - s.o) * k;
      for (let c = 0; c < nch; c++) {
        const buf = this.bufs[c];
        const x = inp && inp[c] ? finiteOr0(inp[c][i]) : 0;
        let q = ph + c * s.o; q -= Math.floor(q);
        let D = s.b + s.d * lfoValue(shape, q);
        if (D < MIN_DELAY_SAMPLES) D = MIN_DELAY_SAMPLES; else if (D > maxD) D = maxD;
        const pos = w - D, i0 = Math.floor(pos), t = pos - i0;
        const xm1 = buf[(i0 - 1) & mask], x0 = buf[i0 & mask], x1 = buf[(i0 + 1) & mask], x2 = buf[(i0 + 2) & mask];
        const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        const y = ((c3 * t + c2) * t + c1) * t + x0;
        buf[w] = flush(x + s.f * y);
        out[c][i] = (1 - s.m) * x + s.m * y;
      }
      w = (w + 1) & mask;
      ph += inc; if (ph >= 1) ph -= 1;
    }
    for (let c = nch; c < out.length; c++) out[c].fill(0);
    this.w = w; this.phase = ph;
  }
}

/** Koeffizienten eines Allpass-Biquads (RBJ, Web-Audio-Spezifikation 'allpass', normiert auf a0 = 1): b0 = a2, b1 = a1, b2 = 1. */
export function allpassCoeffs(f, sr, Q = PHASER_Q) {
  const w0 = 2 * Math.PI * f / sr, alpha = Math.sin(w0) / (2 * Q), a0 = 1 + alpha;
  return { b0: (1 - alpha) / a0, b1: -2 * Math.cos(w0) / a0 };
}

export class Phaser {
  constructor(sr, channels = 2) {
    this.sr = sr;
    this.ch = channels;
    this.st = new Float64Array(channels * PHASER_MAX_BIQUADS * 4);   // je Kanal und Stufe: x1, x2, y1, y2
    this.last = new Float64Array(channels);                          // c[n−1] je Kanal (Rückkopplung)
    this.phase = 0;
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sr));
    this.s = null;
  }

  reset() { this.st.fill(0); this.last.fill(0); this.phase = 0; this.s = null; }

  /**
   * @param {Float32Array[]} inp  @param {Float32Array[]} out  @param {number} n
   * @param {{center:number, depth:number, rate:number, feedback:number, mix:number, stages:number}} p  center in Hz, depth 0…1, stages 2…12 (gerade)
   */
  process(inp, out, n, p) {
    const sr = this.sr, fMax = 0.45 * sr;
    const tc = Math.log2(Math.max(20, Math.min(fMax, finiteOr0(p.center) || 800)));
    const td = Math.max(0, Math.min(1, finiteOr0(p.depth))), tf = Math.max(-0.95, Math.min(0.95, finiteOr0(p.feedback)));
    const tm = Math.max(0, Math.min(1, finiteOr0(p.mix)));
    const K = Math.max(1, Math.min(PHASER_MAX_BIQUADS, Math.round((finiteOr0(p.stages) || 4) / 2)));
    if (!this.s) this.s = { c: tc, d: td, f: tf, m: tm };
    const s = this.s, k = this.k, st = this.st, last = this.last;
    const inc = Math.max(0, finiteOr0(p.rate)) / sr;
    const nch = Math.min(out.length, this.ch);
    let ph = this.phase;
    for (let i = 0; i < n; i++) {
      s.c += (tc - s.c) * k; s.d += (td - s.d) * k; s.f += (tf - s.f) * k; s.m += (tm - s.m) * k;
      let f = Math.pow(2, s.c + 2 * s.d * Math.sin(2 * Math.PI * ph));
      if (f < 20) f = 20; else if (f > fMax) f = fMax;
      const w0 = 2 * Math.PI * f / sr, alpha = Math.sin(w0) / (2 * PHASER_Q), a0 = 1 + alpha;
      const b0 = (1 - alpha) / a0, b1 = -2 * Math.cos(w0) / a0;      // b2 = 1, a1 = b1, a2 = b0
      for (let c = 0; c < nch; c++) {
        const x = inp && inp[c] ? finiteOr0(inp[c][i]) : 0;
        let u = x + s.f * last[c];
        for (let j = 0; j < K; j++) {
          const o = (c * PHASER_MAX_BIQUADS + j) * 4;
          const y = b0 * u + b1 * st[o] + st[o + 1] - b1 * st[o + 2] - b0 * st[o + 3];
          st[o + 1] = st[o]; st[o] = u; st[o + 3] = st[o + 2]; st[o + 2] = flush(y);
          u = y;
        }
        last[c] = flush(u);
        out[c][i] = (1 - s.m) * x + s.m * u;
      }
      ph += inc; if (ph >= 1) ph -= 1;
    }
    for (let c = nch; c < out.length; c++) out[c].fill(0);
    this.phase = ph;
  }
}
