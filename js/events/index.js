/**
 * events/index.js — Orchestrierung: registerEvents() ruft alle Teil-Registrierungen
 * in fester Reihenfolge auf. Enthält außerdem Autosave.
 */

import { registerPresetEvents } from './register-preset-events.js';
import { registerTileEvents } from './register-tile-events.js';
import { registerEffectsEvents } from './register-effects-events.js';
import { registerSlotEvents } from './register-slot-events.js';
import { registerMacroEvents } from './register-macro-events.js';
import { registerToolbarEvents } from './register-toolbar-events.js';
import { registerTransferEvents } from '../dialogs/transfer-modal.js';

// ─── REGISTER ALL LISTENERS ───────────────────────────────────

export function registerEvents() {
  registerPresetEvents();
  registerToolbarEvents();
  registerTileEvents();
  registerEffectsEvents();
  registerSlotEvents();
  registerMacroEvents();
  registerTransferEvents();

  // ── Autosave ─────────────────────────────────────────────
  _startAutosave();
}

// ─── AUTOSAVE ────────────────────────────────────────────────

let _autosaveTimer = null;

function _startAutosave() {
  const INTERVAL = 60_000; // 60 seconds
  setInterval(() => {
    import('../storage/persistence.js').then(m => {
      if (m._saveRaw) m._saveRaw();
      else if (m.save) m.save();
    }).catch(() => {});
  }, INTERVAL);
}

