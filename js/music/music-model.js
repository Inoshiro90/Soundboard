/**
 * music/music-model.js — Playlist-/Track-Datenmodell (CRUD)
 */

import { APP, CMP, CMTracks } from '../core/state.js';
import { uid } from '../utils.js';
import { toast } from '../notifications.js';
import { defaultEffects } from '../audio/effect-graph.js';
import { idbSet, idbDelete, audioKey, IDB_SENTINEL } from '../db.js';
import { _saveRaw } from '../storage/persistence.js';
// Zirkulärer Import (music-playback.js importiert umgekehrt ensureMusicState/
// _findTrack/_persist aus diesem Modul) — unkritisch, s. Kommentar in
// music-playback.js.
import { stopMusic, _revokeBlobUrl, _orderedTracks, _blobUrls, _resetShuffleOrder, _players, _crossfading } from './music-playback.js';
import { renderMusicProfileTabs, renderMusicPanel, renderMusicPlayer } from './music-render.js';

// ─── CONSTANTS ───────────────────────────────────────────────

const MUSIC_ICONS = ['🎵','⚔️','🏰','🌲','🍺','🐉','👑','🔥','🌙','⚡','🎻','🥁'];


// ─── STATE HELPERS ───────────────────────────────────────────

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

// Exportiert: music-playback.js benötigt _persist() (viele Stellen)
// und _findTrack() (mehrere Stellen); music-render.js benötigt _findTrack().
export function _persist() { try { _saveRaw(); } catch (e) { console.warn('[music] persist failed:', e); } }
/** Öffentlicher Persist-Wrapper, analog zu persistAmbientNow()
 *  in ambient/ambient-model.js — für Bulk-Änderungen von außerhalb dieses Moduls
 *  (z.B. applyPresetToCollection() auf alle Tracks einer Playlist). */
export function persistMusicNow() { _persist(); }

export function _findTrack(trackId) {
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
    trimStart: 0, trimEnd: null,
    // Vollständiges Effekt-Modell analog zu Sound/Ambient —
    // dieselbe defaultEffects()-Fabrik, kein eigenes Musik-Effektmodell.
    effects: defaultEffects()
  };
}


// ─── PROFILE (PLAYLIST) CRUD ─────────────────────────────────

export function saveMusicProfile(id, name, icon, color, audioEffectPreset) {
  ensureMusicState();
  const cleanName  = (name || '').trim() || 'Playlist';
  const cleanIcon  = (icon || '').trim() || '🎵';
  const cleanColor = color || 'none';
  if (id) {
    const p = APP.music.profiles.find(x => x.id === id);
    if (p) {
      p.name = cleanName; p.icon = cleanIcon; p.color = cleanColor;
      // Übergeordnetes Preset wird bei jedem Speichern
      // mitgesichert (undefined = Aufrufer hat es nicht übergeben → Feld
      // unangetastet lassen, statt es stillschweigend auf null zu setzen).
      if (audioEffectPreset !== undefined) p.audioEffectPreset = audioEffectPreset;
    }
  } else {
    const np = { id: uid(), name: cleanName, icon: cleanIcon, color: cleanColor, audioEffectPreset: audioEffectPreset ?? null, tracks: [], manualOrder: false };
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
  // liegt (Ansichten/Listen sind keine Audiomodi).
  APP.music.activeProfileId = id;
  _resetShuffleOrder();
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

/**
 * Weist einem Musik-Track ein vollständiges,
 * normalisiertes Effekt-Objekt zu (aus applyPresetEffects() erzeugt, s.
 * events/register-tile-events.js) — niemals ein Merge in ein bestehendes Objekt. Wirkt beim
 * nächsten Laden des Tracks in einen Player-Slot (_loadIntoSlot() →
 * _reconnectSlotFx()); ein bereits laufender Track wird dadurch nicht
 * unterbrochen (gleiche Zurückhaltung wie bei Icon/Farbe/Name-Edits).
 */
export function setMusicTrackEffects(trackId, effects) {
  const t = _findTrack(trackId); if (!t) return;
  t.effects = effects || defaultEffects();
  _persist();
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
    // Sinnvollen nächsten Track bestimmen, sonst stoppen (bereits
    // durch stopMusic() geschehen — activeTrackId bleibt hier bewusst leer,
    // kein automatischer Weiterlauf auf einen ggf. unerwarteten Track).
    APP.music.activeTrackId = null;
  }
  _resetShuffleOrder();
  _persist();
  renderMusicPanel();
  renderMusicPlayer();
}

/** Manuelle Umsortierung (Drag&Drop oder ↑/↓-Buttons) — schaltet ab hier
 *  dauerhaft auf .order statt alphabetischer Sortierung. */
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


// ─── RESET ───────────────────────────────────────────────

export function resetMusic() {
  stopMusic();
  _blobUrls.forEach(url => URL.revokeObjectURL(url));
  _blobUrls.clear();
  _resetShuffleOrder();
  const p = { id: uid(), name: 'Musik', icon: '🎵', tracks: [], manualOrder: false };
  APP.music = {
    profiles: [p], activeProfileId: p.id, masterVol: 1, activeTrackId: null,
    repeatMode: 'off', shuffle: false, crossfade: 2, autoplay: true
  };
  renderMusicProfileTabs();
  renderMusicPanel();
  renderMusicPlayer();
}

