/**
 * dialogs/transfer-modal.js — Zielauswahl-Modal für „Verschieben“ / „Duplizieren“
 *
 * Die Aktionen werden im jeweiligen „… bearbeiten“-Modal angeboten
 * (#soundModal für Sound UND Ambient, #musicTrackModal für Musik). Ein Klick darauf
 * öffnet #transferModal (fragments/modals/transfer.html), das ausschließlich
 * Auswahl + Bestätigung übernimmt; die Datenänderung selbst liegt komplett in
 * storage/transfer.js — dieses Modul manipuliert keine Arrays.
 *
 * ── MODAL-ABLAUF (kein Stapeln) ─────────────────────────────────
 *   Bootstrap 5 kann Modals nicht sauber stapeln (doppelte Backdrops, Fokus-/Scroll-Sperre).
 *   Daher WECHSELN die Modals: Bearbeiten-Modal ausblenden (auf hidden.bs.modal warten)
 *   → Zielauswahl einblenden. Bei Abbruch (Abbrechen/X/Backdrop/Escape) wird das
 *   Bearbeiten-Modal wieder eingeblendet — dieselbe Bootstrap-Instanz, die DOM-Werte
 *   bleiben also unverändert erhalten. Nach erfolgreicher Aktion bleibt es geschlossen.
 *
 * ── UNGESPEICHERTE FORMULARÄNDERUNGEN (Variante A, explizit) ─────
 *   Verschieben/Duplizieren wirken immer auf den zuletzt GESPEICHERTEN Stand des
 *   Elements; Formularwerte werden NICHT mit übernommen. Wer die Aktion bestätigt, beendet
 *   die Bearbeiten-Sitzung: ein ungespeicherter Draft wird verworfen (inkl. Rollback bereits
 *   in IndexedDB geschriebener, aber nicht gespeicherter Audiodaten — sonst würde ein
 *   Duplikat Audio enthalten, das das Original nie bekommen hat). Das Zielauswahl-Modal
 *   weist darauf hin. Bricht der Benutzer ab, bleibt der Draft unangetastet.
 */

import { APP, findSoundAnyProfile, findAmbientTrackAnyScene, findMusicTrackAnyPlaylist } from '../core/state.js';
import { toast } from '../notifications.js';
import { isCustomIcon } from '../utils.js';
import {
  moveSoundToProfile, duplicateSoundToProfile,
  moveAmbientTrackToScene, duplicateAmbientTrackToScene,
  moveMusicTrackToPlaylist, duplicateMusicTrackToPlaylist
} from '../storage/transfer.js';
import { _soundDraftGuard, _isSoundDraftDirty, _releaseSoundDraftGuard } from '../events/utils-modal.js';
import { _fxEditContext, _setFxEditContext, _discardAudioRollback } from './sound-modal.js';
import { _musicEditId, _resetMusicEditId } from './music-modal.js';
import { isAmbientPlaying } from '../ambient/ambient-playback.js';
import { isMusicPlaying } from '../music/music-playback.js';

// ─── KONFIGURATION JE ELEMENTTYP ─────────────────────────────────

