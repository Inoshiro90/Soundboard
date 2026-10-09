/**
 * events/register-tile-events.js — Kachel-Grid-Klicks, Tile-Edit-Modus,
 * Toolbar-Anlege-Buttons, Musik-/Ambient-Modal-Verdrahtung, Bulk-Import
 * (inkl. Race-Condition-Schutz), Ton-Generator
 */

import { iconSvg } from '../ui/icons.js';
import { APP, CP } from '../core/state.js';
import { uid } from '../utils.js';
import { toast } from '../notifications.js';
import { actx } from '../audio/context.js';
import { stopAll } from '../audio/playback.js';
import { bindPreviewModalLifecycle } from '../audio/preview.js';
import { defaultEffects } from '../audio/effect-graph.js';
import { applyPresetEffects, getPresetById } from '../presets.js';
import { audioBufferToWavBlob } from '../export.js';
import { generateToneBuffer } from '../generators.js';
import { renderGrid } from '../ui/grid.js';
import { renderProfileTabs, applyProfileSettings } from '../ui/tabs.js';
import { isTileEditMode, setTileEditMode } from '../ui/drag-drop.js';
import { syncThemeIcon } from '../ui/icon-picker.js';
import { renderSlotList } from '../ui/slot-editor.js';
import { createModalDraftGuard } from '../modalGuards.js';
import { IDB_SENTINEL, idbSet, audioKey } from '../db.js';
import { exportProfile, exportMusicTrack, importData } from '../storage/import-export.js';
import { save, resetAll, saveSlotAudio } from '../storage/persistence.js';
import { mkProfile, mkPH, STARTER_PLACEHOLDER_COUNT } from '../storage/factories.js';
import '../ambient/ambient-playback.js';
import {
  resetAmbient, saveAmbientProfile, deleteAmbientProfile, setAmbientTrackIcon
} from '../ambient/ambient-model.js';
import { renderAmbientPanel, renderAmbientProfileTabs } from '../ambient/ambient-render.js';
import { editMusicTrackMeta, setMusicTrackEffects, removeMusicTrack, deleteMusicProfile, saveMusicProfile, setMusicTrackVolume } from '../music/music-model.js';
import '../music/music-render.js';
import { openProfileModal } from '../dialogs/profile-modals.js';
import { openAmbientProfileModal } from '../dialogs/ambient-modal.js';
import { openMacroModal } from '../dialogs/macro-modal.js';
import { openSoundModal } from '../dialogs/sound-modal.js';
import { _fxEditContext, _setAmbVariantMode, _syncPlaybackSettingsIndicator, _markActivePlaybackSummary, _backupAudioKeyOnce, _discardAudioRollback } from '../dialogs/sound-modal.js';
import { _musicEditId, _musicEditEffects, _setMusicEditEffects, _editMusicProfileId, _syncMusicFxCard, setMusicEditFxEnabled, syncMusicAppearancePreview, openMusicFxEditor, commitMusicFxDraft } from '../dialogs/music-modal.js';
import { _editAmbientProfileId, _editAmbientTrackId } from '../dialogs/ambient-modal.js';
import { switchProfile, openSoundFxToolbar, openAmbientFxToolbar, openMusicFxToolbar } from './register-toolbar-events.js';
import { _setSoundDraftGuard, _soundDraftBaseline, _snapshotSoundDraft } from './utils-modal.js';

