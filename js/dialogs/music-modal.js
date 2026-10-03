/**
 * dialogs/music-modal.js — Musik-Track-Bearbeiten- und Playlist-Modal
 */

import { APP } from '../core/state.js';
import { defaultEffects } from '../audio/effect-graph.js';
import { renderPresetOptions } from '../ui/tabs.js';
import { buildIconGrid, syncEntryCardPreview } from '../ui/icon-picker.js';
import { getPresetById } from '../presets.js';
import { buildColorOpts } from '../ui/color-picker.js';
import '../music/music-model.js';

// ─── MUSIC TRACK MODAL ───────────────────────────────────────
// Eigenes Modal (andere Feldmenge als der geteilte Sound/Ambient-Editor:
// Name/Artist/Album/Icon/Farbe/Lautstärke, keine Hotkeys/Zufall/Makro),
// aber mit demselben Editor-Aufbau und denselben zentralen Komponenten
// (sm-basics-bar, disclosure-group, buildIconGrid/buildColorOpts).
export let _musicEditId = null;
// Staged Effekt-Objekt für die aktuelle Editier-Sitzung
// des Track-Modals — wird NUR beim Speichern in t.effects übernommen
// (setMusicTrackEffects()), analog zum Draft-Prinzip der übrigen Editoren.
export let _musicEditEffects = null;
/** Beendet die Editiersitzung (z.B. nach Verschieben/Duplizieren) — kein Rest-Bezug auf das bearbeitete Stück. */
export function _resetMusicEditId() { _musicEditId = null; _musicEditEffects = null; }
// Exportierter Setter: wird von events/register-tile-events.js beim Anwenden eines
// Audio-Effekt-Presets im Track-Modal neu zugewiesen (ES-Module erlauben kein
// Neuzuweisen eines importierten `let`-Bindings).
export function _setMusicEditEffects(fx) { _musicEditEffects = fx; }

/**
 * Audio-Effekte-Karte des Track-Modals (gleiches Muster wie #fxEnabled/#smFxBadge/
 * #smFxActiveSummary im Sound-Editor): Ein/Aus-Schalter, Aktiv-Badge und Überblick
 * werden ausschließlich aus dem gestagten Effekt-Objekt abgeleitet —
 * effects.enabled ist dasselbe Feld, das die Wiedergabe auswertet
 * (music-playback.js _reconnectSlotFx: `effects?.enabled ? buildEffectChain(...)`).
 */
export function _syncMusicFxCard() {
  const fx = _musicEditEffects || {};
  const on = !!fx.enabled;
  const chk = document.getElementById('musicEditFxEnabled');
  if (chk) chk.checked = on;
  const badge = document.getElementById('musicEditFxBadge');
  if (badge) badge.style.display = on ? '' : 'none';
  const summary = document.getElementById('musicEditFxSummary');
  if (summary) {
    const name = fx.preset ? getPresetById(fx.preset)?.name : '';
    summary.innerHTML = '';
    if (name) {
      const chip = document.createElement('span');
      chip.className = 'sm-fx-summary__chip';
      chip.textContent = name;           // textContent: Preset-Namen können benutzerdefiniert sein
      summary.appendChild(chip);
    }
  }
}

/** Schalter „Audio-Effekte ein/aus“ — ändert nur effects.enabled, Parameter/Preset bleiben erhalten. */
export function setMusicEditFxEnabled(on) {
  if (!_musicEditEffects) return;
  _musicEditEffects.enabled = !!on;
  _syncMusicFxCard();
}

/** Icon + Akzentfarbe in der Einstiegskarte „Darstellung & Organisation“ nachziehen. */
export function syncMusicAppearancePreview() {
  syncEntryCardPreview({
    iconElId: 'musicAppearancePreviewIcon', inputId: 'musicIconInput', fallbackIcon: '🎵',
    colorElId: 'musicAppearancePreviewColor', colorOptsId: 'musicClrOpts'
  });
}

export function openMusicTrackModal(trackId) {
  const t = findMusicTrack(trackId);
  if (!t) return;
  _musicEditId = trackId;
  document.getElementById('musicTrackModalTitle').textContent = 'MUSIKSTÜCK BEARBEITEN';
  _musicEditEffects = t.effects ? { ...t.effects } : defaultEffects();

  document.getElementById('musicEditName').value   = t.name || '';
  document.getElementById('musicEditArtist').value = t.artist || '';
  document.getElementById('musicEditAlbum').value  = t.album || '';
  document.getElementById('musicEditVol').value    = t.vol ?? 1;
  document.getElementById('musicEditVolLbl').textContent = Math.round((t.vol ?? 1) * 100) + '%';

  buildIconGrid('musicIconGrid', t.icon || '🎵');
  buildColorOpts('musicClrOpts', t.color || 'none');
  renderPresetOptions(document.getElementById('musicEditFxPreset'), _musicEditEffects.preset || '');
  _syncMusicFxCard();
  syncMusicAppearancePreview();

  document.getElementById('musicTrackAppearanceModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#musicTrackAppearanceModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });

  new bootstrap.Modal(document.getElementById('musicTrackModal')).show();
}

document.addEventListener('music:editTrack', e => openMusicTrackModal(e.detail?.id));

export function findMusicTrack(id) {
  for (const p of APP.music.profiles) {
    const t = (p.tracks || []).find(x => x.id === id);
    if (t) return t;
  }
  return null;
}


// ─── MUSIC PLAYLIST MODAL ─────────────────────────────────────
// Playlist-Bearbeitung über ein eigenes Modal — gleiches Muster wie openProfileModal()/
// openAmbientProfileModal() (Icon/Farbe über die zentralen Picker).
// Geöffnet über 'music:editProfile' (dispatcht von music/music-events.js), um einen
// zirkulären Import music/music-events.js ⇄ dialogs/music-modal.js zu vermeiden (gleiches Prinzip
// wie 'music:editTrack' oben).
export let _editMusicProfileId = null;

export function openMusicProfileModal(id) {
  _editMusicProfileId = id;
  const p = id ? APP.music.profiles.find(x => x.id === id) : null;

  document.getElementById('musicProfileModalTitle').textContent = id ? 'PLAYLIST BEARBEITEN' : 'NEUE PLAYLIST';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  set('musicProfNameInput', p ? p.name : '');
  set('musicProfIconInput', p ? p.icon : '');

  const delBtn = document.getElementById('btnDelMusicProfile');
  if (delBtn) delBtn.style.display = (id && APP.music.profiles.length > 1) ? '' : 'none';

  buildIconGrid('musicProfIconGrid', p ? p.icon : '🎵');
  buildColorOpts('musicProfColorOpts', p ? (p.color || 'none') : 'none');
  document.getElementById('musicProfileModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#musicProfileModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('musicProfileModal')).show();
}

document.addEventListener('music:editProfile', e => openMusicProfileModal(e.detail?.id));

