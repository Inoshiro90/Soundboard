/**
 * storage/migration.js — Migrationslogik für Altformate
 * Ausgelagert aus storage.js (Phase 2 der Refaktorierung).
 * migrateEffects/migratePlaybackSettings/migrateProfileColors ergänzen
 * rückwärtskompatibel fehlende Felder in bestehenden gespeicherten Daten;
 * runIdbMigrationIfNeeded überführt Base64-Audio in IndexedDB.
 */

import { APP }                              from '../core/state.js';
import { defaultEffects, defaultPlayback }  from '../audio/effect-graph.js';
import { toast }                            from '../notifications.js';
import { idbSet, migrateAudioToIdb, audioKey, IDB_SENTINEL, isBase64Data } from '../db.js';
// Zirkulärer Import (persistence.js importiert umgekehrt migrateEffects/
// migratePlaybackSettings/migrateProfileColors/runIdbMigrationIfNeeded aus
// diesem Modul) — funktioniert wie das bereits bestehende audio/playback.js/
// ambient.js-Muster, da _saveRaw() erst zur Laufzeit (nicht beim
// Modul-Ladevorgang) aufgerufen wird.
import { _saveRaw }                         from './persistence.js';

// ─── EFFECTS MIGRATION ───────────────────────────────────────

export function migrateEffects() {
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

// ─── "WIEDERGABE & VERHALTEN"-MIGRATION ───────────────────────
// Analog zu migrateEffects(): stellt sicher, dass jeder gespeicherte Sound
// (auch aus einer Version vor dieser Funktion) ein vollständiges
// `playback`-Objekt besitzt, ohne bestehende Werte zu überschreiben.
// s.loop/s.fade/s.random bleiben davon unberührt (eigene Legacy-Felder,
// s. mkSound()).
export function migratePlaybackSettings() {
  const def   = defaultPlayback();
  const clone = x => JSON.parse(JSON.stringify(x));

  APP.profiles.forEach(prof => {
    (prof.items || []).filter(x => x.type === 'sound').forEach(s => {
      if (!s.playback || typeof s.playback !== 'object') {
        s.playback = clone(def); return;
      }
      const pb = s.playback;
      if (!pb.fadeIn)    pb.fadeIn    = clone(def.fadeIn);
      if (!pb.fadeOut)   pb.fadeOut   = clone(def.fadeOut);
      if (!pb.crossfade) pb.crossfade = clone(def.crossfade);
    });
  });
}

// ─── PROFIL-FARBEN-/PRESET-MIGRATION ──────────────────────────
// Prompt 1, Kap. 5: Sound-Profile (Tabs) bekommen ein `color`-Feld.
// Prompt 4, Kap. 1: zusätzlich ein `audioEffectPreset`-Feld (null = kein
// übergeordnetes Preset). Bestehende, ohne diese Felder gespeicherte
// Profile erhalten automatisch die neutralen Defaults — keine
// destruktive Migration.
export function migrateProfileColors() {
  APP.profiles.forEach(p => {
    if (!p.color) p.color = 'none';
    if (p.audioEffectPreset === undefined) p.audioEffectPreset = null;
  });
}

// ─── IDB MIGRATION ───────────────────────────────────────────

export async function runIdbMigrationIfNeeded() {
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
