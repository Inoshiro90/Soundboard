/**
 * export.js — MP3 + WAV Export
 *
 * MP3 via lamejs (loaded from CDN in index.html).
 * WAV encoding: own implementation (no external deps).
 * Supports: single sound export + timeline mixdown export.
 */

import { APP }  from './core/state.js';
import { toast } from './notifications.js';
import './audio/context.js';
import { renderSlotOffline, OFFLINE_RENDER_CHANNELS } from './renderPipeline.js';   // P18c: Offline-Kern
import { getOrDecodeBuffer } from './audioCache.js';
import { bufferFor } from './audio/engine/source-registry.js';   // P18b
import { actx } from './audio/context.js';
import { timelineMixdown } from './timeline.js';

// ─── KANALZAHL DER EXPORTDATEI (K1) ───────────────────────────

/**
 * K1 (nach 13f): Der Export rendert immer in Stereo wie Live/Vorschau (Ziel `ctx.destination` mit 2 Kanälen). Die Datei wird nur dann
 * mono geschrieben, wenn L und R sample-genau gleich sind (Mono-Quelle ohne Stereo-Wirkung) — hörbar identisch, Mono bleibt Mono.
 * Sonst bleibt die Kanalzahl des Renders. Vorher: Kanalzahl = Kanalzahl der Quelldatei, eine Mono-Quelle wurde mono gerendert und
 * verlor Panorama, Auto-Pan, Haas, Verbreiterung, Spatial und Doppler-Panorama (Hörliste 13a #15).
 */
export const EXPORT_RENDER_CHANNELS = OFFLINE_RENDER_CHANNELS;   // P18c: Wert (2) liegt in renderPipeline.js

export function exportChannelCount(buffer) {
  if (buffer.numberOfChannels !== 2) return buffer.numberOfChannels;
  const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
  for (let i = 0; i < l.length; i++) if (l[i] !== r[i]) return 2;
  return 1;
}

// ─── WAV ENCODING ─────────────────────────────────────────────

