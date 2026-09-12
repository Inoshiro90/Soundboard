/**
 * music.js — Musikspuren: eigenständige Playlist-/Musikplayer-Ansicht
 *
 * WICHTIGER UNTERSCHIED ZU ambient.js:
 *   Ambient  → mehrere parallele Loop-/Interval-Quellen, kein "aktiver Track".
 *   Musik    → Playlist-Logik, normalerweise GENAU EIN aktiver Track,
 *              Next/Previous/Shuffle/Repeat/Crossfade/Seek/Progress.
 * Deshalb eigenes Datenmodell UND eigene Playback-Engine (kein Ambient-Klon).
 *
 * PLAYBACK-ENGINE:
 *   Zwei persistente <audio>-Elemente ("Slot A"/"Slot B") werden je EINMAL
 *   über AudioContext.createMediaElementSource() in den Web-Audio-Graphen
 *   eingehängt (source → trackGain → musicMasterGain → destination) und
 *   danach nur noch per .src wiederverwendet — MediaElementSourceNode darf
 *   pro <audio>-Element nur einmal erzeugt werden. HTMLAudioElement liefert
 *   nativ Pause/Resume/Seek/Dauer (robuster & speicherschonender als
 *   AudioBufferSourceNode für potenziell große Musikdateien, Kap. 44), die
 *   Web-Audio-GainNodes ermöglichen sauberes Crossfade zwischen den beiden
 *   Slots ohne hörbare Sprünge/Doppelstarts (Kap. 21).
 *
 * STORAGE:
 *   Exakt dieselbe IndexedDB-Infrastruktur wie Sound/Ambient (db.js:
 *   audioKey/idbSet/idbGet), Key = `${trackId}:0` — eindeutig getrennt von
 *   Sound-/Ambient-Keys, weil track.id ein global eindeutiger uid() ist
 *   (dasselbe Prinzip wie ambient.js's `audioKey(variant.id, 0)`).
 *
 * RACE CONDITIONS (Kap. 6):
 *   Jeder Ladevorgang bekommt ein monoton steigendes _loadToken. Wird beim
 *   Abschluss eines async Ladevorgangs festgestellt, dass ein neuerer Token
 *   inzwischen vergeben wurde, wird das Ergebnis verworfen (der veraltete
 *   Track darf nicht mehr nachträglich starten).
 */

import { APP, CMP, CMTracks }        from './state.js';
import { uid, iconHtmlOr, fmtTime }  from './utils.js';
import { toast }                     from './notifications.js';
import { actx }                      from './audio.js';
import { idbSet, idbGet, idbDelete, audioKey, IDB_SENTINEL } from './db.js';
import { _saveRaw, exportMusicTrack, exportMusicProfile } from './storage.js';
import { PENCIL_ICON_SVG, updateStatus }   from './ui.js';

// ─── CONSTANTS ───────────────────────────────────────────────

const MUSIC_ICONS = ['🎵','⚔️','🏰','🌲','🍺','🐉','👑','🔥','🌙','⚡','🎻','🥁'];

// ─── RUNTIME-ONLY STATE (nie persistiert) ────────────────────

let _players       = null;   // { A:{audio,source,gain,trackId}, B:{...}, master } — lazy
let _activeSlot     = 'A';
let _loadToken      = 0;     // Race-Condition-Absicherung (Kap. 6)
let _crossfading    = false;
let _shuffleOrder   = [];    // Track-IDs in fixer Shuffle-Reihenfolge (Kap. 16)
let _rafId          = null;
const _blobUrls     = new Map(); // trackId → ObjectURL (Kap. 65: sauber freigeben)

// ─── STATE HELPERS ───────────────────────────────────────────