const KINDS = {
  sound: {
    editModalId: 'soundModal', hasDraft: true,
    title: 'Sound', currentLabel: 'Aktuelles Profil:', targetLabel: 'Zielprofil:',
    noTargets: 'Es gibt kein anderes Profil. Lege zuerst ein weiteres Profil an.',
    fallbackIcon: '🎵',
    containers: () => APP.profiles,
    count: c => (c.items || []).filter(x => x.type !== 'placeholder').length,
    find: findSoundAnyProfile,
    editedId: () => (_fxEditContext.kind === 'sound' ? APP.editId : null),
    isPlaying: id => (APP.activeAudio[id] || []).length > 0,
    run: { move: moveSoundToProfile, duplicate: duplicateSoundToProfile },
    done: { move: 'verschoben nach', duplicate: 'dupliziert nach' }
  },
  ambient: {
    editModalId: 'soundModal', hasDraft: true,
    title: 'Ambient', currentLabel: 'Aktuelle Szene:', targetLabel: 'Zielszene:',
    noTargets: 'Es gibt keine andere Szene. Lege zuerst eine weitere Szene an.',
    fallbackIcon: '🌫️',
    containers: () => APP.ambient.profiles,
    count: c => (c.tracks || []).length,
    find: findAmbientTrackAnyScene,
    editedId: () => (_fxEditContext.kind === 'ambient' ? _fxEditContext.id : null),
    isPlaying: id => isAmbientPlaying(id),
    run: { move: moveAmbientTrackToScene, duplicate: duplicateAmbientTrackToScene },
    done: { move: 'verschoben nach', duplicate: 'dupliziert nach' }
  },
  music: {
    editModalId: 'musicTrackModal', hasDraft: false,
    title: 'Musikstück', currentLabel: 'Aktuelle Playlist:', targetLabel: 'Zielplaylist:',
    noTargets: 'Es gibt keine andere Playlist. Lege zuerst eine weitere Playlist an.',
    fallbackIcon: '🎵',
    containers: () => APP.music.profiles,
    count: c => (c.tracks || []).length,
    find: findMusicTrackAnyPlaylist,
    editedId: () => _musicEditId,
    isPlaying: id => APP.music.activeTrackId === id && isMusicPlaying(),
    run: { move: moveMusicTrackToPlaylist, duplicate: duplicateMusicTrackToPlaylist },
    done: { move: 'verschoben nach', duplicate: 'dupliziert nach' }
  }
};

const $ = id => document.getElementById(id);

// Laufender Vorgang (null = keiner). _busy blockiert Doppelklicks während des Modal-Wechsels.
let _s = null;
let _busy = false;

// ─── BOOTSTRAP-HELFER ────────────────────────────────────────────

/** Löst `trigger()` aus und wartet auf das Bootstrap-Event (mit Timeout, falls es nie kommt). */
function _awaitModalEvent(el, eventName, trigger, timeoutMs = 1500) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); el.removeEventListener(eventName, finish); resolve(); };
    const t = setTimeout(finish, timeoutMs);
    el.addEventListener(eventName, finish);
    try { trigger(); } catch (e) { console.warn('[transfer-modal]', e); finish(); }
  });
}

async function _hideModal(el) {
  if (!el.classList.contains('show')) return;
  const inst = bootstrap.Modal.getInstance(el);
  if (!inst) return;
  await _awaitModalEvent(el, 'hidden.bs.modal', () => inst.hide());
}

async function _showModal(el) {
  if (el.classList.contains('show')) return;
  const inst = bootstrap.Modal.getOrCreateInstance(el);
  await _awaitModalEvent(el, 'shown.bs.modal', () => inst.show());
}

// ─── ZIELAUSWAHL RENDERN ─────────────────────────────────────────

function _iconNode(icon, fallback) {
  const wrap = document.createElement('span');
  wrap.className = 'transfer-option__icon';
  wrap.setAttribute('aria-hidden', 'true');
  if (isCustomIcon(icon)) {
    const img = document.createElement('img');
    img.src = icon; img.className = 'icon-img'; img.alt = ''; img.draggable = false;
    wrap.appendChild(img);
  } else {
    wrap.textContent = icon || fallback;
  }
  return wrap;
}

/**
 * Akzentfarbe eines Zielcontainers. Quelle ist in allen drei Bereichen dasselbe Feld
 * `container.color` (Hex oder 'none'; factories.js mkProfile/mkAmbientProfile/mkMusicProfile) —
 * dieselbe Quelle, aus der auch die Tab-Leisten ihren Akzent beziehen (_applyTabAccent in ui/tabs.js).
 * 'none'/leer → kein Streifen. Die Farbe wird nur gelesen, nirgends gespeichert oder abgeleitet.
 */
function _containerAccent(container) {
  const c = container && container.color;
  return (typeof c === 'string' && c && c !== 'none') ? c : null;
}

function _macrosReferencing(soundId) {
  const names = [];
  APP.profiles.forEach(p => (p.items || []).forEach(it => {
    if (it.type === 'macro' && (it.steps || []).some(st => st && st.targetId === soundId)) names.push(it.name || 'Makro');
  }));
  return names;
}

