/**
 * audio/dsp-lib/granular-delay.js — Planer des Delay-Modus `granular` (Phase 20f) für den Rechenkern audio/dsp-lib/timebuffer.js.
 * ---------------------------------------------------------------------------------------------------------------------------------
 * Entscheidungen Nutzer (2026-11-07, „A = a … G = a“):
 *   (A) Dichte in Körnern pro Sekunde (1 … 100/s).
 *   (B) Kornabstand gleichmäßig: alle round(sr / Dichte) Samples ein Korn (kein Zufall im Abstand).
 *   (C) Pegel: jedes Korn mit 1/√Überlappung (Überlappung = Dichte · Kornlänge, höchstens 1 → Faktor 1). Für unkorrelierte Körner bleibt der
 *       Pegel damit etwa gleich; ohne Spray und Tonhöhe sind die Körner kohärent (sie lesen dasselbe verzögerte Signal) und die Summe liegt
 *       um √Überlappung unter dem Eingang (bei Überlappung 2: −3 dB) [Code; Höreindruck H].
 *   (D) Stereo: alle Kanäle lesen dieselbe Position (Stereobild bleibt, Kern unverändert).
 *   (E) Zufall: fester Seed je Bau (processorOptions.seed). `arm()` übernimmt keinen Seed — jede Wiedergabe klingt gleich.
 *   (F) Tonhöhe −12 … +12 Halbtöne, Zufall stufenlos 0 … 12 Halbtöne; die Summe je Korn wird auf ±12 Halbtöne geklemmt (Rate 0,5 … 2).
 *   (G) Felder grainSize (ms), grainDensity (/s), grainSpray (ms), grainPitch, grainPitchRandom (Halbtöne); `time` = Verzögerung der Kornmitte,
 *       `feedback`, `wet` wie im übrigen Delay. Low-/High-Cut und Modulation wirken nicht (in der UI ausgeblendet, wie Reverse 20e).
 *
 * Korn k (Kernzeit tk, Start im tick):
 *   Länge Lg = round(grainSize · sr) Ausgangssamples, Hüllkurve volles Hann-Fenster aus zwei halben Flanken (tbFade, fadeIn ⌊Lg/2⌋, fadeOut Rest).
 *   Rate ρ = 2^(Halbtöne/12), Halbtöne = grainPitch + grainPitchRandom · (2u − 1), u = hashRand(seed, k, SALT_PITCH).
 *   Verzögerung der Kornmitte Dk = time · sr + spray · sr · (2v − 1), v = hashRand(seed, k, SALT_SPRAY) (gleichverteilt, ±Spray).
 *   Das Ausgangssample zur Kernzeit t gehört zum Eingangssample t − 1 (Kern: Ausgang = Platz w − 1). Leseposition zu Beginn:
 *   tk − 1 + Lg/2 · (1 − ρ) − Dk, je Sample um ρ weiter. Abstand zum gleichzeitigen Eingangssample bei Alter i: Dk + (1 − ρ)(i − Lg/2)
 *   (ohne Spray und Tonhöhe genau `time`). Damit das Korn nie in die Zukunft (≤ t − 3) und nie hinter den Ring liest, wird Dk geklemmt auf
 *     |ρ − 1| · Lg/2 + 4  …  frames − 8 − |ρ − 1| · Lg/2.
 *   Tonhöhe > 0 verlängert so bei langen Körnern die kleinste Verzögerung (+12, 500 ms: mindestens 250 ms); auf Mobilgeräten (Ring 2 s)
 *   begrenzt die obere Klemmung die Zeit.
 *   Höchstens TB_MAX_HEADS − 2 Körner überlappen: der Abstand ist mindestens ⌈Lg / 30⌉ (sonst würden Starts abgewiesen und es entstünden
 *   unregelmäßige Lücken); die wirksame Überlappung geht in den Pegel (C) ein.
 *   Neue Regler (Port) gelten ab dem nächsten Kornstart; laufende Körner klingen mit ihren Werten aus.
 *
 * Rückkopplung wie Reverse (20e): im tick zum Zeitpunkt t wird fb · Schutz(Kopfsumme des vorigen Samples, `core.acc`) auf das Ringsample t − 2
 *   addiert (schon trocken ausgegeben, frühestens im nächsten Sample gelesen). Schutz = revDelayGuard (Knie wie delayGuardCurve).
 *
 * Zeitbasis wie Reverse: das erste arm() leert nicht (Offline-Render und Export laufen ab Frame 0 identisch, unabhängig vom Ankunftszeitpunkt
 *   der Nachricht). Neuer Ursprung (Seek, Musik nach Pause) → Ring bis auf das gerade geschriebene Sample leeren, Köpfe stoppen, Rückkopplung
 *   leeren, Kornzähler k = 0 (die Körnerfolge beginnt von vorn). hold() wirkt nicht. Der Zufall hängt nur von (seed, k) ab.
 *
 * Regeln der dsp-lib: keine Allokation in tick(), keine DOM-/AudioContext-Zugriffe.
 */
