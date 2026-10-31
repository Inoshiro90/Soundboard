/**
 * audio/effect-graph.js — Effekt-Graph-Konstruktion (zustandslos)
 * Enthält die reinen Knoten-Builder (_build*), buildEffectChain/buildPitchNode sowie die
 * Default-Datenmodelle für Effekte/Wiedergabeparameter.
 */

import { makeDynamicsNode } from './engine/dynamics-node.js';
import { makeFlangerNode, makePhaserNode, phaserStages } from './engine/delayline-node.js';
import { compressorLatencySamples } from './engine/compressor-probe.js';
import { buildCrossover2, buildCrossover3, LR4_Q, LR4_Q_DB } from './engine/crossover.js';
import { _pitchWorkletReadyContexts } from './context.js';
import { getGenericIR, getIRBuffer } from './ir-data.js';
import { defaultModules, peqActiveBands, chorusVoices, chorusIsMulti, vibratoSwing, WIDTH_DECOR_DELAY_S, MS_EQ_DEF, DOPPLER_C, DOPPLER_MAX_DELAY_S,
  delayIsLegacy, delayMode, delayLoopGains, delayActiveTaps, DMB_BANDS, delayMultibandCross, delayMultibandBand, DELAY_TAP_RANGES, DELAY_MIN_S, DELAY_LOWCUT_OFF, DELAY_HIGHCUT_OFF, DELAY_MOD_MAX_MS } from './engine/registry.js';
import { makeEnvelopeFollower, makePhasedWave } from './engine/modsources.js';
import { motionWindows } from './engine/timebase.js';

// ─── DEFAULT EFFECTS ─────────────────────────────────────────

export function defaultEffects() {
  // Einzige Quelle der Modul-Defaults ist die Registry (audio/engine/registry.js, AE-01′). Das Ergebnis ist
  // byte-identisch zur früheren handgeschriebenen Liste (Test: tests/suites/09-registry.js gegen den Phase-1-Stand).
  return defaultModules();
}

/**
 * "Wiedergabe & Verhalten": nicht-destruktive Wiedergabeparameter eines
 * Sounds — im Gegensatz zu slot.fadeIn/slot.fadeOut (dauerhafte, im Editor
 * gebrannte Bearbeitung, s. editor.js editFadeIn()/editFadeOut()) verändern
 * diese Werte nie die gespeicherte Audiodatei, sondern werden erst beim
 * Abspielen angewendet (renderPipeline.js). Eigener Namensraum (`playback`)
 * bewusst getrennt von den bestehenden Legacy-Feldern `s.loop`/`s.fade`/
 * `s.random`, um Namenskonflikte mit den Slot-Fades zu vermeiden.
 */
export function defaultPlayback() {
  return {
    fadeIn:    { enabled: false, duration: 0.5, curve: 'linear' },
    fadeOut:   { enabled: false, duration: 0.5, curve: 'linear' },
    crossfade: { enabled: false, duration: 1,   curve: 'linear' }
  };
}

// ─── NODE BUILDERS ───────────────────────────────────────────
//
// Jedes Modul ist eine INSTANZ (Phase 3, AE-04′): { key, input, output, update(p) → boolean, … }.
//   • Die Parameter→Knoten-Abbildung (inkl. aller Klemmwerte) steht je Modul EINMAL in `apply(p, smooth)`. Beim Bau läuft
//     sie mit smooth=false (direkte Zuweisung — exakt das bisherige Verhalten), beim Live-Update mit smooth=true
//     (`setTargetAtTime`, klickfrei). Dadurch gibt es keine zweite Formel, die vom Bau abweichen könnte.
//   • `update(p)` liefert true, wenn alle Änderungen live angewendet wurden, und false, wenn sich ein NICHT glättbarer Wert
//     geändert hat (LFO-Form, Filter-Stufenzahl …). Dann muss der Aufrufer neu bauen/überblenden (runtime.js).
//     Ausnahme (P10f): Verzerrungskurve und Hall-IR tauschen nur ihren Kern aus (`_hotSlot`) und melden true.

export const EQ10_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Zeitkonstante der Parameterglättung (s): ≈ 95 % nach 3·τ = 45 ms. */
export const SMOOTH_TC = 0.015;

const _cl = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const _setter = (ctx, smooth) => (param, v) => {
  if (!smooth) param.value = v;
  else param.setTargetAtTime(v, ctx.currentTime, SMOOTH_TC);
};

/** Versieht ein Segment {input, output} mit Schlüssel und update(); `sig(p)` = Signatur der nicht glättbaren Werte. */
function _inst(key, seg, p, { apply, sig = null, hot = null }) {
  const s0 = sig ? sig(p) : '';
  seg.key = key;
  seg.update = np => {
    if (hot) { apply(np, true); hot.request(np); return true; }   // nicht glättbarer Kern: Modul-Austausch (_hotSlot) statt Pipeline-Neubau
    if (sig && sig(np) !== s0) return false;
    apply(np, true);
    return true;
  };
  return seg;
}


/**
 * Modul-Austausch (P10f, AE-04′ „Doppelinstanz nur für dieses Modul“): Für nicht glättbare Werte (Verzerrungskurve, Reverb-IR) wird NICHT
 * mehr die ganze Pipeline neu gebaut (das baute auch das Pitch-Worklet jedes Mal neu auf), sondern nur der Kern dieses Moduls.
 * Aufbau: input(Gain 1) → [Kern] → Kern-Fade(Gain 1) → output(Gain 1). Beim Austausch läuft der neue Kern parallel, beide werden
 * `fadeSec` lang überblendet, danach wird der alte entsorgt. Anfragen werden gedrosselt (Leading + Trailing, `throttleMs`): ein Regler
 * erzeugt so höchstens ca. 1000/throttleMs Austausche pro Sekunde, und der zuletzt angefragte Wert gewinnt immer.
 * Beim Bau ist der Graph bis auf die Einsen-Gains identisch zum bisherigen (Gain 1 ist verlustfrei → Goldens unverändert).
 * `make(q)` → {input, output, dispose?()}. `tr` = dispose()-Liste der Pipeline.
 */
export const MODULE_SWAP_STATS = { swaps: 0, requests: 0 };
function _hotSlot(ctx, tr, make, p0, sig, { fadeSec = 0.04, throttleMs = 120, power = true } = {}) {
  const input = ctx.createGain(), output = ctx.createGain();
  const mount = q => {
    const core = make(q), fade = ctx.createGain();
    input.connect(core.input); core.output.connect(fade); fade.connect(output);
    return { core, fade };
  };
  const drop = c => {
    try { c.core.output.disconnect(); } catch (e) { /* schon getrennt */ }
    try { c.fade.disconnect(); } catch (e) { /* schon getrennt */ }
    try { input.disconnect(c.core.input); } catch (e) { /* schon getrennt */ }
    try { c.core.dispose?.(); } catch (e) { /* ignorieren */ }
  };
  let cur = mount(p0), curSig = sig(p0), pending = null, timer = null, last = -Infinity, dead = false;
  const retiring = new Set();
  const curveUp = new Float32Array(32), curveDn = new Float32Array(32);
  for (let i = 0; i < 32; i++) {
    const x = i / 31;
    // power: Equal-Power (unkorrelierte Kerne, z. B. zwei IRs); sonst Raised-Cosine (Summe = 1, an beiden Enden ohne Knick — korrelierte Kerne)
    curveUp[i] = power ? Math.sin(x * Math.PI / 2) : (1 - Math.cos(x * Math.PI)) / 2;
    curveDn[i] = power ? Math.cos(x * Math.PI / 2) : (1 + Math.cos(x * Math.PI)) / 2;
  }
  const run = q => {
    if (dead) return;
    last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const nu = mount(q), old = cur, t0 = ctx.currentTime;
    nu.fade.gain.value = 0;
    nu.fade.gain.setValueCurveAtTime(curveUp, t0, fadeSec);
    old.fade.gain.cancelScheduledValues(t0);
    old.fade.gain.setValueCurveAtTime(curveDn, t0, fadeSec);
    cur = nu; curSig = sig(q); MODULE_SWAP_STATS.swaps++;
    retiring.add(old);
    setTimeout(() => { if (retiring.delete(old)) drop(old); }, fadeSec * 1000 + 80);
  };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const request = q => {
    if (dead) return;
    const sg = sig(q);
    if (!pending && sg === curSig) return;           // nichts zu tun (auch Rückkehr auf den aktuellen Wert)
    pending = q; MODULE_SWAP_STATS.requests++;
    const wait = throttleMs - (now() - last);
    if (wait <= 0 && !timer) { const x = pending; pending = null; if (sig(x) !== curSig) run(x); return; }
    if (!timer) timer = setTimeout(() => { timer = null; const x = pending; pending = null; if (x && sig(x) !== curSig) run(x); }, Math.max(0, wait));
  };
  if (tr) tr.push({ stop() {
    dead = true; if (timer) { clearTimeout(timer); timer = null; }
    for (const c of retiring) drop(c); retiring.clear();
    drop(cur);
  } });
  return { input, output, request };
}

/**
 * bands[i] kann sowohl das alte Format (reine Zahl = Gain, fester Q=1.4) als auch das
 * neue Format ({freq, gain, Q}) sein — Rückwärtskompatibilität mit älteren Presets/gespeicherten
 * Sounds im Flat-Array-Format (u.a. alle mitgelieferten FX-Presets).
 */
function _buildEQ10(ctx, p) {
  const nodes = EQ10_FREQS.map((_, i) => {
    const n = ctx.createBiquadFilter();
    n.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
    return n;
  });
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const bands = q.bands || new Array(10).fill(0);
    nodes.forEach((n, i) => {
      const b = bands[i];
      const isObj = typeof b === 'object' && b !== null;
      const gain = isObj ? (b.gain ?? 0) : (b ?? 0);
      const freq = isObj && b.freq ? b.freq : EQ10_FREQS[i];
      const qq   = isObj && b.Q    ? b.Q    : 1.4;
      set(n.frequency, freq);
      set(n.Q, Math.max(0.3, Math.min(10, qq)));
      set(n.gain, Math.max(-18, Math.min(18, gain)));
    });
  };
  apply(p, false);
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return _inst('eq10', { input: nodes[0], output: nodes[nodes.length - 1] }, p, { apply });
}

function _buildEQ3(ctx, p) {
  const ls = ctx.createBiquadFilter(); ls.type = 'lowshelf';  ls.frequency.value = 200;
  const mp = ctx.createBiquadFilter(); mp.type = 'peaking';   mp.frequency.value = 1000; mp.Q.value = 1.0;
  const hs = ctx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 4000;
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(ls.gain, Math.max(-18, Math.min(18, q.low  ?? 0)));
    set(mp.gain, Math.max(-18, Math.min(18, q.mid  ?? 0)));
    set(hs.gain, Math.max(-18, Math.min(18, q.high ?? 0)));
  };
  apply(p, false);
  ls.connect(mp); mp.connect(hs);
  return _inst('eq', { input: ls, output: hs }, p, { apply });
}

/** Kompressor; als Limiter-Notbehelf (ohne Worklet) die frühere Näherung: `key` = 'compressor' | 'limiter'. */
/** Standardwerte je Band des Multiband-Kompressors (Spiegel von registry.js). */
const _MB_BANDS = ['low', 'mid', 'high'];
const _MB_DEF = { Threshold: -24, Ratio: 3, Attack: 0.01, Release: 0.25, Makeup: 0 };
/**
 * Multiband-Kompressor (Phase 11e): LR4-Dreibandweiche (engine/crossover.js) und je Band ein nativer Kompressor mit Makeup
 * (`_buildCompressor`, dasselbe Modul wie `compressor`: gleiche Vorverzögerung in allen Bändern, Parallelanteil `mix` je Band).
 * Weichenfrequenzen, Schwelle, Verhältnis, Attack, Release, Makeup und `mix` laufen live (geglättet). Strukturell (Neubau,
 * `update()` liefert false) ist nur das erste `mix < 1` (Dry-Pfade entstehen), wie beim Kompressor.
 */
function _buildMultiband(ctx, p) {
  const f1Of = q => _cl(40, 800, Number.isFinite(q.crossLow) ? q.crossLow : 200);
  const f2Of = q => _cl(1000, 12000, Number.isFinite(q.crossHigh) ? q.crossHigh : 2500);
  const bandOf = (q, b) => {
    const o = { mix: q.mix };
    for (const k of Object.keys(_MB_DEF)) { const v = q[b + k]; o[k.toLowerCase()] = Number.isFinite(v) ? v : _MB_DEF[k]; }
    return o;
  };
  // Mono-Pegel (Phase 12e, A1): EIN Hochmischen am Eingang (StereoPanner pan 0, wie _stereoSplit), die Bandkompressoren bekommen dann
  // schon Stereo und mischen nicht selbst hoch.
  const up = _monoUp(ctx);
  const xo = buildCrossover3(ctx, f1Of(p), f2Of(p));
  up.connect(xo.input);
  const out = ctx.createGain();
  const bands = _MB_BANDS.map((b, i) => {
    const c = _buildCompressor(ctx, bandOf(p, b), 'compressor', { upmix: false });
    xo.outputs[i].connect(c.input); c.output.connect(out);
    return c;
  });
  const needDry = (Number.isFinite(p.mix) ? _cl(0, 1, p.mix) : 1) < 1;
  const apply = (q, sm) => {
    xo.setFrequencies(f1Of(q), f2Of(q), _setter(ctx, sm));
    _MB_BANDS.forEach((b, i) => bands[i].update(bandOf(q, b)));
  };
  const sig = q => (needDry || (Number.isFinite(q.mix) ? _cl(0, 1, q.mix) : 1) < 1 ? '1' : '0');   // einmal mit Dry-Pfad gebaut ⇒ mix darf live auf 1 laufen
  return _inst('multiband', { input: up, output: out }, p, { apply, sig });
}

/**
 * Hochmischen vor dem nativen Kompressor (Phase 12e, Entscheidung A1): StereoPanner bei pan 0 — dieselbe Regel wie _stereoSplit und der
 * terminale Panner (M-3): Mono → L = R mit −3,01 dB je Kanal, Stereo unverändert. Grund: Chrome (Android) mischt eine Mono-Quelle im
 * DynamicsCompressorNode selbst zu Stereo hoch (L = R mit Pegel 1, also +3,01 dB gegenüber Filtermodulen), Node und Firefox nicht
 * (Übergabe 11e §3.1, widerspricht D2). Mit dem Panner davor bekommt der Kompressor in allen Motoren Stereo, der Ausgangspegel ist gleich.
 * Folge (freigegeben): Der Detektor sieht eine Mono-Quelle 3,01 dB leiser als bisher → bei Mono-Quellen etwas weniger Kompression.
 */
function _monoUp(ctx) {
  const up = ctx.createStereoPanner();
  up.pan.value = 0;
  return up;
}

/** `o.upmix` (Standard true): Hochmischen am Eingang (_monoUp, nur Modul `compressor`); false, wenn der Aufrufer schon Stereo liefert (Multiband). */
function _buildCompressor(ctx, p, key = 'compressor', o = {}) {
  const n = ctx.createDynamicsCompressor();
  // Phase 11c: `makeup` (dB, Standard 0 = Altverhalten) und `mix` (Parallelkompression, Standard 1 = nur Kompressor) gibt es nur beim Modul
  // `compressor`; als Limiter-Notbehelf (key 'limiter') bleibt der Aufbau wie vor 11c.
  const ext = key === 'compressor';
  const mixOf = q => (ext && Number.isFinite(q.mix) ? _cl(0, 1, q.mix) : 1);
  const needDry = mixOf(p) < 1;
  let inp = n, out = n, mk = null, wet = null, dry = null;
  if (ext) {
    mk = ctx.createGain(); n.connect(mk); out = mk;                           // Makeup (Gain 1,0 ist bit-neutral)
    if (needDry) {
      // Dry-Pfad = reine Verzögerung um die Pre-Delay-Zeit des nativen Kompressors (gemessen, M-8: Chrome/Firefox 288 Samples = 6 ms,
      // Node 384 Samples). Kein zweiter Kompressor: ein neutraler Kompressor (Schwelle 0 dB, 1:1) senkt den Pegel in Chrome und Firefox um
      // 4,04 dB (Faktor 0,628, M-8 [S]) und wäre kein Bypass. So bleibt `mix 0` exakt das unbearbeitete Signal, nur um die Latenz verschoben.
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = compressorLatencySamples(ctx.sampleRate) / ctx.sampleRate;
      inp = ctx.createGain(); out = ctx.createGain(); wet = ctx.createGain(); dry = ctx.createGain();
      inp.connect(n); mk.connect(wet); wet.connect(out);
      inp.connect(delay); delay.connect(dry); dry.connect(out);
    }
  }
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(n.threshold, q.threshold ?? -24);
    set(n.knee,      q.knee      ?? 30);
    set(n.ratio,     Math.min(20, q.ratio ?? 12));
    set(n.attack,    q.attack    ?? 0.003);
    set(n.release,   q.release   ?? 0.25);
    if (ext) {
      const db = Number.isFinite(q.makeup) ? _cl(-12, 24, q.makeup) : 0;
      set(mk.gain, 10 ** (db / 20));
      if (needDry) { const m = mixOf(q); set(wet.gain, m); set(dry.gain, 1 - m); }
    }
  };
  apply(p, false);
  if (ext && o.upmix !== false) { const up = _monoUp(ctx); up.connect(inp); inp = up; }   // Phase 12e (A1): auch der Dry-Pfad liegt dahinter
  const sig = q => (needDry || mixOf(q) < 1 ? '1' : '0');                     // einmal mit Dry-Pfad gebaut ⇒ mix darf live auf 1 laufen
  return _inst(key, { input: inp, output: out }, p, { apply, sig });
}