function _renderTransferModal() {
  const { cfg, mode, hit } = _s;
  const verb = mode === 'move' ? 'verschieben' : 'duplizieren';

  $('transferModalTitle').textContent = `${cfg.title} ${verb}`;
  $('transferItemName').textContent = `„${hit.item.name || ''}“`;
  $('transferSourceLabel').textContent = cfg.currentLabel;
  $('transferSourceName').textContent = hit.container.name || '';
  $('transferTargetLabel').textContent = cfg.targetLabel;

  const confirmBtn = $('btnTransferConfirm');
  confirmBtn.textContent = mode === 'move' ? 'Verschieben' : 'Duplizieren';
  confirmBtn.disabled = true;

  const list = $('transferList');
  list.replaceChildren();
  let validTargets = 0;
  cfg.containers().forEach(c => {
    const isCurrent = c.id === hit.container.id;
    const disabled  = mode === 'move' && isCurrent;   // Move in denselben Container verhindern
    if (!disabled) validTargets++;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'transfer-option';
    btn.dataset.id = c.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.disabled = disabled;
    // Schmaler Akzentstreifen links (CSS: .transfer-option--accent, Farbe über Custom Property).
    const accent = _containerAccent(c);
    if (accent) {
      btn.classList.add('transfer-option--accent');
      btn.style.setProperty('--transfer-accent', accent);
    }

    const radio = document.createElement('span');
    radio.className = 'transfer-option__radio';
    radio.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'transfer-option__name';
    name.textContent = c.name || '';
    const meta = document.createElement('span');
    meta.className = 'transfer-option__meta';
    meta.textContent = isCurrent ? `Aktuell · ${cfg.count(c)}` : String(cfg.count(c));

    btn.append(radio, _iconNode(c.icon, cfg.fallbackIcon), name, meta);
    list.appendChild(btn);
  });

  // Hinweise
  const notes = $('transferNotes');
  notes.replaceChildren();
  const addNote = text => { const p = document.createElement('p'); p.textContent = text; notes.appendChild(p); };
  if (!validTargets) addNote(cfg.noTargets);
  if (_s.kind === 'sound' && mode === 'move') {
    const macros = _macrosReferencing(_s.id);
    if (macros.length) {
      addNote(`Dieser Sound wird von ${macros.length === 1 ? 'einem Makro' : macros.length + ' Makros'} verwendet (${macros.join(', ')}). ` +
              'Die Makros funktionieren weiterhin und rufen den Sound im neuen Profil auf.');
    }
  }
  if (mode === 'move' && cfg.isPlaying(_s.id)) addNote('Die laufende Wiedergabe wird dabei nicht unterbrochen.');
  addNote('Der Bearbeiten-Dialog wird geschlossen. Nicht gespeicherte Änderungen darin werden nicht übernommen.');
}

