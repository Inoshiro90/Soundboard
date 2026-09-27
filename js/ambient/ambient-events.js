/**
 * ambient/ambient-events.js — Event-Verdrahtung für die Ambient-Ansicht
 * Ausgelagert aus ambient.js (Phase 5 der Refaktorierung).
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

  // Ambient scene tabs — mirrors #profBar delegation in events.js.
  // Editing a scene opens a modal owned by events.js, so we signal via a
  // small custom event rather than importing events.js here (would be circular).
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

  // Prompt 4: Export-Button am rechten Rand der Tab-Leiste — exportiert
  // immer die AKTIVE Szene (exportAmbientProfile() unverändert aus storage/import-export.js).
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

  // Prompt 2, Kap. 13/14: Noise-Generator-UI deaktiviert; Generatorfunktionalität
  // bleibt für spätere Reaktivierung erhalten. Der sichtbare Button
  // (#btnAmbientAddGenerator) und sein Popover (#ambientGeneratorPopover)
  // wurden aus der Ambient-Toolbar entfernt (index.html) — die darunter-
  // liegende Funktion addNoiseGeneratorTrack() (inkl. white/pink/brown,
  // AudioWorklet-Code, Datenstrukturen) ist davon unberührt und bleibt
  // vollständig aufrufbar (z. B. für eine künftige UI). Nur die
  // UI-EVENT-REGISTRIERUNG für die entfernten DOM-Elemente ist unten
  // auskommentiert, nicht die Funktionalität selbst.
  /*
  const genBtn   = document.getElementById('btnAmbientAddGenerator');
  const genPanel = document.getElementById('ambientGeneratorPopover');
  function _closeGenPopover() {
    if (genPanel) genPanel.hidden = true;
    genBtn?.setAttribute('aria-expanded', 'false');
  }
  genBtn?.addEventListener('click', () => {
    if (!genPanel) return;
    const wasOpen = !genPanel.hidden;
    _closeGenPopover();
    if (wasOpen) return; // erneuter Klick schließt nur
    const rect = genBtn.getBoundingClientRect();
    genPanel.style.position = 'fixed';
    genPanel.style.top  = `${Math.round(rect.bottom + 6)}px`;
    genPanel.style.left = `${Math.round(rect.left)}px`;
    genPanel.hidden = false;
    genBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      if (genPanel.hidden) return;
      const pad = 8, pRect = genPanel.getBoundingClientRect();
      if (pRect.right > window.innerWidth - pad) {
        genPanel.style.left = `${Math.max(pad, window.innerWidth - pad - pRect.width)}px`;
      }
    });
  });
  document.getElementById('genAddWhite')?.addEventListener('click', () => { addNoiseGeneratorTrack('white'); _closeGenPopover(); });
  document.getElementById('genAddPink') ?.addEventListener('click', () => { addNoiseGeneratorTrack('pink');  _closeGenPopover(); });
  document.getElementById('genAddBrown')?.addEventListener('click', () => { addNoiseGeneratorTrack('brown'); _closeGenPopover(); });
  document.addEventListener('pointerdown', e => {
    if (!genPanel || genPanel.hidden) return;
    if (e.target.closest('#ambientGeneratorPopover') || e.target.closest('#btnAmbientAddGenerator')) return;
    _closeGenPopover();
  });
  */

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

  // Prompt 2, Kap. 12: Lautstärke-Dialog statt permanent sichtbarer Leiste.
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
