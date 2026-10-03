/**
 * storage/transfer.js — Zentrale Organisationslogik: Elemente zwischen
 * Containern VERSCHIEBEN oder DUPLIZIEREN.
 *
 *   Sound   : Profil  (APP.profiles[].items)
 *   Ambient : Szene   (APP.ambient.profiles[].tracks)
 *   Musik   : Playlist (APP.music.profiles[].tracks)
 *
 * Die UI (dialogs/transfer-modal.js) ruft ausschließlich die exportierten
 * move…/duplicate…-Funktionen auf und manipuliert selbst keine Arrays.
 *
 * VERSCHIEBEN: das bestehende Objekt wandert unverändert (gleiche Element-ID,
 *   gleiche Audio-IDs, IndexedDB bleibt unangetastet) in den Zielcontainer.
 * DUPLIZIEREN: unabhängige Kopie mit neuen IDs; die IndexedDB-Audiodaten
 *   werden unter den neuen Keys wirklich kopiert. Schlägt irgendein Schritt
 *   fehl, werden bereits geschriebene IDB-Einträge wieder gelöscht und es
 *   bleibt weder ein halbfertiges Duplikat im State noch im Speicher zurück.
 *
 * Rückgabe jeder Funktion: { ok:true, item, from, to } | { ok:false, error }.
 */

import { APP, findSoundAnyProfile, findAmbientTrackAnyScene, findMusicTrackAnyPlaylist } from '../core/state.js';
import { uid }  from '../utils.js';
import { idbGet, idbSet, idbDelete, audioKey, IDB_SENTINEL, isIdbRef } from '../db.js';
import { mkPH } from './factories.js';
import { _saveRaw } from './persistence.js';
import { renderGrid } from '../ui/grid.js';
import { renderAmbientPanel, renderAmbientProfileTabs } from '../ambient/ambient-render.js';
import { renderMusicPanel, renderMusicProfileTabs, renderMusicPlayer } from '../music/music-render.js';
import { _resetShuffleOrder } from '../music/music-playback.js';

const COPY_SUFFIX = ' (Kopie)';

// ─── KLEINE HELFER ─────────────────────────────────────────────

const _fail = error => ({ ok: false, error });

/** Alle im State vorkommenden IDs (Items, Tracks, Ambient-Dateien) — für kollisionsfreie neue IDs. */
function _collectIds() {
  const ids = new Set();
  APP.profiles.forEach(p => { ids.add(p.id); (p.items || []).forEach(i => ids.add(i.id)); });
  (APP.ambient?.profiles || []).forEach(p => {
    ids.add(p.id);
    (p.tracks || []).forEach(t => { ids.add(t.id); (t.files || []).forEach(f => ids.add(f.id)); });
  });
  (APP.music?.profiles || []).forEach(p => { ids.add(p.id); (p.tracks || []).forEach(t => ids.add(t.id)); });
  return ids;
}

function _newId(taken) {
  let id;
  do { id = uid(); } while (taken.has(id));
  taken.add(id);
  return id;
}

const _maxOrder = list => list.reduce((m, x) => Math.max(m, x.order || 0), -1);
const _clone    = obj  => JSON.parse(JSON.stringify(obj));

/** Schreibt in IDB und liest zur Kontrolle zurück (db.js idbSet() schluckt Fehler bewusst). */
async function _writeVerified(key, value) {
  await idbSet(key, value);
  const back = await idbGet(key);
  const ok = back != null && (typeof value !== 'string' || (typeof back === 'string' && back.length === value.length));
  if (!ok) throw new Error(`IndexedDB-Schreibprüfung fehlgeschlagen (${key})`);
}

/**
 * Kopiert EINEN Audio-Eintrag unter einen neuen Key — nur, wenn tatsächlich Audio existiert.
 * „Kein Audio“ ist KEIN Fehler: Das Element existiert, die Kopie bleibt dann ebenfalls leer.
 *   data leer / kein String      → nichts zu kopieren, Wert unverändert zurück (z.B. null, '')
 *   data === 'idb', Eintrag fehlt → Verweis ist ins Leere gelaufen: Kopie bekommt data = null
 *                                   (kein ungültiger IDB-Verweis in der Kopie; Original bleibt unberührt)
 *   data === 'idb', Eintrag da    → Blob unter dstKey schreiben, Kopie bekommt IDB_SENTINEL
 *   data === Base64-String        → Legacy/inline: unter dstKey in IDB ablegen, Kopie bekommt IDB_SENTINEL
 * Fehler (→ Rollback, Abbruch der Duplizierung) gibt es nur beim Schreiben von tatsächlich
 * vorhandenem Audio. Hinweis: db.js idbGet() meldet Lesefehler und „fehlt“ beide als null.
 * `written` sammelt alle geschriebenen Keys für den Rollback.
 */
