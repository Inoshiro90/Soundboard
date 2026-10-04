/**
 * ambient/ambient-model.js — Ambient-Datenmodell: Szenen-/Track-CRUD,
 * Lautstärke/Loop/Fade/Intervall-Setter
 */

import { APP, CAP, CATracks, findAmbientTrackAnyScene } from '../core/state.js';
import { uid } from '../utils.js';
import { toast } from '../notifications.js';
import { actx, hasAudioContext } from '../audio/context.js';
import { idbSet, idbDelete, audioKey, IDB_SENTINEL } from '../db.js';
import { invalidateBuffer } from '../audioCache.js';
import { _saveRaw } from '../storage/persistence.js';
import { setNoiseGeneratorType } from '../generators.js';
// Zirkulärer Import (playback.js importiert umgekehrt _find/_persist aus
// diesem Modul) — unkritisch, s. Kommentar in ambient-playback.js.
import { _active, _ambientTargetGain, isAmbientPlaying, playAmbientTrack, stopAllAmbient, stopAmbientTrack } from './ambient-playback.js';
import { renderAmbientPanel, renderAmbientProfileTabs, setViewMode } from './ambient-render.js';
import { getAmbientVolumeConfig } from './ambient-volume.js';

// ─── CONSTANTS ───────────────────────────────────────────────

const AMBIENT_ICONS = ['🎐','🌧️','🌊','🔥','🌬️','🐦','🐴','🐕','👥','🏙️','🌲','🕯️','⛈️','🦗','🌙','🐝','🚶','🔔'];

// ─── STATE HELPERS ───────────────────────────────────────────

export function ensureAmbientState() {
  if (!APP.ambient || typeof APP.ambient !== 'object') {
    APP.ambient = { profiles: [], activeProfileId: null, masterVol: 1 };
  }
  if (!Array.isArray(APP.ambient.profiles)) APP.ambient.profiles = [];
  if (!APP.ambient.profiles.length) {
    const p = { id: uid(), name: 'Ambient', icon: '🌫️', tracks: [] };
    APP.ambient.profiles.push(p);
    APP.ambient.activeProfileId = p.id;
  }
  APP.ambient.profiles.forEach(p => { if (!Array.isArray(p.tracks)) p.tracks = []; });
  if (!APP.ambient.activeProfileId || !APP.ambient.profiles.find(p => p.id === APP.ambient.activeProfileId)) {
    APP.ambient.activeProfileId = APP.ambient.profiles[0].id;
  }
  if (typeof APP.ambient.masterVol !== 'number') APP.ambient.masterVol = 1;
  if (!['sound', 'ambient', 'music'].includes(APP.viewMode)) APP.viewMode = 'sound';
}

// Exportiert: _persist() wird auch von ambient-render.js (setViewMode) benötigt;
// _find() von ambient-playback.js (viele Stellen) und ambient-render.js.
export function _persist() {
  try { _saveRaw(); } catch (e) { console.warn('[ambient] persist failed:', e); }
}

export function _find(trackId) {
  // Aktive Szene zuerst (bisheriges Verhalten), danach alle Szenen: ein Track,
  // der per „Verschieben“ in eine andere Szene gewandert ist, aber noch läuft,
  // muss für Intervall-/Ketten-Zyklen, Stop-Fade und Lautstärke auffindbar bleiben.
  return CATracks().find(t => t.id === trackId) || findAmbientTrackAnyScene(trackId)?.item;
}

/** Finds a track across ALL scenes (not just the active one) — used by the effects editor modal. */
export function findAmbientTrack(trackId) {
  ensureAmbientState();
  for (const p of APP.ambient.profiles) {
    const t = (p.tracks || []).find(x => x.id === trackId);
    if (t) return t;
  }
  return null;
}

/** Sets the real-time audio-effects chain (filter/EQ/dynamics/distortion/reverb/delay/3D/pitch) for a track. */
export function setAmbientTrackEffects(trackId, effects) {
  const t = findAmbientTrack(trackId); if (!t) return;
  t.effects = effects;
  _persist();
}

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = e => resolve(e.target.result.split(',')[1]);
    r.onerror = () => reject(new Error('FileReader error'));
    r.readAsDataURL(file);
  });
}

