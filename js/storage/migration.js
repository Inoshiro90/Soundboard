/**
 * storage/migration.js — Migrationslogik für Altformate
 * migrateEffects/migratePlaybackSettings/migrateProfileColors ergänzen
 * rückwärtskompatibel fehlende Felder in bestehenden gespeicherten Daten;
 * runIdbMigrationIfNeeded überführt Base64-Audio in IndexedDB.
 */

import { APP }                              from '../core/state.js';
import { defaultPlayback }                from '../audio/effect-graph.js';
import { STORAGE_KEY }                   from '../core/constants.js';
import { PIPELINE_VERSION, defaultPipelineEffects } from '../audio/fx-pipeline.js';
import { ensureEffectsV2 }               from '../fx-model.js';
import { toast }                            from '../notifications.js';
import { idbSet, migrateAudioToIdb, audioKey, IDB_SENTINEL, isBase64Data } from '../db.js';
// Zirkulärer Import (persistence.js importiert umgekehrt migrateEffects/
// migratePlaybackSettings/migrateProfileColors/runIdbMigrationIfNeeded aus
// diesem Modul) — funktioniert wie das Muster in audio/playback.js/
// ambient/ambient-playback.js, da _saveRaw() erst zur Laufzeit (nicht beim
// Modul-Ladevorgang) aufgerufen wird.
import { _saveRaw }                         from './persistence.js';

// ─── EFFECTS MIGRATION ───────────────────────────────────────

/** Alle Objekte mit einem `effects`-Feld: Sounds, Ambient-Tracks, Musik-Tracks. */
export function forEachEffectHolder(cb) {
  APP.profiles.forEach(prof => (prof.items || []).filter(x => x.type === 'sound').forEach(cb));
  (APP.ambient?.profiles || []).forEach(ap => (ap.tracks || []).forEach(cb));
  (APP.music?.profiles   || []).forEach(mp => (mp.tracks || []).forEach(cb));
}

const PRE_PIPELINE_BACKUP = STORAGE_KEY + ':pre-pipeline';

/** Alte Schlüssel, die das Pipeline-Modell nicht mehr kennt (Hüllkurve, Ausgang/Pan, Analyzer). */
const REMOVED_FX_KEYS = ['envelope', 'output', 'analyzer'];

/** True für v1-Objekte und für v2-Objekte, die noch entfernte Schlüssel tragen (→ Backup + Bereinigung). */
function _needsPipelineMigration(fx) {
  if (!fx || fx.v !== PIPELINE_VERSION) return true;
  return REMOVED_FX_KEYS.some(k => k in fx);
}

/**
 * Überführt ALLE Effekt-Objekte in das Pipeline-Modell (v2). Idempotent: v2-Objekte werden nur normalisiert.
 * Sicherheitsnetz: vor der ersten Migration wird der gespeicherte Rohzustand einmalig unter
 * `<STORAGE_KEY>:pre-pipeline` gesichert; scheitert die Migration eines einzelnen Elements, bekommt es eine leere
 * Pipeline und das Original unter `effects.legacyV1` (nichts geht verloren, nichts wird still falsch einsortiert).
 * Entfernte Schlüssel (envelope/output/analyzer) werden dabei verworfen; die Migration ist wiederholbar.
 * @returns {number} Anzahl migrierter (v1 oder bereinigter v2-)Objekte
 */
export function migrateEffects() {
  let needsBackup = false;
  forEachEffectHolder(h => { if (_needsPipelineMigration(h.effects)) needsBackup = true; });
  if (needsBackup) {
    try {
      if (!localStorage.getItem(PRE_PIPELINE_BACKUP)) {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) localStorage.setItem(PRE_PIPELINE_BACKUP, raw);
      }
    } catch (e) { console.warn('[storage] Pipeline-Backup nicht möglich:', e); }
  }
  let migrated = 0;
  forEachEffectHolder(h => {
    const wasCurrent = !_needsPipelineMigration(h.effects);
    try {
      h.effects = ensureEffectsV2(h.effects);
    } catch (e) {
      console.error('[storage] Effekt-Migration fehlgeschlagen für', h.id, e);
      const orig = h.effects;
      h.effects = defaultPipelineEffects();
      h.effects.legacyV1 = JSON.parse(JSON.stringify(orig ?? null));
    }
    if (!wasCurrent) migrated++;
  });
  return migrated;
}

// ─── "WIEDERGABE & VERHALTEN"-MIGRATION ───────────────────────
// Analog zu migrateEffects(): stellt sicher, dass jeder gespeicherte Sound
// (auch aus einer älteren Version) ein vollständiges `playback`-Objekt
// besitzt, ohne bestehende Werte zu überschreiben.
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
// Sound-Profile (Tabs) bekommen ein `color`-Feld sowie ein
// `audioEffectPreset`-Feld (null = kein übergeordnetes Preset). Bestehende,
// ohne diese Felder gespeicherte Profile erhalten automatisch die neutralen
// Defaults — keine destruktive Migration.
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
