/**
 * audio/dsp-lib/combbank.js — Rechenkern der Kamm-Bank (Phase 21a): bis zu 8 parallele Rückkopplungskämme mit Bruchteil-Verzögerung,
 * Dämpfung und weichem Limiter in der Schleife. Prozessor `combbank-processor` im Worklet `delayline` (js/worklets/delayline.js).
 * Grund für das Worklet (B-14, Plan P21): Rückkopplungszyklen mit Verzögerung < 128 Samples sind nativ in Node/Firefox nicht möglich [S, P12c].
 * Verbraucher: Modul `comb` (21a, ein Kamm); geplant `resonator` (21b) und `tunedResonator` (21c) über dieselben Eingänge.
 *
 * Signalfluss je Kamm k und Kanal c (Periode P_k = sr / (f0 · r_k) Samples):
 *   d[n]  = Leseposition n − D_k (Hermite-Interpolation, 4 Punkte, wie dsp-lib/delayline.js)
 *   l[n]  = l[n−1] + a · (d[n] − l[n−1])                   Dämpfung: Einpol-Tiefpass in der Schleife, a = DAMP_A_MIN^damp (damp 0 → a = 1, kein Filter)
 *   y[n]  = s_k · x[n] + g_k · l[n]                         s_k = √(1 − g_k²): gleiche Leistung wie der Eingang bei weißem Rauschen (Gain-Staging)
 *   Puffer[n] = soft(s_k · xh[n] + g_k · l[n])              xh = Eingang ohne Infraschall (Hochpass 2. Ordnung DC_BLOCK_HZ, Q 0,707, je Kanal, nur auf dem
 *                                                           Weg IN die Schleife): ein positiver Kamm hat auch bei 0 Hz eine Resonanz (Bandbreite < 1 Hz); mit
 *                                                           Dämpfung klingt sie am längsten und füllt den Limiter [S, Node]. Verworfen [S, Node]: Sperre IN der
 *                                                           Schleife (eigene, langsam abklingende Mode bei ≈ 8 Hz aus Hochpass-Pol und langer Verzögerung) und
 *                                                           Einpol-Sperre davor (eine Gleichspannungsstufe lädt die 0-Hz-Mode trotzdem bis zum Limiter).
 *                                                           weicher Limiter soft: linear bis |v| = 1, darüber 1 + tanh(|v| − 1) (≤ 2, stetig differenzierbar)
 *   D_k   = P_k − τ_k                                       τ_k = Phasenverzögerung des Tiefpasses bei f_k (Stimmung bleibt bei Dämpfung exakt)
 * Nass = Σ_k w_k · y_k / √(Σ_k w_k)  (w_k = Gewicht 0…1, geglättet; ein neuer Kamm blendet in 10 ms ein, ein abgeschalteter aus)
 * Ausgang = Ausgangspegel · ((1 − mix) · x + mix · Nass)
 * Phase 21b (nur `resonator`, lim = 1): Ausgang = Ausgangspegel · ((1 − mix) · x + mix · soft(wg · Nass)) — wg = Pegelkompensation (geglättet 10 ms),
 * soft = derselbe weiche Limiter wie in der Schleife (linear bis 1, Grenze 2). Mit lim = 0 (Standard, `comb`) bleibt der Rechenweg wie in 21a
 * (wg wird dann nicht angewendet; gleiche Bits).
 *
 * Rückkopplung g_k: Modus Decay (decay > 0): g_k = 10^(−3 · P_k / (decay · sr)) — jeder Kamm fällt in `decay` Sekunden um 60 dB (RT60), unabhängig
 * von seiner Frequenz. Modus direkt (decay = 0): g_k = fb (−0,99 … 0,99, Vorzeichen erlaubt; negativ → tiefster Gipfel bei f/2, nur ungerade Vielfache).
 * Stereo: bei zwei Kanälen läuft L um −spread/2 Cent, R um +spread/2 Cent (Breite ohne Pegelunterschied); ein Kanal bleibt ein Kanal (M-3).
 * Glättung: Verzögerung, Rückkopplung, Gewichte, Mix und Ausgang je Sample einpolig (10 ms); beim ersten Block gelten die Zielwerte sofort.
 * Ohne Eingang (Quelle beendet) läuft die Rückkopplung mit Stille weiter und klingt aus.
 * Regeln der dsp-lib: keine Allokation in process(), keine DOM-/AudioContext-Zugriffe.
 */
import { finiteOr0, flush, clamp } from './util.js';
import { MIN_DELAY_SAMPLES } from './delayline.js';

