/**
 * events/register-slot-events.js — Trim-Modal-Events, destruktive
 * Slot-Bearbeitung (Normalisieren/Reverse/Fade/Gain/Silence/Noise-Gate/
 * -Reduzieren/Lautheit/Truncate)
 */

import { APP } from '../core/state.js';
import '../utils.js';
import { toast } from '../notifications.js';
import { actx } from '../audio/context.js';
import { invalidateBuffer, getOrDecodeBuffer } from '../audioCache.js';
import { renderSlotList, getSlotEditIndex, markTrimSaved } from '../ui/slot-editor.js';
import { drawTrimWaveform, drawTrimSpectrogram, updateTrimDurLabel } from '../ui/trim-canvas.js';
import { startPeakRmsMeter, stopPeakRmsMeter } from '../ui/meters.js';
import {
  editTrimApply, editNormalize, editReverse, editFadeIn, editFadeOut,
  editGainApply, editRemoveSilence, editNoiseGate, learnNoiseProfile, editNoiseReduce,
  editLoudnessNormalize, editTruncateSilence
} from '../editor.js';
import { findAmbientTrack } from '../ambient/ambient-model.js';
import '../dialogs/ambient-modal.js';
import { _fxEditContext } from '../dialogs/sound-modal.js';
import './utils-modal.js';

