/**
 * ambient/ambient-playback.js — Ambient-Wiedergabe-Engine (Loop/Interval/
 * Generator-Zyklen), Auto-Duck, Lautstärke-Rampen
 */

import { APP } from '../core/state.js';
import { toast } from '../notifications.js';
import { actx, hasAudioContext } from '../audio/context.js';
import { resolvePlan, buildPipelineGraph, preparePipelineContext, estimateTail, TARGET_CAPS } from '../audio/fx-pipeline.js';
import { asPipelineEffects } from '../fx-model.js';
import { scheduleFadeCurve } from '../renderPipeline.js';
import { getOrDecodeBuffer } from '../audioCache.js';
import { buildNoiseGenerator } from '../generators.js';
// Zirkulärer Import (ambient-model.js importiert umgekehrt _active aus
// diesem Modul für setAmbientTrackVolume()/setAmbientMasterVolume(); die
// UI-Rendering-Funktion _updateRowPlayState() unten importieren wir hier
// aus ambient-render.js, das wiederum isAmbientPlaying()/isAmbientWaiting()
// und _active aus DIESEM Modul importiert) — unkritisch, da alle betroffenen
// Bezeichner Funktionsdeklarationen bzw. nur zur Laufzeit gelesene/
// geschriebene Objekte sind (dasselbe Muster wie in audio/playback.js).
import { _find } from './ambient-model.js';
import { _updateRowPlayState } from './ambient-render.js';
import { getAmbientVolumeConfig, pickRandomVolume, VOLUME_MODE_VARYING } from './ambient-volume.js';

// Runtime-only playback state — never persisted.
// trackId → { kind: 'loop' | 'interval' | 'chain' | 'generator', src, gain, timerId, clipVol }
// clipVol: Basis-Lautstärke des AKTUELLEN Clips bei Lautstärkevarianz (null/undefined bei 'constant').
// For 'interval' tracks, src/gain are null while waiting between plays —
// the track still counts as "playing" (scheduled) the whole time.
// Exportiert: ambient-model.js liest/schreibt _active direkt für
// die Live-Gain-Rampen in setAmbientTrackVolume()/setAmbientMasterVolume();
// ambient-render.js liest _active.size für den globalen Live-Indikator.
export const _active = new Map();

// Auto Duck: globaler Ducking-Multiplikator (1.0 = kein Ducking, s.
// duckAmbient()/audio/playback.js notifyDuckTrigger()). Bewusst NICHT in APP.ambient
// persistiert — reiner Laufzeitzustand, analog zu _active.
let _duckFactor = 1.0;

/**
 * Würfelt die Basis-Lautstärke für einen NEU startenden Clip: bei 'varying' ein Zufallswert
 * in [volumeMin, volumeMax], sonst null. Wird genau einmal pro tatsächlichem Abspielen
 * aufgerufen (Start, nächster Loop-Ketten-Clip, nächster Zeitversetzt-Durchlauf) und im
 * Laufzeit-Record (rec.clipVol) abgelegt — nie pro Frame oder bei Live-Rampen.
 */
function _rollClipVolume(t) {
  const c = getAmbientVolumeConfig(t);
  return c.mode === VOLUME_MODE_VARYING ? pickRandomVolume(c.min, c.max) : null;
}

/**
 * Zentrale Ziel-Gain-Formel für einen Ambient-Track: Basis-Lautstärke × Master × Duck.
 * Basis = t.vol bei 'constant' (bisheriges Verhalten, unverändert) bzw. die für den
 * aktuellen Clip gewürfelte Lautstärke (rec.clipVol) bei 'varying'. Fehlt sie noch (z. B.
 * Moduswechsel während der Wiedergabe), wird sie einmalig gewürfelt und im Record gehalten,
 * damit wiederholte Rampen (Duck/Master/Lautstärke) denselben Wert verwenden.
 */
export function _ambientTargetGain(t, rec) {
  const c = getAmbientVolumeConfig(t);
  let base;
  if (c.mode === VOLUME_MODE_VARYING) {
    if (rec && typeof rec.clipVol !== 'number') rec.clipVol = pickRandomVolume(c.min, c.max);
    base = rec ? rec.clipVol : (c.min + c.max) / 2;
  } else {
    base = t.vol ?? 0.7;
  }
  return base * (APP.ambient.masterVol ?? 1) * _duckFactor;
}

