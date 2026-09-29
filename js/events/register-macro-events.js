/**
 * events/register-macro-events.js — Makro-Modal, Makro-Accordion,
 * Makro-Timeline, Makro-Item-Picker
 */

import { APP, CItems } from '../core/state.js';
import { uid, iconHtmlOr, hotkeyMatch } from '../utils.js';
import { toast } from '../notifications.js';
import { actx } from '../audio/context.js';
import { runMacro } from '../audio/playback.js';
import { renderGrid } from '../ui/grid.js';
import { mkMacro } from '../storage/factories.js';
import { handleHotkeyRecord } from './register-toolbar-events.js';
import { _syncMacroAdvancedIndicator } from '../dialogs/sound-modal.js';

export function registerMacroEvents() {
  // ── MACRO MODAL ────────────────────────────────────────────

  /** Helper: re-render macro timeline canvas after any step change */
  function _syncMacroTimeline() {
    import('../macroTimeline.js').then(m => m.setMacroTimelineSteps(APP.macroSteps));
  }

  // Sound/Makro → öffnet Picker-Modal
  document.getElementById('btnAddStep')?.addEventListener('click', _openMacroItemPicker);
  document.getElementById('btnTestMacro')?.addEventListener('click', () => {
    runMacro({
      id: '_test',
      steps:       [...APP.macroSteps],
      repeat:      parseInt(document.getElementById('mRepeat').value) || 1,
      repeatDelay: parseInt(document.getElementById('mRepDelay').value) || 500,
      playMode:    document.getElementById('mPlayMode').value
    });
  });
  document.getElementById('mPlayMode')?.addEventListener('change', () => _syncMacroAdvancedIndicator());
  document.getElementById('btnSaveMacro')?.addEventListener('click', async () => {
    // Convert startTime positions to legacy delay (keeps backward compat)
    let _finalSteps;
    try {
      const _mtMod = await import('../macroTimeline.js');
      _finalSteps  = _mtMod.stepsToLegacy([...APP.macroSteps]);
    } catch (e) {
      // Fallback: use steps as-is if macroTimeline unavailable
      _finalSteps = [...APP.macroSteps];
    }
    const g  = id => document.getElementById(id);
    const name        = g('mName').value.trim()  || 'MAKRO';
    const repeat      = parseInt(g('mRepeat').value)    || 1;
    const repeatDelay = parseInt(g('mRepDelay').value)  || 500;
    const hotkey      = g('mHotkey').value.trim();
    const icon        = g('mIcon').value.trim()  || '🪄';
    const tileW       = parseInt(g('mTileW').value)     || null;
    const tileH       = parseInt(g('mTileH').value)     || null;
    const playMode    = g('mPlayMode').value;
    const mTcSel  = document.querySelector('#mTileClrOpts .color-swatch.is-selected');
    const tileColor   = (mTcSel && mTcSel.dataset.color !== 'none') ? mTcSel.dataset.color : '';
    const sel         = document.querySelector('#mClrOpts .color-swatch.is-selected');
    const color       = sel ? sel.dataset.color : 'none';
    const items       = CItems();
    if (APP.editMacroId) {
      const m = items.find(x => x.id === APP.editMacroId);
      Object.assign(m, { name, repeat, repeatDelay, hotkey, icon, color, tileColor, tileW, tileH, playMode, steps: _finalSteps });
    } else {
      const nm = mkMacro({ name, repeat, repeatDelay, hotkey, icon, color, tileColor, tileW, tileH, playMode, steps: _finalSteps });
      // Add in the exact tile the user clicked "+" on (see ui/grid.js
      // _openTileAddChoice), falling back to the first free slot.
      const phId  = APP._macroPhReplacingId;
      const phIdx = phId ? items.findIndex(x => x.id === phId) : -1;
      if (phIdx >= 0) { nm.order = items[phIdx].order; items.splice(phIdx, 1, nm); }
      else {
        const firstPH = items.findIndex(x => x.type === 'placeholder');
        if (firstPH >= 0) { nm.order = items[firstPH].order; items.splice(firstPH, 1, nm); }
        else              { nm.order = items.length; items.push(nm); }
      }
    }
    bootstrap.Modal.getInstance(document.getElementById('macroModal')).hide();
    renderGrid(); toast('Makro gespeichert ✓', 'ok');
  });
  document.getElementById('btnDelMacro')?.addEventListener('click', () => {
    if (!APP.editMacroId) return;
    if (!confirm('Dieses Makro wirklich löschen?')) return;
    const items = CItems(); const idx = items.findIndex(x => x.id === APP.editMacroId);
    if (idx >= 0) { const order = items[idx].order; items.splice(idx, 1, { type: 'placeholder', id: uid(), order, locked: false }); }
    bootstrap.Modal.getInstance(document.getElementById('macroModal')).hide();
    renderGrid(); toast('Makro gelöscht');
  });

  // Hotkey fields
  ['eHotkey', 'mHotkey'].forEach(id => {
    const f = document.getElementById(id);
    if (!f) return;
    f.addEventListener('click', () => { APP.hkTarget = id; f.classList.add('is-recording'); f.value = 'Taste drücken…'; });
  });

  // Global keyboard
  document.addEventListener('keydown', e => {
    if (APP.hkTarget) { handleHotkeyRecord(e); return; }
    const tag = e.target.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const match = CItems().find(x => x.hotkey && hotkeyMatch(x.hotkey, e));
    if (match) { e.preventDefault(); import('../audio/playback.js').then(m => m.playItem(match.id)); }
  });

  // Wake AudioContext on first interaction
  document.body.addEventListener('click', () => actx(), { once: true });

  // ── Accordion ────────────────────────────────────────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('.sm-section-toggle');
    if (!btn) return;
    const targetId = btn.dataset.target;
    if (!targetId) return;
    const body = document.getElementById(targetId);
    if (!body) return;
    const isOpen = btn.classList.contains('is-open');
    btn.classList.toggle('is-open', !isOpen);
    body.style.display = isOpen ? 'none' : '';
  });

  // ── Macro Timeline ───────────────────────────────────────
  document.getElementById('macroTlSnap')?.addEventListener('change', function() {
    import('../macroTimeline.js').then(m => m.setSnapMs(parseInt(this.value) || 0));
  });
  document.getElementById('macroTlZoom')?.addEventListener('input', function() {
    import('../macroTimeline.js').then(m => m.setZoom(parseFloat(this.value)));
  });
  document.getElementById('btnMacroTlPreview')?.addEventListener('click', () => {
    import('../macroTimeline.js').then(m => m.previewPlay(actx()));
  });
  document.getElementById('btnMacroTlStop')?.addEventListener('click', () => {
    import('../macroTimeline.js').then(m => m.previewStop(actx()));
  });

  // ── MACRO ITEM PICKER ─────────────────────
  let _macroPickerSelected = null; // { id, type }

  /** Alle Sounds und Makros des aktiven Profils im Picker rendern */
  function _renderMacroItemList(filter) {
    const list = document.getElementById('macroItemPickerList');
    if (!list) return;
    const q     = (filter || '').toLowerCase();
    const items = CItems().filter(x =>
      (x.type === 'sound' || x.type === 'macro') &&
      (!q || x.name.toLowerCase().includes(q))
    );
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<p class="u-text-muted" style="padding:8px;font-size:var(--text-badge)">Keine Sounds oder Makros gefunden.</p>';
      return;
    }
    // Group: sounds first, then macros
    const sounds = items.filter(x => x.type === 'sound');
    const macros = items.filter(x => x.type === 'macro');
    const renderGroup = (title, group) => {
      if (!group.length) return;
      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-size:0.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);padding:6px 4px 2px;font-weight:600';
      hdr.textContent = title;
      list.appendChild(hdr);
      group.forEach(s => {
        const el = document.createElement('button');
        el.className = 'tl-picker-item btn btn--ghost';
        el.setAttribute('role', 'option');
        el.innerHTML = `<span style="font-size:1.1em;margin-right:6px">${iconHtmlOr(s.icon, s.type === 'macro' ? '🪄' : '🔊')}</span>
          <span style="flex:1;text-align:left">${s.name}</span>`;
        el.addEventListener('click', () => {
          list.querySelectorAll('.tl-picker-item').forEach(b => b.classList.remove('is-selected'));
          el.classList.add('is-selected');
          _macroPickerSelected = { id: s.id, type: s.type };
          const insertBtn = document.getElementById('btnMacroItemInsert');
          if (insertBtn) insertBtn.disabled = false;
        });
        list.appendChild(el);
      });
    };
    renderGroup('Sounds', sounds);
    renderGroup('Makros', macros);
  }

  /** Öffnet den Makro-Item-Picker */
  function _openMacroItemPicker() {
    _macroPickerSelected = null;
    const insertBtn = document.getElementById('btnMacroItemInsert');
    if (insertBtn) insertBtn.disabled = true;
    const searchEl = document.getElementById('macroItemSearch');
    if (searchEl) searchEl.value = '';
    _renderMacroItemList('');
    new bootstrap.Modal(document.getElementById('macroItemPickerModal')).show();
  }

  document.getElementById('macroItemSearch')?.addEventListener('input', function() {
    _renderMacroItemList(this.value);
  });

  document.getElementById('btnMacroItemInsert')?.addEventListener('click', () => {
    if (!_macroPickerSelected) return;
    // Startzeit = Ende des letzten Schritts
    const lastEnd = APP.macroSteps.reduce((max, s) => {
      const st = s.startTime || 0;
      const dur = s.action === 'fadeout' ? (s.fadeDuration || 1000) / 1000
                : s.action === 'stop' || s.action === 'stop_all' ? 0.25
                : s.action === 'volume' ? 0.25
                : 0.5; // unbekannte Sound-Dauer, Fallback
      return Math.max(max, st + dur);
    }, 0);
    APP.macroSteps.push({
      action:    'play',
      targetId:  _macroPickerSelected.id,
      startTime: +lastEnd.toFixed(3),
      delay:     0
    });
    bootstrap.Modal.getInstance(document.getElementById('macroItemPickerModal'))?.hide();
    import('../macroTimeline.js').then(m => m.setMacroTimelineSteps(APP.macroSteps));
  });


}
