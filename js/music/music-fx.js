/**
 * music/music-fx.js — Effektkette eines Musik-Media-Elements (Phase 17g)
 *
 * Gemeinsamer Code für die Live-Wiedergabe (music-playback.js, _reconnectSlotFx/_armMusicFx) und die Vorschau im Effekt-Dialog
 * (audio/preview.js, previewMusicTrack). Invariante 2 (Live = Preview = Export): beide bauen die Kette ausschließlich hier.
 * Bewusst ohne UI-Abhängigkeiten (kein music-model/music-render), damit preview.js diese Datei laden kann.
 */

import { actx } from '../audio/context.js';
import { buildPipelineGraph, TARGET_CAPS } from '../audio/fx-pipeline.js';
import { musicTiming } from '../audio/engine/timebase.js';   // Phase 13d: Zeitbasis für Bewegungen

/**
 * Phase 17f-2: Tempo der Effektkette am Media-Element anwenden (Entscheidungen M/O/P).
 * - Rate = `runtime.tempoRate` (beim Bau eingefroren). Ändern wirkt erst beim nächsten Laden des Stücks (_loadIntoSlot → _reconnectSlotFx);
 *   runtime.update() lässt das Tempo unverändert. Nur der Notbehelf in applyMusicTrackEffectsLive (Neuverbinden) baut neu und übernimmt
 *   das neue Tempo dabei sofort — Element und Kette bleiben so immer passend.
 * - `defaultPlaybackRate` mit, weil der Ladealgorithmus des Elements (neues `src`) `playbackRate` darauf zurücksetzt.
 * - `preservesPitch` des Browsers AUS (O): „Tonhöhe halten“ leistet der Gegen-Pitch `voice` in der Kette; „folgt dem Tempo“ braucht
 *   ohnehin die Bandwirkung. Präfixe nur, wenn der Standardname fehlt. Bei Rate 1 ohne Wirkung auf den Klang.
 * - Zeitanzeige, Sprung und Trim bleiben in der Zeit des Stücks (Material), nicht in vergangener Zeit (Freigabe 17f-2).
 * P17g: aus music-playback.js hierher verschoben (dort weiter exportiert), Inhalt unverändert.
 */
export function applyMusicTempo(audio, rate) {
  if (!audio) return;
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const pp = 'preservesPitch' in audio ? 'preservesPitch' : ['webkitPreservesPitch', 'mozPreservesPitch'].find(k => k in audio);
  try { if (pp) audio[pp] = false; } catch (e) { /* ignorieren */ }
  try { audio.defaultPlaybackRate = r; audio.playbackRate = r; } catch (e) { console.warn('[music] Tempo:', e); }
}

/**
 * Baut die Musik-Kette für ein Media-Element und verbindet sie: source → [Kette] → out. Danach Rate des Elements = eingefrorenes
 * Tempo der Kette (Regel P). live:true — Ein-/Ausgangs-Gain halten die Verbindung dauerhaft, damit runtime.update() (Parameter live,
 * Strukturänderung per Überblendung) statt eines Reconnects umstellen kann. Das Pitch-Worklet muss vorher geladen sein
 * (preparePipelineContext mit TARGET_CAPS.music); fehlt es, greift der dokumentierte Notbehelf der Pipeline.
 * Wirft bei einem Baufehler, ohne etwas verbunden zu haben. Rückgabe: der Graph (runtime, arm, hold, dispose …).
 */
export function connectMusicFx(ctx, plan, source, out, audio) {
  const graph = buildPipelineGraph(ctx, plan, { numChannels: 2, caps: TARGET_CAPS.music, live: true });
  if (graph.input) { source.connect(graph.input); graph.output.connect(out); }
  else source.connect(out);
  // P17f-2: Rate des Elements = eingefrorenes Tempo der Kette (Regel P), VOR dem Scharfschalten der Zeitbasis (musicTiming liest die Rate).
  applyMusicTempo(audio, graph.runtime?.tempoRate ?? 1);
  return graph;
}

/**
 * Phase 13d: Zeitbasis der Kette aus der Wiedergabeposition des Elements melden (timebase.js musicTiming). Position 0 des Clips =
 * `clipStart` (Trim-Anfang); `newPass` = neuer Durchlauf („Wiederholen: eins“, Vorschau-Loop). Rückgabe: die neue Zeitbasis (für `prev`).
 */
export function armMusicChain(chain, audio, clipStart, prev, newPass) {
  const timing = musicTiming({ ctxNow: actx().currentTime, position: audio.currentTime, clipStart: clipStart || 0,
    duration: audio.duration, rate: audio.playbackRate || 1, prev: prev || null, newPass: !!newPass });
  try { chain.arm(timing); } catch (e) { console.warn('[music] Zeitbasis:', e); }
  return timing;
}

/** Base64-Audiodaten eines Musikstücks als Blob (wie bisher in _blobUrlFor). */
export function musicBlob(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr]);
}