/**
 * Auto Duck: setzt den globalen Ducking-Multiplikator und rampt alle
 * AKTUELL aktiven Ambient-Tracks dorthin. Neu gestartete Tracks (s.
 * _ambientTargetGain() in _playLoopTrack/_playChainCycle/_playIntervalCycle)
 * berücksichtigen _duckFactor automatisch von Anfang an, auch wenn sie
 * WÄHREND eines aktiven Duckings starten.
 * @param {number} factor - Ziel-Multiplikator (1.0 = normal, (1-amount) = geduckt)
 * @param {number} timeConstantSec - Zeitkonstante der Rampe (setTargetAtTime)
 */
export function duckAmbient(factor, timeConstantSec) {
  _duckFactor = factor;
  if (!hasAudioContext()) return;
  const ctx = actx();
  _active.forEach((rec, id) => {
    if (!rec.gain) return; // interval/chain-Track gerade zwischen zwei Clips — nichts zu rampen
    const t = _find(id); if (!t) return;
    rec.gain.gain.cancelScheduledValues(ctx.currentTime);
    rec.gain.gain.setTargetAtTime(_ambientTargetGain(t, rec), ctx.currentTime, timeConstantSec);
  });
}


/** Picks which file variant to play next, per the track's variantMode. Skips unloaded files. */
function _pickTrackFile(t) {
  const files = (t.files || []).filter(f => f && f.data);
  if (!files.length) return null;
  if (files.length === 1) { t._lastFileId = files[0].id; return files[0]; }

  if (t.variantMode === 'rotate') {
    let idx = t._rotateIndex ?? 0;
    if (idx < 0 || idx >= files.length) idx = 0;
    const pick = files[idx];
    t._rotateIndex = (idx + 1) % files.length;
    t._lastFileId = pick.id;
    return pick;
  }

  // Random — avoid repeating the immediately previous file when possible.
  let pool = files;
  if (t._lastFileId) {
    const rest = files.filter(f => f.id !== t._lastFileId);
    if (rest.length) pool = rest;
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  t._lastFileId = pick.id;
  return pick;
}

function _pickIntervalDelay(t) {
  const a = Math.max(0, t.intervalMin ?? 10);
  const b = Math.max(0, t.intervalMax ?? 10);
  const min = Math.min(a, b), max = Math.max(a, b);
  if (min === max) return min;
  return min + Math.random() * (max - min);
}

// ─── PLAYBACK ────────────────────────────────────────────────
// Note: playback is looked up by trackId only (globally unique), so a track
// keeps playing correctly even if the user switches scenes/modes while it runs.
// Two modes:
//  - 'loop':     a single continuously looping (or one-shot) AudioBufferSource.
//  - 'interval': plays the clip once, then waits a random/fixed delay
//                (intervalMin…intervalMax seconds) before playing again —
//                the track counts as "running" for the whole wait, too.

export function isAmbientPlaying(trackId) { return _active.has(trackId); }

/** True while a scheduled interval-track is silently waiting for its next play. */
export function isAmbientWaiting(trackId) {
  const rec = _active.get(trackId);
  return !!(rec && rec.kind === 'interval' && !rec.src);
}

export async function toggleAmbientPlay(trackId) {
  if (_active.has(trackId)) stopAmbientTrack(trackId, { fade: true });
  else await playAmbientTrack(trackId);
}

export async function playAmbientTrack(trackId) {
  const t = _find(trackId); if (!t) return;
  if (_active.has(trackId)) return;

  // Noise-Generator-Tracks haben keine Dateien — eigener Startpfad.
  if (t.sourceType === 'generator') { await _playGeneratorTrack(trackId); return; }

  if (!(t.files || []).some(f => f.data)) { toast('Keine Audiodatei geladen', 'err'); return; }

  if (t.intervalMode) {
    _active.set(trackId, { kind: 'interval', src: null, gain: null, timerId: null });
    _updateRowPlayState(trackId, true);
    await _playIntervalCycle(trackId);
  } else {
    await _startLoopPlayback(trackId);
  }
}

/**
 * Startet einen Noise-Generator-Track. Läuft endlos (kein "Ende" wie
 * bei einer Audiodatei) — wird ausschließlich über stopAmbientTrack()
 * beendet, s. dortige kind==='generator'-Sonderbehandlung (disconnect()
 * statt stop(), AudioWorkletNode kennt kein .stop()).
 */
async function _playGeneratorTrack(trackId) {
  _active.set(trackId, { kind: 'generator', src: null, gain: null, timerId: null });
  const ctx = actx();
  const node = await buildNoiseGenerator(ctx, _find(trackId)?.generatorType || 'pink');
  await _prepareFx(ctx, _find(trackId)?.effects);

  // Re-Check: Track könnte während des (async) Worklet-Ladens gestoppt
  // worden sein.
  const rec = _active.get(trackId);
  if (!rec || rec.kind !== 'generator') { try { node?.disconnect(); } catch (e) {} return; }

  if (!node) {
    toast('Rauschgenerator konnte nicht geladen werden', 'err');
    _active.delete(trackId); _updateRowPlayState(trackId, false);
    return;
  }

  const t = _find(trackId); if (!t) { node.disconnect(); _active.delete(trackId); return; }

  const gainNode = ctx.createGain();
  // Generator kennen keine Clips — ein „Abspielen" = ein Start, dort wird einmal gewürfelt.
  rec.clipVol   = _rollClipVolume(t);
  const target  = _ambientTargetGain(t, rec);
  const fadeIn  = Math.max(0, t.fadeIn || 0);
  const now     = ctx.currentTime;
  gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : target, now);
  if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(target, now + fadeIn);
  gainNode.connect(ctx.destination);
  rec.fxDispose = _connectWithFx(ctx, node, t.effects, gainNode);

  rec.src  = node;
  rec.gain = gainNode;
  _updateRowPlayState(trackId, true);
}