function _mkTrack(name) {
  const icon = AMBIENT_ICONS[CATracks().length % AMBIENT_ICONS.length];
  return {
    id: uid(), name: name || 'Ambient', icon, color: 'none',
    // Several audio-file variants per track (e.g. 3 different dog-bark clips).
    // On each play/interval-firing, one is picked per variantMode.
    files: [], variantMode: 'random', // 'random' | 'rotate'
    vol: 0.7, loop: true, fadeIn: 2, fadeOut: 2,
    // Lautstärkevarianz: 'constant' = feste Lautstärke `vol` (bisheriges Verhalten),
    // 'varying' = pro abgespieltem Clip zufällig zwischen volumeMin und volumeMax (Maßstab wie `vol`).
    volumeMode: 'constant', volumeMin: 0.35, volumeMax: 0.7,
    // Shape der Fade-In/Fade-Out-Rampe (analog zu s.playback.fadeIn/fadeOut.curve bei Sounds)
    // + Crossfade zwischen Datei-Varianten in der Loop-Kette (s. _playChainCycle()). Bewusst
    // eigenständiges Feld statt eines s.playback-Klons — Ambient-Tracks haben ihr eigenes
    // Datenmodell (fadeIn/fadeOut als flache Zahlenfelder statt {enabled,duration}-Objekte).
    fadeInCurve: 'linear', fadeOutCurve: 'linear',
    crossfade: { enabled: false, duration: 1, curve: 'linear' },
    // Time-delayed playback: instead of looping continuously, play once then
    // wait a random (or fixed, if min === max) delay before playing again.
    intervalMode: false, intervalMin: 10, intervalMax: 30
  };
}

function _mkFile(fileName) {
  return { id: uid(), data: null, fileName: fileName || '', trimStart: 0, trimEnd: null };
}

/** Forces an immediate save — used by the shared modal after it bulk-edits a track's fields directly. */
export function persistAmbientNow() { _persist(); }


// ─── SCENE (PROFILE) CRUD ──────────────────────────────────────

/** Creates a new scene or renames/re-icons/re-colors an existing one (id === null → create). */
export function saveAmbientProfile(id, name, icon, color, audioEffectPreset) {
  ensureAmbientState();
  const cleanName  = (name || '').trim() || 'Szene';
  const cleanIcon  = (icon || '').trim() || '🌫️';
  const cleanColor = color || 'none';
  if (id) {
    const p = APP.ambient.profiles.find(x => x.id === id);
    if (p) {
      p.name = cleanName; p.icon = cleanIcon; p.color = cleanColor;
      // Übergeordnetes Preset wird bei jedem Speichern
      // mitgesichert (undefined = Aufrufer hat es nicht übergeben → Feld
      // unangetastet lassen, statt es stillschweigend auf null zu setzen).
      if (audioEffectPreset !== undefined) p.audioEffectPreset = audioEffectPreset;
    }
  } else {
    const np = { id: uid(), name: cleanName, icon: cleanIcon, color: cleanColor, audioEffectPreset: audioEffectPreset ?? null, tracks: [] };
    APP.ambient.profiles.push(np);
    APP.ambient.activeProfileId = np.id;
  }
  _persist();
  renderAmbientProfileTabs();
  renderAmbientPanel();
}

/** Deletes a scene (and its tracks' audio). Refuses to delete the last remaining scene. */
export function deleteAmbientProfile(id) {
  ensureAmbientState();
  if (APP.ambient.profiles.length <= 1) { toast('Letzte Szene kann nicht gelöscht werden', 'err'); return false; }
  const p = APP.ambient.profiles.find(x => x.id === id);
  if (p) {
    (p.tracks || []).forEach(t => {
      stopAmbientTrack(t.id, { fade: false });
      (t.files || []).forEach(f => {
        invalidateBuffer(f.id, 0);
        idbDelete(audioKey(f.id, 0)).catch(() => {});
      });
    });
  }
  APP.ambient.profiles = APP.ambient.profiles.filter(x => x.id !== id);
  if (APP.ambient.activeProfileId === id) APP.ambient.activeProfileId = APP.ambient.profiles[0]?.id || null;
  _persist();
  renderAmbientProfileTabs();
  renderAmbientPanel();
  return true;
}

