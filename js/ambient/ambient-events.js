/**
 * ambient/ambient-events.js — Event-Verdrahtung für die Ambient-Ansicht
 */

import { APP, CAP } from '../core/state.js';
import { toast } from '../notifications.js';
import { exportAmbientProfile, exportAmbientTrack } from '../storage/import-export.js';
import {
  ensureAmbientState, addAmbientFiles, removeAmbientTrack, renameAmbientTrack,
  setAmbientTrackVolume, setAmbientMasterVolume, switchAmbientProfile
} from './ambient-model.js';
import { stopAllAmbient, toggleAmbientPlay } from './ambient-playback.js';
import { renderAmbientProfileTabs, renderAmbientPanel, setViewMode } from './ambient-render.js';

// ─── UI: EVENTS ──────────────────────────────────────────────

export function registerAmbientEvents() {
  ensureAmbientState();

  // View-mode toggle (navbar)
  document.getElementById('btnModeSound')?.addEventListener('click', () => setViewMode('sound'));
  document.getElementById('btnModeAmbient')?.addEventListener('click', () => setViewMode('ambient'));
  document.getElementById('btnModeMusic')?.addEventListener('click', () => setViewMode('music'));

  // Ambient scene tabs — mirrors #profBar delegation in events/register-tile-events.js.
  // Editing a scene opens a modal owned by dialogs/ambient-modal.js, so we signal via a
  // small custom event rather than importing dialogs/ambient-modal.js here (would be circular).
  document.getElementById('ambProfBar')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.profile-tab__edit');
    const tab     = e.target.closest('.profile-tab');
    if (editBtn) {
      const pid = tab?.dataset.pid;
      if (pid) document.dispatchEvent(new CustomEvent('ambient:editProfile', { detail: { id: pid } }));
      return;
    }
    if (tab) switchAmbientProfile(tab.dataset.pid);
  });

  // Export-Button am rechten Rand der Tab-Leiste — exportiert
  // immer die AKTIVE Szene (exportAmbientProfile() aus storage/import-export.js).
  document.getElementById('btnExportAmbientProfileTab')?.addEventListener('click', () => {
    const p = CAP();
    if (p) exportAmbientProfile(p.id); else toast('Keine Ambient-Szene vorhanden', 'err');
  });

  document.getElementById('btnAmbientAdd')?.addEventListener('click', () => {
    document.getElementById('ambientFile')?.click();
  });
  document.getElementById('ambientFile')?.addEventListener('change', function () {
    if (this.files?.length) addAmbientFiles(this.files);
    this.value = '';
  });

  document.getElementById('ambientMasterVol')?.addEventListener('input', function () {
    setAmbientMasterVolume(parseFloat(this.value));
    const numEl = document.getElementById('ambientMasterVolNum');
    if (numEl) numEl.value = Math.round(parseFloat(this.value) * 100);
  });
  document.getElementById('ambientMasterVolNum')?.addEventListener('input', function () {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const val  = pct / 100;
    setAmbientMasterVolume(val);
    const slEl = document.getElementById('ambientMasterVol');
    if (slEl) slEl.value = val;
  });

  document.getElementById('btnAmbientStopAll')?.addEventListener('click', () => stopAllAmbient());

  // Lautstärke-Dialog statt permanent sichtbarer Leiste.
  document.getElementById('btnOpenAmbientVolumeModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('ambientVolumeModal')).show();
  });

  const list = document.getElementById('ambientList');
  if (list) {
    list.addEventListener('click', e => {
      const row = e.target.closest('.ambient-row'); if (!row) return;
      const id     = row.dataset.id;
      const actEl  = e.target.closest('[data-act]'); if (!actEl) return;
      const act    = actEl.dataset.act;

      if      (act === 'play')   toggleAmbientPlay(id);
      else if (act === 'icon')   document.dispatchEvent(new CustomEvent('ambient:pickTrackIcon', { detail: { id } }));
      else if (act === 'fx')     document.dispatchEvent(new CustomEvent('ambient:editEffects', { detail: { id } }));
      else if (act === 'export') exportAmbientTrack(id);
      else if (act === 'remove') { if (confirm('Diesen Ambient-Sound entfernen?')) removeAmbientTrack(id); }
    });

    list.addEventListener('input', e => {
      const row = e.target.closest('.ambient-row'); if (!row) return;
      const id  = row.dataset.id;
      if (e.target.dataset.act === 'vol') {
        const val = parseFloat(e.target.value);
        setAmbientTrackVolume(id, val);
        const pct = row.querySelector('.ambient-row__vol-pct');
        if (pct) pct.textContent = Math.round(val * 100) + '%';
      }
    });

    list.addEventListener('change', e => {
      const row = e.target.closest('.ambient-row'); if (!row) return;
      const id  = row.dataset.id;
      if (e.target.dataset.act === 'name') renameAmbientTrack(id, e.target.value);
    });
  }

  renderAmbientProfileTabs();
  renderAmbientPanel();
  setViewMode(APP.viewMode || 'sound');
}
