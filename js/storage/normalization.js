/**
 * storage/normalization.js — Normalisierung von Ambient-/Musik-Datenstrukturen
 * Ausgelagert aus storage.js (Phase 2 der Refaktorierung).
 * Akzeptiert fehlende/unvollständige/veraltete Rohdaten (z.B. beim Laden aus
 * localStorage oder Import) und liefert immer eine vollständige, valide Struktur.
 */

import { uid }                     from '../utils.js';
import { defaultEffects }          from '../audio/effect-graph.js';
import { mkAmbientProfile, mkMusicProfile } from './factories.js';

// ─── AMBIENT NORMALISATION ────────────────────────────────────
// Accepts either the current scene-profile shape ({ profiles:[{tracks}] })
// or the legacy flat shape from an earlier version ({ tracks:[...] }) and
// always returns a valid, non-empty scene-profile structure. Also migrates
// each track from the old single-file shape ({ data, fileName }) to the
// current multi-variant shape ({ files:[{id,data,fileName}], variantMode }).
function _normalizeAmbientTrack(t) {
  if (!t.id) t.id = uid();
  if (!Array.isArray(t.files)) {
    // Legacy single-file track → one variant, reusing the track's own id so
    // its existing IndexedDB blob (stored under `${trackId}:0`) still resolves.
    t.files = [{ id: t.id, data: (t.data !== undefined ? t.data : null), fileName: t.fileName || '' }];
  }
  delete t.data;
  delete t.fileName;
  t.files.forEach(f => {
    if (!f.id) f.id = uid();
    if (f.data === undefined) f.data = null;
    if (typeof f.fileName !== 'string') f.fileName = '';
    if (typeof f.trimStart !== 'number') f.trimStart = 0;
    if (f.trimEnd === undefined) f.trimEnd = null;
  });
  if (t.variantMode !== 'random' && t.variantMode !== 'rotate') t.variantMode = 'random';
  if (!t.name) t.name = 'Ambient';
  if (!t.icon) t.icon = '🌫️';
  // Prompt 1, Kap. 6: Akzentfarbe für Ambient-Tracks — bestehende Tracks
  // ohne dieses Feld erhalten automatisch 'none' (keine Akzentfarbe).
  if (!t.color) t.color = 'none';
  if (typeof t.vol !== 'number')  t.vol  = 0.7;
  if (typeof t.loop !== 'boolean') t.loop = true;
  if (typeof t.fadeIn !== 'number')  t.fadeIn  = 2;
  if (typeof t.fadeOut !== 'number') t.fadeOut = 2;
  if (typeof t.intervalMode !== 'boolean') t.intervalMode = false;
  if (typeof t.intervalMin !== 'number') t.intervalMin = 10;
  if (typeof t.intervalMax !== 'number') t.intervalMax = 30;
  // Prompt 2, Kap. 17/21/23: neue, defensiv nachgerüstete Felder — bestehende
  // Ambient-Tracks ohne diese Felder erhalten die gleichen Defaults wie
  // _mkTrack() (neue Tracks), ohne vorhandene Werte zu überschreiben.
  if (t.fadeInCurve !== 'linear' && t.fadeInCurve !== 'exponential' && t.fadeInCurve !== 'sCurve') t.fadeInCurve = 'linear';
  if (t.fadeOutCurve !== 'linear' && t.fadeOutCurve !== 'exponential' && t.fadeOutCurve !== 'sCurve') t.fadeOutCurve = 'linear';
  if (!t.crossfade || typeof t.crossfade !== 'object') {
    t.crossfade = { enabled: false, duration: 1, curve: 'linear' };
  } else {
    if (typeof t.crossfade.enabled !== 'boolean') t.crossfade.enabled = false;
    if (typeof t.crossfade.duration !== 'number') t.crossfade.duration = 1;
    if (!t.crossfade.curve) t.crossfade.curve = 'linear';
  }
  return t;
}

