/**
 * audio/engine/output.js — EINZIGER Ausgang der Wiedergabe (Phase 4, ab Phase 6 mit Bus)
 *
 * Alle Live-Quellen (Sound, Vorschau, Ambient, Musik, Rauschen, Reverb-Hub) schließen hier an, nie direkt an
 * `ctx.destination`. Hat der Context einen Bus (Live-Context, installiert von context.js → buses.js), liefert `outputFor`
 * den passenden Bus-Eingang: Sound/Hub → Master-Bus (mit Master-Lautstärke), Ambient/Musik → Master-Bus, Vorschau →
 * eigener Preview-Bus. Ohne Bus (Offline-Contexts: Export, Tests, Kalibrierung) bleibt es `ctx.destination`; der Export
 * läuft bewusst nie über den Live-Bus.
 *
 * Ausgenommen (bewusst, offline bzw. eigener Graph): timeline.js/macroTimeline.js, editor.js, analysis.js,
 * engine/calibrate.js. Ein Test (Suite 18) hält diese Liste fest.
 */
import { inputFor, setMasterVolume, setSafetyLimiter } from './buses.js';
import { hasAudioContext, actx } from '../context.js';

export function outputFor(ctx, kind = 'sound') {
  return inputFor(ctx, kind) || ctx.destination;
}

/** Verbindet `node` mit dem Ausgang seines Contexts und gibt `node` zurück. */
export function connectToOutput(node, kind = 'sound') {
  node.connect(outputFor(node.context, kind));
  return node;
}

/** Master-Lautstärke der Sounds live auf den Live-Bus anwenden (0..1). Ohne Live-Context: nichts zu tun. */
export function applyMasterVolume(v) {
  if (hasAudioContext()) setMasterVolume(actx(), v);
}

/** Safety-Limiter (Master- und Preview-Bus) ein-/ausschalten. */
export function applySafetyLimiter(on) {
  if (hasAudioContext()) setSafetyLimiter(actx(), !!on);
}
