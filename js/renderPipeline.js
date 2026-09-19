/**
 * renderPipeline.js — Einheitliche Render-Pipeline (P1).
 *
 * Ersetzt NICHT buildEffectChain()/buildPitchNode()/_buildPanner() usw. aus
 * audio.js — diese bleiben als Bausteine bestehen. renderSoundGraph() ist
 * die EINZIGE Stelle, die diese Bausteine für jeden Verwendungszweck
 * (Live-Playback, Preview, WAV-/MP3-Export) in derselben Reihenfolge
 * zusammensetzt. Vorher bauten `playSound()`, `exportSoundToWav()` und
 * `renderSoundOffline()` (export.js) unabhängig voneinander denselben
 * Signalpfad nach — das führte strukturell zu genau den im Audit
 * beschriebenen Divergenzen (Pitch bei Export vergessen, Noise Gate
 * nirgends verdrahtet, s. P0-Fixes) UND, wie sich bei dieser
 * Vereinheitlichung zeigte, zu einer weiteren, bisher unentdeckten
 * Divergenz: Fades/Envelope wurden beim Export überhaupt nicht angewendet
 * (nur bei Live-Playback). Diese Pipeline behebt das als Nebeneffekt der
 * Vereinheitlichung.
 *
 * Siehe AUDACITY_SOUNDBOARD_IMPLEMENTATION_PLAN.md, Abschnitt
 * "1. Zielarchitektur: Einheitliche Render-Pipeline".
 *
 * Bewusst NICHT einbezogen in diesem Durchgang: timeline.js (Mixdown) und
 * ambient.js nutzen weiterhin ihre eigene, bestehende Graph-Logik — das
 * Umstellen dieser beiden Module auf renderSoundGraph() ist eine separate,
 * für sich genommen risikoreiche Änderung (andere Aufrufsemantik: mehrere
 * gleichzeitige Quellen, Dauerschleifen-Layer) und wird hier bewusst nicht
 * mit erledigt, um das Risiko dieses Durchgangs nicht unnötig zu erhöhen.
 */

import { buildPitchNode, buildEffectChain, ensurePitchWorkletFor, createAnalyzerSplit } from './audio.js';

/**
 * ADSR-Hüllkurve auf einen Gain-Node anwenden. Kurvenamplitude ist IMMER
 * 0..1 (nicht baseGain-skaliert) — die eigentliche Lautstärke lebt in
 * einem separaten, nachgeschalteten Master-Gain-Node (siehe
 * renderSoundGraph()). Das ist die strukturelle Korrektur aus Plan-
 * Abschnitt 1.5: Envelope und (Legacy-)Fades bekommen getrennte,
 * in Serie geschaltete Gain-Nodes, statt konkurrierend auf demselben
 * AudioParam zu automatisieren.
 */
function _applyEnvelopeCurve(ctx, gainNode, env, dur) {
  const t0  = ctx.currentTime;
  const att = Math.max(0.001, env.attack  ?? 0.01);
  const dec = Math.max(0.001, env.decay   ?? 0.15);
  const sus = Math.max(0, Math.min(1, env.sustain ?? 0.8));
  const rel = Math.max(0.001, env.release ?? 0.25);
  gainNode.gain.cancelScheduledValues(t0);
  gainNode.gain.setValueAtTime(0, t0);
  gainNode.gain.linearRampToValueAtTime(1, t0 + att);
  gainNode.gain.linearRampToValueAtTime(sus, t0 + att + dec);
  const relStart = Math.max(t0 + att + dec, t0 + dur - rel);
  gainNode.gain.setValueAtTime(sus, relStart);
  gainNode.gain.linearRampToValueAtTime(0, relStart + rel);
}

/**
 * P3: Plant eine einzelne Fade-Rampe mit wählbarer Kurvenform auf einem
 * Gain-Node. 'linear' (Standard/Bestandsverhalten), 'exponential' (Web
 * Audio erlaubt keine exakte 0 bei exponentialRampToValueAtTime — daher
 * minimale Untergrenze 0.0001, Unterschied liegt unterhalb der
 * Hörschwelle) oder 'sCurve' (Sigmoid, per setValueCurveAtTime aus 50
 * Stützstellen berechnet).
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
 * BUGFIX (Audit-Problem 13): begrenzt Fade-Dauern auf sinnvolle Anteile
 * der Clip-Länge — vorher konnte bei sehr kurzen Clips ein zu lang
 * gewählter Fade den gesamten Clip "auffressen" bzw. beide Fades
 * zusammen mehr als 100% der Dauer beanspruchen (Überlappung/Stille statt
 * hörbarem Sound). Regel: je Fade max. 40% der Clip-Dauer, beide
 * zusammen max. 90% (10% Sicherheitsmarge für einen hörbaren
 * Vollausschlag-Moment in der Mitte). Ersetzt den bisherigen Ad-hoc-
 * Clamp (`Math.min(fi, dur*0.5)`, ohne Berücksichtigung von fadeOut).
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
 * Gain-Node anwenden. Kurvenamplitude 0..1 (s. _applyEnvelopeCurve-Doku).
 * Mutual-Exclusivity-Regel unverändert ggü. Bestandscode: eine aktive
 * Envelope ersetzt die Legacy-Fades vollständig; `s.fade` (fixe 0.8s-
 * Ausblendung am Ende) bleibt exklusiv ggü. slot.fadeOut, slot.fadeIn
 * kann mit beidem koexistieren (identisch zum Verhalten vor P3).
 */
