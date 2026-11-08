/**
 * audio/dsp-lib/timebuffer.js — Rechenkern des Worklets `timebuffer` (Phase 20a, AE-09: ein Prozessor für alle Time-Buffer-Module).
 * ----------------------------------------------------------------------------------------------------------------------------
 * Grundlage für `stutter` (20b), `beatRepeat` (20c), `retrigger` (20d) und die Delay-Modi `reverse` (20e) und `granular` (20f).
 * 20a liefert nur den gemeinsamen Teil; die Module bringen je einen Planer (`sched.tick`), der Leseköpfe startet.
 *
 * Ringpuffer:
 *   Ein Puffer je Kanal mit `frames = ceil(maxSeconds · sr) + TB_GUARD` Samples (Float32). Er wird einmal im Konstruktor angelegt;
 *   process() allokiert nicht. Die absolute Zeit `t` zählt die geschriebenen Samples seit dem Start (Sample 0 = erstes Eingangssample).
 *   Lesbar ist die absolute Position p mit  t − frames + 1 ≤ p ≤ t − 3  (Hermite liest ⌊p⌋ − 1 … ⌊p⌋ + 2, alles vor dem Jetzt).
 *   Positionen vor dem Start (p < 0) lesen Stille, solange der Puffer noch nicht umgelaufen ist.
 *   Speicher: 4 s Stereo @ 48 kHz = 192 004 · 2 · 4 Byte ≈ 1,5 MB (Plan P20).
 *
 * Leseköpfe (höchstens TB_MAX_HEADS gleichzeitig, Speicher vorab angelegt):
 *   startHead({ at, length, rate, gain, fadeIn, fadeOut }) → Kopf liest ab der absoluten Position `at` für `length` Ausgangssamples,
 *   je Sample um `rate` weiter (1 = Original, 2 = Oktave hoch, −1 = rückwärts). Hüllkurve: halbe Hann-Flanken über fadeIn/fadeOut
 *   Samples (tbFade, um ½ Sample versetzt: überlappende Flanken summieren sich zu 1). Ganzzahlige Position → das Sample selbst (bit-genau, „korrelationsgenau“); sonst Hermite (4 Punkte, wie delayline.js).
 *   Läuft ein Kopf aus dem lesbaren Bereich (zu alt oder in die Zukunft), endet er still (`starved` zählt mit). Volle Liste → −1, `dropped` zählt.
 *   Alle Kanäle lesen dieselbe Position (Stereobild bleibt erhalten).
 *
 * Ausgang je Sample:  out = dry · m · x + wet · Σ Kopf  (dry/wet einpolig geglättet, 10 ms; erster Block ohne Einschwingen).
 *   m = `sched.dryMul` (Phase 20b: der Planer senkt den trockenen Anteil während einer Wiederholung ab), ohne Planer bzw. ohne Feld 1
 *   (dry · 1 ist exakt dry: `thru` und `probe` bleiben bit-gleich).
 * Ablauf je Sample: Eingang schreiben → t + 1 → sched.tick(core, t) (darf Köpfe starten, setzt dryMul) → Köpfe lesen → Ausgang.
 *
 * Haltepuffer (Phase 20b, optional `holdSeconds` > 0): `hold(at, len)` kopiert das Segment at … at + len − 1 (mit je einem bzw. zwei
 * Nachbarn für Hermite) aus dem Ring in einen eigenen, im Konstruktor angelegten Puffer. Köpfe mit `src: 'hold'` lesen dort mit derselben
 * absoluten Position wie im Ring, altern aber nicht: Wiederholungen eines Segments reichen damit beliebig weit über die Ringlänge hinaus.
 * Die Kopie ist bit-genau (Float32 → Float32), Wiederholungen aus Ring und Haltepuffer sind gleich.
 *
 * Regeln der dsp-lib: keine Allokation in process(), keine DOM-/AudioContext-Zugriffe. Eingänge NaN/Inf → 0.
 */
import { finiteOr0, flush } from './util.js';
import { hashRand } from './prng.js';