export function _normalizeAmbient(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  let profiles = Array.isArray(a.profiles) ? a.profiles : null;

  if (!profiles && Array.isArray(a.tracks)) {
    // Legacy single-list format → wrap into one default scene
    profiles = [{ id: uid(), name: 'Ambient', icon: '🌫️', tracks: a.tracks }];
  }
  if (!profiles || !profiles.length) {
    profiles = [mkAmbientProfile('Ambient', '🌫️')];
  }
  profiles.forEach(p => {
    if (!p.id)   p.id   = uid();
    if (!p.name) p.name = 'Ambient';
    if (!p.icon) p.icon = '🌫️';
    // Prompt 1, Kap. 5/6: Szene-Akzentfarbe — rückwärtskompatibel ergänzt.
    if (!p.color) p.color = 'none';
    // Prompt 4, Kap. 1: übergeordnetes Audio-Effekt-Preset der Szene.
    if (p.audioEffectPreset === undefined) p.audioEffectPreset = null;
    if (!Array.isArray(p.tracks)) p.tracks = [];
    p.tracks = p.tracks.map(_normalizeAmbientTrack);
  });

  let activeProfileId = a.activeProfileId;
  if (!activeProfileId || !profiles.find(p => p.id === activeProfileId)) {
    activeProfileId = profiles[0].id;
  }
  return {
    profiles,
    activeProfileId,
    masterVol: typeof a.masterVol === 'number' ? a.masterVol : 1.0
  };
}

// ─── MUSIC NORMALISATION ───────────────────────────────────────
// Analog zu _normalizeAmbient — akzeptiert fehlenden/unvollständigen
// APP.music (Migration Kap. 66: bestehende Nutzer haben noch kein
// APP.music) und liefert immer eine vollständige, valide Struktur.
function _normalizeMusicTrack(t) {
  if (!t.id) t.id = uid();
  if (typeof t.name   !== 'string') t.name   = 'Track';
  if (typeof t.artist !== 'string') t.artist = '';
  if (typeof t.album  !== 'string') t.album  = '';
  if (!t.icon)  t.icon  = '🎵';
  if (!t.color) t.color = 'none';
  if (t.data === undefined)          t.data     = null;
  if (typeof t.fileName !== 'string') t.fileName = '';
  if (typeof t.duration !== 'number' || !isFinite(t.duration)) t.duration = 0;
  if (typeof t.vol      !== 'number') t.vol      = 1;
  if (typeof t.order    !== 'number') t.order    = 0;
  if (typeof t.trimStart !== 'number') t.trimStart = 0;
  if (t.trimEnd === undefined) t.trimEnd = null;
  // Prompt 3, Kap. 5: bestehende Musik-Tracks ohne vollständiges
  // Effekt-Objekt bekommen es rückwärtskompatibel ergänzt (dieselbe
  // defaultEffects()-Fabrik wie Sound/Ambient — kein eigenes Modell,
  // keine destruktive Migration bereits vorhandener Effekte).
  if (!t.effects || typeof t.effects !== 'object') t.effects = defaultEffects();
  return t;
}

export function _normalizeMusic(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  let profiles = Array.isArray(a.profiles) ? a.profiles : [];
  if (!profiles.length) {
    // Spez. Kap. 53: leeres Standardprofil beim ersten Start, ohne Demo-Datei.
    profiles = [mkMusicProfile('Musik', '🎵')];
  }
  profiles.forEach(p => {
    if (!p.id)   p.id   = uid();
    if (!p.name) p.name = 'Musik';
    if (!p.icon) p.icon = '🎵';
    // Prompt 1, Kap. 5: Playlist-Akzentfarbe — rückwärtskompatibel ergänzt.
    if (!p.color) p.color = 'none';
    // Prompt 4, Kap. 1: übergeordnetes Audio-Effekt-Preset der Playlist.
    if (p.audioEffectPreset === undefined) p.audioEffectPreset = null;
    if (!Array.isArray(p.tracks)) p.tracks = [];
    p.tracks = p.tracks.map(_normalizeMusicTrack);
    // Spez. Kap. 54: klares Modell statt widersprüchlicher Kombination —
    // solange KEINE bewusste manuelle Reihenfolge existiert, wird
    // alphabetisch sortiert angezeigt; erst nach der ersten manuellen
    // Umsortierung (siehe music.js: reorderMusicTrack) zählt .order.
    if (typeof p.manualOrder !== 'boolean') p.manualOrder = false;
  });

  let activeProfileId = a.activeProfileId;
  if (!activeProfileId || !profiles.find(p => p.id === activeProfileId)) {
    activeProfileId = profiles[0].id;
  }

  const allTrackIds = profiles.flatMap(p => p.tracks.map(t => t.id));
  const activeTrackId = allTrackIds.includes(a.activeTrackId) ? a.activeTrackId : null;

  return {
    profiles,
    activeProfileId,
    masterVol:     typeof a.masterVol === 'number' ? a.masterVol : 1.0,
    activeTrackId,
    repeatMode:    ['off', 'all', 'one'].includes(a.repeatMode) ? a.repeatMode : 'off',
    shuffle:       !!a.shuffle,
    crossfade:     typeof a.crossfade === 'number' ? a.crossfade : 2,
    autoplay:      typeof a.autoplay === 'boolean' ? a.autoplay : true
  };
}