/** Lädt vor dem (synchronen) Graph-Bau das Pitch-Worklet des Contexts — nach jedem await-Re-Check kein weiteres await. */
async function _prepareFx(ctx, effects) {
  try { await preparePipelineContext(ctx, resolvePlan(asPipelineEffects(effects)), TARGET_CAPS.ambient); }
  catch (e) { console.warn('[ambient] FX-Vorbereitung fehlgeschlagen:', e); }
}

/**
 * Routes src → Pipeline (Quelle → Medium → Umgebung → Hörer, Layer in Benutzerreihenfolge) → gainNode.
 * Gibt die Aufräumfunktion zurück. Bei Buffer-Quellen wird sie automatisch nach 'ended' (+ Nachklang) ausgeführt;
 * Generator-Knoten (kein 'ended') räumt stopAmbientTrack() über rec.fxDispose auf.
 */
function _connectWithFx(ctx, src, effects, gainNode) {
  const plan  = resolvePlan(asPipelineEffects(effects));
  const graph = buildPipelineGraph(ctx, plan, { numChannels: src.buffer?.numberOfChannels || 2, caps: TARGET_CAPS.ambient });
  if (graph.detuneSemitones) { try { src.detune.value = graph.detuneSemitones * 100; } catch (e) {} }
  if (graph.input) { src.connect(graph.input); graph.output.connect(gainNode); }
  else src.connect(gainNode);
  if (src.addEventListener && src.buffer !== undefined) {
    src.addEventListener('ended', () => setTimeout(graph.dispose, Math.ceil(estimateTail(plan) * 1000) + 500));
  }
  return graph.dispose;
}

