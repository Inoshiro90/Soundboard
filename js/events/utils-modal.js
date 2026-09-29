/**
 * events/utils-modal.js — Gemeinsame Modal-Helfer: Kontext-Tracking,
 * Farbauswahl-Lesung, Draft-Snapshot/-Guard für den Sound-/Ambient-Editor
 */

import { APP } from '../core/state.js';
// Zirkulärer Import (sound-modal.js importiert umgekehrt _setModalContext/
// _readSelectedColor/_snapshotSoundDraft/_armSoundDraftGuard aus diesem
// Modul) — unkritisch, da alle betroffenen Bezeichner Funktionsdeklarationen
// sind (analog zum bereits etablierten Muster).
import { readEffectsFromUI, readPlaybackFromUI, _commitAudioRollback, _fxEditContext, _ambVariantMode } from '../dialogs/sound-modal.js';

// ─── SOUND-EDITOR DRAFT GUARD (Unsaved-Changes-Schutz) ────
// Bewacht #soundModal zentral über EIN hide.bs.modal-Listener (s. modalGuards.js)
// statt über separate Handler pro Schließweg (Abbruch/X/Backdrop/Escape).
// _soundDraftBaseline hält den Stand direkt nach dem Öffnen (nach dem
// vollständigen Befüllen aller Felder) fest; ein Abweichen davon beim
// Schließen löst die Rückfrage aus. Wird in registerEvents() einmalig
// instanziiert (siehe dort) — dafür der exportierte Setter unten (ES-Module
// erlauben kein Neuzuweisen eines importierten `let`-Bindings).
export let _soundDraftGuard    = null;
export let _soundDraftBaseline = null;
export function _setSoundDraftGuard(guard) { _soundDraftGuard = guard; }

export function _setModalContext(kind) {
  document.querySelectorAll('.sm-sound-only').forEach(el => { el.style.display = kind === 'sound' ? '' : 'none'; });
  document.querySelectorAll('.sm-ambient-only').forEach(el => { el.style.display = kind === 'ambient' ? '' : 'none'; });
}

export function _readSelectedColor(containerId) {
  const sel = document.querySelector(`#${containerId} .color-swatch.is-selected`);
  return sel ? sel.dataset.color : 'none';
}

/**
 * Baut einen vergleichbaren, deterministischen Schnappschuss des kompletten
 * Sound-/Ambient-Editor-Drafts: Stammdaten + ALLE Effektfelder aus readEffectsFromUI()
 * + die vollständige Slot-Liste inkl. einer Audio-Revisionskennung (_tempId — ein
 * Audio-Austausch lässt sich nicht am Sentinel slot.data allein erkennen). Wird beim
 * Öffnen als Baseline gespeichert und beim Schließen erneut gebildet — nur ein
 * tatsächlicher Unterschied zwischen beiden gilt als "dirty": ändert der Benutzer einen
 * Wert und stellt ihn exakt zurück, ist der Editor danach wieder als unverändert erkannt.
 */
export function _snapshotSoundDraft() {
  const g   = id => document.getElementById(id);
  const val = id => g(id)?.value ?? '';
  const chk = id => !!g(id)?.checked;

  const snap = {
    kind: _fxEditContext.kind,
    name: val('eName'),
    vol:  val('eVol'),
    effects: readEffectsFromUI(),
    slots: (APP.editSlots || []).map(sl => ({
      tempId:       sl?._tempId ?? null,
      hasData:      !!(sl && sl.data),
      name:         sl?.name || '',
      trimStart:    sl?.trimStart || 0,
      trimEnd:      sl?.trimEnd ?? null,
      fadeIn:       sl?.fadeIn || 0,
      fadeOut:      sl?.fadeOut || 0,
      fadeInCurve:  sl?.fadeInCurve  || 'linear',
      fadeOutCurve: sl?.fadeOutCurve || 'linear'
    }))
  };

  if (_fxEditContext.kind === 'ambient') {
    Object.assign(snap, {
      ambLoop:         chk('ambLoop'),
      ambIntervalMode: chk('ambIntervalMode'),
      ambIntervalMin:  val('ambIntervalMin'),
      ambIntervalMax:  val('ambIntervalMax'),
      ambFadeIn:       val('ambFadeIn'),
      ambFadeOut:      val('ambFadeOut'),
      ambFadeInCurve:  val('ambFadeInCurve'),
      ambFadeOutCurve: val('ambFadeOutCurve'),
      crossfade:       readPlaybackFromUI().crossfade,
      variantMode:     _ambVariantMode
    });
  } else {
    Object.assign(snap, {
      loop: chk('eLoop'), fade: chk('eFade'), random: chk('eRnd'),
      playback: readPlaybackFromUI(),
      hotkey: val('eHotkey'), category: val('eCat'), icon: val('eIcon'),
      tileW: val('eTileW'), tileH: val('eTileH'),
      color:     _readSelectedColor('clrOpts'),
      tileColor: _readSelectedColor('eTileClrOpts')
    });
  }
  return JSON.stringify(snap);
}

/** Markiert den aktuellen Zustand als Ausgangspunkt einer neuen Editiersitzung. */
export function _armSoundDraftGuard() {
  _soundDraftBaseline = _snapshotSoundDraft();
  _soundDraftGuard?.arm();
}

/**
 * Vor jedem absichtlichen, NICHT rückfragepflichtigen Schließen von
 * #soundModal aufzurufen — erfolgreiches Speichern, Löschen des bearbeiteten
 * Sounds (hat bereits seine eigene Bestätigung), oder ein Fehlerfall ohne
 * änderbaren Draft (z.B. der bearbeitete Ambient-Track wurde währenddessen
 * anderweitig gelöscht). Deaktiviert den Guard für dieses eine hide.bs.modal
 * und verwirft die Audio-Rollback-Sicherung, weil die neu
 * geschriebenen Audiodaten in diesem Fall bleiben sollen.
 */
export function _releaseSoundDraftGuard() {
  _soundDraftGuard?.disarm();
  _soundDraftBaseline = null;
  _commitAudioRollback();
}

/**
 * Decodes any APP.editSlots entries that don't yet have a `_ed_N` buffer cached
 * (i.e. existing, previously-saved audio that wasn't touched this session) so
 * the waveform/trim/preview tools work immediately, not just for newly-loaded files.
 * Resolves the right IDB key depending on whether we're editing a sound or an
 * ambient track (different key schemes — see _fileId on ambient slot entries).
 */
