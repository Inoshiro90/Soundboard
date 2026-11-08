/**
 * audio/dsp-lib/retrigger.js — Planer des Moduls `retrigger` (Phase 20d) für den Rechenkern audio/dsp-lib/timebuffer.js.
 * ----------------------------------------------------------------------------------------------------------------------------
 * Masterliste #92: Retrigger, onset-gesteuert über eine integrierte Erkennung (Plan P20). Entscheidungen Nutzer (2026-11-06, Plan 20d,
 * „A = a, B = als Regler, C = so in Ordnung“):
 *   - Ein erkannter Anschlag (Onset) im trockenen Eingang löst ein Ereignis aus: das Fenster (`length`) ab dem Onset wird nach vorn
 *     festgehalten und `count`-mal lückenlos wiederholt (wie Beat Repeat: Rate 1, Pegel (1 − decay)^j, Fade fest, Mix wie Stutter).
 *   - Kein Lookahead: die Erkennung ist kausal und kommt wenige Samples nach dem Anschlag. Das Fenster beginnt deshalb `preroll` ms VOR dem
 *     Erkennungszeitpunkt (Regler, höchstens die halbe Fensterlänge) und wird aus dem Ring gelesen. Das Original klingt trocken; die
 *     Wiederholungen beginnen erst am Fensterende — es entsteht keine Latenz.
 *   - Ein neuer Onset nach Ablauf der Totzeit (`holdoff`, ab dem letzten angenommenen Onset) schneidet laufende Wiederholungen ab
 *     (Ausblendflanke über TimeBuffer.releaseHead, trockenes Signal komplementär zurück) und startet ein neues Ereignis.
 *     ∞ = Wiederholungen bis zum nächsten Onset (bzw. bis zum Durchlaufende).
 *   - Wahrscheinlichkeit je angenommenem Onset: hashRand(seed, Durchlauf, Onset-Index im Durchlauf). Ein durch die Wahrscheinlichkeit
 *     ausgelassener Onset schneidet nichts ab, startet aber die Totzeit (die Totzeit hängt nur vom Signal ab, nicht vom Zufall).
 *
 * Erkennung (OnsetDetector, Muster Transient Shaper in dynamics.js, bewusst kopiert, damit dynamics.js unverändert bleibt):
 *   Spitzenwert über die Kanäle mit 10 ms Halten → schnelle Hüllkurve (Attack 0,3 ms, Release 8 ms) und langsame Hüllkurve (Attack 25 ms,
 *   Release 50 ms [H]). Onset, wenn ef ≥ es · 10^(s/20) und ef ≥ Schwelle (linear); s = 12 · (1 − 0,8 · sensitivity) dB (2,4 … 12 dB,
 *   wie der Transient Shaper). Hysterese: erneut scharf erst, wenn ef < es · 10^(s/40) (halber Abstand in dB).
 *   Der Detektor liest das gerade geschriebene Eingangssample aus dem Ring (core.bufs bei core.w − 1); er hört nur das trockene Signal.
 *
 * Ablauf eines Ereignisses (Zeiten in Samples, Context-Frames):
 *   f = Erkennung, P = min(preroll, L/2), A = max(f − P, Durchlaufbeginn, Puffer gültig ab). Wiederholung j = 1 … J startet bei A + j·L,
 *   liest das Fenster ab A. Schnitt `cut`: mit ∞ oder Loop das Durchlaufende, sonst offen (Nachklang über das Quellenende, registry `tail`).
 *   J = count (∞: so viele, wie bis zum Schnitt passen; ohne bekannte Dauer RETRIGGER_INF_CAP). Ein Fenster, das über das Durchlaufende
 *   reicht oder nicht mehr im Ring liegt, löst nicht aus (`skipped`). Trocken von A + L bis W (Ende der letzten Wiederholung) abgesenkt
 *   auf 1 − mix · env wie bei Beat Repeat. Ein neuer Onset während des Ereignisses blendet den laufenden Kopf über die Flanke des neuen
 *   Ereignisses aus (max(1 ms, 10 % des Fensters), ≤ L/2); das trockene Signal kehrt über dieselbe Zeit zurück, ausgehend vom aktuellen
 *   Absenkungswert (stetig). Weil P ≤ L/2 und Flanke ≤ L/2, beginnt die Absenkung des neuen Ereignisses erst nach dieser Rückkehr.
 *
 * Zeitbasis wie BeatRepeatSched/StutterSched: `arm({ originF, passStartF, passIndex, durF, loop, seed })`, `block(frame, t)`, `hold()`.
 * Neuer Ursprung (Seek) = leerer Puffer und frischer Detektor; Fenster vor dem neuen Ursprung lösen nicht aus.
 * Der Detektor läuft immer mit, auch ohne Zeitbasis (vor dem ersten arm(), in der Musik-Pause): so erzeugt ein verspätetes arm() (Port-
 * Nachricht kommt im Worklet nach den ersten Blöcken an) keinen Fehlauslöser auf dem laufenden Signal. Ein Onset ohne Zeitbasis wird
 * vorgemerkt und beim nächsten Sample mit Zeitbasis nachgeholt, solange seine erste Wiederholung (A + L) noch in der Zukunft liegt;
 * sonst entfällt er (`skipped`) — Export = Live, auch wenn arm() einige Blöcke zu spät kommt.
 *
 * Regeln der dsp-lib: keine Allokation in tick(), keine DOM-/AudioContext-Zugriffe.
 */