/** Switches the active ambient scene. Stops whatever was playing in the previous scene. */
export function switchAmbientProfile(id) {
  ensureAmbientState();
  if (id === APP.ambient.activeProfileId) return;
  stopAllAmbient();
  APP.ambient.activeProfileId = id;
  _persist();
  renderAmbientProfileTabs();
  renderAmbientPanel();
}

export function resetAmbient() {
  stopAllAmbient();
  const p = { id: uid(), name: 'Ambient', icon: '🌫️', tracks: [] };
  APP.ambient = { profiles: [p], activeProfileId: p.id, masterVol: 1 };
  APP.viewMode = 'sound';
  renderAmbientProfileTabs();
  renderAmbientPanel();
  setViewMode('sound');
}

// ─── TRACK CRUD ──────────────────────────────────────────────

/** Adds one ambient track per selected file to the active scene, decoding + storing each asynchronously. */
export async function addAmbientFiles(fileList) {
  ensureAmbientState();
  const files = [...fileList].filter(f => f && f.type.startsWith('audio'));
  if (!files.length) { toast('Keine gültige Audiodatei', 'err'); return; }
  const tracks = CATracks();

  for (const f of files) {
    const track  = _mkTrack(f.name.replace(/\.[^.]+$/, ''));
    const variant = _mkFile(f.name);
    track.files.push(variant);
    tracks.push(track);
    renderAmbientPanel();
    try {
      const b64 = await _fileToBase64(f);
      await idbSet(audioKey(variant.id, 0), b64);
      variant.data = IDB_SENTINEL;
    } catch (e) {
      console.error('[ambient] file load error:', e);
      toast(`"${f.name}" konnte nicht geladen werden`, 'err');
    }
    renderAmbientPanel();
  }
  _persist();
  toast(`${files.length} Ambient-Sound${files.length > 1 ? 's' : ''} hinzugefügt`, 'ok');
}

/**
 * Legt einen neuen Noise-Generator-Track an — analog zu
 * addAmbientFiles(), aber ohne Datei: `sourceType:'generator'` statt
 * `files`. playAmbientTrack()/_playGeneratorTrack() erkennen diesen
 * Track-Typ automatisch.
 * @param {'white'|'pink'|'brown'} generatorType
 */
export function addNoiseGeneratorTrack(generatorType = 'pink') {
  ensureAmbientState();
  const label = { white: 'White Noise', pink: 'Pink Noise', brown: 'Brown Noise' }[generatorType] || 'Noise';
  const track = _mkTrack(label);
  track.sourceType    = 'generator';
  track.generatorType = generatorType;
  CATracks().push(track);
  _persist();
  renderAmbientPanel();
  toast(`${label}-Generator hinzugefügt`, 'ok');
  return track.id;
}

/** Ändert den Rauschtyp eines bestehenden Generator-Tracks (auch während er läuft). */
export function setGeneratorType(trackId, generatorType) {
  const t = _find(trackId); if (!t || t.sourceType !== 'generator') return;
  t.generatorType = generatorType;
  const rec = _active.get(trackId);
  if (rec?.kind === 'generator' && rec.src) setNoiseGeneratorType(rec.src, generatorType);
  _persist();
  renderAmbientPanel();
}


