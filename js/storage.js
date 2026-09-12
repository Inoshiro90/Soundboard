/**
 * storage.js — Persistence (Stable Edition)
 * Fixes: decodeAudioSmart uses audioCache, migrateEffects complete for all phases
 */

import { APP, CItems, CATracks, CMTracks, STORAGE_KEY } from './state.js';
import { uid, bk }    from './utils.js';
import { toast }      from './notifications.js';
import { defaultEffects } from './audio.js';
import { getOrDecodeBuffer } from './audioCache.js';
import { openDB, idbSet, idbGet, idbDelete, migrateAudioToIdb, audioKey,
         IDB_SENTINEL, isIdbRef, isBase64Data } from './db.js';
import { hasAudioContext, actx } from './audio.js';

// ─── EFFECTS MIGRATION ───────────────────────────────────────

function migrateEffects() {
  const def   = defaultEffects();
  const clone = x => JSON.parse(JSON.stringify(x));

  APP.profiles.forEach(prof => {
    (prof.items || []).filter(x => x.type === 'sound').forEach(s => {
      if (!s.effects || typeof s.effects !== 'object') {
        s.effects = clone(def); return;
      }
      const fx = s.effects;
      // Phase 1
      if (!fx.lowpass)  fx.lowpass  = clone(def.lowpass);
      if (!fx.highpass) fx.highpass = clone(def.highpass);
      if (!fx.reverb)   fx.reverb   = clone(def.reverb);
      if (!fx.delay)    fx.delay    = clone(def.delay);
      if (fx.pan     == null) fx.pan     = 0;
      if (fx.enabled == null) fx.enabled = false;
      if (fx.preset  == null) fx.preset  = null;
      // Phase 2
      if (!fx.eq)         fx.eq         = clone(def.eq);
      if (!fx.compressor) fx.compressor = clone(def.compressor);
      if (!fx.limiter)    fx.limiter    = clone(def.limiter);
      if (!fx.distortion) fx.distortion = clone(def.distortion);
      // Phase 3
      if (!fx.pitchShift) fx.pitchShift = clone(def.pitchShift);
      if (!fx.irReverb)   fx.irReverb   = clone(def.irReverb);
      if (!fx.envelope)   fx.envelope   = clone(def.envelope);
      if (!fx.analyzer)   fx.analyzer   = clone(def.analyzer);
      if (!fx.eq10)       fx.eq10       = clone(def.eq10);
      if (!Array.isArray(fx.eq10.bands)) fx.eq10.bands = [0,0,0,0,0,0,0,0,0,0];
      while (fx.eq10.bands.length < 10)  fx.eq10.bands.push(0);
      // Phase 4
      if (!fx.spatial)   fx.spatial   = clone(def.spatial);
      if (!fx.noiseGate) fx.noiseGate = clone(def.noiseGate);
    });
  });
}

// ─── IDB MIGRATION ───────────────────────────────────────────

async function runIdbMigrationIfNeeded() {
  let needs = false;
  outer: for (const prof of APP.profiles) {
    for (const item of (prof.items || [])) {
      if (item.type !== 'sound') continue;
      for (const sl of (item.slots || [])) {
        if (sl && isBase64Data(sl.data)) { needs = true; break outer; }
      }
    }
  }
  if (!needs) {
    ambOuter: for (const ap of (APP.ambient?.profiles || [])) {
      for (const t of (ap.tracks || [])) {
        for (const f of (t.files || [])) {
          if (f && isBase64Data(f.data)) { needs = true; break ambOuter; }
        }
      }
    }
  }
  if (!needs) return;
  toast('Migriere Audio zu IndexedDB…');
  try {
    const count = await migrateAudioToIdb(APP.profiles);
    let ambCount = 0;
    for (const ap of (APP.ambient?.profiles || [])) {
      for (const t of (ap.tracks || [])) {
        for (const f of (t.files || [])) {
          if (f && isBase64Data(f.data)) {
            await idbSet(audioKey(f.id, 0), f.data);
            f.data = IDB_SENTINEL;
            ambCount++;
          }
        }
      }
    }
    _saveRaw();
    toast(`Migration abgeschlossen (${count + ambCount} Slots)`, 'ok');
  } catch(e) {
    console.error('[storage] IDB migration error:', e);
    toast('Migration fehlgeschlagen — Fallback aktiv', 'err');
  }
}

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
  if (typeof t.vol !== 'number')  t.vol  = 0.7;
  if (typeof t.loop !== 'boolean') t.loop = true;
  if (typeof t.fadeIn !== 'number')  t.fadeIn  = 2;
  if (typeof t.fadeOut !== 'number') t.fadeOut = 2;
  if (typeof t.intervalMode !== 'boolean') t.intervalMode = false;
  if (typeof t.intervalMin !== 'number') t.intervalMin = 10;
  if (typeof t.intervalMax !== 'number') t.intervalMax = 30;
  return t;
}

