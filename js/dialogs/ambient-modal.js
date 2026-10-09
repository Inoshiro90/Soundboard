/**
 * dialogs/ambient-modal.js — Ambient-Szenen-/Track-Modals: Effekt-Editor
 * (teilt sich #soundModal mit dialogs/sound-modal.js), Szenen-Anlegen/
 * -Bearbeiten, Track-Icon-Auswahl
 */

import { APP } from '../core/state.js';
import { uid } from '../utils.js';
import { stopEffectPreview } from '../audio/preview.js';
import { defaultEffects, defaultPlayback } from '../audio/effect-graph.js';
import { renderSlotList } from '../ui/slot-editor.js';
import { buildIconGrid } from '../ui/icon-picker.js';
import { buildColorOpts } from '../ui/color-picker.js';
import { findAmbientTrack } from '../ambient/ambient-model.js';
import { _setModalContext, _armSoundDraftGuard } from '../events/utils-modal.js';
// Weiche Kopplung an dialogs/sound-modal.js: der Effekt-Editor-Dialog wird
// zwischen Sound-Kacheln und Ambient-Tracks geteilt (identisches FX-
// Akkordeon), daher mehrere Importe von dort.
import { writeEffectsToUI, writePlaybackToUI, _syncAmbientLoopIntervalExclusivity, _resetAudioRollback, _syncAppearancePreview, _preloadEditBuffers, _setFxEditContext, _ambVariantMode, _setAmbVariantMode, _writeAmbientVolumeToUI } from '../dialogs/sound-modal.js';
import { getAmbientVolumeConfig } from '../ambient/ambient-volume.js';

export function openAmbientEffectsModal(trackId) {
  const t = findAmbientTrack(trackId);
  if (!t) return;
  _setFxEditContext({ kind: 'ambient', id: trackId });
  APP.editId = null;

  Object.keys(APP.audioBuffers).forEach(k => {
    if (k.startsWith('_ed_')) delete APP.audioBuffers[k];
  });
  // Frische Audio-Rollback-Sicherung für diese Editiersitzung.
  _resetAudioRollback();
  // Defensiv, s. openSoundModal().
  stopEffectPreview();

  _setModalContext('ambient');
  document.getElementById('sMTitle').textContent = 'AMBIENT BEARBEITEN';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  const chk = (elId, val) => { const el = document.getElementById(elId); if (el) el.checked = val; };

  set('eName',   t.name);
  set('eVol',    t.vol ?? 0.7);
  set('eVolNum', Math.round((t.vol ?? 0.7) * 100));

  // "Darstellung & Organisation" (Icon + Akzentfarbe) ist auch im Ambient-Kontext
  // sichtbar (.sm-entry-card ist nicht sm-sound-only) — muss hier daher ebenfalls befüllt
  // werden, analog zu openSoundModal() oben. "Kachel-Hintergrund" (eTileClrOpts) bleibt
  // sm-sound-only und wird deshalb hier bewusst NICHT befüllt.
  buildIconGrid('iconGrid', t.icon || '🌫️');
  buildColorOpts('clrOpts', t.color || 'none');

  chk('ambLoop',         !!t.loop);
  chk('ambIntervalMode', !!t.intervalMode);
  set('ambIntervalMin',  t.intervalMin ?? 10);
  set('ambIntervalMax',  t.intervalMax ?? 30);
  set('ambFadeIn',       t.fadeIn  ?? 2);
  set('ambFadeOut',      t.fadeOut ?? 2);
  set('ambFadeInCurve',  t.fadeInCurve  || 'linear');
  set('ambFadeOutCurve', t.fadeOutCurve || 'linear');
  _syncAmbientLoopIntervalExclusivity();
  // Lautstärkevarianz (Modus + Min/Max in %). getAmbientVolumeConfig() liefert auch für ältere/
  // importierte Tracks ohne die Felder gültige Werte, ohne den Track zu verändern.
  _writeAmbientVolumeToUI(getAmbientVolumeConfig(t));

  _setAmbVariantMode(t.variantMode === 'rotate' ? 'rotate' : 'random');
  document.getElementById('ambVariantRandom')?.classList.toggle('is-active', _ambVariantMode === 'random');
  document.getElementById('ambVariantRotate')?.classList.toggle('is-active', _ambVariantMode === 'rotate');

  const delBtn = document.getElementById('btnDelSound');
  if (delBtn) delBtn.style.display = 'none'; // deletion is handled from the ambient row itself
  // Verschieben/Duplizieren (Szenenwechsel) sind im Ambient-Kontext verfügbar.
  ['btnEditMove', 'btnEditDuplicate'].forEach(bid => {
    const b = document.getElementById(bid);
    if (b) b.style.display = '';
  });

  APP.editSlots = (t.files || []).map(f => ({
    data: f.data, name: f.fileName || 'Datei', trimStart: f.trimStart || 0, trimEnd: f.trimEnd ?? null, _fileId: f.id, _tempId: uid()
  }));
  if (!APP.editSlots.length) APP.editSlots = [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null, _fileId: null, _tempId: uid() }];
  renderSlotList();
  _preloadEditBuffers();

  writeEffectsToUI(t.effects);
  // "Wiedergabe & Verhalten": Fade-In/Fade-Out-UI ist kontextabhängig
  // (SOUND- vs. AMBIENT-Variante, s. index.html), nur Crossfade
  // (pbCrossfade*) ist ein GEMEINSAMES Feld — hier mit t.crossfade befüllen.
  // pbFadeIn/pbFadeOut selbst bleiben unberührt (unsichtbar in diesem
  // Kontext, s. _setModalContext('ambient')), damit sie beim nächsten
  // Sound-Editieren nicht versehentlich einen Ambient-Rest zeigen —
  // schreibt schon der nächste openSoundModal()-Aufruf frisch.
  writePlaybackToUI({ ...defaultPlayback(), crossfade: t.crossfade || defaultPlayback().crossfade });
  _syncAppearancePreview();

  document.getElementById('soundModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#soundModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });

  // Baseline für den Dirty-Vergleich erst jetzt einfrieren.
  _armSoundDraftGuard();

  new bootstrap.Modal(document.getElementById('soundModal')).show();
}

