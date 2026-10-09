/**
 * dialogs/music-modal.js — Musik-Track-Bearbeiten- und Playlist-Modal
 */

import { APP } from '../core/state.js';
import { defaultPipelineEffects } from '../audio/fx-pipeline.js';
import { ensureEffectsV2 } from '../fx-model.js';
import { buildIconGrid, syncEntryCardPreview } from '../ui/icon-picker.js';
import { getPresetById } from '../presets.js';
import { stopEffectPreview } from '../audio/preview.js';
import { writeEffectsToUI, readEffectsFromUI, _setFxEditContext, _fxEditContext, getActiveEffectGroupLabels } from './sound-modal.js';
import { _setModalContext } from '../events/utils-modal.js';
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

/** Tiefe Kopie eines Effekt-Objekts (reines JSON — so wird es auch persistiert). Der Draft darf nie
 *  verschachtelte Objekte (lowpass, reverb, eq10.bands …) mit dem gespeicherten Track teilen, sonst
 *  würde schon das Bearbeiten im Effekt-Dialog den echten Track verändern. */
function _cloneEffects(fx) { return JSON.parse(JSON.stringify(fx)); }

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
    const name = '';   // Preset-Namen stehen im Effekt-Dialog je Layer; die Karte zeigt die aktiven Stufen
    summary.innerHTML = '';
    // Preset-Name + Namen der aktiven Effekt-Gruppen — derselbe Überblick wie in der Sound-Karte
    // (getActiveEffectGroupLabels() ist dieselbe Quelle wie dort). textContent: Preset-Namen
    // können benutzerdefiniert sein.
    [name, ...getActiveEffectGroupLabels(fx)].filter(Boolean).forEach(label => {
      const chip = document.createElement('span');
      chip.className = 'sm-fx-summary__chip';
      chip.textContent = label;
      summary.appendChild(chip);
    });
  }
}

// ─── AUDIO-EFFEKTE DES MUSIKSTÜCKS (geteilter Effekt-Dialog) ────────────────────
// Der Musik-Editor besitzt KEINEN eigenen Effekt-Dialog: er nutzt kontextabhängig den
// vollständigen #soundFxModal (alle Gruppen, Presets, eigene Presets, Reset — identische
// Controls, identische read/writeEffectsToUI()-Logik wie Sound/Ambient). Der Dialog ist ein reiner
// Editor für das gestagte Objekt `_musicEditEffects`:
//   öffnen  → writeEffectsToUI(_musicEditEffects)   (DOM wird mit dem Draft befüllt)
//   schließen (X/Fertig/Escape/Backdrop) → _musicEditEffects = readEffectsFromUI()  (nur Draft!)
//   „Musikstück speichern" → setMusicTrackEffects(id, _musicEditEffects)  (erst hier persistiert)
// Abbrechen/Schließen des Musik-Editors verwirft den Draft; der echte Track bleibt unberührt.

/** Dialog-Rahmen für den Musik-Kontext: keine Vorschau/Export (gehören zur Sound-Pipeline), Hinweis im Footer. */
function _applyMusicFxModalChrome(on) {
  const prev = document.getElementById('btnPreviewFx');
  if (prev) prev.style.display = on ? 'none' : '';
  const hint = document.getElementById('fxModalFooterHint');
  if (hint) hint.textContent = on
    ? 'Änderungen wirken erst nach dem Speichern des Musikstücks.'
    : 'Änderungen wirken sofort auf die Vorschau.';
}

/** Öffnet den Effekt-Dialog für den Draft des gerade bearbeiteten Musikstücks. */
export function openMusicFxEditor() {
  if (!_musicEditId || !_musicEditEffects) return;
  stopEffectPreview();
  _setFxEditContext({ kind: 'music', id: _musicEditId });
  _setModalContext('music');            // blendet Sound-/Ambient-spezifische Bereiche (z. B. Export) aus
  writeEffectsToUI(_musicEditEffects);  // DOM ← Draft (inkl. Preset-Auswahl und Master-Schalter)
  _applyMusicFxModalChrome(true);
  bootstrap.Modal.getOrCreateInstance(document.getElementById('soundFxModal')).show();
}

/**
 * Beim Schließen des Effekt-Dialogs (hide.bs.modal — deckt alle Schließwege ab) im Musik-Kontext:
 * Formularstand → Draft, Karte aktualisieren, Dialog-Rahmen und Kontext zurücksetzen. Außerhalb des
 * Musik-Kontexts ein No-op (Sound/Ambient verwalten ihren Draft weiterhin selbst über das DOM).
 */
export function commitMusicFxDraft() {
  if (_fxEditContext.kind !== 'music') return;
  if (_musicEditId && _musicEditEffects) _musicEditEffects = readEffectsFromUI();
  _syncMusicFxCard();
  _applyMusicFxModalChrome(false);
  _setFxEditContext({ kind: 'sound', id: null });
  _setModalContext('sound');
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
  // Tiefe Kopie (vorher flach: `{ ...t.effects }` teilte alle verschachtelten Module mit dem echten Track).
  _musicEditEffects = t.effects ? ensureEffectsV2(_cloneEffects(t.effects)) : defaultPipelineEffects();

  document.getElementById('musicEditName').value   = t.name || '';
  document.getElementById('musicEditArtist').value = t.artist || '';
  document.getElementById('musicEditAlbum').value  = t.album || '';
  document.getElementById('musicEditVol').value    = t.vol ?? 1;
  document.getElementById('musicEditVolLbl').textContent = Math.round((t.vol ?? 1) * 100) + '%';

  buildIconGrid('musicIconGrid', t.icon || '🎵');
  buildColorOpts('musicClrOpts', t.color || 'none');
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