/**
 * Limiter mit Lookahead (Phase 11b): Worklet `dynamics`, Modus 2. Ceiling, Eingangsverstärkung und Release laufen live; eine Änderung des
 * Lookaheads (= der Latenz) tauscht nur den Kern aus (_hotSlot, wie bei der Verzerrung), kein Pipeline-Neubau. Ohne geladenes Worklet
 * greift die frühere Kompressor-Näherung (`seg.fallback = 'compressor'`): die Kette bleibt begrenzt, aber ohne Garantie für das Ceiling.
 */
function _buildLimiter(ctx, p, tr) {
  const first = makeDynamicsNode(ctx, 'limiter', p);
  if (!first) {
    const seg = _buildCompressor(ctx, p, 'limiter');
    seg.fallback = 'compressor';
    return seg;
  }
  const cores = new Set();
  let seed = first;
  const make = q => {
    let node = seed; seed = null;
    node = node || makeDynamicsNode(ctx, 'limiter', q);
    if (!node) { const c = _buildCompressor(ctx, q, 'limiter'); return { input: c.input, output: c.output }; }   // Worklet nicht erzeugbar: Näherung für diesen Kern
    cores.add(node);
    return { input: node.input, output: node.output, dispose: () => { cores.delete(node); node.dispose(); } };
  };
  const lookaheadMs = q => Math.min(20, Math.max(1, Number.isFinite(Number(q.lookahead)) ? Number(q.lookahead) : 5));
  const sig = q => String(lookaheadMs(q));
  const slot = _hotSlot(ctx, tr, make, p, sig, { fadeSec: 0.04, throttleMs: 120, power: false });
  const seg = { input: slot.input, output: slot.output };
  const setLatency = q => { seg.latencySamples = Math.round(lookaheadMs(q) / 1000 * ctx.sampleRate); };
  setLatency(p);
  return _inst('limiter', seg, p, { apply: (q, sm) => { for (const c of cores) c.update(q); setLatency(q); }, sig, hot: slot });
}

/**
 * Mehrere Verzerrungs-Kurvenformen (softClip, hardClip, bitcrush).
 * WICHTIG: der 'softClip'/default-Zweig verwendet BEWUSST die exakte Math.PI-basierte Formel
 * (nicht eine vereinfachte (1+k)-Variante) — alle mitgelieferten FX-Presets sind auf genau diese
 * Kurve abgestimmt; ein Formelwechsel würde deren Klang unbeabsichtigt verändern.
 */
function _buildDistortionCurve(mode, amount) {
  // Ungerade Länge (513): der Eingang 0 liegt EXAKT auf einer Stützstelle (Index 256). Bei gerader Länge (512)
  // interpolierte der WaveShaper bei Stille zwischen zwei Punkten und erzeugte einen Gleichanteil (N-01, ≈ −34 dBFS).
  const n = 513; const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1; // -1..1, x(256) = 0 exakt
    switch (mode) {
      case 'hardClip': {
        const threshold = Math.max(0.05, Math.min(1, amount / 100)); // amount 0-100 -> threshold 1-0.05
        curve[i] = Math.max(-threshold, Math.min(threshold, x)) / threshold; // normalisiert
        break;
      }
      case 'bitcrush': {
        const bitDepth = Math.max(1, Math.min(16, Math.round(16 - (amount / 100) * 14))); // amount -> 1..16 bit
        const steps = Math.pow(2, bitDepth);
        curve[i] = Math.round(x * steps) / steps;
        break;
      }
      case 'softClip':
      default: {
        const k = Math.max(0.1, amount);
        curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
      }
    }
  }
  return curve;
}

/** Verzerrung: Kurve und Oversampling sind nicht glättbar → Modul-Austausch mit Überblendung (P10f), kein Pipeline-Neubau. */
function _buildDistortion(ctx, p, tr) {
  const sig = q => `${q.mode}|${q.amount ?? 40}|${q.oversample}`;
  const make = q => {
    const s = ctx.createWaveShaper();
    s.curve = _buildDistortionCurve(q.mode, q.amount ?? 40);
    s.oversample = ['none', '2x', '4x'].includes(q.oversample) ? q.oversample : '4x';
    return { input: s, output: s };
  };
  const slot = _hotSlot(ctx, tr, make, p, sig, { fadeSec: 0.04, throttleMs: 80, power: false });
  return _inst('distortion', { input: slot.input, output: slot.output }, p, { apply: () => {}, sig, hot: slot });
}

/**
 * Butterworth-Güten (linear) je Stufenzahl (Flankensteilheit 12/24/48 dB/Okt. = 1/2/4 Biquads), aufsteigend: Q_k = 1 / (2·sin((2k−1)·π / 2N)),
 * N = 2·Stufen. Die LETZTE Stufe ist die „resonante“; nur sie trägt den Nutzer-Q (P10, Entscheidung a).
 */
const _BW_Q = { 2: [0.5412, 1.3066], 4: [0.5098, 0.6013, 0.8999, 2.5629] };
const _toDb = q => 20 * Math.log10(q);
const _stagesOf = slope => ({ '48': 4, '24': 2 })[String(slope ?? '12')] ?? 1;
const _bpStagesOf = slope => ({ '24': 4, '12': 2 })[String(slope ?? '6')] ?? 1;   // Bandpass: 6/12/24 dB/Okt. je Flanke

/**
 * Filter-Modul aus 1/2/4 gleichartigen Biquads (+ optional parallelem Dry-Pfad für `mix`). Ist `slope` 12 (oder fehlt) und `mix` ≥ 1
 * (oder fehlt), entsteht EXAKT der bisherige Graph (ein Biquad, Q direkt) — Altverhalten, Goldens unverändert.
 * Q: bei 12 dB/Okt. unverändert (lowpass/highpass: Resonanz in dB). Bei 24/48 dB/Okt. bekommen die übrigen Stufen Butterworth-Güten (in dB),
 * die letzte Stufe Butterworth + (Q − Standard-Q): Standard-Q ergibt also eine Butterworth-Kette, Mehr-Q hebt nur die Resonanz an.
 * Strukturell (neu bauen, `update()` liefert false): Stufenzahl und ob ein Dry-Pfad nötig ist (mix < 1).
 */
function _buildBiquadModule(ctx, p, key, type, { fMin, fMax, fDef, qMin, qMax, qDef }, { slopeable = true, mixKey = 'mix', bandpass = false } = {}) {
  const stagesOf = q => (!slopeable ? 1 : bandpass ? _bpStagesOf(q.slope) : _stagesOf(q.slope));
  const stages = stagesOf(p);
  const mixOf = q => { const v = q[mixKey]; return Number.isFinite(v) ? _cl(0, 1, v) : 1; };
  const needDry = mixOf(p) < 1;
  const nodes = [];
  for (let i = 0; i < stages; i++) { const n = ctx.createBiquadFilter(); n.type = type; nodes.push(n); }
  for (let i = 0; i < stages - 1; i++) nodes[i].connect(nodes[i + 1]);
  const bw = bandpass ? null : (_BW_Q[stages] || null);
  // Bandpass: k gleiche Stufen verengen die −3-dB-Bandbreite; Q je Stufe = Q · √(2^(1/k) − 1) (kleiner als Q, jede Stufe also breiter)
  // hält sie auf dem eingestellten Q: (1 + Q'²u²)^k = 2 bei Q·u = 1.
  const bpQ = stages > 1 ? Math.sqrt(2 ** (1 / stages) - 1) : 1;
  let inp = nodes[0], out = nodes[stages - 1], dry = null, wet = null;
  if (needDry) {
    inp = ctx.createGain(); out = ctx.createGain(); dry = ctx.createGain(); wet = ctx.createGain();
    inp.connect(nodes[0]); nodes[stages - 1].connect(wet); wet.connect(out);
    inp.connect(dry); dry.connect(out);
  }
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const f = Math.max(fMin, Math.min(fMax, q.frequency ?? fDef));
    const qu = Math.max(qMin, Math.min(qMax, q.Q ?? qDef));
    for (let i = 0; i < stages; i++) {
      set(nodes[i].frequency, f);
      if (stages === 1) set(nodes[i].Q, qu);
      else if (bandpass) set(nodes[i].Q, qu * bpQ);
      else if (i < stages - 1) set(nodes[i].Q, _toDb(bw[i]));
      else set(nodes[i].Q, _toDb(bw[i]) + (qu - qDef));
    }
    if (needDry) { const m = mixOf(q); set(wet.gain, m); set(dry.gain, 1 - m); }
  };
  apply(p, false);
  const sig = q => `${stagesOf(q)}|${needDry || mixOf(q) < 1 ? 1 : 0}`;   // einmal mit Dry-Pfad gebaut ⇒ mix darf live auf 1 laufen
  return _inst(key, { input: inp, output: out }, p, { apply, sig });
}
/** Schmalbandige Frequenzunterdrückung, primär gegen Netzbrummen (50/60Hz). */
function _buildNotch(ctx, p) {
  // `depth` (0…1): Dry parallel (1 − depth) → Kerbtiefe im Zentrum = 1 − depth; depth 1 = Altverhalten (reiner Notch, kein Dry-Pfad).
  return _buildBiquadModule(ctx, p, 'notch', 'notch', { fMin: 20, fMax: 20000, fDef: 50, qMin: 0.5, qMax: 30, qDef: 10 }, { slopeable: false, mixKey: 'depth' });
}
/**
 * Klassische Lautstärke-Modulation. Gain = dcOffset + LFO*lfoGain,
 * pendelt zwischen [1-depth, 1] (depth=0 → konstant 1, kein Effekt;
 * depth=1 → pendelt zwischen 0 und 1). Die LFO-Form ist nicht glättbar (Signatur).
 */
function _buildTremolo(ctx, p, tr) {
  if (p.stereo === 'on') return _buildTremoloStereo(ctx, p, tr);   // Phase 12a; 'off' bzw. fehlendes Feld: Graph unverändert (bit-gleich)
  const lfo = ctx.createOscillator();
  lfo.type = ['sine', 'triangle', 'square'].includes(p.waveform) ? p.waveform : 'sine';
  const lfoGain = ctx.createGain();
  const dcOffset = ctx.createConstantSource();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const lg = Math.max(0, Math.min(1, q.depth ?? 0.5)) * 0.5;   // auf ±0.5 skaliert
    set(lfo.frequency, Math.max(0.1, Math.min(20, q.rate ?? 5)));
    set(lfoGain.gain, lg);
    set(dcOffset.offset, 1 - (sm ? lg : lfoGain.gain.value));    // Basispegel, damit Gain nie negativ wird
  };
  apply(p, false);

  const outGain = ctx.createGain();
  outGain.gain.value = 0; // wird ausschließlich per LFO+DC moduliert
  lfo.connect(lfoGain).connect(outGain.gain);
  dcOffset.connect(outGain.gain);
  lfo.start(); dcOffset.start();
  if (tr) tr.push(lfo, dcOffset);

  return _inst('tremolo', { input: outGain, output: outGain }, p, { apply, sig: _tremoloSig });
}

/** Nicht glättbar: Form, Stereo-Schalter und (nur bei Stereo) der Phasenversatz — eine neue PeriodicWave braucht einen Neubau mit Überblendung. */
const _tremoloSig = q => (q.stereo === 'on' ? `${q.waveform}|on|${_cl(0, 180, Number.isFinite(q.phase) ? q.phase : 90)}` : `${q.waveform}|off`);

/**
 * Kanalgetrennte Verarbeitung: erzwingt 2 Kanäle vor einem Splitter. Das Hochmischen übernimmt ein StereoPanner bei pan 0 —
 * dieselbe Regel wie der terminale Panner (M-3, Suite 10): Mono → L = R mit −3,01 dB je Kanal, Stereo → unverändert. So liegt eine
 * Mono-Quelle hinter diesen Modulen auf demselben Pegel wie hinter jedem kanalerhaltenden Modul (kein +3-dB-Sprung, D2).
 */
function _stereoSplit(ctx) {
  const up = ctx.createStereoPanner();
  up.pan.value = 0;
  const split = ctx.createChannelSplitter(2);
  up.connect(split);
  return { input: up, split };
}

/** Oszillator mit Phasenversatz (PeriodicWave, modsources.js); gestartet und in `tr` eingetragen. */
function _phasedOsc(ctx, tr, shape, phaseDeg, rate) {
  const o = ctx.createOscillator();
  o.setPeriodicWave(makePhasedWave(ctx, shape, phaseDeg));
  o.frequency.value = rate;
  o.start();
  if (tr) tr.push(o);
  return o;
}

/**
 * Stereo-Tremolo (Phase 12a): je Kanal ein Gain = DC + LFO·Tiefe wie beim Mono-Tremolo, der rechte LFO läuft um `phase` Grad voraus
 * (beide LFOs aus PeriodicWave, gleich gestartet → fester Versatz). Mono-Quellen werden dabei zweikanalig (L = R = −3,01 dB vor der Modulation, wie am terminalen Panner).
 */
function _buildTremoloStereo(ctx, p, tr) {
  const shape = ['sine', 'triangle', 'square'].includes(p.waveform) ? p.waveform : 'sine';
  const ph = _cl(0, 180, Number.isFinite(p.phase) ? p.phase : 90);
  const rate0 = _cl(0.1, 20, p.rate ?? 5);
  const { input, split } = _stereoSplit(ctx);
  const merge = ctx.createChannelMerger(2);
  const lfoL = _phasedOsc(ctx, tr, shape, 0, rate0), lfoR = _phasedOsc(ctx, tr, shape, ph, rate0);
  const lgL = ctx.createGain(), lgR = ctx.createGain(), gL = ctx.createGain(), gR = ctx.createGain();
  const dcOffset = ctx.createConstantSource();
  gL.gain.value = 0; gR.gain.value = 0;
  split.connect(gL, 0); split.connect(gR, 1);
  gL.connect(merge, 0, 0); gR.connect(merge, 0, 1);
  lfoL.connect(lgL).connect(gL.gain); lfoR.connect(lgR).connect(gR.gain);
  dcOffset.connect(gL.gain); dcOffset.connect(gR.gain);
  dcOffset.start(); if (tr) tr.push(dcOffset);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const lg = _cl(0, 1, q.depth ?? 0.5) * 0.5;
    const r = _cl(0.1, 20, q.rate ?? 5);
    set(lfoL.frequency, r); set(lfoR.frequency, r);
    set(lgL.gain, lg); set(lgR.gain, lg);
    set(dcOffset.offset, 1 - lg);
  };
  apply(p, false);
  return _inst('tremolo', { input, output: merge }, p, { apply, sig: _tremoloSig });
}

/** Panwinkel-Kurven für Auto-Pan: Eingang Pan −1 … +1 → Kanalverstärkung √2·cos bzw. √2·sin von (Pan+1)·π/4 (Mitte = 1, Leistung konstant). */
const PAN_CURVE_POINTS = 1025;
let _panCurves = null;
function _panCurveFor(side) {
  if (!_panCurves) {
    const l = new Float32Array(PAN_CURVE_POINTS), r = new Float32Array(PAN_CURVE_POINTS);
    for (let i = 0; i < PAN_CURVE_POINTS; i++) {
      const th = (i / (PAN_CURVE_POINTS - 1)) * Math.PI / 2;      // Pan −1 → 0, +1 → π/2
      l[i] = Math.SQRT2 * Math.cos(th); r[i] = Math.SQRT2 * Math.sin(th);
    }
    l[PAN_CURVE_POINTS - 1] = 0; r[0] = 0;                        // exakt stumm am Anschlag
    _panCurves = { l, r };
  }
  return _panCurves[side];
}

/**
 * Auto-Pan (Phase 12a, Entscheidung „eigene Gains“): Breite (Mitte/Seite: L' = a·L + b·R, R' = b·L + a·R mit a = (1+w)/2, b = (1−w)/2),
 * dann je Kanal ein Gain, dessen Wert eine WaveShaper-Kurve aus dem Panwert (LFO · Tiefe) bildet. Startphase über PeriodicWave.
 * Live: Rate, Tiefe, Breite. Nicht glättbar: Form und Startphase (Neubau mit Überblendung).
 */
