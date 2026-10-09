/**
 * music/music-playback.js — Wiedergabe-Engine (Zwei-Player-Crossfade),
 * Ordering/Shuffle, Blob-URL-Cache, Fortschritts-Loop
 */

import { APP, CMP, CMTracks } from '../core/state.js';
import { fmtTime } from '../utils.js';
import { toast } from '../notifications.js';
import { actx } from '../audio/context.js';
import { resolvePlan, buildPipelineGraph, preparePipelineContext, TARGET_CAPS } from '../audio/fx-pipeline.js';
import { asPipelineEffects } from '../fx-model.js';
import { idbGet, audioKey, IDB_SENTINEL } from '../db.js';
// Zirkulärer Import (music-model.js importiert umgekehrt stopMusic/
// _revokeBlobUrl/_orderedTracks/_blobUrls/_resetShuffleOrder aus diesem
// Modul) — unkritisch, da alle betroffenen Bezeichner Funktions-
// deklarationen bzw. nur zur Laufzeit gelesene/geschriebene Objekte sind
// (dasselbe Muster wie in ambient/*.js).
import { ensureMusicState, _findTrack, _persist } from './music-model.js';
import { renderMusicPanel, renderMusicPlayer } from './music-render.js';

// ─── RUNTIME-ONLY STATE (nie persistiert) ────────────────────

// Exportiert: _players/_activeSlot werden von music-render.js
// (Zeilen-Status) und music-events.js benötigt; _crossfading von
// music-model.js (setMusicTrackVolume, Live-Gain-Check); _blobUrls von
// music-model.js (resetMusic).
export let _players       = null;   // { A:{audio,source,gain,trackId}, B:{...}, master } — lazy
export let _activeSlot     = 'A';
let _loadToken      = 0;     // Race-Condition-Absicherung
export let _crossfading    = false;
let _shuffleOrder   = [];    // Track-IDs in fixer Shuffle-Reihenfolge
let _rafId          = null;
export const _blobUrls     = new Map(); // trackId → ObjectURL (sauber freigeben)

// `_shuffleOrder` wird auch von music-model.js (switchMusicProfile/removeMusicTrack/
// resetMusic) zurückgesetzt — ES-Module erlauben kein Neuzuweisen eines
// importierten `let`-Bindings aus einem anderen Modul, daher diese kleine,
// rein kapselnde Hilfsfunktion.
export function _resetShuffleOrder() { _shuffleOrder = []; }


// ─── ORDERING ──────────────────────────────────────
// Ohne bewusste manuelle Reihenfolge: alphabetisch. Sobald einmal manuell
// umsortiert wurde (reorderMusicTrack), gilt ausschließlich .order — keine
// sich gegenseitig überschreibende Mischung aus beidem.

// Exportiert: music-model.js/music-render.js benötigen die
// Track-Reihenfolge (reorderMusicTrack/moveMusicTrack bzw. renderMusicPanel).
export function _orderedTracks() {
  const p = CMP();
  const tracks = [...CMTracks()];
  if (p?.manualOrder) tracks.sort((a, b) => (a.order || 0) - (b.order || 0));
  else tracks.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  return tracks;
}

function _ensureShuffleOrder() {
  const ids = _orderedTracks().map(t => t.id);
  const valid = _shuffleOrder.length === ids.length && _shuffleOrder.every(id => ids.includes(id));
  if (!valid) _shuffleOrder = _shuffleFisherYates(ids);
  return _shuffleOrder;
}

function _shuffleFisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function _playOrder() {
  return APP.music.shuffle ? _ensureShuffleOrder() : _orderedTracks().map(t => t.id);
}


// ─── BLOB-URL-VERWALTUNG ────────────────────────────

// Exportiert: music-model.js ruft _revokeBlobUrl() beim Löschen
// von Profilen/Tracks auf.
export function _revokeBlobUrl(trackId) {
  const url = _blobUrls.get(trackId);
  if (url) { URL.revokeObjectURL(url); _blobUrls.delete(trackId); }
}

