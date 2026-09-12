/**
 * ambient.js — Ambient Sound Layer & View-Mode Switch
 *
 * A second, independent playback layer that runs alongside the sound-effect
 * grid. Ambient tracks are longer background loops (crowd noise, rain,
 * footsteps, animals, …) that can be mixed together, each with its own
 * volume/loop/fade settings. They are organised into scene-profiles
 * (Marktplatz, Höhle, Schlachtfeld, …) using the exact same tab pattern as
 * the sound-effect profiles. Playback keeps going independently of whatever
 * the sound-effect grid is doing — the main "Stop"-button does not touch it,
 * and switching back to the Sound view doesn't stop it either.
 *
 * Also owns the Sound/Ambient view-mode toggle (two-icon segmented button
 * in the navbar) that swaps which section — the sound grid or the ambient
 * scene — is visible.
 *
 * Storage reuses the exact same primitives as sound slots:
 *  - Audio blobs live in IndexedDB under the key `${trackId}:0`
 *    (via db.js's audioKey/idbSet/idbGet — same scheme sound slots use).
 *  - Decoded AudioBuffers are cached via audioCache.js's getOrDecodeBuffer,
 *    using (trackId, 0) as the (soundId, slotIdx) pair.
 *  - Track/scene metadata is persisted as part of APP.ambient inside the
 *    regular localStorage save (storage.js).
 */

import { APP, CAP, CATracks }                    from './state.js';
import { uid, iconHtmlOr, iconGlyph }             from './utils.js';
import { toast }                                 from './notifications.js';
import { actx, hasAudioContext, buildEffectChain } from './audio.js';
import { getOrDecodeBuffer, invalidateBuffer }   from './audioCache.js';
import { idbSet, idbDelete, audioKey, IDB_SENTINEL } from './db.js';
import { _saveRaw }                              from './storage.js';
import { PENCIL_ICON_SVG }                       from './ui.js';

// ─── CONSTANTS ───────────────────────────────────────────────

const AMBIENT_ICONS = ['🎐','🌧️','🌊','🔥','🌬️','🐦','🐴','🐕','👥','🏙️','🌲','🕯️','⛈️','🦗','🌙','🐝','🚶','🔔'];

// Runtime-only playback state — never persisted.
// trackId → { kind: 'loop' | 'interval', src, gain, timerId }
// For 'interval' tracks, src/gain are null while waiting between plays —
// the track still counts as "playing" (scheduled) the whole time.
const _active = new Map();

// ─── STATE HELPERS ───────────────────────────────────────────

export function ensureAmbientState() {
  if (!APP.ambient || typeof APP.ambient !== 'object') {
    APP.ambient = { profiles: [], activeProfileId: null, masterVol: 1 };
  }
  if (!Array.isArray(APP.ambient.profiles)) APP.ambient.profiles = [];
  if (!APP.ambient.profiles.length) {
    const p = { id: uid(), name: 'Ambient', icon: '🌫️', tracks: [] };
    APP.ambient.profiles.push(p);
    APP.ambient.activeProfileId = p.id;
  }
  APP.ambient.profiles.forEach(p => { if (!Array.isArray(p.tracks)) p.tracks = []; });
  if (!APP.ambient.activeProfileId || !APP.ambient.profiles.find(p => p.id === APP.ambient.activeProfileId)) {
    APP.ambient.activeProfileId = APP.ambient.profiles[0].id;
  }
  if (typeof APP.ambient.masterVol !== 'number') APP.ambient.masterVol = 1;
  if (!['sound', 'ambient', 'music'].includes(APP.viewMode)) APP.viewMode = 'sound';
}

function _persist() {
  try { _saveRaw(); } catch (e) { console.warn('[ambient] persist failed:', e); }
}

function _find(trackId) {
  return CATracks().find(t => t.id === trackId);
}

/** Finds a track across ALL scenes (not just the active one) — used by the effects editor modal. */
export function findAmbientTrack(trackId) {
  ensureAmbientState();
  for (const p of APP.ambient.profiles) {
    const t = (p.tracks || []).find(x => x.id === trackId);
    if (t) return t;
  }
  return null;
}

/** Sets the real-time audio-effects chain (filter/EQ/dynamics/distortion/reverb/delay/3D/pitch) for a track. */
export function setAmbientTrackEffects(trackId, effects) {
  const t = findAmbientTrack(trackId); if (!t) return;
  t.effects = effects;
  _persist();
}

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = e => resolve(e.target.result.split(',')[1]);
    r.onerror = () => reject(new Error('FileReader error'));
    r.readAsDataURL(file);
  });
}