export const COMB_MAX = 8;                 // Kämme je Bank
export const COMB_MIN_FREQ = 20;           // tiefste Kammfrequenz (Puffergröße)
export const COMB_MAX_FB = 0.99;           // Betrag der direkten Rückkopplung
export const COMB_DECAY_RANGE = [0, 30];   // s (0 = direkte Rückkopplung)
export const COMB_SPREAD_MAX = 100;        // Cent L/R
export const DAMP_A_MIN = 0.03;            // Tiefpass-Koeffizient bei Dämpfung 1 (≈ 230 Hz Grenzfrequenz bei 48 kHz)
export const DC_BLOCK_HZ = 10;             // Infraschall-Sperre am Schleifeneingang (Hochpass 2. Ordnung; bei 20 Hz ≈ −1 dB)
const SMOOTH_S = 0.01;

/** Tiefpass-Koeffizient a (0 < a ≤ 1) aus der Dämpfung 0…1. */
export const dampCoeff = damp => Math.pow(DAMP_A_MIN, clamp(finiteOr0(damp), 0, 1));

/** Phasenverzögerung (Samples) des Einpol-Tiefpasses y += a (x − y) bei der Kreisfrequenz w (rad/Sample). */
export function lpPhaseDelay(a, w) {
  const b = 1 - a;
  if (b <= 0 || w <= 0) return 0;
  return Math.atan2(b * Math.sin(w), 1 - b * Math.cos(w)) / w;
}

/** Weicher Limiter der Schleife: linear bis 1, darüber 1 + tanh(|v| − 1); Grenze 2. */
export function combSoft(v) {
  if (v > 1) return 1 + Math.tanh(v - 1);
  if (v < -1) return -1 - Math.tanh(-v - 1);
  return v;
}

/** Rückkopplung eines Kamms mit der Periode P (Samples) für RT60 = decay (s). */
export const decayGain = (P, decay, sr) => (decay > 0 ? Math.pow(10, -3 * P / (decay * sr)) : 0);

/** RT60 (s) eines Kamms mit der Frequenz f und der direkten Rückkopplung fb (Betrag); 0 bei fb = 0. Obergrenze der Ausklingzeit (ohne Dämpfung). */
export function feedbackT60(f, fb) {
  const g = Math.abs(finiteOr0(fb));
  if (!(g > 0) || !(f > 0)) return 0;
  return 3 / (f * -Math.log10(Math.min(COMB_MAX_FB, g)));
}

