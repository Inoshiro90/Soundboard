/**
 * audio/dsp-lib/crusher.js — Rechenkern des Bitcrushers mit echter Sample-Rate-Reduktion (Phase 15c, B-21). REIN, ohne Web Audio:
 * läuft im Worklet `crusher` (js/worklets/crusher.js) und direkt in Node-Tests.
 *
 * Je Block: Sample-and-Hold mit Phasenakkumulator (Zielrate / Samplerate je Sample; Halten bis zum Überlauf, alle Kanäle zum selben Zeitpunkt),
 * danach Quantisierung, dann Mix mit dem unbearbeiteten Eingang.
 * - Quantisierung (mid-rise, vorzeichensymmetrisch): y = sign(x) · (⌊|x| · q⌋ + ½) / q mit q = 2^(Bits − 1); x = 0 bleibt exakt 0 (Stille bleibt Stille).
 *   1 Bit = ±0,5 (Rechteck aus dem Vorzeichen), 16 Bit = Schritt 1/32768. Bits sind ganzzahlig (1–16).
 * - Jitter 0…1: der Abstand jedes Haltewerts schwankt zufällig um bis zu ± 50 % · Jitter (geseedeter Zufall: Live = Vorschau = Export).
 * - Zielrate ≥ Samplerate: keine Reduktion (jedes Sample wird übernommen).
 * - Mix wird je Sample geglättet (10 ms), Bits/Rate/Jitter wirken ab dem nächsten Haltewert.
 */
import { createPrng } from './prng.js';

export const CRUSHER_BITS_RANGE = [1, 16];
export const CRUSHER_RATE_RANGE = [50, 48000];

/** Quantisierung eines Werts auf `bits` Bit (siehe Kopf). */
export function crushQuantize(x, bits) {
  if (x === 0) return 0;
  const q = 2 ** (Math.max(1, Math.min(16, Math.round(bits))) - 1);
  const a = Math.min(Math.abs(x), 1 - 1e-12);   // Vollaussteuerung: oberste Stufe
  return Math.sign(x) * (Math.floor(a * q) + 0.5) / q;
}

export class Crusher {
  constructor(sampleRate, channels = 2, seed = 0x15c) {
    this.sr = sampleRate;
    this.acc = 1;                              // erster Block übernimmt sofort einen Haltewert
    this.next = 1;                             // Schwelle des nächsten Haltewerts (1 ± Jitter)
    this.hold = new Float64Array(Math.max(2, channels));
    this.mix = null;
    this.rnd = createPrng(seed);
    this.mixCoef = 1 - Math.exp(-1 / (0.01 * sampleRate));
  }
  /** @param {Float32Array[]} inp @param {Float32Array[]} out @param {number} n @param {{bits:number, rate:number, jitter:number, mix:number}} p */
  process(inp, out, n, p) {
    const chs = out.length, step = Math.min(1, Math.max(0, p.rate) / this.sr), jit = Math.max(0, Math.min(1, p.jitter)) * 0.5;
    const target = Math.max(0, Math.min(1, p.mix));
    if (this.mix === null) this.mix = target;
    if (this.hold.length < chs) this.hold = new Float64Array(chs);
    for (let i = 0; i < n; i++) {
      this.acc += step;
      if (step >= 1 || this.acc >= this.next - 1e-9) {               // Toleranz: 6 · (1/6) darf nicht an der Rundung scheitern
        this.acc = step >= 1 ? 0 : this.acc - this.next;
        this.next = jit > 0 ? 1 + jit * (2 * this.rnd() - 1) : 1;
        for (let c = 0; c < chs; c++) { const x = (inp[c] || inp[0])[i]; this.hold[c] = crushQuantize(x, p.bits); }
      }
      this.mix += (target - this.mix) * this.mixCoef;
      const w = this.mix;
      for (let c = 0; c < chs; c++) { const x = (inp[c] || inp[0])[i]; out[c][i] = w * this.hold[c] + (1 - w) * x; }
    }
  }
}
