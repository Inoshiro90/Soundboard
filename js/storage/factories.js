/**
 * storage/factories.js — Factory-Funktionen für Profile/Items + Standardbestand
 * Ausgelagert aus storage.js (Phase 2 der Refaktorierung).
 */

import { APP }                             from '../core/state.js';
import { uid }                             from '../utils.js';
import { defaultEffects, defaultPlayback } from '../audio/effect-graph.js';

// ─── FACTORY ─────────────────────────────────────────────────

// Wie viele leere Kacheln bekommt ein neu angelegtes Profil als Startbestand?
// Früher aus maxCols*maxRows (10×10=100) berechnet; das Grid ist seit dem
// neuen Spalten-System (grid-system.css) breakpoint-gesteuert und hat kein
// festes Zeilenlimit mehr, daher ein fester, viewport-unabhängiger Wert.
export const STARTER_PLACEHOLDER_COUNT = 24;

export function mkProfile(name, icon, color) {
  return { id: uid(), name, icon: icon || '🎵', color: color || 'none', audioEffectPreset: null, items: [] };
}

export function mkAmbientProfile(name, icon, color) {
  return { id: uid(), name: name || 'Ambient', icon: icon || '🌫️', color: color || 'none', audioEffectPreset: null, tracks: [] };
}

export function mkMusicProfile(name, icon, color) {
  return { id: uid(), name: name || 'Musik', icon: icon || '🎵', color: color || 'none', audioEffectPreset: null, tracks: [] };
}

export function mkSound(d, order) {
  return {
    type: 'sound', id: uid(), order: order ?? 0,
    name: d.name || 'SOUND', icon: d.icon || '🔊', color: d.color || 'none',
    tileColor: '', tileW: null, tileH: null,
    vol: 1, pitch: 1, loop: false, fade: false, random: false,
    hotkey: '', category: '', locked: false,
    slots: [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null }],
    curSlot: 0, effects: defaultEffects(), playback: defaultPlayback()
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
