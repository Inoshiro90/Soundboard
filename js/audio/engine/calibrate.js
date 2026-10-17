/**
 * audio/engine/calibrate.js — Kapazitäts-Kalibrierung (AE-13′/AE-16, Phase 3a, Schritt 3).
 * ----------------------------------------------------------------------------------------------------------------------
 * Misst einmalig im Leerlauf, wie viele Kostenpunkte (Registry, M-1) das Gerät pro Echtzeitsekunde rechnen kann:
 *   Referenzlast = 8 Faltungen (IR 2 s) + 8 Biquads + 8 WaveShaper 4× → REF_POINTS, offline gerendert.
 *   Kapazität = REF_POINTS × (Audiosekunden / Renderzeit in Sekunden)
 * Der Offline-Faktor sagt das Echtzeitverhalten in Chrome und Firefox voraus (Messung E4) [S]; für Safari/Mobil [H].
 * Das Ergebnis wird unter `sbpro_v5:audioCalib` gespeichert (30 Tage gültig, Schlüssel = UA + Kernzahl) und ist jederzeit löschbar.
 * `capacityFromRender`, `loadCalibration`, `saveCalibration` sind rein; `runCalibration` braucht einen OfflineAudioContext.
 */
import { convolverPoints } from './registry.js';

export const CALIB_KEY = 'sbpro_v5:audioCalib';
export const CALIB_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const REF_VOICES = 8, REF_IR_S = 2, REF_AUDIO_S = 2;
export const REF_POINTS = REF_VOICES * (convolverPoints(REF_IR_S) + 1 + 10);

/** Kapazität in Punkten aus Referenzpunkten, Audiosekunden und gemessener Renderzeit (ms). */
export function capacityFromRender(refPoints, audioSeconds, renderMs) {
  if (!(renderMs > 0) || !(audioSeconds > 0)) return null;
  return refPoints * (audioSeconds * 1000 / renderMs);
}

export const deviceKey = (nav = (typeof navigator !== 'undefined' ? navigator : {})) => `${nav.userAgent || 'ua'}|${nav.hardwareConcurrency || 0}`;

/** Gültige gespeicherte Kalibrierung oder null. `storage` hat getItem/setItem (localStorage-kompatibel). */
export function loadCalibration(storage, { now = Date.now(), key = deviceKey() } = {}) {
  try {
    const o = JSON.parse(storage.getItem(CALIB_KEY) || 'null');
    if (!o || o.key !== key || !Number.isFinite(o.capacity) || o.capacity <= 0) return null;
    if (now - o.at > CALIB_MAX_AGE_MS || o.at > now + 60000) return null;
    return o;
  } catch (e) { return null; }
}

export function saveCalibration(storage, capacity, { now = Date.now(), key = deviceKey() } = {}) {
  const o = { key, capacity: Math.round(capacity), at: now, v: 1 };
  try { storage.setItem(CALIB_KEY, JSON.stringify(o)); return o; } catch (e) { return null; }
}

/**
 * Referenzlast offline rendern und die Kapazität bestimmen. Aufrufen NUR im Leerlauf (keine laufenden Voices).
 * @param {{OfflineAudioContext:Function, sampleRate?:number, clock?:()=>number}} env
 * @returns {Promise<{capacity:number, renderMs:number}|null>}
 */
export async function runCalibration({ OfflineAudioContext, sampleRate = 48000, clock = () => performance.now() }) {
  const build = () => {
    const ctx = new OfflineAudioContext(2, REF_AUDIO_S * sampleRate, sampleRate);
    const len = Math.floor(REF_IR_S * sampleRate);
    const ir = ctx.createBuffer(2, len, sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); let s = 12345 + c; for (let i = 0; i < len; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = ((s / 4294967296) * 2 - 1) * Math.exp(-3 * i / len); } }
    const src = ctx.createBuffer(2, REF_AUDIO_S * sampleRate, sampleRate);
    for (let c = 0; c < 2; c++) { const d = src.getChannelData(c); let s = 777 + c; for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = ((s / 4294967296) * 2 - 1) * 0.1; } }
    const curve = new Float32Array(513); for (let i = 0; i < 513; i++) { const x = i / 256 - 1; curve[i] = Math.tanh(3 * x); }
    for (let v = 0; v < REF_VOICES; v++) {
      const s = ctx.createBufferSource(); s.buffer = src;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8000;
      const conv = ctx.createConvolver(); conv.buffer = ir;
      const ws = ctx.createWaveShaper(); ws.curve = curve; ws.oversample = '4x';
      const g = ctx.createGain(); g.gain.value = 1 / REF_VOICES;
      s.connect(lp); lp.connect(conv); conv.connect(ws); ws.connect(g); g.connect(ctx.destination);
      s.start(0);
    }
    return ctx;
  };
  try {
    await build().startRendering();                 // Warm-up (JIT, Faltungs-Vorbereitung)
    let best = Infinity;
    for (let i = 0; i < 2; i++) { const ctx = build(); const t0 = clock(); await ctx.startRendering(); best = Math.min(best, clock() - t0); }
    const capacity = capacityFromRender(REF_POINTS, REF_AUDIO_S, best);
    return capacity ? { capacity, renderMs: best } : null;
  } catch (e) { return null; }
}