function _buildAutoPan(ctx, p, tr) {
  const shape = ['sine', 'triangle', 'square', 'saw'].includes(p.waveform) ? p.waveform : 'sine';
  const ph = _cl(0, 360, Number.isFinite(p.phase) ? p.phase : 0);
  const { input, split } = _stereoSplit(ctx);
  const merge = ctx.createChannelMerger(2);
  const aL = ctx.createGain(), bL = ctx.createGain(), aR = ctx.createGain(), bR = ctx.createGain();   // a: eigener Kanal, b: Gegenkanal
  const panL = ctx.createGain(), panR = ctx.createGain();
  panL.gain.value = 0; panR.gain.value = 0;                         // ausschließlich von den Kurven gesteuert
  split.connect(aL, 0); split.connect(bR, 0);                       // L → links (a), L → rechts (b)
  split.connect(aR, 1); split.connect(bL, 1);                       // R → rechts (a), R → links (b)
  aL.connect(panL); bL.connect(panL); aR.connect(panR); bR.connect(panR);
  panL.connect(merge, 0, 0); panR.connect(merge, 0, 1);
  const lfo = _phasedOsc(ctx, tr, shape, ph, _cl(0.01, 20, p.rate ?? 0.5));
  const depthGain = ctx.createGain();
  const shL = ctx.createWaveShaper(), shR = ctx.createWaveShaper();
  shL.curve = _panCurveFor('l'); shR.curve = _panCurveFor('r');
  lfo.connect(depthGain); depthGain.connect(shL); depthGain.connect(shR);
  shL.connect(panL.gain); shR.connect(panR.gain);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const w = _cl(0, 1, q.width ?? 1);
    set(lfo.frequency, _cl(0.01, 20, q.rate ?? 0.5));
    set(depthGain.gain, _cl(0, 1, q.depth ?? 1));
    set(aL.gain, (1 + w) / 2); set(aR.gain, (1 + w) / 2);
    set(bL.gain, (1 - w) / 2); set(bR.gain, (1 - w) / 2);
  };
  apply(p, false);
  return _inst('autoPan', { input, output: merge }, p, { apply, sig: q => `${q.waveform}|${_cl(0, 360, Number.isFinite(q.phase) ? q.phase : 0)}` });
}

/**
 * Utility (Phase 13a): eine 2×2-Kanalmatrix aus vier Gains hinter _stereoSplit (Mono → L = R mit −3,01 dB, M-3). Reihenfolge der Operationen:
 * Phase invertieren → Mono-Summe ((L + R)/2 auf beide Kanäle) → L/R tauschen → Panorama. Panorama-Modus `balance` (Standard) nach dem Gesetz von
 * Auto-Pan (12a): je Kanal √2·cos bzw. √2·sin von (pan + 1)·π/4, konstante Leistung; für eine Mono-Quelle genau wie der StereoPanner, bei Stereo eine
 * Balance (Gegenkanal wird leiser). Modus `stereo`: Formel des StereoPannerNode für zwei Kanäle (Gegenkanal wird hinübergemischt, nichts geht verloren).
 * Eine Mono-Quelle ist hier wie überall zweikanalig L = R (M-3); der Modus `stereo` hebt sie am Anschlag deshalb um +3,01 dB an (wie korrelierten
 * Stereo-Inhalt). Mitte (pan 0) ist in beiden Modi bit-neutral.
 * Alle Regler live: Schalter ändern nur Matrixwerte, die Glättung (SMOOTH_TC) blendet um, ohne Klick (Invertieren läuft dabei kurz durch 0).
 */
export function utilityMatrix(q) {
  const inv = q?.invert;
  const sL = inv === 'left' || inv === 'both' ? -1 : 1, sR = inv === 'right' || inv === 'both' ? -1 : 1;
  let m = [[sL, 0], [0, sR]];                                         // [Ausgang][Eingang]
  if (q?.mono === 'on') m = [[0.5 * sL, 0.5 * sR], [0.5 * sL, 0.5 * sR]];
  if (q?.swap === 'on') m = [m[1], m[0]];
  const pan = _cl(-1, 1, Number.isFinite(q?.pan) ? q.pan : 0);
  if (pan === 0) return m;                                            // Mitte: in beiden Modi exakt neutral
  const snap = v => (Math.abs(v) < 1e-9 ? 0 : v);                     // exakt still am Anschlag
  let P;
  if (q?.panMode === 'stereo') {
    // StereoPannerNode, zweikanaliger Eingang (Web-Audio-Spezifikation): pan ≤ 0 → x = pan + 1, L′ = L + R·cos(xπ/2), R′ = R·sin(xπ/2);
    // pan > 0 → x = pan, L′ = L·cos(xπ/2), R′ = R + L·sin(xπ/2).
    const x = pan <= 0 ? pan + 1 : pan, cL = snap(Math.cos(x * Math.PI / 2)), sR = snap(Math.sin(x * Math.PI / 2));
    P = pan <= 0 ? [[1, cL], [0, sR]] : [[cL, 0], [sR, 1]];
  } else {
    const th = (pan + 1) * Math.PI / 4;
    P = [[snap(Math.SQRT2 * Math.cos(th)), 0], [0, snap(Math.SQRT2 * Math.sin(th))]];
  }
  const mul = (o, i) => P[o][0] * m[0][i] + P[o][1] * m[1][i];
  return [[mul(0, 0), mul(0, 1)], [mul(1, 0), mul(1, 1)]];
}
function _buildUtility(ctx, p) {
  const { input, split } = _stereoSplit(ctx);
  const merge = ctx.createChannelMerger(2);
  const g = [[ctx.createGain(), ctx.createGain()], [ctx.createGain(), ctx.createGain()]];
  for (let o = 0; o < 2; o++) for (let i = 0; i < 2; i++) { split.connect(g[o][i], i); g[o][i].connect(merge, 0, o); }
  const apply = (q, sm) => {
    const set = _setter(ctx, sm), m = utilityMatrix(q);
    for (let o = 0; o < 2; o++) for (let i = 0; i < 2; i++) set(g[o][i].gain, m[o][i]);
  };
  apply(p, false);
  return _inst('utility', { input, output: merge }, p, { apply });
}

/**
 * Stereobreite (Phase 13a): Mitte M = (L + R)/2, Seite S = (L − R)/2; L′ = c·M + w·S′, R′ = c·M − w·S′ (w = Breite/100, c = Center-Pegel).
 * S′ = S + d·M(t − τ) (Dekorrelation, Entscheidung C, komplementärer Kammfilter mit τ = WIDTH_DECOR_DELAY_S): Eine Mono-Quelle hat S = 0, M/S allein
 * kann sie nicht verbreitern; mit d > 0 bekommt sie eine künstliche Seite. Die Mono-Summe (L′ + R′)/2 = c·M hängt weder von der Breite noch von der
 * Dekorrelation ab (keine Auslöschung). Bass-Mono: S′ läuft durch den LR4-Hochpass von buildCrossover2, M durch den passenden Allpass 2. Ordnung
 * (LP4 + HP4 = AP2), damit Mitte und Seite oberhalb der Grenze phasengleich bleiben. Mono-Quellen über _stereoSplit (M-3).
 * Live: Breite, Center, Dekorrelation, Grenzfrequenz. Nicht glättbar: Bass-Mono an/aus (Weiche wird eingefügt).
 */
function _buildWidth(ctx, p) {
  const bass = p.bassMono === 'on';
  const { input, split } = _stereoSplit(ctx);
  const merge = ctx.createChannelMerger(2);
  const mid = ctx.createGain(), side = ctx.createGain();             // Summenknoten
  const mL = ctx.createGain(), mR = ctx.createGain(), sL = ctx.createGain(), sR = ctx.createGain();
  mL.gain.value = 0.5; mR.gain.value = 0.5; sL.gain.value = 0.5; sR.gain.value = -0.5;
  split.connect(mL, 0); split.connect(mR, 1); split.connect(sL, 0); split.connect(sR, 1);
  mL.connect(mid); mR.connect(mid); sL.connect(side); sR.connect(side);
  const decor = ctx.createDelay(0.05), decorG = ctx.createGain();
  decor.delayTime.value = WIDTH_DECOR_DELAY_S;
  mid.connect(decor); decor.connect(decorG); decorG.connect(side);
  const centerG = ctx.createGain();
  mid.connect(centerG);
  let midOut = centerG, sideOut = side, xo = null, ap = null;
  const fOf = q => _cl(40, 500, Number.isFinite(q.bassFreq) ? q.bassFreq : 120);
  if (bass) {
    ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.Q.value = LR4_Q;
    centerG.connect(ap); midOut = ap;
    xo = buildCrossover2(ctx, fOf(p));
    side.connect(xo.input); sideOut = xo.high;
  }
  const wG = ctx.createGain(), inv = ctx.createGain();
  inv.gain.value = -1;
  sideOut.connect(wG); wG.connect(merge, 0, 0); wG.connect(inv); inv.connect(merge, 0, 1);
  midOut.connect(merge, 0, 0); midOut.connect(merge, 0, 1);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(wG.gain, _cl(0, 200, Number.isFinite(q.width) ? q.width : 100) / 100);
    set(centerG.gain, 10 ** (_cl(-24, 12, Number.isFinite(q.center) ? q.center : 0) / 20));
    set(decorG.gain, _cl(0, 1, Number.isFinite(q.decorrelate) ? q.decorrelate : 0));
    if (xo) { xo.setFrequency(fOf(q), set); set(ap.frequency, fOf(q)); }
  };
  apply(p, false);
  return _inst('width', { input, output: merge }, p, { apply, sig: q => (q.bassMono === 'on' ? 'bass' : 'flat') });
}

/** Haas (13c): Verzögerungspuffer je Kanal (s), reicht für 35 ms plus Glättung. */
export const HAAS_MAX_DELAY_S = 0.05;
/**
 * Haas (13c, freigegeben „langsamer gleiten“): Zeitkonstante (s) für Live-Änderungen der Verzögerung. Eine gleitende Verzögerung verschiebt die
 * Tonhöhe um den Faktor 1 − dτ/dt; mit SMOOTH_TC (15 ms) wären das beim Sprung 35 → 1 ms kurz das 3,3-Fache. Mit 0,15 s höchstens ≈ 23 %
 * (34 ms / 0,15 s), 95 % des Ziels nach ≈ 0,45 s. Pegel gleiten weiter mit SMOOTH_TC.
 */
export const HAAS_GLIDE_TC = 0.15;
/** Haas (13c): Kanalwerte aus den Parametern — { delay: [L, R] in s, gain: [L, R] }. Der Gegenkanal von `side` wird verzögert und mit `level` gewichtet. */
export function haasValues(q) {
  const d = _cl(1, 35, Number.isFinite(q?.time) ? q.time : 15) / 1000;
  const g = 10 ** (_cl(-24, 6, Number.isFinite(q?.level) ? q.level : 0) / 20);
  return q?.side === 'left' ? { delay: [0, d], gain: [1, g] } : { delay: [d, 0], gain: [g, 1] };
}
/**
 * Haas (Phase 13c): je Kanal ein DelayNode und ein Gain hinter _stereoSplit (Mono → L = R mit −3,01 dB, M-3), keine Rückkopplung. Der Klang wandert
 * zur Seite `side`, weil der Gegenkanal um `time` (1–35 ms) später kommt (Präzedenzeffekt); `level` setzt den Pegel des verzögerten Kanals.
 * Beide Kanäle haben immer eine eigene Verzögerung (die vordere steht auf 0): So ist auch der Seitenwechsel live — die eine Verzögerung gleitet
 * auf 0, die andere auf den Zielwert (Zeitkonstante HAAS_GLIDE_TC: kurzes Gleiten mit höchstens ≈ 23 % Tonhöhenabweichung statt Sprung). Die Mono-Summe ist ein Kammfilter (Kerben bei (2k + 1)/(2τ)).
 */
function _buildHaas(ctx, p) {
  const { input, split } = _stereoSplit(ctx);
  const merge = ctx.createChannelMerger(2);
  const dl = [ctx.createDelay(HAAS_MAX_DELAY_S), ctx.createDelay(HAAS_MAX_DELAY_S)], gn = [ctx.createGain(), ctx.createGain()];
  // Je Verzögerung genau ein Kanal (explizit): Chromium 153 [S] liefert sonst am DelayNode hinter Splitter-Ausgang 1 das erste Renderquantum
  // (128 Samples) still — der rechte Kanal setzte verspätet ein. Mit fester Kanalzahl nicht; in Node bit-gleich.
  for (const d of dl) { d.channelCount = 1; d.channelCountMode = 'explicit'; }
  for (let c = 0; c < 2; c++) { split.connect(dl[c], c); dl[c].connect(gn[c]); gn[c].connect(merge, 0, c); }
  const apply = (q, sm) => {
    const set = _setter(ctx, sm), v = haasValues(q);
    const setDelay = (param, x) => (sm ? param.setTargetAtTime(x, ctx.currentTime, HAAS_GLIDE_TC) : (param.value = x));
    for (let c = 0; c < 2; c++) { setDelay(dl[c].delayTime, v.delay[c]); set(gn[c].gain, v.gain[c]); }
  };
  apply(p, false);
  return _inst('haas', { input, output: merge }, p, { apply });
}

/**
 * Mitte/Seite kodieren (Phase 13b): M = (L + R)/2, S = (L − R)/2 hinter _stereoSplit. Liefert die Eingangshülle, die beiden Summenknoten und
 * `decode(m, s)`, das L = M + S, R = M − S in einen ChannelMerger schreibt (exakt neutral, wenn m und s unverändert bleiben).
 */
function _msCodec(ctx) {
  const { input, split } = _stereoSplit(ctx);
  const mid = ctx.createGain(), side = ctx.createGain();
  const mL = ctx.createGain(), mR = ctx.createGain(), sL = ctx.createGain(), sR = ctx.createGain();
  mL.gain.value = 0.5; mR.gain.value = 0.5; sL.gain.value = 0.5; sR.gain.value = -0.5;
  split.connect(mL, 0); split.connect(mR, 1); split.connect(sL, 0); split.connect(sR, 1);
  mL.connect(mid); mR.connect(mid); sL.connect(side); sR.connect(side);
  const merge = ctx.createChannelMerger(2);
  const decode = (m, s) => {
    const inv = ctx.createGain(); inv.gain.value = -1;
    m.connect(merge, 0, 0); m.connect(merge, 0, 1);
    s.connect(merge, 0, 0); s.connect(inv); inv.connect(merge, 0, 1);
  };
  return { input, mid, side, merge, decode };
}

/**
 * Mid/Side (Phase 13b): Mitte und Seite getrennt mit Pegel und je einer EQ-Kette (Tiefen-Shelf → Glocke → Höhen-Shelf, BiquadFilter).
 * Standardwerte (alle Gains 0 dB) sind ein Nulltest. Alle Regler live. Eine Mono-Quelle hat keine Seite: dort wirkt nur der Mitte-Zweig.
 */
function _buildMidSide(ctx, p) {
  const ms = _msCodec(ctx);
  const chain = ch => {
    const g = ctx.createGain();
    const ls = ctx.createBiquadFilter(), pk = ctx.createBiquadFilter(), hs = ctx.createBiquadFilter();
    ls.type = 'lowshelf'; pk.type = 'peaking'; hs.type = 'highshelf';
    g.connect(ls); ls.connect(pk); pk.connect(hs);
    return { ch, g, ls, pk, hs };
  };
  const cm = chain('mid'), cs = chain('side');
  ms.mid.connect(cm.g); ms.side.connect(cs.g);
  ms.decode(cm.hs, cs.hs);
  const num = (q, k, lo, hi) => _cl(lo, hi, Number.isFinite(q[k]) ? q[k] : MS_EQ_DEF[k.replace(/^(mid|side)/, '')]);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    for (const c of [cm, cs]) {
      const k = c.ch;
      set(c.g.gain, 10 ** (_cl(-24, 12, Number.isFinite(q[`${k}Gain`]) ? q[`${k}Gain`] : 0) / 20));
      set(c.ls.gain, num(q, `${k}LowGain`, -18, 18)); set(c.ls.frequency, num(q, `${k}LowFreq`, 20, 1000));
      set(c.pk.gain, num(q, `${k}PeakGain`, -18, 18)); set(c.pk.frequency, num(q, `${k}PeakFreq`, 50, 15000)); set(c.pk.Q, num(q, `${k}PeakQ`, 0.1, 10));
      set(c.hs.gain, num(q, `${k}HighGain`, -18, 18)); set(c.hs.frequency, num(q, `${k}HighFreq`, 1000, 20000));
    }
  };
  apply(p, false);
  return _inst('midSide', { input: ms.input, output: ms.merge }, p, { apply });
}

/**
 * Stereo-Shaper (Phase 13b): Breite in drei Bändern. Die Seite läuft durch die LR4-Dreibandweiche (buildCrossover3, 11e), je Band ein Breiten-Gain;
 * die Mitte durch die beiden passenden Allpässe 2. Ordnung (Summe der Weiche = AP(f1)·AP(f2)), damit Mitte und Seite phasengleich bleiben.
 * Folge: Alle Breiten 100 % sind KEIN Nulltest, sondern ein Allpass (Betrag flach, Phase gedreht, in L und R gleich). Mono-Summe = AP(M) (flach).
 * Live: Weichenfrequenzen und Breiten. Eine Mono-Quelle hat keine Seite: der Shaper ändert dort nur die Phase.
 */
