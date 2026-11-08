/**
 * audio/dsp-lib/beat-repeat.js — Planer des Moduls `beatRepeat` (Phase 20c) für den Rechenkern audio/dsp-lib/timebuffer.js.
 * ----------------------------------------------------------------------------------------------------------------------------
 * Entscheidungen Nutzer (2026-11-06, Plan 20c, „a) wie bei Ableton, restliche Vorschläge übernehmen“):
 *   - Periodisches Raster über die ganze Quelle (Buffer Repeat = Beat Repeat, Masterliste #91/#97; ohne Tempo-Sync, AE-15, Zeiten in ms):
 *     Ereignis n eines Durchlaufs bei T_n = Durchlaufbeginn + offset + n · I, I = max(interval, length); `length` ist das Fenster (Datenschlüssel wie Stutter;
 *     „window“ ist in der dsp-lib als Bezeichner gesperrt, Wächter Suite 19).
 *   - Wie Ableton: das Fenster wird AB dem Ereignis nach vorn festgehalten ([T_n, T_n + length]); das Original klingt einmal trocken,
 *     danach folgen `count` Wiederholungen lückenlos (Wiederholung j bei T_n + j · L).
 *   - Gate ≤ Intervall: die Wiederholungen enden spätestens beim nächsten Raster-Ereignis (mit Flanke), dort klingt wieder das Original.
 *     ∞ = füllt bis zum nächsten Ereignis (bzw. bis zum Durchlaufende).
 *   - Wahrscheinlichkeit einmal je Ereignis (hashRand, unabhängig von der Vorgeschichte); Decay = Pegelabfall je Wiederholung:
 *     Wiederholung j klingt mit (1 − decay)^j. Mix wie Stutter: 100 % ersetzt das trockene Signal während der Wiederholungen.
 *   - Fade fest: je Wiederholung max(1 ms, 10 % der Länge), höchstens die halbe Länge. Keine Tonhöhe je Wiederholung (das ist Stutter).
 *
 * Ablauf eines Ereignisses (Zeiten in Samples, Context-Frames), wie Stutter mit Rate 100 %:
 *   T = Ereigniszeit, L = Fenster. Das Original T … T + L − 1 klingt trocken. Wiederholung j = 1 … J startet bei T + j·L, liest das Fenster
 *   ab T mit Rate 1 und Pegel (1 − decay)^j; Länge L, am Schnitt `cut` gekürzt.
 *   Schnitt: das nächste gültige Raster-Ereignis T + I; mit ∞ oder Loop zusätzlich das Durchlaufende. Ohne Loop, mit fester Anzahl und ohne
 *   weiteres Ereignis im Durchlauf dürfen die Wiederholungen über das Quellenende hinaus klingen (Nachklang, registry `tail`).
 *   J = count (∞: so viele, wie bis zum Schnitt passen), höchstens bis zum Schnitt. J < 1 (Intervall = Fenster) → keine Wiederholung.
 *   Trocken: von T + L bis zum Ende der letzten Wiederholung W abgesenkt auf 1 − mix · env, env = tbFade über diesen Bereich mit den
 *   Flanken der ersten und der letzten Wiederholung (komplementär, ohne Decay exakt konstante Summe).
 *   Ein Ereignis gilt, wenn das Fenster im Durchlauf liegt (T + L ≤ Durchlaufende); das erste Ereignis, das nicht mehr passt, beendet den
 *   Durchlauf (Loop: weiter mit dem nächsten Durchlauf, Ereignis 0).
 *   Ab der Kopie in den Haltepuffer (T + L + 3) lesen die Wiederholungen dort (bit-gleich zum Ring, altern nicht). Jedes Ereignis kopiert neu;
 *   die Köpfe des vorigen Ereignisses sind dann beendet (Schnitt ≤ T).
 *
 * Zeitbasis wie StutterSched (dsp-lib/stutter.js, bewusst nicht ausgelagert, damit stutter.js unverändert bleibt):
 * `arm({ originF, passStartF, passIndex, durF, loop, seed })` in Context-Frames, `block(frame, t)` je Prozessorblock, `hold()` = Durchgang.
 * Neuer Ursprung (Seek) = leerer Puffer (validFrom); Ereignisse, deren Fenster davor beginnt, lösen nicht aus. Verpasste Ereignisse
 * (Seek, verspätetes arm()) werden in einem Schritt übersprungen; ein Ereignis löst noch aus, solange f ≤ T + L.
 *
 * Regeln der dsp-lib: keine Allokation in tick(), keine DOM-/AudioContext-Zugriffe.
 */