function _mkTrack(name) {
  const icon = AMBIENT_ICONS[CATracks().length % AMBIENT_ICONS.length];
  return {
    id: uid(), name: name || 'Ambient', icon, color: 'none',
    // Several audio-file variants per track (e.g. 3 different dog-bark clips).
    // On each play/interval-firing, one is picked per variantMode.
    files: [], variantMode: 'random', // 'random' | 'rotate'
    vol: 0.7, loop: true, fadeIn: 2, fadeOut: 2,
    // Time-delayed playback: instead of looping continuously, play once then
    // wait a random (or fixed, if min === max) delay before playing again.
    intervalMode: false, intervalMin: 10, intervalMax: 30
  };
}

function _mkFile(fileName) {
  return { id: uid(), data: null, fileName: fileName || '', trimStart: 0, trimEnd: null };
}

/** Forces an immediate save — used by the shared modal after it bulk-edits a track's fields directly. */
export function persistAmbientNow() { _persist(); }

/** Picks which file variant to play next, per the track's variantMode. Skips unloaded files. */
function _pickTrackFile(t) {
  const files = (t.files || []).filter(f => f && f.data);
  if (!files.length) return null;
  if (files.length === 1) { t._lastFileId = files[0].id; return files[0]; }

  if (t.variantMode === 'rotate') {
    let idx = t._rotateIndex ?? 0;
    if (idx < 0 || idx >= files.length) idx = 0;
    const pick = files[idx];
    t._rotateIndex = (idx + 1) % files.length;
    t._lastFileId = pick.id;
    return pick;
  }

  // Random — avoid repeating the immediately previous file when possible.
  let pool = files;
  if (t._lastFileId) {
    const rest = files.filter(f => f.id !== t._lastFileId);
    if (rest.length) pool = rest;
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  t._lastFileId = pick.id;
  return pick;
}

// ─── SCENE (PROFILE) CRUD ──────────────────────────────────────

/** Creates a new scene or renames/re-icons an existing one (id === null → create). */
export function saveAmbientProfile(id, name, icon) {
  ensureAmbientState();
  const cleanName = (name || '').trim() || 'Szene';
  const cleanIcon = (icon || '').trim() || '🌫️';
  if (id) {
    const p = APP.ambient.profiles.find(x => x.id === id);
    if (p) { p.name = cleanName; p.icon = cleanIcon; }
  } else {
    const np = { id: uid(), name: cleanName, icon: cleanIcon, tracks: [] };
    APP.ambient.profiles.push(np);
    APP.ambient.activeProfileId = np.id;
  }
  _persist();
  renderAmbientProfileTabs();
  renderAmbientPanel();
}

/** Deletes a scene (and its tracks' audio). Refuses to delete the last remaining scene. */
export function deleteAmbientProfile(id) {
  ensureAmbientState();
  if (APP.ambient.profiles.length <= 1) { toast('Letzte Szene kann nicht gelöscht werden', 'err'); return false; }
  const p = APP.ambient.profiles.find(x => x.id === id);
  if (p) {
    (p.tracks || []).forEach(t => {
      stopAmbientTrack(t.id, { fade: false });
      (t.files || []).forEach(f => {
        invalidateBuffer(f.id, 0);
        idbDelete(audioKey(f.id, 0)).catch(() => {});
      });
    });
  }
  APP.ambient.profiles = APP.ambient.profiles.filter(x => x.id !== id);
  if (APP.ambient.activeProfileId === id) APP.ambient.activeProfileId = APP.ambient.profiles[0]?.id || null;
  _persist();
  renderAmbientProfileTabs();
  renderAmbientPanel();
  return true;
}

/** Switches the active ambient scene. Stops whatever was playing in the previous scene. */
export function switchAmbientProfile(id) {
  ensureAmbientState();
  if (id === APP.ambient.activeProfileId) return;
  stopAllAmbient();
  APP.ambient.activeProfileId = id;
  _persist();
  renderAmbientProfileTabs();
  renderAmbientPanel();
}

export function resetAmbient() {
  stopAllAmbient();
  const p = { id: uid(), name: 'Ambient', icon: '🌫️', tracks: [] };
  APP.ambient = { profiles: [p], activeProfileId: p.id, masterVol: 1 };
  APP.viewMode = 'sound';
  renderAmbientProfileTabs();
  renderAmbientPanel();
  setViewMode('sound');
}

// ─── TRACK CRUD ──────────────────────────────────────────────

/** Adds one ambient track per selected file to the active scene, decoding + storing each asynchronously. */
export async function addAmbientFiles(fileList) {
  ensureAmbientState();
  const files = [...fileList].filter(f => f && f.type.startsWith('audio'));
  if (!files.length) { toast('Keine gültige Audiodatei', 'err'); return; }
  const tracks = CATracks();

  for (const f of files) {
    const track  = _mkTrack(f.name.replace(/\.[^.]+$/, ''));
    const variant = _mkFile(f.name);
    track.files.push(variant);
    tracks.push(track);
    renderAmbientPanel();
    try {
      const b64 = await _fileToBase64(f);
      await idbSet(audioKey(variant.id, 0), b64);
      variant.data = IDB_SENTINEL;
    } catch (e) {
      console.error('[ambient] file load error:', e);
      toast(`"${f.name}" konnte nicht geladen werden`, 'err');
    }
    renderAmbientPanel();
  }
  _persist();
  toast(`${files.length} Ambient-Sound${files.length > 1 ? 's' : ''} hinzugefügt`, 'ok');
}

/** Adds one more file variant to an existing track (e.g. a 2nd/3rd dog-bark clip). */
export async function addFileVariant(trackId, file) {
  const t = _find(trackId);
  if (!t || !file) return;
  const variant = _mkFile(file.name);
  t.files.push(variant);
  renderAmbientPanel();
  try {
    const b64 = await _fileToBase64(file);
    await idbSet(audioKey(variant.id, 0), b64);
    variant.data = IDB_SENTINEL;
  } catch (e) {
    console.error('[ambient] add variant error:', e);
    toast(`"${file.name}" konnte nicht geladen werden`, 'err');
  }
  _persist();
  renderAmbientPanel();
}

export async function addFileVariants(trackId, fileList) {
  const files = [...fileList].filter(f => f && f.type.startsWith('audio'));
  if (!files.length) { toast('Keine gültige Audiodatei', 'err'); return; }
  for (const f of files) await addFileVariant(trackId, f);
  toast(`${files.length} Variante${files.length > 1 ? 'n' : ''} hinzugefügt`, 'ok');
}

/** Replaces the audio of one specific file variant in place (same id, new blob). */
export async function replaceFileVariant(trackId, fileId, file) {
  const t = _find(trackId);
  const variant = t?.files.find(f => f.id === fileId);
  if (!variant || !file) return;
  invalidateBuffer(fileId, 0);
  try {
    const b64 = await _fileToBase64(file);
    await idbSet(audioKey(fileId, 0), b64);
    variant.data     = IDB_SENTINEL;
    variant.fileName = file.name;
    toast('Datei ersetzt ✓', 'ok');
  } catch (e) {
    console.error('[ambient] replace variant error:', e);
    toast('Fehler beim Ersetzen', 'err');
  }
  _persist();
  renderAmbientPanel();
}

/** Removes one file variant from a track. */
export function removeFileVariant(trackId, fileId) {
  const t = _find(trackId); if (!t) return;
  t.files = (t.files || []).filter(f => f.id !== fileId);
  invalidateBuffer(fileId, 0);
  idbDelete(audioKey(fileId, 0)).catch(() => {});
  _persist();
  renderAmbientPanel();
}

/** Sets whether variants are picked randomly or rotated in order. */
export function setAmbientVariantMode(trackId, mode) {
  const t = _find(trackId); if (!t) return;
  t.variantMode = mode === 'rotate' ? 'rotate' : 'random';
  t._rotateIndex = 0;
  _persist();
  renderAmbientPanel();
}

export function removeAmbientTrack(trackId) {
  stopAmbientTrack(trackId, { fade: false });
  const p = CAP();
  const t = p?.tracks.find(x => x.id === trackId);
  (t?.files || []).forEach(f => {
    invalidateBuffer(f.id, 0);
    idbDelete(audioKey(f.id, 0)).catch(() => {});
  });
  if (p) p.tracks = p.tracks.filter(x => x.id !== trackId);
  _persist();
  renderAmbientPanel();
}

export function renameAmbientTrack(trackId, name) {
  const t = _find(trackId); if (!t) return;
  t.name = (name || '').trim() || 'Ambient';
  _persist();
}

export function setAmbientTrackIcon(trackId, icon) {
  const t = _find(trackId); if (!t) return;
  t.icon = (icon || '').trim() || t.icon;
  _persist();
  renderAmbientPanel();
}

// ─── VOLUME / LOOP / FADE / INTERVAL ─────────────────────────

export function setAmbientTrackVolume(trackId, val) {
  const t = _find(trackId); if (!t) return;
  t.vol = Math.max(0, Math.min(1, val));
  const rec = _active.get(trackId);
  if (rec?.gain && hasAudioContext()) {
    const ctx    = actx();
    const target = t.vol * (APP.ambient.masterVol ?? 1);
    rec.gain.gain.cancelScheduledValues(ctx.currentTime);
    rec.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
  }
}

export function setAmbientMasterVolume(val) {
  ensureAmbientState();
  APP.ambient.masterVol = Math.max(0, Math.min(1, val));
  if (hasAudioContext()) {
    const ctx = actx();
    _active.forEach((rec, id) => {
      if (!rec.gain) return; // interval track currently waiting — nothing to ramp
      const t = _find(id); if (!t) return;
      const target = t.vol * APP.ambient.masterVol;
      rec.gain.gain.cancelScheduledValues(ctx.currentTime);
      rec.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
    });
  }
  _persist();
}

export function toggleAmbientLoop(trackId) {
  const t = _find(trackId); if (!t) return;
  t.loop = !t.loop;
  const rec = _active.get(trackId);
  if (rec?.kind === 'loop' && rec.src) rec.src.loop = t.loop;
  _persist();
  renderAmbientPanel();
}

export function setAmbientFade(trackId, key, val) {
  const t = _find(trackId); if (!t) return;
  const n = Math.max(0, Math.min(30, parseFloat(val)));
  t[key] = isNaN(n) ? 0 : n;
  _persist();
}

/** Toggles time-delayed (random/fixed interval) playback for a track. Restarts playback if currently running. */
export function toggleAmbientInterval(trackId) {
  const t = _find(trackId); if (!t) return;
  t.intervalMode = !t.intervalMode;
  _persist();
  if (isAmbientPlaying(trackId)) {
    stopAmbientTrack(trackId, { fade: false });
    playAmbientTrack(trackId);
  }
  renderAmbientPanel();
}

/** Sets the min/max delay (seconds) between plays in interval mode. If min === max, that exact delay is used every time. */
export function setAmbientInterval(trackId, key, val) {
  const t = _find(trackId); if (!t) return;
  const n = Math.max(0, Math.min(3600, parseFloat(val)));
  t[key] = isNaN(n) ? (key === 'intervalMin' ? 10 : 30) : n;
  _persist();
}

function _pickIntervalDelay(t) {
  const a = Math.max(0, t.intervalMin ?? 10);
  const b = Math.max(0, t.intervalMax ?? 10);
  const min = Math.min(a, b), max = Math.max(a, b);
  if (min === max) return min;
  return min + Math.random() * (max - min);
}

// ─── PLAYBACK ────────────────────────────────────────────────
// Note: playback is looked up by trackId only (globally unique), so a track
// keeps playing correctly even if the user switches scenes/modes while it runs.
// Two modes:
//  - 'loop':     a single continuously looping (or one-shot) AudioBufferSource.
//  - 'interval': plays the clip once, then waits a random/fixed delay
//                (intervalMin…intervalMax seconds) before playing again —
//                the track counts as "running" for the whole wait, too.

export function isAmbientPlaying(trackId) { return _active.has(trackId); }

/** True while a scheduled interval-track is silently waiting for its next play. */
export function isAmbientWaiting(trackId) {
  const rec = _active.get(trackId);
  return !!(rec && rec.kind === 'interval' && !rec.src);
}

export async function toggleAmbientPlay(trackId) {
  if (_active.has(trackId)) stopAmbientTrack(trackId, { fade: true });
  else await playAmbientTrack(trackId);
}

export async function playAmbientTrack(trackId) {
  const t = _find(trackId); if (!t) return;
  if (!(t.files || []).some(f => f.data)) { toast('Keine Audiodatei geladen', 'err'); return; }
  if (_active.has(trackId)) return;

  if (t.intervalMode) {
    _active.set(trackId, { kind: 'interval', src: null, gain: null, timerId: null });
    _updateRowPlayState(trackId, true);
    await _playIntervalCycle(trackId);
  } else {
    await _startLoopPlayback(trackId);
  }
}

/** Routes src → [pitch] → [FX chain] → gainNode, applying the track's effects (if enabled). */
function _connectWithFx(ctx, src, effects, gainNode) {
  if (effects?.pitchShift?.enabled && effects.pitchShift.semitones) {
    try { src.detune.value = (effects.pitchShift.semitones ?? 0) * 100; } catch (e) {}
  }
  const chain = effects?.enabled ? buildEffectChain(ctx, effects) : null;
  if (chain) {
    src.connect(chain.input);
    chain.output.connect(gainNode);
  } else {
    src.connect(gainNode);
  }
}

async function _startLoopPlayback(trackId) {
  const t = _find(trackId); if (!t) return;
  const fileCount = (t.files || []).filter(f => f && f.data).length;

  // Looping with several file variants: chain discrete plays back-to-back,
  // picking a new variant (random/rotate) each time instead of looping
  // the same single buffer forever.
  if (t.loop && fileCount > 1) {
    _active.set(trackId, { kind: 'chain', src: null, gain: null, timerId: null, started: false });
    await _playChainCycle(trackId);
    return;
  }

  const file = _pickTrackFile(t);
  if (!file) { toast('Keine Audiodatei geladen', 'err'); return; }
  const ctx = actx();
  const buf = await getOrDecodeBuffer(file.id, 0, file.data, ctx);
  if (!buf) { toast('Audio konnte nicht geladen werden', 'err'); return; }
  if (_active.has(trackId)) return; // started elsewhere while decoding

  const gainNode = ctx.createGain();
  const target   = (t.vol ?? 0.7) * (APP.ambient.masterVol ?? 1);
  const fadeIn   = Math.max(0, t.fadeIn || 0);
  const now      = ctx.currentTime;
  gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : target, now);
  if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(target, now + fadeIn);
  gainNode.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop   = !!t.loop;
  _connectWithFx(ctx, src, t.effects, gainNode);

  const rec = { kind: 'loop', src, gain: gainNode, timerId: null };
  _active.set(trackId, rec);

  src.onended = () => {
    if (_active.get(trackId) === rec) {
      _active.delete(trackId);
      _updateRowPlayState(trackId, false);
    }
  };

  const ts = file.trimStart || 0;
  let   te = file.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  src.start(0, ts, src.loop ? undefined : (te - ts));
  _updateRowPlayState(trackId, true);
}

