/**
 * music/music-events.js — Event-Verdrahtung für die Musik-Ansicht
 */

import { APP, CMP } from '../core/state.js';
import { toast } from '../notifications.js';
// `exportMusicTrack` war bereits im ursprünglichen music.js importiert,
// aber nie aufgerufen (toter Import) — mechanisch mit übernommen.
import { exportMusicProfile } from '../storage/import-export.js';
import {
  ensureMusicState, addMusicFiles, removeMusicTrack, setMusicTrackVolume,
  switchMusicProfile, moveMusicTrack, reorderMusicTrack
} from './music-model.js';
import {
  playMusicTrack, previousMusicTrack, nextMusicTrack, pauseMusic, resumeMusic,
  stopMusic, setMusicRepeatMode, toggleMusicShuffle, seekMusic,
  setMusicMasterVolume, setMusicCrossfade, setMusicAutoplay
  , _players, _activeSlot
} from './music-playback.js';
import { renderMusicProfileTabs, renderMusicPanel, renderMusicPlayer } from './music-render.js';

// ─── EVENTS ────────────────────────────────────────────────────

export function registerMusicEvents() {
  ensureMusicState();

  document.getElementById('musicProfBar')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.profile-tab__edit');
    const tab     = e.target.closest('.profile-tab');
    if (editBtn) {
      const pid = tab?.dataset.pid;
      if (pid) _dispatchEditProfile(pid);
      return;
    }
    if (tab) switchMusicProfile(tab.dataset.pid);
  });
  document.getElementById('btnAddMusicProfile')?.addEventListener('click', () => _dispatchEditProfile(null));

  // Export-Button am rechten Rand der Tab-Leiste — exportiert immer die
  // AKTIVE Playlist (exportMusicProfile() aus storage/import-export.js).
  document.getElementById('btnExportMusicProfileTab')?.addEventListener('click', () => {
    const p = CMP();
    if (p) exportMusicProfile(p.id); else toast('Keine Musik-Playlist vorhanden', 'err');
  });

  document.getElementById('btnMusicAdd')?.addEventListener('click', () => document.getElementById('musicFile')?.click());
  document.getElementById('musicFile')?.addEventListener('change', function () {
    if (this.files?.length) addMusicFiles(this.files);
    this.value = '';
  });
  // Der Export-Button liegt am rechten Rand von #musicProfBar
  // (s. events/register-toolbar-events.js: btnExportMusicProfileTab), nicht in der
  // Toolbar — exportMusicProfile() ist die zentrale Logik.

  // Dialog-Trigger statt permanent sichtbarer Player-Leisten.
  document.getElementById('btnOpenMusicPlaybackModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('musicPlaybackModal')).show();
  });
  document.getElementById('btnOpenMusicVolumeModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('musicVolumeModal')).show();
  });

  document.getElementById('btnMusicPrev')?.addEventListener('click', () => previousMusicTrack());
  document.getElementById('btnMusicNext')?.addEventListener('click', () => nextMusicTrack());
  document.getElementById('btnMusicPlayPause')?.addEventListener('click', () => {
    if (!APP.music.activeTrackId) return;
    const rec = _players?.[_activeSlot];
    if (rec && rec.trackId && !rec.audio.paused) pauseMusic();
    else if (rec && rec.trackId) resumeMusic();
    else playMusicTrack(APP.music.activeTrackId);
  });
  document.getElementById('btnMusicStop')?.addEventListener('click', () => stopMusic());
  document.getElementById('btnMusicRepeat')?.addEventListener('click', () => {
    const order = { off: 'all', all: 'one', one: 'off' };
    setMusicRepeatMode(order[APP.music.repeatMode] || 'off');
  });
  document.getElementById('btnMusicShuffle')?.addEventListener('click', () => toggleMusicShuffle());

  // Progress-Slider: Ziehen/Klick + Tastatur (ArrowLeft/Right/Home/End)
  const seekEl = document.getElementById('musicSeek');
  seekEl?.addEventListener('input',  function () { seekMusic(parseFloat(this.value) || 0); });
  seekEl?.addEventListener('change', function () { seekMusic(parseFloat(this.value) || 0); });

  document.getElementById('musicMasterVol')?.addEventListener('input', function () {
    setMusicMasterVolume(parseFloat(this.value));
    const numEl = document.getElementById('musicMasterVolNum');
    if (numEl) numEl.value = Math.round(parseFloat(this.value) * 100);
  });
  document.getElementById('musicMasterVolNum')?.addEventListener('input', function () {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const val = pct / 100;
    setMusicMasterVolume(val);
    const slEl = document.getElementById('musicMasterVol');
    if (slEl) slEl.value = val;
  });

  document.getElementById('musicCrossfade')?.addEventListener('change', function () {
    setMusicCrossfade(parseFloat(this.value));
  });
  document.getElementById('musicAutoplay')?.addEventListener('change', function () {
    setMusicAutoplay(this.checked);
  });

  // Space = Play/Pause, ArrowLeft/Right = Seek — nur innerhalb der Musikansicht
  // und nie, wenn ein Eingabefeld fokussiert ist (bestehende Shortcut-Architektur
  // nicht stören, keine globalen Shortcuts erzwingen).
  document.getElementById('musicBoard')?.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      document.getElementById('btnMusicPlayPause')?.click();
    }
  });

  const list = document.getElementById('musicList');
  if (list) {
    list.addEventListener('click', e => {
      const row = e.target.closest('.music-row'); if (!row) return;
      const id = row.dataset.id;
      const actEl = e.target.closest('[data-act]');
      if (!actEl) { playMusicTrack(id); return; } // Klick auf Zeile selbst = abspielen, kein Popup
      const act = actEl.dataset.act;
      if      (act === 'play')   playMusicTrack(id);
      else if (act === 'up')     moveMusicTrack(id, -1);
      else if (act === 'down')   moveMusicTrack(id, +1);
      else if (act === 'edit')   _openTrackEditModal(id);
      else if (act === 'remove') { if (confirm('Diesen Musik-Track löschen?')) removeMusicTrack(id); }
    });
    list.addEventListener('input', e => {
      const row = e.target.closest('.music-row'); if (!row) return;
      const act = e.target.dataset.act;
      if (act === 'vol') {
        setMusicTrackVolume(row.dataset.id, parseFloat(e.target.value));
        const numEl = row.querySelector('[data-act="volnum"]');
        if (numEl) numEl.value = Math.round(parseFloat(e.target.value) * 100);
      } else if (act === 'volnum') {
        const pct = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
        e.target.value = pct;
        const val = pct / 100;
        setMusicTrackVolume(row.dataset.id, val);
        const slEl = row.querySelector('[data-act="vol"]');
        if (slEl) slEl.value = val;
      }
    });
    // Desktop Drag&Drop-Reorder — nur über den Griff (.music-row__handle)
    // ziehbar (Nutzer-Feedback: sonst löste Ziehen am Lautstärkeregler
    // versehentlich ein Verschieben der ganzen Zeile aus). Da draggable
    // nur noch auf dem Griff selbst gesetzt ist, kann der native
    // dragstart gar nicht mehr von Slider/Buttons ausgehen.
    list.addEventListener('dragstart', e => {
      const handle = e.target.closest('.music-row__handle'); if (!handle) return;
      const row = handle.closest('.music-row'); if (!row) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.id);
      e.dataTransfer.setDragImage(row, 12, 12);
      row.classList.add('is-dragging');
    });
    list.addEventListener('dragend', e => {
      e.target.closest('.music-row')?.classList.remove('is-dragging');
      list.querySelectorAll('.music-row.is-drag-over').forEach(x => x.classList.remove('is-drag-over'));
    });
    list.addEventListener('dragover', e => {
      const row = e.target.closest('.music-row'); if (!row) return;
      e.preventDefault();
      row.classList.add('is-drag-over');
    });
    list.addEventListener('dragleave', e => e.target.closest('.music-row')?.classList.remove('is-drag-over'));
    list.addEventListener('drop', e => {
      const row = e.target.closest('.music-row'); if (!row) return;
      e.preventDefault();
      row.classList.remove('is-drag-over');
      const srcId = e.dataTransfer.getData('text/plain');
      if (srcId && srcId !== row.dataset.id) reorderMusicTrack(srcId, row.dataset.id);
    });
  }

  renderMusicProfileTabs();
  renderMusicPanel();
  renderMusicPlayer();
}

// ─── PROFIL-BEARBEITEN: DIALOG-TRIGGER ─────────────────────
// Öffnet KEIN eigenes Modal — das Bootstrap-Modal-Markup (#musicProfileModal)
// lebt konsistent mit allen anderen Edit-Dialogen in index.html/dialogs/music-modal.js.
// Gleiches CustomEvent-Prinzip wie _openTrackEditModal()/'music:editTrack',
// um einen zirkulären Import music/music-events.js ⇄ dialogs/music-modal.js zu vermeiden.
function _dispatchEditProfile(id) {
  document.dispatchEvent(new CustomEvent('music:editProfile', { detail: { id } }));
}

// Track-Edit-Modal wird von dialogs/music-modal.js bereitgestellt (Bootstrap-
// Modal-Markup lebt konsistent mit allen anderen Edit-Dialogen in index.html)
// und über dieses CustomEvent angestoßen — vermeidet einen zirkulären Import
// music/music-events.js ⇄ dialogs/music-modal.js.
function _openTrackEditModal(trackId) {
  document.dispatchEvent(new CustomEvent('music:editTrack', { detail: { id: trackId } }));
}