import { clamp, finiteOr0 } from './util.js';
import { hashRand } from './prng.js';
import { tbFade } from './timebuffer.js';

export const BEATREPEAT_INTERVAL_RANGE = [50, 8000];   // ms
export const BEATREPEAT_OFFSET_RANGE = [0, 8000];      // ms
export const BEATREPEAT_WINDOW_RANGE = [5, 500];       // ms (wie Stutter-Länge: gleicher Haltepuffer)
export const BEATREPEAT_COUNT_RANGE = [1, 64];
export const BEATREPEAT_DECAY_RANGE = [0, 0.9];        // Pegelabfall je Wiederholung
/** Fester Fade je Wiederholung (Anteil der Länge) und Mindestflanke gegen Klicks [H, wie Stutter]. */
export const BEATREPEAT_FADE = 0.1;
export const BEATREPEAT_MIN_FADE_S = 0.001;
/** Haltepuffer: längstes Fenster plus Reserve. */
export const BEATREPEAT_HOLD_SECONDS = BEATREPEAT_WINDOW_RANGE[1] / 1000 + 0.01;
/** Sicherung für ∞ ohne endlichen Schnitt (kommt nicht vor: ohne Dauer gibt es immer ein nächstes Ereignis). */
export const BEATREPEAT_INF_CAP = 64;
export const BEATREPEAT_SALT_CHANCE = 0xBEA7;

const _fin = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * Werte für Worklet, Graph und Tests, geklemmt — eine Wahrheit (registry.js beatRepeatValues ruft diese Funktion).
 * interval/offset/length (Fenster) in ms, count ganzzahlig, infinite boolesch (Daten: 'on' | 'off'), chance, decay, mix.
 */
export function beatRepeatParams(q) {
  return {
    interval: clamp(_fin(q?.interval, 500), BEATREPEAT_INTERVAL_RANGE[0], BEATREPEAT_INTERVAL_RANGE[1]),
    offset: clamp(_fin(q?.offset, 0), BEATREPEAT_OFFSET_RANGE[0], BEATREPEAT_OFFSET_RANGE[1]),
    length: clamp(_fin(q?.length, 125), BEATREPEAT_WINDOW_RANGE[0], BEATREPEAT_WINDOW_RANGE[1]),
    count: Math.round(clamp(_fin(q?.count, 3), BEATREPEAT_COUNT_RANGE[0], BEATREPEAT_COUNT_RANGE[1])),
    infinite: q?.infinite === 'on',
    chance: clamp(_fin(q?.chance, 1), 0, 1),
    decay: clamp(_fin(q?.decay, 0), BEATREPEAT_DECAY_RANGE[0], BEATREPEAT_DECAY_RANGE[1]),
    mix: clamp(_fin(q?.mix, 1), 0, 1)
  };
}

/** Pegel der Wiederholung j (j ≥ 1). */
export const beatRepeatGain = (j, decay) => Math.pow(1 - decay, j);

/**
 * Größter Nachklang über das Quellenende hinaus (s), ohne Loop: Das letzte Fenster endet spätestens am Quellenende, danach folgen
 * höchstens `count` Wiederholungen der Länge `length`. Mit ∞ endet alles am Durchlaufende → 0.
 */