export async function addFileVariant(trackId, file) {
  const t = _find(trackId);
  if (!t || !file) return;
  const variant = _mkFile(file.name);
  t.files.push(variant);
  renderAmbientPanel();
  try {
    const b64 = await _fileToBase64(file);
    await idbSet(audioKey(variant.id, 0), b64);
    variant.data = IDB_SENTINEL;
  } catch (e) {
    console.error('[ambient] add variant error:', e);
    toast(`"${file.name}" konnte nicht geladen werden`, 'err');
  }
  _persist();
  renderAmbientPanel();
}

export async function addFileVariants(trackId, fileList) {
  const files = [...fileList].filter(f => f && f.type.startsWith('audio'));
  if (!files.length) { toast('Keine gültige Audiodatei', 'err'); return; }
  for (const f of files) await addFileVariant(trackId, f);
  toast(`${files.length} Variante${files.length > 1 ? 'n' : ''} hinzugefügt`, 'ok');
}

/** Replaces the audio of one specific file variant in place (same id, new blob). */
export async function replaceFileVariant(trackId, fileId, file) {
  const t = _find(trackId);
  const variant = t?.files.find(f => f.id === fileId);
  if (!variant || !file) return;
  invalidateBuffer(fileId, 0);
  try {
    const b64 = await _fileToBase64(file);
    await idbSet(audioKey(fileId, 0), b64);
    variant.data     = IDB_SENTINEL;
    variant.fileName = file.name;
    toast('Datei ersetzt ✓', 'ok');
  } catch (e) {
    console.error('[ambient] replace variant error:', e);
    toast('Fehler beim Ersetzen', 'err');
  }
  _persist();
  renderAmbientPanel();
}

/** Removes one file variant from a track. */
export function removeFileVariant(trackId, fileId) {
  const t = _find(trackId); if (!t) return;
  t.files = (t.files || []).filter(f => f.id !== fileId);
  invalidateBuffer(fileId, 0);
  idbDelete(audioKey(fileId, 0)).catch(() => {});
  _persist();
  renderAmbientPanel();
}

/** Sets whether variants are picked randomly or rotated in order. */
export function setAmbientVariantMode(trackId, mode) {
  const t = _find(trackId); if (!t) return;
  t.variantMode = mode === 'rotate' ? 'rotate' : 'random';
  t._rotateIndex = 0;
  _persist();
  renderAmbientPanel();
}

export function removeAmbientTrack(trackId) {
  stopAmbientTrack(trackId, { fade: false });
  const p = CAP();
  const t = p?.tracks.find(x => x.id === trackId);
  (t?.files || []).forEach(f => {
    invalidateBuffer(f.id, 0);
    idbDelete(audioKey(f.id, 0)).catch(() => {});
  });
  if (p) p.tracks = p.tracks.filter(x => x.id !== trackId);
  _persist();
  renderAmbientPanel();
}

export function renameAmbientTrack(trackId, name) {
  const t = _find(trackId); if (!t) return;
  t.name = (name || '').trim() || 'Ambient';
  _persist();
}

export function setAmbientTrackIcon(trackId, icon) {
  const t = _find(trackId); if (!t) return;
  t.icon = (icon || '').trim() || t.icon;
  _persist();
  renderAmbientPanel();
}

// Ambient-Tracks unterstützen eine Akzentfarbe (t.color, s. _mkTrack()/
// _normalizeAmbientTrack() sowie den sichtbaren Zeilen-Akzent in _rowTemplate());
// setAmbientTrackColor() analog zu setAmbientTrackIcon().
export function setAmbientTrackColor(trackId, color) {
  const t = _find(trackId); if (!t) return;
  t.color = color || 'none';
  _persist();
  renderAmbientPanel();
}


// ─── VOLUME / LOOP / FADE / INTERVAL ─────────────────────────

export function setAmbientTrackVolume(trackId, val) {
  const t = _find(trackId); if (!t) return;
  t.vol = Math.max(0, Math.min(1, val));
  const rec = _active.get(trackId);
  if (rec?.gain && hasAudioContext()) {
    const ctx = actx();
    // Zentrale Formel (Lautstärke × Master × Duck) — vorher fehlte hier der Duck-Faktor,
    // eine Lautstärkeänderung während aktivem Ducking hob das Ducking kurzzeitig auf.
    rec.gain.gain.cancelScheduledValues(ctx.currentTime);
    rec.gain.gain.setTargetAtTime(_ambientTargetGain(t, rec), ctx.currentTime, 0.03);
  }
}