/**
 * Loop-mode playback for tracks with multiple file variants: plays one
 * variant fully, then immediately (no gap, unlike interval mode) continues
 * with the next one picked per variantMode — repeating until stopped.
 */
async function _playChainCycle(trackId) {
  let rec = _active.get(trackId);
  if (!rec || rec.kind !== 'chain') return; // stopped in the meantime

  const t = _find(trackId);
  if (!t || !t.loop) { _active.delete(trackId); _updateRowPlayState(trackId, false); return; }
  const file = _pickTrackFile(t);
  if (!file) { _active.delete(trackId); _updateRowPlayState(trackId, false); return; }

  const ctx = actx();
  const buf = await getOrDecodeBuffer(file.id, 0, file.data, ctx);

  rec = _active.get(trackId);
  if (!rec || rec.kind !== 'chain') return; // stopped while decoding
  if (!buf) { toast('Audio konnte nicht geladen werden', 'err'); _active.delete(trackId); _updateRowPlayState(trackId, false); return; }

  const gainNode = ctx.createGain();
  const target    = (t.vol ?? 0.7) * (APP.ambient.masterVol ?? 1);
  // Only fade in on the very first clip of the chain — subsequent variants
  // continue seamlessly at full volume, like a continuous ambience loop.
  const fadeIn    = rec.started ? 0 : Math.max(0, t.fadeIn || 0);
  const now       = ctx.currentTime;
  gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : target, now);
  if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(target, now + fadeIn);
  gainNode.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop   = false; // each variant plays once, then we chain to the next
  _connectWithFx(ctx, src, t.effects, gainNode);

  rec.src     = src;
  rec.gain    = gainNode;
  rec.started = true;

  src.onended = () => {
    const cur = _active.get(trackId);
    if (!cur || cur.src !== src) return; // stopped/replaced already
    cur.src  = null;
    cur.gain = null;
    _playChainCycle(trackId); // immediately continue with the next variant
  };

  const ts = file.trimStart || 0;
  let   te = file.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  src.start(0, ts, te - ts);
  _updateRowPlayState(trackId, true);
}