function _blobUrlFor(trackId, b64) {
  const cached = _blobUrls.get(trackId);
  if (cached) return cached;
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr]));
  _blobUrls.set(trackId, url);
  return url;
}


// ─── PLAYBACK ENGINE ──────────────────────────────────────────

/** Erzeugt (einmalig) die zwei Player-Slots + den gemeinsamen Music-Master-
 *  Gain. MediaElementSource darf pro <audio> nur einmal erzeugt werden —
 *  deshalb feste, wiederverwendete Elemente statt pro Track neuer Objekte. */
function _ensurePlayers() {
  if (_players) return _players;
  const ctx = actx();
  const master = ctx.createGain();
  master.gain.value = APP.music.masterVol ?? 1;
  master.connect(ctx.destination);
  const mk = () => {
    const audio = new Audio();
    audio.preload = 'metadata';
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // KEINE statische source→gain-Verkabelung: der tatsächliche Signalweg (mit oder
    // ohne Effektkette) wird pro geladenem Track in _reconnectSlotFx() aufgebaut, weil
    // das Preset (effects) sich von Track zu Track unterscheidet.
    gain.connect(master);
    const rec = { audio, source, gain, trackId: null, fxChain: null };
    // renderMusicPanel()/renderMusicPlayer() reagieren auf die echten play/pause-Events
    // des <audio>-Elements, nicht nur an den JS-Aufrufstellen (playMusicTrack/
    // _switchToTrack usw.): .play() beginnt bei noch ungeladenen Metadaten erst
    // asynchron NACH diesem Aufruf tatsächlich zu spielen, das Icon bliebe sonst auf
    // "Play" stehen. Die Events sind die zuverlässige Quelle der Wahrheit — bei jedem
    // Wechsel wird neu gerendert, unabhängig davon, WARUM sich der Zustand geändert hat.
    audio.addEventListener('play',  () => { renderMusicPanel(); renderMusicPlayer(); });
    audio.addEventListener('pause', () => { renderMusicPanel(); renderMusicPlayer(); });
    return rec;
  };
  _players = { A: mk(), B: mk(), master };
  return _players;
}

/**
 * Baut den Signalweg für einen Player-Slot neu auf —
 * source → [Effektkette] → gain → master (gain→master bleibt statisch,
 * s. _ensurePlayers()). Wird bei JEDEM Track-Laden in einen Slot
 * aufgerufen (_loadIntoSlot()), weil jeder Track sein eigenes
 * Effekt-Preset mitbringt. Trennt zuerst sauber die alte Verkabelung
 * (source.disconnect() kappt ALLE bisherigen Ausgänge des MediaElement-
 * Source-Node — der einzige Knoten, der pro <audio>-Element nur einmal
 * erzeugt werden darf und daher dauerhaft wiederverwendet wird), damit
 * beim Slot-Wechsel keine doppelten Verbindungen/Nodes hängen bleiben.
 * Die alten Effektketten-Nodes (BiquadFilter/Compressor/Convolver/…) sind
 * danach von niemandem mehr referenziert und werden vom Garbage Collector
 * eingesammelt.
 */
function _reconnectSlotFx(rec, effects) {
  try { rec.source.disconnect(); } catch (e) {}
  if (rec.fxChain) { try { rec.fxChain.dispose(); } catch (e) {} rec.fxChain = null; }   // alte LFOs/Träger/Worklets freigeben
  const ctx = actx();
  // Gleiche Pipeline wie überall (Reihenfolge = Benutzerreihenfolge). Das Pitch-Worklet muss vorher geladen sein
  // (_loadIntoSlot()/applyMusicTrackEffectsLive() erledigen das); fehlt es, greift der dokumentierte Notbehelf.
  const graph = buildPipelineGraph(ctx, resolvePlan(asPipelineEffects(effects)), { numChannels: 2, caps: TARGET_CAPS.music });
  if (graph.input) { rec.source.connect(graph.input); graph.output.connect(rec.gain); }
  else rec.source.connect(rec.gain);
  rec.fxChain = graph;
}