function _normalizeAmbient(raw) {
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
  return t;
}

function _normalizeMusic(raw) {
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

// ─── DECODE ALL AUDIO ────────────────────────────────────────
// BUGFIX: We do NOT call actx() here — no AudioContext before user gesture.
// Instead we store slot data refs so getOrDecodeBuffer() can be called on demand.

export async function decodeAllAudio() {
  // Intentionally lazy: only validate that slots have data.
  // Actual decode happens on first playback via getOrDecodeBuffer().
  // This prevents "AudioContext not allowed to start" errors.
  console.info('[storage] decodeAllAudio: lazy mode — buffers decoded on demand');
}

// ─── FACTORY ─────────────────────────────────────────────────

// Wie viele leere Kacheln bekommt ein neu angelegtes Profil als Startbestand?
// Früher aus maxCols*maxRows (10×10=100) berechnet; das Grid ist seit dem
// neuen Spalten-System (grid-system.css) breakpoint-gesteuert und hat kein
// festes Zeilenlimit mehr, daher ein fester, viewport-unabhängiger Wert.
export const STARTER_PLACEHOLDER_COUNT = 24;

export function mkProfile(name, icon) {
  return { id: uid(), name, icon: icon || '🎵', items: [] };
}

export function mkAmbientProfile(name, icon) {
  return { id: uid(), name: name || 'Ambient', icon: icon || '🌫️', tracks: [] };
}

export function mkMusicProfile(name, icon) {
  return { id: uid(), name: name || 'Musik', icon: icon || '🎵', tracks: [] };
}

export function mkSound(d, order) {
  return {
    type: 'sound', id: uid(), order: order ?? 0,
    name: d.name || 'SOUND', icon: d.icon || '🔊', color: d.color || 'none',
    tileColor: '', tileW: null, tileH: null,
    vol: 1, pitch: 1, loop: false, fade: false, random: false,
    hotkey: '', category: '', locked: false,
    slots: [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null }],
    curSlot: 0, effects: defaultEffects()
  };
}

export function mkMacro(d) {
  return {
    type: 'macro', id: uid(), order: d.order ?? 0,
    name: d.name || 'MAKRO', icon: d.icon || '🪄', color: d.color || 'none',
    tileColor: d.tileColor || '', tileW: null, tileH: null,
    hotkey: '', locked: false, steps: d.steps || [],
    repeat: d.repeat || 1, repeatDelay: d.repeatDelay || 500,
    playMode: d.playMode || 'parallel'
  };
}

export function mkPH(order) {
  return { type: 'placeholder', id: uid(), order: order ?? 0, locked: false };
}

export function initDefaults() {
  APP.profiles = [];
  const p = mkProfile('Standard', '🎵');
  const defs = [
    { name: 'BOOOM', icon: '💥', color: '#dd5b00' },
    { name: 'APPLAUS', icon: '👏', color: '#2a9d99' },
    { name: 'PFEIL',  icon: '🏹', color: '#0075de' },
    { name: 'FEUER',  icon: '🔥', color: '#dd5b00' },
    { name: 'WASSER', icon: '💧', color: '#0075de' }
  ];
  const total = STARTER_PLACEHOLDER_COUNT;
  for (let i = 0; i < total; i++) {
    p.items.push(i < defs.length ? mkSound(defs[i], i) : mkPH(i));
  }
  APP.profiles.push(p); APP.activeProfileId = p.id;

  const amb = mkAmbientProfile('Ambient', '🌫️');
  APP.ambient = { profiles: [amb], activeProfileId: amb.id, masterVol: 1.0 };
  const mus = mkMusicProfile('Musik', '🎵');
  APP.music = {
    profiles: [mus], activeProfileId: mus.id, masterVol: 1.0, activeTrackId: null,
    repeatMode: 'off', shuffle: false, crossfade: 2, autoplay: true
  };
  APP.viewMode = 'sound';
}