/** Plays one shot of an interval-mode track (picking a file variant), then schedules the next one after a random/fixed delay. */
async function _playIntervalCycle(trackId) {
  let rec = _active.get(trackId);
  if (!rec || rec.kind !== 'interval') return; // stopped in the meantime

  const t = _find(trackId);
  if (!t || !(t.files || []).some(f => f.data)) { _active.delete(trackId); _updateRowPlayState(trackId, false); return; }
  const file = _pickTrackFile(t);
  if (!file) { _active.delete(trackId); _updateRowPlayState(trackId, false); return; }

  const ctx = actx();
  const buf = await getOrDecodeBuffer(file.id, 0, file.data, ctx);

  // Re-check after the async decode — the track may have been stopped while we waited.
  rec = _active.get(trackId);
  if (!rec || rec.kind !== 'interval') return;
  if (!buf) { toast('Audio konnte nicht geladen werden', 'err'); _active.delete(trackId); _updateRowPlayState(trackId, false); return; }

  const gainNode = ctx.createGain();
  const target   = (t.vol ?? 0.7) * (APP.ambient.masterVol ?? 1);
  const fadeIn   = Math.max(0, t.fadeIn || 0);
  const now      = ctx.currentTime;
  gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : target, now);
  if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(target, now + fadeIn);
  gainNode.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop   = false; // interval mode always plays discrete one-shots
  _connectWithFx(ctx, src, t.effects, gainNode);

  rec.src  = src;
  rec.gain = gainNode;

  src.onended = () => {
    const cur = _active.get(trackId);
    if (!cur || cur.src !== src) return; // stopped/replaced already
    cur.src  = null;
    cur.gain = null;
    const delaySec = _pickIntervalDelay(_find(trackId) || t);
    cur.timerId = setTimeout(() => _playIntervalCycle(trackId), delaySec * 1000);
    _updateRowPlayState(trackId, true);
  };

  const ts = file.trimStart || 0;
  let   te = file.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  src.start(0, ts, te - ts);
  _updateRowPlayState(trackId, true);
}

