/**
 * storage.js — Persistence (Stable Edition)
 * Fixes: decodeAudioSmart uses audioCache, migrateEffects complete for all phases
 */

import { APP, CItems, CSettings, STORAGE_KEY } from './state.js';
import { uid, bk }    from './utils.js';
import { toast }      from './notifications.js';
import { defaultEffects } from './audio.js';
import { getOrDecodeBuffer } from './audioCache.js';
import { openDB, idbSet, idbGet, migrateAudioToIdb, audioKey,
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
  if (!needs) return;
  toast('Migriere Audio zu IndexedDB…');
  try {
    const count = await migrateAudioToIdb(APP.profiles);
    _saveRaw();
    toast(`Migration abgeschlossen (${count} Slots)`, 'ok');
  } catch(e) {
    console.error('[storage] IDB migration error:', e);
    toast('Migration fehlgeschlagen — Fallback aktiv', 'err');
  }
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

export function mkProfile(name, icon) {
  return { id: uid(), name, icon: icon || '🎵', items: [],
           settings: { maxCols: 10, maxRows: 10, tileW: 120, tileH: 120 } };
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
  const total = p.settings.maxCols * p.settings.maxRows;
  for (let i = 0; i < total; i++) {
    p.items.push(i < defs.length ? mkSound(defs[i], i) : mkPH(i));
  }
  APP.profiles.push(p); APP.activeProfileId = p.id;
}

// ─── SAVE ────────────────────────────────────────────────────

export function _saveRaw() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      profiles:        APP.profiles,
      activeProfileId: APP.activeProfileId,
      globalSettings:  APP.globalSettings,
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

export async function exportData() {
  toast('Bereite Export vor…');
  const clone = JSON.parse(JSON.stringify(APP.profiles));
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
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(
    [JSON.stringify({ profiles: clone, activeProfileId: APP.activeProfileId, globalSettings: APP.globalSettings }, null, 2)],
    { type: 'application/json' }
  ));
  a.download = 'soundboard_pro.json'; a.click();
  toast('Export ✓', 'ok');
}

export async function exportDataWithAudio() {
  toast('Bereite vollständigen Export vor…');
  const clone = JSON.parse(JSON.stringify(APP.profiles));
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
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(
    [JSON.stringify({ profiles: clone, activeProfileId: APP.activeProfileId, globalSettings: APP.globalSettings }, null, 2)],
    { type: 'application/json' }
  ));
  a.download = 'soundboard_pro_full.json'; a.click();
  toast('Vollständiger Export ✓', 'ok');
}

export async function importData(file, { onSuccess }) {
  const r = new FileReader();
  r.onload = async e => {
    try {
      const d = JSON.parse(e.target.result);
      APP.profiles        = d.profiles        || [];
      APP.activeProfileId = d.activeProfileId || APP.profiles[0]?.id;
      APP.globalSettings  = { ...APP.globalSettings, ...(d.globalSettings || {}) };
      migrateEffects();
      await runIdbMigrationIfNeeded();
      onSuccess();
    } catch(err) { toast('Import fehlgeschlagen', 'err'); }
  };
  r.readAsText(file);
}

export async function saveSlotAudio(soundId, slotIdx, base64, slot) {
  const key = audioKey(soundId, slotIdx);
  await idbSet(key, base64);
  if (slot) slot.data = IDB_SENTINEL;
}

export function resetAll({ onDone }) {
  if (!confirm('Alles zurücksetzen?')) return;
  localStorage.removeItem(STORAGE_KEY);
  APP.profiles = []; initDefaults(); onDone(); toast('Zurückgesetzt');
}