export function registerSlotEvents() {
  // ── TRIM MODAL ─────────────────────────────────────────────
  // NOTE: canvas mousedown/mousemove/wheel handled by _initTrimCanvasDrag() in ui/trim-canvas.js,
  // which is called from openTrimModal on 'shown.bs.modal'.

  document.getElementById('trimStart')?.addEventListener('input', () => { updateTrimDurLabel(); drawTrimWaveform(); });
  document.getElementById('trimEnd')?.addEventListener('input',   () => { updateTrimDurLabel(); drawTrimWaveform(); });
  // Fade-Felder lösen ebenfalls updateTrimDurLabel() aus, damit der
  // Clamp-Hinweis (s. ui/slot-editor.js) sofort auf Eingaben reagiert.
  document.getElementById('trimFadeIn')?.addEventListener('input',  updateTrimDurLabel);
  document.getElementById('trimFadeOut')?.addEventListener('input', updateTrimDurLabel);
  // Aufräumen beim Schließen: laufende Vorschau + Meter-Loop nicht über
  // das offene Modal hinaus weiterlaufen lassen (sonst Audio- bzw.
  // rAF-Leak, wenn der Nutzer während der Vorschau auf "Schließen" klickt).
  document.getElementById('trimModal')?.addEventListener('hidden.bs.modal', () => {
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
    stopPeakRmsMeter();
  });

  // Statisches Spektrogramm
  document.getElementById('trimSpectrogramToggle')?.addEventListener('change', function() {
    const cv = document.getElementById('trimSpectrogramCanvas');
    if (!cv) return;
    cv.style.display = this.checked ? 'block' : 'none';
    if (this.checked) drawTrimSpectrogram();
  });

  document.getElementById('btnTrimReset')?.addEventListener('click', () => {
    if (!APP.trim.buf) return;
    document.getElementById('trimStart').value   = '0';
    document.getElementById('trimEnd').value     = APP.trim.buf.duration.toFixed(3);
    document.getElementById('trimFadeIn').value  = '0';
    document.getElementById('trimFadeOut').value = '0';
    document.getElementById('trimZoom').value    = '1';
    APP.trim.zoom         = 1;
    APP.trim.scrollOffset = 0;
    const lbl = document.getElementById('trimZoomLbl'); if (lbl) lbl.textContent = '1×';
    updateTrimDurLabel(); drawTrimWaveform();
  });
  document.getElementById('btnTrimPreview')?.addEventListener('click', () => {
    if (!APP.trim.buf) return;
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
    const ts  = parseFloat(document.getElementById('trimStart').value) || 0;
    const te  = parseFloat(document.getElementById('trimEnd').value)   || APP.trim.buf.duration;
    const ctx = actx(); const gain = ctx.createGain(); gain.gain.value = 0.8;
    // Peak/RMS-Meter: AnalyserNode zwischen Gain und Destination
    // eingeschleift, damit der gemessene Pegel den tatsächlich hörbaren
    // (bereits gain-skalierten) Signalpfad widerspiegelt.
    const meterAnalyser = ctx.createAnalyser();
    meterAnalyser.fftSize = 1024;
    gain.connect(meterAnalyser); meterAnalyser.connect(ctx.destination);
    const src = ctx.createBufferSource(); src.buffer = APP.trim.buf; src.connect(gain);
    src.start(0, ts, te - ts); APP.trim.previewSrc = src;
    startPeakRmsMeter(meterAnalyser);
    src.onended = () => { APP.trim.previewSrc = null; stopPeakRmsMeter(); };
    toast('Vorschau läuft…');
  });
  document.getElementById('btnTrimStop')?.addEventListener('click', () => {
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
    stopPeakRmsMeter();
  });
  document.getElementById('btnTrimSave')?.addEventListener('click', () => {
    if (APP.trim.slotIdx === null || !APP.trim.buf) return;
    const ts = parseFloat(document.getElementById('trimStart').value) || 0;
    const te = parseFloat(document.getElementById('trimEnd').value)   || APP.trim.buf.duration;
    const fi = Math.max(0, parseFloat(document.getElementById('trimFadeIn').value)  || 0);
    const fo = Math.max(0, parseFloat(document.getElementById('trimFadeOut').value) || 0);
    APP.editSlots[APP.trim.slotIdx].trimStart = Math.max(0, ts);
    APP.editSlots[APP.trim.slotIdx].trimEnd   = Math.min(APP.trim.buf.duration, te);
    APP.editSlots[APP.trim.slotIdx].fadeIn    = fi;
    APP.editSlots[APP.trim.slotIdx].fadeOut   = fo;
    // Fade-Kurven
    APP.editSlots[APP.trim.slotIdx].fadeInCurve  = document.getElementById('trimFadeInCurve')?.value  || 'linear';
    APP.editSlots[APP.trim.slotIdx].fadeOutCurve = document.getElementById('trimFadeOutCurve')?.value || 'linear';
    // Trim-Dialog: Werte wurden bewusst übernommen —
    // Guard für dieses eine programmgesteuerte Schließen deaktivieren, damit
    // keine Verwerfen-Rückfrage erscheint.
    markTrimSaved();
    bootstrap.Modal.getInstance(document.getElementById('trimModal')).hide();
    renderSlotList(); toast('Trim übernommen ✓', 'ok');
  });

  // ── DESTRUKTIVE SLOT-BEARBEITUNG ──
  // Verdrahtet die eigene Dialogbox #slotDestructiveModal (aus dem kompakten
  // Slot-Edit-Modal heraus geöffnet, Progressive Disclosure — siehe index.html)
  // mit den Funktionen aus editor.js.
  //
  // Wichtiger Kontext: der Slot-Editor arbeitet mit einer Arbeitskopie
  // (APP.editSlots), die erst beim Speichern des GESAMTEN Sounds in das
  // persistierte Item übernommen wird. editor.js-Funktionen schreiben aber
  // direkt in die persistierte Sound-Struktur + IndexedDB. Deshalb:
  //  1) Destruktive Aktionen sind nur für bereits gespeicherte Slots mit
  //     persistierter Audiodatei erlaubt (sonst gäbe es nichts, worauf die
  //     Funktion dauerhaft schreiben könnte) — der Öffnen-Button prüft das
  //     bereits VOR dem Öffnen der Dialogbox.
  //  2) "Trim anwenden" nutzt explizit die aktuell im Draft sichtbaren
  //     Trim-Werte (nicht die zuletzt gespeicherten), siehe editTrimApply().
  //  3) Nach jeder Aktion werden Cache (_ed_N + bk()-Cache), Trim-Wellenform
  //     und Slot-Edit-Felder aktualisiert, damit UI und Audiodaten wieder
  //     konsistent sind.

  /** Sucht einen Sound anhand der ID über alle Profile hinweg (nicht nur das aktive). */
  function _findSoundAnyProfile(soundId) {
    for (const prof of APP.profiles) {
      const s = (prof.items || []).find(x => x.id === soundId && x.type === 'sound');
      if (s) return s;
    }
    return null;
  }

  // "Dauerhaft bearbeiten" (destruktive Slot-Bearbeitung, s.u.) wird über das
  // GETEILTE #soundModal auch vom Ambient-Track-Editor genutzt
  // (_setModalContext('ambient'), Titel "AMBIENT BEARBEITEN"). openAmbientEffectsModal()
  // setzt APP.editId bewusst auf null (Ambient-Tracks sind kein Sound-Item); die
  // Verfügbarkeitsprüfung darf daher nicht hart APP.editId abfragen und nur in
  // APP.profiles suchen, sonst wäre "Dauerhaft bearbeiten" für Ambient IMMER gesperrt
  // ("Erst speichern, dann dauerhaft bearbeiten"), selbst mit bereits gespeicherter
  // Audiodatei. Diese zwei Helfer lösen die ID/das Item kontextabhängig auf
  // (_fxEditContext, s.o.); editor.js löst Ambient-Tracks bereits selbst über
  // findAmbientTrack() + ein `.slots`-Alias auf `.files` auf (s. dort).
  function _currentEditId() {
    return _fxEditContext.kind === 'ambient' ? _fxEditContext.id : APP.editId;
  }

  function _findEditTargetAnyContext(id) {
    if (_fxEditContext.kind === 'ambient') {
      const t = findAmbientTrack(id);
      if (t) Object.defineProperty(t, 'slots', { value: t.files, enumerable: false, configurable: true });
      return t;
    }
    return _findSoundAnyProfile(id);
  }

  function _persistedSlotHasAudio(soundId, slotIdx) {
    if (!soundId || slotIdx == null) return false;
    const s = _findEditTargetAnyContext(soundId);
    return !!(s && s.slots && s.slots[slotIdx] && s.slots[slotIdx].data);
  }

  function _refreshEditorActionsAvailability() {
    const soundId = _currentEditId();
    const slotIdx = getSlotEditIndex();
    const available = _persistedSlotHasAudio(soundId, slotIdx);
    const body = document.getElementById('editorActionsBody');
    const unavailable = document.getElementById('editorActionsUnavailable');
    if (body)        body.style.display        = available ? '' : 'none';
    if (unavailable) unavailable.style.display = available ? 'none' : '';
    const nrBtn = document.querySelector('#slotDestructiveModal [data-editor-action="noiseReduce"]');
    if (nrBtn) nrBtn.title = APP.noiseProfile ? '' : 'Zuerst „Rauschprofil lernen“ ausführen';
  }

  /** Nach einer destruktiven Editor-Aktion: Caches und UI-Anzeige neu synchronisieren. */
  async function _refreshSlotAfterDestructiveEdit(soundId, slotIdx) {
    const s = _findEditTargetAnyContext(soundId);
    const persistedSlot = s?.slots?.[slotIdx];
    // Ambient-Dateivarianten werden unter ihrer EIGENEN id + Index 0
    // gecacht/gespeichert (s. editor.js: _slotKeyParts()) — dieselbe
    // Schlüsselbasis hier verwenden, sonst wird der falsche Cache-Eintrag
    // invalidiert/neu decodiert.
    const isAmbient = _fxEditContext.kind === 'ambient';
    const keyId  = isAmbient ? (persistedSlot?.id || soundId) : soundId;
    const keyIdx = isAmbient ? 0 : slotIdx;

    invalidateBuffer(keyId, keyIdx);
    delete APP.audioBuffers[`_ed_${slotIdx}`];

    const draftSlot = APP.editSlots?.[slotIdx];

    // Trim wird von manchen Aktionen (v.a. Trim selbst) auf der persistierten
    // Seite zurückgesetzt — Arbeitskopie im offenen Modal muss das spiegeln,
    // sonst zeigt der Trim-Dialog weiter die alten (jetzt ungültigen) Werte.
    if (draftSlot && persistedSlot) {
      draftSlot.trimStart = persistedSlot.trimStart || 0;
      draftSlot.trimEnd   = persistedSlot.trimEnd ?? null;
    }

    let buf = null;
    if (s && persistedSlot?.data) {
      try { buf = await getOrDecodeBuffer(keyId, keyIdx, persistedSlot.data, actx()); }
      catch (e) { console.error('[editor] Buffer-Refresh fehlgeschlagen', e); }
    }
    if (buf) APP.audioBuffers[`_ed_${slotIdx}`] = buf;

    if (getSlotEditIndex() === slotIdx) {
      const durEl = document.getElementById('slotEditDuration');
      if (durEl) durEl.textContent = buf ? buf.duration.toFixed(1) + 's' : '–';
    }

    // Falls der Trim-Dialog gerade für genau diesen Slot offen ist: Wellenform neu zeichnen.
    if (APP.trim.slotIdx === slotIdx && buf) {
      APP.trim.buf = buf;
      drawTrimWaveform();
    }

    renderSlotList();
  }

  async function _onEditorActionClick(action, btn) {
    const soundId = _currentEditId();
    const slotIdx = getSlotEditIndex();
    if (!soundId || slotIdx == null) { toast('Kein Slot ausgewählt', 'err'); return; }
    if (!_persistedSlotHasAudio(soundId, slotIdx)) {
      toast('Erst speichern, dann dauerhaft bearbeiten', 'err');
      return;
    }

    const num = (id, def) => {
      const v = parseFloat(document.getElementById(id)?.value);
      return Number.isFinite(v) ? v : def;
    };

    if (action === 'noiseReduce' && !APP.noiseProfile) {
      toast('Zuerst „Rauschprofil lernen“ ausführen', 'err');
      return;
    }

    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    try {
      switch (action) {
        case 'trim': {
          const sl = APP.editSlots?.[slotIdx];
          await editTrimApply(soundId, slotIdx, sl?.trimStart, sl?.trimEnd);
          break;
        }
        case 'normalize':     await editNormalize(soundId, slotIdx, num('editorNormalizeDb', 0)); break;
        case 'loudness':      await editLoudnessNormalize(soundId, slotIdx, { targetRmsDb: num('editorLoudnessDb', -18) }); break;
        case 'reverse':       await editReverse(soundId, slotIdx); break;
        case 'fadeIn':        await editFadeIn(soundId, slotIdx, num('editorFadeInSec', 0.5), document.getElementById('editorFadeInCurve')?.value || 'linear'); break;
        case 'fadeOut':       await editFadeOut(soundId, slotIdx, num('editorFadeOutSec', 0.5), document.getElementById('editorFadeOutCurve')?.value || 'linear'); break;
        case 'gain':          await editGainApply(soundId, slotIdx, num('editorGainDb', 0)); break;
        case 'removeSilence': await editRemoveSilence(soundId, slotIdx, num('editorSilenceDb', -60)); break;
        case 'truncateSilence': await editTruncateSilence(soundId, slotIdx, { thresholdDb: num('editorSilenceDb', -60), targetSilenceDurationSec: num('editorTruncateSec', 0.3) }); break;
        case 'noiseGate':     await editNoiseGate(soundId, slotIdx, num('editorNoiseGateDb', -40)); break;
        case 'learnNoise':    await learnNoiseProfile(soundId, slotIdx); break;
        case 'noiseReduce':   await editNoiseReduce(soundId, slotIdx, num('editorNoiseReduceAmount', 0.6)); break;
        default: return;
      }
      await _refreshSlotAfterDestructiveEdit(soundId, slotIdx);
    } catch (err) {
      console.error(`[editor] Aktion "${action}" fehlgeschlagen:`, err);
      toast(`Fehler bei "${action}": ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
      _refreshEditorActionsAvailability();
    }
  }

  document.getElementById('slotDestructiveModal')?.addEventListener('shown.bs.modal', _refreshEditorActionsAvailability);

  document.getElementById('btnOpenSlotDestructiveModal')?.addEventListener('click', () => {
    if (!_persistedSlotHasAudio(_currentEditId(), getSlotEditIndex())) {
      toast('Erst diesen Sound speichern, dann dauerhaft bearbeiten', 'err');
      return;
    }
    new bootstrap.Modal(document.getElementById('slotDestructiveModal')).show();
  });

  document.querySelectorAll('#slotDestructiveModal [data-editor-action]').forEach(b => {
    b.addEventListener('click', () => _onEditorActionClick(b.dataset.editorAction, b));
  });

  const _nrAmount = document.getElementById('editorNoiseReduceAmount');
  const _nrLbl    = document.getElementById('editorNoiseReduceAmountLbl');
  _nrAmount?.addEventListener('input', () => {
    if (_nrLbl) _nrLbl.textContent = Math.round(parseFloat(_nrAmount.value) * 100) + '%';
  });

  /** Berechnet eine sinnvolle Startzeit für den nächsten Schritt (Ende des letzten Schritts) */
  function _macroNextStart() {
    if (!APP.macroSteps.length) return 0;
    return +APP.macroSteps.reduce((max, s) => {
      const st  = s.startTime || 0;
      const dur = s.action === 'fadeout' ? (s.fadeDuration || 1000) / 1000 : 0.25;
      return Math.max(max, st + dur);
    }, 0).toFixed(3);
  }


}
