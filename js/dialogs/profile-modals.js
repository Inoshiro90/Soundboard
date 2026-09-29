/**
 * dialogs/profile-modals.js — Sound-Profil-Bearbeiten-Modal
 */

import { APP } from '../core/state.js';
import { buildIconGrid } from '../ui/icon-picker.js';
import { buildColorOpts } from '../ui/color-picker.js';

// ─── PROFILE MODAL ────────────────────────────────────────────

export function openProfileModal(id) {
  APP.editProfileId = id;
  const p = id ? APP.profiles.find(x => x.id === id) : null;

  document.getElementById('profModalTitle').textContent = id ? 'PROFIL BEARBEITEN' : 'NEUES PROFIL';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  set('profNameInput', p ? p.name : '');
  set('profIconInput', p ? p.icon : '');

  const delBtn = document.getElementById('btnDelProfile');
  if (delBtn) delBtn.style.display = (id && APP.profiles.length > 1) ? '' : 'none';

  buildIconGrid('profIconGrid', p ? p.icon : '🎵');
  buildColorOpts('profColorOpts', p ? (p.color || 'none') : 'none');
  document.getElementById('profModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#profModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('profModal')).show();
}