/**
 * Setzt Lautstärkemodus und Min/Max eines Tracks (normalisiert: Bereich 0…1, min ≤ max,
 * keine NaN/Infinity). Läuft der Track gerade und hat sich etwas geändert, wird der
 * Clip-Lautstärkewert verworfen und neu bestimmt (varying) bzw. auf `vol` zurückgerampt
 * (constant) — über dieselbe Gain-Node, ohne neue AudioNodes. Unveränderte Werte lösen
 * bewusst keine Neuauswahl aus (sonst würde jedes Speichern im Editor die Lautstärke
 * eines laufenden Tracks neu würfeln).
 */
export function setAmbientVolumeVariance(trackId, { mode, min, max } = {}) {
  const t = _find(trackId); if (!t) return;
  const prev = getAmbientVolumeConfig(t);
  const next = getAmbientVolumeConfig({
    ...t,
    volumeMode: mode ?? prev.mode,
    volumeMin:  Number.isFinite(min) ? min : prev.min,
    volumeMax:  Number.isFinite(max) ? max : prev.max
  });
  t.volumeMode = next.mode;
  t.volumeMin  = next.min;
  t.volumeMax  = next.max;
  _persist();

  if (prev.mode === next.mode && prev.min === next.min && prev.max === next.max) return;
  const rec = _active.get(trackId);
  if (!rec) return;
  rec.clipVol = null; // wird in _ambientTargetGain() bei Bedarf neu gewürfelt
  if (rec.gain && hasAudioContext()) {
    const ctx = actx();
    rec.gain.gain.cancelScheduledValues(ctx.currentTime);
    rec.gain.gain.setTargetAtTime(_ambientTargetGain(t, rec), ctx.currentTime, 0.03);
  }
}

export function setAmbientMasterVolume(val) {
  ensureAmbientState();
  APP.ambient.masterVol = Math.max(0, Math.min(1, val));
  if (hasAudioContext()) {
    const ctx = actx();
    _active.forEach((rec, id) => {
      if (!rec.gain) return; // interval track currently waiting — nothing to ramp
      const t = _find(id); if (!t) return;
      rec.gain.gain.cancelScheduledValues(ctx.currentTime);
      rec.gain.gain.setTargetAtTime(_ambientTargetGain(t, rec), ctx.currentTime, 0.03);
    });
  }
  _persist();
}

export function toggleAmbientLoop(trackId) {
  const t = _find(trackId); if (!t) return;
  t.loop = !t.loop;
  const rec = _active.get(trackId);
  if (rec?.kind === 'loop' && rec.src) rec.src.loop = t.loop;
  _persist();
  renderAmbientPanel();
}

export function setAmbientFade(trackId, key, val) {
  const t = _find(trackId); if (!t) return;
  const n = Math.max(0, Math.min(30, parseFloat(val)));
  t[key] = isNaN(n) ? 0 : n;
  _persist();
}

/** Toggles time-delayed (random/fixed interval) playback for a track. Restarts playback if currently running. */
export function toggleAmbientInterval(trackId) {
  const t = _find(trackId); if (!t) return;
  t.intervalMode = !t.intervalMode;
  _persist();
  if (isAmbientPlaying(trackId)) {
    stopAmbientTrack(trackId, { fade: false });
    playAmbientTrack(trackId);
  }
  renderAmbientPanel();
}

/** Sets the min/max delay (seconds) between plays in interval mode. If min === max, that exact delay is used every time. */
export function setAmbientInterval(trackId, key, val) {
  const t = _find(trackId); if (!t) return;
  const n = Math.max(0, Math.min(3600, parseFloat(val)));
  t[key] = isNaN(n) ? (key === 'intervalMin' ? 10 : 30) : n;
  _persist();
}