export const TB_MAX_HEADS = 32;
/** Zusatzsamples am Pufferende (Hermite-Nachbarn). */
export const TB_GUARD = 4;
/** Harte Grenzen für maxSeconds (die Geräte-Grenze setzt engine/timebuffer-node.js). */
export const TB_MIN_SECONDS = 0.05;
export const TB_MAX_SECONDS = 8;
const SMOOTH_S = 0.01;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Puffergröße in Samples je Kanal. */
export function tbBufferFrames(sr, seconds) {
  return Math.ceil(clamp(finiteOr0(seconds) || TB_MIN_SECONDS, TB_MIN_SECONDS, TB_MAX_SECONDS) * sr) + TB_GUARD;
}

/** Speicherbedarf des Puffers in Byte (Float32). */
export function tbBufferBytes(sr, seconds, channels = 2) {
  return tbBufferFrames(sr, seconds) * channels * 4;
}

/**
 * Hüllkurve eines Kopfs beim Ausgangssample i (0 … len − 1): halbe Hann-Flanke über fadeIn Samples am Anfang und fadeOut am Ende,
 * um ein halbes Sample versetzt abgetastet: g_in(i) = ½ − ½·cos(π·(i + ½)/fadeIn). Dadurch ergänzen sich Aus- und Einblendung zweier
 * Köpfe, deren Flanken sich genau überlappen, in jedem Sample exakt zu 1 (konstante Summe, keine Pegeldelle). Das erste und letzte Sample
 * ist nicht exakt 0, sondern sin²(π/(4·fade)) (bei 1000 Samples ≈ 6·10⁻⁷). Ohne Flanken 1 (Rechteck).
 */
export function tbFade(i, len, fadeIn, fadeOut) {
  let g = 1;
  if (fadeIn > 0 && i < fadeIn) g = 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / fadeIn);
  const r = len - 1 - i;
  if (fadeOut > 0 && r < fadeOut) g *= 0.5 - 0.5 * Math.cos(Math.PI * (r + 0.5) / fadeOut);
  return g;
}