document.addEventListener('ambient:editEffects', e => openAmbientEffectsModal(e.detail?.id));


// ─── AMBIENT SCENE MODAL ───────────────────────────────────────

export let _editAmbientProfileId = null;

export function openAmbientProfileModal(id) {
  _editAmbientProfileId = id;
  const p = id ? APP.ambient.profiles.find(x => x.id === id) : null;

  document.getElementById('ambProfModalTitle').textContent = id ? 'SZENE BEARBEITEN' : 'NEUE SZENE';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  set('ambProfNameInput', p ? p.name : '');
  set('ambProfIconInput', p ? p.icon : '');

  const delBtn = document.getElementById('btnDelAmbientProfile');
  if (delBtn) delBtn.style.display = (id && APP.ambient.profiles.length > 1) ? '' : 'none';

  buildIconGrid('ambProfIconGrid', p ? p.icon : '🌫️');
  buildColorOpts('ambProfColorOpts', p ? (p.color || 'none') : 'none');
  document.getElementById('ambProfModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#ambProfModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('ambProfModal')).show();
}

document.addEventListener('ambient:editProfile', e => openAmbientProfileModal(e.detail?.id || null));


// ─── AMBIENT TRACK ICON MODAL ───────────────────────────────────

export let _editAmbientTrackId = null;

export function openAmbientTrackIconModal(trackId) {
  _editAmbientTrackId = trackId;
  const t = APP.ambient.profiles.flatMap(p => p.tracks).find(x => x.id === trackId);

  buildIconGrid('ambTrackIconGrid', t ? t.icon : '🌫️');
  const inp = document.getElementById('ambTrackIconInput');
  if (inp) inp.value = t ? t.icon : '';
  document.getElementById('ambTrackIconModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#ambTrackIconModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('ambTrackIconModal')).show();
}

document.addEventListener('ambient:pickTrackIcon', e => openAmbientTrackIconModal(e.detail?.id));

