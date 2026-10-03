/**
 * events/index.js — Orchestrierung: registerEvents() ruft alle Teil-Registrierungen
 * in fester Reihenfolge auf. Enthält außerdem Autosave und die Hüllkurven-Vorschau
 * (Sound-Modal-Canvas).
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

// ─── ENVELOPE CURVE PREVIEW ──────────────────────────────────

// Exportiert: register-effects-events.js ruft _updateEnvelopeCurve()
// bei jeder Änderung der Envelope-Regler im Sound-Modal auf.
export function _updateEnvelopeCurve() {
  const cv = document.getElementById('envCanvas');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = cv.offsetWidth; const H = cv.offsetHeight;
  if (W === 0 || H === 0) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  const att = parseFloat(document.getElementById('fxEnvAttack')?.value)  || 0.01;
  const dec = parseFloat(document.getElementById('fxEnvDecay')?.value)   || 0.15;
  const sus = parseFloat(document.getElementById('fxEnvSustain')?.value) || 0.8;
  const rel = parseFloat(document.getElementById('fxEnvRelease')?.value) || 0.25;
  const totalT = att + dec + Math.max(dec * 2, 0.3) + rel;

  const cs     = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--color-accent').trim() || '#0075de';
  const bg     = cs.getPropertyValue('--bg-warm').trim()      || '#1a1a1a';

  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();

  const t2x = t => (t / totalT) * W;
  const v2y = v => H - v * (H - 4) - 2;

  ctx.moveTo(0, v2y(0));
  ctx.lineTo(t2x(att), v2y(1));
  ctx.lineTo(t2x(att + dec), v2y(sus));
  const susEnd = att + dec + Math.max(dec * 2, 0.3);
  ctx.lineTo(t2x(susEnd), v2y(sus));
  ctx.lineTo(t2x(totalT), v2y(0));
  ctx.stroke();

  // Labels
  ctx.fillStyle = accent; ctx.font = `9px monospace`;
  ctx.fillText('A', t2x(att / 2) - 3, H - 2);
  ctx.fillText('D', t2x(att + dec / 2) - 3, H - 2);
  ctx.fillText('S', t2x(att + dec + Math.max(dec, 0.15)) - 3, H - 2);
  ctx.fillText('R', t2x(susEnd + rel / 2) - 3, H - 2);
}
