/**
 * audio/engine/voices.js — VoiceManager (AE-16, Phase 3a): zentrale Verwaltung ALLER gleichzeitigen Quellen und ihrer Kosten.
 * ----------------------------------------------------------------------------------------------------------------------
 * REIN (kein AudioContext, keine DOM-Zugriffe): Uhr und Rückrufe werden injiziert, damit die Logik in Node testbar ist.
 *
 * Ablauf einer Anmeldung `requestVoice({ kind, id, loop, costFor, fadeOut })`:
 *   1. Passt die Voice mit ihren Kosten ins Budget (= Kapazität × Budgetfaktor), wird sie unverändert gewährt.
 *   2. Sonst Degradationsstufen in fester Reihenfolge (AE-16): HRTF → Equal-Power, Oversampling 4× → 2× → 1×, IR kürzen.
 *      (Teilen des Halls, Stufe 0, ist bereits Sache der Pipeline: Phase 3b.) Die erste Stufe, bei der die Voice passt, gilt;
 *      der Aufrufer wendet `degrade` beim Graph-Aufbau an. Laufende Voices werden NICHT nachträglich verändert.
 *   3. Passt sie auch dann nicht: älteste SOUND-Voice klickfrei ausblenden (`fadeOut(80 ms)`), danach erneut ab Schritt 1.
 *   4. Gibt es nichts mehr zu entfernen, wird die Voice trotzdem gewährt (`overBudget: true`, tiefste Stufe) — ein Soundboard
 *      verweigert keinen Tastendruck.
 * Schutzregeln: Musik, Ambient, Rauschen und Vorschau werden gezählt, aber NIE entfernt. Geloopte Sounds werden zuletzt entfernt.
 * Eine Voice jünger als MIN_AGE_MS wird nicht entfernt (kein Flattern).
 *
 * Modi: 'auto' (Budget + Degradation + Entzug) | 'count' (feste Höchstzahl gleichzeitiger Sounds, nur Entzug) | 'off' (nur zählen).
 */
import { sumCosts } from './cost.js';

/** Kapazität vor der ersten Kalibrierung (Punkte, vorsichtig; Chrome 155 liegt nach M-1/E4 bei ≈ 2 300 [H]). */
export const DEFAULT_CAPACITY = 1500;
export const MIN_CAPACITY = 100;
export const BUDGET_FACTOR = 0.5;
export const MIN_AGE_MS = 300;
export const FADE_MS = 80;
/** Degradationsstufen (kumulativ), Reihenfolge laut AE-16. */
export const DEGRADE_LEVELS = Object.freeze([
  Object.freeze({ equalPower: true }),
  Object.freeze({ equalPower: true, oversample: '2x' }),
  Object.freeze({ equalPower: true, oversample: 'none' }),
  Object.freeze({ equalPower: true, oversample: 'none', irMax: 1.5 }),
  Object.freeze({ equalPower: true, oversample: 'none', irMax: 0.6 })
]);
const PROTECTED_KINDS = new Set(['ambient', 'music', 'noise', 'preview']);

export class VoiceManager {
  /** @param {object} [o] { now, capacity, budgetFactor, mode, maxVoices, onEvent } */
  constructor(o = {}) {
    this.now = o.now || (() => Date.now());
    this.capacity = Math.max(MIN_CAPACITY, o.capacity ?? DEFAULT_CAPACITY);
    this.budgetFactor = o.budgetFactor ?? BUDGET_FACTOR;
    this.mode = o.mode || 'auto';
    this.maxVoices = Math.max(1, o.maxVoices ?? 16);
    this.onEvent = o.onEvent || (() => {});
    this.voices = new Map();
    this._seq = 0;
    this._noticed = false;
    this.stats = { granted: 0, degraded: 0, evicted: 0, overBudget: 0, overloads: 0 };
  }

  get budget() { return this.capacity * this.budgetFactor; }
  used() { return sumCosts([...this.voices.values()].map(v => v.cost)).points; }
  count(kind) { let n = 0; for (const v of this.voices.values()) if (!kind || v.kind === kind) n++; return n; }

  setCapacity(points) { if (Number.isFinite(points) && points > 0) this.capacity = Math.max(MIN_CAPACITY, points); }
  setMode(mode, maxVoices) { if (['auto', 'count', 'off'].includes(mode)) this.mode = mode; if (Number.isFinite(maxVoices)) this.maxVoices = Math.max(1, Math.floor(maxVoices)); }

  /** Entfernbare Voices: nur Sounds, alt genug; Nicht-Loops vor Loops, jeweils älteste zuerst. */
  _evictable() {
    const t = this.now();
    const c = [...this.voices.values()].filter(v => !PROTECTED_KINDS.has(v.kind) && t - v.startedAt >= MIN_AGE_MS);
    return c.sort((a, b) => (a.loop - b.loop) || (a.startedAt - b.startedAt));
  }

  _evict(v, reason) {
    this.voices.delete(v.voiceId);
    v.released = true;
    this.stats.evicted++;
    try { v.fadeOut?.(FADE_MS); } catch (e) { /* Fehler im Aufrufer darf die Verwaltung nicht stören */ }
    const first = !this._noticed; this._noticed = true;
    this.onEvent({ type: 'evicted', reason, kind: v.kind, id: v.id, first });
  }

