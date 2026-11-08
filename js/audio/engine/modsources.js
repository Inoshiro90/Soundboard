/**
 * audio/engine/modsources.js — Modulationsquellen (Phase 5): LFO und Hüllkurvenfolger als Steuersignal.
 * ----------------------------------------------------------------------------------------------------
 * Bausteine für Module ab P10/P12 (Auto-Filter, Auto-Wah, Phaser, Auto-Pan …). Bestehende Module (Tremolo, Chorus,
 * Flanger, Wah-Wah, Ringmod) bauen weiter ihre eigenen Oszillatoren; sie werden NICHT umgestellt (klangneutral, Goldens).
 *
 * Gemeinsamer Vertrag (wie EffectInstance, AE-04′): `output` (AudioNode, anschließbar an einen AudioParam),
 * `update(params)`, `dispose()`. Oszillatoren werden bei dispose() gestoppt und getrennt (B-24).
 * Sample&Hold (Phase 20g, Form `sh`): nativ über einen geloopten AudioBufferSourceNode mit vorberechneter Stufenfolge (makeShBuffer).
 */
import { isWorkletReady } from '../context.js';
import { hashRand } from '../dsp-lib/prng.js';

const SHAPES = { sine: 'sine', triangle: 'triangle', square: 'square', saw: 'sawtooth' };
export const LFO_SHAPES = [...Object.keys(SHAPES), 'sh'];   // 20g: + 'sh' (Sample&Hold)

const RATE_RANGE = [0.01, 40];    // Hz
const SMOOTH_TC = 0.02;           // s, wie bei den übrigen Live-Updates

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Bipolarer LFO: Oszillator → Gain(depth). `depth` ist der Spitzenwert in der Einheit des Ziel-AudioParams
 * (z. B. Hz bei `frequency`). Der Basiswert des Ziels bleibt beim Aufrufer.
 * @param {BaseAudioContext} ctx
 * Form `sh` (20g): Stufenquelle statt Oszillator (`osc` = null, `src` = AudioBufferSourceNode, Rate über playbackRate). Ein Wechsel
 * zwischen `sh` und einer Oszillatorform ist nicht neustartfrei und wird in update() ignoriert (Aufrufer baut neu).
 * @param {{shape?: 'sine'|'triangle'|'square'|'saw'|'sh', rate?: number, depth?: number, seed?: number}} [p]
 * @returns {{output: GainNode, osc: OscillatorNode|null, src?: AudioBufferSourceNode, update(p:object):void, start(when?:number):void, dispose():void}}
 */