async function _cloneAudioEntry(srcKey, dstKey, data, written) {
  if (!data || typeof data !== 'string') return data;
  let payload = data;
  if (isIdbRef(data)) {
    payload = await idbGet(srcKey);
    if (payload == null || payload === '') return null;
  }
  written.push(dstKey); // vor dem Schreiben eintragen: auch ein halb geschriebener Eintrag wird zurückgerollt
  await _writeVerified(dstKey, payload);
  return IDB_SENTINEL;
}

async function _rollbackIdb(keys) {
  for (const k of keys) {
    try { await idbDelete(k); } catch (e) { console.warn('[transfer] IDB-Rollback fehlgeschlagen für', k, e); }
  }
}

/** Fügt eine fertige Kopie ein, persistiert und rollt bei Persistenz-Fehler alles zurück. */
async function _commitCopy(list, copy, written) {
  list.push(copy);
  if (!_saveRaw()) {
    list.pop();
    await _rollbackIdb(written);
    return false;
  }
  return true;
}

// ─── SOUND ─────────────────────────────────────────────────────

export async function moveSoundToProfile(soundId, targetProfileId) {
  const src    = findSoundAnyProfile(soundId);
  const target = APP.profiles.find(p => p.id === targetProfileId);
  if (!src)    return _fail('Sound nicht gefunden');
  if (!target) return _fail('Zielprofil nicht gefunden');
  if (src.container.id === target.id) return _fail('Der Sound liegt bereits in diesem Profil');

  const from = src.container;
  const sound = src.item;
  const idx = from.items.indexOf(sound);
  const oldOrder = sound.order;
  // Quelle: Platzhalter auf derselben Position (identisch zum Löschen eines Sounds) →
  // die übrigen Kacheln des Quellprofils behalten ihre .order-Werte und Positionen.
  from.items.splice(idx, 1, mkPH(oldOrder));
  // Ziel: ans Ende der Reihenfolge; bestehende .order-Werte bleiben unberührt.
  sound.order = _maxOrder(target.items) + 1;
  target.items.push(sound);

  if (!_saveRaw()) {
    target.items.pop();
    sound.order = oldOrder;
    from.items.splice(idx, 1, sound);
    return _fail('Speichern fehlgeschlagen');
  }
  _renderSound(from, target);
  return { ok: true, item: sound, from, to: target };
}

export async function duplicateSoundToProfile(soundId, targetProfileId) {
  const src    = findSoundAnyProfile(soundId);
  const target = APP.profiles.find(p => p.id === targetProfileId);
  if (!src)    return _fail('Sound nicht gefunden');
  if (!target) return _fail('Zielprofil nicht gefunden');

  const copy = _clone(src.item);            // keine Referenz auf das Original
  copy.id    = _newId(_collectIds());
  copy.order = _maxOrder(target.items) + 1;
  if (src.container.id === target.id) copy.name = (copy.name || 'SOUND') + COPY_SUFFIX;

  const written = [];
  try {
    for (let i = 0; i < (copy.slots || []).length; i++) {
      const sl = copy.slots[i];
      if (!sl) continue;
      delete sl._idbSlot; delete sl._tempId; delete sl._loading; // reine Editor-Felder
      sl.data = await _cloneAudioEntry(audioKey(src.item.id, i), audioKey(copy.id, i), sl.data, written);
    }
  } catch (err) {
    console.error('[transfer] Sound duplizieren fehlgeschlagen:', err);
    await _rollbackIdb(written);
    return _fail('Audio konnte nicht kopiert werden – nichts dupliziert');
  }
  if (!(await _commitCopy(target.items, copy, written))) return _fail('Speichern fehlgeschlagen – nichts dupliziert');

  _renderSound(src.container, target);
  return { ok: true, item: copy, from: src.container, to: target };
}

function _renderSound(a, b) {
  const act = APP.activeProfileId;
  if (a.id === act || b.id === act) renderGrid();
}

// ─── AMBIENT ───────────────────────────────────────────────────

export async function moveAmbientTrackToScene(trackId, targetSceneId) {
  const src    = findAmbientTrackAnyScene(trackId);
  const target = (APP.ambient?.profiles || []).find(p => p.id === targetSceneId);
  if (!src)    return _fail('Ambient-Sound nicht gefunden');
  if (!target) return _fail('Zielszene nicht gefunden');
  if (src.container.id === target.id) return _fail('Der Ambient-Sound liegt bereits in dieser Szene');

  const from = src.container;
  const idx = from.tracks.indexOf(src.item);
  from.tracks.splice(idx, 1);
  target.tracks.push(src.item);   // ans Ende der Trackliste

  if (!_saveRaw()) {
    target.tracks.pop();
    from.tracks.splice(idx, 0, src.item);
    return _fail('Speichern fehlgeschlagen');
  }
  // Laufende Wiedergabe (ambient/ambient-playback.js _active) wird bewusst NICHT angefasst.
  _renderAmbient();
  return { ok: true, item: src.item, from, to: target };
}