export class TimeBuffer {
  /**
   * @param {number} sr Abtastrate
   * @param {number} channels höchstens so viele Kanäle werden verarbeitet (weitere bleiben still)
   * @param {number} maxSeconds Pufferlänge in Sekunden (geklemmt auf TB_MIN_SECONDS … TB_MAX_SECONDS)
   */
  constructor(sr, channels = 2, maxSeconds = 4, holdSeconds = 0) {
    this.sr = sr;
    this.channels = Math.max(1, channels | 0);
    this.frames = tbBufferFrames(sr, maxSeconds);
    this.maxSeconds = (this.frames - TB_GUARD) / sr;
    this.bufs = Array.from({ length: this.channels }, () => new Float32Array(this.frames));
    this.w = 0;          // Schreibindex im Ring
    this.t = 0;          // absolute Zeit: Anzahl geschriebener Samples
    const H = TB_MAX_HEADS;
    this.hOn = new Uint8Array(H);
    this.hPos = new Float64Array(H);   // absolute Leseposition
    this.hRate = new Float64Array(H);
    this.hGain = new Float64Array(H);
    this.hLen = new Float64Array(H);
    this.hAge = new Float64Array(H);
    this.hIn = new Float64Array(H);
    this.hOut = new Float64Array(H);
    this.active = 0;
    this.dropped = 0;    // abgewiesene Starts (Liste voll)
    this.starved = 0;    // Köpfe, die aus dem lesbaren Bereich liefen
    this.acc = new Float64Array(this.channels);
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sr));
    this.s = null;       // geglättet: { d: dry, w: wet }
    // Haltepuffer (20b): nur mit holdSeconds > 0 angelegt
    const hf = holdSeconds > 0 ? Math.ceil(Math.min(TB_MAX_SECONDS, holdSeconds) * sr) + TB_GUARD : 0;
    this.holdFrames = hf;
    this.hb = hf ? Array.from({ length: this.channels }, () => new Float32Array(hf)) : null;
    this.holdAt = 0;     // absolute Position des ersten Segmentsamples
    this.holdLen = 0;    // Segmentlänge (0 = leer)
    this.hSrc = new Uint8Array(H);   // 1 = Kopf liest aus dem Haltepuffer
  }

  /** Speicherbedarf des Puffers in Byte. */
  get bytes() { return (this.frames + this.holdFrames) * this.channels * 4; }

  reset() {
    for (const b of this.bufs) b.fill(0);
    this.w = 0; this.t = 0; this.hOn.fill(0); this.active = 0; this.dropped = 0; this.starved = 0; this.s = null;
    this.holdLen = 0;
  }

  /** Älteste und jüngste lesbare absolute Position (siehe Kopfkommentar). */
  get oldest() { return this.t - this.frames + 1; }
  get newest() { return this.t - 3; }

  /**
   * Haltepuffer füllen (20b): Segment ab absoluter Position `at` mit `len` Samples, dazu at − 1 und at + len, at + len + 1 (Hermite-Nachbarn).
   * Alle diese Samples müssen geschrieben und noch im Ring sein (at − 1 ≥ oldest, at + len + 1 ≤ t − 1). Allokiert nicht.
   * @returns {boolean} false ohne Haltepuffer, bei zu langem Segment oder nicht (mehr) lesbaren Samples (Haltepuffer bleibt dann leer)
   */
  hold(at, len) {
    at = Math.floor(finiteOr0(at)); len = Math.floor(finiteOr0(len));
    this.holdLen = 0;
    if (!this.hb || len < 1 || len + 3 > this.holdFrames) return false;
    if (at - 1 < this.oldest || at + len + 1 > this.t - 1) return false;
    const F = this.frames;
    let r = this.w - (this.t - (at - 1)); while (r < 0) r += F;
    for (let i = 0; i < len + 3; i++) {
      for (let c = 0; c < this.channels; c++) this.hb[c][i] = this.bufs[c][r];
      r = r + 1 === F ? 0 : r + 1;
    }
    this.holdAt = at; this.holdLen = len;
    return true;
  }

  /**
   * Startet einen Lesekopf. Wirkt ab dem nächsten gelesenen Sample (im Planer: ab dem aktuellen).
   * @param {{at:number, length:number, rate?:number, gain?:number, fadeIn?:number, fadeOut?:number, src?:'ring'|'hold'}} o  Zeiten in Samples;
   *   `src: 'hold'` liest aus dem Haltepuffer (20b; ohne gefüllten Haltepuffer endet der Kopf still, `starved`)
   * @returns {number} Platz 0 … TB_MAX_HEADS − 1, oder −1 (Liste voll / ungültig)
   */
  startHead(o) {
    const len = Math.floor(finiteOr0(o.length));
    if (len < 1) return -1;
    let h = -1;
    for (let i = 0; i < TB_MAX_HEADS; i++) if (!this.hOn[i]) { h = i; break; }
    if (h < 0) { this.dropped++; return -1; }
    this.hOn[h] = 1;
    this.hPos[h] = finiteOr0(o.at);
    this.hRate[h] = Number.isFinite(o.rate) ? o.rate : 1;
    this.hGain[h] = Number.isFinite(o.gain) ? o.gain : 1;
    this.hLen[h] = len;
    this.hAge[h] = 0;
    this.hIn[h] = Math.max(0, Math.floor(finiteOr0(o.fadeIn)));
    this.hOut[h] = Math.max(0, Math.floor(finiteOr0(o.fadeOut)));
    this.hSrc[h] = o.src === 'hold' ? 1 : 0;
    this.active++;
    return h;
  }

  /** Beendet einen Kopf sofort (Planer; ohne Flanke, Aufrufer verantwortet Klickfreiheit). */
  stopHead(h) { if (h >= 0 && h < TB_MAX_HEADS && this.hOn[h]) { this.hOn[h] = 0; this.active--; } }

  /**
   * Blendet einen laufenden Kopf ab dem nächsten gelesenen Sample über `fade` Samples aus (Phase 20d, Retrigger: ein neuer Onset schneidet
   * laufende Wiederholungen). Die Ausblendung beginnt bei ≈ 1 (halbe Hann-Flanke, tbFade) und multipliziert eine noch laufende Einblendung:
   * der Pegelverlauf bleibt stetig. Ist der Kopf schon in seiner eigenen Ausblendung oder endet er ohnehin innerhalb von `fade`, bleibt er
   * unverändert (sonst spränge die Hüllkurve). fade < 1 → sofort beenden (wie stopHead). Additiv: bestehende Modi rufen die Methode nicht auf.
   * @returns {number} Samples bis zum Ende des Kopfs (0 = beendet bzw. nicht aktiv)
   */
  releaseHead(h, fade) {
    if (!(h >= 0 && h < TB_MAX_HEADS) || !this.hOn[h]) return 0;
    const F = Math.floor(finiteOr0(fade));
    if (F < 1) { this.stopHead(h); return 0; }
    const rem = this.hLen[h] - this.hAge[h];
    if (rem <= F || rem <= this.hOut[h]) return rem;
    this.hLen[h] = this.hAge[h] + F;
    this.hOut[h] = F;
    return F;
  }

  /** Alle Köpfe beenden (z. B. Seek). Der Puffer bleibt. */
  stopAll() { this.hOn.fill(0); this.active = 0; }

  /**
   * @param {Float32Array[]} inp Eingangskanäle (fehlend = Stille, z. B. Nachklang)
   * @param {Float32Array[]} out Ausgangskanäle
   * @param {number} n Samples
   * @param {{dry?:number, wet?:number}} p  linear 0 … 1
   * @param {{tick(core:TimeBuffer, t:number):void}|null} [sched] Planer des Moduls (optional)
   */
  process(inp, out, n, p, sched = null) {
    const td = clamp(Number.isFinite(p?.dry) ? p.dry : 1, 0, 1), tw = clamp(Number.isFinite(p?.wet) ? p.wet : 1, 0, 1);
    if (!this.s) this.s = { d: td, w: tw };
    const s = this.s, k = this.k, F = this.frames, bufs = this.bufs, acc = this.acc;
    const nch = Math.min(out.length, this.channels), nb = this.channels;
    const hOn = this.hOn, hPos = this.hPos, hRate = this.hRate, hGain = this.hGain, hLen = this.hLen, hAge = this.hAge, hIn = this.hIn, hOut = this.hOut, hSrc = this.hSrc, hb = this.hb;
    let w = this.w;
    for (let i = 0; i < n; i++) {
      s.d += (td - s.d) * k; s.w += (tw - s.w) * k;
      // 1. schreiben (alle Pufferkanäle, fehlender Eingangskanal = Stille; sonst blieben alte Werte im Ring stehen)
      for (let c = 0; c < nb; c++) bufs[c][w] = inp && inp[c] ? finiteOr0(inp[c][i]) : 0;
      w = w + 1 === F ? 0 : w + 1;
      const t = ++this.t;
      // 2. Planer
      let dm = 1;
      if (sched) { this.w = w; sched.tick(this, t); if (sched.dryMul !== undefined) dm = sched.dryMul; }   // w für hold() aktuell halten
      // 3. Köpfe
      for (let c = 0; c < nch; c++) acc[c] = 0;
      if (this.active) {
        const lo = t - F + 1, hi = t - 3;
        for (let h = 0; h < TB_MAX_HEADS; h++) {
          if (!hOn[h]) continue;
          const pos = hPos[h];
          if (hSrc[h]) {
            // Haltepuffer (20b): Index = Position − holdAt + 1 (Platz 0 hält den linken Hermite-Nachbarn)
            const q = pos - this.holdAt;
            if (!(this.holdLen > 0) || q < 0 || q > this.holdLen - 1) { hOn[h] = 0; this.active--; this.starved++; continue; }
            const g = hGain[h] * tbFade(hAge[h], hLen[h], hIn[h], hOut[h]);
            const q0 = Math.floor(q), f = q - q0, j = q0 + 1;
            if (f === 0) { for (let c = 0; c < nch; c++) acc[c] += g * hb[c][j]; }
            else {
              for (let c = 0; c < nch; c++) {
                const b = hb[c], xm1 = b[j - 1], x0 = b[j], x1 = b[j + 1], x2 = b[j + 2];
                const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
                acc[c] += g * (((c3 * f + c2) * f + c1) * f + x0);
              }
            }
            hPos[h] = pos + hRate[h];
            if (++hAge[h] >= hLen[h]) { hOn[h] = 0; this.active--; }
            continue;
          }
          if (pos < lo || pos > hi) { hOn[h] = 0; this.active--; this.starved++; continue; }
          const g = hGain[h] * tbFade(hAge[h], hLen[h], hIn[h], hOut[h]);
          const i0 = Math.floor(pos), f = pos - i0;
          // Ringindex der absoluten Position i0: w zeigt auf absolute Zeit t (nächster Schreibplatz)
          let r = w - (t - i0); if (r < 0) r += F; if (r < 0) r += F;
          if (f === 0) {
            for (let c = 0; c < nch; c++) acc[c] += g * bufs[c][r];
          } else {
            const rm = r === 0 ? F - 1 : r - 1, r1 = r + 1 === F ? 0 : r + 1, r2 = r1 + 1 === F ? 0 : r1 + 1;
            for (let c = 0; c < nch; c++) {
              const b = bufs[c], xm1 = b[rm], x0 = b[r], x1 = b[r1], x2 = b[r2];
              const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
              acc[c] += g * (((c3 * f + c2) * f + c1) * f + x0);
            }
          }
          hPos[h] = pos + hRate[h];
          if (++hAge[h] >= hLen[h]) { hOn[h] = 0; this.active--; }
        }
      }
      // 4. Ausgang (Eingang steht noch im Puffer an Platz w − 1)
      const wr = w === 0 ? F - 1 : w - 1;
      const d = s.d * dm;   // dm = 1 → exakt s.d (bit-gleich zu 20a)
      for (let c = 0; c < nch; c++) out[c][i] = flush(d * bufs[c][wr] + s.w * acc[c]);
    }
    for (let c = nch; c < out.length; c++) out[c].fill(0);
    this.w = w;
  }
}

