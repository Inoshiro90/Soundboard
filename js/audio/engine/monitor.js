/**
 * audio/engine/monitor.js — Überlast-Wächter (Phase 3a, Schritt 6): Sicherheitsnetz hinter dem Budget.
 * ----------------------------------------------------------------------------------------------------------------------
 * Signal: Verhältnis Audio-Uhr (`ctx.currentTime`) zur Wanduhr über ≈ 1 s. Unter 0,92 = Überlast (gemessen bei Überlast:
 * 0,88 und 0,77 in Chrome [S]). Zusätzlich Underrun-Zähler, wo `ctx.playbackStats` existiert (Chrome; Eigenschaftsname [H]).
 * Ausgesetzt bei `suspended`, unsichtbarem Tab und gedrosselten Zeitgebern. Firefox/Safari: Gültigkeit des Verhältnisses [H] (M-2).
 * `sample()` ist rein (Zeiten werden übergeben); `startMonitor()` verdrahtet es mit Browser-Uhren.
 */
export const OVERLOAD_RATIO = 0.92;

export class OverloadMonitor {
  constructor({ threshold = OVERLOAD_RATIO, windowMs = 1000, cooldownMs = 3000, onOverload = () => {} } = {}) {
    this.threshold = threshold; this.windowMs = windowMs; this.cooldownMs = cooldownMs; this.onOverload = onOverload;
    this.last = null; this.lastFire = -Infinity;
  }

  reset() { this.last = null; }

  /** @returns {{ratio:number, underrunDelta:number, overload:boolean}|null} null = (noch) keine Aussage */
  sample({ audioTime, wallMs, suspended = false, hidden = false, underruns = null }) {
    if (suspended || hidden || !Number.isFinite(audioTime) || !Number.isFinite(wallMs)) { this.last = null; return null; }
    if (!this.last) { this.last = { audioTime, wallMs, underruns }; return null; }
    const dw = wallMs - this.last.wallMs;
    if (dw < this.windowMs) return null;
    if (dw > this.windowMs * 3) { this.last = { audioTime, wallMs, underruns }; return null; }   // Zeitgeber gedrosselt → keine Aussage
    const ratio = ((audioTime - this.last.audioTime) * 1000) / dw;
    const underrunDelta = (underruns != null && this.last.underruns != null) ? Math.max(0, underruns - this.last.underruns) : 0;
    this.last = { audioTime, wallMs, underruns };
    const overload = ratio < this.threshold || underrunDelta > 0;
    if (overload && wallMs - this.lastFire >= this.cooldownMs) { this.lastFire = wallMs; this.onOverload({ ratio, underrunDelta }); }
    return { ratio, underrunDelta, overload };
  }
}

/** Browser: Wächter an einen AudioContext hängen. Liefert eine Stopp-Funktion. */
export function startMonitor(ctx, onOverload, { intervalMs = 1000 } = {}) {
  const mon = new OverloadMonitor({ onOverload });
  const timer = setInterval(() => {
    const ps = ctx.playbackStats;
    mon.sample({
      audioTime: ctx.currentTime, wallMs: performance.now(), suspended: ctx.state !== 'running',
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      underruns: ps && Number.isFinite(ps.underrunEvents) ? ps.underrunEvents : null
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