import { clamp, finiteOr0, DENORMAL_FLOOR } from './util.js';
import { hashRand } from './prng.js';
import { tbFade } from './timebuffer.js';

export const RETRIGGER_SENS_RANGE = [0, 1];
export const RETRIGGER_THRESHOLD_RANGE = [-60, 0];     // dB (Pegeluntergrenze der schnellen Hüllkurve)
export const RETRIGGER_HOLDOFF_RANGE = [10, 2000];     // ms (Totzeit)
export const RETRIGGER_PREROLL_RANGE = [0, 20];        // ms (Vorlauf vor der Erkennung)
export const RETRIGGER_WINDOW_RANGE = [5, 500];        // ms (wie Stutter/Beat Repeat: gleicher Haltepuffer)
export const RETRIGGER_COUNT_RANGE = [1, 64];
export const RETRIGGER_DECAY_RANGE = [0, 0.9];
export const RETRIGGER_FADE = 0.1;
export const RETRIGGER_MIN_FADE_S = 0.001;
export const RETRIGGER_HOLD_SECONDS = RETRIGGER_WINDOW_RANGE[1] / 1000 + 0.01;
/** ∞ ohne bekannte Dauer: höchstens so viele Wiederholungen (ein neuer Onset schneidet ohnehin ab). */
export const RETRIGGER_INF_CAP = 64;
export const RETRIGGER_SALT_CHANCE = 0x2E76;

// Detektor (Zeiten in s): wie Transient Shaper (dynamics.js), langsame Release fest [H]
const OD_FAST_ATTACK_S = 0.0003, OD_FAST_RELEASE_S = 0.008, OD_SLOW_ATTACK_S = 0.025, OD_SLOW_RELEASE_S = 0.05, OD_HOLD_S = 0.01;
const OD_EPS = 1e-9;

const _fin = (v, d) => (Number.isFinite(v) ? v : d);

/** Werte für Worklet, Graph und Tests, geklemmt — eine Wahrheit (registry.js retriggerValues ruft diese Funktion). */
export function retriggerParams(q) {
  return {
    sensitivity: clamp(_fin(q?.sensitivity, 0.5), RETRIGGER_SENS_RANGE[0], RETRIGGER_SENS_RANGE[1]),
    threshold: clamp(_fin(q?.threshold, -40), RETRIGGER_THRESHOLD_RANGE[0], RETRIGGER_THRESHOLD_RANGE[1]),
    holdoff: clamp(_fin(q?.holdoff, 100), RETRIGGER_HOLDOFF_RANGE[0], RETRIGGER_HOLDOFF_RANGE[1]),
    preroll: clamp(_fin(q?.preroll, 3), RETRIGGER_PREROLL_RANGE[0], RETRIGGER_PREROLL_RANGE[1]),
    length: clamp(_fin(q?.length, 125), RETRIGGER_WINDOW_RANGE[0], RETRIGGER_WINDOW_RANGE[1]),
    count: Math.round(clamp(_fin(q?.count, 3), RETRIGGER_COUNT_RANGE[0], RETRIGGER_COUNT_RANGE[1])),
    infinite: q?.infinite === 'on',
    chance: clamp(_fin(q?.chance, 1), 0, 1),
    decay: clamp(_fin(q?.decay, 0), RETRIGGER_DECAY_RANGE[0], RETRIGGER_DECAY_RANGE[1]),
    mix: clamp(_fin(q?.mix, 1), 0, 1)
  };
}

