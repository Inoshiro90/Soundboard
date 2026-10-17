/**
 * audio/engine/runtime.js — PipelineRuntime (Phase 3, AE-04′)
 *
 * Eine Runtime besitzt EINE gebaute Vier-Stufen-Pipeline (Quelle → Medium → Umgebung → Hörer) und macht sie lebendig:
 *   update(plan)        Parameteränderung live (setTargetAtTime). Ändert sich die STRUKTUR (Layer, aktive Module, Pitch an/aus)
 *                       oder ein nicht glättbarer Wert (IR, Verzerrungskurve, LFO-Form), wird neu gebaut und überblendet.
 *   swapTo(plan)        Neue Pipeline daneben bauen und per Equal-Power-Kreuzblende (Standard 40 ms) umschalten.
 *   setModuleBypass     Modul klickfrei an/aus (nur bei `bypassable: true`).
 *   setPipelineBypass   Ganze Pipeline klickfrei auf den trockenen Pfad (A/B; nur im Live-Modus).
 *   tailSeconds()/cost()/dispose()
 *
 * Betriebsarten
 *   live:false (Standard, Fassade `buildPipelineGraph`): keine Zusatzknoten; input/output sind die Endknoten der Pipeline
 *     (null bei leerer Pipeline) — das Klangbild ist bit-gleich zum Stand vor Phase 3. update() wirkt auf Parameter; ist ein
 *     Neubau nötig, meldet es 'rebuild' und der Aufrufer entscheidet (z. B. neu starten).
 *   live:true: Ein- und Ausgangs-Gain (Einheitsgain) halten die Verbindung zum Aufrufer dauerhaft; swapTo()/update() mit
 *     Strukturänderung blenden über. Der Aufrufer verbindet `input`/`output` einmal und lässt sie stehen.
 *
 * INVARIANTE (fx-pipeline.js): Layer-Reihenfolge = Benutzerreihenfolge. Die Runtime baut immer genau die Schritte des Plans
 * in dessen Reihenfolge (assertOrder); sie fasst nichts zusammen, ordnet nichts um, überspringt nichts.
 * Dieses Modul importiert fx-pipeline.js NICHT (Zirkel): Aufrufer übergeben einen aufgelösten Plan (resolvePlan).
 */

import { buildPitchNode, buildLayerChain, buildTerminalPanner } from '../effect-graph.js';
import { ensureWorklets } from '../context.js';
import { workletsForPlan } from './worklets.js';
import { effectiveActiveKeys } from './schema.js';
import { moduleTail, moduleCost } from './registry.js';

/** Vorgabewerte der Überblendung. */
export const XFADE_SECONDS = 0.04;           // Addendum A: 30–50 ms
const FADE_POINTS = 32;
const _up   = new Float32Array(FADE_POINTS), _down = new Float32Array(FADE_POINTS);
for (let i = 0; i < FADE_POINTS; i++) { const a = (i / (FADE_POINTS - 1)) * Math.PI / 2; _up[i] = Math.sin(a); _down[i] = Math.cos(a); }


/** Kreuzblenden-Kurve planen. Überlappt sie mit einer noch laufenden Kurve (Audio-Uhr hinkt hinterher), wird hart auf den Endwert gesetzt statt zu werfen. */
function _ramp(param, curve, t0, d, endValue) {
  try { param.setValueCurveAtTime(curve, t0, d); }
  catch (e) { param.cancelScheduledValues(t0); param.setValueAtTime(endValue, t0); }
}

/** Wartet, bis die AUDIO-Uhr `t` erreicht hat (die Kreuzblende läuft auf der Audio-Uhr, nicht auf der Wanduhr). Rückfall: Wanduhr-Limit (z. B. suspendierter/Offline-Context). */
function _waitAudioTime(ctx, t, isDisposed, maxMs) {
  return new Promise(res => {
    const t0 = Date.now();
    const tick = () => {
      if (isDisposed() || ctx.currentTime >= t || Date.now() - t0 > maxMs) res();
      else setTimeout(tick, 15);
    };
    tick();
  });
}