function _applyFadeCurve(ctx, gainNode, slot, s, dur) {
  const t0 = ctx.currentTime;
  if (s.fade && !s.loop) {
    const fo = Math.min(0.8, dur * 0.4); // Audit-13-Clamping gilt auch hier
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
 * Baut den vollständigen Verarbeitungsgraphen für einen Sound-Slot und
 * verbindet ihn zwischen Quelle und `opts.destination`. Funktioniert
 * identisch für Live-AudioContext und OfflineAudioContext — der einzige
 * Unterschied zwischen den Modi ist der Ziel-Context und ob der Aufrufer
 * anschließend live wiedergibt oder `ctx.startRendering()` aufruft.
 *
 * Pipeline-Reihenfolge (Plan Abschnitt 1.3):
 *   Source(Trim via start-Offset) → Pitch → Realtime-Effekte (inkl. Noise
 *   Gate/Panner) → Envelope-Gain → Fade-Gain → Master-Gain → [Analyser] →
 *   Destination.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioBuffer} buffer      - bereits destruktiv bearbeiteter Quell-Buffer
 * @param {object} slot             - { trimStart, trimEnd, fadeIn, fadeOut }
 * @param {object} s                - Sound-Settings: { vol, pitch, loop, fade, effects }
 * @param {object} opts
 * @param {'live'|'preview'|'export'} opts.mode - steuert Loop-Verhalten UND
 *   ob ein AnalyserNode erzeugt wird (live/preview ja, export nein).
 * @param {AudioNode} opts.destination
 * @param {number} [opts.masterVol=1] - globale Lautstärke (nur 'live' relevant, s.o. Bestandsverhalten)
 * @param {boolean} [opts.allowLoop=true] - false erzwingt Einmal-Wiedergabe selbst bei s.loop (z.B. sequenzielle Makro-Wiedergabe)
 * @returns {Promise<{
 *   src: AudioBufferSourceNode, masterGain: GainNode, analyser: AnalyserNode|null,
 *   dur: number, ts: number, start: (when?: number) => void
 * }>}
 */
export async function renderSoundGraph(ctx, buffer, slot, s, opts) {
  const { destination, mode = 'live', masterVol = 1, allowLoop = true } = opts;
  const isLive    = mode === 'live';
  // Abschnitt 3/8: Analyzer war bisher an isLive geknüpft — dadurch blieb
  // er bei mode==='preview' immer leer, obwohl die Preview denselben Graph
  // durchläuft. Live UND Preview dürfen ihn erzeugen (sofern in den
  // Effekten aktiviert); Export bleibt bewusst ausgeschlossen (dort gibt
  // es kein Canvas/keine Live-Visualisierung, nur unnötiger Overhead).
  const isPreview = mode === 'preview';

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

  // Pitch-Worklet: Context-spezifisch sicherstellen (P0-Fix, gilt gleicher-
  // maßen für Live- UND Offline-Context).
  let pitchNode = null;
  if (s.effects?.pitchShift?.enabled && (s.effects.pitchShift.semitones ?? 0) !== 0) {
    await ensurePitchWorkletFor(ctx);
    pitchNode = buildPitchNode(ctx, s.effects.pitchShift, buffer.numberOfChannels);
    if (!pitchNode) src.detune.value = (s.effects.pitchShift.semitones ?? 0) * 100;
  }

  const chain = buildEffectChain(ctx, s.effects);

  // Envelope/Fades: getrennte, in Serie geschaltete Gain-Nodes (Plan 1.5) —
  // vermeidet konkurrierende Automation auf demselben AudioParam. Beide
  // Nodes tragen nur die FORM der Hüllkurve (0..1); die eigentliche
  // Lautstärke sitzt separat im masterGain.
  const envelopeGain = ctx.createGain(); envelopeGain.gain.value = 1;
  const fadeGain      = ctx.createGain(); fadeGain.gain.value      = 1;
  if (s.effects?.envelope?.enabled) {
    _applyEnvelopeCurve(ctx, envelopeGain, s.effects.envelope, dur);
  } else {
    _applyFadeCurve(ctx, fadeGain, slot, s, dur);
  }

  // Master-Gain: NUR die statische Lautstärke (s.vol * masterVol bei Live;
  // Preview/Export spielen bei vollem s.vol ohne globalen Master-Regler,
  // identisch zum bisherigen Verhalten). Bleibt bewusst UNBERÜHRT von
  // Envelope/Fade-Automation, damit z.B. ein Makro-Fadeout (der live auf
  // diesen Node zugreift) nicht mit einer laufenden Envelope kollidiert.
  const baseGain = (s.vol ?? 1) * (isLive ? masterVol : 1);
  const masterGain = ctx.createGain(); masterGain.gain.value = baseGain;

  let analyser = null;
  if ((isLive || isPreview) && s.effects?.analyzer?.enabled) analyser = createAnalyzerSplit(ctx);

  let node = src;
  if (pitchNode) { node.connect(pitchNode.input); node = pitchNode.output; }
  if (chain)     { node.connect(chain.input);     node = chain.output; }
  node.connect(envelopeGain);
  envelopeGain.connect(fadeGain);
  fadeGain.connect(masterGain);
  if (analyser) masterGain.connect(analyser);
  masterGain.connect(destination);

  return {
    src, masterGain, analyser, dur, ts,
    /** Startet die Quelle. `when` ist eine ctx-relative Zeit (Default: sofort). */
    start(when = 0) {
      src.start(when, ts, src.loop ? undefined : dur);
    }
  };
}