/** Pegel der Wiederholung j (j ≥ 1). */
export const retriggerGain = (j, decay) => Math.pow(1 - decay, j);

/** Erkennungsabstand in dB zur Empfindlichkeit 0 … 1 (wie Transient Shaper). */
export const retriggerSensDb = s => 12 * (1 - 0.8 * clamp(_fin(s, 0.5), 0, 1));

/**
 * Größter Nachklang über das Quellenende hinaus (s), ohne Loop: das letzte Fenster endet spätestens am Quellenende, danach höchstens
 * `count` Wiederholungen. Mit ∞ endet alles am Durchlaufende → 0.
 */
export function retriggerTailSeconds(q) {
  const v = retriggerParams(q);
  return v.infinite ? 0 : v.count * v.length / 1000;
}

const _chanceRand = (seed, k, n) => hashRand((seed ^ Math.imul((k + 1) >>> 0, 0x27D4EB2F)) >>> 0, n, RETRIGGER_SALT_CHANCE);

/** Onset-Erkennung je Sample (rein, ohne Allokation). */
export class OnsetDetector {
  constructor(sr) {
    const c = t => 1 - Math.exp(-1 / (sr * t));
    this.aF = c(OD_FAST_ATTACK_S); this.rF = c(OD_FAST_RELEASE_S); this.aS = c(OD_SLOW_ATTACK_S); this.rS = c(OD_SLOW_RELEASE_S);
    this.holdN = Math.max(1, Math.round(sr * OD_HOLD_S));
    this.reset();
  }

  reset() { this.ef = 0; this.es = 0; this.hp = 0; this.hc = 0; this.armed = true; }

  /**
   * @param {number} pk Spitzenwert des Samples über die Kanäle (≥ 0)
   * @param {number} ratio 10^(s/20)   @param {number} rearm 10^(s/40)   @param {number} floor Schwelle linear
   * @returns {boolean} true im Sample der Erkennung
   */
  step(pk, ratio, rearm, floor) {
    let hp = this.hp, hc = this.hc, ef = this.ef, es = this.es;
    if (pk >= hp) { hp = pk; hc = this.holdN; } else if (hc > 0) hc--; else hp = pk;
    ef += (hp > ef ? this.aF : this.rF) * (hp - ef);
    es += (hp > es ? this.aS : this.rS) * (hp - es);
    if (ef < DENORMAL_FLOOR) ef = 0;
    if (es < DENORMAL_FLOOR) es = 0;
    if (hp < DENORMAL_FLOOR) hp = 0;
    this.hp = hp; this.hc = hc; this.ef = ef; this.es = es;
    if (this.armed) {
      if (ef >= floor && ef + OD_EPS >= (es + OD_EPS) * ratio) { this.armed = false; return true; }
    } else if (ef + OD_EPS < (es + OD_EPS) * rearm) this.armed = true;
    return false;
  }
}

