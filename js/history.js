/**
 * history.js — Undo / Redo System (Phase 4)
 *
 * Strategy: Snapshot-based hybrid.
 *   - Sound parameters + effects → full JSON snapshot (fast, small)
 *   - Audio data in IDB is referenced by key, not snapshotted (too large)
 *     → Destructive edits store the IDB key of the PREVIOUS version as part of snapshot
 *   - Timeline state → full snapshot
 *
 * Each entry: { label, type, snapshot }
 * Snapshot shapes:
 *   type 'sound_params'  → { soundId, before, after }   (effects/vol/pitch/name etc.)
 *   type 'sound_audio'   → { soundId, slotIdx, prevKey } (previous IDB audio key)
 *   type 'timeline'      → { tracks: [...] }
 *   type 'profile_items' → { profileId, items: [...] }   (add/remove/reorder)
 *
 * Undo/Redo only restores parameters — audio data via IDB ref.
 */

import { APP } from './state.js';
import { toast } from './notifications.js';
import { idbGet, idbSet, audioKey, IDB_SENTINEL } from './db.js';
import { decodeAudio } from './audio.js';
import { bk } from './utils.js';

const MAX = () => APP.history.maxSize || 50;

// ─── PUSH ─────────────────────────────────────────────────────

/**
 * Push a new history entry.
 * Truncates redo stack on new action.
 * @param {string} label  Human-readable action name
 * @param {string} type   Entry type key
 * @param {object} data   Type-specific payload
 */
export function historyPush(label, type, data) {
  const h = APP.history;
  // Truncate anything after current pointer
  h.stack = h.stack.slice(0, h.pointer + 1);
  h.stack.push({ label, type, data, ts: Date.now() });
  if (h.stack.length > MAX()) h.stack.shift();
  h.pointer = h.stack.length - 1;
  _updateUI();
}

// ─── UNDO ─────────────────────────────────────────────────────

export async function undo() {
  const h = APP.history;
  if (h.pointer < 0) { toast('Nichts rückgängig zu machen'); return; }
  const entry = h.stack[h.pointer];
  h.pointer--;
  await _apply(entry, 'undo');
  _updateUI();
  toast(`↩ ${entry.label}`, 'ok');
}

// ─── REDO ─────────────────────────────────────────────────────

export async function redo() {
  const h = APP.history;
  if (h.pointer >= h.stack.length - 1) { toast('Nichts wiederherstellen'); return; }
  h.pointer++;
  const entry = h.stack[h.pointer];
  await _apply(entry, 'redo');
  _updateUI();
  toast(`↪ ${entry.label}`, 'ok');
}

// ─── APPLY ────────────────────────────────────────────────────

async function _apply(entry, direction) {
  const { type, data } = entry;
  const isUndo = direction === 'undo';

  if (type === 'sound_params') {
    const { soundId, before, after } = data;
    const sound = _findSound(soundId);
    if (!sound) return;
    const restore = isUndo ? before : after;
    Object.assign(sound, JSON.parse(JSON.stringify(restore)));
    _triggerRender();
  }

  else if (type === 'sound_audio') {
    const { soundId, slotIdx, prevKey, nextKey } = data;
    const restoreKey = isUndo ? prevKey : nextKey;
    if (!restoreKey) return;
    const b64 = await idbGet(restoreKey);
    if (!b64) { toast('Audio-Snapshot nicht mehr verfügbar', 'err'); return; }
    const sound = _findSound(soundId);
    if (!sound) return;
    const currentKey = audioKey(soundId, slotIdx);
    await idbSet(currentKey, b64);
    if (sound.slots[slotIdx]) sound.slots[slotIdx].data = IDB_SENTINEL;
    decodeAudio(bk(soundId, slotIdx), b64);
    _triggerRender();
  }

  else if (type === 'timeline') {
    const { before, after } = data;
    const restore = isUndo ? before : after;
    APP.timeline.tracks = JSON.parse(JSON.stringify(restore));
    _triggerTimeline();
  }

  else if (type === 'profile_items') {
    const { profileId, before, after } = data;
    const restore = isUndo ? before : after;
    const prof = APP.profiles.find(p => p.id === profileId);
    if (prof) { prof.items = JSON.parse(JSON.stringify(restore)); _triggerRender(); }
  }
}

// ─── SNAPSHOT HELPERS ─────────────────────────────────────────

/** Snapshot current sound params (call BEFORE modifying). */
export function snapshotSoundParams(sound) {
  return JSON.parse(JSON.stringify({
    name: sound.name, vol: sound.vol, pitch: sound.pitch,
    loop: sound.loop, fade: sound.fade, random: sound.random,
    hotkey: sound.hotkey, category: sound.category,
    icon: sound.icon, color: sound.color, tileColor: sound.tileColor,
    effects: sound.effects
  }));
}

/** Snapshot current timeline tracks (call BEFORE modifying). */
export function snapshotTimeline() {
  return JSON.parse(JSON.stringify(APP.timeline.tracks));
}

/** Snapshot profile items (call BEFORE modifying). */
export function snapshotProfileItems(profileId) {
  const prof = APP.profiles.find(p => p.id === profileId);
  return prof ? JSON.parse(JSON.stringify(prof.items)) : [];
}

// ─── PRIVATE ──────────────────────────────────────────────────

function _findSound(soundId) {
  for (const prof of APP.profiles) {
    const s = (prof.items || []).find(x => x.id === soundId && x.type === 'sound');
    if (s) return s;
  }
  return null;
}

function _triggerRender() {
  // Use setTimeout to break potential circular dependency chain
  setTimeout(() => {
    if (typeof window !== 'undefined' && window.__sbRenderGrid) window.__sbRenderGrid();
    else import('./ui.js').then(m => { if (m.renderGrid) m.renderGrid(); });
  }, 0);
}

function _triggerTimeline() {
  setTimeout(() => {
    import('./timeline.js').then(m => { if (m.renderTimeline) m.renderTimeline(); });
  }, 0);
}

function _updateUI() {
  const h     = APP.history;
  const canU  = h.pointer >= 0;
  const canR  = h.pointer < h.stack.length - 1;
  const btnU  = document.getElementById('btnUndo');
  const btnR  = document.getElementById('btnRedo');
  if (btnU) { btnU.disabled = !canU; btnU.title = canU ? `↩ ${h.stack[h.pointer]?.label}` : 'Rückgängig'; }
  if (btnR) { btnR.disabled = !canR; btnR.title = canR ? `↪ ${h.stack[h.pointer + 1]?.label}` : 'Wiederholen'; }

  const list = document.getElementById('historyList');
  if (!list) return;
  list.innerHTML = h.stack.map((e, i) => `
    <div class="history-entry ${i === h.pointer ? 'is-current' : i > h.pointer ? 'is-future' : ''}">
      <span class="history-entry__idx">${i + 1}</span>
      <span class="history-entry__label">${e.label}</span>
    </div>
  `).reverse().join('');
}

export function clearHistory() {
  APP.history.stack = [];
  APP.history.pointer = -1;
  _updateUI();
}
