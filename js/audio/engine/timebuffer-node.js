/**
 * audio/engine/timebuffer-node.js — Time-Buffer-Knoten (Phase 20a): dünne Hülle um das Worklet `timebuffer`.
 * Vertrag wie crusher-node.js: { input, output, update(p), dispose() } oder null, wenn das Worklet im Context nicht geladen ist
 * (Aufrufer: vorher `await ensureWorklets(ctx, ['timebuffer'])`; Fallback laut Worklet-Registry: 'none', das Modul wird übersprungen).
 * Zusätzlich: `maxSeconds` (tatsächliche Pufferlänge), `bytes` (Speicher des Puffers), `latency` (0: die Köpfe lesen nur Vergangenes).
 *
 * Kanäle: Eingang über einen StereoPanner bei pan 0 (M-3: Mono → L = R mit −3,01 dB, Stereo unverändert, wie _stereoSplit in
 * effect-graph.js), Worklet fest stereo (channelCount 2 'explicit', outputChannelCount [2]), damit Nachklänge nach dem Ende der Quelle
 * stereo bleiben.
 *
 * Pufferlänge (Ressourcen, Plan P20): Standard und Obergrenze je Gerät — Desktop 4 s, Mobil 2 s (Mobil-Degradation: kürzerer Puffer).
 * Die Erkennung „Mobil“ ist dieselbe Regel wie in render-cache.js (_isMobile, dort nicht exportiert).
 *
 * Phase 20b, Modus 'stutter': `params` (Startwerte), `setParams(q)` (Port, ab dem nächsten Ereignis), `arm(timing)` (Zeitbasis 13d in
 * Context-Sekunden → Frames; Zufall je Wiedergabe: seed = Grundwert ⊕ Hash des Ursprungs-Frames, der Export startet bei Frame 0 und ist
 * damit reproduzierbar), `hold()` (Musik-Pause). Mix über den Parameter `wet`.
 * Phase 20c, Modus 'beatRepeat': gleiche Schnittstelle (params, setParams, arm, hold), Planer audio/dsp-lib/beat-repeat.js.
 * Phase 20d, Modus 'retrigger': gleiche Schnittstelle, Planer audio/dsp-lib/retrigger.js (Onset-Erkennung im Prozessor).
 * Phase 20e, Modus 'reverseDelay' (Delay-Modus `reverse`): gleiche Schnittstelle, Planer audio/dsp-lib/reverse-delay.js; `latency` =
 *   REVDELAY_LATENCY_SAMPLES / sr (Kopfstart am jüngsten lesbaren Sample; die Blockverzögerung selbst ist der Effekt und zählt nicht).
 * Phase 20f, Modus 'granularDelay' (Delay-Modus `granular`): gleiche Schnittstelle, Planer audio/dsp-lib/granular-delay.js; `latency` 0
 *   (die Kornverzögerung ist der Effekt). Der Planer übernimmt den Seed aus arm() nicht (fester Seed je Bau, Entscheidung E).
 */
import { isWorkletReady } from '../context.js';
import { tbBufferBytes, TB_MIN_SECONDS } from '../dsp-lib/timebuffer.js';
import { REVDELAY_LATENCY_SAMPLES } from '../dsp-lib/reverse-delay.js';

export const TB_SECONDS_DESKTOP = 4;
export const TB_SECONDS_MOBILE = 2;

/** Mobilgerät? userAgentData.mobile, sonst grober Zeiger (Touch als Hauptbedienung). Ohne Browser-Umgebung: nein. */
function _isMobile() {
  try {
    const m = globalThis.navigator?.userAgentData?.mobile;
    if (typeof m === 'boolean') return m;
    return !!globalThis.matchMedia?.('(pointer: coarse)').matches;
  } catch { return false; }
}

let _cap = null;   // null = automatisch (Desktop/Mobil)
/** Obergrenze der Pufferlänge in Sekunden für dieses Gerät. */
export function timebufferMaxSeconds() { return _cap ?? (_isMobile() ? TB_SECONDS_MOBILE : TB_SECONDS_DESKTOP); }
/** Obergrenze festlegen (Sekunden); null = wieder automatisch. Für Tests und Diagnose. */
export function setTimebufferMaxSeconds(s) { _cap = Number.isFinite(s) && s > 0 ? s : null; }

