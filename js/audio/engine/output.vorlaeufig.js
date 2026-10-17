/**
 * audio/engine/output.vorlaeufig.js — vorläufige Ausgangsschicht (Phase 3b)
 *
 * Liefert den Ausgang, an den Hub und Wiedergabe-Pfade anschließen. Heute ist das `ctx.destination`; in Phase 4
 * wird daraus `output.js` (einziger Ausgang, `connectToOutput(node, kind)`) und in Phase 6 der Master-Bus mit
 * Safety-Limiter. Bis dahin gibt es hier genau eine Stelle, die das ändern muss.
 */
export function outputFor(ctx) {
  return ctx.destination;
}
