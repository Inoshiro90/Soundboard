/**
 * dialogs/music-modal.js — Musik-Track-Bearbeiten- und Playlist-Modal
 */

import { APP } from '../core/state.js';
import { defaultEffects } from '../audio/effect-graph.js';
import { renderPresetOptions } from '../ui/tabs.js';
import { buildIconGrid } from '../ui/icon-picker.js';
import { buildColorOpts } from '../ui/color-picker.js';
import '../music/music-model.js';

// ─── MUSIC TRACK MODAL ───────────────────────────────────────
// Bewusst ein eigenes, schlankes Modal statt Wiederverwendung des großen
// geteilten Sound/Ambient-Editors — die Feldmenge ist komplett anders
// (Name/Artist/Album/Icon/Farbe/Lautstärke, keine Hotkeys/Zufall/Makro)
// und ein eigenes Modal minimiert das Risiko, den bestehenden
// Sound-/Ambient-Editor versehentlich zu beschädigen.
export let _musicEditId = null;
// Staged Effekt-Objekt für die aktuelle Editier-Sitzung
// des Track-Modals — wird NUR beim Speichern in t.effects übernommen
// (setMusicTrackEffects()), analog zum Draft-Prinzip der übrigen Editoren.
export let _musicEditEffects = null;
// Exportierter Setter: wird von events/register-tile-events.js beim Anwenden eines
// Audio-Effekt-Presets im Track-Modal neu zugewiesen (ES-Module erlauben kein
// Neuzuweisen eines importierten `let`-Bindings).
export function _setMusicEditEffects(fx) { _musicEditEffects = fx; }

export function openMusicTrackModal(trackId) {
  const t = findMusicTrack(trackId);
  if (!t) return;
  _musicEditId = trackId;
  _musicEditEffects = t.effects ? { ...t.effects } : defaultEffects();

  document.getElementById('musicEditName').value   = t.name || '';
  document.getElementById('musicEditArtist').value = t.artist || '';
  document.getElementById('musicEditAlbum').value  = t.album || '';
  document.getElementById('musicEditVol').value    = t.vol ?? 1;
  document.getElementById('musicEditVolLbl').textContent = Math.round((t.vol ?? 1) * 100) + '%';

  buildIconGrid('musicIconGrid', t.icon || '🎵');
  buildColorOpts('musicClrOpts', t.color || 'none');
  renderPresetOptions(document.getElementById('musicEditFxPreset'), _musicEditEffects.preset || '');

  document.getElementById('musicTrackModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#musicTrackModal .icon-picker__cats');
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

