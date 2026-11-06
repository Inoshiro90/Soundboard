/**
 * audio/engine/runtime.js — PipelineRuntime (Phase 3, AE-04′)
 *
 * Eine Runtime besitzt EINE gebaute Vier-Stufen-Pipeline (Quelle → Medium → Umgebung → Hörer) und macht sie lebendig:
 *   update(plan)        Parameteränderung live (setTargetAtTime). Ändert sich die STRUKTUR (Layer, aktive Module, Pitch an/aus)
 *                       oder ein nicht glättbarer Wert (IR, Verzerrungskurve, LFO-Form), wird neu gebaut und überblendet.
 *   swapTo(plan)        Neue Pipeline daneben bauen und per Equal-Power-Kreuzblende (Standard 40 ms) umschalten.
 *   setModuleBypass     Modul klickfrei an/aus (nur bei `bypassable: true`).
 *   setPipelineBypass   Ganze Pipeline klickfrei auf den trockenen Pfad (A/B; nur im Live-Modus).
 *   arm(timing)/hold()  Zeitbasis für Bewegungen (Phase 13d, timebase.js): Der Aufrufer meldet beim START der Quelle Beginn und
 *                       Durchlaufdauer; Module mit `arm({timing, from, to, reset})` planen ihre Automation daraus. Ein Live-Update
 *                       plant geänderte Module relativ zum ursprünglichen Start neu (ab „jetzt“), ein Austausch startet die neue
 *                       Kette mit derselben Zeitbasis. Loop-Durchläufe werden mit Vorlauf geplant und per Wanduhr-Timer nachgeplant
 *                       (nicht in Offline-Contexts). `hold()` friert ein (Musik-Pause); ein neues arm() setzt fort.
 *                       Module ohne `arm` sind unberührt — ohne solche Module ist arm() wirkungslos (kein Knoten, kein Timer).
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
 *
 * Tempo (Phase 17f, Entscheidungen M/N/P): Hat das Ziel `caps.tempo` und der Plan `tempo.counter` (Tonhöhe halten, Rate ≠ 1), sitzt ein
 * Gegen-Pitch-Knoten (`voice`, Faktor 1/Rate) am Kettenanfang VOR allen Layern. Das Tempo wird beim Bau EINGEFROREN (`this.tempo`):
 * Austausche und Live-Updates während der Wiedergabe ändern es nicht — die Rate der Quelle steht ebenfalls fest; ein geändertes
 * Tempo wirkt beim nächsten Start (Regel P). Tempo-Module selbst zählen nicht zur Strukturunterschrift.
 */

import { buildPitchNode, buildLayerChain, buildTerminalPanner } from '../effect-graph.js';
import { ensureWorklets } from '../context.js';
import { workletsForPlan, fallbackWorklets } from './worklets.js';
import { ensureCompressorLatency, planNeedsCompressorProbe } from './compressor-probe.js';
import { ensureWaveShaperLatency, planNeedsWaveShaperProbe } from './waveshaper-probe.js';
import { effectiveActiveKeys } from './schema.js';
import { moduleTail, moduleCost, moduleLatency, pitchActive, pitchValues, isPlanLevelKey, tempoCounterParams, TEMPO_COUNTER_TAIL_S } from './registry.js';
import { makeTiming, planHorizon } from './timebase.js';

/** Vorgabewerte der Überblendung. */
export const XFADE_SECONDS = 0.04;           // Addendum A: 30–50 ms
/** Mindestabstand zwischen den Starts zweier struktureller Austausche (Wanduhr, ms). Erster sofort, letzter gewinnt (Fix B, Befund 3A). */
export const MIN_SWAP_INTERVAL_MS = 200;
/** Obergrenze der Wartezeit (s) vor der Überblendung (17e, Entscheidung B): schützt vor unplausiblen Latenzwerten. */
export const MAX_SWAP_DELAY_S = 0.12;
const FADE_POINTS = 32;
const _up   = new Float32Array(FADE_POINTS), _down = new Float32Array(FADE_POINTS);
for (let i = 0; i < FADE_POINTS; i++) { const a = (i / (FADE_POINTS - 1)) * Math.PI / 2; _up[i] = Math.sin(a); _down[i] = Math.cos(a); }


