/**
 * audio/context.js — AudioContext-Verwaltung + Pitch-Worklet-Ladezustand
 * Ausgelagert aus audio.js (Phase 3 der Refaktorierung).
 */

import { APP } from '../core/state.js';

// ─── AUDIO CONTEXT ───────────────────────────────────────────
// BUGFIX: ctx is NEVER created automatically on module load.
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
// BUGFIX (Pitch-Export-Konsistenz): das Pitch-Worklet-Modul muss pro
// BaseAudioContext einzeln registriert werden (AudioWorklet-Module sind
// context-gebunden). Der frühere globale `APP.pitchWorkletReady`-Flag
// bezog sich implizit NUR auf den einen Live-AudioContext — dadurch wurde
// beim WAV/MP3-Export (der einen eigenen OfflineAudioContext nutzt) nie
// geprüft/geladen, ob DAS Modul in diesem Context verfügbar ist, obwohl
// der globale Flag "true" meldete. Ergebnis: Pitch-Shift wurde beim
// Export stillschweigend ignoriert. Fix: readiness wird jetzt pro Context
// in einem WeakSet verfolgt, und jeder Aufrufer (Live ODER Offline) MUSS
// vor dem Bau eines Pitch-Nodes `ensurePitchWorkletFor(ctx)` aufrufen.

// Exportiert (Phase 3): buildPitchNode() in audio/effect-graph.js muss den
// Worklet-Ladezustand für den jeweiligen Context prüfen können. Reine
// Sichtbarkeits-Erweiterung durch den Datei-Split, keine Verhaltensänderung.
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