export function stopAmbientTrack(trackId, { fade = true } = {}) {
  const rec = _active.get(trackId);
  if (!rec) return;
  if (rec.timerId) { clearTimeout(rec.timerId); rec.timerId = null; }
  if (rec.src) {
    const t = _find(trackId);
    try {
      if (hasAudioContext()) {
        const ctx     = actx();
        const fadeOut = fade ? Math.max(0, t?.fadeOut ?? 0) : 0;
        if (fadeOut > 0) {
          const now = ctx.currentTime;
          rec.gain.gain.cancelScheduledValues(now);
          rec.gain.gain.setValueAtTime(rec.gain.gain.value, now);
          rec.gain.gain.linearRampToValueAtTime(0, now + fadeOut);
          setTimeout(() => { try { rec.src.stop(); } catch (e) {} }, fadeOut * 1000 + 60);
        } else {
          rec.src.stop();
        }
      } else {
        rec.src.stop();
      }
    } catch (e) { /* already stopped */ }
    rec.src.onended = null; // prevent the natural-end handler from re-scheduling
  }
  _active.delete(trackId);
  _updateRowPlayState(trackId, false);
}

export function stopAllAmbient() {
  [..._active.keys()].forEach(id => stopAmbientTrack(id, { fade: true }));
}

// ─── UI: SCENE TABS ──────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Renders the ambient scene tabs into #ambProfBar — mirrors renderProfileTabs() for sounds. */
export function renderAmbientProfileTabs() {
  ensureAmbientState();
  const bar    = document.getElementById('ambProfBar');
  const addBtn = document.getElementById('btnAddAmbientProfile');
  if (!bar) return;
  bar.querySelectorAll('.profile-tab').forEach(t => t.remove());

  APP.ambient.profiles.forEach(p => {
    const tab = document.createElement('button');
    tab.className = 'profile-tab' + (p.id === APP.ambient.activeProfileId ? ' is-active' : '');
    tab.dataset.pid = p.id;
    const playingCount = (p.tracks || []).filter(t => isAmbientPlaying(t.id)).length;
    tab.innerHTML =
      `<span class="profile-tab__name">${iconHtmlOr(p.icon, '🌫️', 'profile-tab__icon-img')} ${_esc(p.name)}${playingCount ? ` <span class="profile-tab__live" title="${playingCount} Sound(s) laufen" aria-hidden="true"></span>` : ''}</span>` +
      `<span class="profile-tab__edit" title="Szene bearbeiten" aria-label="Szene bearbeiten">` +
      `${PENCIL_ICON_SVG}</span>`;
    if (addBtn) bar.insertBefore(tab, addBtn); else bar.appendChild(tab);
  });
}