export class RetriggerSched {
  /** @param {number} sr Abtastrate */
  constructor(sr) {
    this.sr = sr;
    this.dryMul = 1;
    this.det = new OnsetDetector(sr);
    this.tm = null;
    this.seed = 1;
    this.off = 0;
    this.k = -1;             // Durchlauf des letzten angenommenen Onsets
    this.n = 0;              // nächster Onset-Index im Durchlauf
    this.lastOnF = -Infinity;
    this.validFrom = -Infinity;
    this.pendingReset = false;
    this.pendingStop = false;
    // laufendes Ereignis
    this.on = false; this.A = 0; this.L = 0; this.J = 0; this.decay = 0;
    this.cut = Infinity; this.W = 0; this.F1 = 0; this.FJ = 0; this.next = 1; this.capF = 0; this.held = false; this.h = -1;
    // Rückkehr des trockenen Signals nach einem Schnitt
    this.rel = false; this.relF = 0; this.relR = 1; this.relE = 0;
    // Zähler (Tests/Diagnose)
    this.onsets = 0;         // erkannte Onsets (vor Totzeit)
    this.holdoffSkipped = 0; // in der Totzeit verworfen
    this.chanceSkipped = 0;  // durch die Wahrscheinlichkeit ausgelassen
    this.skipped = 0;        // kein Platz (Durchlaufende, Puffer, keine Wiederholung)
    this.events = 0;         // gestartete Ereignisse
    this.released = 0;       // laufende Ereignisse, die ein neuer Onset geschnitten hat
    this.lastDetectF = NaN;  // Frame der letzten Erkennung (Tests)
    this.pend = NaN;         // Onset ohne Zeitbasis (vorgemerkt bis zum nächsten arm())
    this.setParams({});
  }

  /** Neue Regler: Erkennung sofort, die übrigen ab dem nächsten Ereignis (Mix über den wet-Parameter des Worklets). */
  setParams(q) {
    const v = this.v = retriggerParams(q);
    const s = retriggerSensDb(v.sensitivity);
    this.ratio = Math.pow(10, s / 20); this.rearm = Math.pow(10, s / 40); this.floor = Math.pow(10, v.threshold / 20);
    this.holdoffF = Math.round(v.holdoff * this.sr / 1000);
  }

  arm(tm) {
    const prev = this.tm;
    this.tm = { originF: Math.round(finiteOr0(tm.originF)), passStartF: Math.round(finiteOr0(tm.passStartF)), passIndex: Math.max(0, Math.floor(finiteOr0(tm.passIndex))),
      durF: Math.max(0, Math.round(finiteOr0(tm.durF))), loop: !!tm.loop && tm.durF > 0 };
    if (Number.isFinite(tm.seed)) this.seed = tm.seed >>> 0;
    if (prev && prev.originF !== this.tm.originF) { this.pendingReset = true; this.on = false; this.rel = false; this.k = -1; this.n = 0; this.lastOnF = -Infinity; this.pend = NaN; }
  }

  hold() { this.tm = null; this.on = false; this.rel = false; this.dryMul = 1; this.pendingStop = true; }

  block(frame, t) { this.off = frame - t; }

  _passOf(f) {
    const tm = this.tm;
    if (!tm.loop) return tm.passIndex;
    return Math.max(0, tm.passIndex + Math.floor((f - tm.passStartF) / tm.durF));
  }

  _passStart(k) { const tm = this.tm; return tm.passStartF + (k - tm.passIndex) * tm.durF; }

  _len(j) { return Math.max(1, Math.min(this.L, this.cut - (this.A + j * this.L))); }

  _fadeOf(j) {
    const len = this._len(j);
    return Math.min(len >> 1, Math.max(Math.round(RETRIGGER_MIN_FADE_S * this.sr), Math.round(RETRIGGER_FADE * len)));
  }

  /** Absenkungswert des laufenden Ereignisses beim Frame f (0 … 1). */
  _env(f) {
    const D0 = this.A + this.L;
    return this.on && f >= D0 && f < this.W ? tbFade(f - D0, this.W - D0, this.F1, this.FJ) : 0;
  }

  _relEnv(f) {
    const i = f - this.relF;
    return this.rel && i >= 0 && i < this.relR ? this.relE * tbFade(i, this.relR, 0, this.relR) : 0;
  }