export function ensureMusicState() {
  if (!APP.music || typeof APP.music !== 'object') {
    APP.music = {
      profiles: [], activeProfileId: null, masterVol: 1, activeTrackId: null,
      repeatMode: 'off', shuffle: false, crossfade: 2, autoplay: true
    };
  }
  if (!Array.isArray(APP.music.profiles)) APP.music.profiles = [];
  if (!APP.music.profiles.length) {
    const p = { id: uid(), name: 'Musik', icon: '🎵', tracks: [], manualOrder: false };
    APP.music.profiles.push(p);
    APP.music.activeProfileId = p.id;
  }
  APP.music.profiles.forEach(p => {
    if (!Array.isArray(p.tracks)) p.tracks = [];
    if (typeof p.manualOrder !== 'boolean') p.manualOrder = false;
  });
  if (!APP.music.activeProfileId || !APP.music.profiles.find(p => p.id === APP.music.activeProfileId)) {
    APP.music.activeProfileId = APP.music.profiles[0].id;
  }
  if (typeof APP.music.masterVol !== 'number') APP.music.masterVol = 1;
  if (!['off', 'all', 'one'].includes(APP.music.repeatMode)) APP.music.repeatMode = 'off';
  if (typeof APP.music.shuffle !== 'boolean') APP.music.shuffle = false;
  if (typeof APP.music.crossfade !== 'number') APP.music.crossfade = 2;
  if (typeof APP.music.autoplay !== 'boolean') APP.music.autoplay = true;
}

function _persist() { try { _saveRaw(); } catch (e) { console.warn('[music] persist failed:', e); } }