/**
 * 17e (Entscheidung B): Latenz (s) der neu gebauten Kette = Summe der Modul-Latenzen je Schritt (Pitch-Knoten + Module mit `latencySamples`).
 * Erst nach dieser Zeit liegt das Signal der neuen Kette an; die Überblendung beginnt dann erst — sonst bricht der Pegel beim Umschalten ein.
 * Ketten ohne Latenz: 0 (Verhalten und Klang bit-gleich zu vorher).
 */
export function chainLatencySeconds(inner, plan, sampleRate) {
  let n = Number(inner.counter?.latency) || 0;   // P17f: Gegen-Pitch am Kettenanfang
  plan.steps.forEach((st, i) => {
    const rec = inner.steps[i]; if (!rec) return;
    n += Number(rec.pitch?.latency) || 0;
    for (const m of rec.modules) n += moduleLatency(m.key, st.params[m.key], sampleRate) || 0;
  });
  return Math.min(MAX_SWAP_DELAY_S, n / sampleRate);
}

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

const _pitchActive = pitchActive;   // P17b: eine Regel (registry.js), für `legacy` mit Cent 0 wie bisher „Halbtöne ≠ 0“
/** Module einer gebauten Kette, die eine Zeitbasis brauchen (13d). */
const _armable = inner => inner.steps.flatMap(r => r.modules.filter(m => typeof m.arm === 'function'));
/** Offline-Context (Export, Tests): kein Wanduhr-Timer, Loops gibt es dort nicht. */
const _isOffline = ctx => typeof ctx.startRendering === 'function';