function _buildStereoShaper(ctx, p) {
  const f1Of = q => _cl(40, 800, Number.isFinite(q.crossLow) ? q.crossLow : 200);
  const f2Of = q => _cl(1000, 12000, Number.isFinite(q.crossHigh) ? q.crossHigh : 2500);
  const ms = _msCodec(ctx);
  const ap1 = ctx.createBiquadFilter(), ap2 = ctx.createBiquadFilter();
  ap1.type = 'allpass'; ap2.type = 'allpass'; ap1.Q.value = LR4_Q; ap2.Q.value = LR4_Q;
  ms.mid.connect(ap1); ap1.connect(ap2);
  const xo = buildCrossover3(ctx, f1Of(p), f2Of(p));
  ms.side.connect(xo.input);
  const sideSum = ctx.createGain();
  const bands = ['low', 'mid', 'high'].map((b, i) => { const g = ctx.createGain(); xo.outputs[i].connect(g); g.connect(sideSum); return { b, g }; });
  ms.decode(ap2, sideSum);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    xo.setFrequencies(f1Of(q), f2Of(q), set);
    set(ap1.frequency, f1Of(q)); set(ap2.frequency, f2Of(q));
    for (const { b, g } of bands) { const v = q[`${b}Width`]; set(g.gain, _cl(0, 200, Number.isFinite(v) ? v : 100) / 100); }
  };
  apply(p, false);
  return _inst('stereoShaper', { input: ms.input, output: ms.merge }, p, { apply });
}

/**
 * Modulierte Delay-Line, gemeinsame Basis für Chorus (lang, kein
 * Feedback) und Flanger (kurz, mit Feedback) — siehe _buildChorus/
 * _buildFlanger. `maxDelay` (Sekunden) begrenzt den DelayNode-Puffer und
 * muss baseDelay+depth mit Sicherheitsabstand abdecken, sonst würde die
 * LFO-Modulation bei hohen depth-Werten den erlaubten Bereich verlassen.
 */
function _buildModulatedDelay(ctx, p, { key, withFeedback, maxDelay = 0.05, shape = 'sine' }, tr) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(maxDelay);
  const lfo = ctx.createOscillator();
  lfo.type = shape;
  const lfoGain = ctx.createGain();
  const wetGain = ctx.createGain();
  const dryGain = ctx.createGain();
  const fb = withFeedback ? ctx.createGain() : null;
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(delay.delayTime, Math.max(0, (q.baseDelay ?? 15) / 1000));
    set(lfo.frequency, Math.max(0.01, Math.min(10, q.rate ?? 0.8)));
    set(lfoGain.gain, Math.max(0, (q.depth ?? 8) / 1000));       // ms -> s
    const w = Math.max(0, Math.min(1, q.mix ?? 0.3));
    set(wetGain.gain, w);
    set(dryGain.gain, 1 - (sm ? w : wetGain.gain.value));
    if (fb) set(fb.gain, Math.max(0, Math.min(0.95, q.feedback ?? 0.5)));
  };
  apply(p, false);
  lfo.connect(lfoGain).connect(delay.delayTime);
  lfo.start();
  if (tr) tr.push(lfo);

  const output = ctx.createGain();
  input.connect(dryGain).connect(output);
  input.connect(delay);
  if (fb) delay.connect(fb).connect(delay);
  delay.connect(wetGain).connect(output);

  return _inst(key, { input, output }, p, { apply });
}

// Chorus: lange Basis-Delay-Zeit (10-30ms), kein Feedback — "mehrere
// leicht verstimmte Stimmen". Flanger: sehr kurze Basis-Delay-Zeit
// (0.5-5ms) MIT Feedback — Kammfilter-/"Jet"-Effekt.
// maxDelay-Puffer bewusst mit Sicherheitsabstand über dem theoretischen
// Maximum von baseDelay+depth (Chorus: 40+20=60ms, Flanger: 5+20=25ms aus
// den jeweiligen Parametertabellen) gewählt — DelayNode moduliert additiv
// (delayTime-AudioParam + LFO-Signal), ein zu knapper Puffer würde die
// LFO-Modulation bei hohen depth-Werten stillschweigend kappen.
function _buildChorus(ctx, p, tr) {
  if (chorusIsMulti(p)) return _buildChorusVoices(ctx, p, tr);   // Phase 12b; 1 Stimme im Modus „chorus“: Graph unverändert (bit-gleich)
  const seg = _buildModulatedDelay(ctx, p, { key: 'chorus',  withFeedback: false, maxDelay: 0.08 }, tr);
  const s0 = _chorusSig(p), up = seg.update;
  seg.update = np => (_chorusSig(np) !== s0 ? false : up(np));   // Wechsel zu mehreren Stimmen/Ensemble = Strukturänderung
  return seg;
}
const _chorusSig = q => (chorusIsMulti(q) ? `${q.mode === 'ensemble' ? 'ens' : 'ch'}|${chorusVoices(q)}` : 'legacy');

/** Ensemble (12b): zusätzlicher schneller LFO je Stimme (feste Rate) für das typische „Schimmern“ der String-Ensembles.
 *  K3: Sein Anteil an der Tiefe ist der Regler `fastShare` („Schimmern“, 0–0,5); fehlt das Feld, gilt der bisherige feste Wert 0,12 (bit-gleich). */
const ENSEMBLE_FAST_HZ = 6;
const ENSEMBLE_FAST_SHARE = 0.12;
const _ensembleShare = q => _cl(0, 0.5, Number.isFinite(q?.fastShare) ? q.fastShare : ENSEMBLE_FAST_SHARE);

/**
 * Chorus mit mehreren Stimmen (Phase 12b): je Stimme eine modulierte Verzögerung, LFO-Phasen gleichmäßig versetzt (i·360°/N, PeriodicWave),
 * Stimmenpegel 1/√N (Leistung wie eine Stimme), Position je Stimme gleichmäßig in ±spread (Gains √2·cos/√2·sin wie Auto-Pan, Mitte = 1).
 * Ensemble = 3 Stimmen + schneller Zusatz-LFO (Anteil `fastShare`, K3; live). Trocken- und Stimmenpfad laufen über einen StereoPanner bei pan 0 (Mono → −3,01 dB je Kanal,
 * M-3), damit eine Mono-Quelle denselben Pegel behält wie hinter jedem kanalerhaltenden Modul. Live: Grundverzögerung, Tiefe, Rate, Mix, spread.
 */
function _buildChorusVoices(ctx, p, tr) {
  const ens = p.mode === 'ensemble', n = chorusVoices(p);
  const input = ctx.createGain(), output = ctx.createGain();
  const dryUp = ctx.createStereoPanner(); dryUp.pan.value = 0;
  const dryGain = ctx.createGain(), wetGain = ctx.createGain();
  input.connect(dryUp).connect(dryGain).connect(output);
  const merge = ctx.createChannelMerger(2);
  merge.connect(wetGain).connect(output);
  const voices = [];
  for (let i = 0; i < n; i++) {
    const delay = ctx.createDelay(0.08);
    const lfo = _phasedOsc(ctx, tr, 'sine', (i * 360) / n, 0.8);
    const lfoGain = ctx.createGain();
    lfo.connect(lfoGain).connect(delay.delayTime);
    let fast = null, fastGain = null;
    if (ens) {
      fast = _phasedOsc(ctx, tr, 'sine', (i * 360) / n + 90, ENSEMBLE_FAST_HZ);
      fastGain = ctx.createGain();
      fast.connect(fastGain).connect(delay.delayTime);
    }
    const lvl = ctx.createGain(); lvl.gain.value = 1 / Math.sqrt(n);
    const { input: vIn, split } = _stereoSplit(ctx);
    const gL = ctx.createGain(), gR = ctx.createGain();
    input.connect(delay); delay.connect(lvl).connect(vIn);
    split.connect(gL, 0); split.connect(gR, 1);
    gL.connect(merge, 0, 0); gR.connect(merge, 0, 1);
    voices.push({ delay, lfo, lfoGain, fastGain, gL, gR, pos: n > 1 ? -1 + (2 * i) / (n - 1) : 0 });
  }
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const base = Math.max(0, (q.baseDelay ?? 15) / 1000), depth = Math.max(0, (q.depth ?? 8) / 1000);
    const rate = Math.max(0.01, Math.min(10, q.rate ?? 0.8)), spread = _cl(0, 1, q.spread ?? 0);
    const w = _cl(0, 1, q.mix ?? 0.3), share = ens ? _ensembleShare(q) : 0;
    for (const v of voices) {
      set(v.delay.delayTime, base);
      set(v.lfo.frequency, rate);
      set(v.lfoGain.gain, depth * (ens ? 1 - share : 1));
      if (v.fastGain) set(v.fastGain.gain, depth * share);
      const th = (v.pos * spread + 1) * Math.PI / 4;
      set(v.gL.gain, Math.SQRT2 * Math.cos(th)); set(v.gR.gain, Math.SQRT2 * Math.sin(th));
    }
    set(wetGain.gain, w); set(dryGain.gain, 1 - w);
  };
  apply(p, false);
  return _inst('chorus', { input, output }, p, { apply, sig: _chorusSig });
}

/**
 * Phaser (Phase 12d): Worklet `delayline` Modus 1 (Rückkopplung live). Ohne Worklet: native Kette aus stages/2 BiquadFilter 'allpass' (Q 0,5,
 * dieselbe Formel wie der Rechenkern), Mittenfrequenz über `detune` (± depth · 2400 Cent, LFO Sinus); Rückkopplung wirkt dort nicht
 * (Zyklus ohne DelayNode wäre stumm, R-01), Marke `fallback = 'native'`. Kanalerhaltend. Nicht glättbar: Stufenzahl.
 */
function _buildPhaser(ctx, p, tr) {
  const sig = q => String(phaserStages(q));
  const node = makePhaserNode(ctx, p);
  if (node) {
    if (tr) tr.push({ stop() { node.dispose(); } });
    return _inst('phaser', { input: node.input, output: node.output }, p, { apply: q => node.update(q), sig });
  }
  const K = phaserStages(p) / 2;
  const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  const depthGain = ctx.createGain();
  lfo.connect(depthGain); lfo.start(); if (tr) tr.push(lfo);
  let last = input;
  const aps = [];
  for (let i = 0; i < K; i++) {
    const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.Q.value = 0.5;
    depthGain.connect(ap.detune);
    last.connect(ap); last = ap; aps.push(ap);
  }
  last.connect(wet).connect(output);
  input.connect(dry).connect(output);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const f = _cl(100, 8000, q.center ?? 800);
    for (const ap of aps) set(ap.frequency, f);
    set(lfo.frequency, _cl(0.01, 10, q.rate ?? 0.5));
    set(depthGain.gain, _cl(0, 1, q.depth ?? 0.7) * 2400);
    const w = _cl(0, 1, q.mix ?? 0.5);
    set(wet.gain, w); set(dry.gain, 1 - w);
  };
  apply(p, false);
  const seg = _inst('phaser', { input, output }, p, { apply, sig });
  seg.fallback = 'native';
  return seg;
}

/**
 * Vibrato (Phase 12b): Verzögerung D(t) = D0 + A·LFO(t), Tonhöhe ∝ 1 − dD/dt. A aus der Spitzenabweichung in Cent (vibratoSwing, Registry),
 * D0 = A + 0,5 ms (nie negativ). Kanalerhaltend (DelayNode). Live: Rate, Tiefe, Mix (Tiefe/Rate verschieben D0 geglättet — kurzes Gleiten).
 * Nicht glättbar: Wellenform.
 */
function _buildVibrato(ctx, p, tr) {
  const shape = p.waveform === 'triangle' ? 'triangle' : 'sine';
  const input = ctx.createGain(), output = ctx.createGain();
  const delay = ctx.createDelay(0.25);
  const lfo = ctx.createOscillator(); lfo.type = shape;
  const lfoGain = ctx.createGain(), wetGain = ctx.createGain(), dryGain = ctx.createGain();
  lfo.connect(lfoGain).connect(delay.delayTime);
  lfo.start(); if (tr) tr.push(lfo);
  input.connect(delay).connect(wetGain).connect(output);
  input.connect(dryGain).connect(output);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const rate = _cl(0.1, 20, q.rate ?? 5);
    const a = vibratoSwing(_cl(0, 100, q.depth ?? 20), rate, shape);
    set(lfo.frequency, rate);
    set(lfoGain.gain, a);
    set(delay.delayTime, a + 0.0005);
    const w = _cl(0, 1, q.mix ?? 1);
    set(wetGain.gain, w); set(dryGain.gain, 1 - w);
  };
  apply(p, false);
  return _inst('vibrato', { input, output }, p, { apply, sig: q => String(q.waveform === 'triangle' ? 'triangle' : 'sine') });
}
/**
 * Flanger (Phase 12c, Entscheidung E1): Worklet `delayline` in allen Motoren — Verzögerung ab 3 Samples, sample-genaue Rückkopplung (B-14).
 * `phase` > 0 (E3): StereoPanner bei pan 0 davor (Mono → L = R mit −3,01 dB, M-3), der rechte LFO läuft um `phase` voraus; bei 0 bleibt Mono mono.
 * Live: alle Regler außer der Wellenform (Neubau mit Überblendung) und dem Wechsel phase 0 ↔ > 0 (Kanalzahl, Neubau).
 * Ohne Worklet: bisheriger nativer Graph (Form Sinus/Dreieck, ohne L/R-Versatz), Marke `fallback = 'native'`.
 */
const _flangerSig = q => `${q.waveform === 'triangle' ? 'tri' : 'sine'}|${(Number(q.phase) || 0) > 0 ? 'st' : 'mono'}`;
function _buildFlanger(ctx, p, tr) {
  const node = makeFlangerNode(ctx, p);
  if (!node) {
    const seg = _buildModulatedDelay(ctx, p, { key: 'flanger', withFeedback: true, maxDelay: 0.04, shape: p.waveform === 'triangle' ? 'triangle' : 'sine' }, tr);
    const s0 = _flangerSig(p), up = seg.update;
    seg.update = np => (_flangerSig(np) !== s0 ? false : up(np));
    seg.fallback = 'native';
    return seg;
  }
  if (tr) tr.push({ stop() { node.dispose(); } });
  let input = node.input;
  if ((Number(p.phase) || 0) > 0) { input = ctx.createStereoPanner(); input.pan.value = 0; input.connect(node.input); }
  return _inst('flanger', { input, output: node.output }, p, { apply: q => node.update(q), sig: _flangerSig });
}

/**
 * Wahwah — LFO-modulierter Bandpass, klassischer "Wah"-Sweep-Klang.
 * depthHz wird proportional zur Basisfrequenz skaliert, damit "depth" bei jeder
 * Basisfrequenz einen vergleichbar hörbaren Sweep-Bereich ergibt (ein fixer Hz-Wert
 * würde bei niedrigem baseFreq unverhältnismäßig groß wirken).
 */
/**
 * Hüllkurven-Steuerung (P10c): Eingangssignal → Envelope-Follower (Worklet) → Empfindlichkeit → Begrenzung auf 0…1 → Tiefe → Zielparameter.
 * Liefert null, wenn das Worklet im Context nicht geladen ist (Aufrufer fällt auf den LFO zurück, Hinweis über das Ereignis `sb:fx-fallback`).
 */
function _buildEnvelopeControl(ctx, tr, from, depthGain, label) {
  const env = makeEnvelopeFollower(ctx, { attack: 0.005, release: 0.15, mode: 'peak' });
  if (!env) {
    console.warn(`[audio] ${label}: Hüllkurve nicht verfügbar (Worklet fehlt) — LFO-Ersatz`);
    try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sb:fx-fallback', { detail: { module: label, reason: 'envfollower' } })); } catch (e) { /* ohne Fenster */ }
    return null;
  }
  const scale = ctx.createGain();
  const limit = ctx.createWaveShaper(); limit.curve = new Float32Array([0, 0, 1]);   // y = max(0, min(1, x)) für x ∈ [−1, 1]; Hüllkurve ist ≥ 0
  from.connect(env.input); env.output.connect(scale); scale.connect(limit); limit.connect(depthGain);
  if (tr) tr.push({ stop() { env.dispose(); try { scale.disconnect(); limit.disconnect(); } catch (e) { /* bereits getrennt */ } } });
  return { scale };
}
/** Empfindlichkeit 0…1 → Verstärkung der Hüllkurve (0,5 … 8). */
const _sensGain = s => 0.5 + Math.max(0, Math.min(1, s ?? 0.5)) * 7.5;