  _total(extra) { return sumCosts([...[...this.voices.values()].map(v => v.cost), extra]).points; }

  /** Erste Stufe (inkl. „keine“), bei der die Voice ins Budget passt: { degrade, cost } | null. */
  _fit(req) {
    let cost = req.costFor(null);
    if (this._total(cost) <= this.budget) return { degrade: null, cost };
    if (req.noDegrade) return null;     // Musik/Ambient: nie vereinfacht (Plan und Live-Update bleiben unberührt)
    for (const level of DEGRADE_LEVELS) {
      cost = req.costFor(level);
      if (this._total(cost) <= this.budget) return { degrade: level, cost };
    }
    return null;
  }

  /**
   * @param {object} req { kind:'sound'|'ambient'|'music'|'noise'|'preview', id, loop, costFor(degrade|null) → planCost-Ergebnis, fadeOut(ms), noDegrade? (nur zählen, nie vereinfachen) }
   * @returns {{granted:true, voiceId:number, degrade:object|null, evicted:number, overBudget:boolean, release:()=>void}}
   */
  requestVoice(req) {
    const kind = req.kind || 'sound';
    let degrade = null, cost, evicted = 0, overBudget = false;
    if (this.mode === 'off') {
      cost = req.costFor(null);
    } else if (this.mode === 'count') {
      cost = req.costFor(null);
      if (!PROTECTED_KINDS.has(kind)) {
        while (this.count('sound') >= this.maxVoices) {
          const cand = this._evictable().find(v => v.kind === 'sound');
          if (!cand) break;
          this._evict(cand, 'count'); evicted++;
        }
      }
    } else {
      let fit = this._fit(req);
      while (!fit) {
        const cand = this._evictable()[0];
        if (!cand) break;
        this._evict(cand, 'budget'); evicted++;
        fit = this._fit(req);
      }
      if (fit) { degrade = fit.degrade; cost = fit.cost; }
      else { degrade = req.noDegrade ? null : DEGRADE_LEVELS[DEGRADE_LEVELS.length - 1]; cost = req.costFor(degrade); overBudget = true; this.stats.overBudget++; }
    }
    if (degrade) this.stats.degraded++;
    const voiceId = ++this._seq;
    const v = { voiceId, kind, id: req.id ?? null, loop: req.loop ? 1 : 0, cost, startedAt: this.now(), fadeOut: req.fadeOut, degrade, released: false };
    this.voices.set(voiceId, v);
    this.stats.granted++;
    return { granted: true, voiceId, degrade, evicted, overBudget, release: () => { if (!v.released) { v.released = true; this.voices.delete(voiceId); } } };
  }

  /** Überlast gemeldet (Wächter): Kapazität × 0,8 und eine Sound-Voice entfernen. */
  reportOverload(info = {}) {
    this.stats.overloads++;
    this.capacity = Math.max(MIN_CAPACITY, this.capacity * 0.8);
    const cand = this._evictable()[0];
    if (cand) this._evict(cand, 'overload');
    this.onEvent({ type: 'overload', capacity: this.capacity, ...info });
  }

  getState() {
    return {
      mode: this.mode, capacity: Math.round(this.capacity), budget: Math.round(this.budget), used: Math.round(this.used() * 10) / 10,
      voices: [...this.voices.values()].map(v => ({ id: v.id, kind: v.kind, loop: !!v.loop, points: Math.round(v.cost.points * 10) / 10, hub: v.cost.hub?.irKey || null, degraded: !!v.degrade })),
      stats: { ...this.stats }
    };
  }
}

/**
 * Staffelung schwerer Graph-Aufbauten (Firefox: 16 Pitch-Worklets blockieren den Haupt-Thread ≈ 1 s [S, E6]; Chrome: Faltungsaufbau
 * 13–46 ms je Voice im Haupt-Thread [S, M-1]). Je Frame laufen höchstens `threshold` Aufbauten sofort; weitere warten und werden
 * mit höchstens `perFrame` je Frame abgearbeitet. `raf` wird injiziert (Node: Zeitgeber).
 */
export function createStagger({ threshold = 4, perFrame = 2, raf = cb => setTimeout(cb, 16) } = {}) {
  let ran = 0, scheduled = false;
  const queue = [];
  const tick = () => {
    scheduled = false; ran = 0;
    let n = 0;
    while (queue.length && n < perFrame) { const job = queue.shift(); n++; ran++; job(); }
    if (queue.length) { scheduled = true; raf(tick); }
  };
  const arm = () => { if (!scheduled) { scheduled = true; raf(tick); } };
  return {
    /** Führt `fn` sofort oder im nächsten freien Frame aus; liefert ein Promise mit dem Ergebnis. */
    run(fn) {
      return new Promise((resolve, reject) => {
        const job = () => { try { resolve(fn()); } catch (e) { reject(e); } };
        if (ran < threshold && queue.length === 0) { ran++; arm(); job(); }
        else { queue.push(job); arm(); }
      });
    },
    pending: () => queue.length
  };
}