async function _startLoopPlayback(trackId) {
  const t = _find(trackId); if (!t) return;
  const fileCount = (t.files || []).filter(f => f && f.data).length;

  // Looping with several file variants: chain discrete plays back-to-back,
  // picking a new variant (random/rotate) each time instead of looping
  // the same single buffer forever.
  if (t.loop && fileCount > 1) {
    _active.set(trackId, { kind: 'chain', src: null, gain: null, timerId: null, started: false });
    await _playChainCycle(trackId);
    return;
  }

  const file = _pickTrackFile(t);
  if (!file) { toast('Keine Audiodatei geladen', 'err'); return; }
  const ctx = actx();
  const buf = await getOrDecodeBuffer(file.id, 0, file.data, ctx);
  await _prepareFx(ctx, t.effects);
  if (!buf) { toast('Audio konnte nicht geladen werden', 'err'); return; }
  if (_active.has(trackId)) return; // started elsewhere while decoding

  const gainNode = ctx.createGain();
  // Record vor der Gain-Berechnung anlegen, damit der gewürfelte Clip-Wert darin liegt;
  // registriert (_active.set) wird er erst unten, unverändert nach dem Re-Check oben.
  // Einzeldatei im Loop = ein einziger Clip → ein Zufallswert bis zum Stopp.
  const rec = { kind: 'loop', src: null, gain: null, timerId: null, clipVol: _rollClipVolume(t) };
  const target   = _ambientTargetGain(t, rec);
  const fadeIn   = Math.max(0, t.fadeIn || 0);
  const now      = ctx.currentTime;
  gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : target, now);
  if (fadeIn > 0) scheduleFadeCurve(gainNode, t.fadeInCurve || 'linear', 0, target, now, fadeIn);
  gainNode.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop   = !!t.loop;
  _connectWithFx(ctx, src, t.effects, gainNode);

  rec.src  = src;
  rec.gain = gainNode;
  _active.set(trackId, rec);

  src.onended = () => {
    if (_active.get(trackId) === rec) {
      _active.delete(trackId);
      _updateRowPlayState(trackId, false);
    }
  };

  const ts = file.trimStart || 0;
  let   te = file.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  src.start(0, ts, src.loop ? undefined : (te - ts));
  _updateRowPlayState(trackId, true);
}

/**
 * Loop-mode playback for tracks with multiple file variants: plays one
 * variant fully, then continues with the next one picked per variantMode —
 * repeating until stopped.
 *
 * Crossfade zwischen Varianten ist NUR hier sinnvoll (kontinuierliche Kette
 * mehrerer Dateien) — nicht bei einer einzelnen Datei im Loop (nichts, wohin
 * überblendet werden könnte) und nicht bei Intervall-Wiedergabe (dort sind
 * Pausen zwischen den Plays gewollt, ein Crossfade würde dem widersprechen).
 * Ist t.crossfade.enabled, wird die NÄCHSTE Variante nicht erst im onended der
 * aktuellen gestartet (kein Overlap möglich), sondern vorzeitig per Timer —
 * s. leadMs unten — während die aktuelle noch läuft; beide Gain-Nodes werden
 * dann gegenläufig überblendet (identische Rampen-Technik wie der Sound-Crossfade
 * in audio/playback.js playSelectedSlot(); nicht mit js/music/music-playback.js
 * geteilt, da beide einen eigenen Lebenszyklus haben).
 */