/**
 * Parametrischer EQ (10d): je aktives Band (höchstens 8, ausgeschaltete entfallen) ein Biquad in Serie. Gain wirkt bei Glocke/Shelves,
 * Q bei Glocke/Bandpass/Notch (linear) und bei Low-/High-Cut (Resonanz; für BiquadFilterNode in dB umgerechnet), Shelves ignorieren Q.
 * Strukturell (neu bauen): Anzahl und Typen der aktiven Bänder. Frequenz, Gain und Q laufen live. Ohne aktive Bänder: Durchgang.
 */
const _PEQ_BIQUAD = { bell: 'peaking', lowShelf: 'lowshelf', highShelf: 'highshelf', lowCut: 'highpass', highCut: 'lowpass', bandPass: 'bandpass', notch: 'notch' };
function _buildParamEq(ctx, p) {
  const list = peqActiveBands(p);
  const nodes = list.map(b => { const n = ctx.createBiquadFilter(); n.type = _PEQ_BIQUAD[b.type] || 'peaking'; return n; });
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  const pass = nodes.length ? null : ctx.createGain();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm), act = peqActiveBands(q);
    act.forEach((b, i) => {
      const n = nodes[i]; if (!n) return;
      set(n.frequency, Math.max(20, Math.min(20000, b.freq ?? 1000)));
      if (b.type === 'bell' || b.type === 'lowShelf' || b.type === 'highShelf') set(n.gain, Math.max(-24, Math.min(24, b.gain ?? 0)));
      const qLin = Math.max(0.1, Math.min(18, b.Q ?? 1));
      if (b.type === 'lowCut' || b.type === 'highCut') set(n.Q, 20 * Math.log10(qLin));
      else if (b.type !== 'lowShelf' && b.type !== 'highShelf') set(n.Q, qLin);
    });
  };
  apply(p, false);
  return _inst('paramEq', { input: pass || nodes[0], output: pass || nodes[nodes.length - 1] }, p, { apply, sig: q => peqActiveBands(q).map(b => b.type).join(',') });
}

function _buildWahwah(ctx, p, tr) {
  const wantEnv = p.source === 'envelope';
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  const lfoGain = ctx.createGain();     // Tiefe in Hz (für LFO ±, für Hüllkurve 0 … +)
  let lfo = null, envCtl = null, inp = filter;
  if (wantEnv) {
    inp = ctx.createGain(); inp.connect(filter);
    envCtl = _buildEnvelopeControl(ctx, tr, inp, lfoGain, 'Wah-Wah');
    if (envCtl) lfoGain.connect(filter.frequency);
  }
  if (!envCtl) {   // Standard (und Ersatz ohne Worklet): LFO — Graph wie vor 10c
    lfo = ctx.createOscillator(); lfo.type = 'sine';
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    if (tr) tr.push(lfo);
  }
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const baseFreq = Math.max(100, Math.min(5000, q.frequency ?? 800));
    const depthHz  = Math.max(0, Math.min(1, q.depth ?? 0.7)) * baseFreq * 3;
    set(filter.frequency, baseFreq);
    set(filter.Q, Math.max(1, Math.min(20, q.resonance ?? 5)));
    if (lfo) set(lfo.frequency, Math.max(0.1, Math.min(10, q.rate ?? 2)));
    set(lfoGain.gain, depthHz);
    if (envCtl) set(envCtl.scale.gain, _sensGain(q.sensitivity));
  };
  apply(p, false);
  const seg = _inst('wahwah', { input: inp, output: filter }, p, { apply, sig: q => (q.source === 'envelope' ? 'env' : 'lfo') });
  if (wantEnv && !envCtl) seg.fallback = 'lfo';
  return seg;
}

/**
 * Auto-Filter (P10c): Biquad (Tief-/Band-/Hochpass), Grundfrequenz moduliert über `detune` (Cent → exponentiell wie das Gehör):
 * LFO: ± Tiefe·2400 Cent; Hüllkurve: 0 … +Tiefe·4800 Cent (laut = Filter öffnet sich). Resonanz = lineare Güte Q
 * (bei Tief-/Hochpass in dB umgerechnet, weil BiquadFilterNode dort dB erwartet).
 */
function _buildAutoFilter(ctx, p, tr) {
  const wantEnv = p.source === 'envelope';
  const filter = ctx.createBiquadFilter();
  const depthGain = ctx.createGain();
  let lfo = null, envCtl = null, inp = filter;
  if (wantEnv) {
    inp = ctx.createGain(); inp.connect(filter);
    envCtl = _buildEnvelopeControl(ctx, tr, inp, depthGain, 'Auto-Filter');
  }
  if (!envCtl) { lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.connect(depthGain); lfo.start(); if (tr) tr.push(lfo); }
  depthGain.connect(filter.detune);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const type = ['lowpass', 'bandpass', 'highpass'].includes(q.filterType) ? q.filterType : 'lowpass';
    if (filter.type !== type) filter.type = type;
    const qLin = Math.max(0.5, Math.min(20, q.resonance ?? 3));
    set(filter.frequency, Math.max(50, Math.min(10000, q.frequency ?? 600)));
    set(filter.Q, type === 'bandpass' ? qLin : 20 * Math.log10(qLin));
    const depth = Math.max(0, Math.min(1, q.depth ?? 0.7));
    set(depthGain.gain, depth * (envCtl ? 4800 : 2400));
    if (lfo) set(lfo.frequency, Math.max(0.1, Math.min(10, q.rate ?? 2)));
    if (envCtl) set(envCtl.scale.gain, _sensGain(q.sensitivity));
  };
  apply(p, false);
  const seg = _inst('autoFilter', { input: inp, output: filter }, p, { apply, sig: q => (q.source === 'envelope' ? 'env' : 'lfo') });
  if (wantEnv && !envCtl) seg.fallback = 'lfo';
  return seg;
}

/**
 * Ring Modulation — Träger-Oszillator moduliert direkt den Gain des Eingangssignals
 * (Web-Audio-Parameter-Modulation: bei Oszillator-Amplitude ±1 und Gain-Basiswert 0 entspricht das einer
 * echten Multiplikation Input×Träger; nur Sinusform, 20–5000 Hz).
 */
function _buildRingMod(ctx, p, tr) {
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  const ringGain = ctx.createGain(); ringGain.gain.value = 0; // Träger moduliert direkt den Gain
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(carrier.frequency, Math.max(20, Math.min(5000, q.frequency ?? 440)));
    const w = Math.max(0, Math.min(1, q.mix ?? 1));
    set(wet.gain, w);
    set(dry.gain, 1 - (sm ? w : wet.gain.value));
  };
  apply(p, false);
  carrier.connect(ringGain.gain);
  carrier.start();
  if (tr) tr.push(carrier);

  const input = ctx.createGain(); const output = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(ringGain).connect(wet).connect(output);

  return _inst('ringmod', { input, output }, p, { apply });
}

/** Gemeinsame Hall-Hülle: Dry/Wet um einen Convolver. `wetOf(p)` liefert den Anteil; die IR ist nicht glättbar → Modul-Austausch (P10f). */
function _buildConvolverModule(ctx, p, tr, { key, wetOf, irOf, sig }) {
  const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const wet = wetOf(q);
    set(dry.gain, 1 - wet); set(wetG.gain, wet);
  };
  apply(p, false);
  const make = q => {
    const conv = ctx.createConvolver();
    conv.buffer = irOf(ctx, q);
    return { input: conv, output: conv, dispose() { try { conv.buffer = null; } catch (e) { /* Knoten bereits verworfen */ } } };   // Chrome-Leck (L-02)
  };
  const slot = _hotSlot(ctx, tr, make, p, sig, { fadeSec: 0.05, throttleMs: 150, power: true });
  const inp = slot.input;
  inp.connect(dry); slot.output.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return _inst(key, { input: inp, output: out }, p, { apply, sig, hot: slot });
}

function _buildReverb(ctx, p, tr) {
  return _buildConvolverModule(ctx, p, tr, {
    key: 'reverb', wetOf: q => Math.max(0, Math.min(1, q.amount ?? 0.35)), irOf: getGenericIR,
    sig: q => `${q.duration ?? 2.2}|${q.decay ?? 2.0}|${q.pre ?? 0.005}`
  });
}

function _buildIRReverb(ctx, p, tr) {
  return _buildConvolverModule(ctx, p, tr, {
    key: 'irReverb', wetOf: q => Math.max(0, Math.min(1, q.wet ?? 0.35)), irOf: (c, q) => getIRBuffer(c, q.impulse, q.irMax),
    sig: q => String(q.impulse)
  });
}

/**
 * Delay v2 (Phase 14a). Modus mono mit neutralen neuen Feldern (delayIsLegacy) baut exakt den bisherigen Graphen (_buildDelayLegacy, bit-gleich).
 * Sonst je Seite eine Schleife: Delay → Low-Cut (Hochpass) → High-Cut (Tiefpass) → Ausgang (Wet) und → Rückkopplungs-Gain → Schutzsättigung → zurück
 * ins Delay. Echo k ist also k-mal gefiltert (High-Cut senkt die Höhen je Wiederholung). Jede Schleife enthält ein Delay ≥ DELAY_MIN_S (> 128 Samples).
 *   mono:     kanalerhaltend (wie bisher), eine Schleife.
 *   stereo:   hinter _stereoSplit (Mono → L = R mit −3,01 dB, M-3) je Kanal eine Schleife mit eigener Zeit; Kreuz-Rückkopplung L ↔ R vor der Sättigung.
 *   pingpong: Mono-Summe ½(L + R) → links → rechts → links …, Abstand `time` je Seitenwechsel.
 * Modulation: ein Sinus-LFO auf allen Verzögerungen (rechts gegenphasig), Tiefe höchstens die halbe kleinste Zeit.
 * Strukturell (Neubau mit Überblendung): Modus und der Übergang bisheriges ↔ erweitertes Delay. Alles andere ist live.
 * Chromium [S, 13c/14]: jede Wiederholung eines nativen Rückkopplungszyklus kommt +128 Samples später (bekannt, Entscheidung A P14: dokumentiert, nicht ausgeglichen).
 *   multitap (14b): Summe (L + R)/√2 → je Tap eigenes Delay → Filter → Pegel → StereoPanner (Equal-Power; Mono-Quelle in der Mitte = −3,01 dB wie M-3)
 *             → Wet; je Tap optional eine eigene Rückkopplungsschleife (Gain → Schutzsättigung → zurück ins Tap-Delay). Strukturell zusätzlich: welche Taps gebaut
 *             werden (Ein/Aus, Hinzufügen, Entfernen); Zeit, Pegel, Panorama und Rückkopplung der Taps sind live.
 */
const _delaySig = q => (delayIsLegacy(q) ? 'legacy' : delayMode(q) === 'multitap' ? `multitap:${delayActiveTaps(q).map(([, i]) => i).join(',')}` : delayMode(q));
/** Schutzsättigung (P14a): bis ±0,5 linear, darüber weich (tanh-Knie mit stetiger Steigung); Eingänge jenseits ±1 hält der WaveShaper auf dem Randwert ±0,88. */
export const DELAY_GUARD_KNEE = 0.5;
let _guardCurve = null;
export function delayGuardCurve() {
  if (_guardCurve) return _guardCurve;
  const N = 2049, c = new Float32Array(N), T = DELAY_GUARD_KNEE;
  for (let i = 0; i < N; i++) {
    const x = i / 1024 - 1, a = Math.abs(x);
    c[i] = a <= T ? x : Math.sign(x) * (T + (1 - T) * Math.tanh((a - T) / (1 - T)));
  }
  return (_guardCurve = c);
}
const DELAY_MAX_BUFFER_S = 2 + DELAY_MOD_MAX_MS / 1000 + 0.01;
function _delayLoop(ctx, explicitMono) {
  const d = ctx.createDelay(DELAY_MAX_BUFFER_S);
  // Kanalzahl fest 1 hinter Splitter-Ausgängen (Chromium-Regel aus 13c: sonst ist das erste Renderquantum still).
  if (explicitMono) { d.channelCount = 1; d.channelCountMode = 'explicit'; }
  const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
  hp.type = 'highpass'; lp.type = 'lowpass'; hp.Q.value = LR4_Q_DB; lp.Q.value = LR4_Q_DB;   // Butterworth (Q in dB)
  const fb = ctx.createGain(), guard = ctx.createWaveShaper();
  guard.curve = delayGuardCurve();
  d.connect(hp); hp.connect(lp); lp.connect(fb); fb.connect(guard);
  return { d, hp, lp, fb, guard, out: lp };
}
function _buildDelay(ctx, p, tr) {
  return delayIsLegacy(p) ? _buildDelayLegacy(ctx, p) : _buildDelayV2(ctx, p, tr);
}
function _buildDelayV2(ctx, p, tr) {
  const mode = delayMode(p);
  if (mode === 'multitap') return _buildDelayMultiTap(ctx, p, tr);
  const out = ctx.createGain(), dry = ctx.createGain(), wetG = ctx.createGain();
  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  let input, loops, cross = null;
  if (mode === 'mono') {
    input = ctx.createGain();
    const L = _delayLoop(ctx, false);
    input.connect(L.d); L.guard.connect(L.d); L.out.connect(wetG);
    loops = [L];
  } else {
    const st = _stereoSplit(ctx);
    input = st.input;
    const merge = ctx.createChannelMerger(2);
    const L = _delayLoop(ctx, true), R = _delayLoop(ctx, true);
    L.out.connect(merge, 0, 0); R.out.connect(merge, 0, 1); merge.connect(wetG);
    if (mode === 'stereo') {
      st.split.connect(L.d, 0); st.split.connect(R.d, 1);
      L.guard.connect(L.d); R.guard.connect(R.d);
      cross = [ctx.createGain(), ctx.createGain()];                  // L → rechte Schleife, R → linke Schleife (vor der Sättigung)
      L.out.connect(cross[0]); cross[0].connect(R.guard);
      R.out.connect(cross[1]); cross[1].connect(L.guard);
    } else {
      const sum = ctx.createGain(); sum.gain.value = 0.5;           // ½(L + R)
      sum.channelCount = 1; sum.channelCountMode = 'explicit';
      st.split.connect(sum, 0); st.split.connect(sum, 1);
      sum.connect(L.d);
      L.guard.connect(R.d); R.guard.connect(L.d);                    // Ping-Pong: Seitenwechsel je Wiederholung
    }
    loops = [L, R];
  }
  const mods = loops.map(() => ctx.createGain());
  loops.forEach((l, i) => { lfo.connect(mods[i]); mods[i].connect(l.d.delayTime); });
  input.connect(dry); dry.connect(out); wetG.connect(out);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const T = (v, d) => _cl(DELAY_MIN_S, 2, Number.isFinite(v) ? v : d);
    const times = mode === 'stereo' ? [T(q.timeL, 0.22), T(q.timeR, 0.33)] : loops.map(() => T(q.time, 0.22));
    const g = delayLoopGains(q);
    const lc = Number.isFinite(q.lowCut) ? q.lowCut : DELAY_LOWCUT_OFF, hc = Number.isFinite(q.highCut) ? q.highCut : DELAY_HIGHCUT_OFF;
    // Neutral = exakt durchlässig: Hochpass bei 0 Hz, Tiefpass bei Nyquist (Biquad-Sonderfälle der Web-Audio-Spezifikation).
    const hpF = lc > DELAY_LOWCUT_OFF ? _cl(DELAY_LOWCUT_OFF, 2000, lc) : 0;
    const lpF = hc < DELAY_HIGHCUT_OFF ? _cl(500, DELAY_HIGHCUT_OFF, hc) : ctx.sampleRate / 2;
    const depth = Math.min(_cl(0, DELAY_MOD_MAX_MS, Number.isFinite(q.modDepth) ? q.modDepth : 0) / 1000, Math.min(...times) / 2);
    loops.forEach((l, i) => {
      set(l.d.delayTime, times[i]); set(l.fb.gain, g.fb);
      set(l.hp.frequency, hpF); set(l.lp.frequency, lpF);
      set(mods[i].gain, i === 1 ? -depth : depth);
    });
    if (cross) for (const x of cross) set(x.gain, g.cross);
    set(lfo.frequency, _cl(0.05, 5, Number.isFinite(q.modRate) ? q.modRate : 0.5));
    const wet = _cl(0, 0.95, q.wet ?? 0.35);
    set(dry.gain, 1 - wet); set(wetG.gain, wet);
  };
  apply(p, false);
  lfo.start();
  if (tr) tr.push(lfo);
  return _inst('delay', { input, output: out }, p, { apply, sig: _delaySig });
}

