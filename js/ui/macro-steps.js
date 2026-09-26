/**
 * ui/macro-steps.js — Makro-Schritte-Editor-Liste (Makro-Modal)
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { APP, CItems } from '../core/state.js';
import { iconGlyph } from '../utils.js';

// ─── MACRO STEPS RENDER ───────────────────────────────────────

export function renderMacroSteps() {
  const list = document.getElementById('mStepList');
  if (!list) return;
  list.innerHTML = '';

  const allTargets = CItems().filter(x =>
    (x.type === 'sound' || x.type === 'macro') && x.id !== APP.editMacroId
  );

  APP.macroSteps.forEach((step, i) => {
    const div    = document.createElement('div');
    div.className = 'macro-step';
    const action  = step.action || 'play';

    if (action === 'stop_all') {
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <span class="u-text-badge u-text-danger" style="flex:1">
          <i class="fa-solid fa-stop" aria-hidden="true"></i> Alle stoppen
        </span>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
    } else if (action === 'stop') {
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <span class="u-text-badge u-text-danger u-nowrap">
          <i class="fa-solid fa-stop" aria-hidden="true"></i> Stop
        </span>
        <select class="form-select mstep-select js-sel" aria-label="Ziel-Sound">
          <option value="">-- wählen --</option>
          ${allTargets.filter(x => x.type === 'sound').map(x =>
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${iconGlyph(x.icon)} ${x.name}</option>`
          ).join('')}
        </select>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      div.querySelector('.js-sel').addEventListener('change', e => { APP.macroSteps[i].targetId = e.target.value; });
    } else if (action === 'fadeout') {
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <span class="u-text-badge u-text-accent u-nowrap">
          <i class="fa-solid fa-volume-xmark" aria-hidden="true"></i> Fade
        </span>
        <select class="form-select mstep-select js-sel" aria-label="Ziel-Sound">
          <option value="">-- wählen --</option>
          ${allTargets.filter(x => x.type === 'sound').map(x =>
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${iconGlyph(x.icon)} ${x.name}</option>`
          ).join('')}
        </select>
        <input type="number" class="form-control mstep-delay js-fade-dur" value="${step.fadeDuration || 1000}" min="100" max="10000" aria-label="Fade-Dauer ms">
        <span class="mstep-ms-label">ms</span>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      div.querySelector('.js-sel').addEventListener('change',      e => { APP.macroSteps[i].targetId     = e.target.value; });
      div.querySelector('.js-fade-dur').addEventListener('change', e => { APP.macroSteps[i].fadeDuration = parseInt(e.target.value) || 1000; });
      div.querySelector('.js-delay').addEventListener('change',    e => { APP.macroSteps[i].delay        = parseInt(e.target.value) || 0; });
    } else if (action === 'volume') {
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <span class="u-text-badge u-text-accent u-nowrap">
          <i class="fa-solid fa-sliders" aria-hidden="true"></i> Vol
        </span>
        <input type="range" class="slider js-vol-sl" style="flex:1;min-width:70px" min="0" max="1" step=".05" value="${step.volumeVal != null ? step.volumeVal : 1}" aria-label="Lautstärke">
        <span class="js-vol-val u-text-mono u-text-badge u-text-accent" style="min-width:36px">${Math.round((step.volumeVal != null ? step.volumeVal : 1) * 100)}%</span>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      const sl = div.querySelector('.js-vol-sl');
      const vv = div.querySelector('.js-vol-val');
      sl.addEventListener('input', e => { APP.macroSteps[i].volumeVal = parseFloat(e.target.value); vv.textContent = Math.round(parseFloat(e.target.value) * 100) + '%'; });
      div.querySelector('.js-delay').addEventListener('change', e => { APP.macroSteps[i].delay = parseInt(e.target.value) || 0; });
    } else {
      const selType = step.targetId ? (CItems().find(x => x.id === step.targetId)?.type || 'sound') : 'sound';
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <select class="form-select mstep-type js-type" aria-label="Typ">
          <option value="sound"${selType === 'sound' ? ' selected' : ''}>Sound</option>
          <option value="macro"${selType === 'macro' ? ' selected' : ''}>Makro</option>
        </select>
        <select class="form-select mstep-select js-sel" aria-label="Ziel">
          <option value="">-- wählen --</option>
          ${allTargets.filter(x => x.type === selType).map(x =>
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${iconGlyph(x.icon)} ${x.name}</option>`
          ).join('')}
        </select>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      const typeEl = div.querySelector('.js-type');
      const selEl  = div.querySelector('.js-sel');
      typeEl.addEventListener('change', () => {
        const t = typeEl.value;
        selEl.innerHTML = '<option value="">-- wählen --</option>' +
          allTargets.filter(x => x.type === t).map(x => `<option value="${x.id}">${iconGlyph(x.icon)} ${x.name}</option>`).join('');
        APP.macroSteps[i].targetId = '';
      });
      selEl.addEventListener('change', e  => { APP.macroSteps[i].targetId = e.target.value; });
      div.querySelector('.js-delay').addEventListener('change', e => { APP.macroSteps[i].delay = parseInt(e.target.value) || 0; });
    }

    if (action === 'stop_all' || action === 'stop') {
      const dEl = div.querySelector('.js-delay');
      if (dEl) dEl.addEventListener('change', e => { APP.macroSteps[i].delay = parseInt(e.target.value) || 0; });
    }

    div.querySelector('.mstep-remove').addEventListener('click', () => { APP.macroSteps.splice(i, 1); renderMacroSteps(); });
    list.appendChild(div);
  });
}