async function _playChainCycle(trackId) {
  let rec = _active.get(trackId);
  if (!rec || rec.kind !== 'chain') return; // stopped in the meantime

  const t = _find(trackId);
  if (!t || !t.loop) { _active.delete(trackId); _updateRowPlayState(trackId, false); return; }
  const file = _pickTrackFile(t);
  if (!file) { _active.delete(trackId); _updateRowPlayState(trackId, false); return; }

  const ctx = actx();
  const buf = await getOrDecodeBuffer(file.id, 0, file.data, ctx);
  await _prepareFx(ctx, t.effects);

  rec = _active.get(trackId);
  if (!rec || rec.kind !== 'chain') return; // stopped while decoding
  if (!buf) { toast('Audio konnte nicht geladen werden', 'err'); _active.delete(trackId); _updateRowPlayState(trackId, false); return; }

  const cf = t.crossfade;
  const useCrossfade = !!(cf?.enabled) && cf.duration > 0;

  const ts = file.trimStart || 0;
  let   te = file.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  const dur = te - ts;

  const gainNode = ctx.createGain();
  // Neuer Clip der Kette → neuer Zufallswert. Bewusst erst NACH dem asynchronen Decode und
  // direkt vor dem Austausch von rec.gain: bis dahin gehört rec.clipVol noch zum laufenden
  // Vorgänger-Clip (Duck-/Master-Rampen dürfen ihn nicht umspringen lassen). Beim Crossfade
  // behält die auslaufende Gain-Node ihren eigenen Pegel (prevGain), nur die neue erhält den neuen Wert.
  rec.clipVol     = _rollClipVolume(t);
  const target    = _ambientTargetGain(t, rec);
  const now       = ctx.currentTime;

  // Die noch laufende VORHERIGE Variante (falls vorhanden) — vor dem
  // Überschreiben von rec.src/rec.gain sichern, s.u.
  const prevSrc  = rec.started ? rec.src  : null;
  const prevGain = rec.started ? rec.gain : null;

  if (useCrossfade && prevSrc) {
    // Überlappender Wechsel: neue Variante blendet ein, während die alte
    // (separat, parallel) ausblendet — beide über dieselbe Crossfade-Dauer/-Kurve.
    const d = Math.min(cf.duration, dur);
    scheduleFadeCurve(gainNode, cf.curve || 'linear', 0, target, now, d);
  } else {
    // Kein Crossfade (aus, oder allererste Variante der Kette): bisheriges
    // Verhalten — nur beim allerersten Clip einblenden, danach nahtlos voll.
    const fadeIn = rec.started ? 0 : Math.max(0, t.fadeIn || 0);
    gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : target, now);
    if (fadeIn > 0) scheduleFadeCurve(gainNode, t.fadeInCurve || 'linear', 0, target, now, fadeIn);
  }
  gainNode.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop   = false; // each variant plays once, then we chain to the next
  _connectWithFx(ctx, src, t.effects, gainNode);

  rec.src     = src;
  rec.gain    = gainNode;
  rec.started = true;
  if (rec.timerId) { clearTimeout(rec.timerId); rec.timerId = null; }

  if (useCrossfade && prevSrc && prevGain) {
    // Alte Variante parallel ausblenden und danach stoppen — sie läuft
    // technisch noch bis zu ihrem eigenen geplanten Ende weiter, wird aber
    // durch die Rampe schon vorher unhörbar; explizites stop() danach
    // räumt den Knoten zuverlässig auf (analog audio/playback.js Sound-Crossfade).
    const d = Math.min(cf.duration, dur);
    try {
      prevGain.gain.cancelScheduledValues(now);
      prevGain.gain.setValueAtTime(prevGain.gain.value, now);
      scheduleFadeCurve(prevGain, cf.curve || 'linear', prevGain.gain.value, 0, now, d);
    } catch (e) {}
    prevSrc.onended = null; // verhindert, dass ihr alter Handler die Kette doppelt fortsetzt
    setTimeout(() => { try { prevSrc.stop(); } catch (e) {} }, d * 1000 + 50);
  }

  if (useCrossfade) {
    // Nächste Variante VOR dem natürlichen Ende dieser hier anstoßen, statt
    // erst in onended (das wäre zu spät für einen Overlap) — Vorlaufzeit =
    // Klip-Dauer minus Crossfade-Dauer (min. 0, falls Klip kürzer ist).
    const leadMs = Math.max(0, dur - Math.min(cf.duration, dur)) * 1000;
    rec.timerId = setTimeout(() => {
      const cur = _active.get(trackId);
      if (!cur || cur.kind !== 'chain' || cur.src !== src) return; // inzwischen gestoppt/ersetzt
      cur.timerId = null;
      _playChainCycle(trackId);
    }, leadMs);
    // onended dient hier nur noch der Aufräum-Buchhaltung, falls das Ende
    // VOR dem Timer eintrifft (z.B. sehr kurzer Klip) — die Fortsetzung
    // übernimmt in diesem Fall bereits der obige Timer, nicht onended.
    src.onended = () => {
      const cur = _active.get(trackId);
      if (!cur || cur.src !== src) return;
      cur.src = null; cur.gain = null;
    };
  } else {
    src.onended = () => {
      const cur = _active.get(trackId);
      if (!cur || cur.src !== src) return; // stopped/replaced already
      cur.src  = null;
      cur.gain = null;
      _playChainCycle(trackId); // immediately continue with the next variant
    };
  }

  src.start(0, ts, dur);
  _updateRowPlayState(trackId, true);
}