/**
 * Nach „Musikstück speichern": Effektkette eines GERADE geladenen Tracks (aktiver oder auslaufender Slot)
 * sofort auf die gespeicherten Effekte umstellen, statt erst beim nächsten Laden. Berührt weder
 * Gain-Automation noch Position/Pause-Zustand — nur die Verbindung Source → [Kette] → Gain wird neu
 * aufgebaut (_reconnectSlotFx(), s.o.). Während eines Crossfades unverändert (keine Eingriffe in die Rampen).
 */
export function applyMusicTrackEffectsLive(trackId, effects) {
  if (!_players || _crossfading) return;
  ['A', 'B'].forEach(slot => {
    const rec = _players[slot];
    if (rec?.trackId === trackId && rec.source) {
      preparePipelineContext(actx(), resolvePlan(asPipelineEffects(effects)), TARGET_CAPS.music)
        .catch(() => {})
        .then(() => { if (rec.trackId === trackId && rec.source) _reconnectSlotFx(rec, effects); });
    }
  });
}

async function _loadIntoSlot(slot, track) {
  const players = _ensurePlayers();
  const rec = players[slot];
  if (!track.data) { toast('Keine Audiodatei geladen', 'err'); return null; }

  const myToken = _loadToken;
  let b64 = track.data;
  if (track.data === IDB_SENTINEL) {
    b64 = await idbGet(audioKey(track.id, 0));
    if (myToken !== _loadToken) return null; // Inzwischen überholt
    if (!b64) { toast(`"${track.name}" konnte nicht geladen werden`, 'err'); return null; }
  }

  let url;
  try { url = _blobUrlFor(track.id, b64); }
  catch (e) { console.error('[music] blob decode failed:', e); toast('Datei konnte nicht gelesen werden', 'err'); return null; }
  if (myToken !== _loadToken) return null;

  rec.audio.src   = url;
  rec.trackId     = track.id;
  // Effektkette für DIESEN Track aufbauen — jeder
  // Track kann ein anderes Preset haben, daher pro Ladevorgang neu.
  try { await preparePipelineContext(actx(), resolvePlan(asPipelineEffects(track.effects)), TARGET_CAPS.music); } catch (e) {}
  if (myToken !== _loadToken) return null;
  _reconnectSlotFx(rec, track.effects);
  return rec;
}

function _attachEndedHandler(rec, trackId) {
  rec.audio.onended = () => {
    if (_players[_activeSlot] !== rec || rec.trackId !== trackId) return; // überholt/ersetzt
    _handleTrackEnded();
  };
  rec.audio.onerror = () => {
    if (rec.trackId !== trackId) return;
    toast('Wiedergabe fehlgeschlagen — Format evtl. nicht unterstützt', 'err');
  };
}

function _handleTrackEnded() {
  if (APP.music.repeatMode === 'one') {
    const rec = _players[_activeSlot];
    if (rec) { rec.audio.currentTime = 0; rec.audio.play().catch(() => {}); _startProgressLoop(); }
    return;
  }
  if (!APP.music.autoplay) { stopMusic(); return; }
  nextMusicTrack({ auto: true });
}

/** Klick auf aktiven Track = Play/Pause, auf anderen Track = wechseln. */
export async function playMusicTrack(id) {
  ensureMusicState();
  const track = _findTrack(id);
  if (!track) return;

  if (APP.music.activeTrackId === id) {
    const rec = _players?.[_activeSlot];
    if (rec && rec.trackId === id) {
      if (rec.audio.paused) { rec.audio.play().catch(() => {}); _startProgressLoop(); }
      else rec.audio.pause();
      renderMusicPanel(); renderMusicPlayer();
      return;
    }
  }
  await _switchToTrack(track);
}