const _pitchActive = ps => !!(ps && ps.enabled && ps.semitones);

/** Strukturunterschrift eines Plans: gleiche Unterschrift ⇒ gleiche Knotentopologie, nur Parameter dürfen abweichen. */
export function planSignature(plan) {
  return JSON.stringify({
    p: !!plan.needsPanner,
    s: plan.steps.map(s => [s.layerId, _pitchActive(s.params.pitchShift) ? 1 : 0, effectiveActiveKeys(s.params).filter(k => k !== 'pitchShift').sort()])
  });
}

/** Prüft, dass die gebauten Schritte exakt die Schritte des Plans in Planreihenfolge sind (Invariante). */
export function assertOrder(plan, builtSteps) {
  const a = plan.steps.map(s => s.layerId).join('|'), b = builtSteps.map(s => s.layerId).join('|');
  if (a !== b) throw new Error('PipelineRuntime: Layer-Reihenfolge verletzt (' + a + ' ≠ ' + b + ')');
}

/**
 * Baut die serielle Knotenkette eines Plans: [Pitch₁] → Kette₁ → [Pitch₂] → Kette₂ → … → [terminaler Panner].
 * (Bis Phase 2 stand dieser Code in fx-pipeline.js buildPipelineGraph; unverändert in der Verdrahtung.)
 */
function buildInner(ctx, plan, { numChannels = 2, caps = { pitch: 'worklet' }, bypassable = false, send = null } = {}) {
  const track = [];      // gestartete Quellen (LFO/Träger) und Convolver → dispose() stoppt/leert sie
  const nodes = [];      // Verbindungsknoten → dispose() trennt sie
  const steps = [];
  let input = null, tail = null, detuneSemitones = 0, skippedPitch = 0;

  const link = seg => {
    if (!seg) return;
    nodes.push(seg.input, seg.output);
    if (!input) input = seg.input; else tail.connect(seg.input);
    tail = seg.output;
  };

  for (const step of plan.steps) {
    const rec = { layerId: step.layerId, pitch: null, modules: [] };
    const ps = step.params.pitchShift;
    if (ps.enabled && ps.semitones) {
      if (caps.pitch === 'worklet') {
        const n = buildPitchNode(ctx, ps, numChannels);
        if (n) { link(n); rec.pitch = n; }
        else {
          detuneSemitones += ps.semitones;
          console.warn('[pipeline] Pitch-Worklet nicht verfügbar — Notbehelf über detune (Reihenfolge nicht garantiert)');
        }
      } else skippedPitch++;
    }
    // Geteilter Reverb-Send (Phase 3b): das Hall-Modul dieses Schritts baut der Hub, nicht die Kette.
    const isSend = !!send && step.index === send.step;
    const lc = buildLayerChain(ctx, step.params, { track, bypassable, omit: isSend ? new Set([send.key]) : undefined });
    if (lc) { link(lc); rec.modules = lc.modules; for (const m of lc.modules) nodes.push(m.input, m.output); }
    steps.push(rec);
  }
  // Im Sendmodus sitzt der terminale Panner hinter dem Master-Gain (Dry- und Hub-Pfad, reverb-hub.js attachSend).
  if (input && plan.needsPanner && !send) link(buildTerminalPanner(ctx, 0));
  assertOrder(plan, steps);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const s of track) { try { s.stop(); } catch (e) { /* bereits gestoppt */ } }
    for (const n of nodes) { try { n.disconnect(); } catch (e) { /* bereits getrennt */ } }
    track.length = 0; nodes.length = 0;
  };
  return { input, output: tail, steps, detuneSemitones, skippedPitch, dispose };
}