export async function duplicateAmbientTrackToScene(trackId, targetSceneId) {
  const src    = findAmbientTrackAnyScene(trackId);
  const target = (APP.ambient?.profiles || []).find(p => p.id === targetSceneId);
  if (!src)    return _fail('Ambient-Sound nicht gefunden');
  if (!target) return _fail('Zielszene nicht gefunden');

  const taken = _collectIds();
  const copy  = _clone(src.item);
  copy.id = _newId(taken);
  // Laufzeit-/Rotationszustand des Originals gehört nicht in die Kopie (_lastFileId zeigt auf alte Datei-IDs).
  delete copy._rotateIndex; delete copy._lastFileId;
  if (src.container.id === target.id) copy.name = (copy.name || 'Ambient') + COPY_SUFFIX;

  const written = [];
  try {
    // Generator-Tracks haben keine files[] → Schleife läuft nicht, nur Trackdaten werden dupliziert.
    const origFiles = src.item.files || [];
    for (let i = 0; i < (copy.files || []).length; i++) {
      const f = copy.files[i];
      f.id   = _newId(taken);
      f.data = await _cloneAudioEntry(audioKey(origFiles[i].id, 0), audioKey(f.id, 0), f.data, written);
    }
  } catch (err) {
    console.error('[transfer] Ambient duplizieren fehlgeschlagen:', err);
    await _rollbackIdb(written);
    return _fail('Audio konnte nicht kopiert werden – nichts dupliziert');
  }
  if (!(await _commitCopy(target.tracks, copy, written))) return _fail('Speichern fehlgeschlagen – nichts dupliziert');

  _renderAmbient();
  return { ok: true, item: copy, from: src.container, to: target };
}

function _renderAmbient() {
  renderAmbientProfileTabs();   // Live-Punkt je Szene
  renderAmbientPanel();
}

// ─── MUSIK ─────────────────────────────────────────────────────

export async function moveMusicTrackToPlaylist(trackId, targetPlaylistId) {
  const src    = findMusicTrackAnyPlaylist(trackId);
  const target = (APP.music?.profiles || []).find(p => p.id === targetPlaylistId);
  if (!src)    return _fail('Musikstück nicht gefunden');
  if (!target) return _fail('Zielplaylist nicht gefunden');
  if (src.container.id === target.id) return _fail('Das Musikstück liegt bereits in dieser Playlist');

  const from = src.container;
  const track = src.item;
  const idx = from.tracks.indexOf(track);
  const oldOrder = track.order;
  from.tracks.splice(idx, 1);
  // Zielreihenfolge: ans Ende. Das manualOrder-/order-System bleibt unverändert —
  // .order wird nur fortgeschrieben, manualOrder-Flags der Playlists nicht angefasst.
  track.order = _maxOrder(target.tracks) + 1;
  target.tracks.push(track);

  if (!_saveRaw()) {
    target.tracks.pop();
    track.order = oldOrder;
    from.tracks.splice(idx, 0, track);
    return _fail('Speichern fehlgeschlagen');
  }
  // Player (_players/activeTrackId) bleibt unberührt: _findTrack() sucht über alle Playlists.
  _resetShuffleOrder();
  _renderMusic();
  return { ok: true, item: track, from, to: target };
}

export async function duplicateMusicTrackToPlaylist(trackId, targetPlaylistId) {
  const src    = findMusicTrackAnyPlaylist(trackId);
  const target = (APP.music?.profiles || []).find(p => p.id === targetPlaylistId);
  if (!src)    return _fail('Musikstück nicht gefunden');
  if (!target) return _fail('Zielplaylist nicht gefunden');

  const copy = _clone(src.item);
  copy.id    = _newId(_collectIds());
  copy.order = _maxOrder(target.tracks) + 1;
  if (src.container.id === target.id) copy.name = (copy.name || 'Track') + COPY_SUFFIX;

  const written = [];
  try {
    copy.data = await _cloneAudioEntry(audioKey(src.item.id, 0), audioKey(copy.id, 0), copy.data, written);
  } catch (err) {
    console.error('[transfer] Musik duplizieren fehlgeschlagen:', err);
    await _rollbackIdb(written);
    return _fail('Audio konnte nicht kopiert werden – nichts dupliziert');
  }
  if (!(await _commitCopy(target.tracks, copy, written))) return _fail('Speichern fehlgeschlagen – nichts dupliziert');

  // Die Kopie wird NICHT abgespielt; activeTrackId bleibt beim bisherigen Track.
  _resetShuffleOrder();
  _renderMusic();
  return { ok: true, item: copy, from: src.container, to: target };
}

function _renderMusic() {
  renderMusicProfileTabs();
  renderMusicPanel();
  renderMusicPlayer();
}
