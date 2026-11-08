/**
 * audio/dsp-lib/stutter.js — Planer des Moduls `stutter` (Phase 20b) für den Rechenkern audio/dsp-lib/timebuffer.js.
 * -------------------------------------------------------------------------------------------------------------------
 * Entscheidungen Nutzer (2026-11-06):
 *   - Je Durchlauf der Quelle EIN Ereignis: `at` ms nach Durchlaufbeginn wird das Segment [at, at + Länge] festgehalten und wiederholt.
 *     (Ein periodisches Raster über die ganze Quelle ist `beatRepeat`, 20c.)
 *   - Rate = Abstand der Wiederholungsstarts in Vielfachen der Länge (1 = lückenlos, 2 = gleich lange Pause; UI in %).
 *   - Mix 100 %: die Wiederholungen ERSETZEN das trockene Signal; Mix < 100 % entsprechend weniger; außerhalb der Wiederholungen voll trocken.
 *   - ∞: wiederholt bis zum Ende des Durchlaufs (mit Flanke), danach Stille wie die Quelle.
 *   - Wahrscheinlichkeit: einmal je Ereignis (Stutter ja/nein), hashRand(seed, Durchlauf, STUTTER_SALT_PROB).
 *
 * Ablauf eines Ereignisses (Zeiten in Samples, Context-Frames):
 *   A = Durchlaufbeginn + at, L = Länge, P = round(L · Rate).
 *   Das Original A … A + L − 1 klingt trocken (Wiederholung 0). Wiederholung j = 1 … J startet bei A + j·P und liest das Segment ab A
 *   mit der Rate r_j = 2^(j · pitchStep / 12) (geklemmt auf STUTTER_RATE_MIN … STUTTER_RATE_MAX), Länge min(L / r_j, P): tiefere
 *   Wiederholungen werden am nächsten Start gekürzt (der Rhythmus bleibt), höhere lassen eine Pause.
 *   Flanken je Wiederholung: F_j = max(1 ms, fade · Länge_j), höchstens die halbe Länge (halbe Hann-Flanken, tbFade).
 *   Trocken: von A + L bis zum Ende der letzten Wiederholung W abgesenkt auf 1 − mix · env, env = tbFade über diesen Bereich mit den
 *   Flanken F_1 (Anfang) und F_J (Ende). Bei Rate 1 ergänzen sich das Ausblenden des trockenen Signals und das Einblenden der ersten
 *   Wiederholung exakt zu 1 (gleiche Flanke, gleiche Abtastung), ebenso am Ende.
 *   Grenzen: Das Segment muss im Durchlauf liegen (A + L ≤ Durchlaufende, sonst kein Ereignis). Mit ∞ oder Loop enden die Wiederholungen
 *   am Durchlaufende (die letzte wird dort mit Flanke abgeschnitten); ohne Loop dürfen endliche Wiederholungen über das Quellenende
 *   hinaus klingen (Nachklang, registry `tail`). ∞ ohne bekannte Dauer: höchstens STUTTER_INF_CAP Wiederholungen.
 *   Ab der Kopie in den Haltepuffer (A + L + 3) lesen die Wiederholungen dort (bit-gleich zum Ring, altern nicht).
 *
 * Zeitbasis: `arm({ passStartF, passIndex, durF, loop, originF, seed })` in Context-Frames (engine/timebuffer-node.js rechnet die
 * Zeitbasis 13d um). `block(frame, t)` je Prozessorblock verbindet Context-Frame und Kernzeit. Ohne arm(): Durchgang (dryMul 1).
 * Ein neuer Ursprung gilt als leerer Puffer (Seek, Musik nach Pause): Köpfe und Haltepuffer leer, Segmente, die davor begannen,
 * lösen nicht aus (validFrom). Der Ring selbst wird nicht gelöscht (sonst ein Aussetzer im trockenen Signal).
 *
 * Regeln der dsp-lib: keine Allokation in tick(), keine DOM-/AudioContext-Zugriffe.
 */
import { clamp, finiteOr0 } from './util.js';
import { hashRand } from './prng.js';
import { tbFade } from './timebuffer.js';

export const STUTTER_AT_RANGE = [0, 10000];         // ms
export const STUTTER_LENGTH_RANGE = [5, 500];       // ms (Plan P20)
export const STUTTER_COUNT_RANGE = [1, 64];
export const STUTTER_SPACING_RANGE = [1, 4];        // × Länge
export const STUTTER_FADE_RANGE = [0, 0.5];         // Anteil der Länge je Flanke
export const STUTTER_STEP_RANGE = [-12, 12];        // Halbtöne je Wiederholung
/** Grenzen der Kopf-Rate (± 2 Oktaven) — ohne Grenze liefe ein großer Schritt über viele Wiederholungen ins Unhörbare [H]. */
export const STUTTER_RATE_MIN = 0.25;
export const STUTTER_RATE_MAX = 4;
/** Mindestflanke gegen Klicks (auch bei Fade 0) [H]. */
export const STUTTER_MIN_FADE_S = 0.001;
/** ∞ ohne bekannte Durchlaufdauer (z. B. Musik-Stream): höchstens so viele Wiederholungen. */
export const STUTTER_INF_CAP = 64;
/** Haltepuffer: längstes Segment plus Reserve. */
export const STUTTER_HOLD_SECONDS = STUTTER_LENGTH_RANGE[1] / 1000 + 0.01;
export const STUTTER_SALT_PROB = 0x5701;

