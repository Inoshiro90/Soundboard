/**
 * presets/preset-macros.js — Makro-Regler der Built-in-Presets (Phase 9). Nur Daten, kein Verhalten.
 * ----------------------------------------------------------------------------------------------------
 * Die Effektparameter der Built-ins bleiben unverändert in effect-presets-data.js; hier steht nur, welche Makro-Regler ein
 * Built-in anbietet. Form und Regeln: audio/engine/macros.js. Ziele ausgeschalteter Module werden nie angewendet, die
 * Startposition eines Reglers wird aus dem ersten Ziel zurückgerechnet — das Anwenden eines Presets ändert keinen Klang.
 */

export const MACRO_LIBRARY = {
  raumgroesse: {
    id: 'raumgroesse', label: 'Raumgröße',
    targets: [
      { path: 'reverb.duration', von: 0.2, bis: 10, kurve: 'log' },
      { path: 'reverb.decay', von: 0.8, bis: 5 }
    ]
  },
  verzerrung: {
    id: 'verzerrung', label: 'Verzerrung',
    targets: [{ path: 'distortion.amount', von: 0, bis: 100 }]
  },
  entfernung: {
    id: 'entfernung', label: 'Entfernung',
    targets: [
      { path: 'lowpass.frequency', von: 12000, bis: 500, kurve: 'log' },
      { path: 'reverb.amount', von: 0.05, bis: 0.45 }
    ]
  }
};

/** Built-in-Preset-ID → Makro-IDs aus MACRO_LIBRARY (nur Presets, in denen das Zielmodul tatsächlich aktiv ist). */
export const BUILTIN_PRESET_MACROS = {
  // Raumgröße: algorithmischer Hall mit hörbarer Dauer
  metal_room: ['raumgroesse'], underwater: ['raumgroesse'], monster: ['raumgroesse', 'verzerrung'], possessed: ['raumgroesse', 'verzerrung'],
  portal_warp: ['raumgroesse'], dying_breath: ['raumgroesse'], endless_abyss: ['raumgroesse'], drunk_dizzy: ['raumgroesse'],
  shadow_realm: ['raumgroesse'], fairy_pixie: ['raumgroesse'],
  // Verzerrung: Presets mit aktivem Distortion-Modul
  phone: ['verzerrung'], radio: ['verzerrung'], lofi: ['verzerrung'], megaphone: ['verzerrung'], vintage_tape: ['verzerrung'],
  broken_speaker: ['verzerrung'], signal_dropout: ['verzerrung'], heavy_barricade: ['verzerrung'], intercom_bunker: ['verzerrung'],
  phonograph_horn: ['verzerrung'],
  // Entfernung: Tiefpass (+ Hall-Anteil, falls aktiv)
  distant: ['entfernung'], distant_horizon: ['entfernung'], behind_wall: ['entfernung'], dense_canopy: ['entfernung']
};

/** Tiefe Kopien der Makros eines Built-ins (leer, wenn es keine hat). */
export function builtinMacrosFor(presetId) {
  const ids = BUILTIN_PRESET_MACROS[presetId];
  return Array.isArray(ids) ? ids.map(id => JSON.parse(JSON.stringify(MACRO_LIBRARY[id]))) : [];
}