// ─── UI: TRACK LIST RENDERING ────────────────────────────────

function _rowTemplate(t) {
  const playing = isAmbientPlaying(t.id);
  const waiting = playing && isAmbientWaiting(t.id);
  const files   = t.files || [];
  const loaded  = files.some(f => f.data);
  return `
  <div class="ambient-row${playing ? ' is-playing' : ''}${waiting ? ' is-waiting' : ''}" data-id="${t.id}">
    <button class="ambient-row__play" data-act="play" ${loaded ? '' : 'disabled'}
      title="${playing ? 'Stoppen' : 'Abspielen'}" aria-label="${playing ? 'Stoppen' : 'Abspielen'}">
      <i class="fa-solid ${playing ? 'fa-stop' : 'fa-play'}" aria-hidden="true"></i>
    </button>
    <button class="ambient-row__icon" data-act="icon" title="Icon auswählen" aria-label="Icon auswählen">${iconHtmlOr(t.icon, '🌫️', 'ambient-row__icon-img')}</button>
    <input type="text" class="ambient-row__name" data-act="name" value="${_esc(t.name)}" maxlength="30"
      aria-label="Name des Ambient-Sounds" placeholder="Ambient-Name">
    <span class="ambient-row__state">${waiting ? 'wartet…' : (playing ? 'spielt…' : '')}</span>
    <div class="ambient-row__vol">
      <i class="fa-solid fa-volume-low" aria-hidden="true"></i>
      <input type="range" class="slider ambient-row__vol-slider" data-act="vol" min="0" max="1" step=".01"
        value="${t.vol}" aria-label="Lautstärke ${_esc(t.name)}">
      <span class="ambient-row__vol-pct">${Math.round(t.vol * 100)}%</span>
    </div>
    <button class="ambient-row__opt" data-act="fx" title="Bearbeiten — Grundeinstellungen &amp; Audio-Effekte" aria-label="Ambient-Sound bearbeiten">
      <i class="fa-solid fa-pen" aria-hidden="true"></i>
    </button>
    <button class="ambient-row__opt ambient-row__opt--danger" data-act="remove" title="Entfernen"
      aria-label="Ambient-Sound entfernen">
      <i class="fa-solid fa-trash" aria-hidden="true"></i>
    </button>
  </div>`;
}

