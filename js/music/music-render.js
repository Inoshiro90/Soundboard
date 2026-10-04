/**
 * music/music-render.js — Playlist-Tabs, Track-Liste, Player-UI, View-Mode
 */

import { iconSvg, setIcon } from '../ui/icons.js';
import { APP } from '../core/state.js';
import { iconHtmlOr, fmtTime } from '../utils.js';
import { PENCIL_ICON_SVG, _applyTabAccent } from '../ui/tabs.js';
// `buildIconGrid`/`buildColorOpts` waren bereits im ursprünglichen music.js
// importiert, aber nie aufgerufen (toter Import) — mechanisch mit übernommen.
import '../ui/icon-picker.js';
import '../ui/color-picker.js';
import { ensureMusicState, _findTrack } from './music-model.js';
import { isMusicPlaying, _orderedTracks, _players, _activeSlot, _updateProgressUI } from './music-playback.js';

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}


// ─── RENDERING ─────────────────────────────────────────────────

/** Mirrors renderProfileTabs()/renderAmbientProfileTabs() — linksbündiger
 *  Name, rechtsbündiger Edit-Button, Lucide-Pencil-Icon. */
export function renderMusicProfileTabs() {
  ensureMusicState();
  const bar    = document.getElementById('musicProfBar');
  const addBtn = document.getElementById('btnAddMusicProfile');
  if (!bar) return;
  bar.querySelectorAll('.profile-tab').forEach(t => t.remove());

  APP.music.profiles.forEach(p => {
    const tab = document.createElement('button');
    const isActive = p.id === APP.music.activeProfileId;
    const hasLive  = (p.tracks || []).some(t => t.id === APP.music.activeTrackId) && isMusicPlaying();
    tab.className = 'profile-tab' + (isActive ? ' is-active' : '');
    tab.dataset.pid = p.id;
    _applyTabAccent(tab, p.color);
    tab.innerHTML =
      `<span class="profile-tab__name">${iconHtmlOr(p.icon, '🎵', 'profile-tab__icon-img')} ${_esc(p.name)}${hasLive ? ' <span class="profile-tab__live" title="Musik läuft" aria-hidden="true"></span>' : ''}</span>` +
      `<span class="profile-tab__edit" title="Playlist bearbeiten" aria-label="Playlist bearbeiten">${PENCIL_ICON_SVG}</span>`;
    bar.insertBefore(tab, addBtn);
  });
}

function _trackRowTemplate(t) {
  const isActive  = t.id === APP.music.activeTrackId;
  const isPlaying = isActive && isMusicPlaying();
  const rec       = isActive ? _players?.[_activeSlot] : null;
  const pct       = rec && rec.audio.duration ? Math.min(100, (rec.audio.currentTime / rec.audio.duration) * 100) : 0;
  // t.color als Akzent nutzen — analog zu Soundkachel/Ambient-Track, nie als
  // Vollfarben-Hintergrund.
  const hasAccent  = t.color && t.color !== 'none';
  const accentAttr = hasAccent ? ` style="--row-accent:${t.color};"` : '';
  return `
  <div class="music-row${isActive ? ' is-active' : ''}${isPlaying ? ' is-playing' : ''}${hasAccent ? ' music-row--accent' : ''}" data-id="${t.id}"${accentAttr}>
    <span class="music-row__handle" draggable="true" title="Ziehen zum Neuanordnen" aria-label="${_esc(t.name)} neu anordnen">
      ${iconSvg('grip-vertical')}
    </span>
    <button class="music-row__play" data-act="play" ${t.data ? '' : 'disabled'}
      title="${isPlaying ? 'Pause' : 'Abspielen'}" aria-label="${isPlaying ? 'Pause' : 'Abspielen'} — ${_esc(t.name)}">
      ${iconSvg(isPlaying ? 'pause' : 'play')}
    </button>
    <span class="music-row__icon" aria-hidden="true">${iconHtmlOr(t.icon, '🎵', 'music-row__icon-img')}</span>
    <div class="music-row__info">
      <span class="music-row__name">${_esc(t.name)}</span>
      ${t.artist ? `<span class="music-row__artist">${_esc(t.artist)}${t.album ? ' — ' + _esc(t.album) : ''}</span>` : ''}
      <div class="music-row__progress" aria-hidden="true"><div class="music-row__progress-fill" style="width:${pct}%"></div></div>
    </div>
    <span class="music-row__duration">${t.duration ? fmtTime(t.duration) : '—:—'}</span>
    <div class="music-row__vol-group">
      <span class="music-row__vol-icon" aria-hidden="true">${iconSvg('volume-2')}</span>
      <input type="range" class="slider music-row__vol" data-act="vol" min="0" max="1" step=".01" value="${t.vol}"
        aria-label="Lautstärke ${_esc(t.name)}">
      <input type="number" class="music-row__vol-num" data-act="volnum" min="0" max="100" step="1"
        value="${Math.round((t.vol ?? 1) * 100)}" aria-label="Lautstärke ${_esc(t.name)} in Prozent">
    </div>
    <div class="music-row__reorder">
      <button class="music-row__reorder-btn" data-act="up" title="Nach oben" aria-label="${_esc(t.name)} nach oben verschieben">${iconSvg('chevron-up')}</button>
      <button class="music-row__reorder-btn" data-act="down" title="Nach unten" aria-label="${_esc(t.name)} nach unten verschieben">${iconSvg('chevron-down')}</button>
    </div>
    <button class="music-row__opt" data-act="edit" title="Bearbeiten" aria-label="${_esc(t.name)} bearbeiten">${iconSvg('pencil')}</button>
    <button class="music-row__opt music-row__opt--danger" data-act="remove" title="Löschen" aria-label="${_esc(t.name)} löschen">
      ${iconSvg('trash')}
    </button>
  </div>`;
}

