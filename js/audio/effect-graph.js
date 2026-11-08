/**
 * audio/effect-graph.js — Effekt-Graph-Konstruktion (zustandslos)
 * Enthält die reinen Knoten-Builder (_build*), buildEffectChain/buildPitchNode sowie die
 * Default-Datenmodelle für Effekte/Wiedergabeparameter.
 */

import { makeDynamicsNode } from './engine/dynamics-node.js';
import { makeFlangerNode, makePhaserNode, phaserStages } from './engine/delayline-node.js';
import { makeCrusherNode } from './engine/crusher-node.js';
import { makeTimebufferNode } from './engine/timebuffer-node.js';
import { reverseDelayParams, REVDELAY_BUFFER_SECONDS } from './dsp-lib/reverse-delay.js';
import { granularDelayParams, GRDELAY_BUFFER_SECONDS } from './dsp-lib/granular-delay.js';
import { crushQuantize } from './dsp-lib/crusher.js';
import { compressorLatencySamples } from './engine/compressor-probe.js';
import { waveShaperLatencySamples } from './engine/waveshaper-probe.js';
import { buildDistortionCurveV2, distortionDrive, distortionBias, distortionNeedsDcBlock, waveshaperKnots,
  TAPE_HF_HZ, TAPE_BASE_DELAY_S, TAPE_WOW_HZ, TAPE_WOW_MAX_S, TAPE_FLUTTER_HZ, TAPE_FLUTTER_MAX_S } from './engine/distortion-curves.js';
import { hilbertPath } from './engine/hilbert.js';
import { buildCrossover2, buildCrossover3, LR4_Q, LR4_Q_DB } from './engine/crossover.js';
import { isWorkletReady } from './context.js';
import { getGenericIR, getIRBuffer } from './ir-data.js';
import { reverbIsLegacy, reverbIRKey, reverbNormalize } from './ir-synth.js';   // P19a; reverbNormalize: Nachbesserung 19a Teil 2
import { defaultModules, peqActiveBands, chorusVoices, chorusIsMulti, vibratoSwing, WIDTH_DECOR_DELAY_S, MS_EQ_DEF, DOPPLER_C, DOPPLER_MAX_DELAY_S,
  delayIsLegacy, delayMode, delayLoopGains, crusherValues, stutterValues, beatRepeatValues, retriggerValues, freqShiftValues, freqShiftSig, FREQ_SHIFT_LOOP_SAMPLES, FREQ_SHIFT_LOOP_HP, FREQ_SHIFT_LOOP_LP, FREQ_SHIFT_LOOP_FADE_S, reverbBuiltMode, reverbGateParams, shimmerValues, reverseValues, reverbIRSig, REVERSE_PREROLL_RANGE, SHIMMER_LOOP_HP, SHIMMER_LOOP_LP, SHIMMER_LOOP_SAMPLES, distortionIsLegacy, distortionMode, DISTORTION_TONE_OFF, delayActiveTaps, DMB_BANDS, delayMultibandCross, delayMultibandBand, DELAY_TAP_RANGES, DELAY_MIN_S, DELAY_LOWCUT_OFF, DELAY_HIGHCUT_OFF, DELAY_MOD_MAX_MS, pitchActive, pitchValues, PITCH_PV_LATENCY, PITCH_VOICE_LATENCY } from './engine/registry.js';
import { makeEnvelopeFollower, makePhasedWave, makeShSource, shSetRate, shStartOffset } from './engine/modsources.js';
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
function _inst(key, seg, p, { apply, sig = null, hot = null, struct = null }) {
  const s0 = sig ? sig(p) : '';
  const st0 = struct ? struct(p) : '';                // P19c: strukturelle Signatur neben dem Hot-Slot (z. B. Hall-Modus) → Neubau
  seg.key = key;
  seg.update = np => {
    if (struct && struct(np) !== st0) return false;
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
 * `make(q)` → {input, output, dispose?(), startDelay?}. `tr` = dispose()-Liste der Pipeline.
 * `rho(alterKern, neuerKern)` (P19b, optional): Korrelation der beiden Kerne ∈ [0, 1] oder null. Bei einer Zahl folgt die Überblendung
 * `xfadeCurves(ρ)` (konstante Leistung bei Korrelation ρ); null oder ohne `rho` bleibt es bei den festen Kurven (`power`).
 * `tailOf(kern)` (P19b, optional, Hall): Nachklang des Kerns in s. Dann sitzt der Kern-Fade VOR dem Kern (input → Fade → Kern → Ausklang-Gain
 * → output): beim Austausch wird nur der EINGANG umgeblendet, der alte Kern klingt mit seiner Vorgeschichte aus und wird erst nach
 * Fade + Nachklang (Audio-Uhr) entsorgt. Grund [S, Node]: ein neuer Convolver beginnt ohne Vorgeschichte; bei Ausgangs-Blende fiel der
 * Hall 100–200 ms lang um 4–7 dB ab. Höchstens `maxTails` Kerne klingen gleichzeitig aus; ein weiterer blendet den ältesten in `fadeSec` aus.
 */
export const MODULE_SWAP_STATS = { swaps: 0, requests: 0 };

/**
 * P19b: Überblendkurven mit konstanter Ausgangsleistung für zwei Signale gleicher Leistung mit Korrelation ρ:
 *   g_neu = sin θ · k, g_alt = cos θ · k, k = 1/√(1 + 2ρ·sin θ·cos θ), θ = x·π/2.
 * Dann gilt g_alt² + g_neu² + 2ρ·g_alt·g_neu = 1 an jeder Stelle. ρ = 0 ergibt genau die bisherige Equal-Power-Kurve (sin/cos),
 * ρ = 1 eine Kurve mit Summe 1 (keine Pegelbeule bei fast gleichen Kernen). ρ wird auf [0, 1] geklemmt.
 */
export function xfadeCurves(rho, n = 32) {
  const r = Math.max(0, Math.min(1, Number(rho) || 0));
  const up = new Float32Array(n), dn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / (n - 1)) * Math.PI / 2, s = Math.sin(a), c = Math.cos(a), k = 1 / Math.sqrt(1 + 2 * r * s * c);
    up[i] = s * k; dn[i] = c * k;
  }
  return { up, dn };
}

/**
 * P19b: Korrelation zweier Impulsantworten (AudioBuffer) ∈ [−1, 1]: Σ a·b / √(Σa²·Σb²) über alle gemeinsamen Kanäle. Für weißes
 * Eingangssignal ist das genau die Korrelation der beiden Hall-Ausgänge; für farbige Signale eine Näherung [H]. Die Normalisierung des
 * ConvolverNode skaliert beide IRs auf gleiche Energie, der Wert bleibt davon unberührt. Leere oder fehlende IR → 0.
 */