export function beatRepeatTailSeconds(q) {
  const v = beatRepeatParams(q);
  return v.infinite ? 0 : v.count * v.length / 1000;
}

/** Zufallswert des Ereignisses n im Durchlauf k (nur von seed, k, n abhängig). */
const _chanceRand = (seed, k, n) => hashRand((seed ^ Math.imul((k + 1) >>> 0, 0x27D4EB2F)) >>> 0, n, BEATREPEAT_SALT_CHANCE);

export class BeatRepeatSched {
  /** @param {number} sr Abtastrate */
  constructor(sr) {
    this.sr = sr;
    this.dryMul = 1;
    this.v = beatRepeatParams({});
    this.tm = null;          // Zeitbasis in Frames oder null (Durchgang)
    this.seed = 1;
    this.off = 0;            // Context-Frame des gerade geschriebenen Samples = t − 1 + off
    this.k = 0;              // laufender Durchlauf
    this.n = 0;              // nächstes zu prüfendes Ereignis im Durchlauf
    this.done = false;       // ohne Loop: Raster des Durchlaufs erledigt
    this.validFrom = -Infinity;
    this.pendingReset = false;
    this.pendingStop = false;
    // laufendes Ereignis (Zahlen statt Objekt: keine Allokation)
    this.on = false; this.A = 0; this.L = 0; this.J = 0; this.decay = 0;
    this.cut = Infinity; this.W = 0; this.F1 = 0; this.FJ = 0; this.next = 1; this.capF = 0; this.held = false;
    // Zähler (Tests/Diagnose)
    this.events = 0;         // ausgelöste Ereignisse (mit Wiederholungen)
    this.skipped = 0;        // verpasste/ungültige Ereignisse (Seek, nicht im Puffer, kein Platz für eine Wiederholung)
    this.chanceSkipped = 0;  // durch die Wahrscheinlichkeit ausgelassene Ereignisse
  }

  /** Neue Regler (wirken ab dem nächsten Ereignis; Mix läuft über den wet-Parameter des Worklets). */
  setParams(q) { this.v = beatRepeatParams(q); }

  /**
   * Zeitbasis setzen. Anderer Ursprung als bisher → Puffer leeren (beim nächsten tick), Ereignis abbrechen.
   * @param {{originF:number, passStartF:number, passIndex:number, durF:number, loop:boolean, seed?:number}} tm
   */
  arm(tm) {
    const prev = this.tm;
    this.tm = { originF: Math.round(finiteOr0(tm.originF)), passStartF: Math.round(finiteOr0(tm.passStartF)), passIndex: Math.max(0, Math.floor(finiteOr0(tm.passIndex))),
      durF: Math.max(0, Math.round(finiteOr0(tm.durF))), loop: !!tm.loop && tm.durF > 0 };
    if (Number.isFinite(tm.seed)) this.seed = tm.seed >>> 0;
    const fresh = () => { this.k = this.tm.passIndex; this.n = 0; this.done = false; };
    if (prev && prev.originF !== this.tm.originF) { this.pendingReset = true; this.on = false; fresh(); }
    else if (!prev) fresh();
    else if (this.tm.passIndex > this.k || (!this.tm.loop && this.tm.passIndex !== prev.passIndex)) fresh();   // Musik: neuer Durchlauf
  }

  /** Musik-Pause: Ereignis beenden, Köpfe stoppen (beim nächsten tick), Durchgang bis zum nächsten arm(). */
  hold() { this.tm = null; this.on = false; this.dryMul = 1; this.pendingStop = true; }

  /** Je Prozessorblock vor core.process(): Context-Frame des ersten Samples und Kernzeit vor dem Block. */
  block(frame, t) { this.off = frame - t; }

  _passStart(k) { const tm = this.tm; return tm.passStartF + (k - tm.passIndex) * tm.durF; }