export function renderMusicPanel() {
  ensureMusicState();
  const list  = document.getElementById('musicList');
  const empty = document.getElementById('musicEmpty');
  if (!list) return;
  const tracks = _orderedTracks();
  if (empty) empty.style.display = tracks.length ? 'none' : '';
  list.innerHTML = tracks.map(_trackRowTemplate).join('');
}

export function renderMusicPlayer() {
  ensureMusicState();
  const track = _findTrack(APP.music.activeTrackId);
  const playing = isMusicPlaying();

  const nameEl = document.getElementById('musicPlayerName');
  if (nameEl) nameEl.textContent = track ? track.name : 'Kein Track ausgewählt';

  const playBtn = document.getElementById('btnMusicPlayPause');
  if (playBtn) {
    playBtn.disabled = !track;
    playBtn.title = playing ? 'Pause' : 'Abspielen';
    playBtn.setAttribute('aria-label', playBtn.title);
    setIcon(playBtn.querySelector('.ui-icon'), playing ? 'pause' : 'play');
  }

  const repeatBtn = document.getElementById('btnMusicRepeat');
  if (repeatBtn) {
    const mode = APP.music.repeatMode;
    repeatBtn.classList.toggle('is-active', mode !== 'off');
    repeatBtn.setAttribute('aria-pressed', String(mode !== 'off'));
    repeatBtn.title = mode === 'off' ? 'Wiederholen: Aus' : mode === 'all' ? 'Wiederholen: Alle' : 'Wiederholen: Ein Track';
    repeatBtn.setAttribute('aria-label', repeatBtn.title);
    repeatBtn.classList.toggle('is-repeat-one', mode === 'one');
  }

  const shuffleBtn = document.getElementById('btnMusicShuffle');
  if (shuffleBtn) {
    shuffleBtn.classList.toggle('is-active', APP.music.shuffle);
    shuffleBtn.setAttribute('aria-pressed', String(APP.music.shuffle));
  }

  const mv = document.getElementById('musicMasterVol');
  if (mv) mv.value = APP.music.masterVol ?? 1;
  const mvNum = document.getElementById('musicMasterVolNum');
  if (mvNum) mvNum.value = Math.round((APP.music.masterVol ?? 1) * 100);

  const cfSel = document.getElementById('musicCrossfade');
  if (cfSel) cfSel.value = String(APP.music.crossfade);
  const apChk = document.getElementById('musicAutoplay');
  if (apChk) apChk.checked = !!APP.music.autoplay;

  _updateProgressUI();
  // Live-Indikator am Mode-Toggle-Button — analog zum Ambient-Muster.
  document.getElementById('btnModeMusic')?.classList.toggle('has-live-indicator', playing);
  // Ergänzende, nicht rein farbliche Statusvermittlung (analog zu den Sound-/Ambient-
  // Indikatoren, s. audio/playback.js/ambient/ambient-render.js) — der Punkt (::after)
  // allein trägt die Information nicht.
  const liveDesc = document.getElementById('btnModeMusicLiveDesc');
  if (liveDesc) liveDesc.textContent = playing ? 'Wiedergabe aktiv' : '';
  renderMusicProfileTabs();
}


// ─── VIEW-MODE-INTEGRATION (aufgerufen von ambient/ambient-render.js: setViewMode) ────
// Playback läuft unabhängig von der Sichtbarkeit weiter — diese Funktion schaltet nur
// die DOM-Sichtbarkeit, nie Play/Pause.

export function applyMusicViewVisibility(isMusicView) {
  document.getElementById('musicProfBarRow')?.toggleAttribute('hidden', !isMusicView);
  document.getElementById('musicBoard')?.toggleAttribute('hidden', !isMusicView);
  if (isMusicView) { renderMusicPanel(); renderMusicPlayer(); }
}