// ─── SAVE ────────────────────────────────────────────────────

export function _saveRaw() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      profiles:        APP.profiles,
      activeProfileId: APP.activeProfileId,
      globalSettings:  APP.globalSettings,
      ambient:         APP.ambient,
      // Spez. Kap. 32/67: nur serialisierbare, sinnvoll persistente Felder —
      // kein laufender AudioContext/AudioElement/Timer. isPlaying wird
      // bewusst NICHT gespeichert (Kap. 33: nach Reload nie automatisch
      // starten), nur welcher Track zuletzt aktiv war.
      music: {
        profiles:        APP.music.profiles,
        activeProfileId: APP.music.activeProfileId,
        masterVol:       APP.music.masterVol,
        activeTrackId:   APP.music.activeTrackId,
        repeatMode:      APP.music.repeatMode,
        shuffle:         APP.music.shuffle,
        crossfade:       APP.music.crossfade,
        autoplay:        APP.music.autoplay
      },
      viewMode:        APP.viewMode,
      _idbMigrated:    true
    }));
  } catch(e) { console.error('[storage] save error:', e); }
}

export function save() {
  try { _saveRaw(); toast('Gespeichert ✓', 'ok'); }
  catch(e) { toast('Speichern fehlgeschlagen', 'err'); }
}

// ─── LOAD ────────────────────────────────────────────────────

export async function load() {
  await openDB();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { initDefaults(); return; }
    const d = JSON.parse(raw);
    APP.profiles        = d.profiles || [];
    APP.activeProfileId = d.activeProfileId || null;
    APP.globalSettings  = { ...APP.globalSettings, ...(d.globalSettings || {}) };
    APP.ambient          = _normalizeAmbient(d.ambient);
    APP.music            = _normalizeMusic(d.music);
    APP.viewMode         = ['sound', 'ambient', 'music'].includes(d.viewMode) ? d.viewMode : 'sound';
    if (!APP.profiles.length) {
      initDefaults();
    } else {
      if (!APP.activeProfileId || !APP.profiles.find(p => p.id === APP.activeProfileId)) {
        APP.activeProfileId = APP.profiles[0].id;
      }
      migrateEffects();
      await runIdbMigrationIfNeeded();
      // BUGFIX: No decodeAllAudio() here — lazy decode on demand
    }
  } catch(e) {
    console.error('[storage] load error:', e); initDefaults();
  }
}

// ─── EXPORT / IMPORT ─────────────────────────────────────────

async function _resolveAmbientAudio(ambientClone) {
  for (const ap of (ambientClone?.profiles || [])) {
    for (const t of (ap.tracks || [])) {
      for (const f of (t.files || [])) {
        if (f && isIdbRef(f.data)) {
          try {
            const b64 = await idbGet(audioKey(f.id, 0));
            if (b64) f.data = b64;
          } catch (err) {
            console.warn('[storage] ambient export: IDB read failed for', f.id, err);
          }
        }
      }
    }
  }
}

async function _resolveMusicAudio(musicClone) {
  for (const mp of (musicClone?.profiles || [])) {
    for (const t of (mp.tracks || [])) {
      if (t && isIdbRef(t.data)) {
        try {
          const b64 = await idbGet(audioKey(t.id, 0));
          if (b64) t.data = b64;
        } catch (err) {
          console.warn('[storage] music export: IDB read failed for', t.id, err);
        }
      }
    }
  }
}

