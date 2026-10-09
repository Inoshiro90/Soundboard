/**
 * renderPipeline.js — Einheitliche Render-Pipeline.
 *
 * Ersetzt NICHT buildEffectChain()/buildPitchNode()/_buildPanner() usw. aus
 * audio/effect-graph.js — diese bleiben als Bausteine bestehen. renderSoundGraph() ist
 * die EINZIGE Stelle, die diese Bausteine für jeden Verwendungszweck
 * (Live-Playback, Preview, WAV-/MP3-Export) in derselben Reihenfolge
 * zusammensetzt, statt dass `playSound()`, `exportSoundToWav()` und
 * `renderSoundOffline()` (export.js) unabhängig voneinander denselben
 * Signalpfad nachbauen — das würde sonst zu Divergenzen führen (z.B. Pitch bei
 * Export oder Fades beim Export vergessen).
 *
 * Bewusst NICHT einbezogen: timeline.js (Mixdown) und
 * ambient/ambient-playback.js nutzen weiterhin ihre eigene, bestehende
 * Graph-Logik — andere Aufrufsemantik (mehrere gleichzeitige Quellen,
 * Dauerschleifen-Layer).
 */

import { resolvePlan, buildPipelineGraph, preparePipelineContext, estimateTail, TARGET_CAPS } from './audio/fx-pipeline.js';
import { asPipelineEffects } from './fx-model.js';

/**
 * Plant eine einzelne Fade-Rampe mit wählbarer Kurvenform auf einem Gain-Node.
 * 'linear' (Standard), 'exponential' (Web Audio erlaubt keine exakte 0 bei
 * exponentialRampToValueAtTime — daher minimale Untergrenze 0.0001, Unterschied
 * liegt unterhalb der Hörschwelle) oder 'sCurve' (Sigmoid, per
 * setValueCurveAtTime aus 50 Stützstellen berechnet).
 */
function _scheduleFadeCurve(gainNode, curve, startVal, endVal, t0, duration) {
  if (duration <= 0) { gainNode.gain.setValueAtTime(endVal, t0); return; }
  switch (curve) {
    case 'exponential': {
      const s = Math.max(startVal, 0.0001), e = Math.max(endVal, 0.0001);
      gainNode.gain.setValueAtTime(s, t0);
      gainNode.gain.exponentialRampToValueAtTime(e, t0 + duration);
      break;
    }
    case 'sCurve': {
      const steps = 50;
      const arr = new Float32Array(steps);
      for (let i = 0; i < steps; i++) {
        const x = i / (steps - 1);
        const sig = 1 / (1 + Math.exp(-10 * (x - 0.5))); // Sigmoid, an [0,1] normiert
        arr[i] = startVal + (endVal - startVal) * sig;
      }
      gainNode.gain.setValueCurveAtTime(arr, t0, duration);
      break;
    }
    case 'linear':
    default:
      gainNode.gain.setValueAtTime(startVal, t0);
      gainNode.gain.linearRampToValueAtTime(endVal, t0 + duration);
  }
}

/**
 * Exportierte Variante von _scheduleFadeCurve() für Aufrufer außerhalb
 * dieses Moduls (audio/playback.js: Crossfade-Ausblenden bereits laufender
 * Instanzen desselben Sounds, s. playSelectedSlot()). Bewusst dieselbe
 * Kurvenlogik wie die Sound-internen Fades — keine zweite Implementierung.
 */
export function scheduleFadeCurve(gainNode, curve, startVal, endVal, t0, duration) {
  _scheduleFadeCurve(gainNode, curve, startVal, endVal, t0, duration);
}

/**
 * Begrenzt Fade-Dauern auf sinnvolle Anteile der Clip-Länge — sonst könnte bei
 * sehr kurzen Clips ein zu lang gewählter Fade den gesamten Clip "auffressen"
 * bzw. beide Fades zusammen mehr als 100% der Dauer beanspruchen
 * (Überlappung/Stille statt hörbarem Sound). Regel: je Fade max. 40% der
 * Clip-Dauer, beide zusammen max. 90% (10% Sicherheitsmarge für einen
 * hörbaren Vollausschlag-Moment in der Mitte).
 */
export function clampFadeDurations(fadeIn, fadeOut, dur) {
  let fi = Math.max(0, Math.min(fadeIn,  dur * 0.4));
  let fo = Math.max(0, Math.min(fadeOut, dur * 0.4));
  if (fi + fo > dur * 0.9) {
    const scale = (dur * 0.9) / (fi + fo);
    fi *= scale; fo *= scale;
  }
  return { fadeIn: fi, fadeOut: fo };
}

