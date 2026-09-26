/**
 * storage/persistence.js — Kern-Persistenz (Laden/Speichern)
 * Ausgelagert aus storage.js (Phase 2 der Refaktorierung). Bleibt die zentrale
 * Fassade für _saveRaw()/save()/load(): viele Module projektweit rufen diese
 * Funktionen unter unverändertem Namen und unveränderter Signatur auf.
 */

import { APP }              from '../core/state.js';
import { STORAGE_KEY }      from '../core/constants.js';
import { toast }            from '../notifications.js';
import { hasAudioContext, actx } from '../audio/context.js';
import { openDB, idbDelete, audioKey, idbSet, IDB_SENTINEL } from '../db.js';
import { _normalizeAmbient, _normalizeMusic } from './normalization.js';
import { migratePresetCategories } from '../presets.js';
import { initDefaults }     from './factories.js';
// Zirkulärer Import, s. Kommentar in migration.js.
import { migrateEffects, migratePlaybackSettings, migrateProfileColors, runIdbMigrationIfNeeded } from './migration.js';

// ─── DECODE ALL AUDIO ────────────────────────────────────────
// BUGFIX: We do NOT call actx() here — no AudioContext before user gesture.
// Instead we store slot data refs so getOrDecodeBuffer() can be called on demand.

export async function decodeAllAudio() {
  // Intentionally lazy: only validate that slots have data.
  // Actual decode happens on first playback via getOrDecodeBuffer().
  // This prevents "AudioContext not allowed to start" errors.
  console.info('[storage] decodeAllAudio: lazy mode — buffers decoded on demand');
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
      // Eigene Audio-Effekt-Presets (js/presets.js) — reine Metadaten +
      // Effektparameter, kein Audio, daher unproblematisch für localStorage.
      userPresets:     APP.userPresets || [],
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
    // Rückwärtskompatibel: ältere gespeicherte Zustände haben kein
    // userPresets-Feld — Default leeres Array (Kap. 15/16).
    APP.userPresets      = Array.isArray(d.userPresets) ? d.userPresets : [];
    // Kap. 16: Kategorie-Schema kann sich zwischen Versionen ändern
    // (z.B. altes 3er- auf neues 6er-Schema) — vorhandene User-Presets
    // migrieren, statt sie unsichtbar werden zu lassen.
    if (migratePresetCategories()) _saveRaw();
    if (!APP.profiles.length) {
      initDefaults();
    } else {
      if (!APP.activeProfileId || !APP.profiles.find(p => p.id === APP.activeProfileId)) {
        APP.activeProfileId = APP.profiles[0].id;
      }
      migrateEffects();
      migratePlaybackSettings();
      migrateProfileColors();
      await runIdbMigrationIfNeeded();
      // BUGFIX: No decodeAllAudio() here — lazy decode on demand
    }
  } catch(e) {
    console.error('[storage] load error:', e); initDefaults();
  }
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