export async function exportData() {
  toast('Bereite Export vor…');
  const clone   = JSON.parse(JSON.stringify(APP.profiles));
  const ambient = JSON.parse(JSON.stringify(APP.ambient || { profiles: [] }));
  const music   = JSON.parse(JSON.stringify(APP.music   || { profiles: [] }));
  for (const prof of clone) {
    for (const item of (prof.items || [])) {
      if (item.type !== 'sound') continue;
      for (let i = 0; i < (item.slots || []).length; i++) {
        const sl = item.slots[i];
        if (sl && isIdbRef(sl.data)) {
          try {
            const b64 = await idbGet(audioKey(item.id, i));
            if (b64) sl.data = b64;
          } catch (err) {
            console.warn('[storage] exportData: IDB read failed for', item.id, i, err);
          }
        }
      }
    }
  }
  await _resolveAmbientAudio(ambient);
  await _resolveMusicAudio(music);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(
    [JSON.stringify({ profiles: clone, activeProfileId: APP.activeProfileId, globalSettings: APP.globalSettings, ambient, music }, null, 2)],
    { type: 'application/json' }
  ));
  a.download = 'soundboard_pro.json'; a.click();
  toast('Export ✓', 'ok');
}

export async function exportDataWithAudio() {
  toast('Bereite vollständigen Export vor…');
  const clone   = JSON.parse(JSON.stringify(APP.profiles));
  const ambient = JSON.parse(JSON.stringify(APP.ambient || { profiles: [] }));
  const music   = JSON.parse(JSON.stringify(APP.music   || { profiles: [] }));
  for (const prof of clone) {
    for (const item of (prof.items || [])) {
      if (item.type !== 'sound') continue;
      for (let i = 0; i < (item.slots || []).length; i++) {
        const sl = item.slots[i];
        if (sl && isIdbRef(sl.data)) {
          const b64 = await idbGet(audioKey(item.id, i));
          if (b64) sl.data = b64;
        }
      }
    }
  }
  await _resolveAmbientAudio(ambient);
  await _resolveMusicAudio(music);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(
    [JSON.stringify({ profiles: clone, activeProfileId: APP.activeProfileId, globalSettings: APP.globalSettings, ambient, music }, null, 2)],
    { type: 'application/json' }
  ));
  a.download = 'soundboard_pro_full.json'; a.click();
  toast('Vollständiger Export ✓', 'ok');
}

// ═══════════════════════════════════════════════════════════════
// EINZEL-EXPORT / -IMPORT: PROFILE, SZENEN, PLAYLISTS UND EINZELNE
// SOUNDEFFEKTE / AMBIENT-TRACKS / MUSIKSTÜCKE
//
// Jede Export-Datei trägt ein "kind"-Feld, über das importData() den
// richtigen Import-Pfad automatisch erkennt — dieselbe "Import"-Schaltfläche
// im Einstellungen-Popover funktioniert also für JEDE Export-Art, ohne
// eigene UI dafür zu benötigen. Bestehende Exporte ohne "kind" (voller
// Datensatz) bleiben unverändert importierbar (Rückwärtskompatibilität).
// ═══════════════════════════════════════════════════════════════

function _slug(s) {
  return (String(s || 'export').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)) || 'export';
}

