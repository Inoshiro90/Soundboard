/**
 * audio/dsp-lib/reverse-delay.js — Planer des Delay-Modus `reverse` (Phase 20e) für den Rechenkern audio/dsp-lib/timebuffer.js.
 * -------------------------------------------------------------------------------------------------------------------------------
 * Entscheidungen Nutzer (2026-11-06, „A = a, B = a, C = a, D = a“):
 *   (A) Blocklänge = Delay-Zeit `time` (kein eigener Regler).
 *   (B) Rückkopplung: der Ausgang (Kopfsumme) läuft in den Puffer zurück und wird beim nächsten Durchgang erneut umgedreht —
 *       die Wiederholungen wechseln rückwärts → vorwärts → rückwärts …
 *   (C) Low-/High-Cut und Modulation wirken im Modus `reverse` nicht (in der UI ausgeblendet; gespeicherte Werte bleiben).
 *   (D) Mono-Quellen: Hochmischen −3,01 dB vor dem Worklet (M-3, wie Stutter), kein Ausgleich.
 *
 * Blöcke (Zeiten in Samples, Kernzeit t):
 *   L = Blocklänge = round(time · sr), H = ⌈L/2⌉ (Abstand der Kopfstarts). Alle H Samples startet ein Kopf mit Rate −1 am jüngsten
 *   lesbaren Sample (t − 3) und liest Fin + H Samples rückwärts (stationär Fin = H, also L Samples = ein Block). Hüllkurve halbe
 *   Hann-Flanken: Einblendung Fin, Ausblendung H (tbFade). Der nächste Kopf startet, wenn die Ausblendung des vorigen beginnt (nach Fin
 *   Samples) und blendet über genau diese Restlänge ein: zwei Köpfe überlappen sich immer zu komplementären Flanken, die Summe der
 *   Gewichte ist in jedem Ausgangssample exakt 1 (keine Pegeldelle, keine Klicks an den Blockgrenzen).
 *   Neue Zeit (Port): gilt ab dem nächsten Kopfstart; der Übergangskopf blendet über die Restlänge des alten ein und über das neue H aus —
 *   die Summe bleibt auch beim Wechsel 1.
 *   Verzögerung: das jüngste Sample eines Blocks kommt nach 2 Samples (Kernlatenz), das älteste nach ≈ 2L. Die Mitte der Hüllkurve liegt
 *   bei ≈ L. Die Latenz gehört zum Effekt und wird nicht ausgeglichen.
 *
 * Rückkopplung: im tick zum Zeitpunkt t wird fb · Schutz(Kopfsumme des vorigen Samples, `core.acc`) auf das Ringsample t − 2 addiert.
 *   Dieses Sample hat der trockene Ausgang schon verlassen (der Dry bleibt rein), gelesen wird es frühestens im nächsten Sample (Köpfe lesen
 *   ≤ t − 3). Schutz = Knie wie die Schutzsättigung des Delay v2 (effect-graph.js delayGuardCurve: bis ±0,5 linear, darüber tanh, Grenze
 *   ±0,88 ab |x| ≥ 1), hier analytisch statt als Kurventabelle [H: Abweichung zur Tabelle ≤ Interpolationsfehler, nicht hörbar].
 *   fb kommt geklemmt aus registry.delayLoopGains (≤ 0,95).
 *
 * Zeitbasis: arm() wie 20b–20d. Ein Raster-Ursprung ist nicht nötig (die Köpfe laufen frei ab dem ersten Sample bzw. ab dem Leeren).
 *   Der Ursprung dient nur zum Erkennen eines Neustarts: anderer Ursprung als bisher (Seek, Musik nach Pause) → Ring bis auf das gerade
 *   geschriebene Sample leeren (kein Geisterecho von vor dem Sprung), Köpfe stoppen, Rückkopplung leeren, Blöcke neu ab dem nächsten Sample.
 *   Das erste arm() nach dem Bau leert nicht (kommt im Worklet oft einige Blöcke zu spät, 20d) — Offline-Render und Export laufen damit
 *   ab Frame 0 identisch, unabhängig davon, wann die Nachricht ankommt.
 *   hold() (Musik-Pause): nichts — der Nachklang klingt aus wie beim nativen Delay.
 *
 * Regeln der dsp-lib: keine Allokation in tick(), keine DOM-/AudioContext-Zugriffe.
 */
import { clamp, finiteOr0 } from './util.js';