export class CombBank {
  /**
   * @param {number} sr Abtastrate
   * @param {number} channels höchstens so viele Kanäle (weitere bleiben still)
   */
  constructor(sr, channels = 2) {
    this.sr = sr;
    this.ch = channels;
    // Längste Periode: 20 Hz bei −spread/2 Cent, plus Hermite-Reserve
    const maxP = sr / COMB_MIN_FREQ * Math.pow(2, COMB_SPREAD_MAX / 2400);
    let size = 1; while (size < Math.ceil(maxP) + 8) size <<= 1;
    this.size = size; this.mask = size - 1;
    this.bufs = Array.from({ length: COMB_MAX * channels }, () => new Float32Array(size));
    this.lp = new Float64Array(COMB_MAX * channels);
    this.w = 0;
    // Hochpass 2. Ordnung (RBJ, Q 0,707), Zustand je Kanal: x1, x2, y1, y2
    { const w0 = 2 * Math.PI * DC_BLOCK_HZ / sr, al = Math.sin(w0) / (2 * Math.SQRT1_2), cw = Math.cos(w0), a0 = 1 + al;
      this.hb = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0]; }
    this.hs = new Float64Array(channels * 4);
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sr));
    // Ziel- und geglättete Werte je Kamm und Kanal
    this.tD = new Float64Array(COMB_MAX * channels); this.sD = new Float64Array(COMB_MAX * channels);
    this.tG = new Float64Array(COMB_MAX * channels); this.sG = new Float64Array(COMB_MAX * channels);
    this.tW = new Float64Array(COMB_MAX); this.sW = new Float64Array(COMB_MAX);
    this.s = null;                     // geglättete gemeinsame Werte (mix, out, Nass-Verstärkung wg)
  }

  reset() { for (const b of this.bufs) b.fill(0); this.lp.fill(0); this.hs.fill(0); this.w = 0; this.s = null; this.sW.fill(0); }

  /**
   * @param {Float32Array[]} inp Eingangskanäle (fehlend = Stille)
   * @param {Float32Array[]} out Ausgangskanäle
   * @param {number} n Samples
   * @param {{f0:number, ratios:ArrayLike<number>, decay:number, fb:number, damp:number, spread:number, mix:number, out:number}} p
   *   f0 in Hz, ratios je Kamm (≤ 0 = aus), decay RT60 in s (0 = direkte Rückkopplung fb), damp 0…1, spread in Cent, mix 0…1, out linear;
   *   optional (21b) wg = Nass-Verstärkung linear (Standard 1), lim = 1 → weicher Limiter auf wg · Nass (Standard 0: Rechenweg wie 21a)
   */
  process(inp, out, n, p) {
    const sr = this.sr, mask = this.mask, maxD = this.size - 4, fMax = 0.45 * sr;
    const nch = Math.min(out.length, this.ch);
    const f0 = Math.max(COMB_MIN_FREQ, finiteOr0(p.f0) || 220);
    const decay = clamp(finiteOr0(p.decay), COMB_DECAY_RANGE[0], COMB_DECAY_RANGE[1]);
    const fb = clamp(finiteOr0(p.fb), -COMB_MAX_FB, COMB_MAX_FB);
    const a = dampCoeff(p.damp);
    const spread = nch > 1 ? clamp(finiteOr0(p.spread), 0, COMB_SPREAD_MAX) : 0;
    const tm = clamp(finiteOr0(p.mix), 0, 1), to = Math.max(0, finiteOr0(p.out));
    const tg = p.wg === undefined ? 1 : Math.max(0, finiteOr0(p.wg)), lim = finiteOr0(p.lim) >= 0.5;
    const first = !this.s;
    // Zielwerte je Kamm und Kanal
    for (let j = 0; j < COMB_MAX; j++) {
      const r = finiteOr0(p.ratios[j]);
      const on = r > 0;
      this.tW[j] = on ? 1 : 0;
      for (let c = 0; c < nch; c++) {
        const o = j * this.ch + c;
        if (!on) { this.tG[o] = 0; continue; }
        const cent = nch > 1 ? (c === 0 ? -spread / 2 : spread / 2) : 0;
        const f = clamp(f0 * r * Math.pow(2, cent / 1200), COMB_MIN_FREQ, fMax);
        const P = sr / f;
        let D = P - lpPhaseDelay(a, 2 * Math.PI * f / sr);
        if (D < MIN_DELAY_SAMPLES) D = MIN_DELAY_SAMPLES; else if (D > maxD) D = maxD;
        this.tD[o] = D;
        this.tG[o] = decay > 0 ? decayGain(P, decay, sr) : fb;
        // Neu eingeschalteter Kamm: leerer Puffer, Verzögerung sofort am Ziel (kein Gleiten aus einer alten Stimmung)
        if (this.sW[j] === 0 && !first) { this.bufs[o].fill(0); this.lp[o] = 0; this.sD[o] = D; this.sG[o] = 0; }
      }
    }
    if (first) {
      this.s = { m: tm, o: to, g: tg };
      this.sD.set(this.tD); this.sG.set(this.tG); this.sW.set(this.tW);
    }
    const s = this.s, k = this.k, sD = this.sD, sG = this.sG, tD = this.tD, tG = this.tG, sW = this.sW, tW = this.tW;
    const bufs = this.bufs, lp = this.lp, CH = this.ch, hs = this.hs, [hb0, hb1, hb2, ha1, ha2] = this.hb;
    let w = this.w;
    for (let i = 0; i < n; i++) {
      s.m += (tm - s.m) * k; s.o += (to - s.o) * k; s.g += (tg - s.g) * k;
      let wsum = 0;
      for (let j = 0; j < COMB_MAX; j++) {
        let wj = sW[j] + (tW[j] - sW[j]) * k;
        if (wj < 1e-6 && tW[j] === 0) wj = 0;
        sW[j] = wj; wsum += wj;
      }
      const norm = wsum > 0 ? 1 / Math.sqrt(Math.max(1, wsum)) : 0;
      for (let c = 0; c < nch; c++) {
        const x = inp && inp[c] ? finiteOr0(inp[c][i]) : 0;
        const q = c * 4, xh = flush(hb0 * x + hb1 * hs[q] + hb2 * hs[q + 1] - ha1 * hs[q + 2] - ha2 * hs[q + 3]);
        hs[q + 1] = hs[q]; hs[q] = x; hs[q + 3] = hs[q + 2]; hs[q + 2] = xh;
        let wet = 0;
        for (let j = 0; j < COMB_MAX; j++) {
          const wj = sW[j];
          if (wj === 0) continue;
          const o = j * CH + c, buf = bufs[o];
          let D = sD[o] + (tD[o] - sD[o]) * k; sD[o] = D;
          const g = sG[o] + (tG[o] - sG[o]) * k; sG[o] = g;
          const pos = w - D, i0 = Math.floor(pos), t = pos - i0;
          const xm1 = buf[(i0 - 1) & mask], x0 = buf[i0 & mask], x1 = buf[(i0 + 1) & mask], x2 = buf[(i0 + 2) & mask];
          const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
          const d = ((c3 * t + c2) * t + c1) * t + x0;
          const l = flush(lp[o] + a * (d - lp[o])); lp[o] = l;
          const sg = Math.sqrt(Math.max(0, 1 - g * g)), gl = g * l;
          buf[w] = flush(combSoft(sg * xh + gl));
          wet += wj * (sg * x + gl);
        }
        if (lim) out[c][i] = s.o * ((1 - s.m) * x + s.m * combSoft(s.g * wet * norm));
        else out[c][i] = s.o * ((1 - s.m) * x + s.m * wet * norm);
      }
      w = (w + 1) & mask;
    }
    for (let c = nch; c < out.length; c++) out[c].fill(0);
    this.w = w;
  }
}