/**
 * Lastprobe (nur Kostenmessung M-1 und Tests, keine Nutzerfunktion): hält `heads` Köpfe ständig aktiv. Jeder Kopf liest ein Korn
 * von 20–100 ms aus der letzten Sekunde mit Rate 0,5–2 (ein Viertel rückwärts), Flanken je 25 %. Alle Werte über hashRand(seed, k, …),
 * also gleicher Seed ⇒ gleicher Ausgang. Startet höchstens einen Kopf je Sample.
 */
export class TbProbe {
  constructor(sr, heads = 8, seed = 1) {
    this.sr = sr;
    this.heads = clamp(heads | 0, 0, TB_MAX_HEADS);
    this.seed = seed >>> 0;
    this.k = 0;
  }

  tick(core, t) {
    if (core.active >= this.heads) return;
    const sr = this.sr, k = this.k, sd = this.seed;
    const len = Math.round((0.02 + 0.08 * hashRand(sd, k, 1)) * sr);
    const rate = (0.5 + 1.5 * hashRand(sd, k, 2)) * (hashRand(sd, k, 3) < 0.25 ? -1 : 1);
    const span = len * Math.abs(rate) + 2;                       // verbrauchte Quelle
    const room = Math.min(t - 3, core.newest - core.oldest);     // verfügbare Historie
    const back = Math.min(sr, Math.max(0, room - span)) * hashRand(sd, k, 4);
    if (room < span) return;                                     // noch zu wenig Historie
    this.k = k + 1;
    const end = core.newest - back;                              // jüngstes gelesenes Sample
    const at = rate > 0 ? end - span + 2 : end;                  // vorwärts: endet bei `end`; rückwärts: beginnt dort
    core.startHead({ at, length: len, rate, gain: 1 / Math.sqrt(Math.max(1, this.heads)), fadeIn: len >> 2, fadeOut: len >> 2 });
  }
}