async function _switchToTrack(track) {
  ensureMusicState();
  const myToken = ++_loadToken;
  const oldSlot = _activeSlot;
  const newSlot = oldSlot === 'A' ? 'B' : 'A';

  const rec = await _loadIntoSlot(newSlot, track);
  if (myToken !== _loadToken || !rec) return; // Überholt oder fehlgeschlagen

  const ctx = actx();
  const targetGain = track.vol ?? 1;
  const startAt = track.trimStart || 0;
  const cf = Math.max(0, APP.music.crossfade || 0);

  const players = _ensurePlayers();
  const oldRec  = players[oldSlot];
  const hasOld  = !!(oldRec.trackId && !oldRec.audio.paused);

  const doPlay = () => {
    if (myToken !== _loadToken) return; // während des Ladens überholt
    if (isFinite(rec.audio.duration) && rec.audio.duration > 0) {
      track.duration = rec.audio.duration;
      _persist();
    }
    try { if (startAt > 0) rec.audio.currentTime = startAt; } catch (e) {}
    rec.audio.play().catch(e => {
      console.warn('[music] play blocked:', e);
      toast('Wiedergabe wurde vom Browser blockiert — bitte erneut klicken', 'err');
    });
    _startProgressLoop();
  };
  if (rec.audio.readyState >= 1) doPlay();
  else rec.audio.addEventListener('loadedmetadata', doPlay, { once: true });

  rec.gain.gain.cancelScheduledValues(ctx.currentTime);
  if (cf > 0 && hasOld) {
    _crossfading = true;
    const now = ctx.currentTime;
    rec.gain.gain.setValueAtTime(0, now);
    rec.gain.gain.linearRampToValueAtTime(targetGain, now + cf);
    oldRec.gain.gain.cancelScheduledValues(now);
    oldRec.gain.gain.setValueAtTime(oldRec.gain.gain.value, now);
    oldRec.gain.gain.linearRampToValueAtTime(0, now + cf);
    const fadingSlot = oldSlot;
    setTimeout(() => {
      const cur = players[fadingSlot];
      if (cur === oldRec) { try { oldRec.audio.pause(); } catch (e) {} oldRec.trackId = null; }
      _crossfading = false;
    }, cf * 1000 + 80);
  } else {
    if (hasOld) { try { oldRec.audio.pause(); } catch (e) {} oldRec.trackId = null; }
    rec.gain.gain.setValueAtTime(targetGain, ctx.currentTime);
  }

  _activeSlot = newSlot;
  APP.music.activeTrackId = track.id;
  _attachEndedHandler(rec, track.id);
  _persist();
  renderMusicPanel();
  renderMusicPlayer();
  document.dispatchEvent(new CustomEvent('music:stateChanged'));
}

export function pauseMusic() {
  const rec = _players?.[_activeSlot];
  if (rec && !rec.audio.paused) rec.audio.pause();
  renderMusicPanel(); renderMusicPlayer();
}

export function resumeMusic() {
  const rec = _players?.[_activeSlot];
  if (rec && rec.trackId && rec.audio.paused) {
    rec.audio.play().catch(() => {});
    _startProgressLoop();
  }
  renderMusicPanel(); renderMusicPlayer();
}

/** Stoppt AUSSCHLIESSLICH Musik — rührt Sound-Kacheln/Ambient nicht an. */
export function stopMusic() {
  ++_loadToken; // laufende Ladevorgänge verwerfen
  if (_players) {
    ['A', 'B'].forEach(slot => {
      const rec = _players[slot];
      if (rec.trackId) {
        rec.audio.onended = null;
        try { rec.audio.pause(); } catch (e) {}
        rec.trackId = null;
      }
    });
  }
  _stopProgressLoop();
  renderMusicPanel();
  renderMusicPlayer();
}

export function seekMusic(sec) {
  const rec = _players?.[_activeSlot];
  if (!rec || !rec.trackId) return;
  const dur = isFinite(rec.audio.duration) ? rec.audio.duration : sec;
  rec.audio.currentTime = Math.max(0, Math.min(dur, sec));
  _updateProgressUI();
}

