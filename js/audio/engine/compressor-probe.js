/**
 * audio/engine/compressor-probe.js — Pre-Delay des nativen DynamicsCompressorNode (Phase 11c, Messung M-8).
 *
 * Der native Kompressor verzögert das Signal (Lookahead) und die Zeit ist je Engine verschieden: Chrome und Firefox 288 Samples = 6,0 ms
 * bei 48 kHz [S], Node (node-web-audio-api) 384 Samples [S]. Der Dry-Pfad der Parallelkompression (mix < 1) muss dieselbe Zeit verzögern, sonst
 * entstehen Kammfilter. Statt eine feste Zahl anzunehmen, misst eine kleine Offline-Probe sie einmal je Samplerate (Impuls durch einen Kompressor).
 *
 * Der Aufbau des Graphen ist synchron: `compressorLatencySamples()` liefert den gemessenen Wert, bis zur Messung 6 ms (Browser-Wert).
 * Die Vorbereitung des Plans (`preparePipelineContext`, `runtime.prepare`) ruft `ensureCompressorLatency()` vor dem Aufbau.
 */

const _samples = new Map();   // Samplerate → Samples
const _pending = new Map();   // Samplerate → Promise

const clampSamples = (n, sr) => Math.max(1, Math.min(Math.round(sr * 0.05), n));

/** Gemessene (oder angenommene 6 ms) Verzögerung des nativen Kompressors in Samples. */
export function compressorLatencySamples(sampleRate) {
  const m = _samples.get(sampleRate);
  return m !== undefined ? m : clampSamples(Math.round(0.006 * sampleRate), sampleRate);
}

/** Misst die Verzögerung einmal je Samplerate (idempotent, gleichzeitige Aufrufe teilen sich eine Messung). Fehler → Annahme 6 ms. */
export function ensureCompressorLatency(sampleRate) {
  if (_samples.has(sampleRate)) return Promise.resolve(_samples.get(sampleRate));
  if (_pending.has(sampleRate)) return _pending.get(sampleRate);
  const p = (async () => {
    let result = clampSamples(Math.round(0.006 * sampleRate), sampleRate);
    try {
      const Offline = globalThis.OfflineAudioContext;
      if (typeof Offline === 'function') {
        const n = Math.ceil(sampleRate * 0.1), at = 200;
        const ctx = new Offline(2, n, sampleRate);
        const buf = ctx.createBuffer(2, n, sampleRate);
        buf.getChannelData(0)[at] = 0.5; buf.getChannelData(1)[at] = 0.5;
        const src = ctx.createBufferSource(); src.buffer = buf;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = 0; comp.ratio.value = 1; comp.knee.value = 0;
        src.connect(comp); comp.connect(ctx.destination); src.start();
        const out = (await ctx.startRendering()).getChannelData(0);
        let idx = -1, pk = 0;
        for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (Number.isFinite(a) && a > pk) { pk = a; idx = i; } }
        if (idx >= at && pk > 0.01) result = clampSamples(idx - at, sampleRate);
      }
    } catch (e) { /* Annahme bleibt */ }
    _samples.set(sampleRate, result);
    _pending.delete(sampleRate);
    return result;
  })();
  _pending.set(sampleRate, p);
  return p;
}

/** Braucht der Plan die Messung (Parallelkompression mit Dry-Pfad)? */
export function planNeedsCompressorProbe(plan) {
  return !!plan?.steps?.some(s => { const c = s.params?.compressor; return c?.enabled && Number.isFinite(c.mix) && c.mix < 1; });
}

/** Nur für Tests: Messwert setzen/zurücksetzen. */
export function _setCompressorLatencyForTest(sampleRate, samples) { if (samples == null) _samples.delete(sampleRate); else _samples.set(sampleRate, samples); }
