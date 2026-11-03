/**
 * events/register-effects-events.js — Effekt-UI-Events (Akkordeon,
 * Preset-Dropdown, alle Effekt-Regler), Sound-Modal-Speichern (inkl.
 * Draft-Guard-Freigabe, Audio-Rollback-Commit)
 */

import { APP, CItems } from '../core/state.js';
import { uid } from '../utils.js';
import { toast } from '../notifications.js';
import { stopItem } from '../audio/playback.js';
import { previewSound, previewNoiseGenerator, previewMusicTrack, stopEffectPreview, setPreviewLoop, setPreviewBypass, schedulePreviewUpdate } from '../audio/preview.js';
import '../presets/effect-presets-data.js';
import { invalidateBuffer } from '../audioCache.js';
import { renderGrid } from '../ui/grid.js';
import { getSlotEditIndex } from '../ui/slot-editor.js';
import { idbDelete, idbGet, audioKey, normalizeSlotAudioStorage, IDB_SENTINEL } from '../db.js';
import { _musicEditId, findMusicTrack } from '../dialogs/music-modal.js';   // P17g: Musik-Vorschau (Entwurf des Musik-Editors)
import { musicBlob } from '../music/music-fx.js';
import { exportSoundItem } from '../storage/import-export.js';
import { collectEntityIds, collectSlotIds, ensureSlotIdentity } from '../storage/normalization.js';   // P18a
import { positionKey, sourceKey, cachedBuffer, dropCachedBuffer, draftBuffer, syncLiveCacheAfterSave } from '../audio/engine/source-registry.js';   // P18b
import '../export.js';
import '../audio/playback.js';
import '../history.js';
import { pickRandomVolume, VOLUME_MODE_VARYING } from '../ambient/ambient-volume.js';
import {
  findAmbientTrack, renameAmbientTrack, setAmbientTrackIcon, setAmbientTrackColor,
  setAmbientTrackEffects, setAmbientTrackVolume, setAmbientVolumeVariance, persistAmbientNow
} from '../ambient/ambient-model.js';
import { renderAmbientPanel } from '../ambient/ambient-render.js';
import '../dialogs/ambient-modal.js';
import {
  readEffectsFromUI, writeEffectsToUI, 
  readPlaybackFromUI, updatePlaybackSectionVisibility, _markActivePlaybackSummary,
  updateEffectSectionVisibility, _fxEditContext, _ambVariantMode,
  _syncAmbientLoopIntervalExclusivity, _syncAppearancePreview,
  _setAmbientVolumeMode, _correctAmbientVolumeInputs, _readAmbientVolumeFromUI, _preloadEditBuffers
} from '../dialogs/sound-modal.js';
import { _releaseSoundDraftGuard } from './utils-modal.js';
import { initFxPipelineModals, currentPreviewEffects } from '../dialogs/fx-pipeline-modals.js';