function _selectTarget(btn) {
  if (!_s || _s.running || btn.disabled) return;
  _s.targetId = btn.dataset.id;
  $('transferList').querySelectorAll('.transfer-option').forEach(o => {
    const on = o === btn;
    o.classList.toggle('is-selected', on);
    o.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  $('btnTransferConfirm').disabled = false;
}

// ─── ABLAUF ──────────────────────────────────────────────────────

/** Einstieg: vom Bearbeiten-Modal aus aufgerufen. kind: 'sound'|'ambient'|'music', mode: 'move'|'duplicate'. */
export async function startTransfer(kind, mode) {
  if (_busy) return;
  const cfg = KINDS[kind];
  // Das aktuell BEARBEITETE Element (nicht das zuletzt abgespielte/angeklickte).
  const id  = cfg.editedId();
  const hit = id ? cfg.find(id) : null;
  if (!hit) { toast('Element nicht gefunden', 'err'); return; }

  _busy = true;
  const editEl = $(cfg.editModalId);
  const tEl    = $('transferModal');
  _s = { kind, mode, cfg, id, hit, editEl, tEl, targetId: null,
         dirty: cfg.hasDraft && _isSoundDraftDirty(), running: false, allowHide: false,
         completed: false, sessionDiscarded: false };
  _renderTransferModal();

  // Draft-Guard für den programmatischen Wechsel abschalten (sonst würde hide.bs.modal bei
  // ungespeicherten Änderungen die Rückfrage zeigen/den Wechsel blockieren); bei Abbruch wieder scharf.
  if (cfg.hasDraft) _soundDraftGuard?.disarm();

  await _hideModal(editEl);
  if (editEl.classList.contains('show')) { await _restoreEdit(); return; } // Ausblenden hat nicht geklappt
  await _showModal(tEl);
}

async function _restoreEdit() {
  const s = _s;
  if (!s) return;
  try { await _showModal(s.editEl); }
  finally {
    if (s.cfg.hasDraft) _soundDraftGuard?.arm();   // Baseline bleibt → Dirty-Vergleich wie vorher
    _s = null; _busy = false;
  }
}

/** Zielauswahl ist geschlossen (Abbruch ODER nach Bestätigung). */
async function _onTransferHidden() {
  const s = _s;
  if (!s) return;
  if (s.completed || s.sessionDiscarded) { _endSession(); return; }
  await _restoreEdit();   // Abbruch → zurück zum Bearbeiten-Modal, keine Datenänderung
}

/** Bearbeiten-Sitzung endgültig beenden (nach Verschieben/Duplizieren bzw. verworfenem Draft). */
function _endSession() {
  const s = _s;
  if (s.cfg.hasDraft) {
    _releaseSoundDraftGuard();            // Guard aus, Baseline weg, Rollback-Sicherung verwerfen
    APP.editId = null;
    APP.editSlots = [];
    _setFxEditContext({ kind: 'sound', id: null });
  } else {
    _resetMusicEditId();
  }
  _s = null; _busy = false;
}

async function _confirm() {
  const s = _s;
  if (!s || s.running || !s.targetId) return;
  s.running = true;
  $('btnTransferConfirm').disabled = true;
  $('btnTransferCancel').disabled  = true;

  // Bestätigen beendet die Bearbeiten-Sitzung (Variante A, s. Kopfkommentar). Ein dirty Draft wird
  // VOR dem Transfer verworfen — inkl. Audio-Rollback, damit ein Duplikat nur gespeicherte Daten kopiert.
  if (s.dirty) {
    try { await _discardAudioRollback(); } catch (e) { console.warn('[transfer-modal] Audio-Rollback:', e); }
    s.sessionDiscarded = true;
  }

  let res;
  try { res = await s.cfg.run[s.mode](s.id, s.targetId); }
  catch (e) { console.error('[transfer-modal]', e); res = { ok: false, error: 'Unerwarteter Fehler' }; }

  if (res.ok) {
    s.completed = true;
    const itemName = res.item?.name || s.hit.item.name || '';
    toast(`„${itemName}“ ${s.cfg.done[s.mode]} „${res.to.name}“`, 'ok');
  } else {
    toast(res.error || 'Aktion fehlgeschlagen', 'err');
  }
  s.allowHide = true;
  bootstrap.Modal.getInstance(s.tEl)?.hide();   // → _onTransferHidden()
  $('btnTransferCancel').disabled = false;
}

// ─── EVENT-VERDRAHTUNG (einmalig, aus events/index.js) ───────────

export function registerTransferEvents() {
  const tEl = $('transferModal');
  if (!tEl) return;

  $('btnEditMove')?.addEventListener('click',      () => startTransfer(_fxEditContext.kind === 'ambient' ? 'ambient' : 'sound', 'move'));
  $('btnEditDuplicate')?.addEventListener('click', () => startTransfer(_fxEditContext.kind === 'ambient' ? 'ambient' : 'sound', 'duplicate'));
  $('btnMusicEditMove')?.addEventListener('click',      () => startTransfer('music', 'move'));
  $('btnMusicEditDuplicate')?.addEventListener('click', () => startTransfer('music', 'duplicate'));

  $('transferList').addEventListener('click', e => {
    const btn = e.target.closest('.transfer-option');
    if (btn) _selectTarget(btn);
  });
  $('btnTransferConfirm').addEventListener('click', _confirm);

  // Während der Transfer läuft darf das Modal nicht (Escape/Backdrop/X) geschlossen werden.
  tEl.addEventListener('hide.bs.modal', e => { if (_s?.running && !_s.allowHide) e.preventDefault(); });
  tEl.addEventListener('hidden.bs.modal', _onTransferHidden);
}
