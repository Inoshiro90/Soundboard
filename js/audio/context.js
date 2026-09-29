/**
 * audio/context.js — AudioContext-Verwaltung + Pitch-Worklet-Ladezustand
 */

import { APP } from '../core/state.js';

// ─── AUDIO CONTEXT ───────────────────────────────────────────
// ctx is NEVER created automatically on module load.
// It is only created on the first call to actx(), which must
// happen inside a user-gesture event handler.

let _ctx = null;

export function actx() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if browser auto-suspended it
  if (_ctx.state === 'suspended') {
    _ctx.resume().catch(e => console.warn('[audio] ctx.resume():', e));
  }
  return _ctx;
}

/** True only after the user has interacted and actx() has been called. */
export function hasAudioContext() { return _ctx !== null; }

// ─── WORKLET INIT ────────────────────────────────────────────
// Das Pitch-Worklet-Modul muss pro BaseAudioContext einzeln registriert
// werden (AudioWorklet-Module sind context-gebunden). Die Bereitschaft wird
// deshalb pro Context in einem WeakSet verfolgt, und jeder Aufrufer (Live ODER
// Offline, z.B. WAV/MP3-Export mit eigenem OfflineAudioContext) MUSS vor dem
// Bau eines Pitch-Nodes `ensurePitchWorkletFor(ctx)` aufrufen — sonst würde der
// Pitch-Shift stillschweigend ignoriert.

// Exportiert, damit buildPitchNode() in audio/effect-graph.js den
// Worklet-Ladezustand für den jeweiligen Context prüfen kann.
export const _pitchWorkletReadyContexts = new WeakSet();

/**
 * Lädt das Pitch-Worklet-Modul für EINEN gegebenen Context (Live- oder
 * OfflineAudioContext) und merkt sich das Ergebnis pro Context.
 * Muss vor jedem `buildPitchNode(ctx, …)`-Aufruf für diesen Context
 * ausgeführt worden sein, sonst bleibt der Worklet-Pfad inaktiv und
 * `buildPitchNode()` liefert `null` (Aufrufer nutzt dann den
 * `detune`-Fallback).
 * @returns {Promise<boolean>} true, wenn das Modul in diesem Context bereit ist
 */
export async function ensurePitchWorkletFor(ctx) {
  if (!ctx || !ctx.audioWorklet) return false;
  if (_pitchWorkletReadyContexts.has(ctx)) return true;
  try {
    await ctx.audioWorklet.addModule('./js/worklets/pitch-processor.js');
    _pitchWorkletReadyContexts.add(ctx);
    return true;
  } catch (e) {
    console.warn('[audio] PitchWorklet unavailable for context:', e.message);
    return false;
  }
}

let _workletLoading = false;

/** Lädt das Pitch-Worklet für den (Lazy-erzeugten) Live-AudioContext. */
export async function ensurePitchWorklet() {
  if (APP.pitchWorkletReady || _workletLoading) return;
  _workletLoading = true;
  APP.pitchWorkletReady = await ensurePitchWorkletFor(actx());
  _workletLoading = false;
}
