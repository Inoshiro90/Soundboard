/**
 * dialogs/macro-modal.js — Makro-Bearbeiten-Modal
 */

import { APP, CItems } from '../core/state.js';
import { buildIconGrid } from '../ui/icon-picker.js';
import { buildColorOpts } from '../ui/color-picker.js';
import { renderMacroSteps } from '../ui/macro-steps.js';
import { _syncMacroAdvancedIndicator } from '../dialogs/sound-modal.js';

// ─── MACRO MODAL ─────────────────────────────────────────────

export function openMacroModal(id, placeholderId = null) {
  APP.editMacroId = id;
  APP._macroPhReplacingId = placeholderId;
  const m = id ? CItems().find(x => x.id === id && x.type === 'macro') : null;

  document.getElementById('mMTitle').textContent = id ? 'MAKRO BEARBEITEN' : 'NEUES MAKRO';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };

  set('mName',      m ? m.name         : '');
  set('mRepeat',    m ? m.repeat        : 1);
  set('mRepDelay',  m ? m.repeatDelay   : 500);
  set('mHotkey',    m ? m.hotkey        : '');
  set('mIcon',      m ? m.icon          : '🪄');
  set('mTileW',     m && m.tileW ? m.tileW : '');
  set('mTileH',     m && m.tileH ? m.tileH : '');
  set('mPlayMode',  m ? m.playMode || 'parallel' : 'parallel');
  set('mTileClr',   m && m.tileColor ? m.tileColor : '#ffffff');
  _syncMacroAdvancedIndicator();

  const delBtn = document.getElementById('btnDelMacro');
  if (delBtn) delBtn.style.display = id ? '' : 'none';

  // Migrate old delay-based steps + init timeline
  APP.macroSteps = m ? (m.steps || []).map(s => ({ ...s })) : [];
  import('../macroTimeline.js').then(mod => {
    APP.macroSteps = mod.migrateStepsToStartTime(APP.macroSteps);
  });
  buildColorOpts('mClrOpts', m ? m.color : 'none');
  buildColorOpts('mTileClrOpts', m && m.tileColor ? m.tileColor : 'none');
  buildIconGrid('mIconGrid',  m ? m.icon  : '🪄');
  renderMacroSteps();
  document.getElementById('macroModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#macroModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
    // Init macro timeline canvas
    const canvas = document.getElementById('macroTimelineCanvas');
    if (canvas) import('../macroTimeline.js').then(mod => mod.initMacroTimeline(canvas, APP.macroSteps));
  }, { once: true });
  new bootstrap.Modal(document.getElementById('macroModal')).show();
}