export function nextMusicTrack({ auto = false } = {}) {
  ensureMusicState();
  const order = _playOrder();
  if (!order.length) { stopMusic(); return; }
  const idx = order.indexOf(APP.music.activeTrackId);
  let nextIdx = idx + 1;
  if (nextIdx >= order.length) {
    if (APP.music.repeatMode === 'all') nextIdx = 0;
    else { if (auto) stopMusic(); return; }
  }
  const track = _findTrack(order[nextIdx]);
  if (track) _switchToTrack(track);
}

export function previousMusicTrack() {
  ensureMusicState();
  // Klassisches Player-Verhalten: > 3s in den Track hinein -> Trackanfang,
  // sonst echter Sprung zum vorherigen Track.
  const rec = _players?.[_activeSlot];
  if (rec && rec.trackId && rec.audio.currentTime > 3) { seekMusic(0); return; }
  const order = _playOrder();
  if (!order.length) return;
  const idx = order.indexOf(APP.music.activeTrackId);
  let prevIdx = idx - 1;
  if (prevIdx < 0) prevIdx = APP.music.repeatMode === 'all' ? order.length - 1 : 0;
  const track = _findTrack(order[prevIdx]);
  if (track) _switchToTrack(track);
}

export function setMusicMasterVolume(val) {
  ensureMusicState();
  APP.music.masterVol = Math.max(0, Math.min(1, val));
  if (_players) _players.master.gain.value = APP.music.masterVol;
  _persist();
}

export function setMusicRepeatMode(mode) {
  ensureMusicState();
  APP.music.repeatMode = ['off', 'all', 'one'].includes(mode) ? mode : 'off';
  _persist();
  renderMusicPlayer();
}

export function toggleMusicShuffle() {
  ensureMusicState();
  APP.music.shuffle = !APP.music.shuffle;
  if (APP.music.shuffle) { _shuffleOrder = []; _ensureShuffleOrder(); }
  _persist();
  renderMusicPlayer();
}

export function setMusicCrossfade(sec) {
  ensureMusicState();
  APP.music.crossfade = Math.max(0, Number(sec) || 0);
  _persist();
}

export function setMusicAutoplay(on) {
  ensureMusicState();
  APP.music.autoplay = !!on;
  _persist();
}

export function isMusicPlaying() {
  const rec = _players?.[_activeSlot];
  return !!(rec && rec.trackId && !rec.audio.paused);
}

// ─── PROGRESS (rAF, throttled auf die aktive Zeile) ──────

function _startProgressLoop() {
  if (_rafId) return;
  const tick = () => {
    _updateProgressUI();
    const rec = _players?.[_activeSlot];
    if (rec && rec.trackId && !rec.audio.paused) _rafId = requestAnimationFrame(tick);
    else _rafId = null;
  };
  _rafId = requestAnimationFrame(tick);
}
function _stopProgressLoop() {
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = null;
}

export function _updateProgressUI() {
  const rec = _players?.[_activeSlot];
  const cur = rec?.trackId ? rec.audio.currentTime : 0;
  const dur = rec?.trackId ? rec.audio.duration : 0;

  const seekEl = document.getElementById('musicSeek');
  if (seekEl && document.activeElement !== seekEl) {
    seekEl.max   = isFinite(dur) && dur > 0 ? dur : 0;
    seekEl.value = isFinite(cur) ? cur : 0;
  }
  const curEl = document.getElementById('musicCurTime');
  const durEl = document.getElementById('musicDurTime');
  if (curEl) curEl.textContent = fmtTime(cur);
  if (durEl) durEl.textContent = fmtTime(dur);

  if (rec?.trackId) {
    const fill = document.querySelector(`.music-row[data-id="${rec.trackId}"] .music-row__progress-fill`);
    if (fill && isFinite(dur) && dur > 0) fill.style.width = Math.min(100, (cur / dur) * 100) + '%';
  }
}