export function makeLfo(ctx, p = {}) {
  if (p.shape === 'sh') return _makeShLfo(ctx, p);
  const osc = ctx.createOscillator();
  const out = ctx.createGain();
  osc.type = SHAPES[p.shape] || 'sine';
  osc.frequency.value = clamp(Number.isFinite(p.rate) ? p.rate : 1, RATE_RANGE[0], RATE_RANGE[1]);
  out.gain.value = Number.isFinite(p.depth) ? p.depth : 1;
  osc.connect(out);
  let started = false, disposed = false;
  return {
    output: out,
    osc,
    /** Form (Neustart-frei) sowie Rate/Tiefe (geglättet). */
    update(np = {}) {
      if (disposed) return;
      const t = ctx.currentTime;
      if (np.shape && SHAPES[np.shape]) osc.type = SHAPES[np.shape];
      if (Number.isFinite(np.rate)) osc.frequency.setTargetAtTime(clamp(np.rate, RATE_RANGE[0], RATE_RANGE[1]), t, SMOOTH_TC);
      if (Number.isFinite(np.depth)) out.gain.setTargetAtTime(np.depth, t, SMOOTH_TC);
    },
    start(when) { if (!started && !disposed) { started = true; osc.start(when ?? 0); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { if (started) osc.stop(); } catch (e) { /* war bereits gestoppt */ }
      try { osc.disconnect(); out.disconnect(); } catch (e) { /* bereits getrennt */ }
    }
  };
}

/**
 * LFO-Wellenform mit Phasenversatz (Phase 12): `PeriodicWave` aus den Fourier-Koeffizienten der Spezifikation (Web Audio §OscillatorNode:
 * sine b1 = 1; square b_k = 4/(kπ), k ungerade; saw b_k = 2·(−1)^(k+1)/(kπ); triangle b_k = 8·sin(kπ/2)/(kπ)²), jede Harmonische k um k·φ
 * gedreht: b·sin(kωt + kφ) = b·sin(kφ)·cos(kωt) + b·cos(kφ)·sin(kωt) → real[k] = b·sin(kφ), imag[k] = b·cos(kφ). Normalisierung wie bei den
 * eingebauten Formen (Spitzenwert 1). Gebraucht für L/R-Versatz (Stereo-Tremolo, Flanger) und Startphase (Auto-Pan); ein Oszillator mit
 * `type` kennt keine Phase. Zahl der Harmonischen: 2048 (≈ Tabellengrenze der Browser bei 48 kHz [H]), Sinus nur eine.
 * @param {BaseAudioContext} ctx
 * @param {'sine'|'triangle'|'square'|'saw'} shape  unbekannt → sine
 * @param {number} phaseDeg  Phasenversatz in Grad (Vorlauf)
 * @returns {PeriodicWave}
 */
export const LFO_HARMONICS = 2048;
const _waveCache = new WeakMap();   // ctx → Map(`${shape}|${phase}` → PeriodicWave); PeriodicWave ist an den Context gebunden
export function makePhasedWave(ctx, shape, phaseDeg = 0) {
  const sh = SHAPES[shape] ? shape : 'sine';
  const ph = Number.isFinite(phaseDeg) ? ((phaseDeg % 360) + 360) % 360 : 0;
  let m = _waveCache.get(ctx);
  if (!m) { m = new Map(); _waveCache.set(ctx, m); }
  const id = `${sh}|${ph}`;
  if (m.has(id)) return m.get(id);
  const n = sh === 'sine' ? 1 : LFO_HARMONICS;
  const re = new Float32Array(n + 1), im = new Float32Array(n + 1);
  const phi = ph * Math.PI / 180;
  for (let k = 1; k <= n; k++) {
    let b = 0;
    if (sh === 'sine') b = k === 1 ? 1 : 0;
    else if (sh === 'square') b = k % 2 ? 4 / (k * Math.PI) : 0;
    else if (sh === 'saw') b = (k % 2 ? 2 : -2) / (k * Math.PI);
    else b = 8 * Math.sin(k * Math.PI / 2) / ((k * Math.PI) * (k * Math.PI));
    if (b === 0) continue;
    re[k] = b * Math.sin(k * phi);
    im[k] = b * Math.cos(k * phi);
  }
  const w = ctx.createPeriodicWave(re, im, { disableNormalization: false });
  m.set(id, w);
  return w;
}

/**
 * Sample&Hold (Phase 20g, Entscheidungen A–H = a): Stufenfolge aus SH_STEPS Stufen zu je SH_STEP_SAMPLES Samples (Context-Rate), Wert je
 * Stufe gleichverteilt in [−1, 1) über hashRand(seed, k, SH_SALT) — fest je Seed, also jede Wiedergabe gleich und Live = Vorschau = Export (E).
 * Glättung (D): die ersten SH_SLEW_SAMPLES jeder Stufe gehen per Kosinus vom Vorgänger (zyklisch, Stufe 0 ← Stufe N−1) zum neuen Wert —
 * ein fester Anteil der Stufe (2 %), also bei 20 Hz ≈ 1 ms, bei 0,5 Hz ≈ 40 ms. Abgespielt als geloopter AudioBufferSourceNode mit
 * playbackRate = rate · SH_STEP_SAMPLES / sampleRate (shPlaybackRate) → genau `rate` Stufen je Sekunde; die Folge wiederholt sich nach
 * SH_STEPS / rate Sekunden. Startphase (H): 360° = eine Stufe (shStartOffset). Puffer je Context und Seed zwischengespeichert.
 */
export const SH_STEPS = 256;
export const SH_STEP_SAMPLES = 1024;
export const SH_SLEW_SAMPLES = Math.round(SH_STEP_SAMPLES * 0.02);   // 20
const SH_SALT = 0x5348;
const _shCache = new WeakMap();   // ctx → Map(seed → AudioBuffer)

/** Stufenwert k (zyklisch) in [−1, 1). Rein, für Tests und Puffer. */
export function shValue(seed, k) {
  const kk = ((k % SH_STEPS) + SH_STEPS) % SH_STEPS;
  return 2 * hashRand(seed >>> 0, kk, SH_SALT) - 1;
}

/** Stufenfolge als Float32Array (Länge SH_STEPS · SH_STEP_SAMPLES); rein, ohne Context. */
export function shSamples(seed) {
  const L = SH_STEP_SAMPLES, T = SH_SLEW_SAMPLES, out = new Float32Array(SH_STEPS * L);
  let prev = shValue(seed, SH_STEPS - 1);
  for (let k = 0; k < SH_STEPS; k++) {
    const v = shValue(seed, k), o = k * L;
    for (let i = 0; i < T; i++) out[o + i] = prev + (v - prev) * 0.5 * (1 - Math.cos(Math.PI * (i + 1) / T));
    out.fill(v, o + T, o + L);
    prev = v;
  }
  return out;
}

/** Einkanaliger AudioBuffer der Stufenfolge (Context-Rate), zwischengespeichert. */
export function makeShBuffer(ctx, seed) {
  const sd = seed >>> 0;
  let m = _shCache.get(ctx);
  if (!m) { m = new Map(); _shCache.set(ctx, m); }
  if (m.has(sd)) return m.get(sd);
  const data = shSamples(sd);
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data, 0);
  m.set(sd, buf);
  return buf;
}