/** Plays one shot of an interval-mode track (picking a file variant), then schedules the next one after a random/fixed delay. */
async function _playIntervalCycle(trackId) {
  let rec = _active.get(trackId);
  if (!rec || rec.kind !== 'interval') return; // stopped in the meantime

  const t = _find(trackId);
  if (!t || !(t.files || []).some(f => f.data)) { _active.delete(trackId); _updateRowPlayState(trackId, false); return; }
  const file = _pickTrackFile(t);
  if (!file) { _active.delete(trackId); _updateRowPlayState(trackId, false); return; }

  const ctx = actx();
  const buf = await getOrDecodeBuffer(file.id, 0, file.data, ctx);
  await _prepareFx(ctx, t.effects);

  // Re-check after the async decode — the track may have been stopped while we waited.
  rec = _active.get(trackId);
  if (!rec || rec.kind !== 'interval') return;
  if (!buf) { toast('Audio konnte nicht geladen werden', 'err'); _active.delete(trackId); _updateRowPlayState(trackId, false); return; }

  const gainNode = ctx.createGain();
  // Jeder Zeitversetzt-Durchlauf ist ein neuer Clip → neuer Zufallswert.
  rec.clipVol    = _rollClipVolume(t);
  const target   = _ambientTargetGain(t, rec);
  const fadeIn   = Math.max(0, t.fadeIn || 0);
  const now      = ctx.currentTime;
  gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : target, now);
  if (fadeIn > 0) scheduleFadeCurve(gainNode, t.fadeInCurve || 'linear', 0, target, now, fadeIn);
  gainNode.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop   = false; // interval mode always plays discrete one-shots
  _connectWithFx(ctx, src, t.effects, gainNode);

  rec.src  = src;
  rec.gain = gainNode;

  src.onended = () => {
    const cur = _active.get(trackId);
    if (!cur || cur.src !== src) return; // stopped/replaced already
    cur.src  = null;
    cur.gain = null;
    const delaySec = _pickIntervalDelay(_find(trackId) || t);
    cur.timerId = setTimeout(() => _playIntervalCycle(trackId), delaySec * 1000);
    _updateRowPlayState(trackId, true);
  };

  const ts = file.trimStart || 0;
  let   te = file.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  src.start(0, ts, te - ts);
  _updateRowPlayState(trackId, true);
}

export function stopAmbientTrack(trackId, { fade = true } = {}) {
  const rec = _active.get(trackId);
  if (!rec) return;
  if (rec.timerId) { clearTimeout(rec.timerId); rec.timerId = null; }
  if (rec.src) {
    const t = _find(trackId);
    // Noise-Generatoren sind AudioWorkletNodes — die kennen kein
    // .stop() (laufen endlos, bis man sie trennt). Ein unbedingtes
    // rec.src.stop() würde hier nur einen TypeError werfen
    // (vom umgebenden try/catch verschluckt) und den Node NIE trennen —
    // stiller Ressourcen-Leak (Worklet läuft unhörbar, aber weiter,
    // bis die Seite neu geladen wird).
    const stopNode = () => { try {
      if (rec.kind === 'generator') rec.src.disconnect(); else rec.src.stop();
    } catch (e) { /* already stopped */ } };
    try {
      if (hasAudioContext()) {
        const ctx     = actx();
        const fadeOut = fade ? Math.max(0, t?.fadeOut ?? 0) : 0;
        if (fadeOut > 0) {
          const now = ctx.currentTime;
          rec.gain.gain.cancelScheduledValues(now);
          rec.gain.gain.setValueAtTime(rec.gain.gain.value, now);
          scheduleFadeCurve(rec.gain, t?.fadeOutCurve || 'linear', rec.gain.gain.value, 0, now, fadeOut);
          setTimeout(stopNode, fadeOut * 1000 + 60);
        } else {
          stopNode();
        }
      } else {
        stopNode();
      }
    } catch (e) { /* already stopped */ }
    if ('onended' in rec.src) rec.src.onended = null; // prevent the natural-end handler from re-scheduling (n/a for generator nodes)
  }
  if (rec.fxDispose) { const d = rec.fxDispose; rec.fxDispose = null; setTimeout(d, 600); }   // Generator-Pipeline (kein 'ended')
  _active.delete(trackId);
  _updateRowPlayState(trackId, false);
}

export function stopAllAmbient() {
  [..._active.keys()].forEach(id => stopAmbientTrack(id, { fade: true }));
}

