/**
 * ambient/ambient-render.js — Szenen-Tabs, Track-Listen-Rendering, View-Mode
 */

import { iconSvg, setIcon } from '../ui/icons.js';
import { APP, CAP, CATracks } from '../core/state.js';
import { iconHtmlOr, iconGlyph } from '../utils.js';
import { PENCIL_ICON_SVG, _applyTabAccent } from '../ui/tabs.js';
import { isAmbientPlaying, isAmbientWaiting, _active } from './ambient-playback.js';
import { _persist, ensureAmbientState } from './ambient-model.js';

// ─── UI: SCENE TABS ──────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Renders the ambient scene tabs into #ambProfBar — mirrors renderProfileTabs() for sounds. */
export function renderAmbientProfileTabs() {
  ensureAmbientState();
  const bar    = document.getElementById('ambProfBar');
  const addBtn = document.getElementById('btnAddAmbientProfile');
  if (!bar) return;
  bar.querySelectorAll('.profile-tab').forEach(t => t.remove());

  APP.ambient.profiles.forEach(p => {
    const tab = document.createElement('button');
    tab.className = 'profile-tab' + (p.id === APP.ambient.activeProfileId ? ' is-active' : '');
    tab.dataset.pid = p.id;
    _applyTabAccent(tab, p.color);
    const playingCount = (p.tracks || []).filter(t => isAmbientPlaying(t.id)).length;
    tab.innerHTML =
      `<span class="profile-tab__name">${iconHtmlOr(p.icon, '🌫️', 'profile-tab__icon-img')} ${_esc(p.name)}${playingCount ? ` <span class="profile-tab__live" title="${playingCount} Sound(s) laufen" aria-hidden="true"></span>` : ''}</span>` +
      `<span class="profile-tab__edit" title="Szene bearbeiten" aria-label="Szene bearbeiten">` +
      `${PENCIL_ICON_SVG}</span>`;
    if (addBtn) bar.insertBefore(tab, addBtn); else bar.appendChild(tab);
  });
}

// ─── UI: TRACK LIST RENDERING ────────────────────────────────

function _rowTemplate(t) {
  const playing = isAmbientPlaying(t.id);
  const waiting = playing && isAmbientWaiting(t.id);
  const isGenerator = t.sourceType === 'generator';
  const files   = t.files || [];
  // Noise-Generator-Tracks haben keine Dateien — ohne diese Sonderbehandlung wäre
  // `loaded` für sie immer false und der Play-Button dauerhaft disabled
  // (Generator braucht nichts zu "laden").
  const loaded  = isGenerator || files.some(f => f.data);
  const generatorBadge = isGenerator
    ? `<span class="ambient-row__gen-badge" title="Rauschgenerator">${_esc({white:'White',pink:'Pink',brown:'Brown'}[t.generatorType] || 'Noise')}</span>`
    : '';
  // Sichtbarer Akzent-Rand entsprechend t.color, analog
  // zur Soundkachel. Über --row-accent + .ambient-row--accent (siehe
  // css/ambient.css) statt direktem box-shadow, damit die bestehende
  // .is-playing/.is-waiting-Kennzeichnung unverändert weiterfunktioniert.
  // Bei color === 'none' erscheint kein Akzent.
  const hasAccent  = t.color && t.color !== 'none';
  const accentAttr = hasAccent ? ` style="--row-accent:${t.color};"` : '';
  return `
  <div class="ambient-row${playing ? ' is-playing' : ''}${waiting ? ' is-waiting' : ''}${hasAccent ? ' ambient-row--accent' : ''}" data-id="${t.id}"${accentAttr}>
    <button class="ambient-row__play" data-act="play" ${loaded ? '' : 'disabled'}
      title="${playing ? 'Stoppen' : 'Abspielen'}" aria-label="${playing ? 'Stoppen' : 'Abspielen'}">
      ${iconSvg(playing ? 'square' : 'play')}
    </button>
    <button class="ambient-row__icon" data-act="icon" title="Icon auswählen" aria-label="Icon auswählen">${iconHtmlOr(t.icon, '🌫️', 'ambient-row__icon-img')}</button>
    <input type="text" class="ambient-row__name" data-act="name" value="${_esc(t.name)}" maxlength="30"
      aria-label="Name des Ambient-Sounds" placeholder="Ambient-Name">
    ${generatorBadge}
    <span class="ambient-row__state">${waiting ? 'wartet…' : (playing ? 'spielt…' : '')}</span>
    <button class="ambient-row__opt" data-act="fx" title="Bearbeiten — Grundeinstellungen &amp; Audio-Effekte" aria-label="Ambient-Sound bearbeiten">
      ${iconSvg('pencil')}
    </button>
    <button class="ambient-row__opt" data-act="export" title="Als Datei exportieren" aria-label="Ambient-Sound exportieren">
      ${iconSvg('download')}
    </button>
    <button class="ambient-row__opt ambient-row__opt--danger" data-act="remove" title="Entfernen"
      aria-label="Ambient-Sound entfernen">
      ${iconSvg('trash')}
    </button>
        <div class="ambient-row__vol">
      ${iconSvg('volume-2')}
      <input type="range" class="slider ambient-row__vol-slider" data-act="vol" min="0" max="1" step=".01"
        value="${t.vol}" aria-label="Lautstärke ${_esc(t.name)}">
      <span class="ambient-row__vol-pct">${Math.round(t.vol * 100)}%</span>
    </div>
  </div>`;
}

