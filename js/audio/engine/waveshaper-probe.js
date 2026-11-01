/**
 * audio/engine/waveshaper-probe.js — Latenz des Oversamplings im nativen WaveShaperNode (Phase 15a).
 *
 * Mit `oversample` 2× bzw. 4× verzögert der WaveShaper das Signal (Hoch-/Heruntertasten), je Engine verschieden [S]:
 *   Chromium 153: 2× 128, 4× 192 Samples; Node (node-web-audio-api): 2× und 4× je 128 Samples; ohne Oversampling 0. Firefox: ungemessen [H].
 * Der Dry-Pfad der erweiterten Verzerrung (Mix < 100 %) muss dieselbe Zeit verzögern, sonst entstehen Kammfilter. Wie beim Kompressor (11c,
 * compressor-probe.js) misst eine kleine Offline-Probe die Zeit einmal je Samplerate (Impuls durch einen WaveShaper mit Geradenkurve).
 *
 * Der Aufbau des Graphen ist synchron: `waveShaperLatencySamples()` liefert den gemessenen Wert, bis zur Messung die Chromium-Werte.
 * Die Vorbereitung des Plans (`preparePipelineContext`, `runtime.prepare`) ruft `ensureWaveShaperLatency()` vor dem Aufbau.
 */

const ASSUMED = { none: 0, '2x': 128, '4x': 192 };
const _samples = new Map();   // Samplerate → { none, '2x', '4x' }
const _pending = new Map();   // Samplerate → Promise

/** Gemessene (oder angenommene) Verzögerung des WaveShapers in Samples für die Oversampling-Stufe `os`. */
export function waveShaperLatencySamples(sampleRate, os) {
  if (os !== '2x' && os !== '4x') return 0;
  const m = _samples.get(sampleRate);
  return m ? m[os] : ASSUMED[os];
}

async function _measure(Offline, sampleRate, os) {
  const n = Math.ceil(sampleRate * 0.05), at = 200;
  const ctx = new Offline(1, n, sampleRate);
  const buf = ctx.createBuffer(1, n, sampleRate);
  buf.getChannelData(0)[at] = 0.5;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const ws = ctx.createWaveShaper(), c = new Float32Array(513);
  for (let i = 0; i < 513; i++) c[i] = i / 256 - 1;              // Gerade: reine Verzögerung (plus Anti-Alias-Filter)
  ws.curve = c; ws.oversample = os;
  src.connect(ws); ws.connect(ctx.destination); src.start();
  const out = (await ctx.startRendering()).getChannelData(0);
  let idx = -1, pk = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (Number.isFinite(a) && a > pk) { pk = a; idx = i; } }
  return idx >= at && pk > 0.05 ? Math.min(Math.round(sampleRate * 0.04), idx - at) : ASSUMED[os];
}

/** Misst die Verzögerungen einmal je Samplerate (idempotent, gleichzeitige Aufrufe teilen sich eine Messung). Fehler → Annahme. */
export function ensureWaveShaperLatency(sampleRate) {
  if (_samples.has(sampleRate)) return Promise.resolve(_samples.get(sampleRate));
  if (_pending.has(sampleRate)) return _pending.get(sampleRate);
  const p = (async () => {
    const result = { ...ASSUMED };
    try {
      const Offline = globalThis.OfflineAudioContext;
      if (typeof Offline === 'function') for (const os of ['2x', '4x']) result[os] = await _measure(Offline, sampleRate, os);
    } catch (e) { /* Annahme bleibt */ }
    _samples.set(sampleRate, result);
    _pending.delete(sampleRate);
    return result;
  })();
  _pending.set(sampleRate, p);
  return p;
}

/** Braucht der Plan die Messung? Jede aktive Verzerrung mit Oversampling (auch die bisherige: Ton/Mix können sie live erweitern). */
export function planNeedsWaveShaperProbe(plan) {
  return !!plan?.steps?.some(s => { const d = s.params?.distortion; return d?.enabled && d.oversample !== 'none'; });
}

/** Nur für Tests: Messwerte setzen/zurücksetzen. */
export function _setWaveShaperLatencyForTest(sampleRate, values) { if (values == null) _samples.delete(sampleRate); else _samples.set(sampleRate, { ...ASSUMED, ...values }); }