function _buildDelayMultiTap(ctx, p, tr) {
  const { input, split } = _stereoSplit(ctx);
  const out = ctx.createGain(), dry = ctx.createGain(), wetG = ctx.createGain();
  const sum = ctx.createGain(); sum.channelCount = 1; sum.channelCountMode = 'explicit';
  const hl = ctx.createGain(), hr = ctx.createGain(); hl.gain.value = Math.SQRT1_2; hr.gain.value = Math.SQRT1_2;   // (L + R)/√2
  split.connect(hl, 0); split.connect(hr, 1); hl.connect(sum); hr.connect(sum);
  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  const idx = delayActiveTaps(p).map(([, i]) => i);
  const taps = idx.map(() => {
    const l = _delayLoop(ctx, true), lvl = ctx.createGain(), pan = ctx.createStereoPanner(), mod = ctx.createGain();
    sum.connect(l.d); l.guard.connect(l.d);
    l.out.connect(lvl); lvl.connect(pan); pan.connect(wetG);
    lfo.connect(mod); mod.connect(l.d.delayTime);
    return { ...l, lvl, pan, mod };
  });
  input.connect(dry); dry.connect(out); wetG.connect(out);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const list = Array.isArray(q.taps) ? q.taps : [];
    const val = (v, r, d) => _cl(r[0], r[1], Number.isFinite(v) ? v : d);
    const lc = Number.isFinite(q.lowCut) ? q.lowCut : DELAY_LOWCUT_OFF, hc = Number.isFinite(q.highCut) ? q.highCut : DELAY_HIGHCUT_OFF;
    const hpF = lc > DELAY_LOWCUT_OFF ? _cl(DELAY_LOWCUT_OFF, 2000, lc) : 0;
    const lpF = hc < DELAY_HIGHCUT_OFF ? _cl(500, DELAY_HIGHCUT_OFF, hc) : ctx.sampleRate / 2;
    const times = idx.map(i => val(list[i]?.time, DELAY_TAP_RANGES.time, 0.25));
    const depth = times.length ? Math.min(_cl(0, DELAY_MOD_MAX_MS, Number.isFinite(q.modDepth) ? q.modDepth : 0) / 1000, Math.min(...times) / 2) : 0;
    taps.forEach((tp, k) => {
      const t = list[idx[k]] || {};
      set(tp.d.delayTime, times[k]);
      set(tp.lvl.gain, val(t.level, DELAY_TAP_RANGES.level, 0.7));
      set(tp.pan.pan, val(t.panorama, DELAY_TAP_RANGES.panorama, 0));
      set(tp.fb.gain, val(t.feedback, DELAY_TAP_RANGES.feedback, 0));
      set(tp.hp.frequency, hpF); set(tp.lp.frequency, lpF);
      set(tp.mod.gain, k % 2 ? -depth : depth);                    // benachbarte Taps gegenläufig moduliert
    });
    set(lfo.frequency, _cl(0.05, 5, Number.isFinite(q.modRate) ? q.modRate : 0.5));
    const wet = _cl(0, 0.95, q.wet ?? 0.35);
    set(dry.gain, 1 - wet); set(wetG.gain, wet);
  };
  apply(p, false);
  lfo.start();
  if (tr) tr.push(lfo);
  return _inst('delay', { input, output: out }, p, { apply, sig: _delaySig });
}

/**
 * Multiband-Delay (Phase 14c): LR4-Dreibandweiche (buildCrossover3, wie der Multiband-Kompressor), je Band eine Echoschleife Delay → Pegel → Wet,
 * Rückkopplung Delay → Gain → Schutzsättigung → Delay (Jede Schleife enthält ein Delay ≥ DELAY_MIN_S). Die Bänder bleiben bandbegrenzt, jedes kommt zu
 * seiner Zeit. Kanalerhaltend (kein Hochmischen; Mono bleibt mono wie beim Mono-Delay). Trockenanteil = unbearbeiteter Eingang. Alle Regler live
 * (Weiche über setFrequencies geglättet). Bei gleichen Zeiten und Pegeln ohne Rückkopplung ist das Echo ein Allpass des Eingangs (Betrag flach).
 */
function _buildDelayMultiband(ctx, p) {
  const input = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wetG = ctx.createGain();
  const [f1, f2] = delayMultibandCross(p);
  const xo = buildCrossover3(ctx, f1, f2);
  input.connect(xo.input); input.connect(dry); dry.connect(out); wetG.connect(out);
  const bands = DMB_BANDS.map((b, i) => {
    const d = ctx.createDelay(2.05), fb = ctx.createGain(), guard = ctx.createWaveShaper(), lvl = ctx.createGain();
    guard.curve = delayGuardCurve();
    xo.outputs[i].connect(d); d.connect(fb); fb.connect(guard); guard.connect(d);
    d.connect(lvl); lvl.connect(wetG);
    return { d, fb, lvl };
  });
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const [a, b] = delayMultibandCross(q);
    xo.setFrequencies(a, b, set);
    DMB_BANDS.forEach((name, i) => {
      const v = delayMultibandBand(q, name);
      set(bands[i].d.delayTime, v.time); set(bands[i].fb.gain, v.feedback); set(bands[i].lvl.gain, v.level);
    });
    const wet = _cl(0, 0.95, Number.isFinite(q.wet) ? q.wet : 0.35);
    set(dry.gain, 1 - wet); set(wetG.gain, wet);
  };
  apply(p, false);
  return _inst('delayMultiband', { input, output: out }, p, { apply });
}

function _buildDelayLegacy(ctx, p) {
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const del  = ctx.createDelay(5.0); const fbG = ctx.createGain();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const time = Math.max(0.01, Math.min(2.0, q.time ?? 0.22));
    const fb   = Math.max(0, Math.min(0.95, q.feedback ?? 0.35));
    const wet  = Math.max(0, Math.min(0.95, q.wet ?? 0.35));
    set(del.delayTime, time); set(fbG.gain, fb);
    set(dry.gain, 1 - wet); set(wetG.gain, wet);
  };
  apply(p, false);
  del.connect(fbG); fbG.connect(del);
  inp.connect(dry); inp.connect(del); del.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return _inst('delay', { input: inp, output: out }, p, { apply, sig: _delaySig });
}

/**
 * Noise Gate und Expander (P11a): Worklet `dynamics` (dsp-lib/dynamics.js). Ersetzt die frühere Compressor-Näherung (B-03), die
 * oberhalb der Schwelle verdichtete, statt darunter abzusenken. Alle Parameter sind live (AudioParam, k-rate).
 * Ohne geladenes Worklet (kein Secure Context, addModule fehlgeschlagen) wird das Modul übersprungen: Durchgang + `seg.fallback = 'none'`.
 */
function _buildDynamicsModule(ctx, p, tr, kind) {
  const key = kind === 'gate' ? 'noiseGate' : kind === 'expander' ? 'expander' : 'transient';
  const node = makeDynamicsNode(ctx, kind, p);
  if (!node) {
    const pass = ctx.createGain();
    const seg = _inst(key, { input: pass, output: pass }, p, { apply: () => {} });
    seg.fallback = 'none';
    return seg;
  }
  if (tr) tr.push({ stop() { node.dispose(); } });
  return _inst(key, { input: node.input, output: node.output }, p, { apply: q => node.update(q) });
}


/**
 * Baut einen Pitch-Shift-Node für GENAU den übergebenen Context.
 * Prüft die Context-spezifische Worklet-Readiness (`_pitchWorkletReadyContexts`) statt des
 * globalen, nur für den Live-Context gültigen `APP.pitchWorkletReady`-Flags. Damit liefert
 * dieselbe Funktion für Live-AudioContext UND OfflineAudioContext (Export) ein konsistentes
 * Ergebnis, sofern der Aufrufer zuvor `ensurePitchWorkletFor(ctx)` ausgeführt hat.
 * Exportiert, damit export.js denselben Baustein wiederverwenden kann.
 *
 * @param {number} [numChannels=2] Kanalzahl der Quelle (buffer.numberOfChannels).
 *   Stereo-fähiger Worklet: `channelCountMode:'explicit'` +
 *   `channelInterpretation:'discrete'` verhindert, dass der Browser bei
 *   Mono-Quellen automatisch hoch- bzw. bei Multi-Channel-Quellen
 *   heruntermischt, BEVOR der Worklet die Kanäle sieht — jeder Kanal
 *   bekommt im Prozessor eine eigene, unabhängige Overlap-Add-Instanz.
 */
export function buildPitchNode(ctx, p, numChannels = 2) {
  const semitones = p.semitones ?? 0;
  if (semitones === 0) return null;
  if (_pitchWorkletReadyContexts.has(ctx)) {
    try {
      const ch = Math.max(1, Math.min(2, numChannels || 2));
      const n = new AudioWorkletNode(ctx, 'pitch-shifter-processor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        channelCount: ch,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        outputChannelCount: [ch]
      });
      const pf = n.parameters.get('pitchFactor');
      pf.setValueAtTime(Math.pow(2, semitones / 12), ctx.currentTime);
      // Live-Update: nur die Tonhöhe selbst ist glättbar. Ob der Knoten überhaupt existiert (Halbtöne ≠ 0), entscheidet
      // die Runtime (Strukturvergleich) — deshalb liefert update() bei Halbtönen = 0 false (Neubau/Überblendung nötig).
      const seg = { input: n, output: n, key: 'pitchShift' };
      seg.dispose = () => { try { n.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } };   // Prozessor beenden (Fix A)
      seg.update = np => {
        const st = np?.semitones ?? 0;
        if (!st) return false;
        pf.setTargetAtTime(Math.pow(2, st / 12), ctx.currentTime, SMOOTH_TC);
        return true;
      };
      return seg;
    } catch (e) { console.warn('[audio] PitchWorklet node failed:', e.message); }
  }
  return null; // caller uses src.detune as fallback
}

// ─── Spatial v2 (Phase 13e) ─────────────────────────────────────────────────────────────────────
/** Abtastraster (s) der Bewegungsbahn, wenn sie nicht als eine einzige Gerade geplant werden kann (Kurve, Abstandsbegrenzung). */
export const SPATIAL_STEP_S = 0.02;
/** Höchstzahl Bahnpunkte je Bewegungsfenster (lange Bewegungen bekommen ein gröberes Raster). */
export const SPATIAL_MAX_POINTS = 2000;
/** Übergang (s), wenn die Bahn nicht dort beginnt, wo die Position gerade steht: Rücksprung am Durchlaufbeginn (Entscheidung D), Start der Kette. */
export const SPATIAL_GLIDE_S = 0.02;
/**
 * K4: Übergang (s) auf die neue Bahn nach einer Live-Änderung während einer Bewegung. Mit 20 ms fiel der Pegel bei einem großen Abstandssprung
 * (z. B. 3 m → 40 m) um > 20 dB in 20 ms (Klickmaß bis 5,1 in Chromium 153); mit 0,15 s ≤ 1,14 in Node und Chromium [S].
 */
export const SPATIAL_LIVE_GLIDE_S = 0.15;
/**
 * K4: Eigenschaften des PannerNode, die keine AudioParams sind (direkte Zuweisung = Sprung). Ändert sich eine davon, liefert update() false →
 * Neubau mit Überblendung (wie beim Modellwechsel); eine laufende Bewegung wird dabei fortgesetzt.
 */
export const SPATIAL_ATTR_KEYS = ['rolloff', 'maxDistance', 'refDistance', 'coneInnerAngle', 'coneOuterAngle', 'coneOuterGain'];
const SPATIAL_ATTR_DEF = { rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 };
/** K4: Unterschrift der Attribut-Eigenschaften (fehlende Felder = native Vorgabe, wie in props()). */
export const spatialAttrSig = s => SPATIAL_ATTR_KEYS.map(k => s?.[k] ?? SPATIAL_ATTR_DEF[k]).join('|');

/** Verlaufskurven der Bewegung (u = Zeitanteil 0…1 → Wegeanteil 0…1). */
export const SPATIAL_EASE = {
  linear: u => u,
  easeIn: u => u * u,
  easeOut: u => 1 - (1 - u) * (1 - u),
  easeInOut: u => (1 - Math.cos(Math.PI * u)) / 2
};

/** Bewegungsspezifikation für timebase.motionWindows; null = keine Bewegung. */
export function spatialMotionSpec(s) {
  if (!s || (s.motion !== 'once' && s.motion !== 'loop')) return null;
  const rel = s.motionUnit === 'relative';
  return { repeat: s.motion, relative: rel, duration: rel ? (s.motionShare ?? 1) : (s.motionTime ?? 2) };
}

/** Wirksames Panning-Modell (Degradation Equal-Power hat Vorrang, Phase 3a). */
export const spatialPanningModel = s => (s?.equalPower || s?.panningModel === 'equalpower') ? 'equalpower' : 'HRTF';

/**
 * Abstandsbegrenzung (Entscheidung A): Der native Panner wertet `maxDistance` nur bei distanceModel 'linear' aus [S, Node + Chromium 153].
 * Damit „Max. Distanz“ in allen Modellen wirkt, wird der Positionsvektor auf den Radius `maxDistance` gekürzt (Richtung bleibt, nur der
 * Abstand — und damit der Pegel — hört auf zu wachsen). Bei 'linear' ist das gleichwertig zur nativen Klemmung. Innerhalb des Radius unverändert.
 */
export function spatialClamp(v, maxDistance) {
  const m = Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance : Infinity;
  const d = Math.hypot(v[0], v[1], v[2]);
  if (!(d > m)) return v;
  const k = m / d; return [v[0] * k, v[1] * k, v[2] * k];
}

const _start = s => [s.x ?? 0, s.y ?? 0, s.z ?? -1];
const _target = s => [s.toX ?? 0, s.toY ?? 0, s.toZ ?? -1];

/** Position auf der Bahn bei Fortschritt p (0…1), mit Verlauf und Abstandsbegrenzung. */
export function spatialPathAt(s, p) {
  const e = (SPATIAL_EASE[s.curve] || SPATIAL_EASE.linear)(Math.max(0, Math.min(1, p)));
  const a = _start(s), b = _target(s);
  return spatialClamp([a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e], s.maxDistance);
}

/**
 * Kegel-Ausrichtung (13e, Nachentscheidung zu B): 'motion' → in Fahrtrichtung (Ziel − Start, normiert; konstant, auch ohne eingeschaltete
 * Bewegung; Start = Ziel → +X); sonst null (native Vorgabe +X bleibt unangetastet). Eine Ausrichtung „zum Hörer“ entfiel: Der Winkel wäre immer 0°
 * und der Kegel ohne Wirkung; außerdem liefert node-web-audio-api 2.2.0 mit nachgeführter Ausrichtung NaN [S].
 */
export function spatialOrientation(s) {
  if (s?.facing !== 'motion') return null;
  const a = _start(s), b = _target(s), v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], d = Math.hypot(v[0], v[1], v[2]);
  return d > 1e-9 ? [v[0] / d, v[1] / d, v[2] / d] : [1, 0, 0];
}

/**
 * Spatial-Panner (HRTF bzw. Equal-Power). null, wenn deaktiviert oder nicht erzeugbar.
 * Phase 13e: Panning-/Distanzmodell aus den Daten (nicht glättbar → Signatur, Wechsel = Überblendung durch die Runtime), Kegel-Ausrichtung,
 * Abstandsbegrenzung und Bewegung Start → Ziel über die Zeitbasis (arm/hold, runtime.js + timebase.js). Ohne Bewegung (Standard) entspricht
 * der Graph genau dem bisherigen (gleiche Knoten, gleiche Startwerte; Ausrichtung nur bei 'motion' gesetzt).
 */