export class PipelineRuntime {
  /**
   * @param {BaseAudioContext} ctx
   * @param {object} plan  aufgelöster Plan (fx-pipeline.js resolvePlan)
   * @param {{numChannels?:number, caps?:object, bypassable?:boolean, live?:boolean, xfade?:number}} [o]
   */
  constructor(ctx, plan, o = {}) {
    this.ctx = ctx;
    this.numChannels = o.numChannels ?? 2;
    this.caps = o.caps || { pitch: 'worklet' };
    this.bypassable = !!o.bypassable;
    this.live = !!o.live;
    this.xfade = o.xfade ?? XFADE_SECONDS;
    this.disposed = false;
    this.plan = plan;
    this.sig = planSignature(plan);
    this._retiring = new Set();
    this._swapChain = Promise.resolve();
    this._pending = null;
    this._swapping = false;
    this.bypassedAll = false;
    // Sendmodus (Phase 3b): nur nicht-live und ohne Bypass-Hüllen. `o.send` = { step, key, ... } aus fx-pipeline.sendEligibility().
    this.send = (o.send && !this.live && !this.bypassable) ? o.send : null;
    this.sendSig = this.send ? JSON.stringify(plan.steps[this.send.step]?.params?.[this.send.key]) : null;

    const inner = buildInner(ctx, plan, { numChannels: this.numChannels, caps: this.caps, bypassable: this.bypassable, send: this.send });
    this.cur = inner;
    if (this.live) {
      this.entry = ctx.createGain(); this.exit = ctx.createGain();
      this.wetBus = ctx.createGain(); this.dry = ctx.createGain(); this.dry.gain.value = 0;
      inner.fade = ctx.createGain(); inner.fade.gain.value = 1;
      if (inner.input) this.entry.connect(inner.input); else this.entry.connect(inner.fade);
      if (inner.output) inner.output.connect(inner.fade);
      inner.fade.connect(this.wetBus); this.wetBus.connect(this.exit);
      this.entry.connect(this.dry); this.dry.connect(this.exit);
      this.input = this.entry; this.output = this.exit;
    } else {
      this.input = inner.input; this.output = inner.output;
    }
  }

  get detuneSemitones() { return this.cur.detuneSemitones; }
  get skippedPitch() { return this.cur.skippedPitch; }
  get sequence() { return this.plan.sequence; }

  /** Vorbereitung eines Plans im Context (Pitch-Worklet laden). */
  async prepare(plan) {
    const ids = workletsForPlan(plan, this.caps);
    if (ids.length) await ensureWorklets(this.ctx, ids);
  }

  /**
   * Parameteränderung. Rückgabe (Promise nur bei Überblendung):
   *   'live'     alles live angewendet (kein Neubau)
   *   'swapped'  (live:true) Struktur/nicht glättbarer Wert → neu gebaut und überblendet
   *   'rebuild'  (live:false) Neubau nötig; nichts überblendet — Aufrufer entscheidet
   *   'disposed'
   */
  update(plan) {
    if (this.disposed) return 'disposed';
    const sig = planSignature(plan);
    let ok = sig === this.sig;
    if (ok) {
      for (let i = 0; i < plan.steps.length && ok; i++) {
        const rec = this.cur.steps[i], p = plan.steps[i].params;
        if (rec.pitch && !rec.pitch.update(p.pitchShift)) ok = false;
        for (const m of rec.modules) { if (ok && !m.update(p[m.key])) ok = false; }
      }
    }
    // Sendmodus: der Hall liegt außerhalb der Kette (Hub) — geänderte Hall-Parameter erfordern einen Neubau.
    if (ok && this.send && JSON.stringify(plan.steps[this.send.step]?.params?.[this.send.key]) !== this.sendSig) ok = false;
    if (ok) { this.plan = plan; return 'live'; }
    return this.live ? this.swapTo(plan).then(() => 'swapped') : 'rebuild';
  }

  /**
   * Baut `plan` daneben und blendet per Equal-Power-Kreuzblende um (nur live:true). Aufrufe werden hintereinander
   * abgearbeitet; während einer laufenden Überblendung wartende Pläne werden zusammengefasst (der letzte gewinnt).
   */
  swapTo(plan, { fade = this.xfade } = {}) {
    if (!this.live) return Promise.reject(new Error('PipelineRuntime.swapTo: nur im Live-Modus (live:true)'));
    if (this.disposed) return Promise.resolve('disposed');
    this._pending = { plan, fade };
    if (!this._swapping) {
      this._swapping = true;
      this._swapChain = this._drain();
    }
    return this._swapChain;
  }