function _downloadJson(obj, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function _resolveSoundProfileAudio(profileClone) {
  for (const item of (profileClone.items || [])) {
    if (item.type !== 'sound') continue;
    for (let i = 0; i < (item.slots || []).length; i++) {
      const sl = item.slots[i];
      if (sl && isIdbRef(sl.data)) {
        try {
          const b64 = await idbGet(audioKey(item.id, i));
          if (b64) sl.data = b64;
        } catch (err) { console.warn('[storage] profile export: IDB read failed for', item.id, i, err); }
      }
    }
  }
}

// ─── PROFIL / SZENE / PLAYLIST EXPORTIEREN ───────────────────────

export async function exportProfile(profileId) {
  const p = APP.profiles.find(x => x.id === profileId);
  if (!p) { toast('Profil nicht gefunden', 'err'); return; }
  toast('Bereite Profil-Export vor…');
  const clone = JSON.parse(JSON.stringify(p));
  await _resolveSoundProfileAudio(clone);
  _downloadJson({ kind: 'soundboard_profile', version: 1, profile: clone }, `profil_${_slug(p.name)}.json`);
  toast('Profil exportiert ✓', 'ok');
}

export async function exportAmbientProfile(profileId) {
  const p = APP.ambient.profiles.find(x => x.id === profileId);
  if (!p) { toast('Szene nicht gefunden', 'err'); return; }
  toast('Bereite Szenen-Export vor…');
  const clone = JSON.parse(JSON.stringify(p));
  await _resolveAmbientAudio({ profiles: [clone] });
  _downloadJson({ kind: 'ambient_profile', version: 1, profile: clone }, `szene_${_slug(p.name)}.json`);
  toast('Szene exportiert ✓', 'ok');
}

export async function exportMusicProfile(profileId) {
  const p = APP.music.profiles.find(x => x.id === profileId);
  if (!p) { toast('Playlist nicht gefunden', 'err'); return; }
  toast('Bereite Playlist-Export vor…');
  const clone = JSON.parse(JSON.stringify(p));
  await _resolveMusicAudio({ profiles: [clone] });
  _downloadJson({ kind: 'music_profile', version: 1, profile: clone }, `playlist_${_slug(p.name)}.json`);
  toast('Playlist exportiert ✓', 'ok');
}

// ─── EINZELNES ELEMENT EXPORTIEREN ────────────────────────────────

export async function exportSoundItem(itemId) {
  let item = null;
  for (const p of APP.profiles) {
    const f = (p.items || []).find(x => x.id === itemId && x.type === 'sound');
    if (f) { item = f; break; }
  }
  if (!item) { toast('Sound nicht gefunden', 'err'); return; }
  toast('Bereite Sound-Export vor…');
  const clone = JSON.parse(JSON.stringify(item));
  for (let i = 0; i < (clone.slots || []).length; i++) {
    const sl = clone.slots[i];
    if (sl && isIdbRef(sl.data)) {
      const b64 = await idbGet(audioKey(item.id, i));
      if (b64) sl.data = b64;
    }
  }
  _downloadJson({ kind: 'sound_item', version: 1, item: clone }, `sound_${_slug(item.name)}.json`);
  toast('Sound exportiert ✓', 'ok');
}

export async function exportAmbientTrack(trackId) {
  let track = null;
  for (const p of APP.ambient.profiles) {
    const f = (p.tracks || []).find(x => x.id === trackId);
    if (f) { track = f; break; }
  }
  if (!track) { toast('Ambient-Sound nicht gefunden', 'err'); return; }
  toast('Bereite Ambient-Sound-Export vor…');
  const clone = JSON.parse(JSON.stringify(track));
  for (const f of (clone.files || [])) {
    if (f && isIdbRef(f.data)) {
      try {
        const b64 = await idbGet(audioKey(f.id, 0));
        if (b64) f.data = b64;
      } catch (err) { console.warn('[storage] ambient track export: IDB read failed for', f.id, err); }
    }
  }
  _downloadJson({ kind: 'ambient_track', version: 1, track: clone }, `ambient_${_slug(track.name)}.json`);
  toast('Ambient-Sound exportiert ✓', 'ok');
}

export async function exportMusicTrack(trackId) {
  let track = null;
  for (const p of APP.music.profiles) {
    const f = (p.tracks || []).find(x => x.id === trackId);
    if (f) { track = f; break; }
  }
  if (!track) { toast('Musikstück nicht gefunden', 'err'); return; }
  toast('Bereite Musik-Export vor…');
  const clone = JSON.parse(JSON.stringify(track));
  if (isIdbRef(clone.data)) {
    try {
      const b64 = await idbGet(audioKey(track.id, 0));
      if (b64) clone.data = b64;
    } catch (err) { console.warn('[storage] music track export: IDB read failed for', track.id, err); }
  }
  _downloadJson({ kind: 'music_track', version: 1, track: clone }, `musik_${_slug(track.name)}.json`);
  toast('Musikstück exportiert ✓', 'ok');
}

// ─── IMPORT-HANDLER (aufgerufen von importData() anhand von d.kind) ────
// Jeder Handler vergibt frische uid()s für Profil/Track/Item UND alle
// darin enthaltenen Audio-Referenzen — verhindert ID-Kollisionen, falls
// dieselbe Datei zweimal importiert wird oder Ids zufällig mit bereits
// vorhandenen Daten kollidieren. Makro-Steps (die per targetId auf
// Geschwister-Items verweisen) werden dabei korrekt mitübersetzt.

async function _importProfileBundle(profileData) {
  const idMap = new Map();
  const items = (profileData.items || [])
    .filter(it => it.type === 'sound' || it.type === 'macro') // leere Platzhalter bringen nichts
    .map(orig => {
      const clone = JSON.parse(JSON.stringify(orig));
      const newId = uid();
      idMap.set(orig.id, newId);
      clone.id = newId;
      return clone;
    });
  for (const it of items) {
    if (it.type === 'macro') {
      for (const step of (it.steps || [])) {
        if (step && step.targetId && idMap.has(step.targetId)) step.targetId = idMap.get(step.targetId);
      }
    }
  }
  for (const it of items) {
    if (it.type !== 'sound') continue;
    for (let i = 0; i < (it.slots || []).length; i++) {
      const sl = it.slots[i];
      if (sl && sl.data && !isIdbRef(sl.data)) {
        await idbSet(audioKey(it.id, i), sl.data);
        sl.data = IDB_SENTINEL;
      }
    }
  }
  const newProfile = { id: uid(), name: (profileData.name || 'Profil') + ' (importiert)', icon: profileData.icon || '🎵', items };
  APP.profiles.push(newProfile);
  APP.activeProfileId = newProfile.id;
  return newProfile;
}

async function _importAmbientProfileBundle(profileData) {
  const tracks = (profileData.tracks || []).map(origTrack => {
    const clone = JSON.parse(JSON.stringify(origTrack));
    clone.id = uid();
    clone.files = (clone.files || []).map(f => ({ ...f, id: uid() }));
    return clone;
  });
  for (const t of tracks) {
    for (const f of (t.files || [])) {
      if (f && f.data && !isIdbRef(f.data)) {
        await idbSet(audioKey(f.id, 0), f.data);
        f.data = IDB_SENTINEL;
      }
    }
  }
  const newProfile = { id: uid(), name: (profileData.name || 'Ambient') + ' (importiert)', icon: profileData.icon || '🌫️', tracks };
  APP.ambient.profiles.push(newProfile);
  APP.ambient.activeProfileId = newProfile.id;
  return newProfile;
}

async function _importMusicProfileBundle(profileData) {
  const tracks = (profileData.tracks || []).map((orig, i) => {
    const clone = JSON.parse(JSON.stringify(orig));
    clone.id = uid();
    clone.order = i;
    return clone;
  });
  for (const t of tracks) {
    if (t.data && !isIdbRef(t.data)) {
      await idbSet(audioKey(t.id, 0), t.data);
      t.data = IDB_SENTINEL;
    }
  }
  const newProfile = {
    id: uid(), name: (profileData.name || 'Playlist') + ' (importiert)', icon: profileData.icon || '🎵',
    tracks, manualOrder: !!profileData.manualOrder
  };
  APP.music.profiles.push(newProfile);
  APP.music.activeProfileId = newProfile.id;
  return newProfile;
}

async function _importSoundItemBundle(itemData) {
  ensureActiveSoundProfile();
  const clone = JSON.parse(JSON.stringify(itemData));
  const newId = uid();
  clone.id = newId;
  const items = CItems();
  clone.order = items.length ? Math.max(...items.map(x => x.order || 0)) + 1 : 0;
  for (let i = 0; i < (clone.slots || []).length; i++) {
    const sl = clone.slots[i];
    if (sl && sl.data && !isIdbRef(sl.data)) {
      await idbSet(audioKey(newId, i), sl.data);
      sl.data = IDB_SENTINEL;
    }
  }
  items.push(clone);
  return clone;
}

async function _importAmbientTrackBundle(trackData) {
  if (!APP.ambient.profiles.length) APP.ambient.profiles.push(mkAmbientProfile('Ambient', '🌫️'));
  if (!APP.ambient.activeProfileId) APP.ambient.activeProfileId = APP.ambient.profiles[0].id;
  const clone = JSON.parse(JSON.stringify(trackData));
  clone.id = uid();
  clone.files = (clone.files || []).map(f => ({ ...f, id: uid() }));
  for (const f of (clone.files || [])) {
    if (f && f.data && !isIdbRef(f.data)) {
      await idbSet(audioKey(f.id, 0), f.data);
      f.data = IDB_SENTINEL;
    }
  }
  CATracks().push(clone);
  return clone;
}

async function _importMusicTrackBundle(trackData) {
  if (!APP.music.profiles.length) APP.music.profiles.push(mkMusicProfile('Musik', '🎵'));
  if (!APP.music.activeProfileId) APP.music.activeProfileId = APP.music.profiles[0].id;
  const clone = JSON.parse(JSON.stringify(trackData));
  clone.id = uid();
  const tracks = CMTracks();
  clone.order = tracks.length ? Math.max(...tracks.map(x => x.order || 0)) + 1 : 0;
  if (clone.data && !isIdbRef(clone.data)) {
    await idbSet(audioKey(clone.id, 0), clone.data);
    clone.data = IDB_SENTINEL;
  }
  tracks.push(clone);
  return clone;
}

function ensureActiveSoundProfile() {
  if (!APP.profiles.length) { const p = mkProfile('Standard', '🎵'); APP.profiles.push(p); APP.activeProfileId = p.id; }
  if (!APP.activeProfileId || !APP.profiles.find(p => p.id === APP.activeProfileId)) {
    APP.activeProfileId = APP.profiles[0].id;
  }
}

export async function importData(file, { onSuccess }) {
  const r = new FileReader();
  r.onload = async e => {
    try {
      const d = JSON.parse(e.target.result);

      // Einzel-Import (Profil/Szene/Playlist/einzelnes Element) — erkannt
      // am "kind"-Feld, das nur unsere neuen Teilexporte tragen. Alte
      // Vollexporte haben kein "kind" und fallen unten in den bestehenden
      // Pfad (Rückwärtskompatibilität, Spez. Kap. 34).
      if (d && d.kind) {
        switch (d.kind) {
          case 'soundboard_profile': await _importProfileBundle(d.profile); break;
          case 'ambient_profile':    await _importAmbientProfileBundle(d.profile); break;
          case 'music_profile':      await _importMusicProfileBundle(d.profile); break;
          case 'sound_item':         await _importSoundItemBundle(d.item); break;
          case 'ambient_track':      await _importAmbientTrackBundle(d.track); break;
          case 'music_track':        await _importMusicTrackBundle(d.track); break;
          default: toast('Unbekannter Import-Typ', 'err'); return;
        }
        await runIdbMigrationIfNeeded();
        _saveRaw();
        onSuccess();
        return;
      }

      APP.profiles        = d.profiles        || [];
      APP.activeProfileId = d.activeProfileId || APP.profiles[0]?.id;
      APP.globalSettings  = { ...APP.globalSettings, ...(d.globalSettings || {}) };
      APP.ambient          = _normalizeAmbient(d.ambient);
      // Spez. Kap. 34: bestehender Export ohne Musik (d.music === undefined)
      // muss weiterhin problemlos importierbar sein — _normalizeMusic()
      // liefert dafür eine valide Default-Struktur.
      APP.music            = _normalizeMusic(d.music);
      migrateEffects();
      await runIdbMigrationIfNeeded();
      onSuccess();
    } catch(err) { console.error('[storage] import error:', err); toast('Import fehlgeschlagen', 'err'); }
  };
  r.readAsText(file);
}

export async function saveSlotAudio(soundId, slotIdx, base64, slot) {
  const key = audioKey(soundId, slotIdx);
  await idbSet(key, base64);
  if (slot) slot.data = IDB_SENTINEL;
}

export async function resetAll({ onDone }) {
  if (!confirm('Alles zurücksetzen?')) return;
  // Spez. Kap. 35: zugehörige IndexedDB-Musikdateien gezielt löschen —
  // Sound-/Ambient-Blobs bleiben davon unberührt (bestehendes Verhalten).
  try {
    for (const mp of (APP.music?.profiles || [])) {
      for (const t of (mp.tracks || [])) {
        await idbDelete(audioKey(t.id, 0));
      }
    }
  } catch (e) { console.warn('[storage] reset: music IDB cleanup failed:', e); }
  localStorage.removeItem(STORAGE_KEY);
  APP.profiles = []; initDefaults(); onDone(); toast('Zurückgesetzt');
}