/**
 * @param {BaseAudioContext} ctx
 * @param {{maxSeconds?:number, seed?:number, mode?:'thru'|'probe'|'stutter'|'beatRepeat'|'retrigger'|'reverseDelay'|'granularDelay', probeHeads?:number, params?:object, dry?:number, wet?:number}} [o]
 *   maxSeconds wird auf TB_MIN_SECONDS … timebufferMaxSeconds() geklemmt; Standard = Obergrenze.
 */
/** Zufall je Wiedergabe (20b): Grundwert ⊕ Hash des Ursprungs-Frames (gleicher Ursprung ⇒ gleiche Entscheidungen). */
export function timebufferSeed(base, originF) {
  return ((base >>> 0) ^ Math.imul((Math.round(originF) | 0) ^ 0x2545F491, 0x9E3779B1)) >>> 0;
}

export function makeTimebufferNode(ctx, o = {}) {
  if (!isWorkletReady(ctx, 'timebuffer')) return null;
  const cap = timebufferMaxSeconds();
  const maxSeconds = Math.max(TB_MIN_SECONDS, Math.min(cap, Number.isFinite(o.maxSeconds) ? o.maxSeconds : cap));
  const vals = q => ({ dry: Number.isFinite(q.dry) ? Math.max(0, Math.min(1, q.dry)) : 1, wet: Number.isFinite(q.wet) ? Math.max(0, Math.min(1, q.wet)) : 1 });
  let node, up;
  try {
    up = ctx.createStereoPanner();
    up.pan.value = 0;
    node = new AudioWorkletNode(ctx, 'timebuffer-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      parameterData: vals(o),
      processorOptions: { maxSeconds, seed: (o.seed ?? 1) >>> 0, mode: ['probe', 'stutter', 'beatRepeat', 'retrigger', 'reverseDelay', 'granularDelay'].includes(o.mode) ? o.mode : 'thru', probeHeads: o.probeHeads, params: o.params }
    });
    up.connect(node);
  } catch (e) { console.warn('[audio] Time-Buffer-Worklet nicht erzeugbar:', e && e.message); try { up?.disconnect(); } catch { /* */ } return null; }
  const prm = node.parameters;
  let disposed = false;
  const base = (o.seed ?? 1) >>> 0, sr = ctx.sampleRate;
  const post = m => { if (!disposed) { try { node.port.postMessage(m); } catch (e) { /* Port zu */ } } };
  return {
    input: up, output: node,
    maxSeconds,
    bytes: tbBufferBytes(ctx.sampleRate, maxSeconds, 2),
    latency: o.mode === 'reverseDelay' ? REVDELAY_LATENCY_SAMPLES / ctx.sampleRate : 0,
    update(np = {}) {
      if (disposed) return;
      const t = ctx.currentTime;
      const v = vals(np);
      for (const name of ['dry', 'wet']) if (Number.isFinite(np[name])) prm.get(name)?.setValueAtTime(v[name], t);   // nur genannte Werte
    },
    /** 20b–20f: neue Regler des Planers (Modi 'stutter', 'beatRepeat', 'retrigger', 'reverseDelay', 'granularDelay'). */
    setParams(q) { post({ type: 'params', params: q }); },
    /** 20b: Zeitbasis (engine/timebase.js makeTiming, Context-Sekunden). */
    arm(tm) {
      if (!tm) return;
      const originF = Math.round((tm.origin ?? 0) * sr);
      post({ type: 'arm', timing: { originF, passStartF: Math.round((tm.passStart ?? tm.origin ?? 0) * sr), passIndex: tm.passIndex ?? 0, durF: Math.round((tm.dur ?? 0) * sr), loop: !!tm.loop, seed: timebufferSeed(base, originF) } });
    },
    /** 20b: Musik-Pause. */
    hold() { post({ type: 'hold' }); },
    dispose() {
      if (disposed) return; disposed = true;
      try { up.disconnect(); } catch (e) { /* bereits getrennt */ }
      try { node.disconnect(); } catch (e) { /* bereits getrennt */ }
      try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ }
    }
  };
}