  async _drain() {
    try {
      while (this._pending && !this.disposed) {
        const { plan, fade } = this._pending; this._pending = null;
        await this.prepare(plan);
        if (this.disposed) break;
        await this._swapNow(plan, fade);
      }
    } finally { this._swapping = false; }
    return this.disposed ? 'disposed' : 'swapped';
  }

  async _swapNow(plan, fade) {
    const ctx = this.ctx, old = this.cur;
    const nu = buildInner(ctx, plan, { numChannels: this.numChannels, caps: this.caps, bypassable: this.bypassable });
    nu.fade = ctx.createGain(); nu.fade.gain.value = 0;
    if (nu.input) this.entry.connect(nu.input); else this.entry.connect(nu.fade);
    if (nu.output) nu.output.connect(nu.fade);
    nu.fade.connect(this.wetBus);
    const t0 = ctx.currentTime, d = Math.max(0.005, fade);
    _ramp(nu.fade.gain, _up, t0, d, 1);
    _ramp(old.fade.gain, _down, t0, d, 0);
    this.cur = nu; this.plan = plan; this.sig = planSignature(plan);
    this._retiring.add(old);
    await _waitAudioTime(ctx, t0 + d + 0.02, () => this.disposed, (d + 1) * 1000);
    this._retiring.delete(old);
    try { old.dispose(); old.fade.disconnect(); } catch (e) { /* ignorieren */ }
  }

  /** Modul (Layer-Schritt `layerId`, Schlüssel `key`) klickfrei an/aus. Nur mit `bypassable:true`. */
  setModuleBypass(layerId, key, on, smooth = true) {
    const i = this.plan.steps.findIndex(s => s.layerId === layerId);
    const m = i >= 0 ? this.cur.steps[i].modules.find(x => x.key === key) : null;
    if (!m || !m.setBypass) return false;
    m.setBypass(on, smooth);
    return true;
  }

  /** Ganze Pipeline klickfrei auf den trockenen Pfad (Original ohne Effekte, wie bei deaktivierten Effekten). Nur live:true. */
  setPipelineBypass(on) {
    if (!this.live || this.disposed) return false;
    this.bypassedAll = !!on;
    const t = this.ctx.currentTime;
    this.wetBus.gain.setTargetAtTime(on ? 0 : 1, t, 0.005);
    this.dry.gain.setTargetAtTime(on ? 1 : 0, t, 0.005);
    return true;
  }

  /** Nachklingdauer (s) aus den TATSÄCHLICH gebauten Modulen (überlagerte Module zählen nicht). Je Schritt das Maximum, Summe über Schritte. */
  tailSeconds() {
    let sum = 0;
    this.plan.steps.forEach((s, i) => {
      let t = 0;
      for (const m of (this.cur.steps[i]?.modules || [])) t = Math.max(t, moduleTail(m.key, s.params[m.key]));
      sum += t;
    });
    return Math.min(30, sum);
  }

  /** Kostenpunkte der gebauten Pipeline: { total, measured } (measured = alle Werte aus Messung, heute false). */
  cost() {
    let total = 0, measured = true;
    this.plan.steps.forEach((s, i) => {
      const rec = this.cur.steps[i];
      const keys = [...(rec?.pitch ? ['pitchShift'] : []), ...(rec?.modules || []).map(m => m.key)];
      for (const k of keys) { const c = moduleCost(k, s.params[k]); total += c.base || 0; if (!c.measured) measured = false; }
    });
    return { total, measured };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._pending = null;
    for (const r of this._retiring) { try { r.dispose(); } catch (e) { /* ignorieren */ } }
    this._retiring.clear();
    try { this.cur.dispose(); } catch (e) { /* ignorieren */ }
    for (const n of [this.entry, this.exit, this.wetBus, this.dry, this.cur?.fade]) { try { n?.disconnect(); } catch (e) { /* ignorieren */ } }
  }
}