/**
 * Leistungsverstärkung der Kamm-Bank für weißes Rauschen (Phase 21b, Pegelkompensation des Resonators): Energie der Impulsantwort des Nass-Signals
 * (mix 1, out 1, lim 0, wg 1, ein Kanal, spread 0) — Parseval: bei weißem Rauschen = Ausgangsleistung / Eingangsleistung. Schließt alles ein, was der
 * Kern tut (Dämpfung, Hermite-Verlust, Infraschall-Sperre, Korrelation der Kämme, Normierung 1/√N). Grund für die Simulation statt einer Formel
 * [S, Node]: Näherungen über den Frequenzgang wichen bei wenigen Gipfeln (hoher Grundton) bis 10 dB ab (Gipfel sitzen nicht im Mittel der Welligkeit).
 * Länge: simLength s (Standard 0,5) in Fenstern aus ganzen Perioden des tiefsten Kamms; Rest geometrisch aus den letzten zwei Fenstern, höchstens
 * mit der Rate, die der Decay erlaubt. Genauigkeit gegen die volle Impulsantwort [S, Node, 48 kHz]: Decay ≤ 2 s ≤ 0,05 dB, bis 30 s ≤ 3,5 dB.
 * Rechenzeit ≈ 5 ms bei 8 Kämmen [S, Node] — Aufrufer cachen das Ergebnis. Eine Bank je Abtastrate wird wiederverwendet (nur zwei Blockpuffer je Aufruf).
 * @returns {number} Leistungsverhältnis (> 0); 0, wenn kein Kamm aktiv ist
 */
const _calBanks = new Map();
export function bankPowerGain(p, sr, simLength = 0.5) {
  const ratios = Array.from(p.ratios || [], r => finiteOr0(r)).filter(r => r > 0);
  if (!ratios.length) return 0;
  let bank = _calBanks.get(sr);
  if (!bank) { bank = new CombBank(sr, 1); _calBanks.set(sr, bank); }
  bank.reset();
  const q = { f0: p.f0, ratios: p.ratios, decay: p.decay, fb: p.fb, damp: p.damp, spread: 0, mix: 1, out: 1 };
  const f0 = Math.max(COMB_MIN_FREQ, finiteOr0(q.f0) || 220);
  const Pm = Math.max(1, Math.round(sr / Math.max(COMB_MIN_FREQ, f0 * Math.min(...ratios))));
  const W = Pm * Math.max(1, Math.ceil(1024 / Pm)), Lmax = Math.max(4 * W, simLength * sr);
  const x = new Float32Array(128), y = new Float32Array(128);
  let e = 0, cur = 0, cnt = 0, last = 0, prev = 0, n = 0;
  while (n < Lmax) {
    x.fill(0); if (n === 0) x[0] = 1;
    bank.process([x], [y], 128, q);
    for (let i = 0; i < 128; i++) { const v = y[i] * y[i]; e += v; cur += v; if (++cnt === W) { prev = last; last = cur; cur = 0; cnt = 0; } }
    n += 128;
  }
  const decay = clamp(finiteOr0(q.decay), COMB_DECAY_RANGE[0], COMB_DECAY_RANGE[1]);
  const rmax = decay > 0 ? Math.pow(10, -6 * W / (decay * sr)) : Math.pow(Math.min(COMB_MAX_FB, Math.abs(finiteOr0(q.fb))), 2 * W / Pm);
  const rho = prev > 0 ? Math.min(rmax, last / prev) : rmax;
  if (rho > 0 && rho < 1) e += last * rho / (1 - rho);
  bank.reset();
  return e;
}