/**
 * Legacy-Fades (Sound-weites `s.fade`, Slot-`fadeIn`/`fadeOut`) auf einen
 * Gain-Node anwenden. Kurvenamplitude 0..1.
 * `s.fade` (fixe 0.8s-Ausblendung am Ende) bleibt exklusiv ggü. slot.fadeOut,
 * slot.fadeIn kann mit beidem koexistieren.
 */
function _applyFadeCurve(ctx, gainNode, slot, s, dur) {
  const t0 = ctx.currentTime;
  if (s.fade && !s.loop) {
    const fo = Math.min(0.8, dur * 0.4); // Clamping gilt auch hier
    const fs = Math.max(0, dur - fo);
    _scheduleFadeCurve(gainNode, 'linear', 1, 0, t0 + fs, fo);
  }
  const { fadeIn: fi, fadeOut: fo } = clampFadeDurations(slot.fadeIn || 0, slot.fadeOut || 0, dur);
  const fiCurve = slot.fadeInCurve  || 'linear';
  const foCurve = slot.fadeOutCurve || 'linear';
  if (fi > 0 && !s.loop) {
    _scheduleFadeCurve(gainNode, fiCurve, 0, 1, t0, fi);
  }
  if (fo > 0 && !s.loop && !s.fade) {
    const foStart = Math.max(t0, t0 + dur - fo);
    _scheduleFadeCurve(gainNode, foCurve, 1, 0, foStart, fo);
  }
}

/**
 * Nicht-destruktive Fade-In/Fade-Out-Rampen auf einem EIGENEN, separaten
 * Gain-Node (getrennt von fadeGain, s. Kommentar an _applyFadeCurve()
 * zur Mutual-Exclusivity-Regel der LEGACY-Fades) — dadurch koexistieren die
 * playback.fadeIn/fadeOut konfliktfrei mit den Legacy-Fades
 * (s.fade/slot.fadeIn/slot.fadeOut), ohne konkurrierende Automation auf
 * demselben AudioParam.
 *
 * `crossfadeIn` (optional) wird von playSelectedSlot() (audio/playback.js)
 * gesetzt, wenn diese Wiedergabe technisch ein Crossfade-Übergang zwischen
 * zwei gleichzeitig laufenden Instanzen DESSELBEN Sounds ist (Retrigger bei
 * aktiviertem Overlap) — in diesem Fall ersetzt die Crossfade-Dauer/-Kurve die
 * konfigurierte fadeIn-Rampe für DIESEN Start (die neue Instanz blendet sich
 * über die Crossfade-Zeit ein, während playSelectedSlot() die alten Instanzen
 * parallel darüber ausblendet).
 */
function _applyPlaybackFades(ctx, gainNode, playback, dur, s, crossfadeIn) {
  const t0 = ctx.currentTime;
  if (crossfadeIn && crossfadeIn.duration > 0) {
    const d = Math.min(crossfadeIn.duration, dur);
    _scheduleFadeCurve(gainNode, crossfadeIn.curve || 'linear', 0, 1, t0, d);
    return;
  }
  const fi = playback?.fadeIn;
  if (fi?.enabled && fi.duration > 0 && !s.loop) {
    const d = Math.min(fi.duration, dur * 0.9);
    _scheduleFadeCurve(gainNode, fi.curve || 'linear', 0, 1, t0, d);
  }
  const fo = playback?.fadeOut;
  if (fo?.enabled && fo.duration > 0 && !s.loop) {
    const d = Math.min(fo.duration, dur * 0.9);
    const foStart = Math.max(t0, t0 + dur - d);
    _scheduleFadeCurve(gainNode, fo.curve || 'linear', 1, 0, foStart, d);
  }
}

/**
 * Baut den vollständigen Verarbeitungsgraphen für einen Sound-Slot und
 * verbindet ihn zwischen Quelle und `opts.destination`. Funktioniert identisch
 * für Live-AudioContext und OfflineAudioContext — der einzige Unterschied
 * zwischen den Modi ist der Ziel-Context und ob der Aufrufer anschließend live
 * wiedergibt oder `ctx.startRendering()` aufruft.
 *
 * Pipeline-Reihenfolge:
 *   Source(Trim via start-Offset) → Pipeline (Quelle → Medium → Umgebung → Hörer, inkl. Pitch je Layer)
 *   → Fade-Gain → Playback-Fade-Gain ("Wiedergabe & Verhalten" Fade-In/Fade-Out/Crossfade)
 *   → Master-Gain → Destination.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioBuffer} buffer      - bereits destruktiv bearbeiteter Quell-Buffer
 * @param {object} slot             - { trimStart, trimEnd, fadeIn, fadeOut }
 * @param {object} s                - Sound-Settings: { vol, pitch, loop, fade, effects }
 * @param {object} opts
 * @param {'live'|'preview'|'export'} opts.mode - steuert das Loop-Verhalten.
 * @param {AudioNode} opts.destination
 * @param {number} [opts.masterVol=1] - globale Lautstärke (nur 'live' relevant)
 * @param {boolean} [opts.allowLoop=true] - false erzwingt Einmal-Wiedergabe selbst
 *   bei s.loop (z.B. sequenzielle Makro-Wiedergabe)
 * @param {{duration:number, curve:string}} [opts.crossfadeIn] - s. _applyPlaybackFades()
 * @returns {Promise<{
 *   src: AudioBufferSourceNode, masterGain: GainNode,
 *   dur: number, ts: number, start: (when?: number) => void
 * }>}
 */