const _fin = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * Werte für Worklet, Graph und Tests, geklemmt — eine Wahrheit (registry.js stutterValues ruft diese Funktion).
 * at/length in ms, count ganzzahlig, infinite boolesch (Daten: 'on' | 'off'), spacing, fade, pitchStep, probability, mix.
 */
export function stutterParams(q) {
  return {
    at: clamp(_fin(q?.at, 0), STUTTER_AT_RANGE[0], STUTTER_AT_RANGE[1]),
    length: clamp(_fin(q?.length, 80), STUTTER_LENGTH_RANGE[0], STUTTER_LENGTH_RANGE[1]),
    count: Math.round(clamp(_fin(q?.count, 4), STUTTER_COUNT_RANGE[0], STUTTER_COUNT_RANGE[1])),
    infinite: q?.infinite === 'on',
    spacing: clamp(_fin(q?.spacing, 1), STUTTER_SPACING_RANGE[0], STUTTER_SPACING_RANGE[1]),
    fade: clamp(_fin(q?.fade, 0.1), STUTTER_FADE_RANGE[0], STUTTER_FADE_RANGE[1]),
    pitchStep: clamp(_fin(q?.pitchStep, 0), STUTTER_STEP_RANGE[0], STUTTER_STEP_RANGE[1]),
    probability: clamp(_fin(q?.probability, 1), 0, 1),
    mix: clamp(_fin(q?.mix, 1), 0, 1)
  };
}

/** Kopf-Rate der Wiederholung j (j ≥ 1). */
export const stutterRate = (j, step) => clamp(Math.pow(2, (j * step) / 12), STUTTER_RATE_MIN, STUTTER_RATE_MAX);

/**
 * Größter Nachklang über das Quellenende hinaus (s), ohne Loop: Das Segment endet spätestens am Quellenende, die Wiederholungen
 * reichen höchstens J·P + min(P, L/r_J) − L weiter. Mit ∞ endet alles am Durchlaufende → 0.
 */
export function stutterTailSeconds(q) {
  const v = stutterParams(q);
  if (v.infinite) return 0;
  const L = v.length / 1000, P = L * v.spacing, J = v.count;
  return Math.max(0, J * P + Math.min(P, L / stutterRate(J, v.pitchStep)) - L);
}

export class StutterSched {
  /** @param {number} sr Abtastrate */
  constructor(sr) {
    this.sr = sr;
    this.dryMul = 1;
    this.v = stutterParams({});
    this.tm = null;          // Zeitbasis in Frames oder null (Durchgang)
    this.seed = 1;
    this.off = 0;            // Context-Frame des gerade geschriebenen Samples = t − 1 + off; absolute Pufferposition eines Frames = Frame − off
    this.k = 0;              // nächster zu prüfender Durchlauf
    this.done = false;       // ohne Loop: Ereignis des Durchlaufs erledigt
    this.validFrom = -Infinity;   // erstes Frame mit gültigem Pufferinhalt (nach Leeren)
    this.pendingReset = false;
    // laufendes Ereignis (feste Werte, Zahlen statt Objekt: keine Allokation)
    this.on = false; this.A = 0; this.L = 0; this.P = 0; this.J = 0; this.step = 0; this.fade = 0;
    this.cut = Infinity; this.W = 0; this.F1 = 0; this.FJ = 0; this.next = 1; this.capF = 0; this.held = false;
    // Zähler (Tests/Diagnose)
    this.events = 0; this.skipped = 0;
    this.pendingStop = false;
  }

  /** Neue Regler (wirken ab dem nächsten Ereignis; Mix läuft über den wet-Parameter des Worklets). */
  setParams(q) { this.v = stutterParams(q); }

  /**
   * Zeitbasis setzen. Anderer Ursprung als bisher → Puffer leeren (beim nächsten tick), Ereignis abbrechen.
   * @param {{originF:number, passStartF:number, passIndex:number, durF:number, loop:boolean, seed?:number}} tm
   */
  arm(tm) {
    const prev = this.tm;
    this.tm = { originF: Math.round(finiteOr0(tm.originF)), passStartF: Math.round(finiteOr0(tm.passStartF)), passIndex: Math.max(0, Math.floor(finiteOr0(tm.passIndex))),
      durF: Math.max(0, Math.round(finiteOr0(tm.durF))), loop: !!tm.loop && tm.durF > 0 };
    if (Number.isFinite(tm.seed)) this.seed = tm.seed >>> 0;
    if (prev && prev.originF !== this.tm.originF) { this.pendingReset = true; this.on = false; this.k = this.tm.passIndex; this.done = false; }
    else if (!prev) { this.k = this.tm.passIndex; this.done = false; }
    else if (this.tm.passIndex > this.k || (!this.tm.loop && this.tm.passIndex !== prev.passIndex)) { this.k = this.tm.passIndex; this.done = false; }   // Musik: neuer Durchlauf
  }

