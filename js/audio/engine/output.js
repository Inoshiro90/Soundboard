/**
 * audio/engine/output.js — EINZIGER Ausgang der Wiedergabe (Phase 4)
 *
 * Alle Live-Quellen (Sound, Vorschau, Ambient, Musik, Rauschen, Reverb-Hub) schließen hier an, nie direkt an
 * `ctx.destination`. Heute ist der Ausgang `ctx.destination`; in Phase 6 wird daraus der Master-Bus mit Safety-Limiter und
 * Stereo-Meter (Vorschau bekommt dann einen eigenen Bus). `kind` ('sound' | 'preview' | 'ambient' | 'music' | 'hub' | 'export')
 * ist dafür schon Teil der Schnittstelle, wirkt heute aber nicht.
 *
 * Ausgenommen (bewusst, offline bzw. Messzweck): timeline.js/macroTimeline.js, editor.js, analysis.js, engine/calibrate.js
 * (Offline-Kontexte) und der stumme Meter-Abgriff in main.js (wird in P6 ersetzt). Ein Test (Suite 18) hält diese Liste fest.
 */
export function outputFor(ctx, kind = 'sound') {   // eslint-disable-line no-unused-vars
  return ctx.destination;
}

/** Verbindet `node` mit dem Ausgang seines Contexts und gibt `node` zurück. */
export function connectToOutput(node, kind = 'sound') {
  node.connect(outputFor(node.context, kind));
  return node;
}