/** Renders the track list of the currently active ambient scene into #ambientList. */
export function renderAmbientPanel() {
  ensureAmbientState();
  const list  = document.getElementById('ambientList');
  const empty = document.getElementById('ambientEmpty');
  const count = document.getElementById('ambientCount');
  if (!list) return;

  const tracks = CATracks();
  if (count) count.textContent = String(tracks.length);
  if (empty) empty.style.display = tracks.length ? 'none' : '';
  list.innerHTML = tracks.map(_rowTemplate).join('');

  const mv = document.getElementById('ambientMasterVol');
  if (mv) mv.value = APP.ambient.masterVol ?? 1;
  const mvNum = document.getElementById('ambientMasterVolNum');
  if (mvNum) mvNum.value = Math.round((APP.ambient.masterVol ?? 1) * 100);

  const lbl = document.getElementById('ambientSceneLbl');
  if (lbl) { const p = CAP(); lbl.textContent = p ? `${iconGlyph(p.icon)} ${p.name}` : ''; }
}

function _updateRowPlayState(trackId, playing) {
  const waiting = playing && isAmbientWaiting(trackId);
  const row = document.querySelector(`.ambient-row[data-id="${trackId}"]`);
  if (row) {
    row.classList.toggle('is-playing', playing);
    row.classList.toggle('is-waiting', waiting);
    const btn = row.querySelector('[data-act="play"]');
    if (btn) {
      btn.title = playing ? 'Stoppen' : 'Abspielen';
      btn.setAttribute('aria-label', btn.title);
      const icon = btn.querySelector('i');
      if (icon) icon.className = `fa-solid ${playing ? 'fa-stop' : 'fa-play'}`;
    }
    const badge = row.querySelector('.ambient-row__state');
    if (badge) badge.textContent = waiting ? 'wartet…' : (playing ? 'spielt…' : '');
  }
  // Live-dot on the scene tab, since a track keeps playing across scene/mode switches.
  renderAmbientProfileTabs();
}

// ─── VIEW MODE: SOUND ⇄ AMBIENT ──────────────────────────────

/** Swaps the visible section (sound grid vs. ambient scene) — playback of either keeps running. */
export function setViewMode(mode) {
  ensureAmbientState();
  APP.viewMode = ['sound', 'ambient', 'music'].includes(mode) ? mode : 'sound';
  const soundOn   = APP.viewMode === 'sound';
  const ambientOn = APP.viewMode === 'ambient';
  const musicOn   = APP.viewMode === 'music';

  document.getElementById('profBar')?.toggleAttribute('hidden', !soundOn);
  document.getElementById('soundMenubar')?.toggleAttribute('hidden', !soundOn);
  document.getElementById('soundBoard')?.toggleAttribute('hidden', !soundOn);
  document.getElementById('ambProfBar')?.toggleAttribute('hidden', !ambientOn);
  document.getElementById('ambientBoard')?.toggleAttribute('hidden', !ambientOn);
  // Stop sitzt jetzt zusammen mit der Sound-Lautstärke in #fxToolbar
  // innerhalb von #soundBoard (stoppt nur Sound-Kacheln, s. audio.js) —
  // wird durch das hidden-Attribut auf #soundBoard bereits mitversteckt;
  // dieser Toggle bleibt zusätzlich als explizite Absicherung bestehen.
  document.getElementById('btnStop')?.toggleAttribute('hidden', !soundOn);

  // Musikansicht: nur DOM-Sichtbarkeit umschalten, Playback läuft im
  // Hintergrund unabhängig weiter (Kap. 38) — siehe music.js. Dynamischer
  // Import vermeidet einen zirkulären Import ambient.js ⇄ music.js.
  import('./music.js').then(m => m.applyMusicViewVisibility(musicOn));

  const bSound = document.getElementById('btnModeSound');
  const bAmb   = document.getElementById('btnModeAmbient');
  const bMusic = document.getElementById('btnModeMusic');
  bSound?.classList.toggle('is-active', soundOn);
  bSound?.setAttribute('aria-pressed', String(soundOn));
  bAmb?.classList.toggle('is-active', ambientOn);
  bAmb?.setAttribute('aria-pressed', String(ambientOn));
  bMusic?.classList.toggle('is-active', musicOn);
  bMusic?.setAttribute('aria-pressed', String(musicOn));

  _persist();
}

