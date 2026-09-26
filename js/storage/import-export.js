/**
 * storage/import-export.js — JSON-Export/Import-Feature (Vollexport +
 * Einzel-Export/-Import für Profile/Szenen/Playlists/einzelne Elemente/Presets)
 * Ausgelagert aus storage.js (Phase 2 der Refaktorierung).
 */

import { APP, CItems, CATracks, CMTracks } from '../core/state.js';
import { uid }                             from '../utils.js';
import { toast }                            from '../notifications.js';
import { idbGet, idbSet, audioKey, IDB_SENTINEL, isIdbRef } from '../db.js';
import { getPresetById, validatePresetShape, importSinglePresetData, importPresetCollectionData, migratePresetCategories } from '../presets.js';
import { mkProfile, mkAmbientProfile, mkMusicProfile } from './factories.js';
import { _normalizeAmbient, _normalizeMusic } from './normalization.js';
import { migrateEffects, migratePlaybackSettings, migrateProfileColors, runIdbMigrationIfNeeded } from './migration.js';
import { _saveRaw }                        from './persistence.js';

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

// ─── AUDIO-EFFEKT-PRESETS EXPORTIEREN (Kap. 12, 14) ───────────
// Gleiches Muster wie die übrigen Einzel-Exporte oben: kind + version +
// _downloadJson(). Einzelpreset ('fx_preset') und Preset-Sammlung
// ('fx_preset_collection') sind bewusst zwei unterschiedliche, jeweils
// klar versionierte kinds (Kap. 14) statt eines vermischten Formats.

export async function exportPreset(presetId) {
  const p = getPresetById(presetId);
  if (!p) { toast('Preset nicht gefunden', 'err'); return; }
  const data = { id: p.id, name: p.name, category: p.category, description: p.description || '', effects: JSON.parse(JSON.stringify(p.effects)) };
  _downloadJson({ kind: 'fx_preset', version: 1, preset: data }, `preset_${_slug(p.name)}.json`);
  toast('Preset exportiert ✓', 'ok');
}

export async function exportUserPresets() {
  const list = APP.userPresets || [];
  if (!list.length) { toast('Keine eigenen Presets vorhanden', 'err'); return; }
  const presets = list.map(p => ({ id: p.id, name: p.name, category: p.category, description: p.description || '', effects: JSON.parse(JSON.stringify(p.effects)) }));
  _downloadJson({ kind: 'fx_preset_collection', version: 1, presets }, 'presets_sammlung.json');
  toast(`${list.length} Preset(s) exportiert ✓`, 'ok');
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
  const newProfile = {
    id: uid(), name: (profileData.name || 'Profil') + ' (importiert)', icon: profileData.icon || '🎵',
    // Prompt 1/4: color/audioEffectPreset aus dem Bundle übernehmen (alte
    // Exports ohne diese Felder bekommen die neutralen Defaults).
    color: profileData.color || 'none', audioEffectPreset: profileData.audioEffectPreset ?? null,
    items
  };
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
  const newProfile = {
    id: uid(), name: (profileData.name || 'Ambient') + ' (importiert)', icon: profileData.icon || '🌫️',
    color: profileData.color || 'none', audioEffectPreset: profileData.audioEffectPreset ?? null,
    tracks
  };
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
    color: profileData.color || 'none', audioEffectPreset: profileData.audioEffectPreset ?? null,
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
          case 'fx_preset': {
            // Kap. 13: fehlende Pflichtfelder (kein effects-Objekt) -> Import
            // abbrechen und verständlich melden, statt fehlerhaft zu importieren.
            if (!validatePresetShape(d.preset)) { toast('Ungültiges Preset: Pflichtfelder fehlen', 'err'); return; }
            importSinglePresetData(d.preset);
            break;
          }
          case 'fx_preset_collection': {
            if (!Array.isArray(d.presets) || !d.presets.length) { toast('Keine gültigen Presets in der Datei gefunden', 'err'); return; }
            const imported = importPresetCollectionData(d.presets);
            if (!imported.length) { toast('Keine gültigen Presets in der Datei gefunden', 'err'); return; }
            break;
          }
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
      // Kap. 16 Rückwärtskompatibilität: alte Vollexporte kennen noch kein
      // userPresets-Feld — bestehende eigene Presets bleiben dabei erhalten
      // (nicht überschreiben, falls die importierte Datei welche enthält;
      // sonst unverändert lassen statt zu leeren).
      if (Array.isArray(d.userPresets)) APP.userPresets = d.userPresets;
      else if (!Array.isArray(APP.userPresets)) APP.userPresets = [];
      migratePresetCategories();
      migrateEffects();
      migratePlaybackSettings();
      migrateProfileColors();
      await runIdbMigrationIfNeeded();
      onSuccess();
    } catch(err) { console.error('[storage] import error:', err); toast('Import fehlgeschlagen', 'err'); }
  };
  r.readAsText(file);
}