export function irCorrelation(a, b) {
  if (!a || !b) return 0;
  const nc = Math.min(a.numberOfChannels, b.numberOfChannels);
  let ab = 0, aa = 0, bb = 0;
  for (let c = 0; c < nc; c++) {
    const x = a.getChannelData(c), y = b.getChannelData(c), n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) ab += x[i] * y[i];
    for (let i = 0; i < x.length; i++) aa += x[i] * x[i];
    for (let i = 0; i < y.length; i++) bb += y[i] * y[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** P19b: Höchstzahl gleichzeitig ausklingender Hall-Kerne je Modul (CPU: jeder läuft bis zu einer IR-Länge weiter). */
export const HOT_SLOT_MAX_TAILS = 2;

function _hotSlot(ctx, tr, make, p0, sig, { fadeSec = 0.04, throttleMs = 120, power = true, rho = null, tailOf = null, maxTails = HOT_SLOT_MAX_TAILS } = {}) {
  const input = ctx.createGain(), output = ctx.createGain();
  const mount = q => {
    const core = make(q), fade = ctx.createGain();
    if (!tailOf) { input.connect(core.input); core.output.connect(fade); fade.connect(output); return { core, fade }; }
    const out = ctx.createGain();                      // P19b: Ausklang-Gain (1); nur zum Kappen über den Deckel `maxTails`
    input.connect(fade); fade.connect(core.input); core.output.connect(out); out.connect(output);
    return { core, fade, out };
  };
  const drop = c => {
    try { c.core.output.disconnect(); } catch (e) { /* schon getrennt */ }
    try { c.fade.disconnect(); } catch (e) { /* schon getrennt */ }
    try { c.out?.disconnect(); } catch (e) { /* schon getrennt */ }
    try { input.disconnect(tailOf ? c.fade : c.core.input); } catch (e) { /* schon getrennt */ }
    try { c.core.dispose?.(); } catch (e) { /* ignorieren */ }
  };
  let cur = mount(p0), curSig = sig(p0), pending = null, timer = null, last = -Infinity, dead = false;
  const retiring = new Map();                          // alter Kern → Timer der Entsorgung
  const curveUp = new Float32Array(32), curveDn = new Float32Array(32);
  for (let i = 0; i < 32; i++) {
    const x = i / 31;
    // power: Equal-Power (unkorrelierte Kerne, z. B. zwei IRs); sonst Raised-Cosine (Summe = 1, an beiden Enden ohne Knick — korrelierte Kerne)
    curveUp[i] = power ? Math.sin(x * Math.PI / 2) : (1 - Math.cos(x * Math.PI)) / 2;
    curveDn[i] = power ? Math.cos(x * Math.PI / 2) : (1 + Math.cos(x * Math.PI)) / 2;
  }
  const retire = (c, ms, set = retiring) => { const id = setTimeout(() => { if (set.delete(c)) drop(c); }, ms); set.set(c, id); };
  const capped = new Map();                            // P19b: über den Deckel ausgeblendete Kerne (zählen nicht mehr als Ausklang)
  /** P19b: entsorgt `c`, sobald die AUDIO-Uhr `tEnd` erreicht (Nachklang vollständig); Rückfall Wanduhr (suspendierter Context). */
  const retireAt = (c, tEnd) => {
    const limit = Date.now() + Math.max(1000, (tEnd - ctx.currentTime) * 3000 + 1000);
    const tick = () => {
      if (!retiring.has(c)) return;
      if (ctx.currentTime >= tEnd || Date.now() > limit) { retiring.delete(c); drop(c); return; }
      retiring.set(c, setTimeout(tick, Math.min(250, Math.max(15, (tEnd - ctx.currentTime) * 1000))));
    };
    retiring.set(c, null); tick();
  };
  const run = q => {
    if (dead) return;
    last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const nu = mount(q), old = cur;
    // `startDelay` (s, Phase 15a): Latenz des neuen Kerns (Oversampling der Verzerrung). Die Überblendung beginnt erst, wenn sein Signal anliegt —
    // sonst setzt es mitten in der Rampe ein (bei Gleichanteil hinter dem DC-Blocker als Sprung messbar). Fehlt das Feld: wie bisher sofort.
    const t0 = ctx.currentTime + Math.max(0, Number(nu.core.startDelay) || 0);
    // P19b: Kurve nach der gemessenen Korrelation der beiden Kerne (Hall-IR); null → feste Kurve wie bisher
    const r = rho ? rho(old.core, nu.core) : null;
    const cv = (r == null) ? { up: curveUp, dn: curveDn } : xfadeCurves(r);
    if (r != null) MODULE_SWAP_STATS.lastRho = r;
    nu.fade.gain.value = 0;
    nu.fade.gain.setValueCurveAtTime(cv.up, t0, fadeSec);
    old.fade.gain.cancelScheduledValues(ctx.currentTime);
    old.fade.gain.setValueCurveAtTime(cv.dn, t0, fadeSec);
    cur = nu; curSig = sig(q); MODULE_SWAP_STATS.swaps++;
    if (!tailOf) { retire(old, (t0 - ctx.currentTime + fadeSec) * 1000 + 80); return; }
    // P19b: Ausklang. Deckel: der älteste noch ausklingende Kern wird am Ausgang in `fadeSec` ausgeblendet und danach entsorgt.
    retireAt(old, t0 + fadeSec + Math.max(0, Number(tailOf(old.core)) || 0) + 0.05);
    while (retiring.size > maxTails) {
      const [oldest, id] = retiring.entries().next().value;
      if (id) clearTimeout(id);
      retiring.delete(oldest);
      const tc = ctx.currentTime;
      try { oldest.out.gain.cancelScheduledValues(tc); oldest.out.gain.setValueAtTime(oldest.out.gain.value, tc); oldest.out.gain.linearRampToValueAtTime(0, tc + fadeSec); } catch (e) { /* ignorieren */ }
      MODULE_SWAP_STATS.tailCaps = (MODULE_SWAP_STATS.tailCaps || 0) + 1;
      retire(oldest, fadeSec * 1000 + 80, capped);
    }
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
    for (const m of [retiring, capped]) { for (const [c, id] of m) { if (id) clearTimeout(id); drop(c); } m.clear(); }
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

/**
 * Verzerrung: Kurve und Oversampling sind nicht glättbar → Modul-Austausch mit Überblendung (P10f), kein Pipeline-Neubau.
 * Phase 15a: Derselbe Austausch-Slot trägt zwei Kernformen:
 *   bisherig (distortionIsLegacy): ein WaveShaper — exakt der bisherige Graph (bit-gleich, Goldens 03/04);
 *   erweitert: input → WaveShaper (Kurve aus Modus/Drive/Bias bzw. bisherige Kurve) → [DC-Blocker] → Ton-Tiefpass → Wet(Mix · Ausgang) → output
 *              input → Dry-Verzögerung (= Latenz des Oversamplings, engine/waveshaper-probe.js) → Dry(1 − Mix) → output.
 * Strukturell (Austausch): Modus, bisherig ↔ erweitert, Oversampling, Stärke (bisherige Modi), Drive und Bias (neue Modi; Kurve und Kompensation
 * hängen davon ab). Live (ohne Austausch): Ton, Ausgang, Mix — sie wirken auf alle laufenden erweiterten Kerne.
 * Phase 15b: Tape hängt hinter die Kennlinie einen festen Höhen-Tiefpass (TAPE_HF_HZ) und ein Mikro-Vibrato (Verzögerung TAPE_BASE_DELAY_S, moduliert
 *   von zwei Sinus-LFOs: Wow 0,7 Hz, Flutter 7,3 Hz; Tiefe live). Der Dry-Pfad wartet die Grundverzögerung mit ab. Waveshaper: Kurve aus `curvePoints`,
 *   jede Punktänderung ist strukturell (neue Kurve, Austausch). Die Oszillatoren eines Kerns stoppt dessen dispose (beim Austausch und beim Abbau).
 */
const _distOs = q => (['none', '2x', '4x'].includes(q.oversample) ? q.oversample : '4x');
const _distSig = q => {
  if (distortionIsLegacy(q)) return `L|${q.mode}|${q.amount ?? 40}|${q.oversample}`;
  const m = distortionMode(q);
  if (['softClip', 'hardClip', 'bitcrush'].includes(m)) return `V|${m}|${q.amount ?? 40}|${_distOs(q)}`;
  return `V|${m}|${distortionDrive(q)}|${distortionBias(q)}|${_distOs(q)}${m === 'waveshaper' ? '|' + JSON.stringify(waveshaperKnots(q.curvePoints)) : ''}`;
};
function _buildDistortion(ctx, p, tr) {
  const cores = new Set();
  const make = q => {
    const s = ctx.createWaveShaper();
    if (distortionIsLegacy(q)) {
      s.curve = _buildDistortionCurve(q.mode, q.amount ?? 40);
      s.oversample = ['none', '2x', '4x'].includes(q.oversample) ? q.oversample : '4x';
      return { input: s, output: s };
    }
    const mode = distortionMode(q), os = _distOs(q), legacyCurve = ['softClip', 'hardClip', 'bitcrush'].includes(mode);
    s.curve = legacyCurve ? _buildDistortionCurve(mode, q.amount ?? 40) : buildDistortionCurveV2(mode, distortionDrive(q), distortionBias(q), q.curvePoints);
    s.oversample = os;
    const input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = LR4_Q_DB;          // Butterworth (Q in dB)
    const dryDelay = ctx.createDelay(0.05);
    const tape = mode === 'tape';
    const tapeBase = Math.round(TAPE_BASE_DELAY_S * ctx.sampleRate) / ctx.sampleRate;               // ganze Samples: Dry-Pfad exakt deckungsgleich
    dryDelay.delayTime.value = (waveShaperLatencySamples(ctx.sampleRate, os) + (tape ? Math.round(TAPE_BASE_DELAY_S * ctx.sampleRate) : 0)) / ctx.sampleRate;
    input.connect(s);
    let last = s;
    if (!legacyCurve && distortionNeedsDcBlock(mode, distortionBias(q), q.curvePoints)) {
      const dc = ctx.createBiquadFilter(); dc.type = 'highpass'; dc.frequency.value = 10; dc.Q.value = LR4_Q_DB;
      s.connect(dc); last = dc;
    }
    let tapeMod = null;
    if (tape) {
      const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = TAPE_HF_HZ; hf.Q.value = LR4_Q_DB;
      const vib = ctx.createDelay(TAPE_BASE_DELAY_S + TAPE_WOW_MAX_S + TAPE_FLUTTER_MAX_S + 0.001); vib.delayTime.value = tapeBase;
      const wowO = ctx.createOscillator(), flO = ctx.createOscillator(), wowG = ctx.createGain(), flG = ctx.createGain();
      wowO.frequency.value = TAPE_WOW_HZ; flO.frequency.value = TAPE_FLUTTER_HZ;
      wowO.connect(wowG); flO.connect(flG); wowG.connect(vib.delayTime); flG.connect(vib.delayTime);
      last.connect(hf); hf.connect(vib); last = vib;
      wowO.start(); flO.start();
      tapeMod = { wowG, flG, stop: () => { for (const o of [wowO, flO]) { try { o.stop(); } catch (e) { /* schon gestoppt */ } } } };
    }
    last.connect(tone); tone.connect(wet); wet.connect(output);
    input.connect(dryDelay); dryDelay.connect(dry); dry.connect(output);
    const core = {
      update(v, sm) {
        const set = _setter(ctx, sm);
        const tc = Number.isFinite(v.tone) ? v.tone : DISTORTION_TONE_OFF;
        // Neutral = exakt durchlässig: Tiefpass bei Nyquist (Biquad-Sonderfall der Web-Audio-Spezifikation, wie im Delay v2)
        set(tone.frequency, tc < DISTORTION_TONE_OFF ? _cl(500, DISTORTION_TONE_OFF, tc) : ctx.sampleRate / 2);
        const mix = _cl(0, 1, Number.isFinite(v.mix) ? v.mix : 1), out = 10 ** (_cl(-24, 12, Number.isFinite(v.output) ? v.output : 0) / 20);
        set(wet.gain, mix * out); set(dry.gain, 1 - mix);
        if (tapeMod) {
          set(tapeMod.wowG.gain, TAPE_WOW_MAX_S * _cl(0, 1, Number.isFinite(v.wow) ? v.wow : 0.2));
          set(tapeMod.flG.gain, TAPE_FLUTTER_MAX_S * _cl(0, 1, Number.isFinite(v.flutter) ? v.flutter : 0.15));
        }
      }
    };
    core.update(q, false);
    cores.add(core);
    return { input, output, startDelay: dryDelay.delayTime.value, dispose: () => { cores.delete(core); tapeMod?.stop(); } };
  };
  const slot = _hotSlot(ctx, tr, make, p, _distSig, { fadeSec: 0.04, throttleMs: 80, power: false });
  const apply = (q, sm) => { for (const c of cores) c.update(q, sm); };
  return _inst('distortion', { input: slot.input, output: slot.output }, p, { apply, sig: _distSig, hot: slot });
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

/** Feste Seeds der Sample&Hold-LFOs (20g, Entscheidung F: fest je Bau) — je Modul eine eigene Folge, damit zwei S&H-Module nicht gleich springen. */
const SH_SEED_AUTOPAN = 0x53A7, SH_SEED_AUTOFILTER = 0x53F1;

/**
 * Sample&Hold-LFO (Phase 20g): geloopte Stufenquelle (modsources.js makeShSource), gestartet mit Startphase (360° = eine Stufe) und in `tr`
 * eingetragen. Rückgabe: { node, setRate(hz, smooth) } — Rate über playbackRate (shSetRate: geglättet mit Ankerwert).
 */
function _shLfo(ctx, tr, seed, phaseDeg, rate) {
  const src = makeShSource(ctx, { seed, rate });
  src.start(0, shStartOffset(ctx, phaseDeg));
  if (tr) tr.push(src);
  return { node: src, setRate: (hz, smooth) => shSetRate(ctx, src, hz, smooth) };
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
 * Live: Rate, Tiefe, Breite. Nicht glättbar: Form und Startphase (Neubau mit Überblendung). Form `sh` (20g): Stufenquelle, Startphase 360° = eine Stufe.
 */
function _buildAutoPan(ctx, p, tr) {
  const shape = ['sine', 'triangle', 'square', 'saw', 'sh'].includes(p.waveform) ? p.waveform : 'sine';
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
  // 20g: `sh` → Stufenquelle (Startphase = Verschiebung innerhalb einer Stufe); alle übrigen Formen unverändert (bit-gleich)
  const sh = shape === 'sh' ? _shLfo(ctx, tr, SH_SEED_AUTOPAN, ph, _cl(0.01, 20, p.rate ?? 0.5)) : null;
  const lfo = sh ? sh.node : _phasedOsc(ctx, tr, shape, ph, _cl(0.01, 20, p.rate ?? 0.5));
  const depthGain = ctx.createGain();
  const shL = ctx.createWaveShaper(), shR = ctx.createWaveShaper();
  shL.curve = _panCurveFor('l'); shR.curve = _panCurveFor('r');
  lfo.connect(depthGain); depthGain.connect(shL); depthGain.connect(shR);
  shL.connect(panL.gain); shR.connect(panR.gain);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const w = _cl(0, 1, q.width ?? 1);
    if (sh) sh.setRate(_cl(0.01, 20, q.rate ?? 0.5), sm); else set(lfo.frequency, _cl(0.01, 20, q.rate ?? 0.5));
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

/** Auto-Filter-Wellenform (20g); unbekannt → sine. Signatur: Form ist nicht glättbar (Neubau); `lfo` (ohne Zusatz) = Sinus wie vor 20g. */
const _autoFilterWave = q => (['sine', 'triangle', 'square', 'saw', 'sh'].includes(q.waveform) ? q.waveform : 'sine');
const _autoFilterSig = q => (q.source === 'envelope' ? 'env' : (_autoFilterWave(q) === 'sine' ? 'lfo' : `lfo|${_autoFilterWave(q)}`));

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
  // 20g: Wellenform nur bei Steuerung LFO; `sine` (Standard, auch der Hüllkurven-Ersatz) = Graph wie vor 20g (bit-gleich)
  const wf = wantEnv ? 'sine' : _autoFilterWave(p);
  let sh = null;
  if (!envCtl && wf === 'sh') {
    sh = _shLfo(ctx, tr, SH_SEED_AUTOFILTER, 0, Math.max(0.1, Math.min(10, p.rate ?? 2)));
    lfo = sh.node; lfo.connect(depthGain);
  } else if (!envCtl) { lfo = ctx.createOscillator(); lfo.type = wf === 'saw' ? 'sawtooth' : wf; lfo.connect(depthGain); lfo.start(); if (tr) tr.push(lfo); }
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
    if (sh) sh.setRate(Math.max(0.1, Math.min(10, q.rate ?? 2)), sm);
    else if (lfo) set(lfo.frequency, Math.max(0.1, Math.min(10, q.rate ?? 2)));
    if (envCtl) set(envCtl.scale.gain, _sensGain(q.sensitivity));
  };
  apply(p, false);
  const seg = _inst('autoFilter', { input: inp, output: filter }, p, { apply, sig: _autoFilterSig });
  if (wantEnv && !envCtl) seg.fallback = 'lfo';
  return seg;
}

/**
 * Bitcrusher (Phase 15c): Worklet `crusher` (Sample-and-Hold mit Zielrate + Quantisierung + Mix, alles live). Ohne geladenes Worklet: Ersatz
 * aus einer nativen Quantisierungskurve (WaveShaper, 65 537 Punkte, gleiche Quantisierungsformel) mit Dry/Wet — OHNE Sample-Rate-Reduktion,
 * Marke `seg.fallback = 'native'` und Ereignis `sb:fx-fallback` (wie die Hüllkurve, P10c). Bits sind im Ersatz strukturell (neue Kurve → Neubau).
 */
const _crushCurves = new Map();
function _crushCurve(bits) {
  if (_crushCurves.has(bits)) return _crushCurves.get(bits);
  const n = 65537, h = (n - 1) / 2, c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = crushQuantize((i - h) / h, bits);
  _crushCurves.set(bits, c);
  return c;
}
function _buildCrusher(ctx, p, tr) {
  const node = makeCrusherNode(ctx, p);
  if (node) {
    if (tr) tr.push({ stop() { node.dispose(); } });
    return _inst('crusher', { input: node.input, output: node.output }, p, { apply: q => node.update(q) });
  }
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sb:fx-fallback', { detail: { module: 'crusher', reason: 'crusher' } })); } catch (e) { /* ohne Fenster */ }
  const input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain(), ws = ctx.createWaveShaper();
  ws.curve = _crushCurve(crusherValues(p).bits);
  input.connect(ws); ws.connect(wet); wet.connect(output); input.connect(dry); dry.connect(output);
  const apply = (q, sm) => { const set = _setter(ctx, sm), v = crusherValues(q); set(wet.gain, v.mix); set(dry.gain, 1 - v.mix); };
  apply(p, false);
  const seg = _inst('crusher', { input, output }, p, { apply, sig: q => String(crusherValues(q).bits) });
  seg.fallback = 'native';
  return seg;
}

/**
 * Stutter (Phase 20b, layerOrder 5): Worklet `timebuffer` im Modus 'stutter' (Planer audio/dsp-lib/stutter.js). Der Knoten bekommt die
 * Zeitbasis über arm() (13d-Vertrag wie Bewegungen und Reverse-Hall: Ereignis je Durchlauf relativ zum Durchlaufbeginn) und hält sie bei
 * der Musik-Pause an (hold). Mix live über den Parameter `wet` (geglättet, wirkt auch auf eine laufende Wiederholung), die übrigen Regler
 * gehen über den Port und gelten ab dem nächsten Ereignis (kein Neubau). Ohne Worklet: Durchgang, `fallback = 'none'`, Hinweis in der Konsole
 * (wie Gated-Hall/Noise Gate; das Ereignis sb:fx-fallback zeigt in budget.js einen Text zur Hüllkurven-Steuerung und passt hier nicht).
 */
function _buildStutter(ctx, p, tr) {
  const v = stutterValues(p);
  const node = makeTimebufferNode(ctx, { mode: 'stutter', params: v, dry: 1, wet: v.mix, seed: 0x57A7 });
  if (!node) {
    console.warn('[audio] Stutter: Worklet "timebuffer" nicht verfügbar — Modul übersprungen');
    const pass = ctx.createGain();
    const seg = _inst('stutter', { input: pass, output: pass }, p, { apply: () => {} });
    seg.fallback = 'none';
    return seg;
  }
  if (tr) tr.push({ stop() { node.dispose(); } });
  const apply = (q, live) => { const w = stutterValues(q); node.update({ wet: w.mix }); if (live) node.setParams(w); };
  const seg = _inst('stutter', { input: node.input, output: node.output }, p, { apply });
  seg.arm = ({ timing }) => node.arm(timing);
  seg.hold = () => node.hold();
  return seg;
}

/**
 * Beat Repeat (Phase 20c, layerOrder 6): Worklet `timebuffer` im Modus 'beatRepeat' (Planer audio/dsp-lib/beat-repeat.js). Aufbau wie
 * _buildStutter: Zeitbasis über arm() (Raster relativ zum Durchlaufbeginn), hold() bei der Musik-Pause, Mix live über `wet`, übrige Regler
 * über den Port ab dem nächsten Ereignis. Ohne Worklet: Durchgang, `fallback = 'none'`, Hinweis in der Konsole (wie Stutter).
 */
function _buildBeatRepeat(ctx, p, tr) {
  const v = beatRepeatValues(p);
  const node = makeTimebufferNode(ctx, { mode: 'beatRepeat', params: v, dry: 1, wet: v.mix, seed: 0xBEA7 });
  if (!node) {
    console.warn('[audio] Beat Repeat: Worklet "timebuffer" nicht verfügbar — Modul übersprungen');
    const pass = ctx.createGain();
    const seg = _inst('beatRepeat', { input: pass, output: pass }, p, { apply: () => {} });
    seg.fallback = 'none';
    return seg;
  }
  if (tr) tr.push({ stop() { node.dispose(); } });
  const apply = (q, live) => { const w = beatRepeatValues(q); node.update({ wet: w.mix }); if (live) node.setParams(w); };
  const seg = _inst('beatRepeat', { input: node.input, output: node.output }, p, { apply });
  seg.arm = ({ timing }) => node.arm(timing);
  seg.hold = () => node.hold();
  return seg;
}

/**
 * Retrigger (Phase 20d, layerOrder 7): Worklet `timebuffer` im Modus 'retrigger' (Planer audio/dsp-lib/retrigger.js, Onset-Erkennung im
 * Prozessor). Aufbau wie _buildBeatRepeat: Zeitbasis über arm() (Durchlauf für die Wahrscheinlichkeit, Durchlaufende für ∞/Loop, Seek leert
 * Puffer und Erkennung), hold() bei der Musik-Pause, Mix live über `wet`, übrige Regler über den Port (Erkennung sofort, Wiederholungen ab dem
 * nächsten Ereignis). Ohne Worklet: Durchgang, `fallback = 'none'`, Hinweis in der Konsole (wie Stutter).
 */
function _buildRetrigger(ctx, p, tr) {
  const v = retriggerValues(p);
  const node = makeTimebufferNode(ctx, { mode: 'retrigger', params: v, dry: 1, wet: v.mix, seed: 0x2E7A });
  if (!node) {
    console.warn('[audio] Retrigger: Worklet "timebuffer" nicht verfügbar — Modul übersprungen');
    const pass = ctx.createGain();
    const seg = _inst('retrigger', { input: pass, output: pass }, p, { apply: () => {} });
    seg.fallback = 'none';
    return seg;
  }
  if (tr) tr.push({ stop() { node.dispose(); } });
  const apply = (q, live) => { const w = retriggerValues(q); node.update({ wet: w.mix }); if (live) node.setParams(w); };
  const seg = _inst('retrigger', { input: node.input, output: node.output }, p, { apply });
  seg.arm = ({ timing }) => node.arm(timing);
  seg.hold = () => node.hold();
  return seg;
}

/**
 * Ring Modulation — Träger-Oszillator moduliert direkt den Gain des Eingangssignals
 * (Web-Audio-Parameter-Modulation: bei Oszillator-Amplitude ±1 und Gain-Basiswert 0 entspricht das einer
 * echten Multiplikation Input×Träger; 20–5000 Hz). Phase 15c: Trägerform Sinus (Standard), Rechteck, Dreieck oder Sägezahn (native,
 * bandbegrenzte Oszillatorformen; Spitze ±1 wie der Sinus, der Effektivwert also je Form verschieden).
 */
const _ringSig = q => (['square', 'triangle', 'sawtooth'].includes(q.waveform) ? q.waveform : 'sine');
function _buildRingMod(ctx, p, tr) {
  const carrier = ctx.createOscillator();
  carrier.type = _ringSig(p);                          // 15c: Trägerform; Standard/fehlend/unbekannt = Sinus (bisheriger Graph)
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

  return _inst('ringmod', { input, output }, p, { apply, sig: _ringSig });   // Formwechsel = Neubau mit Überblendung (15c)
}

/**
 * Frequenzschieber (Phase 16a, Einseitenband, nativ): Das IIR-Hilbert-Paar (engine/hilbert.js, je Pfad EIN IIRFilterNode 8. Ordnung) liefert
 * I und Q (90° Phasendifferenz), zwei Oszillatoren aus PeriodicWave liefern cos und sin mit derselben Frequenz = `shift`.
 *   Wet = I·cos + Q·sin → jede Frequenz f wird zu f + shift (negativ: nach unten). Eine negative Oszillatorfrequenz kehrt die Richtung um,
 *   `shift` gleitet daher live auch durch 0 (bei 0 Hz stehen die Oszillatoren auf cos = 1, sin = 0 → Wet = I).
 *   Dry = I-Pfad (Entscheidung B, P16): Betrag flach, Phase allpassverschoben; bei Shift 0 sind Dry und Wet deckungsgleich (keine Auslöschung).
 *   Die Multiplikation läuft wie bei der Ringmodulation über einen Gain mit Basiswert 0, dessen Parameter der Oszillator ansteuert.
 *   Kanäle: IIR-Filter und Gains arbeiten kanalweise → eine Mono-Quelle bleibt mono, Stereo bleibt stereo.
 * Phase 16b:
 *   Spreizung > 0: zweikanalig (Mono-Quelle über StereoPanner pan 0 hochgemischt, −3,01 dB je Kanal wie am terminalen Panner, vgl. _stereoSplit);
 *   je Kanal ein eigenes cos/sin-Paar: links shift + Spreizung, rechts shift − Spreizung.
 *   Rückkopplung > 0: Summe vor dem Hilbert-Paar ← Wet über DelayNode (FREQ_SHIFT_LOOP_SAMPLES = 128 Samples), Hochpass 25 Hz, Tiefpass 18 kHz
 *   und Gain `feedback`. Jeder Umlauf verschiebt erneut. Im Nutzband hat der Schieber Verstärkung 1 (Einseitenband: Leistung bleibt erhalten);
 *   nahe 0 Hz und Nyquist dagegen bis √2 (I = Q) — die beiden Filter halten die Schleifenverstärkung dort unter 1 (stabil bis 0,9). Der Dry-Pfad bekommt dann ein
 *   EIGENES I-Filter auf dem Eingang (ohne Rückkopplungsanteil), damit Mix 0 weiterhin der I-Pfad des Eingangs ist.
 *   Signatur (freqShiftSig): Spreizung 0 ↔ > 0 und Rückkopplung 0 ↔ > 0 bauen neu (Überblendung); alle Werte innerhalb sind live.
 */
const _fsWaves = new WeakMap();
function _fsWave(ctx, kind) {
  let m = _fsWaves.get(ctx);
  if (!m) {
    const mk = (re, im) => ctx.createPeriodicWave(new Float32Array(re), new Float32Array(im), { disableNormalization: true });
    m = { cos: mk([0, 1], [0, 0]), sin: mk([0, 0], [0, 1]) };
    _fsWaves.set(ctx, m);
  }
  return m[kind];
}
const _fsIIR = (ctx, path) => { const h = hilbertPath(path); return ctx.createIIRFilter(Array.from(h.feedforward), Array.from(h.feedback)); };
function _buildFreqShift(ctx, p, tr) {
  const v0 = freqShiftValues(p), spread = v0.spread > 0, fb = v0.feedback > 0;
  const input = ctx.createGain(), output = ctx.createGain();
  const fI = _fsIIR(ctx, 'i'), fQ = _fsIIR(ctx, 'q');
  const wet = ctx.createGain(), dry = ctx.createGain();
  // Eingang (16b: bei Spreizung zweikanalig hochgemischt)
  let src = input;
  if (spread) { const up = ctx.createStereoPanner(); up.pan.value = 0; input.connect(up); src = up; }
  // Hilbert-Eingang: ohne Rückkopplung direkt, mit Rückkopplung über eine Summe
  let sum = src, loopDelay = null, loopGain = null;
  if (fb) {
    sum = ctx.createGain(); src.connect(sum);
    loopDelay = ctx.createDelay(0.1); loopDelay.delayTime.value = FREQ_SHIFT_LOOP_SAMPLES / ctx.sampleRate;
    loopGain = ctx.createGain();
    // Schutz in der Schleife: Nahe 0 Hz und Nyquist versagt das Hilbert-Paar (I = Q, Verstärkung bis √2) → dort Hoch-/Tiefpass, damit die
    // Schleifenverstärkung überall < 1 bleibt (sonst schaukeln sich Anteile nahe 0 Hz/Nyquist auf, gemessen 16b).
    const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
    // Butterworth ohne Resonanzspitze: Q bei Hoch-/Tiefpass in dB (Web Audio) → 20·log10(1/√2) = LR4_Q_DB. Eine Spitze > 0 dB würde die Schleife
    // bei 90 % über 1 heben.
    hp.type = 'highpass'; hp.frequency.value = FREQ_SHIFT_LOOP_HP; hp.Q.value = LR4_Q_DB;
    lp.type = 'lowpass'; lp.frequency.value = Math.min(FREQ_SHIFT_LOOP_LP, 0.42 * ctx.sampleRate); lp.Q.value = LR4_Q_DB;
    wet.connect(loopDelay); loopDelay.connect(hp); hp.connect(lp); lp.connect(loopGain); loopGain.connect(sum);
  }
  sum.connect(fI); sum.connect(fQ);
  // Träger: ein cos/sin-Paar je Kanalgruppe (ohne Spreizung eins für alle Kanäle, mit Spreizung je Kanal eins)
  const pairs = [];
  const pair = () => {
    const oCos = ctx.createOscillator(), oSin = ctx.createOscillator();
    oCos.setPeriodicWave(_fsWave(ctx, 'cos')); oSin.setPeriodicWave(_fsWave(ctx, 'sin'));
    const mI = ctx.createGain(), mQ = ctx.createGain();
    mI.gain.value = 0; mQ.gain.value = 0;                 // Träger moduliert den Gain direkt (echte Multiplikation)
    oCos.connect(mI.gain); oSin.connect(mQ.gain);
    const pr = { oCos, oSin, mI, mQ }; pairs.push(pr); return pr;
  };
  if (!spread) {
    const pr = pair();
    fI.connect(pr.mI); fQ.connect(pr.mQ); pr.mI.connect(wet); pr.mQ.connect(wet);
  } else {
    const sI = ctx.createChannelSplitter(2), sQ = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    fI.connect(sI); fQ.connect(sQ);
    for (const c of [0, 1]) {
      const pr = pair();
      sI.connect(pr.mI, c); sQ.connect(pr.mQ, c);
      pr.mI.connect(merge, 0, c); pr.mQ.connect(merge, 0, c);
    }
    merge.connect(wet);
  }
  // Dry = I-Pfad des Eingangs (Entscheidung B); mit Rückkopplung eigenes Filter ohne Schleifenanteil
  let dryI = fI;
  if (fb) { dryI = _fsIIR(ctx, 'i'); src.connect(dryI); }
  dryI.connect(dry);
  wet.connect(output); dry.connect(output);
  const apply = (q, sm) => {
    const set = _setter(ctx, sm), v = freqShiftValues(q);
    const fr = spread ? [v.shift + v.spread, v.shift - v.spread] : [v.shift];
    pairs.forEach((pr, i) => { set(pr.oCos.frequency, fr[i]); set(pr.oSin.frequency, fr[i]); });   // gleiche Werte, gleiche Glättung → exakt 90°
    set(wet.gain, v.mix); set(dry.gain, 1 - v.mix);
    if (loopGain) set(loopGain.gain, v.feedback);
  };
  apply(p, false);
  const t0 = ctx.currentTime;
  // Phasenende 16: Rückkopplung beim Aufbau einblenden (τ = FREQ_SHIFT_LOOP_FADE_S). Bekommt die neue Kette ein laufendes Signal (Einschalten,
  // Neubau), antworten die Hilbert-Filter mit einer Einsatz-Transiente; ohne Einblendung liefe sie sofort voll durch die Schleife und fiele in die
  // Überblendung der Runtime (gemessen [S] Klickmaß bis 2,1 in Chromium). Live-Änderungen setzen danach wie gewohnt per setTargetAtTime auf.
  if (loopGain) { loopGain.gain.value = 0; loopGain.gain.setTargetAtTime(v0.feedback, t0, FREQ_SHIFT_LOOP_FADE_S); }
  for (const pr of pairs) { pr.oCos.start(t0); pr.oSin.start(t0); if (tr) tr.push(pr.oCos, pr.oSin); }   // gemeinsamer Start → feste Phasenbeziehung
  return _inst('freqShift', { input, output }, p, { apply, sig: freqShiftSig });
}

/** Gemeinsame Hall-Hülle: Dry/Wet um einen Convolver. `wetOf(p)` liefert den Anteil; die IR ist nicht glättbar → Modul-Austausch (P10f). */
function _buildConvolverModule(ctx, p, tr, { key, wetOf, irOf, sig, rhoOf = null, wetInsert = null, wetLoop = null, struct = null, normalizeOf = null }) {
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
    const ir = irOf(ctx, q);
    if (normalizeOf) conv.normalize = normalizeOf(q);   // Nachbesserung 19a Teil 2: vor `buffer` setzen (wirkt beim Zuweisen)
    conv.buffer = ir;
    return { input: conv, output: conv, q, ir, dispose() { try { conv.buffer = null; } catch (e) { /* Knoten bereits verworfen */ } } };   // Chrome-Leck (L-02)
  };
  // P19b: `rhoOf(altQ, neuQ, altIR, neuIR)` → Korrelation oder null (feste Equal-Power-Kurve wie bisher)
  const rho = rhoOf ? (o, n) => rhoOf(o.q, n.q, o.ir, n.ir) : null;
  const slot = _hotSlot(ctx, tr, make, p, sig, { fadeSec: 0.05, throttleMs: 150, power: true, rho, tailOf: c => c.ir?.duration ?? 0 });   // P19b: Eingang umblenden, alter Hall klingt aus
  // P19d: optionaler Rückkopplungskreis HINTER dem Hall-Kern (slot.output → Kreis → zurück in slot.input). `wetLoop` → { input, output,
  // update(q), fallback? } | { fallback } | null. Mit Kreis bekommt das Modul einen eigenen Eingang (Gain 1), damit der trockene Anteil
  // nichts aus dem Kreis erhält. Der Kreis sitzt außerhalb des Hot-Slots: Bei einem IR-Wechsel speist er ab der Umblendung den neuen Kern,
  // der alte klingt nur mit seiner eigenen Vorgeschichte aus (19b). Ohne Kreis bleibt der Graph unverändert (room/gated bit-gleich).
  const loopSeg = wetLoop ? wetLoop(p) : null;
  const loop = loopSeg?.input ? loopSeg : null;
  let inp = slot.input;
  if (loop) {
    inp = ctx.createGain();
    inp.connect(slot.input);
    slot.output.connect(loop.input); loop.output.connect(slot.input);
  }
  // P19c: optionaler Baustein im Wet-Pfad HINTER dem Hall-Kern (slot.output → Baustein → wetG). Die Eingangsumblendung (19b) bleibt
  // davon unberührt; der Baustein läuft über einen IR-Wechsel ohne Neustart weiter. `wetInsert` → { input, output, update(q), fallback?,
  // sidechain? } | null. Nachbesserung 19a, Teil 5: `sidechain` = { node, input } bekommt den Moduleingang (trocken, vor dem Hall-Kern).
  const ins = wetInsert ? wetInsert(p) : null;
  inp.connect(dry);
  if (ins?.sidechain) inp.connect(ins.sidechain.node, 0, ins.sidechain.input);
  if (ins) { slot.output.connect(ins.input); ins.output.connect(wetG); } else slot.output.connect(wetG);
  dry.connect(out); wetG.connect(out);
  const extra = [ins, loop].filter(Boolean);
  const applyAll = extra.length ? (q, sm) => { apply(q, sm); for (const e of extra) e.update(q); } : apply;
  const seg = _inst(key, { input: inp, output: out }, p, { apply: applyAll, sig, hot: slot, struct });
  const fb = ins?.fallback || loopSeg?.fallback;
  if (fb) seg.fallback = fb;
  return seg;
}

function _buildReverb(ctx, p, tr, rev = null) {
  if (reverbBuiltMode(p) === 'reverse') return _buildReverseReverb(ctx, p, tr, rev);   // P19e: eigene Bauform (kein Convolver live)
  return _buildConvolverModule(ctx, p, tr, {
    key: 'reverb', wetOf: q => Math.max(0, Math.min(1, q.amount ?? 0.35)), irOf: getGenericIR,
    // Nachbesserung 19a Teil 2: neue Synthese ist bereits normiert (ir-synth.js, Kopf 6) → normalize = false; Altdaten wie bisher
    normalizeOf: reverbNormalize,
    // P19a: neue Synthese mit vollständigem Parameterschlüssel; Altdaten unverändert
    sig: q => (reverbIsLegacy(q) ? `${q.duration ?? 2.2}|${q.decay ?? 2.0}|${q.pre ?? 0.005}` : reverbIRKey(q)),
    // P19b: Die neuen Regler (Dämpfung, Breite, Cuts, frühe Reflexionen) behalten das Rauschen → alte und neue IR sind stark korreliert
    // (ρ bis 1), die Equal-Power-Kurve höbe die Mitte der Überblendung um bis zu +3 dB. Deshalb Kurve nach gemessenem ρ.
    // Altdaten ↔ Altdaten: jede Änderung würfelt das Rauschen neu (ρ ≈ 0) → feste Kurve wie bisher (unverändert).
    rhoOf: (a, b, ia, ib) => (reverbIsLegacy(a) && reverbIsLegacy(b)) ? null : irCorrelation(ia, ib),
    // P19c: Modus strukturell (room ↔ gated = Neubau mit Überblendung durch die Runtime). Gated: Gate des Moduls `noiseGate` im Wet-Pfad,
    // gesteuert vom trockenen Signal (Seitenkette, Nachbesserung 19a, Teil 5).
    struct: reverbBuiltMode,
    wetInsert: q => (reverbBuiltMode(q) === 'gated' ? _reverbGate(ctx, q, tr) : null),
    // P19d: Shimmer-Kreis (Tonhöhe in der Rückkopplung) hinter dem Hall-Kern.
    wetLoop: q => (reverbBuiltMode(q) === 'shimmer' ? _reverbShimmer(ctx, q, tr) : null)
  });
}

/** P19e: strukturelle Signatur des Reverse-Halls: Modus und Vorlauf (der Vorlauf bestimmt Verzögerung und Startpunkt → Neubau). */
const _reverseStruct = q => (reverbBuiltMode(q) === 'reverse' ? 'reverse:' + reverseValues(q).preRoll : reverbBuiltMode(q));
/** P19e: höchstens so viele Wet-Quellen gleichzeitig (sehr kurze Loops mit langer IR). */
const REVERSE_MAX_SOURCES = 32;

/**
 * P19e: Reverse-Hall. Das Wet-Signal ist vorgerendert (reverse-reverb.js: reverse(conv(reverse(x), IR)) aus dem Signal x am Eingang dieses
 * Moduls, Render-Cache) und kommt als `rev` = { buffer, irSamples, sig } herein. Im Buffer liegt der Hall-Anteil zum Eingangssample n bei
 * Index n + irSamples − 1 (der Anstieg endet dort); der Anstieg beginnt bis zu einer IR-Länge davor.
 *   Mit Variante:  Eingang → DelayNode(preRoll) → Dry(1 − amount) → Ausgang;  Buffer-Quelle → Wet(amount) → Ausgang.
 *                  Die Quelle startet zum Start der Wiedergabe (arm, Zeitbasis 13d) bei Offset (irSamples − 1)/sr − preRoll; ein Anstieg,
 *                  der länger als der Vorlauf ist, wird vorne abgeschnitten. Loop (F1 = a): je Durchlauf eine eigene Quelle; ab dem zweiten
 *                  Durchlauf ungekürzt (sie beginnt im vorigen Durchlauf), nur der erste ist um den Vorlauf gekürzt. Alle Durchläufe
 *                  nutzen das Wet-Signal des ersten (eine Variante je Sound).
 *   Ohne Variante (F2 = b): Eingang → Dry → Ausgang, unverzögert, kein Wet.
 * `amount` live. Ändert sich die IR (andere Signatur als die Variante) oder meldet die Vorschau die Variante als veraltet (`rev.stale`,
 * reverse-reverb.js markStaleReverse), schweigt das Wet-Signal bis zum nächsten Start. Ohne gültiges Wet-Signal klingt Dry mit vollem
 * Pegel (Ersatzpegel, Nachbesserung 19a, Teil 5; geglättet beim Wechsel), mit Variante Dry(1 − amount) wie bisher. Der Vorlauf ist strukturell (Neubau). Kein Send.
 */
function _buildReverseReverb(ctx, p, tr, rev) {
  const buf = rev?.buffer || null;
  const inp = ctx.createGain(), dry = ctx.createGain(), wetG = ctx.createGain(), out = ctx.createGain();
  // Ausgang fest stereo (wie der Raum-Hall mit Stereo-IR): Ohne festen Wert wechselte die Kanalzahl mit dem Lauf der Wet-Quelle
  // (vor dem Start mono, danach stereo) und der terminale Panner (Mono → Stereo mit −3 dB) änderte mitten im Klang den Pegel [S, Node].
  out.channelCount = 2; out.channelCountMode = 'explicit'; out.channelInterpretation = 'speakers';
  const preRoll = reverseValues(p).preRoll;
  let delay = null;
  if (buf) {
    delay = ctx.createDelay(REVERSE_PREROLL_RANGE[1] + 0.01);
    delay.delayTime.value = preRoll;
    inp.connect(delay); delay.connect(dry);
  } else inp.connect(dry);
  dry.connect(out); wetG.connect(out);
  let cur = p;
  const apply = (q, sm) => {
    cur = q;
    const set = _setter(ctx, sm);
    const a = Math.max(0, Math.min(1, q.amount ?? 0.35));
    // Nachbesserung 19a, Teil 5 (Hörliste 19, Punkte 38/41): Dry = 1 − a · w, w = 1 nur mit gültiger Variante. Fehlt das Wet-Signal
    // (keine, veraltete oder andere Variante; Musik/Ambient), klingt der trockene Anteil voll statt mit 1 − a (bei a = 1 sonst Stille).
    const w = buf && !rev.stale && reverbIRSig(q) === rev.sig ? 1 : 0;
    set(dry.gain, 1 - a * w);
    set(wetG.gain, a * w);
  };
  apply(p, false);
  const seg = _inst('reverb', { input: inp, output: out }, p, { apply, struct: _reverseStruct });
  if (!buf) { seg.fallback = 'dry'; return seg; }
  // P19e-2: Meldung „veraltet“ der Vorschau sofort übernehmen (geglättet); beim Entsorgen abmelden.
  const refresh = () => apply(cur, true);
  rev.mods?.add(refresh);

  const lead = (Math.max(1, rev.irSamples) - 1) / buf.sampleRate;   // Länge des Anstiegs vor dem Einsatz
  const bufDur = buf.duration;
  const sources = new Map();   // Durchlauf k → AudioBufferSourceNode
  let origin = null;
  const stopAll = t => {
    for (const n of sources.values()) { try { n.stop(t); } catch (e) { /* bereits gestoppt */ } }
    if (t === undefined) { for (const n of sources.values()) { try { n.disconnect(); } catch (e) { /* bereits getrennt */ } } sources.clear(); }
  };
  if (tr) tr.push({ stop() { stopAll(); rev.mods?.delete(refresh); } });
  // Start und Offset der Quelle für Durchlauf k (Context-Zeit). Durchlauf 0 beginnt frühestens mit der Wiedergabe.
  const span = (tm, k) => {
    const ps = tm.passStart + (k - tm.passIndex) * tm.dur;
    if (k === 0) { const t0 = ps + Math.max(0, preRoll - lead); return { t0, off: Math.max(0, lead - preRoll) }; }
    return { t0: ps + preRoll - lead, off: 0 };
  };
  const schedule = (tm, k, from) => {
    if (sources.has(k) || sources.size >= REVERSE_MAX_SOURCES) return;
    const { t0, off } = span(tm, k);
    const at = Math.max(t0, from, ctx.currentTime);
    const offset = off + (at - t0);
    if (offset >= bufDur) return;
    const n = ctx.createBufferSource();
    n.buffer = buf; n.connect(wetG);
    n.start(at, offset);
    n.onended = () => { try { n.disconnect(); } catch (e) { /* bereits getrennt */ } if (sources.get(k) === n) sources.delete(k); };
    sources.set(k, n);
  };
  // Zeitbasis (13d-Vertrag): Quellen mit Beginn vor `to`, die nach `from` noch klingen. Bereits geplante Durchläufe bleiben (reset ändert nur Gains).
  seg.arm = ({ timing: tm, from, to }) => {
    if (origin !== tm.origin) { stopAll(); origin = tm.origin; }
    if (!tm.loop) { schedule(tm, tm.passIndex, from); return; }
    if (!(tm.dur > 0)) return;
    const kLo = Math.max(0, tm.passIndex + Math.floor((from - tm.passStart - preRoll - bufDur) / tm.dur));
    for (let k = kLo; ; k++) {
      const { t0, off } = span(tm, k);
      if (!(t0 < to)) break;
      if (t0 + (bufDur - off) > from) schedule(tm, k, from);
      if (sources.size >= REVERSE_MAX_SOURCES) break;
    }
  };
  // Musik-Pause (hold): Reverse kommt dort nicht vor (R5); der Vollständigkeit halber verstummen.
  seg.hold = t => stopAll(t);
  return seg;
}

/** P19d: Parameter des Pitch-Worklets im Shimmer-Kreis: Algorithmus `music` (Phasenvocoder, polyphon), nur Wet (Mix 1), ohne Formant. */
const _shimmerPitchParams = q => ({ enabled: true, algorithm: 'music', semitones: shimmerValues(q).semitones, cents: 0, mix: 1, formant: 0 });

/**
 * P19d: Shimmer-Kreis. Hallausgang → Tonhöhe (buildPitchNode, `music`; ohne `stft` das Legacy-Worklet `pitch`, E6) → Rückkopplung
 * (≤ SHIMMER_FB_MAX) → Hochpass/Tiefpass (fest, Butterworth) → Schutzsättigung (P14a) → DelayNode (SHIMMER_LOOP_SAMPLES) → zurück in den
 * Hall-Eingang. Jede Runde erklingt also eine Stufe höher (bzw. um das Intervall verschoben) und wird erneut gefaltet. Intervall und
 * Rückkopplung live. Ohne Pitch-Worklet: kein Kreis (klingt wie `room`), `fallback = 'none'`, Hinweis in der Konsole.
 */
function _reverbShimmer(ctx, q, tr) {
  const pitch = buildPitchNode(ctx, _shimmerPitchParams(q), 2);
  if (!pitch) {
    console.warn('[audio] Shimmer-Hall: kein Pitch-Worklet verfügbar — Hall ohne Shimmer');
    return { fallback: 'none' };
  }
  const fb = ctx.createGain(), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), guard = ctx.createWaveShaper();
  const d = ctx.createDelay(1);
  hp.type = 'highpass'; lp.type = 'lowpass'; hp.Q.value = LR4_Q_DB; lp.Q.value = LR4_Q_DB;   // Butterworth (Q in dB)
  hp.frequency.value = SHIMMER_LOOP_HP; lp.frequency.value = Math.min(SHIMMER_LOOP_LP, ctx.sampleRate * 0.45);
  guard.curve = delayGuardCurve();
  d.delayTime.value = SHIMMER_LOOP_SAMPLES / ctx.sampleRate;
  fb.gain.value = shimmerValues(q).feedback;
  pitch.output.connect(fb); fb.connect(hp); hp.connect(lp); lp.connect(guard); guard.connect(d);
  if (tr) tr.push({ stop() { pitch.dispose?.(); } });
  return {
    input: pitch.input, output: d,
    update(nq) { fb.gain.setTargetAtTime(shimmerValues(nq).feedback, ctx.currentTime, SMOOTH_TC); pitch.update(_shimmerPitchParams(nq)); }
  };
}

/**
 * P19c: Gate im Wet-Pfad des Gated-Halls. Baustein des Moduls `noiseGate` (makeDynamicsNode 'gate', Worklet `dynamics`).
 * Nachbesserung 19a, Teil 5 (Hörliste 19, Punkt 23, Prototyp B): gesteuert vom TROCKENEN Signal (Seitenkette = Moduleingang vor dem
 * Hall-Kern, `_buildConvolverModule`). Das Gate öffnet mit dem Schlag und schließt Hold + Release nach dessen Ende, nicht erst im leisen
 * Ausklang des Halls (bis P19c: das Hallsignal steuerte sich selbst). Der Convolver hat keine Latenz, ein Ausgleich entfällt.
 * Schwelle (dBFS des trockenen Signals), Hold und Release live; Attack, Absenkung, Hysterese und Sidechain-Hochpass fest (REVERB_GATE_FIXED, E2 = a).
 * Ohne Worklet: Durchgang (klingt wie `room`), `fallback = 'none'` wie beim Noise Gate, Hinweis in der Konsole.
 */
function _reverbGate(ctx, q, tr) {
  const node = makeDynamicsNode(ctx, 'gate', reverbGateParams(q), { sidechain: true });
  if (!node) {
    console.warn('[audio] Gated-Hall: Worklet "dynamics" nicht verfügbar — Hall ohne Gate');
    const pass = ctx.createGain();
    return { input: pass, output: pass, update() {}, fallback: 'none' };
  }
  if (tr) tr.push({ stop() { node.dispose(); } });
  return { input: node.input, output: node.output, sidechain: node.sidechain, update: nq => node.update(reverbGateParams(nq)) };
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
  if (delayMode(p) === 'reverse') return _buildDelayReverse(ctx, p, tr);
  if (delayMode(p) === 'granular') return _buildDelayGranular(ctx, p, tr);
  return delayIsLegacy(p) ? _buildDelayLegacy(ctx, p) : _buildDelayV2(ctx, p, tr);
}
/**
 * Reverse-Delay (Phase 20e, Modus `reverse`): Worklet `timebuffer` im Modus 'reverseDelay' (Planer audio/dsp-lib/reverse-delay.js).
 * Blöcke der Länge `time` rückwärts, 50 % überlappend mit komplementären Hann-Flanken; Rückkopplung im Worklet (Wiederholungen wechseln
 * rückwärts/vorwärts, Entscheidung B). Low-/High-Cut und Modulation wirken nicht (Entscheidung C). Dry/Wet über die Worklet-Parameter
 * (dry = 1 − wet, live, geglättet); Zeit und Rückkopplung über den Port (Zeit ab dem nächsten Kopfstart, Rückkopplung sofort).
 * Kanäle: fest stereo hinter dem StereoPanner des Knotens (Mono −3,01 dB, M-3, Entscheidung D).
 * Zeitbasis: arm() erkennt den Neustart (Seek leert den Ring), hold() wirkt nicht.
 * Ohne Worklet (Entscheidung Phase 20): bisheriges Delay im Modus `mono` (_buildDelayLegacy: Zeit, Rückkopplung, Wet), `fallback = 'mono'`,
 * Hinweis in der Konsole. Die Signatur bleibt 'reverse' (kein Neubau bei jeder Änderung).
 */
function _buildDelayReverse(ctx, p, tr) {
  const vals = q => { const v = reverseDelayParams(q); return { time: v.time, feedback: delayLoopGains(q).fb, wet: v.wet }; };
  const v = vals(p);
  const node = makeTimebufferNode(ctx, { mode: 'reverseDelay', maxSeconds: REVDELAY_BUFFER_SECONDS, params: v, dry: 1 - v.wet, wet: v.wet, seed: 0x2E5D });
  if (!node) {
    console.warn('[audio] Reverse-Delay: Worklet "timebuffer" nicht verfügbar — Modus mono');
    const seg = _buildDelayLegacy(ctx, p);
    seg.fallback = 'mono';
    return seg;
  }
  if (tr) tr.push({ stop() { node.dispose(); } });
  const apply = (q, live) => { const w = vals(q); node.update({ dry: 1 - w.wet, wet: w.wet }); if (live) node.setParams(w); };
  const seg = _inst('delay', { input: node.input, output: node.output }, p, { apply, sig: _delaySig });
  seg.arm = ({ timing }) => node.arm(timing);
  seg.hold = () => node.hold();
  return seg;
}
/**
 * Granular-Delay (Phase 20f, Modus `granular`): Worklet `timebuffer` im Modus 'granularDelay' (Planer audio/dsp-lib/granular-delay.js).
 * Körner (Hann-Fenster) aus dem Puffer im festen Abstand 1/Dichte, Verzögerung der Kornmitte = `time` ± Spray, Tonhöhe über die Kopf-Rate,
 * Kornpegel 1/√Überlappung (Entscheidung C), alle Kanäle an derselben Position (D). Rückkopplung im Worklet wie Reverse. Low-/High-Cut und
 * Modulation wirken nicht. Dry/Wet über die Worklet-Parameter (dry = 1 − wet), übrige Regler über den Port (ab dem nächsten Korn).
 * Zufall: fester Seed je Bau 0x6A1F (Entscheidung E: jede Wiedergabe gleich). Zeitbasis wie Reverse (Seek leert, hold() wirkt nicht).
 * Ohne Worklet (Entscheidung Phase 20): bisheriges Delay im Modus `mono` (_buildDelayLegacy), `fallback = 'mono'`, Hinweis in der Konsole.
 */
function _buildDelayGranular(ctx, p, tr) {
  const vals = q => ({ ...granularDelayParams(q), feedback: delayLoopGains(q).fb });
  const v = vals(p);
  const node = makeTimebufferNode(ctx, { mode: 'granularDelay', maxSeconds: GRDELAY_BUFFER_SECONDS, params: v, dry: 1 - v.wet, wet: v.wet, seed: 0x6A1F });
  if (!node) {
    console.warn('[audio] Granular-Delay: Worklet "timebuffer" nicht verfügbar — Modus mono');
    const seg = _buildDelayLegacy(ctx, p);
    seg.fallback = 'mono';
    return seg;
  }
  if (tr) tr.push({ stop() { node.dispose(); } });
  const apply = (q, live) => { const w = vals(q); node.update({ dry: 1 - w.wet, wet: w.wet }); if (live) node.setParams(w); };
  const seg = _inst('delay', { input: node.input, output: node.output }, p, { apply, sig: _delaySig });
  seg.arm = ({ timing }) => node.arm(timing);
  seg.hold = () => node.hold();
  return seg;
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
 * Prüft die Context-spezifische Worklet-Bereitschaft (`isWorkletReady(ctx, id)`) statt des globalen, nur für den Live-AudioContext
 * gültigen `APP.pitchWorkletReady`-Flags. Damit liefert dieselbe Funktion für Live-AudioContext UND OfflineAudioContext (Export) ein
 * konsistentes Ergebnis, sofern der Aufrufer zuvor die Worklets des Plans geladen hat (preparePipelineContext / runtime.prepare).
 *
 * Phase 17b: Algorithmus je `registry.pitchValues`:
 *   legacy  Grain-Worklet `pitch` (unverändert; Faktor = 2^(Halbtöne/12); `cents` und `mix` ohne Wirkung und in der UI ausgeblendet)
 *   music   Worklet `stft` (Phasenvocoder, Latenz 2048 Samples, Mix im Worklet mit deckungsgleich verzögertem Dry-Anteil; Formant seit 17d)
 *   voice   Worklet `stft` mit `processorOptions.algorithm = 'voice'` (WSOLA, Latenz 1344 Samples, Mix wie `music`)
 * Ist `stft` nicht geladen, aber `pitch`: Legacy-Worklet als Ersatz (Entscheidung E, Konsolenwarnung; Mix entfällt). Sonst null → Detune.
 * Ob überhaupt ein Knoten gebaut wird, entscheidet `registry.pitchActive` (Runtime); hier null bei inaktiven Parametern.
 *
 * @param {number} [numChannels=2] Kanalzahl der Quelle (buffer.numberOfChannels).
 *   Stereo-fähige Worklets: `channelCountMode:'explicit'` + `channelInterpretation:'discrete'` verhindert, dass der Browser bei
 *   Mono-Quellen automatisch hoch- bzw. bei Multi-Channel-Quellen heruntermischt, BEVOR das Worklet die Kanäle sieht — jeder Kanal
 *   bekommt im Prozessor eine eigene, unabhängige Engine.
 */
export function buildPitchNode(ctx, p, numChannels = 2) {
  if (!pitchActive({ ...p, enabled: true })) return null;
  const v = pitchValues(p);
  const ch = Math.max(1, Math.min(2, numChannels || 2));
  const opts = { numberOfInputs: 1, numberOfOutputs: 1, channelCount: ch, channelCountMode: 'explicit', channelInterpretation: 'discrete', outputChannelCount: [ch] };
  let kind = v.algorithm === 'legacy' ? 'legacy' : 'stft';
  if (kind === 'stft' && !isWorkletReady(ctx, 'stft')) {
    if (!isWorkletReady(ctx, 'pitch')) return null;
    console.warn('[audio] Worklet "stft" nicht verfügbar — Tonhöhe über das Legacy-Worklet (ohne Mix)');
    kind = 'legacy';
  }
  if (kind === 'legacy' && !isWorkletReady(ctx, 'pitch')) return null; // caller uses src.detune as fallback
  try {
    const n = kind === 'stft'
      ? new AudioWorkletNode(ctx, 'stft-pitch-processor', { ...opts, processorOptions: { algorithm: v.algorithm }, parameterData: { pitchFactor: v.factor, mix: v.mix, formantFactor: v.formantFactor } })
      : new AudioWorkletNode(ctx, 'pitch-shifter-processor', opts);
    const pf = n.parameters.get('pitchFactor'), mx = kind === 'stft' ? n.parameters.get('mix') : null, fmt = kind === 'stft' ? n.parameters.get('formantFactor') : null;
    if (kind === 'legacy') pf.setValueAtTime(v.factor, ctx.currentTime);
    // Live-Update: Faktor (und bei `stft` Mix) sind glättbar. Wechsel des Algorithmus oder aktiv ↔ inaktiv ⇒ false (Neubau/Überblendung
    // durch die Runtime). Ein Ersatz-Legacy-Knoten bleibt bei `music`/`voice` (Algorithmus unverändert), damit kein Dauer-Neubau entsteht.
    const builtAlg = v.algorithm;
    const seg = { input: n, output: n, key: 'pitchShift', algorithm: kind === 'stft' ? v.algorithm : 'legacy', latency: kind === 'stft' ? (v.algorithm === 'voice' ? PITCH_VOICE_LATENCY : PITCH_PV_LATENCY) : 0 };
    seg.dispose = () => { try { n.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } };   // Prozessor beenden (Fix A)
    seg.update = np => {
      if (!pitchActive({ ...np, enabled: true })) return false;
      const w = pitchValues(np);
      if (w.algorithm !== builtAlg) return false;
      const t = ctx.currentTime;
      pf.setTargetAtTime(w.factor, t, SMOOTH_TC);
      if (mx) mx.setTargetAtTime(w.mix, t, SMOOTH_TC);
      if (fmt) fmt.setTargetAtTime(w.formantFactor, t, SMOOTH_TC);
      return true;
    };
    return seg;
  } catch (e) { console.warn('[audio] PitchWorklet node failed:', e.message); }
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
function _collectSegments(ctx, effects, tr, omit, rev = null) {
  const segs = [];

  // Stutter (Phase 20b, layerOrder 5): direkt hinter dem Tonhöhen-Knoten am Layer-Kopf, vor den Filtern.
  if (effects.stutter?.enabled)    segs.push(_buildStutter(ctx, effects.stutter, tr));
  // Beat Repeat (Phase 20c, layerOrder 6): direkt nach Stutter.
  if (effects.beatRepeat?.enabled) segs.push(_buildBeatRepeat(ctx, effects.beatRepeat, tr));
  // Retrigger (Phase 20d, layerOrder 7): direkt nach Beat Repeat.
  if (effects.retrigger?.enabled)  segs.push(_buildRetrigger(ctx, effects.retrigger, tr));

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
  // Bitcrusher (Phase 15c, layerOrder 75): hinter der Verzerrung, vor der Ringmodulation.
  if (effects.crusher?.enabled)    segs.push(_buildCrusher(ctx, effects.crusher, tr));
  if (effects.ringmod?.enabled)    segs.push(_buildRingMod(ctx, effects.ringmod, tr));
  // Frequenzschieber (Phase 16a, layerOrder 82): direkt hinter der Ringmodulation, vor der Modulationsfamilie.
  if (effects.freqShift?.enabled)  segs.push(_buildFreqShift(ctx, effects.freqShift, tr));

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
  else if (effects.reverb?.enabled) { if (!omit?.has('reverb')) segs.push(_buildReverb(ctx, effects.reverb, tr, rev)); }

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
  let segs = _collectSegments(ctx, params, opts.track, opts.omit, opts.reverse || null);   // P19e: Variante des Reverse-Halls
  const sp = _buildSpatialPanner(ctx, params.spatial);
  if (sp) segs.push(sp);
  if (opts.bypassable) segs = segs.map(s => _wrapBypass(ctx, s));
  return _chain(segs);
}

// Fade-Kurven werden zentral in renderPipeline.js (renderSoundGraph()) berechnet,
// auf getrennten, in Serie geschalteten Gain-Nodes.

