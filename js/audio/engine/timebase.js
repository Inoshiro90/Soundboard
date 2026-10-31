/**
 * audio/engine/timebase.js — Zeitbasis für Bewegungen (Phase 13d)
 *
 * Bewegungen (13e Spatial `motion`, 13f `doppler`) laufen relativ zur WIRKSAMEN Clip-Dauer in Context-Zeit. Der Graph wird gebaut,
 * bevor diese Dauer feststeht (`dur` hängt vom Detune-Notbehelf ab, renderPipeline.js) und bevor die Quelle startet. Deshalb bekommt
 * die Runtime die Zeitbasis erst beim Start: `runtime.arm(timing)`.
 *
 * Zeitbasis (alle Zeiten in Context-Zeit, Sekunden):
 *   origin     Beginn des ersten Durchlaufs (Start der Quelle; Musik: Position 0 des Clips)
 *   passStart  Beginn des aktuellen Durchlaufs (bei Sound-Loops = origin + passIndex·dur)
 *   passIndex  Nummer des aktuellen Durchlaufs (0 = erster)
 *   dur        Dauer EINES Durchlaufs = Trimlänge / Abspielrate (seit 13d-0 auch im Loop); 0 = unbekannt
 *   loop       true: Durchläufe folgen periodisch im Abstand `dur` (Sound-Loop). Musik „Wiederholen: eins“ meldet jeden
 *              neuen Durchlauf selbst (loop false, passIndex + 1), weil das Media-Element nicht sample-genau periodisch ist.
 *
 * Entscheidung D (freigegeben): je Bewegung `repeat` 'once' (einmal je Start: Fenster ab `origin`) oder 'loop' (je Durchlauf: ein
 * Fenster ab jedem Durchlaufbeginn); Dauer in Sekunden oder mit `relative` als Anteil der Clip-Dauer (`duration · dur`).
 * Ein Fenster je Durchlauf endet spätestens mit dem Beginn des nächsten Durchlaufs (die Bewegung startet dort neu, `cut`).
 *
 * Dieses Modul ist rein rechnerisch (keine Knoten). Module setzen ihre Automation selbst (arm/hold, runtime.js).
 */

/** Vorlauf (s), mit dem eine Runtime Loop-Durchläufe im Voraus plant; nachgeplant wird nach der Hälfte (Wanduhr-Timer). */
export const LOOP_HORIZON_MIN_S = 1;

const _num = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** Normalisiert eine Zeitbasis (fehlende Felder → Standard, ungültige Dauer → 0). */
export function makeTiming({ origin = 0, passStart, passIndex = 0, dur = 0, loop = false } = {}) {
  const o = _num(origin, 0), d = Math.max(0, _num(dur, 0)), pi = Math.max(0, Math.floor(_num(passIndex, 0)));
  return { origin: o, passStart: _num(passStart, o + (loop ? pi * d : 0)), passIndex: pi, dur: d, loop: !!loop && d > 0 };
}

/** Bewegungsdauer (s) einer Spezifikation `{ duration, relative }` unter der Zeitbasis; 0 = keine Bewegung (z. B. relativ ohne bekannte Dauer). */
export function motionDuration(timing, spec) {
  const v = Math.max(0, _num(spec?.duration, 0));
  return spec?.relative ? v * timing.dur : v;
}

/** Durchlaufbeginn k (k ≥ passIndex) — periodisch nur bei `loop`. */
function _passAt(timing, k) { return timing.passStart + (k - timing.passIndex) * timing.dur; }

/**
 * Zeitfenster einer Bewegung, deren Beginn in [from, to) liegt (Planung in Abschnitten, ohne Doppelungen).
 * Mit `partial: true` kommt zusätzlich ein bereits laufendes Fenster (Beginn < from < Ende) dazu — beim (Neu-)Planen ab „jetzt“.
 * @returns {Array<{start:number, end:number, len:number, p0:number, p1:number, pass:number, cut:boolean}>}
 *   start/end = Context-Zeit des Abschnitts, len = volle Bewegungsdauer, p0/p1 = Fortschritt 0…1 an start/end
 *   (p0 > 0 bei angeschnittenem Fenster, p1 < 1 bei vom nächsten Durchlauf abgeschnittenem Fenster `cut`).
 */
export function motionWindows(timing, spec, from, to, { partial = false } = {}) {
  const tm = makeTiming(timing), len = motionDuration(tm, spec), out = [];
  if (!(len > 0) || !(to > from)) return out;
  const push = (s, pass, next) => {
    const full = s + len, end = next != null ? Math.min(full, next) : full;
    const cut = end < full;
    if (s >= from && s < to) out.push({ start: s, end, len, p0: 0, p1: (end - s) / len, pass, cut });
    else if (partial && s < from && end > from) out.push({ start: from, end, len, p0: (from - s) / len, p1: (end - s) / len, pass, cut });
  };
  if (spec?.repeat === 'loop') {
    if (tm.loop) {
      // erster in Frage kommender Durchlauf: der, in dem `from` liegt (für partial), sonst der erste mit Beginn ≥ from
      let k = Math.max(tm.passIndex, tm.passIndex + Math.floor((from - tm.passStart) / tm.dur));
      for (let s = _passAt(tm, k); s < to; k++, s = _passAt(tm, k)) push(s, k, _passAt(tm, k + 1));
    } else push(tm.passStart, tm.passIndex, null);   // einzelner Durchlauf (kein Loop, oder Musik: jeder Durchlauf wird neu gemeldet)
  } else push(tm.origin, 0, null);                   // 'once': genau ein Fenster ab dem ersten Start
  return out;
}

/** Fortschritt 0…1 einer Bewegung zur Zeit t (für Halten/Neuplanen); null = keine Bewegung aktiv oder noch nicht begonnen. */
export function motionProgressAt(timing, spec, t) {
  const w = motionWindows(timing, spec, t, t + 1e-9, { partial: true });
  if (w.length) return w[0].p0;
  return null;
}

/** Planungsfenster einer Runtime ab `now`: ohne Loop alles (∞), mit Loop mindestens zwei Durchläufe bzw. LOOP_HORIZON_MIN_S. */
export function planHorizon(timing, now) {
  const tm = makeTiming(timing);
  return tm.loop ? now + Math.max(LOOP_HORIZON_MIN_S, 2 * tm.dur) : Infinity;
}

/**
 * Musik (Media-Element): Zeitbasis aus der Wiedergabeposition. `position` = audio.currentTime, `clipStart` = Trim-Anfang des Tracks
 * (Position 0 des Clips), `duration` = audio.duration, `rate` = audio.playbackRate. `prev` = vorige Zeitbasis desselben Tracks
 * (für origin bei „Wiederholen: eins“), `newPass` = dieser Start ist ein neuer Durchlauf (Wiederholen: eins).
 * Unbekannte Dauer (Stream, Metadaten fehlen) → dur 0: relative Bewegungen ruhen, Bewegungen in Sekunden laufen.
 */
export function musicTiming({ ctxNow, position, clipStart = 0, duration, rate = 1, prev = null, newPass = false }) {
  const r = Math.max(0.01, Math.abs(_num(rate, 1)) || 1);
  const passStart = ctxNow - (_num(position, 0) - _num(clipStart, 0)) / r;
  const dur = Number.isFinite(duration) && duration > 0 ? Math.max(0, (duration - _num(clipStart, 0)) / r) : 0;
  const passIndex = prev ? prev.passIndex + (newPass ? 1 : 0) : 0;
  const origin = passIndex === 0 ? passStart : prev.origin;
  return makeTiming({ origin, passStart, passIndex, dur, loop: false });
}