/** `channels` (optional, K1): Anzahl der geschriebenen Kanäle (die ersten n des Buffers); Standard = alle. */
export function audioBufferToWavBlob(buffer, channels = buffer.numberOfChannels) {
  const numCh   = Math.max(1, Math.min(buffer.numberOfChannels, channels));
  const sr      = buffer.sampleRate;
  const len     = buffer.length;
  const bps     = 16;
  const bpSmp   = bps / 8;
  const block   = numCh * bpSmp;
  const dataSize = len * block;
  const ab      = new ArrayBuffer(44 + dataSize);
  const v       = new DataView(ab);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  wr(0,'RIFF'); v.setUint32(4, 36 + dataSize, true); wr(8,'WAVE'); wr(12,'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * block, true);
  v.setUint16(32, block, true); v.setUint16(34, bps, true);
  wr(36,'data'); v.setUint32(40, dataSize, true);
  let off = 44;
  for (let f = 0; f < len; f++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[f]));
      v.setInt16(off, s < 0 ? s * 32768 : s * 32767, true); off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ─── MP3 ENCODING ─────────────────────────────────────────────

/**
 * Encode an AudioBuffer to MP3 using lamejs.
 * lamejs must be loaded via CDN script tag.
 * @param {AudioBuffer} buffer
 * @param {number} kbps   — 64 | 128 | 192 | 320
 * @param {number} [channels] — K1: Anzahl der geschriebenen Kanäle (Standard: alle, höchstens 2)
 * @returns {Blob}  MP3 blob
 */
export function audioBufferToMp3Blob(buffer, kbps = 128, channels = buffer.numberOfChannels) {
  if (typeof lamejs === 'undefined') {
    toast('lamejs nicht geladen — verwende WAV als Fallback', 'err');
    return null;
  }

  const numCh = Math.max(1, Math.min(2, buffer.numberOfChannels, channels));
  const sr    = buffer.sampleRate;
  const mp3enc = new lamejs.Mp3Encoder(numCh, sr, kbps);

  const CHUNK  = 1152; // lamejs frame size
  const data   = [];

  // Convert Float32 → Int16
  const toInt16 = (ch) => {
    const floats = buffer.getChannelData(ch);
    const ints   = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      ints[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return ints;
  };

  const left  = toInt16(0);
  const right = numCh > 1 ? toInt16(1) : left;

  for (let offset = 0; offset < left.length; offset += CHUNK) {
    const l = left.subarray(offset, offset + CHUNK);
    const r = right.subarray(offset, offset + CHUNK);
    const chunk = numCh > 1 ? mp3enc.encodeBuffer(l, r) : mp3enc.encodeBuffer(l);
    if (chunk.length > 0) data.push(chunk);
  }

  const final = mp3enc.flush();
  if (final.length > 0) data.push(final);

  return new Blob(data, { type: 'audio/mpeg' });
}

// ─── RENDER SOUND WITH EFFECTS ────────────────────────────────

/**
 * EINZIGER Render-Pfad für den Einzel-Export (WAV und MP3). Der frühere Zweitpfad `exportSoundToWav()` in
 * audio/playback.js delegiert hierher (B-12). Der Buffer kommt über den zentralen Cache (getOrDecodeBuffer) —
 * kein ungeprüfter Legacy-Decode mit fester Wartezeit mehr.
 * Länge = wirksame Spielzeit (Material ÷ Abspielrate) + Effekt-Nachklang; deckt sich mit der Live-Wiedergabe (B-10).
 * Kanäle: immer EXPORT_RENDER_CHANNELS (2) wie Live (K1); die Kanalzahl der Datei bestimmt `exportChannelCount`.
 */
export async function renderSoundOffline(s, slotIdx) {
  slotIdx = slotIdx ?? (s.curSlot || 0) % Math.max(1, (s.slots || []).length);
  const slot = (s.slots || [])[slotIdx];
  if (!slot || !slot.data) return null;

  let liveBuf = bufferFor(s, slotIdx);
  if (!liveBuf) liveBuf = await getOrDecodeBuffer(s.id, slotIdx, slot.data, actx(), slot);
  if (!liveBuf) return null;

  const numCh = EXPORT_RENDER_CHANNELS;   // K1: wie Live, nicht die Kanalzahl der Quelle
  // P18c: Graph-Aufbau, Länge, Nachklang und Rendern unverändert nach renderPipeline.js renderSlotOffline() verschoben.
  return renderSlotOffline(s, slot, liveBuf, { channels: numCh, sharedReverb: APP.globalSettings.reverbShare !== false });
}

const _safeFileName = (name, fallback = 'sound') => ((name || fallback).replace(/[^a-zA-Z0-9äöüÄÖÜß _-]/g, '').trim() || fallback);

// ─── PUBLIC EXPORT FUNCTIONS ──────────────────────────────────

export async function exportSoundWav(s) {
  toast('Rendere WAV…');
  try {
    const buf  = await renderSoundOffline(s);
    if (!buf) { toast('Kein Audio', 'err'); return; }
    _download(audioBufferToWavBlob(buf, exportChannelCount(buf)), _safeFileName(s.name) + '.wav');
    toast('WAV Export ✓', 'ok');
  } catch (e) { toast('Export fehlgeschlagen: ' + e.message, 'err'); }
}

export async function exportSoundMp3(s, kbps = 128) {
  toast('Rendere MP3…');
  try {
    const buf  = await renderSoundOffline(s);
    if (!buf) { toast('Kein Audio', 'err'); return; }
    const ch   = exportChannelCount(buf);
    const blob = audioBufferToMp3Blob(buf, kbps, ch);
    if (!blob) { _download(audioBufferToWavBlob(buf, ch), _safeFileName(s.name) + '.wav'); return; }
    _download(blob, _safeFileName(s.name) + '.mp3');
    toast('MP3 Export ✓', 'ok');
  } catch (e) { toast('Export fehlgeschlagen: ' + e.message, 'err'); }
}

export async function exportTimelineWav() {
  const buf = await timelineMixdown();
  if (!buf) return;
  _download(audioBufferToWavBlob(buf), 'timeline_mixdown.wav');
}

export async function exportTimelineMp3(kbps = 128) {
  const buf = await timelineMixdown();
  if (!buf) return;
  const blob = audioBufferToMp3Blob(buf, kbps);
  if (!blob) { _download(audioBufferToWavBlob(buf), 'timeline_mixdown.wav'); return; }
  _download(blob, 'timeline_mixdown.mp3');
}

function _download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