/** Bereich der Blocklänge (s): wie die Delay-Zeit (registry DELAY_MIN_S … 2 s). */
export const REVDELAY_TIME_RANGE = [0.01, 2];
/** Pufferlänge (s): ein Übergangskopf liest höchstens H_alt + H_neu ≤ 2 s zurück, dazu Reserve. */
export const REVDELAY_BUFFER_SECONDS = REVDELAY_TIME_RANGE[1] + 0.05;
/** Kernlatenz: der Kopf startet am jüngsten lesbaren Sample t − 3; das gerade geschriebene ist t − 1. */
export const REVDELAY_LATENCY_SAMPLES = 2;
const KNEE = 0.5;

const _fin = (v, d) => (Number.isFinite(v) ? v : d);

/** Werte für Worklet, Graph und Tests, geklemmt: time (s), feedback (0 … 0,95, schon nach delayLoopGains), wet. */
export function reverseDelayParams(q) {
  return {
    time: clamp(_fin(q?.time, 0.22), REVDELAY_TIME_RANGE[0], REVDELAY_TIME_RANGE[1]),
    feedback: clamp(_fin(q?.feedback, 0.35), 0, 0.95),
    wet: clamp(_fin(q?.wet, 0.35), 0, 0.95)
  };
}

/** Schutzknie der Rückkopplung (analytisch, wie delayGuardCurve). */
export function revDelayGuard(x) {
  const a = x < 0 ? -x : x;
  if (a <= KNEE) return x;
  const y = KNEE + (1 - KNEE) * Math.tanh((Math.min(a, 1) - KNEE) / (1 - KNEE));
  return x < 0 ? -y : y;
}

/**
 * Nachklang (s) über das Quellenende hinaus: 2 Blöcke für den letzten Block, dazu je Rückkopplungsdurchgang ≈ ein Block bis −60 dB
 * (Formel wie delayTailSeconds: ⌈ln 0,001 / ln fb⌉). Grenze 30 s wie der Export.
 */
export function reverseDelayTailSeconds(q) {
  const v = reverseDelayParams(q);
  const repeats = v.feedback > 0 ? Math.ceil(Math.log(0.001) / Math.log(v.feedback)) : 0;
  return Math.min(30, v.time * (2 + repeats));
}

export class ReverseDelaySched {
  /** @param {number} sr Abtastrate */
  constructor(sr) {
    this.sr = sr;
    this.v = reverseDelayParams({});
    this.tm = null;
    this.seed = 1;            // ungenutzt (kein Zufall); Feld für das gemeinsame Worklet-Protokoll
    this.off = 0;
    this.next = -1;           // Kernzeit des nächsten Kopfstarts (−1 = beim nächsten tick)
    this.prevOut = 0;         // Ausblendlänge des zuletzt gestarteten Kopfs (0 = keiner)
    this.pendingReset = false;
    this.heads = 0;           // gestartete Köpfe (Tests/Diagnose)
    this.resets = 0;
  }

  setParams(q) { this.v = reverseDelayParams(q); }

  arm(tm) {
    const o = Math.round(finiteOr0(tm?.originF));
    if (this.tm && this.tm.originF !== o) this.pendingReset = true;
    this.tm = { originF: o };
  }

  hold() { /* Nachklang läuft weiter */ }

  block(frame, t) { this.off = frame - t; }

  /** Ring bis auf das gerade geschriebene Sample leeren, Köpfe und Rückkopplung zurücksetzen. Einmal je Neustart (kein Allokieren). */
  _clear(core) {
    const keep = core.w === 0 ? core.frames - 1 : core.w - 1;
    for (let c = 0; c < core.channels; c++) { const b = core.bufs[c], x = b[keep]; b.fill(0); b[keep] = x; }
    core.stopAll();
    core.acc.fill(0);
    this.next = -1; this.prevOut = 0;
    this.resets++;
  }

  tick(core, t) {
    if (this.pendingReset) { this.pendingReset = false; this._clear(core); }
    // 1. Rückkopplung: Kopfsumme des vorigen Samples auf das Ringsample t − 2 (schon trocken ausgegeben, noch nicht gelesen)
    const fb = this.v.feedback;
    if (fb > 0 && t >= 2) {
      const F = core.frames, acc = core.acc;
      let r = core.w - 2; if (r < 0) r += F;
      for (let c = 0; c < core.channels; c++) core.bufs[c][r] += fb * revDelayGuard(acc[c]);
    }
    // 2. Kopfstart
    if (this.next < 0) this.next = t;
    if (t !== this.next) return;
    const L = clamp(Math.round(this.v.time * this.sr), 2, core.frames - 8);
    const H = Math.max(1, Math.ceil(L / 2));
    const fin = this.prevOut > 0 ? this.prevOut : H;
    core.startHead({ at: t - 3, length: fin + H, rate: -1, gain: 1, fadeIn: fin, fadeOut: H });
    this.heads++;
    this.next = t + fin;
    this.prevOut = H;
  }
}