export function registerTileEvents() {
  // EIN zentraler Schließschutz für #soundModal über hide.bs.modal (fängt
  // Abbruch/X/Backdrop/Escape und programmatische .hide()-Aufrufe gleichermaßen ab —
  // s. modalGuards.js). Wird hier genau einmal instanziiert (registerEvents() läuft nur
  // einmal beim Start, s. main.js), damit kein mehrfach registrierter Listener entsteht;
  // openSoundModal()/openAmbientEffectsModal() rufen bei jedem Öffnen nur
  // _armSoundDraftGuard() auf, um die Sitzung neu "scharf" zu stellen.
  _setSoundDraftGuard(createModalDraftGuard({
    modalId: 'soundModal',
    isDirty: () => _soundDraftBaseline !== null && _snapshotSoundDraft() !== _soundDraftBaseline,
    message: 'Es gibt ungespeicherte Änderungen. Wenn du die Dialogbox jetzt schließt, gehen diese Änderungen verloren. Dialogbox wirklich schließen?',
    onDiscard: () => _discardAudioRollback(),
  }));

  // Effekt-Editor-Preview  IMMER beenden,
  // sobald #soundModal zu schließen beginnt — unabhängig davon, ob über X,
  // Abbruch, Backdrop, Escape oder programmatisch nach Speichern/Löschen
  // geschlossen wird (hide.bs.modal deckt alle diese Wege einheitlich ab,
  // s. modalGuards.js/_soundDraftGuard oben). Bewusst ein EIGENER, separater
  // Listener statt in den Draft-Guard eingebaut: der Draft-Guard kann das
  // Schließen bei ungespeicherten Änderungen per preventDefault() zunächst
  // verhindern — die Preview soll aber so oder so sofort stoppen, damit nie
  // Audio über eine ggf. blockierende Rückfrage hinweg weiterläuft. Einmalig
  // hier registriert (registerEvents() läuft nur einmal, s. main.js).
  bindPreviewModalLifecycle(document.getElementById('soundModal'));

  // Theme toggle
  document.getElementById('btnTheme')?.addEventListener('click', () => {
    const html    = document.documentElement;
    const current = html.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    html.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
    syncThemeIcon();
  });

  // Profile bar (event delegation)
  document.getElementById('profBar')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.profile-tab__edit');
    const tab     = e.target.closest('.profile-tab');
    if (editBtn) { const pid = tab?.dataset.pid; if (pid) openProfileModal(pid); return; }
    if (tab)     { switchProfile(tab.dataset.pid); }
  });
  document.getElementById('btnAddProfile')?.addEventListener('click', () => openProfileModal(null));

  // Export-Button am rechten Rand der Tab-Leiste — exportiert immer das AKTIVE
  // Profil, unabhängig davon, welches zuletzt per Stift bearbeitet wurde
  // (exportProfile() aus storage/import-export.js).
  document.getElementById('btnExportProfileTab')?.addEventListener('click', () => {
    const p = CP();
    if (p) exportProfile(p.id); else toast('Kein Soundeffekt-Profil vorhanden', 'err');
  });

  // Profile modal
  // Das Audio-Effekte-Preset lebt nicht in diesem Dialog (s. #soundFxToolbarModal/
  // _profFxSection) — wird hier bewusst NICHT mitgelesen/-gespeichert, um kein stilles
  // Überschreiben mit einem veralteten Select-Wert zu riskieren (der Select existiert im
  // DOM, nur eben in einem anderen Dialog).
  document.getElementById('btnSaveProfile')?.addEventListener('click', () => {
    const name  = document.getElementById('profNameInput').value.trim() || 'Profil';
    const icon  = document.getElementById('profIconInput').value.trim() || '🎵';
    const clrEl = document.querySelector('#profColorOpts .color-swatch.is-selected');
    const color = clrEl?.dataset.color || 'none';
    if (APP.editProfileId) {
      const p = APP.profiles.find(x => x.id === APP.editProfileId);
      if (p) { p.name = name; p.icon = icon; p.color = color; }
    } else {
      const np = mkProfile(name, icon, color);
      for (let i = 0; i < STARTER_PLACEHOLDER_COUNT; i++) np.items.push(mkPH(i));
      APP.profiles.push(np);
      APP.activeProfileId = np.id;
    }
    bootstrap.Modal.getInstance(document.getElementById('profModal')).hide();
    renderProfileTabs(); renderGrid(); toast('Profil gespeichert', 'ok');
  });
  document.getElementById('btnDelProfile')?.addEventListener('click', () => {
    if (APP.profiles.length <= 1) { toast('Letztes Profil kann nicht gelöscht werden', 'err'); return; }
    if (!confirm('Profil wirklich löschen?')) return;
    APP.profiles        = APP.profiles.filter(x => x.id !== APP.editProfileId);
    APP.activeProfileId = APP.profiles[0].id;
    bootstrap.Modal.getInstance(document.getElementById('profModal')).hide();
    renderProfileTabs(); renderGrid(); toast('Profil gelöscht');
  });
  // Der Export-Button liegt am rechten Rand der Tab-Leiste (#btnExportProfileTab in
  // #profBarRow), nicht im Bearbeiten-Dialog.

  // Ambient scene modal
  document.getElementById('btnAddAmbientProfile')?.addEventListener('click', () => openAmbientProfileModal(null));
  // Das Audio-Effekte-Preset lebt nicht in diesem Dialog (s. #ambientFxToolbarModal/
  // _ambProfFxSection) — saveAmbientProfile() lässt p.audioEffectPreset bei fehlendem
  // 5. Argument bewusst unangetastet (s. Kommentar dort), daher wird hier nichts übergeben.
  document.getElementById('btnSaveAmbientProfile')?.addEventListener('click', () => {
    const name  = document.getElementById('ambProfNameInput').value.trim() || 'Szene';
    const icon  = document.getElementById('ambProfIconInput').value.trim() || '🌫️';
    const clrEl = document.querySelector('#ambProfColorOpts .color-swatch.is-selected');
    const color = clrEl?.dataset.color || 'none';
    saveAmbientProfile(_editAmbientProfileId, name, icon, color);
    bootstrap.Modal.getInstance(document.getElementById('ambProfModal')).hide();
    toast('Szene gespeichert', 'ok');
  });
  document.getElementById('btnDelAmbientProfile')?.addEventListener('click', () => {
    if (APP.ambient.profiles.length <= 1) { toast('Letzte Szene kann nicht gelöscht werden', 'err'); return; }
    if (!confirm('Ambient-Szene wirklich löschen? Alle enthaltenen Sounds werden entfernt.')) return;
    deleteAmbientProfile(_editAmbientProfileId);
    bootstrap.Modal.getInstance(document.getElementById('ambProfModal')).hide();
    toast('Szene gelöscht');
  });
  // Der Export-Button liegt am rechten Rand der Tab-Leiste (#btnExportAmbientProfileTab
  // in #ambProfBarRow), nicht im Bearbeiten-Dialog.

  // Ambient track icon modal
  document.getElementById('btnApplyAmbientTrackIcon')?.addEventListener('click', () => {
    const icon = document.getElementById('ambTrackIconInput').value.trim();
    if (_editAmbientTrackId && icon) setAmbientTrackIcon(_editAmbientTrackId, icon);
    bootstrap.Modal.getInstance(document.getElementById('ambTrackIconModal')).hide();
  });

  // Toolbar — Rastergröße kommt vollständig aus grid-system.css (--grid-cols je
  // Breakpoint); es gibt keine manuellen Spalten/Reihen-Felder.

  // Master volume
  document.getElementById('masterVol')?.addEventListener('input', function() {
    const val = parseFloat(this.value);
    APP.globalSettings.masterVol = val;
    const numEl = document.getElementById('masterVolNum');
    if (numEl) numEl.value = Math.round(val * 100);
  });
  document.getElementById('masterVolNum')?.addEventListener('input', function() {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const val  = pct / 100;
    APP.globalSettings.masterVol = val;
    const slEl = document.getElementById('masterVol');
    if (slEl) slEl.value = val;
  });
  document.getElementById('btnStop')?.addEventListener('click', stopAll);
  document.getElementById('btnSave')?.addEventListener('click', save);

  // ─── Musik-Track-Bearbeiten-Modal ────────────────────────────
  document.getElementById('musicEditVol')?.addEventListener('input', function () {
    document.getElementById('musicEditVolLbl').textContent = Math.round(parseFloat(this.value) * 100) + '%';
  });
  // Audio-Effekte: Ein/Aus-Schalter + eigene Dialogbox (wie #fxEnabled/#btnOpenFxModal)
  document.getElementById('musicEditFxEnabled')?.addEventListener('change', function() {
    setMusicEditFxEnabled(this.checked);
  });
  // „Bearbeiten“ öffnet den vollständigen, geteilten #soundFxModal im Musik-Kontext
  // (Preset-Auswahl, alle Effektgruppen, eigene Presets — dieselben Handler wie bei Sound/Ambient
  // aus register-effects-events.js/register-preset-events.js). Der Formularstand wandert beim
  // Schließen NUR in den Draft _musicEditEffects (commitMusicFxDraft); persistiert wird erst
  // über #btnMusicEditSave.
  document.getElementById('btnOpenMusicTrackFxModal')?.addEventListener('click', openMusicFxEditor);
  document.getElementById('soundFxModal')?.addEventListener('hide.bs.modal', e => {
    if (e.target === e.currentTarget) commitMusicFxDraft();
  });
  // Darstellung & Organisation: Einstiegskarte -> Dialogbox, Vorschau live nachziehen
  document.getElementById('btnOpenMusicAppearanceModal')?.addEventListener('click', () => {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('musicTrackAppearanceModal')).show();
  });
  document.getElementById('musicTrackAppearanceModal')?.addEventListener('hidden.bs.modal', syncMusicAppearancePreview);
  document.getElementById('musicIconInput')?.addEventListener('input', syncMusicAppearancePreview);
  document.getElementById('musicClrOpts')?.addEventListener('click', syncMusicAppearancePreview);
  document.getElementById('btnMusicEditSave')?.addEventListener('click', () => {
    if (!_musicEditId) return;
    const icon  = document.getElementById('musicIconInput').value.trim();
    const clrEl = document.querySelector('#musicClrOpts .color-swatch.is-selected');
    editMusicTrackMeta(_musicEditId, {
      name:   document.getElementById('musicEditName').value,
      artist: document.getElementById('musicEditArtist').value,
      album:  document.getElementById('musicEditAlbum').value,
      icon:   icon || undefined,
      color:  clrEl?.dataset.color
    });
    setMusicTrackVolume(_musicEditId, parseFloat(document.getElementById('musicEditVol').value));
    setMusicTrackEffects(_musicEditId, _musicEditEffects);
    bootstrap.Modal.getInstance(document.getElementById('musicTrackModal'))?.hide();
  });
  document.getElementById('btnMusicEditDelete')?.addEventListener('click', () => {
    if (!_musicEditId) return;
    if (!confirm('Dieses Musikstück wirklich löschen?')) return;
    removeMusicTrack(_musicEditId);
    bootstrap.Modal.getInstance(document.getElementById('musicTrackModal'))?.hide();
  });
  document.getElementById('btnMusicEditExport')?.addEventListener('click', () => {
    if (_musicEditId) exportMusicTrack(_musicEditId);
  });

  // ─── Musik-Playlist-Modal ──────────────────────────────────
  // Das Audio-Effekte-Preset lebt nicht in diesem Dialog (s. #musicFxToolbarModal/
  // _musicProfFxSection) — analog zu btnSaveAmbientProfile.
  document.getElementById('btnSaveMusicProfile')?.addEventListener('click', () => {
    const name  = document.getElementById('musicProfNameInput').value.trim() || 'Playlist';
    const icon  = document.getElementById('musicProfIconInput').value.trim() || '🎵';
    const clrEl = document.querySelector('#musicProfColorOpts .color-swatch.is-selected');
    const color = clrEl?.dataset.color || 'none';
    saveMusicProfile(_editMusicProfileId, name, icon, color);
    bootstrap.Modal.getInstance(document.getElementById('musicProfileModal')).hide();
    toast('Playlist gespeichert', 'ok');
  });
  document.getElementById('btnDelMusicProfile')?.addEventListener('click', () => {
    if (!_editMusicProfileId) return;
    if (!confirm('Playlist wirklich löschen? Alle enthaltenen Musikstücke werden entfernt.')) return;
    const ok = deleteMusicProfile(_editMusicProfileId);
    if (ok) {
      bootstrap.Modal.getInstance(document.getElementById('musicProfileModal')).hide();
      toast('Playlist gelöscht');
    }
  });
  // Der Export-Button liegt am rechten Rand der Tab-Leiste (#btnExportMusicProfileTab
  // in #musicProfBarRow), nicht im Bearbeiten-Dialog.

  // ─── Bearbeitungsmodus (Kacheln) — Fertig-Button + Tap-außerhalb ──
  // Umschaltung per Toolbar-Button #btnTileEditMode (Long-Press verschiebt direkt die
  // Kachel, siehe ui/drag-drop.js setupTileEditGestures). #btnTileEditMode muss von der
  // "Klick außerhalb schließt den Modus"-Erkennung ausgenommen werden — sonst würde das
  // pointerdown-Ereignis des eigenen Klicks den Modus schon VOR dem click-Handler unten
  // schließen, der ihn dann direkt wieder öffnet (pointerdown feuert vor click → Toggle
  // würde nie richtig "aus" gehen).
  document.getElementById('btnExitEditMode')?.addEventListener('click', () => setTileEditMode(false));
  document.getElementById('btnTileEditMode')?.addEventListener('click', () => setTileEditMode(!isTileEditMode()));
  document.addEventListener('pointerdown', e => {
    if (!isTileEditMode()) return;
    if (e.target.closest('#grid') || e.target.closest('#editModeBar') || e.target.closest('#btnTileEditMode')) return;
    setTileEditMode(false);
  });

  // ─── Direkter Anlege-Einstieg in der Toolbar (+ Sound / + Makro) ──
  document.getElementById('btnToolbarAddSound')?.addEventListener('click', () => openSoundModal(null));
  document.getElementById('btnToolbarAddMacro')?.addEventListener('click', () => openMacroModal(null));

  // Makro-Erstellung lebt außerdem weiterhin im "+"-Menü leerer Kacheln
  // (ui/grid.js: _openTileAddChoice → openMacroModal(null, placeholderId))
  // für den Fall, dass eine bestimmte leere Kachel befüllt werden soll.

  // Wiedergabe-Einstellungen: Dialogbox — #btnPlaybackSettingsToggle ist ein normaler
  // Dialog-Trigger.
  document.getElementById('btnPlaybackSettingsToggle')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('playbackSettingsModal')).show();
  });
  document.getElementById('setOverlap')?.addEventListener('change',    e => { APP.globalSettings.overlap    = e.target.checked; _syncPlaybackSettingsIndicator(); });
  document.getElementById('setStopReplay')?.addEventListener('change', e => { APP.globalSettings.stopReplay = e.target.checked; _syncPlaybackSettingsIndicator(); });
  document.getElementById('setMultiClick')?.addEventListener('change', e => { APP.globalSettings.multiClick = e.target.checked; _syncPlaybackSettingsIndicator(); });

  // Lautstärke: Dialogbox — #masterVol/#masterVolNum.
  document.getElementById('btnOpenSoundVolumeModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('soundVolumeModal')).show();
  });

  // Audio-Effekte des aktiven Kontexts — je ein eigener
  // Toolbar-Button pro Ansicht, neben "Lautstärke".
  document.getElementById('btnOpenSoundFxToolbar')?.addEventListener('click', openSoundFxToolbar);
  document.getElementById('btnOpenAmbientFxToolbar')?.addEventListener('click', openAmbientFxToolbar);
  document.getElementById('btnOpenMusicFxToolbar')?.addEventListener('click', openMusicFxToolbar);

  // Auto Duck (Ambient): globale Wiedergabe-Einstellung, siehe
  // audio/playback.js notifyDuckTrigger()/notifyDuckRelease() + ambient/ambient-playback.js duckAmbient().
  document.getElementById('setAutoDuck')?.addEventListener('change', e => {
    APP.globalSettings.autoDuck.enabled = e.target.checked;
    _syncPlaybackSettingsIndicator();
  });
  document.getElementById('setAutoDuckAmount')?.addEventListener('input', function() {
    APP.globalSettings.autoDuck.amount = parseFloat(this.value);
    const lbl = document.getElementById('setAutoDuckAmountLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
    _syncPlaybackSettingsIndicator();
  });
  _syncPlaybackSettingsIndicator();

  // Verwalten / Speichern / Undo / Redo — leben gemeinsam im
  // "Einstellungen"-Popover (js/ui/disclosure.js regelt Öffnen/Schließen,
  // hier nur noch die fachliche Aktion je Button; Undo/Redo-Klicks werden
  // weiter unten im Datei-Setup registriert).
  document.getElementById('btnExport')?.addEventListener('click', () => {
    import('../storage/import-export.js').then(m => m.exportData());
  });
  document.getElementById('btnImportTrigger')?.addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f) return;
    importData(f, {
      onSuccess: () => {
        applyProfileSettings(); renderProfileTabs(); renderGrid();
        renderAmbientProfileTabs(); renderAmbientPanel();
        import('../music/music-render.js').then(m => { m.renderMusicProfileTabs(); m.renderMusicPanel(); m.renderMusicPlayer(); });
        toast('Import ✓', 'ok');
      }
    });
  });
  document.getElementById('btnReset')?.addEventListener('click', () => {
    resetAll({
      onDone: () => {
        applyProfileSettings(); renderProfileTabs(); renderGrid(); resetAmbient();
        import('../music/music-model.js').then(m => m.resetMusic());
      }
    });
  });


  document.getElementById('btnAddSlot')?.addEventListener('click', () => {
    APP.editSlots.push({ data: null, name: 'Leer', trimStart: 0, trimEnd: null, _fileId: null, _tempId: uid() });
    renderSlotList();
  });
  document.getElementById('slotFile')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f || APP.loadingSlotIdx === null) return;
    const r = new FileReader();
    r.onload = async e => {
      const b64 = e.target.result.split(',')[1];
      const idx = APP.loadingSlotIdx;
      if (_fxEditContext.kind === 'ambient') {
        const fileId = APP.editSlots[idx]?._fileId || uid();
        // Vor dem Überschreiben den bisherigen Wert dieses Keys
        // für diese Sitzung sichern (nur beim ersten Mal, s. _backupAudioKeyOnce).
        await _backupAudioKeyOnce(audioKey(fileId, 0));
        await idbSet(audioKey(fileId, 0), b64);
        APP.editSlots[idx] = { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null, _fileId: fileId, _tempId: uid() };
      } else {
        // Use the pre-generated stable ID so IDB key matches the eventual sound ID.
        const stableId = APP.editId || APP._pendingSoundId || uid();
        if (!APP._pendingSoundId && !APP.editId) APP._pendingSoundId = stableId;
        await _backupAudioKeyOnce(audioKey(stableId, idx));
        await saveSlotAudio(stableId, idx, b64, null);
        APP.editSlots[idx] = { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null, _idbSlot: idx, _tempId: uid() };
      }
      try {
        const bin = atob(b64); const arr = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
        const decoded = await actx().decodeAudioData(arr.buffer.slice(0));
        APP.audioBuffers[`_ed_${idx}`] = decoded;
      } catch (err) {
        console.warn('[events] slotFile decode error:', err?.message || err);
      } finally {
        renderSlotList();
      }
    };
    r.readAsDataURL(f);
  });
  document.getElementById('btnBulk')?.addEventListener('click', () => document.getElementById('bulkFile').click());

  // Tone Generator: Sweep-Modus blendet Fest-/Start-End-Frequenzfelder um.
  document.getElementById('toneSweepMode')?.addEventListener('change', function() {
    const fixedRow = document.getElementById('toneFixedFreqRow');
    const sweepRow = document.getElementById('toneSweepFreqRow');
    if (fixedRow) fixedRow.style.display = this.checked ? 'none' : '';
    if (sweepRow) sweepRow.style.display = this.checked ? 'flex' : 'none';
  });

  document.getElementById('btnToneGenerate')?.addEventListener('click', async () => {
    const idx = APP.loadingSlotIdx;
    if (idx === null || idx === undefined) { toast('Kein Slot ausgewählt', 'err'); return; }
    const isSweep = !!document.getElementById('toneSweepMode')?.checked;
    const opts = {
      waveform:    document.getElementById('toneWaveform')?.value || 'sine',
      durationSec: parseFloat(document.getElementById('toneDuration')?.value) || 2,
      amplitudeDb: parseFloat(document.getElementById('toneAmplitude')?.value),
    };
    if (Number.isNaN(opts.amplitudeDb)) opts.amplitudeDb = -12;
    let name;
    if (isSweep) {
      opts.startFrequency = parseFloat(document.getElementById('toneStartFreq')?.value) || 100;
      opts.endFrequency   = parseFloat(document.getElementById('toneEndFreq')?.value)   || 10000;
      name = `Sweep ${opts.startFrequency}–${opts.endFrequency}Hz`;
    } else {
      opts.frequency = parseFloat(document.getElementById('toneFrequency')?.value) || 440;
      name = `Ton ${opts.frequency}Hz`;
    }

    const btn = document.getElementById('btnToneGenerate');
    const origHtml = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = iconSvg('loader-circle', 'ui-icon--spin');
    try {
      const ctx  = actx();
      const buf  = generateToneBuffer(ctx, opts);
      const blob = audioBufferToWavBlob(buf);
      const b64  = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = e => resolve(e.target.result.split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });

      // Gleicher Ziel-Slot-Schreibpfad wie beim Datei-Upload (#slotFile
      // oben) — der generierte Ton wird wie eine importierte Datei
      // behandelt, kein Sonderfall im restlichen Code nötig.
      if (_fxEditContext.kind === 'ambient') {
        const fileId = APP.editSlots[idx]?._fileId || uid();
        await _backupAudioKeyOnce(audioKey(fileId, 0));
        await idbSet(audioKey(fileId, 0), b64);
        APP.editSlots[idx] = { data: IDB_SENTINEL, name, trimStart: 0, trimEnd: null, _fileId: fileId, _tempId: uid() };
      } else {
        const stableId = APP.editId || APP._pendingSoundId || uid();
        if (!APP._pendingSoundId && !APP.editId) APP._pendingSoundId = stableId;
        await _backupAudioKeyOnce(audioKey(stableId, idx));
        await saveSlotAudio(stableId, idx, b64, null);
        APP.editSlots[idx] = { data: IDB_SENTINEL, name, trimStart: 0, trimEnd: null, _idbSlot: idx, _tempId: uid() };
      }
      APP.audioBuffers[`_ed_${idx}`] = buf;
      renderSlotList();
      bootstrap.Modal.getInstance(document.getElementById('toneGeneratorModal'))?.hide();
      toast(`${name} erzeugt und eingesetzt ✓`, 'ok');
    } catch (err) {
      console.error('[events] Tone-Generator fehlgeschlagen:', err);
      toast('Erzeugen fehlgeschlagen: ' + err.message, 'err');
    } finally {
      btn.disabled = false; btn.innerHTML = origHtml;
    }
  });

  document.getElementById('bulkFile')?.addEventListener('change', function() {
    const files = [...this.files]; if (!files.length) return;

    // Bulk-Import: Race-Condition-Schutz. Alle Ziel-Indizes (emptyIdx/slotIdx) werden
    // SYNCHRON, VOR jedem await und VOR jedem FileReader-Start, eindeutig reserviert —
    // nicht erst im jeweiligen FileReader.onload-Callback: Da mehrere FileReader nahezu
    // gleichzeitig fertig werden können, würden mehrere Callbacks denselben "nächsten
    // leeren Slot"/dieselbe Array-Länge lesen, BEVOR einer von ihnen APP.editSlots
    // tatsächlich verändert hat (mehrere Dateien landeten im selben Slot-Index bzw. unter
    // demselben IndexedDB-Key, andere bekämen gar keinen Slot).
    //
    // Dazu wird sofort ein Platzhalter-Slot-Objekt an die jeweils reservierte Position
    // geschrieben (entweder ein existierender leerer Slot wird belegt, oder das Array
    // wird sofort um einen neuen Platzhalter erweitert). Jede Datei bekommt dadurch
    // bereits vor jeglicher Asynchronität ihren garantiert eigenen, festen Index —
    // unabhängig davon, in welcher Reihenfolge FileReader/IndexedDB/decodeAudioData
    // später fertig werden.
    const targets = [];
    files.forEach(f => {
      // WICHTIG: `!sl.data` bestimmt "leer". Der Platzhalter braucht daher
      // einen WAHRHEITSWERTIGEN Sentinel (nicht null!) — sonst würde die
      // NÄCHSTE Datei in derselben Schleife denselben, gerade erst
      // reservierten Slot erneut als "leer" erkennen und ihn ebenfalls
      // beanspruchen (exakt dieselbe Race Condition, nur eine Ebene
      // höher). '_loading: true' markiert ihn zusätzlich als "wird
      // gerade importiert" für die UI.
      const emptyIdx = APP.editSlots.findIndex(sl => !sl.data);
      const slotIdx  = emptyIdx >= 0 ? emptyIdx : APP.editSlots.length;
      const placeholder = { data: '__pending__', name: f.name, trimStart: 0, trimEnd: null, _loading: true, _tempId: uid() };
      if (emptyIdx >= 0) APP.editSlots[emptyIdx] = placeholder;
      else               APP.editSlots.push(placeholder);
      targets.push({ file: f, slotIdx, slotObj: placeholder });
      console.debug(`[BULK] file="${f.name}" -> slot=${slotIdx} (reserviert)`);
    });
    renderSlotList();

    let okCount = 0, errCount = 0;
    let pending = targets.length;

    targets.forEach(({ file: f, slotIdx, slotObj }) => {
      const r = new FileReader();
      r.onload = async e => {
        try {
          const b64 = e.target.result.split(',')[1];
          let idbSlot = slotIdx;
          if (_fxEditContext.kind === 'ambient') {
            const fileId = slotObj._fileId || uid();
            await _backupAudioKeyOnce(audioKey(fileId, 0));
            await idbSet(audioKey(fileId, 0), b64);
            Object.assign(slotObj, { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null, _fileId: fileId });
            delete slotObj._loading;
          } else {
            const stableId = APP.editId || APP._pendingSoundId || uid();
            if (!APP._pendingSoundId && !APP.editId) APP._pendingSoundId = stableId;
            await _backupAudioKeyOnce(audioKey(stableId, slotIdx));
            await saveSlotAudio(stableId, slotIdx, b64, null);
            console.debug(`[BULK] file="${f.name}" -> slot=${slotIdx} -> idbKey=${audioKey(stableId, slotIdx)}`);
            Object.assign(slotObj, { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null, _idbSlot: idbSlot });
            delete slotObj._loading;
          }

          const bin = atob(b64); const arr = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
          const decoded = await actx().decodeAudioData(arr.buffer.slice(0));
          // Slot könnte inzwischen per Drag-and-Drop verschoben worden
          // sein — _ed_N folgt dem Slot-Objekt über ui/slot-editor.js' Reorder-Resync,
          // daher hier bewusst weiterhin über den ursprünglich reservierten
          // slotIdx schreiben: renderSlotList()/der Resync-Mechanismus
          // hält _ed_N synchron zur aktuellen Position des Objekts.
          APP.audioBuffers[`_ed_${slotIdx}`] = decoded;
          okCount++;
        } catch (err) {
          errCount++;
          console.warn('[events] bulkFile decode error:', err?.message || err);
        } finally {
          if (--pending === 0) {
            renderSlotList();
            if (errCount === 0) toast(`${okCount} Dateien importiert ✓`, 'ok');
            else toast(`${okCount} Dateien importiert, ${errCount} fehlgeschlagen`, errCount === targets.length ? 'err' : 'ok');
          }
        }
      };
      r.onerror = () => {
        errCount++;
        console.warn('[events] bulkFile read error:', f.name);
        if (--pending === 0) {
          renderSlotList();
          toast(`${okCount} Dateien importiert, ${errCount} fehlgeschlagen`, errCount === targets.length ? 'err' : 'ok');
        }
      };
      r.readAsDataURL(f);
    });
  });

  // Ambient basics: variant-mode toggle (Zufällig / Rotierend)
  document.getElementById('ambVariantRandom')?.addEventListener('click', function() {
    _setAmbVariantMode('random');
    this.classList.add('is-active');
    document.getElementById('ambVariantRotate')?.classList.remove('is-active');
    _markActivePlaybackSummary();
  });
  document.getElementById('ambVariantRotate')?.addEventListener('click', function() {
    _setAmbVariantMode('rotate');
    this.classList.add('is-active');
    document.getElementById('ambVariantRandom')?.classList.remove('is-active');
    _markActivePlaybackSummary();
  });

  // Sound modal: volume slider ↔ number input sync
  document.getElementById('eVol')?.addEventListener('input', function() {
    const numEl = document.getElementById('eVolNum');
    if (numEl) numEl.value = Math.round(parseFloat(this.value) * 100);
  });
  document.getElementById('eVolNum')?.addEventListener('input', function() {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const slEl = document.getElementById('eVol');
    if (slEl) slEl.value = pct / 100;
  });


}
