/**
 * storage.js — LocalStorage Persistence & Factory Functions
 */

import { APP, CP, CItems, CSettings, STORAGE_KEY } from './state.js';
import { uid, bk }    from './utils.js';
import { toast }      from './notifications.js';
import { decodeAudio } from './audio.js';

// ─── FACTORY FUNCTIONS ──────────────────────────────────────

export function mkProfile(name, icon) {
  return {
    id: uid(), name, icon: icon || '🎵',
    items: [],
    settings: { maxCols: 10, maxRows: 10, tileW: 120, tileH: 120 }
  };
}

export function mkSound(d, order) {
  return {
    type: 'sound', id: uid(),
    order: order ?? CItems().length,
    name:  d.name  || 'SOUND',
    icon:  d.icon  || '🔊',
    color: d.color || 'none',
    tileColor: '', tileW: null, tileH: null,
    vol: 1, pitch: 1, loop: false, fade: false, random: false,
    hotkey: '', category: '', locked: false,
    slots: [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null }],
    curSlot: 0
  };
}

export function mkMacro(d) {
  return {
    type: 'macro', id: uid(),
    order: CItems().length,
    name:  d.name  || 'MAKRO',
    icon:  d.icon  || '🪄',
    color: d.color || 'none',
    tileColor: d.tileColor || '',
    tileW: null, tileH: null,
    hotkey: '', locked: false,
    steps: d.steps || [],
    repeat: 1, repeatDelay: 500,
    playMode: d.playMode || 'parallel'
  };
}

export function mkPH(order) {
  return { type: 'placeholder', id: uid(), order: order ?? CItems().length, locked: false };
}

// ─── DEFAULT DATA ────────────────────────────────────────────

export function initDefaults() {
  APP.profiles = [];
  const p = mkProfile('Standard', '🎵');
  const defs = [
    { name: 'BOOOM',   icon: '💥', color: '#dd5b00' },
    { name: 'APPLAUS', icon: '👏', color: '#2a9d99'  },
    { name: 'PFEIL',   icon: '🏹', color: '#0075de'  },
    { name: 'FEUER',   icon: '🔥', color: '#dd5b00'  },
    { name: 'WASSER',  icon: '💧', color: '#0075de'  }
  ];
  const total = p.settings.maxCols * p.settings.maxRows;
  for (let i = 0; i < total; i++) {
    p.items.push(i < defs.length ? mkSound(defs[i], i) : mkPH(i));
  }
  APP.profiles.push(p);
  APP.activeProfileId = p.id;
}

// ─── DECODE ALL BUFFERED AUDIO ───────────────────────────────

export function decodeAllAudio() {
  APP.profiles.forEach(prof => {
    (prof.items || [])
      .filter(x => x.type === 'sound')
      .forEach(s => {
        (s.slots || []).forEach((sl, i) => {
          if (sl && sl.data) decodeAudio(bk(s.id, i), sl.data);
        });
      });
  });
}

// ─── SAVE ────────────────────────────────────────────────────

export function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      profiles:        APP.profiles,
      activeProfileId: APP.activeProfileId,
      globalSettings:  APP.globalSettings
    }));
    toast('Gespeichert ✓', 'ok');
  } catch (e) {
    toast('Speichern fehlgeschlagen', 'err');
  }
}

// ─── LOAD ────────────────────────────────────────────────────

export function load() {
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
      decodeAllAudio();
    }
  } catch (e) {
    initDefaults();
  }
}

// ─── EXPORT / IMPORT ─────────────────────────────────────────

export function exportData() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(
    [JSON.stringify({ profiles: APP.profiles, activeProfileId: APP.activeProfileId, globalSettings: APP.globalSettings }, null, 2)],
    { type: 'application/json' }
  ));
  a.download = 'soundboard_pro.json';
  a.click();
}

export function importData(file, { onSuccess }) {
  const r = new FileReader();
  r.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      APP.profiles        = d.profiles        || [];
      APP.activeProfileId = d.activeProfileId || APP.profiles[0]?.id;
      APP.globalSettings  = { ...APP.globalSettings, ...(d.globalSettings || {}) };
      decodeAllAudio();
      onSuccess();
    } catch (err) {
      toast('Import fehlgeschlagen', 'err');
    }
  };
  r.readAsText(file);
}

export function resetAll({ onDone }) {
  if (!confirm('Alles zurücksetzen?')) return;
  localStorage.removeItem(STORAGE_KEY);
  APP.profiles = [];
  initDefaults();
  onDone();
  toast('Zurückgesetzt');
}