import { clamp, finiteOr0 } from './util.js';
import { hashRand } from './prng.js';
import { revDelayGuard } from './reverse-delay.js';

export const GRAIN_SIZE_RANGE = [10, 500];          // ms
export const GRAIN_DENSITY_RANGE = [1, 100];        // Körner/s
export const GRAIN_SPRAY_RANGE = [0, 250];          // ms (± um die Verzögerung)
export const GRAIN_PITCH_RANGE = [-12, 12];         // Halbtöne
export const GRAIN_PITCH_RANDOM_RANGE = [0, 12];    // Halbtöne
export const GRAIN_TIME_RANGE = [0.01, 2];          // s (Verzögerung der Kornmitte, wie die Delay-Zeit)
/** Höchstens so viele Körner überlappen (Reserve gegen TB_MAX_HEADS = 32). */
export const GRAIN_MAX_OVERLAP = 30;
/** Pufferlänge (s): größte Zeit + Spray + |ρ − 1| · Lg/2 bei ρ = 2 und 500 ms, dazu Reserve. */
export const GRDELAY_BUFFER_SECONDS = GRAIN_TIME_RANGE[1] + GRAIN_SPRAY_RANGE[1] / 1000 + GRAIN_SIZE_RANGE[1] / 2000 + 0.05;
export const GRAIN_SALT_SPRAY = 0x6D;
export const GRAIN_SALT_PITCH = 0x70;

const _fin = (v, d) => (Number.isFinite(v) ? v : d);

/** Werte für Worklet, Graph und Tests, geklemmt (feedback schon nach registry.delayLoopGains). Zeiten: time in s, Korn/Spray in ms. */
export function granularDelayParams(q) {
  return {
    time: clamp(_fin(q?.time, 0.22), GRAIN_TIME_RANGE[0], GRAIN_TIME_RANGE[1]),
    feedback: clamp(_fin(q?.feedback, 0.35), 0, 0.95),
    wet: clamp(_fin(q?.wet, 0.35), 0, 0.95),
    grainSize: clamp(_fin(q?.grainSize, 80), GRAIN_SIZE_RANGE[0], GRAIN_SIZE_RANGE[1]),
    grainDensity: clamp(_fin(q?.grainDensity, 20), GRAIN_DENSITY_RANGE[0], GRAIN_DENSITY_RANGE[1]),
    grainSpray: clamp(_fin(q?.grainSpray, 30), GRAIN_SPRAY_RANGE[0], GRAIN_SPRAY_RANGE[1]),
    grainPitch: clamp(_fin(q?.grainPitch, 0), GRAIN_PITCH_RANGE[0], GRAIN_PITCH_RANGE[1]),
    grainPitchRandom: clamp(_fin(q?.grainPitchRandom, 0), GRAIN_PITCH_RANDOM_RANGE[0], GRAIN_PITCH_RANDOM_RANGE[1])
  };
}

/** Raster eines Parametersatzes (Samples): Kornlänge, Abstand, wirksame Überlappung, Kornpegel (Entscheidung C). */
export function granularGrid(v, sr) {
  const len = Math.max(2, Math.round(v.grainSize / 1000 * sr));
  const step = Math.max(1, Math.round(sr / v.grainDensity), Math.ceil(len / GRAIN_MAX_OVERLAP));
  const overlap = len / step;
  return { len, step, overlap, gain: 1 / Math.sqrt(Math.max(1, overlap)) };
}

/**
 * Korn k (zustandslos, nur von (v, seed, k) und der Ringlänge abhängig): Rate, Verzögerung der Kornmitte (Samples, geklemmt) und
 * Versatz der Startposition gegenüber dem gleichzeitigen Eingangssample (at = tk − 1 + off).
 */