export function registerEffectsEvents() {
  initFxPipelineModals();   // Pipeline: Übersicht (Ebene 1) + Stufen-/Preset-/Layer-Modals (Ebene 2–3)

  // ── EFFECTS UI EVENTS ──────────────────────────────────────

  // Master enable toggle
  document.getElementById('fxEnabled')?.addEventListener('change', () => {
    updateEffectSectionVisibility();
    schedulePreviewUpdate(currentPreviewEffects);   // Phase 7: Master-Schalter wirkt sofort auf eine laufende Vorschau
  });

  // Audio-Effekte: eigene Dialogbox statt Accordion im Hauptformular
  // (siehe soundFxModal in index.html). Bleibt technisch unabhängig vom
  // Hauptdialog — alle FX-Feld-IDs sind unverändert.
  document.getElementById('btnOpenFxModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('soundFxModal')).show();
  });

  // Darstellung & Organisation: gleiches Muster wie Audio-Effekte — eigene
  // Dialogbox statt drittem Formular-Block im Hauptdialog.
  document.getElementById('btnOpenAppearanceModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('soundAppearanceModal')).show();
  });
  // Vorschau in der Einstiegskarte nachziehen, sobald die Dialogbox
  // schließt — die Karte ist dann wieder sichtbar und muss den aktuellen
  // Stand zeigen (Prinzip: aktive Auswahl bleibt sichtbar).
  document.getElementById('soundAppearanceModal')?.addEventListener('hidden.bs.modal', _syncAppearancePreview);
  // …und schon während der Dialog offen ist live mitziehen, für den Fall,
  // dass beide Dialoge gleichzeitig sichtbar sind (z. B. sehr breiter Screen).
  document.getElementById('eIcon')?.addEventListener('input', _syncAppearancePreview);
  document.getElementById('clrOpts')?.addEventListener('click', _syncAppearancePreview);

  // Wiedergabe & Verhalten: gleiches Muster wie Audio-Effekte/Darstellung —
  // eigene Dialogbox statt drittem/viertem Formular-Block im Hauptdialog.
  document.getElementById('btnOpenPlaybackModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('soundPlaybackModal')).show();
  });

  // Fade-In
  document.getElementById('pbFadeInEnabled')?.addEventListener('change', () => updatePlaybackSectionVisibility());
  document.getElementById('pbFadeInDuration')?.addEventListener('input', function() {
    const lbl = document.getElementById('pbFadeInDurationLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + 's';
  });
  document.getElementById('pbFadeInCurve')?.addEventListener('change', () => _markActivePlaybackSummary());

  // Fade-Out
  document.getElementById('pbFadeOutEnabled')?.addEventListener('change', () => updatePlaybackSectionVisibility());
  document.getElementById('pbFadeOutDuration')?.addEventListener('input', function() {
    const lbl = document.getElementById('pbFadeOutDurationLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + 's';
  });
  document.getElementById('pbFadeOutCurve')?.addEventListener('change', () => _markActivePlaybackSummary());

  // Crossfade
  document.getElementById('pbCrossfadeEnabled')?.addEventListener('change', () => updatePlaybackSectionVisibility());
  document.getElementById('pbCrossfadeDuration')?.addEventListener('input', function() {
    const lbl = document.getElementById('pbCrossfadeDurationLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + 's';
  });
  document.getElementById('pbCrossfadeCurve')?.addEventListener('change', () => _markActivePlaybackSummary());

  // Zufall (#eRnd) lebt in #soundPlaybackModal, ist aber ein eigenständiges Sound-Feld
  // (s.random) — Summary/Badge trotzdem live mitziehen, wenn es umgeschaltet wird.
  document.getElementById('eRnd')?.addEventListener('change', () => _markActivePlaybackSummary());

  // AMBIENT-Kontext: Fade-In/Fade-Out-Kurven, Loop⇄Zeitversetzt-Ausschließlichkeit.
  document.getElementById('ambFadeIn')?.addEventListener('input',  () => _markActivePlaybackSummary());
  document.getElementById('ambFadeOut')?.addEventListener('input', () => _markActivePlaybackSummary());
  document.getElementById('ambFadeInCurve')?.addEventListener('change',  () => _markActivePlaybackSummary());
  document.getElementById('ambFadeOutCurve')?.addEventListener('change', () => _markActivePlaybackSummary());
  // Loop/Zeitversetzt sind echte Buttons (#ambLoopRow/#ambIntervalRow); die internen
  // Boolean-Felder (#ambLoop/#ambIntervalMode) bleiben als verstecktes Zustandsfeld
  // erhalten (Speichern liest .checked).
  document.getElementById('ambLoopRow')?.addEventListener('click', function() {
    const loopEl = document.getElementById('ambLoop');
    const intEl  = document.getElementById('ambIntervalMode');
    if (!loopEl) return;
    loopEl.checked = !loopEl.checked;
    if (loopEl.checked && intEl) intEl.checked = false;
    _syncAmbientLoopIntervalExclusivity();
  });
  document.getElementById('ambIntervalRow')?.addEventListener('click', function() {
    const loopEl = document.getElementById('ambLoop');
    const intEl  = document.getElementById('ambIntervalMode');
    if (!intEl) return;
    intEl.checked = !intEl.checked;
    if (intEl.checked && loopEl) loopEl.checked = false;
    _syncAmbientLoopIntervalExclusivity();
  });

  // Lautstärkevarianz: Konstant/Variierend sind radio-artige Buttons (genau eine Option aktiv,
  // Klick auf die bereits aktive Option ändert nichts). Min/Max werden bei `change` korrigiert
  // (Bereich 0–100, vertauschte Werte tauschen) — Speichern korrigiert nochmals vor dem Lesen.
  document.getElementById('ambVolConstant')?.addEventListener('click', () => _setAmbientVolumeMode('constant'));
  document.getElementById('ambVolVarying')?.addEventListener('click',  () => _setAmbientVolumeMode('varying'));
  ['ambVolumeMin', 'ambVolumeMax'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => { _correctAmbientVolumeInputs(); _markActivePlaybackSummary(); });
  });

  // Lowpass/Highpass/Notch: generierte Controls (ui/effects/, Phase 8) — Beschriftung und Schalter verwaltet der Editor.

  // Wahwah: generierte Controls (ui/effects/, Phase 8).

  // Reverb, Delay: generierte Controls (ui/effects/, Phase 8).

  // 3-Band-EQ, Compressor, Limiter: generierte Controls (ui/effects/, Phase 8).

  // Distortion: generierte Controls (ui/effects/, Phase 8).

  // Ring Modulation: generierte Controls (ui/effects/, Phase 8).

  // Tremolo/Chorus/Flanger: generierte Controls (ui/effects/, Phase 8).

  // WAV Export Button
  document.getElementById('btnExportWav')?.addEventListener('click', () => {
    const id = APP.editId;
    if (!id) { toast('Kein Sound gewählt', 'err'); return; }
    const s = CItems().find(x => x.id === id);
    if (!s) { toast('Sound nicht gefunden', 'err'); return; }
    // Save current UI state to sound before exporting
    const effects = readEffectsFromUI();
    s.effects = effects;
    import('../export.js').then(m => m.exportSoundWav(s));   // ein einziger Exportpfad (B-12)
  });

  // Pitch Shift: generierte Controls (ui/effects/, Phase 8).

  // 10-Band-EQ: generiertes Spezialcontrol (ui/effects/eq10-bands.js, Phase 8) — Regler, Beschriftungen und Reset verwaltet es selbst.

  // IR-Reverb: generierte Controls (ui/effects/, Phase 8).

  // Full export (with audio)
  document.getElementById('btnExportFull')?.addEventListener('click', () => {
    import('../storage/import-export.js').then(m => m.exportDataWithAudio());
  });

  // Spatial 3D: generierte Controls (ui/effects/, Phase 8).

  // Noise Gate: generierte Controls (ui/effects/, Phase 8).
  // Undo / Redo buttons
  document.getElementById('btnUndo')?.addEventListener('click', () => import('../history.js').then(m => m.undo()));
  document.getElementById('btnRedo')?.addEventListener('click', () => import('../history.js').then(m => m.redo()));

  // Sound Modal: MP3 Export button
  document.getElementById('btnExportMp3')?.addEventListener('click', async () => {
    const id = APP.editId; if (!id) return;
    const s  = CItems().find(x => x.id === id); if (!s) return;
    s.effects = readEffectsFromUI();
    const { exportSoundMp3 } = await import('../export.js');
    await exportSoundMp3(s);
  });

  // ── SOUND MODAL SAVE ───────────────────────────────────────

  document.getElementById('btnSaveSound')?.addEventListener('click', async () => {
    // Preview zuerst stoppen, dann speichern, dann schließen.
    // Der hide.bs.modal-Listener oben würde das ohnehin beim anschließenden
    // .hide() nachholen — hier zusätzlich explizit, um die geforderte
    // Reihenfolge unmissverständlich abzubilden.
    stopEffectPreview();
    if (_fxEditContext.kind === 'ambient') {
      const g = id => document.getElementById(id);
      const t = findAmbientTrack(_fxEditContext.id);
      if (!t) { _releaseSoundDraftGuard(); bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide(); return; }

      const name = g('eName').value.trim() || 'Ambient';
      const vol  = parseFloat(g('eVol').value);
      renameAmbientTrack(_fxEditContext.id, name);
      if (!isNaN(vol)) setAmbientTrackVolume(_fxEditContext.id, vol);
      setAmbientTrackEffects(_fxEditContext.id, readEffectsFromUI());

      // Icon + Akzentfarbe ("Darstellung & Organisation") werden auch im Ambient-Kontext
      // angezeigt (s. openAmbientEffectsModal) und müssen deshalb hier gespeichert werden —
      // Kachel-Hintergrund (eTileClr) bleibt bewusst außen vor, da sm-sound-only.
      const icon = g('eIcon')?.value.trim();
      if (icon) setAmbientTrackIcon(_fxEditContext.id, icon);
      const clrEl = document.querySelector('#clrOpts .color-swatch.is-selected');
      setAmbientTrackColor(_fxEditContext.id, clrEl?.dataset.color || 'none');

      // Reconcile file variants (incl. trim) from APP.editSlots back into t.files.
      const keptIds  = new Set();
      const newFiles = [];
      APP.editSlots.forEach(sl => {
        if (!sl || !sl.data) return;
        const fid = sl._fileId || uid();
        keptIds.add(fid);
        newFiles.push({
          id: fid, data: sl.data, fileName: sl.name || 'Datei',
          trimStart: sl.trimStart || 0, trimEnd: sl.trimEnd ?? null
        });
      });
      (t.files || []).forEach(f => {
        if (!keptIds.has(f.id)) { invalidateBuffer(f.id, 0); idbDelete(audioKey(f.id, 0)).catch(() => {}); }
      });
      t.files = newFiles;

      t.loop         = !!g('ambLoop').checked;
      t.intervalMode = !!g('ambIntervalMode').checked;
      const iMin = parseFloat(g('ambIntervalMin').value);
      const iMax = parseFloat(g('ambIntervalMax').value);
      if (!isNaN(iMin)) t.intervalMin = Math.max(0, iMin);
      if (!isNaN(iMax)) t.intervalMax = Math.max(0, iMax);
      const fIn  = parseFloat(g('ambFadeIn').value);
      const fOut = parseFloat(g('ambFadeOut').value);
      if (!isNaN(fIn))  t.fadeIn  = Math.max(0, fIn);
      if (!isNaN(fOut)) t.fadeOut = Math.max(0, fOut);
      t.fadeInCurve  = g('ambFadeInCurve')?.value  || 'linear';
      t.fadeOutCurve = g('ambFadeOutCurve')?.value || 'linear';
      // Crossfade: gemeinsame Felder mit dem Sound-Kontext (pbCrossfade*,
      // s. #soundPlaybackModal) — hier nach t.crossfade statt s.playback.crossfade.
      t.crossfade = readPlaybackFromUI().crossfade;
      t.variantMode = _ambVariantMode;
      // Lautstärkevarianz über den Model-Setter: normalisiert (0…1, min ≤ max), speichert und
      // passt einen gerade laufenden Track live an (ohne neue AudioNodes).
      setAmbientVolumeVariance(_fxEditContext.id, _readAmbientVolumeFromUI());

      persistAmbientNow();
      renderAmbientPanel();
      // Erfolgreich gespeichert — Guard für DIESES eine
      // programmgesteuerte Schließen deaktivieren, sonst würde die
      // Verwerfen-Rückfrage direkt nach dem Speichern nochmal erscheinen.
      _releaseSoundDraftGuard();
      bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
      toast('Gespeichert ✓', 'ok');
      return;
    }
    const g = id => document.getElementById(id);
    const name     = g('eName').value.trim()      || 'SOUND';
    const vol      = parseFloat(g('eVol').value);
    // Pitch hat keine UI mehr (siehe Audio-Effekte → Pitch Shift) — beim
    // Bearbeiten bleibt ein evtl. vorhandener alter Wert einfach erhalten,
    // neue Sounds starten bei 1 (unverändert).
    const pitch    = APP.editId ? (CItems().find(x => x.id === APP.editId)?.pitch || 1) : 1;
    const loop     = g('eLoop').checked;
    const fade     = g('eFade').checked;
    const random   = g('eRnd').checked;
    const hotkey   = g('eHotkey').value.trim();
    const category = g('eCat').value.trim();
    const icon     = g('eIcon').value.trim()      || '🔊';
    const sel      = document.querySelector('#clrOpts .color-swatch.is-selected');
    const color    = sel ? sel.dataset.color : 'none';
    const tcSel    = document.querySelector('#eTileClrOpts .color-swatch.is-selected');
    const tileColor = (tcSel && tcSel.dataset.color !== 'none') ? tcSel.dataset.color : '';
    const tileW    = parseInt(g('eTileW').value)  || null;
    const tileH    = parseInt(g('eTileH').value)  || null;
    const effects  = readEffectsFromUI();
    const playback = readPlaybackFromUI();
    const items    = CItems();

    // BEVOR die internen Tracking-Felder entfernt werden, muss die physische
    // IndexedDB-Position jedes Slots an seine finale (evtl. per Drag-and-Drop veränderte)
    // Reihenfolge angeglichen werden — sonst bleibt Audio nach einem Reorder unter dem
    // alten Index liegen, während die Metadaten schon die neue Reihenfolge zeigen.
    const stableIdForNormalize = APP.editId || APP._pendingSoundId;
    if (stableIdForNormalize) {
      const existingSound   = APP.editId ? items.find(x => x.id === APP.editId) : null;
      const previousSlotCnt = existingSound ? (existingSound.slots || []).length : 0;
      try {
        await normalizeSlotAudioStorage(stableIdForNormalize, APP.editSlots, previousSlotCnt);
      } catch (err) {
        console.error('[events] normalizeSlotAudioStorage fehlgeschlagen:', err);
      }
    }

    // Strip internal-only fields from slots before persisting
    const cleanSlots = APP.editSlots.map(sl => {
      if (!sl) return sl;
      const { _tempId, _idbSlot, _loading, ...rest } = sl; // remove temporary editor-only fields
      return rest;
    });
    // P18a: jeder Slot hat eine stabile Kennung `id`. Neue Slots erhalten eine; vorhandene bleiben, sofern sie nicht
    // mit einer Kennung außerhalb dieses Sounds kollidieren. Kennungen der Slots des bearbeiteten Sounds sind frei.
    {
      const taken = collectEntityIds(APP);
      collectSlotIds(APP, APP.editId).forEach(id => taken.add(id));
      ensureSlotIdentity(cleanSlots, taken);
    }

    if (APP.editId) {
      const s = items.find(x => x.id === APP.editId);
      if (!s) { toast('Sound nicht gefunden', 'err'); return; }
      const oldSlots = (s.slots || []).slice();
      const oldSlotCount = oldSlots.length;
      Object.assign(s, { name, vol, pitch, loop, fade, random, hotkey, category, icon, color, tileColor, tileW, tileH, slots: cleanSlots, curSlot: 0, effects, playback });
      // P18b: Der Laufzeit-Cache ist über die Slot-Identität (`id@rev`) geschlüsselt, nicht mehr über die Position.
      // Gezielt statt komplett: Ein Slot mit unveränderter Kennung UND Revision behält seinen Eintrag (Umordnen ändert
      // den Schlüssel nicht; IndexedDB wurde oben mitverschoben). Entfernte Slots und alte Revisionen (Datei ersetzt)
      // verlieren ihren Eintrag; neue Schlüssel werden verworfen und aus dem Entwurfspuffer neu befüllt. Ohne
      // Entwurfspuffer lädt getOrDecodeBuffer() beim nächsten Abspielen aus IndexedDB nach.
      syncLiveCacheAfterSave(s.id, oldSlots, cleanSlots, APP.editSlots);
      // Positionsschlüssel (Altbestand ohne Kennung) im alten und neuen Bereich verwerfen — früheres Verhalten.
      const maxIdx = Math.max(oldSlotCount, cleanSlots.length);
      for (let i = 0; i < maxIdx; i++) dropCachedBuffer(positionKey(s.id, i));
    } else {
      // Use the pre-generated stable ID (so IDB audio keys already match)
      const id    = APP._pendingSoundId || uid();
      APP._pendingSoundId = null;
      const phId  = APP._phReplacingId;
      const phIdx = phId ? items.findIndex(x => x.id === phId) : -1;
      const newS  = { type: 'sound', id, order: phIdx >= 0 ? items[phIdx].order : 99999, name, vol, pitch, loop, fade, random, hotkey, category, icon, color, tileColor, tileW, tileH, slots: cleanSlots, curSlot: 0, locked: false, effects, playback };
      if (phIdx >= 0) items.splice(phIdx, 1, newS);
      else {
        const firstPH = items.findIndex(x => x.type === 'placeholder');
        if (firstPH >= 0) { newS.order = items[firstPH].order; items.splice(firstPH, 1, newS); }
        else              { newS.order = items.length; items.push(newS); }
      }
      // Copy edit-modal buffers into the main cache for immediate playback (P18b: unter der Slot-Identität)
      syncLiveCacheAfterSave(id, [], cleanSlots, APP.editSlots);
      cleanSlots.forEach((sl, i) => dropCachedBuffer(positionKey(id, i)));
    }
    // Erfolgreich gespeichert — Guard für dieses programmgesteuerte
    // Schließen deaktivieren, damit danach keine Verwerfen-Rückfrage erscheint.
    _releaseSoundDraftGuard();
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gespeichert ✓', 'ok');
  });

  document.getElementById('btnDelSound')?.addEventListener('click', () => {
    if (!APP.editId) return;
    if (!confirm('Diesen Sound wirklich löschen?')) return;
    stopEffectPreview();
    stopItem(APP.editId);
    const items = CItems(); const idx = items.findIndex(x => x.id === APP.editId);
    if (idx >= 0) { const order = items[idx].order; items.splice(idx, 1, { type: 'placeholder', id: uid(), order, locked: false }); }
    // Der ganze Sound wird gelöscht (bereits oben eigens bestätigt) — die
    // separate Unsaved-Changes-Rückfrage beim anschließenden Schließen des
    // Dialogs wäre hier nur verwirrend und wird deshalb unterdrückt.
    _releaseSoundDraftGuard();
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gelöscht');
  });
  document.getElementById('btnExportSound')?.addEventListener('click', () => {
    if (APP.editId) exportSoundItem(APP.editId);
  });

  // Gemeinsame Handler-Funktion statt doppelter Logik — #btnPreviewSound (Sticky-Bar
  // des Sound-Editors) und #btnPreviewFx (Footer von "Audio-Effekte") steuern beide
  // dieselbe, einzige Preview (previewSound()/APP.audioPreview).
  async function _handlePreviewClick() {
    // Ein Klick während einer laufenden ODER ladenden Preview stoppt sie — für Sound UND
    // Ambient, unabhängig vom Dateityp (previewSound()/previewNoiseGenerator() togglen intern,
    // audio/preview.js). Steht bewusst GANZ OBEN: der Stopp darf nie von Kontext, Slots oder
    // Draft-Daten abhängen.
    if (APP.audioPreview.playing || APP.audioPreview.loading) { stopEffectPreview(); return; }

    if (_fxEditContext.kind === 'ambient') { await _startAmbientPreview(); return; }
    // P17g: Musik hat einen eigenen Quellpfad (Media-Element). Nie in den Sound-Pfad fallen: APP.editSlots gehört dort dem
    // zuletzt bearbeiteten Sound bzw. Ambient-Track (Fehler aus Hörliste 17f-2, Punkt 2).
    if (_fxEditContext.kind === 'music') { await _startMusicPreview(); return; }

    const slots = APP.editSlots;
    const hasData = slots.some(sl => sl && sl.data);
    if (!hasData) { toast('Keine Audio-Dateien geladen', 'err'); return; }

    // Den Slot verwenden, der gerade im Slot-Editor offen ist (sofern vorhanden und mit
    // Audio belegt) — sonst den ersten belegten Slot. NICHT hartkodiert Slot 0, der könnte
    // inzwischen leer/entfernt sein (im Draft können einzelne Slots entfernt werden).
    const editIdx = getSlotEditIndex();
    let slotIdx = (editIdx !== null && slots[editIdx]?.data) ? editIdx : slots.findIndex(sl => sl && sl.data);
    if (slotIdx < 0) slotIdx = 0;

    // Build a temporary sound object from the current modal state
    // so preview uses the FULL effect chain (same engine as playback)
    const vol   = parseFloat(document.getElementById('eVol')?.value)   || 1;
    const pitch = APP.editId ? (CItems().find(x => x.id === APP.editId)?.pitch || 1) : 1;
    const effects  = currentPreviewEffects();   // Draft; bei offenem Layer-Modal mit dem aktuellen Layer-Formular (Phase 7)
    const playback = readPlaybackFromUI();

    // Eigene, von der echten Sound-ID losgelöste Preview-ID statt APP.editId zu übernehmen — verhindert, dass die Preview unter
    // demselben activeAudio-Schlüssel wie der ECHTE, gespeicherte Sound landet (der würde sonst z.B. dessen Kachel als „spielend“
    // markieren). Phase 7: Die Preview-ID ist nur ein Name; es werden keine Buffer-Cache-Einträge mehr unter ihr angelegt.
    const tempSound = {
      id:      '_fxpreview_' + (APP.editId || APP._pendingSoundId || 'draft'),
      name:    document.getElementById('eName')?.value || 'Preview',
      slots:   APP.editSlots,
      vol, pitch, loop: !!APP.audioPreview.loop, fade: false, random: false, curSlot: 0, effects, playback
    };

    // Quelle als Buffer-Referenz: ein in dieser Sitzung geladener/ersetzter Entwurfspuffer vor einem unveränderten, unter der
    // ECHTEN Sound-ID gecachten Buffer. Fehlt beides, lädt `_loadEditBuffer` nach (innerhalb des Token-Schutzes).
    // P18b: Entwurfspuffer am Slot-Objekt, sonst der Live-Eintrag derselben Identität (`id@rev`; ersetzte Datei = neue Revision).
    const draftSlot = slots[slotIdx];
    const buffer = draftBuffer(draftSlot) || (APP.editId ? cachedBuffer(sourceKey(draftSlot)) : null) || null;

    try {
      await previewSound(tempSound, slotIdx, { buffer, loadBuffer: _loadEditBuffer });
    } catch(e) {
      console.error('Preview error:', e);
      toast('Vorschau-Fehler: ' + e.message, 'err');
    }
  }

  /**
   * Buffer des Editor-Entwurfs für Slot `i`: der Entwurfspuffer wird beim Öffnen asynchron vorgeladen
   * (_preloadEditBuffers, Audio liegt nur als IDB-Verweis vor). Ein schneller Klick könnte vor
   * dem Abschluss kommen — dann hier nachladen (idempotent: bereits vorhandene Buffer werden
   * übersprungen). Läuft innerhalb des Token-Schutzes von startEffectPreview().
   */
  async function _loadEditBuffer(i) {
    const sl = APP.editSlots[i];
    if (!draftBuffer(sl)) await _preloadEditBuffers();
    return draftBuffer(sl) || null;
  }

  /**
   * AMBIENT-Vorschau — bewusst NICHT die normale Ambient-Wiedergabe (_active in
   * ambient-playback.js). Sie läuft über den isolierten Preview-Lifecycle (APP.audioPreview), wie
   * die Sound-Vorschau, und spielt den EDITOR-ENTWURF (nicht den gespeicherten Track): einen Clip
   * der gerade gewählten Datei-Variante mit den aktuell eingestellten Effekten, Fades und der
   * Entwurfs-Lautstärke. Dadurch
   *   - stoppt der Vorschau-Button nie einen normal laufenden Ambient-Track,
   *   - startet er keinen (kein Eintrag in _active, kein Zeilen-/Tab-Status, kein Auto-Duck),
   *   - bleibt nach dem Schließen des Editors nichts übrig (hide.bs.modal → stopEffectPreview()).
   * Master-Lautstärke und Auto-Duck gelten bewusst nicht (wie bei der Sound-Vorschau).
   * Loop/Zeitversetzt/Crossfade sind Wiedergabe-Verhalten über mehrere Clips und werden in der
   * Vorschau nicht abgebildet — sie spielt immer genau einen Clip. Bei „Variierend" wird je
   * Vorschau-Start ein Zufallswert aus dem Entwurfs-Bereich gewürfelt.
   */
  async function _startAmbientPreview() {
    const g   = id => document.getElementById(id);
    const num = (id, fb) => { const v = parseFloat(g(id)?.value); return Number.isFinite(v) ? v : fb; };

    const vc  = _readAmbientVolumeFromUI();
    const vol = vc.mode === VOLUME_MODE_VARYING
      ? pickRandomVolume(vc.min, vc.max)
      : Math.max(0, Math.min(1, num('eVol', 0.7)));
    const effects = currentPreviewEffects();

    // Rauschgenerator-Tracks haben keine Dateien — eigener Quellpfad im selben Lifecycle.
    const track = findAmbientTrack(_fxEditContext.id);
    if (track?.sourceType === 'generator') {
      try { await previewNoiseGenerator({ generatorType: track.generatorType || 'pink', vol, effects }); }
      catch (e) { console.error('Preview error:', e); toast('Vorschau-Fehler: ' + e.message, 'err'); }
      return;
    }

    const slots = APP.editSlots;
    if (!slots.some(sl => sl && sl.data)) { toast('Keine Audio-Dateien geladen', 'err'); return; }
    const editIdx = getSlotEditIndex();
    let slotIdx = (editIdx !== null && slots[editIdx]?.data) ? editIdx : slots.findIndex(sl => sl && sl.data);
    if (slotIdx < 0) slotIdx = 0;

    const fadeIn  = Math.max(0, num('ambFadeIn', 0));
    const fadeOut = Math.max(0, num('ambFadeOut', 0));
    const tempSound = {
      id:      '_ambpreview_' + _fxEditContext.id,
      name:    g('eName')?.value || 'Preview',
      slots, vol, pitch: 1, loop: !!APP.audioPreview.loop, fade: false, random: false, curSlot: 0, effects,
      playback: {
        fadeIn:    { enabled: fadeIn  > 0, duration: fadeIn,  curve: g('ambFadeInCurve')?.value  || 'linear' },
        fadeOut:   { enabled: fadeOut > 0, duration: fadeOut, curve: g('ambFadeOutCurve')?.value || 'linear' },
        crossfade: { enabled: false, duration: 1, curve: 'linear' }
      }
    };

    const buffer = draftBuffer(slots[slotIdx]) || null;   // Entwurfs-Buffer als Referenz (kein Alias im Cache)

    try {
      await previewSound(tempSound, slotIdx, { buffer, loadBuffer: _loadEditBuffer });   // P17f-3: Ambient führt Tempo aus (Vorschau = Live; Neustart bei Tempo-Änderung wie bei Sounds)
    } catch (e) {
      console.error('Preview error:', e);
      toast('Vorschau-Fehler: ' + e.message, 'err');
    }
  }
  /**
   * MUSIK-Vorschau (Phase 17g) — wie die Ambient-Vorschau isoliert von der normalen Wiedergabe (eigenes Media-Element in
   * audio/preview.js; die Live-Player bleiben unberührt). Spielt den ENTWURF: die gespeicherte Audiodatei des Stücks (der
   * Musik-Editor ersetzt keine Datei), die Effekte aus dem Dialog und die Lautstärke aus dem Musik-Editor. Master- und
   * Musik-Master-Lautstärke gelten wie bei den anderen Vorschauen nicht.
   */
  async function _startMusicPreview() {
    const t = findMusicTrack(_musicEditId);
    if (!t || !t.data) { toast('Keine Audiodatei geladen', 'err'); return; }
    const vol = parseFloat(document.getElementById('musicEditVol')?.value);
    try {
      await previewMusicTrack({
        id:        '_musicpreview_' + t.id,
        name:      t.name || 'Preview',
        vol:       Number.isFinite(vol) ? vol : (t.vol ?? 1),
        trimStart: t.trimStart || 0,
        effects:   currentPreviewEffects(),
        // Eigene Blob-URL der Vorschau (preview.js gibt sie frei) — nicht der Cache _blobUrls der Live-Wiedergabe.
        loadUrl: async () => {
          const b64 = t.data === IDB_SENTINEL ? await idbGet(audioKey(t.id, 0)) : t.data;
          return b64 ? URL.createObjectURL(musicBlob(b64)) : null;
        }
      });
    } catch (e) {
      console.error('Preview error:', e);
      toast('Vorschau-Fehler: ' + e.message, 'err');
    }
  }
  document.getElementById('btnPreviewSound')?.addEventListener('click', _handlePreviewClick);
  document.getElementById('btnPreviewFx')?.addEventListener('click', _handlePreviewClick);
  // Phase 7: Vorschau auch im Layer-Modal (dort wird geregelt), Loop (ab dem nächsten Start) und A/B (Effekte klickfrei umgehen).
  document.getElementById('btnPreviewFxLayer')?.addEventListener('click', _handlePreviewClick);
  for (const id of ['btnPreviewLoop', 'btnPreviewLoopLayer']) document.getElementById(id)?.addEventListener('click', () => setPreviewLoop(!APP.audioPreview.loop));
  for (const id of ['btnPreviewAB', 'btnPreviewABLayer']) document.getElementById(id)?.addEventListener('click', () => setPreviewBypass(!APP.audioPreview.bypass));


}