  /** Musik-Pause: Ereignis beenden, Köpfe stoppen (über den Kern beim nächsten tick), Durchgang bis zum nächsten arm(). */
  hold() { this.tm = null; this.on = false; this.dryMul = 1; this.pendingStop = true; }

  /** Je Prozessorblock vor core.process(): Context-Frame des ersten Samples und Kernzeit vor dem Block (im tick des ersten Samples ist t um 1 weiter). */
  block(frame, t) { this.off = frame - t; }

  _passStart(k) { const tm = this.tm; return tm.passStartF + (k - tm.passIndex) * tm.durF; }

  /** Prüft das Ereignis des Durchlaufs k zum Frame f: 1 = gestartet, 0 = noch nicht fällig, −1 = entfällt (verpasst/ungültig). */
  _try(core, k, f) {
    const tm = this.tm, sr = this.sr, v = this.v;
    const ps = this._passStart(k);
    const A = ps + Math.round(v.at * sr / 1000), L = Math.max(8, Math.round(v.length * sr / 1000));
    if (f < A) return 0;
    if (f > A + L || A < this.validFrom || A - this.off < core.oldest + 1) return -1;   // zu spät (Seek mitten ins Segment) oder nicht im Puffer
    const E = tm.durF > 0 ? ps + tm.durF : Infinity;
    if (A + L > E) return -1;                                                          // Segment reicht über das Durchlaufende
    if (!(hashRand(this.seed, k, STUTTER_SALT_PROB) < v.probability)) return -1;       // Random Repeat: dieses Mal nicht
    const P = Math.max(L, Math.round(L * v.spacing));
    const cut = v.infinite || tm.loop ? E : Infinity;
    let J = v.infinite ? (Number.isFinite(cut) ? Math.floor((cut - 1 - A) / P) : STUTTER_INF_CAP) : v.count;
    if (Number.isFinite(cut)) J = Math.min(J, Math.floor((cut - 1 - A) / P));
    if (!(J >= 1)) return -1;
    // laufendes Ereignis eines früheren Durchlaufs (nur Musik ohne Loop möglich) endet hart
    if (this.on) core.stopAll();
    this.on = true; this.A = A; this.L = L; this.P = P; this.J = J; this.step = v.pitchStep; this.fade = v.fade; this.cut = cut;
    const lenJ = this._len(J);
    this.W = A + J * P + lenJ;
    this.F1 = this._fadeOf(1); this.FJ = this._fadeOf(J);
    this.next = 1; this.capF = A + L + 3; this.held = false;
    this.events++;
    return 1;
  }

  /** Ausgangslänge der Wiederholung j: L / r_j, höchstens der Abstand P (der Rhythmus bleibt, tiefere Wiederholungen werden gekürzt), am Schnitt gekürzt. */
  _len(j) {
    const full = Math.max(1, Math.min(this.P, Math.round(this.L / stutterRate(j, this.step))));
    const st = this.A + j * this.P;
    return Math.max(1, Math.min(full, this.cut - st));
  }

  _fadeOf(j) {
    const len = this._len(j);
    return Math.min(len >> 1, Math.max(Math.round(STUTTER_MIN_FADE_S * this.sr), Math.round(this.fade * len)));
  }

  tick(core, t) {
    if (this.pendingStop) { this.pendingStop = false; core.stopAll(); }
    this.dryMul = 1;
    const tm = this.tm;
    if (!tm) return;
    const f = t - 1 + this.off;
    // Neuer Ursprung: Inhalt davor gilt als leer (kein Ereignis greift auf ein Segment vor validFrom zu), Köpfe und Haltepuffer leer.
    // Der Ring selbst wird nicht gelöscht: das gerade geschriebene Sample klingt sonst als Aussetzer im trockenen Signal.
    if (this.pendingReset) { this.pendingReset = false; this.validFrom = f; core.stopAll(); core.holdLen = 0; }
    if (!this.on && !this.done) {
      // Ereignis des Durchlaufs k (bei Loop: verpasste Durchläufe überspringen, höchstens wenige je Sample)
      for (let guard = 0; guard < 4 && !this.on && !this.done; guard++) {
        const r = this._try(core, this.k, f);
        if (r === 0) break;
        if (r < 0) { this.skipped++; if (tm.loop) this.k++; else this.done = true; }
      }
    }
    if (!this.on) return;
    const A = this.A;
    if (f === this.capF) this.held = core.hold(A - this.off, this.L);
    while (this.next <= this.J && f === A + this.next * this.P) {
      const j = this.next++, len = this._len(j), F = this._fadeOf(j);
      core.startHead({ at: A - this.off, length: len, rate: stutterRate(j, this.step), gain: 1, fadeIn: F, fadeOut: F, src: this.held ? 'hold' : 'ring' });
    }
    const D0 = A + this.L;
    if (f >= D0 && f < this.W) this.dryMul = 1 - core.s.w * tbFade(f - D0, this.W - D0, this.F1, this.FJ);
    if (f + 1 >= this.W) { this.on = false; if (tm.loop) this.k++; else this.done = true; }
  }
}