/** Renders the track list of the currently active ambient scene into #ambientList. */
export function renderAmbientPanel() {
  ensureAmbientState();
  const list  = document.getElementById('ambientList');
  const empty = document.getElementById('ambientEmpty');
  if (!list) return;

  const tracks = CATracks();
  if (empty) empty.style.display = tracks.length ? 'none' : '';
  list.innerHTML = tracks.map(_rowTemplate).join('');

  const mv = document.getElementById('ambientMasterVol');
  if (mv) mv.value = APP.ambient.masterVol ?? 1;
  const mvNum = document.getElementById('ambientMasterVolNum');
  if (mvNum) mvNum.value = Math.round((APP.ambient.masterVol ?? 1) * 100);

  const lbl = document.getElementById('ambientSceneLbl');
  if (lbl) { const p = CAP(); lbl.textContent = p ? `${iconGlyph(p.icon)} ${p.name}` : ''; }
}

// Exportiert: ambient-playback.js ruft _updateRowPlayState() nach jedem Start/Stop
// auf, um die Zeilen-UI zu synchronisieren.
export function _updateRowPlayState(trackId, playing) {
  const waiting = playing && isAmbientWaiting(trackId);
  const row = document.querySelector(`.ambient-row[data-id="${trackId}"]`);
  if (row) {
    row.classList.toggle('is-playing', playing);
    row.classList.toggle('is-waiting', waiting);
    const btn = row.querySelector('[data-act="play"]');
    if (btn) {
      btn.title = playing ? 'Stoppen' : 'Abspielen';
      btn.setAttribute('aria-label', btn.title);
      setIcon(btn.querySelector('.ambient-row__opt'), playing ? 'square' : 'play');
    }
    const badge = row.querySelector('.ambient-row__state');
    if (badge) badge.textContent = waiting ? 'wartet…' : (playing ? 'spielt…' : '');
  }
  // Live-dot on the scene tab, since a track keeps playing across scene/mode switches.
  renderAmbientProfileTabs();

  // Navbar-Indikator an #btnModeAmbient — unabhängig von der sichtbaren Ansicht,
  // gespeist aus dem tatsächlichen Wiedergabestatus (_active-Map, nicht dem zuletzt
  // geklickten Button), analog zum Musik-Indikator (has-live-indicator, s. music.css)
  // und zum Sound-Indikator (s. audio/playback.js: _updateSoundLiveIndicator()).
  // #ambProfBar trägt bereits einen eigenen .profile-tab__live-Indikator pro Szene
  // (renderAmbientProfileTabs() oben) — dieser hier ist bewusst zusätzlich und unabhängig:
  // er zeigt global "irgendwo läuft Ambient", auch während die Sound- oder Musik-Ansicht
  // sichtbar ist.
  const n = _active.size;
  document.getElementById('btnModeAmbient')?.classList.toggle('has-live-indicator', n > 0);
  const liveDesc = document.getElementById('btnModeAmbientLiveDesc');
  if (liveDesc) liveDesc.textContent = n > 0 ? `Wiedergabe aktiv (${n})` : '';
}

// ─── VIEW MODE: SOUND ⇄ AMBIENT ──────────────────────────────

/** Swaps the visible section (sound grid vs. ambient scene) — playback of either keeps running. */
export function setViewMode(mode) {
  ensureAmbientState();
  APP.viewMode = ['sound', 'ambient', 'music'].includes(mode) ? mode : 'sound';
  const soundOn   = APP.viewMode === 'sound';
  const ambientOn = APP.viewMode === 'ambient';
  const musicOn   = APP.viewMode === 'music';

  document.getElementById('profBarRow')?.toggleAttribute('hidden', !soundOn);
  document.getElementById('soundBoard')?.toggleAttribute('hidden', !soundOn);
  document.getElementById('ambProfBarRow')?.toggleAttribute('hidden', !ambientOn);
  document.getElementById('ambientBoard')?.toggleAttribute('hidden', !ambientOn);
  // Stop sitzt zusammen mit der Sound-Lautstärke in #fxToolbar innerhalb von #soundBoard
  // (stoppt nur Sound-Kacheln, s. audio/playback.js) — wird durch das hidden-Attribut auf
  // #soundBoard bereits mitversteckt; dieser Toggle bleibt zusätzlich als explizite
  // Absicherung bestehen.
  document.getElementById('btnStop')?.toggleAttribute('hidden', !soundOn);

  // Musikansicht: nur DOM-Sichtbarkeit umschalten, Playback läuft im
  // Hintergrund unabhängig weiter — siehe music/music-render.js. Dynamischer
  // Import vermeidet einen zirkulären Import ambient/*.js ⇄ music/*.js.
  import('../music/music-render.js').then(m => m.applyMusicViewVisibility(musicOn));

  const bSound = document.getElementById('btnModeSound');
  const bAmb   = document.getElementById('btnModeAmbient');
  const bMusic = document.getElementById('btnModeMusic');
  bSound?.classList.toggle('is-active', soundOn);
  bSound?.setAttribute('aria-pressed', String(soundOn));
  bAmb?.classList.toggle('is-active', ambientOn);
  bAmb?.setAttribute('aria-pressed', String(ambientOn));
  bMusic?.classList.toggle('is-active', musicOn);
  bMusic?.setAttribute('aria-pressed', String(musicOn));

  _persist();
}

