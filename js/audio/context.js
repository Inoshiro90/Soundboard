/**
 * audio/context.js — AudioContext-Verwaltung + Worklet-Ladezustand (Phase 5: ensureWorklets)
 */

import { APP } from '../core/state.js';
import { WORKLETS } from './engine/worklets.js';
import { installBuses } from './engine/buses.js';

// ─── AUDIO CONTEXT ───────────────────────────────────────────
// ctx is NEVER created automatically on module load.
// It is only created on the first call to actx(), which must
// happen inside a user-gesture event handler.

let _ctx = null;

export function actx() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Phase 6: Master- und Preview-Bus des Live-Contexts (Offline-Contexts bekommen keinen).
    try { installBuses(_ctx, { limiter: APP.globalSettings?.safetyLimiter !== false, masterVol: APP.globalSettings?.masterVol ?? 1 }); }
    catch (e) { console.warn('[audio] Bus nicht installiert, Ausgang = destination:', e); }
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
// AudioWorklet-Module sind context-gebunden: jedes Modul muss pro BaseAudioContext einzeln registriert werden (Live
// UND Offline, z. B. Export mit eigenem OfflineAudioContext). Welche Module es gibt, steht in engine/worklets.js.
// Aufrufer laden vor dem Bau eines Knotens `await ensureWorklets(ctx, ids)`; ohne das bleibt der Worklet-Pfad inaktiv
// (z. B. buildPitchNode() liefert null → Aufrufer nutzt den `detune`-Fallback).

const _ready = new WeakMap();     // ctx → Set<id>
const _pending = new WeakMap();   // ctx → Map<id, Promise<boolean>>  (verhindert Doppel-Laden bei gleichzeitigen Aufrufern)
let _resolveUrl = u => u;

/**
 * Testhaken: wandelt die Registry-URL (z. B. './js/worklets/x.js') in die vom Context ladbare um. Im Browser der App
 * ist keine Umrechnung nötig; die Testumgebungen (Node, tests/index.html liegt unter tests/) setzen sie.
 */
export function setWorkletUrlResolver(fn) { _resolveUrl = typeof fn === 'function' ? fn : (u => u); }

/**
 * Exportiert, damit buildPitchNode() in audio/effect-graph.js die Pitch-Bereitschaft je Context prüfen kann.
 * Wird von ensureWorklets(…'pitch') gefüllt.
 */
export const _pitchWorkletReadyContexts = new WeakSet();

/** true, wenn das Worklet `id` in diesem Context registriert ist. */
export function isWorkletReady(ctx, id) { return !!(ctx && _ready.get(ctx)?.has(id)); }

function _markReady(ctx, id) {
  let set = _ready.get(ctx);
  if (!set) { set = new Set(); _ready.set(ctx, set); }
  set.add(id);
  if (id === 'pitch') _pitchWorkletReadyContexts.add(ctx);
}

function _ensureOne(ctx, id) {
  const def = WORKLETS[id];
  if (!def) { console.warn('[audio] Unbekanntes Worklet:', id); return Promise.resolve(false); }
  if (!ctx || !ctx.audioWorklet) return Promise.resolve(false);    // kein Secure Context / alte Engine
  if (isWorkletReady(ctx, id)) return Promise.resolve(true);
  let pend = _pending.get(ctx);
  if (!pend) { pend = new Map(); _pending.set(ctx, pend); }
  if (pend.has(id)) return pend.get(id);
  const p = (async () => {
    try {
      await ctx.audioWorklet.addModule(_resolveUrl(def.url));
      _markReady(ctx, id);
      return true;
    } catch (e) {
      console.warn(`[audio] Worklet "${id}" nicht verfügbar:`, e && e.message);
      return false;   // kein Negativ-Cache: ein späterer Aufruf darf es erneut versuchen
    } finally { pend.delete(id); }
  })();
  pend.set(id, p);
  return p;
}

/**
 * Lädt die Worklet-Module `ids` für EINEN Context (idempotent, gleichzeitige Aufrufe teilen sich das Laden).
 * @param {BaseAudioContext} ctx
 * @param {string[]} ids  Schlüssel aus engine/worklets.js
 * @returns {Promise<Record<string, boolean>>} je ID: bereit (true) oder nicht verfügbar (false) — wirft nie
 */
export async function ensureWorklets(ctx, ids) {
  const list = [...new Set(ids || [])];
  const res = {};
  await Promise.all(list.map(async id => { res[id] = await _ensureOne(ctx, id); }));
  return res;
}

/** Kompatibilität (vor Phase 5): lädt das Pitch-Worklet; true, wenn bereit. */
export async function ensurePitchWorkletFor(ctx) {
  return (await ensureWorklets(ctx, ['pitch'])).pitch === true;
}

let _workletLoading = false;

/** Lädt das Pitch-Worklet für den (Lazy-erzeugten) Live-AudioContext. */
export async function ensurePitchWorklet() {
  if (APP.pitchWorkletReady || _workletLoading) return;
  _workletLoading = true;
  try { APP.pitchWorkletReady = await ensurePitchWorkletFor(actx()); }
  finally { _workletLoading = false; }
}