export function granularGrain(v, sr, seed, k, frames, len = granularGrid(v, sr).len) {
  const st = clamp(v.grainPitch + v.grainPitchRandom * (2 * hashRand(seed, k, GRAIN_SALT_PITCH) - 1), -12, 12);
  const rate = Math.pow(2, st / 12);
  const half = len / 2, skew = Math.abs(rate - 1) * half;
  const lo = skew + 4, hi = Math.max(lo, frames - 8 - skew);
  const delay = clamp(v.time * sr + v.grainSpray / 1000 * sr * (2 * hashRand(seed, k, GRAIN_SALT_SPRAY) - 1), lo, hi);
  return { semitones: st, rate, delay, off: half * (1 - rate) - delay };
}

/**
 * Nachklang (s) über das Quellenende hinaus: ein Durchgang = größte Verzögerung der Kornmitte (Zeit + Spray, mindestens die Klemmung bei
 * Tonhöhe) + eine Kornlänge; mit Rückkopplung je Durchgang eine Verzögerung bis −60 dB (⌈ln 0,001 / ln fb⌉, der Kornpegel ≤ 1 verkürzt
 * nur). Grenze 30 s wie der Export.
 */
export function granularDelayTailSeconds(q) {
  const v = granularDelayParams(q);
  const hiSt = Math.min(12, v.grainPitch + v.grainPitchRandom), loSt = Math.max(-12, v.grainPitch - v.grainPitchRandom);
  const skew = Math.max(Math.pow(2, hiSt / 12) - 1, 1 - Math.pow(2, loSt / 12), 0) * v.grainSize / 2000;
  const d = Math.max(v.time, skew) + v.grainSpray / 1000;
  const repeats = v.feedback > 0 ? Math.ceil(Math.log(0.001) / Math.log(v.feedback)) : 0;
  return Math.min(30, d + v.grainSize / 1000 + d * repeats);
}

export class GranularDelaySched {
  /** @param {number} sr Abtastrate */
  constructor(sr) {
    this.sr = sr;
    this.v = granularDelayParams({});
    this.tm = null;
    this.seed = 1;            // fester Seed je Bau (Entscheidung E; der Worklet setzt ihn aus processorOptions)
    this.off = 0;
    this.next = -1;           // Kernzeit des nächsten Kornstarts (−1 = beim nächsten tick)
    this.k = 0;               // Kornzähler seit Bau bzw. letztem Leeren (Index des Zufalls)
    this.pendingReset = false;
    this.grains = 0;          // gestartete Körner (Tests/Diagnose)
    this.rejected = 0;        // abgewiesene Starts (Liste voll; sollte 0 bleiben)
    this.resets = 0;
  }

  setParams(q) { this.v = granularDelayParams(q); }

  /** Zeitbasis: nur der Neustart zählt; ein mitgeschickter Seed wird nicht übernommen (Entscheidung E). */
  arm(tm) {
    const o = Math.round(finiteOr0(tm?.originF));
    if (this.tm && this.tm.originF !== o) this.pendingReset = true;
    this.tm = { originF: o };
  }

  hold() { /* Nachklang läuft weiter */ }

  block(frame, t) { this.off = frame - t; }

  _clear(core) {
    const keep = core.w === 0 ? core.frames - 1 : core.w - 1;
    for (let c = 0; c < core.channels; c++) { const b = core.bufs[c], x = b[keep]; b.fill(0); b[keep] = x; }
    core.stopAll();
    core.acc.fill(0);
    this.next = -1; this.k = 0;
    this.resets++;
  }

  tick(core, t) {
    if (this.pendingReset) { this.pendingReset = false; this._clear(core); }
    // 1. Rückkopplung (wie 20e): Kopfsumme des vorigen Samples auf das Ringsample t − 2
    const fb = this.v.feedback;
    if (fb > 0 && t >= 2) {
      const F = core.frames, acc = core.acc;
      let r = core.w - 2; if (r < 0) r += F;
      for (let c = 0; c < core.channels; c++) core.bufs[c][r] += fb * revDelayGuard(acc[c]);
    }
    // 2. Kornstart
    if (this.next < 0) this.next = t;
    if (t !== this.next) return;
    const v = this.v, g = granularGrid(v, this.sr);
    const gr = granularGrain(v, this.sr, this.seed, this.k, core.frames, g.len);
    const fin = g.len >> 1;
    const h = core.startHead({ at: t - 1 + gr.off, length: g.len, rate: gr.rate, gain: g.gain, fadeIn: fin, fadeOut: g.len - fin });
    if (h < 0) this.rejected++; else this.grains++;
    this.k++;
    this.next = t + g.step;
  }
}