function _buildSpatialPanner(ctx, spatial) {
  if (!spatial?.enabled) return null;
  try {
    const p = ctx.createPanner(); p.panningModel = spatialPanningModel(spatial); p.distanceModel = spatial.distanceModel || 'inverse';
    const hasParams = !!p.positionX;
    const pos = hasParams ? [p.positionX, p.positionY, p.positionZ] : null;
    const ori = hasParams && p.orientationX ? [p.orientationX, p.orientationY, p.orientationZ] : null;
    const props = s => {
      p.rolloffFactor = s.rolloff ?? 1; p.maxDistance = s.maxDistance ?? 10000; p.refDistance = s.refDistance ?? 1;
      p.coneInnerAngle = s.coneInnerAngle ?? 360; p.coneOuterAngle = s.coneOuterAngle ?? 360; p.coneOuterGain = s.coneOuterGain ?? 0;
    };
    const p0 = spatialClamp(_start(spatial), spatial.maxDistance), o0 = spatialOrientation(spatial);
    if (hasParams) {
      p.positionX.value = p0[0]; p.positionY.value = p0[1]; p.positionZ.value = p0[2];
      if (o0 && ori) { ori[0].value = o0[0]; ori[1].value = o0[1]; ori[2].value = o0[2]; }
    } else {
      p.setPosition(p0[0], p0[1], p0[2]);                     // ältere Browser: keine AudioParams → keine Bewegung, statische Startposition
      if (o0 && p.setOrientation) p.setOrientation(o0[0], o0[1], o0[2]);
    }
    props(spatial);
    const modelSig = s => spatialPanningModel(s) + '|' + (s.distanceModel || 'inverse');
    const sig0 = modelSig(spatial);
    let cur = spatial, timing = null, moving = false, oriSet = !!o0, armed = false, liveGlide = false;
    // Planungsstand: Zeit und Wert des letzten geplanten Positionsereignisses
    let lastT = -Infinity, lastV = null;
    const seg = { input: p, output: p, key: 'spatial' };

    const idleVec = (s, t) => {            // Wert außerhalb eines Bewegungsfensters: vor dem ersten Start bzw. ruhende Bewegung → Start, danach → Ziel
      const spec = spatialMotionSpec(s);
      const len = spec && timing ? (spec.relative ? spec.duration * timing.dur : spec.duration) : 0;
      return !(len > 0) || !timing || t < timing.origin ? spatialClamp(_start(s), s.maxDistance) : spatialPathAt(s, 1);
    };
    const setAt = (v, t) => { for (let i = 0; i < 3; i++) pos[i].setValueAtTime(v[i], t); lastT = t; lastV = v; };
    const rampTo = (v, t) => { for (let i = 0; i < 3; i++) pos[i].linearRampToValueAtTime(v[i], t); lastT = t; lastV = v; };
    const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1e-9);
    const straight = s => SPATIAL_EASE[s.curve || 'linear'] === SPATIAL_EASE.linear
      && Math.max(Math.hypot(..._start(s)), Math.hypot(..._target(s))) <= (s.maxDistance ?? 10000);   // Strecke liegt im Radius (konvex)
    /** Ausrichtung live: nur anfassen, wenn sie gesetzt ist oder war (sonst bleibt die native Vorgabe unberührt). */
    const applyOrientation = (s, t) => {
      const o = spatialOrientation(s);
      if (ori && (o || oriSet)) { const oo = o || [1, 0, 0]; for (let i = 0; i < 3; i++) ori[i].setTargetAtTime(oo[i], t, SMOOTH_TC); }
      oriSet = !!o;
    };

    /** Ein Bewegungsfenster planen (w aus motionWindows). */
    const planWindow = (s, w, glide = SPATIAL_GLIDE_S) => {
      const pAt = t => w.p0 + (w.p1 - w.p0) * ((t - w.start) / Math.max(1e-9, w.end - w.start));
      const begin = spatialPathAt(s, w.p0);
      let t = Math.max(w.start, lastT);
      if (same(lastV, begin)) setAt(begin, t);
      else {                                                   // Übergang: von der aktuellen Stelle in `glide` auf die Bahn
        setAt(lastV, t);
        const tg = Math.min(w.end, t + glide);
        rampTo(spatialPathAt(s, pAt(tg)), tg); t = tg;
      }
      if (!(w.end > t)) return;
      if (straight(s)) { rampTo(spatialPathAt(s, w.p1), w.end); return; }
      const n = Math.max(1, Math.min(SPATIAL_MAX_POINTS, Math.ceil((w.end - t) / SPATIAL_STEP_S)));
      for (let k = 1; k <= n; k++) { const tk = t + (w.end - t) * k / n; rampTo(spatialPathAt(s, pAt(tk)), tk); }
    };

    // Live-Update: ohne Bewegung Position (und Ausrichtung) über AudioParams geglättet wie bisher; mit Bewegung plant arm() neu (die Runtime ruft
    // es nach update() für geänderte Module auf). Modellwechsel → false (Überblendung). Ohne AudioParam-Positionen nur Neubau.
    // K4: Änderung einer Attribut-Eigenschaft (SPATIAL_ATTR_KEYS) → false (Überblendung statt Sprung).
    seg.update = np => {
      if (!hasParams || modelSig(np) !== sig0 || spatialAttrSig(np) !== spatialAttrSig(cur)) return false;
      const t = ctx.currentTime, changed = JSON.stringify(np) !== JSON.stringify(cur);
      props(np); cur = np;
      applyOrientation(np, t);
      if (spatialMotionSpec(np) && timing) { if (changed) liveGlide = true; return true; }   // Position: arm() folgt (K4: mit SPATIAL_LIVE_GLIDE_S)
      const v = spatialClamp(_start(np), np.maxDistance);
      if (moving) {                                            // Bewegung wurde ausgeschaltet: geplante Bahn ab jetzt verwerfen, vom aktuellen Wert aus gleiten
        for (const q of pos) { const cv = q.value; q.cancelScheduledValues(t); q.setValueAtTime(cv, t); }
        moving = false;
      }
      p.positionX.setTargetAtTime(v[0], t, SMOOTH_TC); p.positionY.setTargetAtTime(v[1], t, SMOOTH_TC); p.positionZ.setTargetAtTime(v[2], t, SMOOTH_TC);
      return true;
    };

    // Zeitbasis (13d-Vertrag): reset → ab `from` verwerfen und mit angeschnittenem Fenster neu planen; sonst Fenster mit Beginn in [from, to) anhängen.
    seg.arm = ({ timing: tm, from, to, reset }) => {
      timing = tm;
      const s = cur, spec = spatialMotionSpec(s);
      if (!hasParams || !spec) return;
      const ws = motionWindows(tm, spec, from, to, { partial: !!reset });
      // K4: Neuplanung nach einer Live-Änderung gleitet SPATIAL_LIVE_GLIDE_S, alles andere (Start, Austausch, Fortsetzen, Loop) wie bisher.
      const glide = reset && armed && liveGlide ? SPATIAL_LIVE_GLIDE_S : SPATIAL_GLIDE_S;
      liveGlide = false;
      if (reset) {
        const cv = pos.map(q => q.value);
        for (const q of pos) q.cancelScheduledValues(from);
        const act = ws[0] && ws[0].start <= from + 1e-9 ? spatialPathAt(s, ws[0].p0) : idleVec(s, from);
        if (!armed) setAt(act, from);                          // frisch gebaute Kette (Start, Austausch): direkt auf die Bahn
        else {                                                 // Neuplanung: vom aktuellen Wert aus, Übergang in SPATIAL_GLIDE_S
          setAt(cv, from);
          if ((!ws.length || ws[0].start > from + 1e-9) && !same(cv, act)) rampTo(act, from + glide);
        }
        armed = true; moving = true;
      }
      ws.forEach((w, i) => planWindow(s, w, i === 0 ? glide : SPATIAL_GLIDE_S));
    };

    // Musik-Pause: aktuellen Wert halten, Planung verwerfen; ein neues arm() (reset) setzt fort.
    seg.hold = t => {
      if (!hasParams || !moving) return;
      const v = pos.map(q => q.value);
      for (const q of pos) q.cancelScheduledValues(t);
      setAt(v, t);
    };
    return seg;
  } catch(e) { return null; }
}

// ─── Doppler (Phase 13f) ────────────────────────────────────────────────────────────────────────
/** Kleinster und größter Abstand (s) der Rasterpunkte der Bahn; das Raster wird dort dicht, wo sich die Tonhöhe schnell ändert. */
export const DOPPLER_MIN_STEP_S = 0.001;
export const DOPPLER_MAX_STEP_S = 0.02;
/** Höchstzahl Rasterpunkte je Bewegungsfenster (lange Bahnen bekommen einen größeren Mindestabstand). */
export const DOPPLER_MAX_POINTS = 6000;
/** Größter Tonhöhensprung zwischen zwei Rampenabschnitten (Faktor − 1, ≈ 2 Cent): Die Verzögerung läuft je Abschnitt linear, die Tonhöhe stufig. */
export const DOPPLER_PITCH_STEP = 2 ** (2 / 1200) - 1;
/** Übergang der Verzögerung bei Neuplanung (s). Ein kleiner Sprung gleitet (Tonhöhenabweichung ≤ 25 %); ein großer wird unter einer Pegelsenke gesetzt. */
export const DOPPLER_GLIDE_S = 0.15;
/** Übergang von Pegel, Panorama und Tiefpass bei Neuplanung (s); auch Dauer jeder Hälfte der Pegelsenke. */
export const DOPPLER_FADE_S = 0.02;
/** Luftdämpfung: Grenzfrequenz am nächsten Punkt bzw. Untergrenze (Hz). */
export const DOPPLER_AIR_MAX_HZ = 20000;
export const DOPPLER_AIR_MIN_HZ = 200;
/** Tiefpass-Güte in dB (Web Audio): −3,01 dB = Butterworth, keine Resonanzspitze. */
const DOPPLER_LP_Q_DB = -3.0103;

const _dn = (v, d) => (Number.isFinite(v) ? v : d);
/** Bewegungsspezifikation des Dopplers für timebase.motionWindows (die Vorbeifahrt ist immer eingeschaltet, solange das Modul aktiv ist). */
export function dopplerMotionSpec(q) {
  const rel = q?.motionUnit === 'relative';
  return { repeat: q?.motion === 'loop' ? 'loop' : 'once', relative: rel, duration: rel ? _dn(q?.motionShare, 1) : _dn(q?.motionTime, 4) };
}

/**
 * Doppler-Zustand bei Empfangszeit `tr` (s seit Beginn des Bewegungsfensters) einer Bahn der Länge `len` (s). Rein rechnerisch.
 * Geometrie: Die Quelle fährt mit `speed` auf einer Geraden im Abstand `minDistance`; größte Nähe bei `closest · len`. Seitliche Lage zur Sendezeit e:
 * x(e) = v·(e − closest·len), Abstand d = √(d_min² + x²). Entscheidung C: Die Sendezeit wird exakt gelöst, e + k·(d(e) − d_min)/c = tr (k = Anteil
 * Tonhöhe, Grundverzögerung d_min/c abgezogen); die Verzögerung ist dann tr − e. Damit ist der Tonhöhenfaktor de/dt = 1/(1 + k·v_r/c) mit der
 * Radialgeschwindigkeit v_r = v·x/d — für k = 1 genau die Doppler-Formel der bewegten Quelle c/(c + v_r).
 * Entscheidung B: Weiter als d_park = d_min + DOPPLER_MAX_DELAY_S·c/k „parkt“ die Quelle (|x| begrenzt): Verzögerung höchstens DOPPLER_MAX_DELAY_S.
 * Pegel (d_min/d)^Anteil, Tiefpass DOPPLER_AIR_MAX_HZ·(d_min/d)^Luft (≥ DOPPLER_AIR_MIN_HZ), Panorama ±x/d·Anteil nach dem Balance-Gesetz von Utility.
 * @returns {{delay:number, freq:number, gain:number, pan:number, gL:number, gR:number, ratio:number, d:number, x:number, e:number}}
 */
export function dopplerAt(q, tr, len) {
  const v = _cl(1, 150, _dn(q?.speed, 20)), dmin = _cl(0.5, 100, _dn(q?.minDistance, 5));
  const k = _cl(0, 1, _dn(q?.pitchAmount, 1)), tc = _cl(0, 1, _dn(q?.closest, 0.5)) * Math.max(0, len);
  const xMax = k > 0 ? Math.sqrt((dmin + DOPPLER_MAX_DELAY_S * DOPPLER_C / k) ** 2 - dmin * dmin) : Infinity;
  const geo = e => {
    const raw = v * (e - tc), x = Math.max(-xMax, Math.min(xMax, raw)), d = Math.hypot(dmin, x);
    return { x, d, dd: Math.abs(raw) < xMax ? v * x / d : 0 };   // dd = Ableitung des Abstands nach der Sendezeit (geparkt: 0)
  };
  // Sendezeit: Newton auf f(e) = e + k·(d(e) − d_min)/c − tr (f' = 1 + k·dd/c ≥ 1 − 150/343 > 0, streng monoton → eindeutig)
  let e = tr, g = geo(e);
  for (let i = 0; i < 30; i++) {
    const f = e + k * (g.d - dmin) / DOPPLER_C - tr, fp = 1 + k * g.dd / DOPPLER_C;
    const step = f / fp; e -= step; g = geo(e);
    if (Math.abs(step) < 1e-13) break;
  }
  const delay = Math.max(0, Math.min(DOPPLER_MAX_DELAY_S, tr - e));
  const near = dmin / g.d;
  const gain = Math.pow(near, _cl(0, 1, _dn(q?.levelAmount, 1)));
  const freq = Math.max(DOPPLER_AIR_MIN_HZ, DOPPLER_AIR_MAX_HZ * Math.pow(near, _cl(0, 1, _dn(q?.airAmount, 0.5))));
  const pan = _cl(-1, 1, (q?.direction === 'rightToLeft' ? -1 : 1) * (g.x / g.d) * _cl(0, 1, _dn(q?.panAmount, 1)));
  const th = (pan + 1) * Math.PI / 4;
  return { delay, freq, gain, pan, gL: gain * Math.SQRT2 * Math.cos(th), gR: gain * Math.SQRT2 * Math.sin(th),
    ratio: 1 / (1 + k * g.dd / DOPPLER_C), d: g.d, x: g.x, e };
}
/** Neutraler Zustand (größte Nähe: keine Verzögerung, 0 dB, Mitte, Tiefpass offen) — vor dem ersten arm() und ohne bekannte Bahnlänge. */
const _dopplerNeutral = () => [0, DOPPLER_AIR_MAX_HZ, 1, 1];
const _dVec = s => [s.delay, s.freq, s.gL, s.gR];

/**
 * Doppler (Phase 13f): _stereoSplit-Hochmischer (Mono → L = R mit −3,01 dB, M-3) → Verzögerung (beide Kanäle, feste Kanalzahl 2) → Tiefpass
 * (Luftdämpfung) → je Kanal ein Gain (Abstandspegel · Panorama) → Merger. Die vier Werte folgen der Bahn über AudioParam-Automation
 * (arm/hold, Zeitbasis 13d, Vorbild Spatial 13e): je Bewegungsfenster ein adaptives Raster (DOPPLER_PITCH_STEP, DOPPLER_MIN/MAX_STEP_S) aus
 * linearen Rampen. Neuplanung (Live-Änderung, Rücksprung je Durchlauf) startet am aktuellen Wert: Pegel/Panorama/Tiefpass gleiten
 * DOPPLER_FADE_S, die Verzögerung gleitet DOPPLER_GLIDE_S (kleiner Sprung) oder springt unter einer Pegelsenke (großer Sprung).
 * Eine frisch gebaute Kette (Start, Austausch) geht direkt auf die Bahn. Ohne arm() bleibt sie neutral. Alle Regler live.
 */