/** playbackRate für `rate` Stufen je Sekunde. */
export const shPlaybackRate = (ctx, rate) => rate * SH_STEP_SAMPLES / ctx.sampleRate;

/**
 * Rate einer Stufenquelle setzen (Hz). `smooth`: geglättet wie die übrigen Live-Updates (SMOOTH_TC), aber mit Ankerwert
 * (setValueAtTime des aktuellen Werts unmittelbar davor). Grund [S, node-web-audio-api 2.2.0]: ein setTargetAtTime mit Startzeit > 0
 * als erstes Ereignis auf playbackRate/detune eines AudioBufferSourceNode lässt das Rendern hängen bzw. rechnet die Rate vor dem
 * Ereignis falsch; mit Anker korrekt. Die Leseposition bleibt stetig, der Anker ist daher unhörbar.
 */
export function shSetRate(ctx, src, rate, smooth) {
  const v = shPlaybackRate(ctx, rate), pr = src.playbackRate;
  if (!smooth) { pr.value = v; return; }
  const t = ctx.currentTime;
  pr.setValueAtTime(pr.value, t);
  pr.setTargetAtTime(v, t, SMOOTH_TC);
}

/** Startversatz im Puffer (Sekunden) für eine Startphase in Grad (360° = eine Stufe). */
export function shStartOffset(ctx, phaseDeg = 0) {
  const ph = Number.isFinite(phaseDeg) ? ((phaseDeg % 360) + 360) % 360 : 0;
  return (ph / 360) * SH_STEP_SAMPLES / ctx.sampleRate;
}

/** Geloopte, noch nicht gestartete Stufenquelle. Start: `src.start(when, shStartOffset(ctx, phase))`. */
export function makeShSource(ctx, { seed = SH_SALT, rate = 1 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = makeShBuffer(ctx, seed);
  src.loop = true;
  src.playbackRate.value = shPlaybackRate(ctx, rate);
  return src;
}

function _makeShLfo(ctx, p) {
  const out = ctx.createGain();
  const src = makeShSource(ctx, { seed: Number.isFinite(p.seed) ? p.seed : SH_SALT, rate: clamp(Number.isFinite(p.rate) ? p.rate : 1, RATE_RANGE[0], RATE_RANGE[1]) });
  out.gain.value = Number.isFinite(p.depth) ? p.depth : 1;
  src.connect(out);
  let started = false, disposed = false;
  return {
    output: out,
    osc: null,
    src,
    update(np = {}) {
      if (disposed) return;
      const t = ctx.currentTime;
      if (Number.isFinite(np.rate)) shSetRate(ctx, src, clamp(np.rate, RATE_RANGE[0], RATE_RANGE[1]), true);
      if (Number.isFinite(np.depth)) out.gain.setTargetAtTime(np.depth, t, SMOOTH_TC);
    },
    start(when) { if (!started && !disposed) { started = true; src.start(when ?? 0, shStartOffset(ctx, p.phase)); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { if (started) src.stop(); } catch (e) { /* war bereits gestoppt */ }
      try { src.disconnect(); out.disconnect(); } catch (e) { /* bereits getrennt */ }
    }
  };
}

/**
 * Hüllkurvenfolger als Steuersignal (Worklet `envfollower`). `null`, wenn das Worklet im Context nicht geladen ist
 * (Aufrufer: vorher `await ensureWorklets(ctx, ['envfollower'])`; Fallback laut Worklet-Registry: Baustein überspringen).
 * @param {BaseAudioContext} ctx
 * @param {{attack?: number, release?: number, mode?: 'peak'|'rms'}} [p]  attack/release in Sekunden
 * @returns {{input: AudioWorkletNode, output: AudioWorkletNode, update(p:object):void, dispose():void}|null}
 */
export function makeEnvelopeFollower(ctx, p = {}) {
  if (!isWorkletReady(ctx, 'envfollower')) return null;
  let node;
  try {
    node = new AudioWorkletNode(ctx, 'envelope-follower-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 2, channelCountMode: 'max'
    });
  } catch (e) { console.warn('[audio] Envelope-Follower nicht erzeugbar:', e && e.message); return null; }
  const prm = node.parameters;
  const apply = (np, smooth) => {
    const t = ctx.currentTime, set = (a, v) => { if (!a || !Number.isFinite(v)) return; smooth ? a.setTargetAtTime(v, t, SMOOTH_TC) : a.setValueAtTime(v, t); };
    set(prm.get('attack'), np.attack);
    set(prm.get('release'), np.release);
    if (np.mode) prm.get('mode').setValueAtTime(np.mode === 'rms' ? 1 : 0, t);
  };
  apply(p, false);
  let disposed = false;
  return {
    input: node, output: node,
    update(np = {}) { if (!disposed) apply(np, true); },
    dispose() { if (disposed) return; disposed = true; try { node.disconnect(); } catch (e) { /* bereits getrennt */ } try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } }   // Prozessor beenden (Fix A)
  };
}