  /** Erkannter Onset beim Frame f, behandelt beim Frame `now` (≥ f; > f nur für einen vorgemerkten Onset). */
  _onset(core, f, now = f) {
    if (f - this.lastOnF < this.holdoffF) { this.holdoffSkipped++; return; }
    this.lastOnF = f;
    const tm = this.tm, v = this.v, sr = this.sr;
    const k = this._passOf(f);
    if (k !== this.k) { this.k = k; this.n = 0; }
    const n = this.n++;
    if (!(_chanceRand(this.seed, k, n) < v.chance)) { this.chanceSkipped++; return; }
    const ps = this._passStart(k), E = tm.durF > 0 ? ps + tm.durF : Infinity;
    const L = Math.max(8, Math.round(v.length * sr / 1000));
    const P = Math.min(Math.round(v.preroll * sr / 1000), L >> 1);
    const A = Math.max(f - P, ps, this.validFrom);
    if (A + L > E || A + L <= now || A - this.off < core.oldest + 1) { this.skipped++; return; }
    const cut = v.infinite || tm.loop ? E : Infinity;
    let J = v.infinite ? (Number.isFinite(cut) ? Math.floor((cut - 1 - A) / L) : RETRIGGER_INF_CAP) : v.count;
    if (Number.isFinite(cut)) J = Math.min(J, Math.floor((cut - 1 - A) / L));
    if (!(J >= 1)) { this.skipped++; return; }
    // Neues Ereignis: Flanke aus dem neuen Fenster (≤ L/2)
    const R = Math.min(L >> 1, Math.max(Math.round(RETRIGGER_MIN_FADE_S * sr), Math.round(RETRIGGER_FADE * L)));
    if (this.on) {
      const e0 = Math.max(this._env(now), this._relEnv(now));
      let rem = R;
      if (this.h >= 0) { const r = core.releaseHead(this.h, R); if (r > 0) rem = r; }
      this.rel = e0 > 0; this.relF = now; this.relR = Math.max(1, rem); this.relE = e0;
      if (e0 > 0 || this.h >= 0) this.released++;
    }
    this.on = true; this.A = A; this.L = L; this.J = J; this.decay = v.decay; this.cut = cut;
    this.W = A + J * L + this._len(J);
    this.F1 = this._fadeOf(1); this.FJ = this._fadeOf(J);
    this.next = 1; this.capF = A + L + 3; this.held = false; this.h = -1;
    this.events++;
  }

  tick(core, t) {
    if (this.pendingStop) { this.pendingStop = false; core.stopAll(); this.h = -1; }
    this.dryMul = 1;
    const f = t - 1 + this.off;
    if (this.tm && this.pendingReset) { this.pendingReset = false; this.validFrom = f; core.stopAll(); core.holdLen = 0; this.det.reset(); this.h = -1; }
    // Erkennung auf dem gerade geschriebenen Eingangssample (immer, auch ohne Zeitbasis)
    const bufs = core.bufs, wr = core.w === 0 ? core.frames - 1 : core.w - 1;
    let pk = 0;
    for (let c = 0; c < bufs.length; c++) { const x = bufs[c][wr]; const a = x < 0 ? -x : x; if (a > pk) pk = a; }
    const hit = this.det.step(pk, this.ratio, this.rearm, this.floor);
    if (hit) { this.onsets++; this.lastDetectF = f; }
    if (!this.tm) { if (hit) this.pend = f; return; }
    if (this.pend === this.pend) { const p = this.pend; this.pend = NaN; this._onset(core, p, f); }   // vorgemerkter Onset (NaN ≠ NaN)
    if (hit) this._onset(core, f);
    if (this.on) {
      const A = this.A, L = this.L;
      if (f === this.capF) this.held = core.hold(A - this.off, L);
      while (this.next <= this.J && f === A + this.next * L) {
        const j = this.next++, len = this._len(j), F = this._fadeOf(j);
        this.h = core.startHead({ at: A - this.off, length: len, rate: 1, gain: retriggerGain(j, this.decay), fadeIn: F, fadeOut: F, src: this.held ? 'hold' : 'ring' });
      }
    }
    const e = Math.max(this._env(f), this._relEnv(f));
    if (e > 0) this.dryMul = 1 - core.s.w * e;
    if (this.on && f + 1 >= this.W) { this.on = false; this.h = -1; }
    if (this.rel && f + 1 >= this.relF + this.relR) this.rel = false;
  }
}