function _buildDoppler(ctx, p) {
  const input = ctx.createStereoPanner(); input.pan.value = 0;                 // Hochmischer nach der Regel von _stereoSplit (M-3)
  const dl = ctx.createDelay(DOPPLER_MAX_DELAY_S + 0.05);
  dl.channelCount = 2; dl.channelCountMode = 'explicit'; dl.channelInterpretation = 'speakers';   // Chromium-Regel (13c): feste Kanalzahl
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = DOPPLER_LP_Q_DB;
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const gL = ctx.createGain(), gR = ctx.createGain();
  input.connect(dl); dl.connect(lp); lp.connect(split);
  split.connect(gL, 0); split.connect(gR, 1); gL.connect(merge, 0, 0); gR.connect(merge, 0, 1);
  const P = [dl.delayTime, lp.frequency, gL.gain, gR.gain];
  const n0 = _dopplerNeutral();
  for (let i = 0; i < 4; i++) P[i].value = n0[i];

  let cur = p, timing = null, moving = false, armed = false, lastT = -Infinity, lastV = n0;
  const seg = { input, output: merge, key: 'doppler' };
  // Eigenes Protokoll der geplanten Ereignisse je AudioParam: Der aktuelle Wert beim Neuplanen wird daraus exakt berechnet. `param.value`
  // kann um ein Renderquantum veraltet sein [H] — bei der Verzögerung gäbe schon 0,2 ms Versatz einen hörbaren Phasensprung (Klick).
  const log = [[], [], [], []];
  const setV = (i, v, t) => { P[i].setValueAtTime(v, t); log[i].push({ t, v, r: false }); };
  const rampV = (i, v, t) => { P[i].linearRampToValueAtTime(v, t); log[i].push({ t, v, r: true }); };
  const cancelAll = t => { for (let i = 0; i < 4; i++) { P[i].cancelScheduledValues(t); log[i] = log[i].filter(e => e.t < t); } };
  /** Geplanter Wert zur Zeit t (Rampe linear; eine nach dem Abbruch fehlende Rampe hält den letzten Wert, wie die Engine). */
  const valueAt = (i, t) => {
    const L = log[i]; let k = -1;
    for (let j = 0; j < L.length; j++) { if (L[j].t <= t) k = j; else break; }
    if (k < 0) return n0[i];
    const a = L[k], b = L[k + 1];
    return b && b.r && b.t > a.t ? a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t) : a.v;
  };
  const valuesAt = t => [0, 1, 2, 3].map(i => valueAt(i, t));
  const setAt = (v, t) => { for (let i = 0; i < 4; i++) setV(i, v[i], t); lastT = t; lastV = v; };
  const near = (a, b, i) => Math.abs(a - b) <= (i === 1 ? 1e-6 : 1e-9);
  const same = (a, b) => a && b && a.every((x, i) => near(x, b[i], i));
  const lenOf = s => (timing ? (dopplerMotionSpec(s).relative ? dopplerMotionSpec(s).duration * timing.dur : dopplerMotionSpec(s).duration) : 0);
  /** Wert außerhalb eines Fensters: vor dem ersten Start Anfang der Bahn, danach Ende; ohne Bahnlänge neutral. */
  const idleVec = (s, t) => {
    const len = lenOf(s);
    if (!(len > 0)) return n0;
    return _dVec(dopplerAt(s, t < timing.origin ? 0 : len, len));
  };

  /**
   * Abschnitt [t0, tEnd] planen: Übergang vom aktuellen Wert `lastV` auf `stateAt`, danach Rampen auf die Rasterpunkte `grid` (aufsteigend,
   * letzter = tEnd). Je AudioParam: gleicher Wert → sofort auf der Bahn; Pegel/Panorama/Tiefpass gleiten DOPPLER_FADE_S; die Verzögerung gleitet
   * DOPPLER_GLIDE_S, wenn der Sprung klein ist (Tonhöhe ≤ 25 % daneben), sonst wird sie unter einer Pegelsenke gesetzt (2 × DOPPLER_FADE_S).
   * `newPass`: Beginn eines neuen Durchlaufs (Loop, „neues Fahrzeug“) — jede Änderung der Verzögerung unter der Pegelsenke, damit die Tonhöhe
   * ab der Senke stimmt. Die Verzögerung am Bahnanfang ist größer als am Ende (die Sendezeit liegt dort früher), auch bei symmetrischer Bahn.
   */
  const planSegment = (t0, tEnd, stateAt, grid, newPass = false) => {
    const begin = stateAt(t0), prev = lastV;
    const from = [t0, t0, t0, t0];
    setAt(prev, t0);
    const jump = Math.abs(begin[0] - prev[0]);
    if (jump > 0.25 * DOPPLER_GLIDE_S || (newPass && !near(begin[0], prev[0], 0))) {                                        // großer Sprung: unter einer Pegelsenke setzen
      const ta = Math.min(tEnd, t0 + DOPPLER_FADE_S), tb = Math.min(tEnd, t0 + 2 * DOPPLER_FADE_S);
      const sa = stateAt(ta), sb = stateAt(tb);
      rampV(2, 0, ta); rampV(3, 0, ta); rampV(1, sa[1], ta); setV(0, sa[0], ta);
      if (tb > ta) { rampV(2, sb[2], tb); rampV(3, sb[3], tb); }
      from[0] = ta; from[1] = ta; from[2] = tb; from[3] = tb;
    } else {
      if (!near(begin[0], prev[0], 0)) { const tg = Math.min(tEnd, t0 + DOPPLER_GLIDE_S); rampV(0, stateAt(tg)[0], tg); from[0] = tg; }
      const tf = Math.min(tEnd, t0 + DOPPLER_FADE_S);
      for (let i = 1; i < 4; i++) if (!near(begin[i], prev[i], i)) { rampV(i, stateAt(tf)[i], tf); from[i] = tf; }
    }
    let tl = t0;
    for (const tk of grid) {
      if (!(tk > t0)) continue;
      const st = stateAt(tk);
      for (let i = 0; i < 4; i++) if (tk > from[i] + 1e-9) rampV(i, st[i], tk);
      tl = tk;
    }
    lastT = Math.max(tl, ...from); lastV = stateAt(lastT);
  };

  /** Ein Bewegungsfenster planen (w aus motionWindows): adaptives Raster aus dem Tonhöhenverlauf. */
  const planWindow = (s, w) => {
    const len = w.len, base = w.p0 * len - w.start;                             // Empfangszeit im Fenster = t + base
    const at = t => dopplerAt(s, t + base, len);
    const t0 = Math.max(w.start, lastT), newPass = w.p0 === 0 && lastT <= w.start + 1e-9;
    if (!(w.end > t0)) return;
    const minStep = Math.max(DOPPLER_MIN_STEP_S, (w.end - t0) / DOPPLER_MAX_POINTS);
    const dr = t => { const h = 2e-4; return Math.abs(at(t + h).ratio - at(t - h).ratio) / (2 * h); };
    const stepAt = t => { const r = dr(t); return r > 0 ? DOPPLER_PITCH_STEP / r : DOPPLER_MAX_STEP_S; };
    const grid = [];
    for (let t = t0; t < w.end - 1e-12;) {
      const h1 = _cl(minStep, DOPPLER_MAX_STEP_S, stepAt(t));
      const h = _cl(minStep, DOPPLER_MAX_STEP_S, Math.min(h1, stepAt(t + h1 / 2), stepAt(t + h1)));
      t = w.end - (t + h) < minStep / 2 ? w.end : t + h;
      grid.push(t);
    }
    planSegment(t0, w.end, t => _dVec(at(t)), grid, newPass);
  };

  seg.update = np => { cur = np; return true; };                               // alle Regler live: die Runtime plant geänderte Module per arm() neu

  // Zeitbasis (13d-Vertrag, wie Spatial 13e): reset → ab `from` verwerfen und mit angeschnittenem Fenster neu planen; sonst Fenster anhängen.
  seg.arm = ({ timing: tm, from, to, reset }) => {
    timing = tm;
    const s = cur, ws = motionWindows(tm, dopplerMotionSpec(s), from, to, { partial: !!reset });
    if (reset) {
      const cv = valuesAt(from);
      cancelAll(from);
      const inWin = ws[0] && ws[0].start <= from + 1e-9;
      lastT = -Infinity;
      if (!armed) setAt(inWin ? _dVec(dopplerAt(s, ws[0].p0 * ws[0].len, ws[0].len)) : idleVec(s, from), from);   // frische Kette: direkt auf die Bahn
      else {
        lastV = cv;
        if (!inWin) { const act = idleVec(s, from); planSegment(from, from + DOPPLER_GLIDE_S, () => act, [from + DOPPLER_GLIDE_S]); }
      }
      armed = true; moving = true;
    }
    for (const w of ws) planWindow(s, w);
  };

  // Musik-Pause: aktuellen Wert halten, Planung verwerfen; ein neues arm() (reset) setzt fort.
  seg.hold = t => {
    if (!moving) return;
    const v = valuesAt(t);
    cancelAll(t);
    setAt(v, t);
  };
  return seg;
}

function _buildPanner(ctx, effects) {
  const sp = _buildSpatialPanner(ctx, effects.spatial);
  if (sp) return sp;
  return buildTerminalPanner(ctx, 0);
}

/**
 * Terminaler Stereo-Panner am Ende der Pipeline (genau einer pro Pipeline, s. audio/fx-pipeline.js).
 * Bei Stereo-Eingang und pan=0 ist er die Identität; bei Mono-Eingang erzeugt er (wie bisher) Stereo mit −3 dB je Kanal.
 */
export function buildTerminalPanner(ctx, pan) {
  try {
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan ?? 0)); return { input: p, output: p };
  } catch(e) { return null; }
}

/**
 * Die Modulkette EINES Effekt-Objekts in fester Modulreihenfolge (ohne Panner). `tr` (optional) sammelt alle
 * gestarteten Quellen (LFOs, Träger, ConstantSources), damit der Aufrufer sie über dispose() wieder stoppen kann.
 * Jedes Element ist eine Modul-Instanz mit `key` und `update()` (s. NODE BUILDERS).
 */
function _collectSegments(ctx, effects, tr, omit) {
  const segs = [];

  if (effects.highpass?.enabled)
    segs.push(_buildBiquadModule(ctx, effects.highpass, 'highpass', 'highpass', { fMin: 20, fMax: 5000, fDef: 20, qMin: 0.1, qMax: 10, qDef: 0.7 }));
  if (effects.lowpass?.enabled)
    segs.push(_buildBiquadModule(ctx, effects.lowpass, 'lowpass', 'lowpass', { fMin: 100, fMax: 20000, fDef: 20000, qMin: 0.1, qMax: 10, qDef: 0.7 }));
  if (effects.notch?.enabled)      segs.push(_buildNotch(ctx, effects.notch));
  if (effects.bandpass?.enabled)
    segs.push(_buildBiquadModule(ctx, effects.bandpass, 'bandpass', 'bandpass', { fMin: 20, fMax: 20000, fDef: 1000, qMin: 0.1, qMax: 30, qDef: 1 }, { bandpass: true }));
  if (effects.wahwah?.enabled)     segs.push(_buildWahwah(ctx, effects.wahwah, tr));
  if (effects.autoFilter?.enabled) segs.push(_buildAutoFilter(ctx, effects.autoFilter, tr));
  if (effects.eq10?.enabled)       segs.push(_buildEQ10(ctx, effects.eq10));
  else if (effects.eq?.enabled)    segs.push(_buildEQ3(ctx, effects.eq));
  if (effects.paramEq?.enabled)    segs.push(_buildParamEq(ctx, effects.paramEq));

  if (effects.limiter?.enabled)    segs.push(_buildLimiter(ctx, effects.limiter, tr));
  else if (effects.compressor?.enabled) segs.push(_buildCompressor(ctx, effects.compressor, 'compressor'));
  // Transient Shaper (Phase 11d, Worklet `dynamics`): hinter Kompressor/Limiter, vor der Verzerrung; ohne Worklet übersprungen.
  if (effects.transient?.enabled)  segs.push(_buildDynamicsModule(ctx, effects.transient, tr, 'transient'));
  // Multiband-Kompressor (Phase 11e): hinter dem Transient Shaper, vor der Verzerrung; rein nativ, kein Worklet.
  if (effects.multiband?.enabled)  segs.push(_buildMultiband(ctx, effects.multiband));

  if (effects.distortion?.enabled) segs.push(_buildDistortion(ctx, effects.distortion, tr));
  if (effects.ringmod?.enabled)    segs.push(_buildRingMod(ctx, effects.ringmod, tr));

  // Chorus/Flanger: Modulationseffekte, bewusst vor Reverb/Delay platziert
  // (typische Effektketten-Reihenfolge: Filter → Verzerrung → Modulation →
  // Zeitbasierte Effekte). Gegenseitig exklusiv wie EQ/EQ10 wäre unnötig
  // einschränkend (Chorus+Flanger gleichzeitig ist klanglich sinnvoll),
  // daher hier — anders als z.B. bei eq/eq10 — KEIN else-if.
  if (effects.chorus?.enabled)     segs.push(_buildChorus(ctx, effects.chorus, tr));
  if (effects.flanger?.enabled)    segs.push(_buildFlanger(ctx, effects.flanger, tr));
  // Phaser (Phase 12d): zwischen Flanger und Vibrato (layerOrder 102).
  if (effects.phaser?.enabled)     segs.push(_buildPhaser(ctx, effects.phaser, tr));
  // Vibrato (Phase 12b): Modulationsstufe hinter dem Flanger (layerOrder 104), vor Hall/Delay.
  if (effects.vibrato?.enabled)    segs.push(_buildVibrato(ctx, effects.vibrato, tr));

  // `omit` (Phase 3b): Schlüssel, die NICHT gebaut werden, obwohl sie klingen würden — der geteilte Reverb-Send übernimmt den
  // Hall (engine/reverb-hub.js). Die Exklusivität bleibt erhalten: ein überlagertes Modul wird auch dann nicht gebaut.
  if (effects.irReverb?.enabled)   { if (!omit?.has('irReverb')) segs.push(_buildIRReverb(ctx, effects.irReverb, tr)); }
  else if (effects.reverb?.enabled) { if (!omit?.has('reverb')) segs.push(_buildReverb(ctx, effects.reverb, tr)); }

  if (effects.delay?.enabled)      segs.push(_buildDelay(ctx, effects.delay, tr));
  // Multiband-Delay (Phase 14c, layerOrder 121): direkt hinter dem Delay, vor dem Tremolo.
  if (effects.delayMultiband?.enabled) segs.push(_buildDelayMultiband(ctx, effects.delayMultiband));

  // Tremolo: bewusst NACH dem Delay-Block platziert —
  // moduliert damit auch die Delay-Wiederholungen mit, nicht nur das
  // Trockensignal.
  if (effects.tremolo?.enabled)    segs.push(_buildTremolo(ctx, effects.tremolo, tr));
  // Auto-Pan (Phase 12a): Amplitude-Stufe direkt hinter dem Tremolo (layerOrder 132), vor Gate/Expander.
  if (effects.autoPan?.enabled)    segs.push(_buildAutoPan(ctx, effects.autoPan, tr));

  // Noise-Gate (echtes Gate seit P11a, Worklet `dynamics`) und Expander dahinter.
  if (effects.noiseGate?.enabled)  segs.push(_buildDynamicsModule(ctx, effects.noiseGate, tr, 'gate'));
  if (effects.expander?.enabled)   segs.push(_buildDynamicsModule(ctx, effects.expander, tr, 'expander'));
  // Phase 13: Stereo-Werkzeuge hinter der Dynamik, vor dem Spatial-Panner am Layer-Ende (layerOrder 143 Mid/Side, 144 Breite, 145 Stereo-Shaper, 146 Haas, 147 Utility).
  if (effects.midSide?.enabled)    segs.push(_buildMidSide(ctx, effects.midSide));
  if (effects.width?.enabled)      segs.push(_buildWidth(ctx, effects.width));
  if (effects.stereoShaper?.enabled) segs.push(_buildStereoShaper(ctx, effects.stereoShaper));
  if (effects.haas?.enabled)       segs.push(_buildHaas(ctx, effects.haas));
  if (effects.utility?.enabled)    segs.push(_buildUtility(ctx, effects.utility));
  // Doppler (Phase 13f, layerOrder 148): hinter Utility, vor dem Spatial-Panner.
  if (effects.doppler?.enabled)    segs.push(_buildDoppler(ctx, effects.doppler));
  return segs;
}

/**
 * Bypass-Hülle (AE-04′): input → [Modul] → Summe  ∥  input → Dry → Summe. `setBypass(true)` blendet auf Dry, `false` zurück
 * (Dry und Wet stammen aus derselben Quelle, sind also kohärent: Summe der Gains = 1, kein Pegelsprung). Nur auf Anforderung
 * (`bypassable`), weil sie zwei Summenknoten je Modul kostet und die Kanalform der Kette berührt (Mono-Dry gegen Stereo-Wet,
 * M-3): bestehende Konsumenten bauen ohne Hülle und bleiben damit bit-gleich.
 */
function _wrapBypass(ctx, seg) {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
  wet.gain.value = 1; dry.gain.value = 0;
  inp.connect(seg.input); seg.output.connect(wet); wet.connect(out);
  inp.connect(dry); dry.connect(out);
  const w = { ...seg, input: inp, output: out, bypassed: false };
  w.inner = seg;
  w.update = np => seg.update(np);
  w.setBypass = (on, smooth = true) => {
    w.bypassed = !!on;
    const t = ctx.currentTime;
    if (smooth) { wet.gain.setTargetAtTime(on ? 0 : 1, t, 0.005); dry.gain.setTargetAtTime(on ? 1 : 0, t, 0.005); }
    else { wet.gain.value = on ? 0 : 1; dry.gain.value = on ? 1 : 0; }
  };
  return w;
}

function _chain(segs) {
  if (!segs.length) return null;
  for (let i = 0; i < segs.length - 1; i++) segs[i].output.connect(segs[i + 1].input);
  return { input: segs[0].input, output: segs[segs.length - 1].output, modules: segs };
}

/**
 * LEGACY-Kette (v1-Effektobjekt, flach): Modulkette + Panner am Ende. Wird von der Pipeline NICHT mehr benutzt
 * (dort: buildLayerChain pro Layer + ein terminaler Panner), bleibt aber als Referenz für die
 * Paritätstests gegen den bisherigen Klang erhalten.
 */
export function buildEffectChain(ctx, effects) {
  if (!effects || !effects.enabled) return null;
  const segs = _collectSegments(ctx, effects);
  const panner = _buildPanner(ctx, effects);
  if (panner) segs.push(panner);
  return _chain(segs);
}

/**
 * Baut die Kette EINES Layers aus seinen (vollständig aufgefüllten) Parametern: feste Modulreihenfolge,
 * der Spatial-Panner (falls aktiv) am Layer-Ende. Kein Master-Schalter, kein terminaler Panner, kein Pitch
 * (Pitch ist ein eigener Knoten am Layer-Kopf, s. fx-pipeline.js). Liefert null, wenn der Layer nichts tut
 * (reines Durchreichen). `opts.track` sammelt gestartete Quellen für dispose().
 * Ergebnis: { input, output, modules } — `modules` = Modul-Instanzen in Kettenreihenfolge (key, update, ggf. setBypass).
 * `opts.bypassable`: jedes Modul in eine Bypass-Hülle setzen (s. _wrapBypass).
 * `opts.omit` (Set von Schlüsseln): diese Module nicht bauen (geteilter Reverb-Send, Phase 3b).
 */
export function buildLayerChain(ctx, params, opts = {}) {
  if (!params) return null;
  let segs = _collectSegments(ctx, params, opts.track, opts.omit);
  const sp = _buildSpatialPanner(ctx, params.spatial);
  if (sp) segs.push(sp);
  if (opts.bypassable) segs = segs.map(s => _wrapBypass(ctx, s));
  return _chain(segs);
}

// Fade-Kurven werden zentral in renderPipeline.js (renderSoundGraph()) berechnet,
// auf getrennten, in Serie geschalteten Gain-Nodes.