export async function renderSoundGraph(ctx, buffer, slot, s, opts) {
  const { destination, mode = 'live', masterVol = 1, allowLoop = true, crossfadeIn = null } = opts;
  const isLive    = mode === 'live';

  const ts = slot.trimStart || 0;
  let   te = slot.trimEnd ?? buffer.duration;
  if (te <= ts) te = buffer.duration;
  const dur = te - ts;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = s.pitch || 1;
  // Preview/Export loopen nie (Bestandsverhalten). `allowLoop=false` erlaubt
  // zusätzlich Aufrufern wie playSoundAndWait() (sequenzielle Makro-
  // Wiedergabe), Loop-Sounds bewusst NICHT zu loopen — sonst würde
  // `onended` nie feuern und die await-Kette der Makro-Sequenz hinge fest.
  src.loop = isLive && allowLoop && !!s.loop;

  // Pipeline: EIN Plan (Quelle → Medium → Umgebung → Hörer, Layer in Benutzerreihenfolge) → EINE serielle
  // Knotenkette. Live, Preview und Export laufen durch dieselbe Funktion; es gibt keine Optimierung, die Layer
  // zusammenfasst oder umordnet (auch kein Pitch-Coalescing). Der Pitch-Worklet wird je Layer-Instanz gebaut.
  const plan = resolvePlan(asPipelineEffects(s.effects));
  await preparePipelineContext(ctx, plan, TARGET_CAPS.sound);
  const graph = buildPipelineGraph(ctx, plan, { numChannels: buffer.numberOfChannels, caps: TARGET_CAPS.sound });
  if (graph.detuneSemitones) src.detune.value = graph.detuneSemitones * 100;

  // Legacy-Fades (s.fade / slot.fadeIn / slot.fadeOut): eigener Gain-Node mit Form 0..1; die eigentliche
  // Lautstärke sitzt separat im masterGain.
  const fadeGain = ctx.createGain(); fadeGain.gain.value = 1;
  _applyFadeCurve(ctx, fadeGain, slot, s, dur);

  // "Wiedergabe & Verhalten": eigener Gain-Node — bewusst getrennt von fadeGain (s. _applyPlaybackFades()-Doku),
  // damit die nicht-destruktiven Fade-In/Fade-Out/Crossfade-Einstellungen unabhängig von den Legacy-Fades funktionieren.
  const playbackFadeGain = ctx.createGain(); playbackFadeGain.gain.value = 1;
  _applyPlaybackFades(ctx, playbackFadeGain, s.playback, dur, s, crossfadeIn);

  // Master-Gain: NUR die statische Lautstärke (s.vol * masterVol bei Live;
  // Preview/Export spielen bei vollem s.vol ohne globalen Master-Regler).
  // Bleibt bewusst UNBERÜHRT von der Fade-Automation, damit z.B. ein Makro-Fadeout (der live auf
  // diesen Node zugreift) nicht mit einer laufenden Rampe kollidiert.
  const baseGain = (s.vol ?? 1) * (isLive ? masterVol : 1);
  const masterGain = ctx.createGain(); masterGain.gain.value = baseGain;

  let node = src;
  if (graph.input) { node.connect(graph.input); node = graph.output; }
  node.connect(fadeGain);
  fadeGain.connect(playbackFadeGain);
  playbackFadeGain.connect(masterGain);
  masterGain.connect(destination);

  return {
    src, masterGain, dur, ts,
    /** Aufgelöster Plan (Reihenfolge s. plan.sequence), geschätzter Nachklang und Aufräumfunktion der Effekt-Knoten. */
    plan, tailSeconds: estimateTail(plan), dispose: graph.dispose,
    /** Startet die Quelle. `when` ist eine ctx-relative Zeit (Default: sofort). */
    start(when = 0) {
      src.start(when, ts, src.loop ? undefined : dur);
    }
  };
}