function _findTrack(trackId) {
  for (const p of APP.music.profiles) {
    const t = (p.tracks || []).find(x => x.id === trackId);
    if (t) return t;
  }
  return null;
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
  return {
    id: uid(), name: name || 'Track', artist: '', album: '',
    icon: MUSIC_ICONS[CMTracks().length % MUSIC_ICONS.length], color: 'none',
    data: null, fileName: '', duration: 0, vol: 1, order: CMTracks().length,
    trimStart: 0, trimEnd: null
  };
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ─── ORDERING (Kap. 54) ──────────────────────────────────────
// Ohne bewusste manuelle Reihenfolge: alphabetisch. Sobald einmal manuell
// umsortiert wurde (reorderMusicTrack), gilt ausschließlich .order — keine
// sich gegenseitig überschreibende Mischung aus beidem.

function _orderedTracks() {
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

// ─── PROFILE (PLAYLIST) CRUD ─────────────────────────────────

export function saveMusicProfile(id, name, icon) {
  ensureMusicState();
  const cleanName = (name || '').trim() || 'Playlist';
  const cleanIcon = (icon || '').trim() || '🎵';
  if (id) {
    const p = APP.music.profiles.find(x => x.id === id);
    if (p) { p.name = cleanName; p.icon = cleanIcon; }
  } else {
    const np = { id: uid(), name: cleanName, icon: cleanIcon, tracks: [], manualOrder: false };
    APP.music.profiles.push(np);
    APP.music.activeProfileId = np.id;
  }
  _persist();
  renderMusicProfileTabs();
  renderMusicPanel();
}

export function deleteMusicProfile(id) {
  ensureMusicState();
  if (APP.music.profiles.length <= 1) { toast('Letzte Playlist kann nicht gelöscht werden', 'err'); return false; }
  const p = APP.music.profiles.find(x => x.id === id);
  if (p) {
    (p.tracks || []).forEach(t => {
      if (APP.music.activeTrackId === t.id) stopMusic();
      _revokeBlobUrl(t.id);
      idbDelete(audioKey(t.id, 0)).catch(() => {});
    });
  }
  APP.music.profiles = APP.music.profiles.filter(x => x.id !== id);
  if (APP.music.activeProfileId === id) APP.music.activeProfileId = APP.music.profiles[0]?.id || null;
  _persist();
  renderMusicProfileTabs();
  renderMusicPanel();
  return true;
}

export function switchMusicProfile(id) {
  ensureMusicState();
  if (id === APP.music.activeProfileId) return;
  // Anders als Ambient-Szenenwechsel wird die Musik NICHT gestoppt — der
  // Track spielt weiter, auch wenn man die Playlist wechselt, in der er
  // liegt (Kap. 38: Ansichten/Listen sind keine Audiomodi).
  APP.music.activeProfileId = id;
  _shuffleOrder = [];
  _persist();
  renderMusicProfileTabs();
  renderMusicPanel();
}

// ─── TRACK CRUD ───────────────────────────────────────────────

export async function addMusicFiles(fileList) {
  ensureMusicState();
  const files = [...fileList].filter(f => f && f.type.startsWith('audio'));
  if (!files.length) { toast('Keine gültige Audiodatei', 'err'); return; }
  const tracks = CMTracks();

  for (const f of files) {
    const track = _mkTrack(f.name.replace(/\.[^.]+$/, ''));
    track.fileName = f.name;
    tracks.push(track);
    renderMusicPanel();
    try {
      const b64 = await _fileToBase64(f);
      await idbSet(audioKey(track.id, 0), b64);
      track.data = IDB_SENTINEL;
    } catch (e) {
      console.error('[music] file load error:', e);
      toast(`"${f.name}" konnte nicht geladen werden`, 'err');
    }
    renderMusicPanel();
  }
  _persist();
  toast(`${files.length} Musikstück${files.length > 1 ? 'e' : ''} hinzugefügt`, 'ok');
}

export function renameMusicTrack(trackId, name) {
  const t = _findTrack(trackId); if (!t) return;
  t.name = (name || '').trim() || 'Track';
  _persist();
}

export function editMusicTrackMeta(trackId, { name, artist, album, icon, color }) {
  const t = _findTrack(trackId); if (!t) return;
  if (name   !== undefined) t.name   = (name || '').trim() || 'Track';
  if (artist !== undefined) t.artist = (artist || '').trim();
  if (album  !== undefined) t.album  = (album  || '').trim();
  if (icon   !== undefined && icon)  t.icon  = icon;
  if (color  !== undefined && color) t.color = color;
  _persist();
  renderMusicPanel();
  renderMusicPlayer();
}

export function setMusicTrackIcon(trackId, icon) {
  const t = _findTrack(trackId); if (!t) return;
  t.icon = icon;
  _persist();
  renderMusicPanel();
}

export function setMusicTrackVolume(trackId, val) {
  const t = _findTrack(trackId); if (!t) return;
  t.vol = Math.max(0, Math.min(1, val));
  // Live nachziehen, falls dieser Track gerade (auch während eines
  // Crossfades) tatsächlich läuft — ohne die andere Slot-Automation zu stören.
  if (_players) {
    ['A', 'B'].forEach(slot => {
      const rec = _players[slot];
      if (rec.trackId === trackId && !_crossfading) rec.gain.gain.value = t.vol;
    });
  }
  _persist();
}

export function removeMusicTrack(trackId) {
  const wasActive = APP.music.activeTrackId === trackId;
  if (wasActive) stopMusic();
  for (const p of APP.music.profiles) {
    p.tracks = (p.tracks || []).filter(t => t.id !== trackId);
  }
  _revokeBlobUrl(trackId);
  idbDelete(audioKey(trackId, 0)).catch(() => {});
  if (wasActive) {
    // Kap. 42: sinnvollen nächsten Track bestimmen, sonst stoppen (bereits
    // durch stopMusic() geschehen — activeTrackId bleibt hier bewusst leer,
    // kein automatischer Weiterlauf auf einen ggf. unerwarteten Track).
    APP.music.activeTrackId = null;
  }
  _shuffleOrder = [];
  _persist();
  renderMusicPanel();
  renderMusicPlayer();
}

/** Manuelle Umsortierung (Drag&Drop oder ↑/↓-Buttons) — schaltet ab hier
 *  dauerhaft auf .order statt alphabetischer Sortierung (Kap. 54). */
export function reorderMusicTrack(idA, idB) {
  const p = CMP(); if (!p) return;
  const tracks = p.tracks || [];
  const ai = tracks.findIndex(x => x.id === idA);
  const bi = tracks.findIndex(x => x.id === idB);
  if (ai < 0 || bi < 0) return;
  if (!p.manualOrder) {
    // Erstmalige manuelle Aktion: aktuelle (bisher alphabetische) Anzeige
    // als Ausgangs-.order einfrieren, dann die Positionen von A/B tauschen.
    _orderedTracks().forEach((t, i) => { t.order = i; });
    p.manualOrder = true;
  }
  [tracks[ai].order, tracks[bi].order] = [tracks[bi].order, tracks[ai].order];
  _persist();
  renderMusicPanel();
}

export function moveMusicTrack(trackId, dir) {
  const ordered = _orderedTracks();
  const idx = ordered.findIndex(t => t.id === trackId);
  if (idx < 0) return;
  const otherIdx = idx + dir;
  if (otherIdx < 0 || otherIdx >= ordered.length) return;
  reorderMusicTrack(trackId, ordered[otherIdx].id);
}

// ─── BLOB-URL-VERWALTUNG (Kap. 65) ────────────────────────────

function _revokeBlobUrl(trackId) {
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
    source.connect(gain);
    gain.connect(master);
    const rec = { audio, source, gain, trackId: null };
    // BUGFIX (Nutzer-Feedback): renderMusicPanel()/renderMusicPlayer() wurden
    // bisher nur an den JS-Aufrufstellen (playMusicTrack/_switchToTrack usw.)
    // aktualisiert. Da .play() bei noch ungeladenen Metadaten erst asynchron
    // NACH diesem Aufruf tatsächlich zu spielen beginnt, blieb das Icon auf
    // "Play" stehen. Die echten play/pause-Events des <audio>-Elements sind
    // die zuverlässige Quelle der Wahrheit — bei jedem Wechsel wird neu
    // gerendert, unabhängig davon, WARUM sich der Zustand geändert hat.
    audio.addEventListener('play',  () => { renderMusicPanel(); renderMusicPlayer(); });
    audio.addEventListener('pause', () => { renderMusicPanel(); renderMusicPlayer(); });
    return rec;
  };
  _players = { A: mk(), B: mk(), master };
  return _players;
}

async function _loadIntoSlot(slot, track) {
  const players = _ensurePlayers();
  const rec = players[slot];
  if (!track.data) { toast('Keine Audiodatei geladen', 'err'); return null; }

  const myToken = _loadToken;
  let b64 = track.data;
  if (track.data === IDB_SENTINEL) {
    b64 = await idbGet(audioKey(track.id, 0));
    if (myToken !== _loadToken) return null; // Kap. 6: inzwischen überholt
    if (!b64) { toast(`"${track.name}" konnte nicht geladen werden`, 'err'); return null; }
  }

  let url;
  try { url = _blobUrlFor(track.id, b64); }
  catch (e) { console.error('[music] blob decode failed:', e); toast('Datei konnte nicht gelesen werden', 'err'); return null; }
  if (myToken !== _loadToken) return null;

  rec.audio.src   = url;
  rec.trackId     = track.id;
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

/** Kap. 57: Klick auf aktiven Track = Play/Pause, auf anderen Track = wechseln. */
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
  if (myToken !== _loadToken || !rec) return; // Kap. 6: überholt oder fehlgeschlagen

  const ctx = actx();
  const targetGain = track.vol ?? 1;
  const startAt = track.trimStart || 0;
  const cf = Math.max(0, APP.music.crossfade || 0);

  const players = _ensurePlayers();
  const oldRec  = players[oldSlot];
  const hasOld  = !!(oldRec.trackId && !oldRec.audio.paused);

  const doPlay = () => {
    if (myToken !== _loadToken) return; // während des Ladens überholt (Kap. 6)
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

/** Stoppt AUSSCHLIESSLICH Musik (Kap. 18) — rührt Sound-Kacheln/Ambient nicht an. */
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
  // sonst echter Sprung zum vorherigen Track (Kap. 14).
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

// ─── PROGRESS (rAF, throttled auf die aktive Zeile — Kap. 12/44) ──────

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

function _updateProgressUI() {
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

// ─── RENDERING ─────────────────────────────────────────────────

/** Mirrors renderProfileTabs()/renderAmbientProfileTabs() — linksbündiger
 *  Name, rechtsbündiger Edit-Button, Lucide-Pencil-Icon (Kap. 47). */
export function renderMusicProfileTabs() {
  ensureMusicState();
  const bar    = document.getElementById('musicProfBar');
  const addBtn = document.getElementById('btnAddMusicProfile');
  if (!bar) return;
  bar.querySelectorAll('.profile-tab').forEach(t => t.remove());

  APP.music.profiles.forEach(p => {
    const tab = document.createElement('button');
    const isActive = p.id === APP.music.activeProfileId;
    const hasLive  = (p.tracks || []).some(t => t.id === APP.music.activeTrackId) && isMusicPlaying();
    tab.className = 'profile-tab' + (isActive ? ' is-active' : '');
    tab.dataset.pid = p.id;
    tab.innerHTML =
      `<span class="profile-tab__name">${iconHtmlOr(p.icon, '🎵', 'profile-tab__icon-img')} ${_esc(p.name)}${hasLive ? ' <span class="profile-tab__live" title="Musik läuft" aria-hidden="true"></span>' : ''}</span>` +
      `<span class="profile-tab__edit" title="Playlist bearbeiten" aria-label="Playlist bearbeiten">${PENCIL_ICON_SVG}</span>`;
    bar.insertBefore(tab, addBtn);
  });
}

function _trackRowTemplate(t) {
  const isActive  = t.id === APP.music.activeTrackId;
  const isPlaying = isActive && isMusicPlaying();
  const rec       = isActive ? _players?.[_activeSlot] : null;
  const pct       = rec && rec.audio.duration ? Math.min(100, (rec.audio.currentTime / rec.audio.duration) * 100) : 0;
  return `
  <div class="music-row${isActive ? ' is-active' : ''}${isPlaying ? ' is-playing' : ''}" data-id="${t.id}">
    <span class="music-row__handle" draggable="true" title="Ziehen zum Neuanordnen" aria-label="${_esc(t.name)} neu anordnen">
      <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
    </span>
    <button class="music-row__play" data-act="play" ${t.data ? '' : 'disabled'}
      title="${isPlaying ? 'Pause' : 'Abspielen'}" aria-label="${isPlaying ? 'Pause' : 'Abspielen'} — ${_esc(t.name)}">
      <i class="fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}" aria-hidden="true"></i>
    </button>
    <span class="music-row__icon" aria-hidden="true">${iconHtmlOr(t.icon, '🎵', 'music-row__icon-img')}</span>
    <div class="music-row__info">
      <span class="music-row__name">${_esc(t.name)}</span>
      ${t.artist ? `<span class="music-row__artist">${_esc(t.artist)}${t.album ? ' — ' + _esc(t.album) : ''}</span>` : ''}
      <div class="music-row__progress" aria-hidden="true"><div class="music-row__progress-fill" style="width:${pct}%"></div></div>
    </div>
    <span class="music-row__duration">${t.duration ? fmtTime(t.duration) : '—:—'}</span>
    <div class="music-row__vol-group">
      <input type="range" class="slider music-row__vol" data-act="vol" min="0" max="1" step=".01" value="${t.vol}"
        aria-label="Lautstärke ${_esc(t.name)}">
      <input type="number" class="music-row__vol-num" data-act="volnum" min="0" max="100" step="1"
        value="${Math.round((t.vol ?? 1) * 100)}" aria-label="Lautstärke ${_esc(t.name)} in Prozent">
    </div>
    <div class="music-row__reorder">
      <button class="music-row__reorder-btn" data-act="up" title="Nach oben" aria-label="${_esc(t.name)} nach oben verschieben"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>
      <button class="music-row__reorder-btn" data-act="down" title="Nach unten" aria-label="${_esc(t.name)} nach unten verschieben"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
    </div>
    <button class="music-row__opt" data-act="edit" title="Bearbeiten" aria-label="${_esc(t.name)} bearbeiten">${PENCIL_ICON_SVG}</button>
    <button class="music-row__opt music-row__opt--danger" data-act="remove" title="Löschen" aria-label="${_esc(t.name)} löschen">
      <i class="fa-solid fa-trash" aria-hidden="true"></i>
    </button>
  </div>`;
}

export function renderMusicPanel() {
  ensureMusicState();
  const list  = document.getElementById('musicList');
  const empty = document.getElementById('musicEmpty');
  if (!list) return;
  const tracks = _orderedTracks();
  if (empty) empty.style.display = tracks.length ? 'none' : '';
  list.innerHTML = tracks.map(_trackRowTemplate).join('');
  const countEl = document.getElementById('musicCount');
  if (countEl) countEl.textContent = String(tracks.length);
  updateStatus();
}

export function renderMusicPlayer() {
  ensureMusicState();
  const track = _findTrack(APP.music.activeTrackId);
  const playing = isMusicPlaying();

  const nameEl = document.getElementById('musicPlayerName');
  if (nameEl) nameEl.textContent = track ? track.name : 'Kein Track ausgewählt';

  const playBtn = document.getElementById('btnMusicPlayPause');
  if (playBtn) {
    playBtn.disabled = !track;
    playBtn.title = playing ? 'Pause' : 'Abspielen';
    playBtn.setAttribute('aria-label', playBtn.title);
    const icon = playBtn.querySelector('i');
    if (icon) icon.className = `fa-solid ${playing ? 'fa-pause' : 'fa-play'}`;
  }

  const repeatBtn = document.getElementById('btnMusicRepeat');
  if (repeatBtn) {
    const mode = APP.music.repeatMode;
    repeatBtn.classList.toggle('is-active', mode !== 'off');
    repeatBtn.setAttribute('aria-pressed', String(mode !== 'off'));
    repeatBtn.title = mode === 'off' ? 'Wiederholen: Aus' : mode === 'all' ? 'Wiederholen: Alle' : 'Wiederholen: Ein Track';
    repeatBtn.setAttribute('aria-label', repeatBtn.title);
    repeatBtn.classList.toggle('is-repeat-one', mode === 'one');
  }

  const shuffleBtn = document.getElementById('btnMusicShuffle');
  if (shuffleBtn) {
    shuffleBtn.classList.toggle('is-active', APP.music.shuffle);
    shuffleBtn.setAttribute('aria-pressed', String(APP.music.shuffle));
  }

  const mv = document.getElementById('musicMasterVol');
  if (mv) mv.value = APP.music.masterVol ?? 1;
  const mvNum = document.getElementById('musicMasterVolNum');
  if (mvNum) mvNum.value = Math.round((APP.music.masterVol ?? 1) * 100);

  const cfSel = document.getElementById('musicCrossfade');
  if (cfSel) cfSel.value = String(APP.music.crossfade);
  const apChk = document.getElementById('musicAutoplay');
  if (apChk) apChk.checked = !!APP.music.autoplay;

  _updateProgressUI();
  // Live-Indikator am Mode-Toggle-Button (Kap. 39) — analog zum Ambient-Muster.
  document.getElementById('btnModeMusic')?.classList.toggle('has-live-indicator', playing);
  renderMusicProfileTabs();
}

// ─── RESET (Kap. 35) ───────────────────────────────────────────

export function resetMusic() {
  stopMusic();
  _blobUrls.forEach(url => URL.revokeObjectURL(url));
  _blobUrls.clear();
  _shuffleOrder = [];
  const p = { id: uid(), name: 'Musik', icon: '🎵', tracks: [], manualOrder: false };
  APP.music = {
    profiles: [p], activeProfileId: p.id, masterVol: 1, activeTrackId: null,
    repeatMode: 'off', shuffle: false, crossfade: 2, autoplay: true
  };
  renderMusicProfileTabs();
  renderMusicPanel();
  renderMusicPlayer();
}

// ─── VIEW-MODE-INTEGRATION (aufgerufen von ambient.js: setViewMode) ────
// Playback läuft unabhängig von der Sichtbarkeit weiter (Kap. 38) — diese
// Funktion schaltet nur die DOM-Sichtbarkeit, nie Play/Pause.

export function applyMusicViewVisibility(isMusicView) {
  document.getElementById('musicProfBar')?.toggleAttribute('hidden', !isMusicView);
  document.getElementById('musicBoard')?.toggleAttribute('hidden', !isMusicView);
  if (isMusicView) { renderMusicPanel(); renderMusicPlayer(); }
}

// ─── EVENTS ────────────────────────────────────────────────────

export function registerMusicEvents() {
  ensureMusicState();

  document.getElementById('musicProfBar')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.profile-tab__edit');
    const tab     = e.target.closest('.profile-tab');
    if (editBtn) {
      const pid = tab?.dataset.pid;
      if (pid) _openProfileEditPrompt(pid);
      return;
    }
    if (tab) switchMusicProfile(tab.dataset.pid);
  });
  document.getElementById('btnAddMusicProfile')?.addEventListener('click', () => _openProfileEditPrompt(null));

  document.getElementById('btnMusicAdd')?.addEventListener('click', () => document.getElementById('musicFile')?.click());
  document.getElementById('musicFile')?.addEventListener('change', function () {
    if (this.files?.length) addMusicFiles(this.files);
    this.value = '';
  });
  document.getElementById('btnMusicExportProfile')?.addEventListener('click', () => {
    if (APP.music.activeProfileId) exportMusicProfile(APP.music.activeProfileId);
  });

  document.getElementById('btnMusicPrev')?.addEventListener('click', () => previousMusicTrack());
  document.getElementById('btnMusicNext')?.addEventListener('click', () => nextMusicTrack());
  document.getElementById('btnMusicPlayPause')?.addEventListener('click', () => {
    if (!APP.music.activeTrackId) return;
    const rec = _players?.[_activeSlot];
    if (rec && rec.trackId && !rec.audio.paused) pauseMusic();
    else if (rec && rec.trackId) resumeMusic();
    else playMusicTrack(APP.music.activeTrackId);
  });
  document.getElementById('btnMusicStop')?.addEventListener('click', () => stopMusic());
  document.getElementById('btnMusicRepeat')?.addEventListener('click', () => {
    const order = { off: 'all', all: 'one', one: 'off' };
    setMusicRepeatMode(order[APP.music.repeatMode] || 'off');
  });
  document.getElementById('btnMusicShuffle')?.addEventListener('click', () => toggleMusicShuffle());

  // Progress-Slider: Ziehen/Klick + Tastatur (ArrowLeft/Right/Home/End, Kap. 12)
  const seekEl = document.getElementById('musicSeek');
  seekEl?.addEventListener('input',  function () { seekMusic(parseFloat(this.value) || 0); });
  seekEl?.addEventListener('change', function () { seekMusic(parseFloat(this.value) || 0); });

  document.getElementById('musicMasterVol')?.addEventListener('input', function () {
    setMusicMasterVolume(parseFloat(this.value));
    const numEl = document.getElementById('musicMasterVolNum');
    if (numEl) numEl.value = Math.round(parseFloat(this.value) * 100);
  });
  document.getElementById('musicMasterVolNum')?.addEventListener('input', function () {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const val = pct / 100;
    setMusicMasterVolume(val);
    const slEl = document.getElementById('musicMasterVol');
    if (slEl) slEl.value = val;
  });

  document.getElementById('musicCrossfade')?.addEventListener('change', function () {
    setMusicCrossfade(parseFloat(this.value));
  });
  document.getElementById('musicAutoplay')?.addEventListener('change', function () {
    setMusicAutoplay(this.checked);
  });

  // Space = Play/Pause, ArrowLeft/Right = Seek — nur innerhalb der Musikansicht
  // und nie, wenn ein Eingabefeld fokussiert ist (Kap. 29: bestehende
  // Shortcut-Architektur nicht stören, keine globalen Shortcuts erzwingen).
  document.getElementById('musicBoard')?.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      document.getElementById('btnMusicPlayPause')?.click();
    }
  });

  const list = document.getElementById('musicList');
  if (list) {
    list.addEventListener('click', e => {
      const row = e.target.closest('.music-row'); if (!row) return;
      const id = row.dataset.id;
      const actEl = e.target.closest('[data-act]');
      if (!actEl) { playMusicTrack(id); return; } // Kap. 58: Klick auf Zeile selbst = abspielen, kein Popup
      const act = actEl.dataset.act;
      if      (act === 'play')   playMusicTrack(id);
      else if (act === 'up')     moveMusicTrack(id, -1);
      else if (act === 'down')   moveMusicTrack(id, +1);
      else if (act === 'edit')   _openTrackEditModal(id);
      else if (act === 'remove') { if (confirm('Diesen Musik-Track löschen?')) removeMusicTrack(id); }
    });
    list.addEventListener('input', e => {
      const row = e.target.closest('.music-row'); if (!row) return;
      const act = e.target.dataset.act;
      if (act === 'vol') {
        setMusicTrackVolume(row.dataset.id, parseFloat(e.target.value));
        const numEl = row.querySelector('[data-act="volnum"]');
        if (numEl) numEl.value = Math.round(parseFloat(e.target.value) * 100);
      } else if (act === 'volnum') {
        const pct = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
        e.target.value = pct;
        const val = pct / 100;
        setMusicTrackVolume(row.dataset.id, val);
        const slEl = row.querySelector('[data-act="vol"]');
        if (slEl) slEl.value = val;
      }
    });
    // Desktop Drag&Drop-Reorder — nur über den Griff (.music-row__handle)
    // ziehbar (Nutzer-Feedback: sonst löste Ziehen am Lautstärkeregler
    // versehentlich ein Verschieben der ganzen Zeile aus). Da draggable
    // nur noch auf dem Griff selbst gesetzt ist, kann der native
    // dragstart gar nicht mehr von Slider/Buttons ausgehen.
    list.addEventListener('dragstart', e => {
      const handle = e.target.closest('.music-row__handle'); if (!handle) return;
      const row = handle.closest('.music-row'); if (!row) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.id);
      e.dataTransfer.setDragImage(row, 12, 12);
      row.classList.add('is-dragging');
    });
    list.addEventListener('dragend', e => {
      e.target.closest('.music-row')?.classList.remove('is-dragging');
      list.querySelectorAll('.music-row.is-drag-over').forEach(x => x.classList.remove('is-drag-over'));
    });
    list.addEventListener('dragover', e => {
      const row = e.target.closest('.music-row'); if (!row) return;
      e.preventDefault();
      row.classList.add('is-drag-over');
    });
    list.addEventListener('dragleave', e => e.target.closest('.music-row')?.classList.remove('is-drag-over'));
    list.addEventListener('drop', e => {
      const row = e.target.closest('.music-row'); if (!row) return;
      e.preventDefault();
      row.classList.remove('is-drag-over');
      const srcId = e.dataTransfer.getData('text/plain');
      if (srcId && srcId !== row.dataset.id) reorderMusicTrack(srcId, row.dataset.id);
    });
  }

  renderMusicProfileTabs();
  renderMusicPanel();
  renderMusicPlayer();
}

// ─── EINFACHE PROMPT-BASIERTE PROFIL-BEARBEITUNG ──────────────
// Bewusst schlank gehalten (kein eigenes Modal-Markup nötig) — analog zum
// Umfang der Ambient-Szenen-Verwaltung, aber ohne zusätzliche HTML-Modals.
function _openProfileEditPrompt(id) {
  const existing = id ? APP.music.profiles.find(p => p.id === id) : null;
  const name = prompt('Name der Playlist:', existing?.name || 'Playlist');
  if (name === null) return;
  if (existing && !name.trim()) {
    if (confirm('Playlist ohne Namen löschen?')) deleteMusicProfile(id);
    return;
  }
  saveMusicProfile(id, name, existing?.icon || '🎵');
}

// Track-Edit-Modal wird von events.js bereitgestellt (Bootstrap-Modal-Markup
// lebt konsistent mit allen anderen Edit-Dialogen in index.html) und über
// dieses CustomEvent angestoßen — vermeidet einen zirkulären Import
// music.js ⇄ events.js.
function _openTrackEditModal(trackId) {
  document.dispatchEvent(new CustomEvent('music:editTrack', { detail: { id: trackId } }));
}