// ─── UI: EVENTS ──────────────────────────────────────────────

export function registerAmbientEvents() {
  ensureAmbientState();

  // View-mode toggle (navbar)
  document.getElementById('btnModeSound')?.addEventListener('click', () => setViewMode('sound'));
  document.getElementById('btnModeAmbient')?.addEventListener('click', () => setViewMode('ambient'));
  document.getElementById('btnModeMusic')?.addEventListener('click', () => setViewMode('music'));

  // Ambient scene tabs — mirrors #profBar delegation in events.js.
  // Editing a scene opens a modal owned by events.js, so we signal via a
  // small custom event rather than importing events.js here (would be circular).
  document.getElementById('ambProfBar')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.profile-tab__edit');
    const tab     = e.target.closest('.profile-tab');
    if (editBtn) {
      const pid = tab?.dataset.pid;
      if (pid) document.dispatchEvent(new CustomEvent('ambient:editProfile', { detail: { id: pid } }));
      return;
    }
    if (tab) switchAmbientProfile(tab.dataset.pid);
  });

  document.getElementById('btnAmbientAdd')?.addEventListener('click', () => {
    document.getElementById('ambientFile')?.click();
  });
  document.getElementById('ambientFile')?.addEventListener('change', function () {
    if (this.files?.length) addAmbientFiles(this.files);
    this.value = '';
  });

  document.getElementById('ambientMasterVol')?.addEventListener('input', function () {
    setAmbientMasterVolume(parseFloat(this.value));
    const numEl = document.getElementById('ambientMasterVolNum');
    if (numEl) numEl.value = Math.round(parseFloat(this.value) * 100);
  });
  document.getElementById('ambientMasterVolNum')?.addEventListener('input', function () {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const val  = pct / 100;
    setAmbientMasterVolume(val);
    const slEl = document.getElementById('ambientMasterVol');
    if (slEl) slEl.value = val;
  });

  document.getElementById('btnAmbientStopAll')?.addEventListener('click', () => stopAllAmbient());

  const list = document.getElementById('ambientList');
  if (list) {
    list.addEventListener('click', e => {
      const row = e.target.closest('.ambient-row'); if (!row) return;
      const id     = row.dataset.id;
      const actEl  = e.target.closest('[data-act]'); if (!actEl) return;
      const act    = actEl.dataset.act;

      if      (act === 'play')   toggleAmbientPlay(id);
      else if (act === 'icon')   document.dispatchEvent(new CustomEvent('ambient:pickTrackIcon', { detail: { id } }));
      else if (act === 'fx')     document.dispatchEvent(new CustomEvent('ambient:editEffects', { detail: { id } }));
      else if (act === 'remove') { if (confirm('Diesen Ambient-Sound entfernen?')) removeAmbientTrack(id); }
    });

    list.addEventListener('input', e => {
      const row = e.target.closest('.ambient-row'); if (!row) return;
      const id  = row.dataset.id;
      if (e.target.dataset.act === 'vol') {
        const val = parseFloat(e.target.value);
        setAmbientTrackVolume(id, val);
        const pct = row.querySelector('.ambient-row__vol-pct');
        if (pct) pct.textContent = Math.round(val * 100) + '%';
      }
    });

    list.addEventListener('change', e => {
      const row = e.target.closest('.ambient-row'); if (!row) return;
      const id  = row.dataset.id;
      if (e.target.dataset.act === 'name') renameAmbientTrack(id, e.target.value);
    });
  }

  renderAmbientProfileTabs();
  renderAmbientPanel();
  setViewMode(APP.viewMode || 'sound');
}