  /**
   * Prüft das nächste Raster-Ereignis zum Frame f: 1 = gestartet, 0 = noch nicht fällig, −1 = weitergeschaltet (Ereignis entfällt
   * oder Durchlauf erledigt; der Aufrufer prüft im selben Sample erneut).
   */
  _try(core, f) {
    const tm = this.tm, sr = this.sr, v = this.v;
    const ps = this._passStart(this.k);
    const E = tm.durF > 0 ? ps + tm.durF : Infinity;
    const L = Math.max(8, Math.round(v.length * sr / 1000));
    const I = Math.max(L, Math.round(v.interval * sr / 1000));
    const T0 = ps + Math.round(v.offset * sr / 1000);
    const n = this.n, T = T0 + n * I;
    if (T + L > E) {                                                                   // Raster des Durchlaufs erschöpft
      if (tm.loop) { this.k++; this.n = 0; } else this.done = true;
      return -1;
    }
    if (f < T) return 0;
    if (f > T + L || T < this.validFrom || T - this.off < core.oldest + 1) {            // verpasst (Seek, spätes arm) oder nicht im Puffer
      this.skipped++;
      this.n = Math.max(n + 1, Math.ceil((f - L - T0) / I));
      return -1;
    }
    this.n = n + 1;
    if (!(_chanceRand(this.seed, this.k, n) < v.chance)) { this.chanceSkipped++; return -1; }
    const Tn = T + I;
    let cut = Tn + L <= E ? Tn : Infinity;                                             // Gate: bis zum nächsten gültigen Ereignis
    if ((v.infinite || tm.loop) && E < cut) cut = E;
    let J = v.infinite ? (Number.isFinite(cut) ? Math.floor((cut - 1 - T) / L) : BEATREPEAT_INF_CAP) : v.count;
    if (Number.isFinite(cut)) J = Math.min(J, Math.floor((cut - 1 - T) / L));
    if (!(J >= 1)) { this.skipped++; return -1; }
    if (this.on) core.stopAll();
    this.on = true; this.A = T; this.L = L; this.J = J; this.decay = v.decay; this.cut = cut;
    this.W = T + J * L + this._len(J);
    this.F1 = this._fadeOf(1); this.FJ = this._fadeOf(J);
    this.next = 1; this.capF = T + L + 3; this.held = false;
    this.events++;
    return 1;
  }

  /** Ausgangslänge der Wiederholung j: L, am Schnitt gekürzt. */
  _len(j) { return Math.max(1, Math.min(this.L, this.cut - (this.A + j * this.L))); }

  _fadeOf(j) {
    const len = this._len(j);
    return Math.min(len >> 1, Math.max(Math.round(BEATREPEAT_MIN_FADE_S * this.sr), Math.round(BEATREPEAT_FADE * len)));
  }

  tick(core, t) {
    if (this.pendingStop) { this.pendingStop = false; core.stopAll(); }
    this.dryMul = 1;
    const tm = this.tm;
    if (!tm) return;
    const f = t - 1 + this.off;
    if (this.pendingReset) { this.pendingReset = false; this.validFrom = f; core.stopAll(); core.holdLen = 0; }
    if (!this.on && !this.done) {
      for (let guard = 0; guard < 6 && !this.on && !this.done; guard++) if (this._try(core, f) >= 0) break;
    }
    if (!this.on) return;
    const A = this.A, L = this.L;
    if (f === this.capF) this.held = core.hold(A - this.off, L);
    while (this.next <= this.J && f === A + this.next * L) {
      const j = this.next++, len = this._len(j), F = this._fadeOf(j);
      core.startHead({ at: A - this.off, length: len, rate: 1, gain: beatRepeatGain(j, this.decay), fadeIn: F, fadeOut: F, src: this.held ? 'hold' : 'ring' });
    }
    const D0 = A + L;
    if (f >= D0 && f < this.W) this.dryMul = 1 - core.s.w * tbFade(f - D0, this.W - D0, this.F1, this.FJ);
    if (f + 1 >= this.W) this.on = false;
  }
}