/** Strukturunterschrift eines Plans: gleiche Unterschrift ⇒ gleiche Knotentopologie, nur Parameter dürfen abweichen. */
export function planSignature(plan) {
  return JSON.stringify({
    p: !!plan.needsPanner,
    s: plan.steps.map(s => [s.layerId, _pitchActive(s.params.pitchShift) ? 1 : 0, effectiveActiveKeys(s.params).filter(k => k !== 'pitchShift' && !isPlanLevelKey(k)).sort()])   // P17f: Tempo eingefroren, zählt nicht
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
function buildInner(ctx, plan, { numChannels = 2, caps = { pitch: 'worklet' }, bypassable = false, send = null, tempo = null, reverse = null } = {}) {
  const track = [];      // gestartete Quellen (LFO/Träger) und Convolver → dispose() stoppt/leert sie
  const nodes = [];      // Verbindungsknoten → dispose() trennt sie
  const steps = [];
  let input = null, tail = null, detuneSemitones = 0, skippedPitch = 0, counter = null, tempoFallback = false;

  const link = seg => {
    if (!seg) return;
    nodes.push(seg.input, seg.output);
    if (!input) input = seg.input; else tail.connect(seg.input);
    tail = seg.output;
  };

  // P17f: Gegen-Pitch des Tempos vor allen Layern (nur Ziele mit caps.tempo). Ohne Worklet: kein Knoten — die Rate wirkt trotzdem, die Tonhöhe ändert sich mit.
  if (tempo?.counter && caps.tempo) {
    const n = caps.pitch === 'worklet' ? buildPitchNode(ctx, tempoCounterParams(tempo.rate), numChannels) : null;
    if (n) { link(n); counter = n; track.push({ stop() { n.dispose?.(); } }); }
    else { tempoFallback = true; console.warn('[pipeline] Tempo: Gegen-Pitch nicht verfügbar — die Tonhöhe ändert sich mit der Rate'); }
  }

  for (const step of plan.steps) {
    const rec = { layerId: step.layerId, pitch: null, modules: [] };
    const ps = step.params.pitchShift;
    if (_pitchActive(ps)) {
      if (caps.pitch === 'worklet') {
        const n = buildPitchNode(ctx, ps, numChannels);
        if (n) { link(n); rec.pitch = n; track.push({ stop() { n.dispose?.(); } }); }
        else {
          detuneSemitones += pitchValues(ps).semitones;   // P17b: Halbtöne (+ Cent außer bei legacy); Mix/Formant entfallen im Notbehelf (Entscheidung E)
          console.warn('[pipeline] Pitch-Worklet nicht verfügbar — Notbehelf über detune (Reihenfolge nicht garantiert)');
        }
      } else skippedPitch++;
    }
    // Geteilter Reverb-Send (Phase 3b): das Hall-Modul dieses Schritts baut der Hub, nicht die Kette.
    const isSend = !!send && step.index === send.step;
    const lc = buildLayerChain(ctx, step.params, { track, bypassable, omit: isSend ? new Set([send.key]) : undefined, reverse: reverse?.get(step.layerId) || null });   // P19e
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
  return { input, output: tail, steps, detuneSemitones, skippedPitch, counter, tempoFallback, dispose };
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
    this.minSwapInterval = Math.max(0, o.minSwapInterval ?? MIN_SWAP_INTERVAL_MS);
    this._lastSwapAt = -Infinity;
    this.disposed = false;
    this.plan = plan;
    this.sig = planSignature(plan);
    this._retiring = new Set();
    // Diagnose (P10, M-7): Dauer der Austausche im echten Betrieb — wird im Overlay `?debug=audio` angezeigt; keine Wirkung auf den Klang.
    this.swapStats = { swaps: 0, coalesced: 0, buildMs: 0, totalMs: 0, maxTotalMs: 0 };
    this._swapChain = Promise.resolve();
    this._pending = null;
    this._swapping = false;
    this._inflight = false;   // P19-0: Neubau läuft (Plan entnommen, noch nicht aktiv)
    this.bypassedAll = false;
    // Zeitbasis (13d): erst beim Start der Quelle bekannt (arm). `_armedTo` = bis wohin Module geplant sind.
    this.timing = null; this.held = false; this._armedTo = -Infinity; this._timer = null;
    // Sendmodus (Phase 3b): nur nicht-live und ohne Bypass-Hüllen. `o.send` = { step, key, ... } aus fx-pipeline.sendEligibility().
    this.send = (o.send && !this.live && !this.bypassable) ? o.send : null;
    this.sendSig = this.send ? JSON.stringify(plan.steps[this.send.step]?.params?.[this.send.key]) : null;

    // P17f: Tempo beim Bau einfrieren (Regel P) — nur Ziele, die Tempo ausführen.
    this.tempo = this.caps.tempo ? (plan.tempo || null) : null;
    // P19e: Varianten des Reverse-Halls (Map layerId → Wet-Signal) — fest für die Lebensdauer der Runtime, auch für Neubauten.
    this.reverse = o.reverse instanceof Map ? o.reverse : null;
    const inner = buildInner(ctx, plan, { numChannels: this.numChannels, caps: this.caps, bypassable: this.bypassable, send: this.send, tempo: this.tempo, reverse: this.reverse });
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
  /** P17f: wirksame Tempo-Rate (eingefroren beim Bau; 1 ohne Tempo oder bei Zielen ohne caps.tempo). */
  get tempoRate() { return this.tempo?.rate ?? 1; }
  /** P17f: Tonhöhe halten war verlangt, aber der Gegen-Pitch konnte nicht gebaut werden (kein Worklet). */
  get tempoFallback() { return !!this.cur.tempoFallback; }
  get sequence() { return this.plan.sequence; }

  /** Vorbereitung eines Plans im Context (Pitch-Worklet laden). */
  async prepare(plan) {
    const ids = workletsForPlan(plan, this.caps);
    if (ids.length) { const fb = fallbackWorklets(await ensureWorklets(this.ctx, ids)); if (fb.length) await ensureWorklets(this.ctx, fb); }   // P17b: stft → pitch
    if (planNeedsCompressorProbe(plan)) await ensureCompressorLatency(this.ctx.sampleRate);   // Dry-Pfad der Parallelkompression (11c)
    if (planNeedsWaveShaperProbe(plan)) await ensureWaveShaperLatency(this.ctx.sampleRate);   // Dry-Pfad der Verzerrung v2 (15a)
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
    // P19-0 (Befund 6, Zeitrennen): Läuft gerade ein Neubau (Plan aus der Warteschlange genommen, aber noch nicht aktiv), vergliche
    // die Signatur unten mit der ALTEN Kette; ein Live-Update ginge an die ausblendende Kette, und der ältere Plan gewänne danach.
    // Deshalb einreihen: der neueste Plan wird nach dem laufenden Neubau gebaut (letzter gewinnt).
    if (this.live && this._inflight) return this.swapTo(plan).then(() => 'swapped');
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
    if (ok) {
      // P19-0 (Befund 6): Ein noch wartender älterer Plan (Drosselung) ist durch diesen neueren überholt und wird verworfen —
      // sonst baute _drain() ihn danach und überschriebe den live angewendeten Stand.
      if (this._pending) { this._pending = null; this.swapStats.coalesced++; }
      const old = this.plan; this.plan = plan;
      // Zeitbasis (13d): geänderte Module mit Bewegung relativ zum ursprünglichen Start neu planen (ab jetzt, bis zum bisherigen Vorlauf).
      if (this.timing && !this.held) {
        const now = this.ctx.currentTime, to = Math.max(this._armedTo, planHorizon(this.timing, now));
        plan.steps.forEach((st, i) => {
          for (const m of this.cur.steps[i].modules) {
            if (typeof m.arm !== 'function') continue;
            if (JSON.stringify(old.steps[i]?.params?.[m.key]) === JSON.stringify(st.params[m.key])) continue;
            m.arm({ timing: this.timing, from: now, to, reset: true });
          }
        });
      }
      return 'live';
    }
    return this.live ? this.swapTo(plan).then(() => 'swapped') : 'rebuild';
  }

  /**
   * Baut `plan` daneben und blendet per Equal-Power-Kreuzblende um (nur live:true). Aufrufe werden hintereinander
   * abgearbeitet; während einer laufenden Überblendung wartende Pläne werden zusammengefasst (der letzte gewinnt).
   */
  swapTo(plan, { fade = this.xfade } = {}) {
    if (!this.live) return Promise.reject(new Error('PipelineRuntime.swapTo: nur im Live-Modus (live:true)'));
    if (this.disposed) return Promise.resolve('disposed');
    if (this._pending) this.swapStats.coalesced++;     // ein noch wartender Plan wird vom neueren ersetzt
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
        // Drosselung (Fix B): Neubauten höchstens im Abstand `minSwapInterval`. Währenddessen darf `_pending` durch neuere Pläne ersetzt werden (letzter gewinnt).
        const wait = this._lastSwapAt + this.minSwapInterval - Date.now();
        if (wait > 0) { await new Promise(r => setTimeout(r, wait)); continue; }
        const { plan, fade } = this._pending; this._pending = null;
        this._lastSwapAt = Date.now();
        // P19-0: `_inflight` von der Entnahme bis `this.sig` umgestellt ist (synchroner Teil von _swapNow) — s. update().
        this._inflight = true;
        await this.prepare(plan);
        if (this.disposed) break;
        const done = this._swapNow(plan, fade);
        this._inflight = false;
        await done;
      }
    } finally { this._swapping = false; this._inflight = false; }
    return this.disposed ? 'disposed' : 'swapped';
  }

  async _swapNow(plan, fade) {
    const ctx = this.ctx, old = this.cur, tSwap = (typeof performance !== 'undefined') ? performance.now() : 0;
    const nu = buildInner(ctx, plan, { numChannels: this.numChannels, caps: this.caps, bypassable: this.bypassable, tempo: this.tempo, reverse: this.reverse });   // P17f: eingefrorenes Tempo; P19e
    nu.fade = ctx.createGain(); nu.fade.gain.value = 0;
    if (nu.input) this.entry.connect(nu.input); else this.entry.connect(nu.fade);
    if (nu.output) nu.output.connect(nu.fade);
    nu.fade.connect(this.wetBus);
    // Zeitbasis (13d): die neue Kette übernimmt die laufende Bewegung (gleicher Start, ab jetzt geplant) — sonst begänne sie von vorn.
    if (this.timing && !this.held) this._armInner(nu, ctx.currentTime, Math.max(this._armedTo, planHorizon(this.timing, ctx.currentTime)), true);
    const t0 = ctx.currentTime + chainLatencySeconds(nu, plan, ctx.sampleRate), d = Math.max(0.005, fade);   // 17e (B): erst wenn das Signal der neuen Kette anliegt
    _ramp(nu.fade.gain, _up, t0, d, 1);
    _ramp(old.fade.gain, _down, t0, d, 0);
    this.cur = nu; this.plan = plan; this.sig = planSignature(plan);
    this._retiring.add(old);
    const st = this.swapStats, tBuilt = (typeof performance !== 'undefined') ? performance.now() : 0;
    await _waitAudioTime(ctx, t0 + d + 0.02, () => this.disposed, (d + 1) * 1000);
    this._retiring.delete(old);
    if (tSwap) {
      const tEnd = performance.now();
      st.swaps++; st.buildMs = tBuilt - tSwap; st.totalMs = tEnd - tSwap; st.maxTotalMs = Math.max(st.maxTotalMs, st.totalMs);
      if (typeof window !== 'undefined') window.__swapStats = st;
    }
    try { old.dispose(); old.fade.disconnect(); } catch (e) { /* ignorieren */ }
  }

  /**
   * Zeitbasis setzen und Bewegungen planen (Phase 13d). Aufruf beim START der Quelle (renderPipeline.js start(), Musik bei
   * playing/seeked). `timing` siehe timebase.js (origin, passStart, passIndex, dur, loop). Ein erneuter Aufruf ersetzt die Zeitbasis
   * und plant ab jetzt neu (Musik: Fortsetzen nach Pause, Sprung, neuer Durchlauf). Rückgabe: Anzahl geplanter Module.
   */
  arm(timing) {
    if (this.disposed) return 0;
    this.timing = makeTiming(timing); this.held = false;
    this._stopTimer();
    const now = this.ctx.currentTime, mods = _armable(this.cur);
    if (!mods.length) { this._armedTo = planHorizon(this.timing, now); return 0; }
    this._armInner(this.cur, now, planHorizon(this.timing, now), true);
    if (this.timing.loop && !_isOffline(this.ctx)) this._startTimer();
    return mods.length;
  }

  /** Bewegungen einfrieren (Musik-Pause): Module mit `hold(t)` halten ihren aktuellen Wert; Nachplanen stoppt. arm() setzt fort. */
  hold() {
    if (this.disposed || !this.timing) return;
    this.held = true; this._stopTimer();
    const t = this.ctx.currentTime;
    for (const m of _armable(this.cur)) m.hold?.(t);
  }

  /** Loop-Durchläufe nachplanen: Fenster mit Beginn in [_armedTo, neuer Vorlauf) anhängen (ohne Neuplanung des Bisherigen). */
  _topUp() {
    if (this.disposed || this.held || !this.timing?.loop) return;
    const to = planHorizon(this.timing, this.ctx.currentTime);
    if (!(to > this._armedTo)) return;
    this._armInner(this.cur, this._armedTo, to, false);
  }

  _armInner(inner, from, to, reset) {
    for (const m of _armable(inner)) m.arm({ timing: this.timing, from, to, reset });
    this._armedTo = to;
  }

  _startTimer() {
    const ms = Math.max(250, (planHorizon(this.timing, 0) / 2) * 1000);
    const tick = () => { this._timer = null; if (this.disposed || this.held) return; this._topUp(); this._timer = setTimeout(tick, ms); };
    this._timer = setTimeout(tick, ms);
  }

  _stopTimer() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

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
    let sum = this.cur.counter ? TEMPO_COUNTER_TAIL_S : 0;   // P17f: Gegen-Pitch (wie planTailSeconds)
    this.plan.steps.forEach((s, i) => {
      let t = 0;
      for (const m of (this.cur.steps[i]?.modules || [])) t = Math.max(t, moduleTail(m.key, s.params[m.key]));
      if (this.cur.steps[i]?.pitch) t += moduleTail('pitchShift', s.params.pitchShift);   // P17b: Latenz verschiebt die Kette (wie planTailSeconds)
      sum += t;
    });
    return Math.min(30, sum);
  }

  /** Kostenpunkte der gebauten Pipeline: { total, measured } (measured = alle Werte aus Messung, heute false). */
  cost() {
    let total = 0, measured = true;
    if (this.cur.counter) { const c = moduleCost('pitchShift', tempoCounterParams(this.tempo.rate)); total += c.base || 0; if (!c.measured) measured = false; }   // P17f
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
    this._stopTimer();
    for (const r of this._retiring) { try { r.dispose(); } catch (e) { /* ignorieren */ } }
    this._retiring.clear();
    try { this.cur.dispose(); } catch (e) { /* ignorieren */ }
    for (const n of [this.entry, this.exit, this.wetBus, this.dry, this.cur?.fade]) { try { n?.disconnect(); } catch (e) { /* ignorieren */ } }
  }
}
