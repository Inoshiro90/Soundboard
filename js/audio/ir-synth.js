/**
 * audio/ir-synth.js — Deterministische Impulsantwort-Synthese für das Modul `reverb` (Phase 19a, AE-08)
 *
 * REIN: keine Imports, kein AudioContext, kein Zufall ohne Seed. Registry (Tail, Kosten), ir-data.js (Cache, AudioBuffer),
 * effect-graph.js (Signatur des Hall-Kerns) und reverb-hub.js (Hub-Schlüssel) nutzen dieselben Funktionen.
 *
 * ALTDATEN (Invariante 3/4): Sind alle neuen Felder neutral (`reverbIsLegacy`), baut ir-data.js wie bisher `_buildIR`
 * (bit-gleich, Hub-Schlüssel und Signatur unverändert). Die neue Synthese greift erst, sobald ein neues Feld vom Standard abweicht.
 * Neutral: preDelay 5 ms (= bisheriger fester Vorlauf 0,005 s), damping 0, diffusion 1, earlyLevel 0, width 1, lowCut 20 Hz,
 * highCut 20 kHz, seed 0 (automatisch). `earlySize` wirkt nur mit earlyLevel > 0 und zählt deshalb nicht.
 *
 * NEUE SYNTHESE (Entscheidung R2, 2026-11-03): `duration` ist die Nachhallzeit RT60 (s), gemessen als Zeitpunkt, an dem die
 * Energieabfallkurve nach Schroeder (EDC) −60 dB erreicht. `decay` bleibt die Kurvenform des bisherigen Halls
 * (Hüllkurve (1 − t/L)^decay); die IR-Länge L wird so gewählt, dass die EDC bei t = duration genau −60 dB erreicht:
 *   EDC(t) ∝ (1 − t/L)^(2·decay + 1)  ⇒  L = duration / x60,  x60 = 1 − 10^(−6/(2·decay + 1)),  x60 ≥ 0,5 (Längendeckel 2 × duration).
 *   (x60 < 0,5 erst ab decay > 9,47; der UI-Regler endet bei 6.)
 * Bausteine (Reihenfolge):
 *   1. Rauschen je Kanal aus mulberry32(Seed): dicht (diffusion 1) oder Velvet-Rauschen mit Pulsdichte
 *      REVERB_VELVET_MIN·(sr/REVERB_VELVET_MIN)^diffusion je Sekunde (Nachbesserung 19a: Untergrenze 30/s, Abstand 33 ms → einzelne Echos;
 *      vorher 300/s, nicht körnig hörbar), energiegleich zum dichten Rauschen (Pulshöhe √(Abstand/3)).
 *   2. Dämpfung in 3 Bändern über eine Linkwitz-Riley-Weiche 4. Ordnung (250 Hz, 4 kHz; Summe betragsflach). Jedes Band
 *      bekommt die Hüllkurve mit eigener Länge: RT60 × [1, 1 − 0,4·damping, 1 − 0,85·damping]. Bei damping 0 entfällt die Weiche
 *      (ungeteiltes Rauschen mal Hüllkurve; die Weiche wäre dort nur ein Allpass). Mit Dämpfung gilt `duration` für das tiefe Band; die breitbandige Nachhallzeit wird kürzer.
 *   3. Frühe Reflexionen: Spiegelquellen 1. und 2. Ordnung in einem Quader (Länge earlySize, Breite 0,7·, Höhe 0,4·, mindestens
 *      2,5 m), Ohren ±0,09 m. Geometrie (`earlyRoom`, Nachbesserung 19a Teil 3): Der Klang passiert NAH beim Hörer (Soundboard:
 *      Schritt, Schwertschlag), die Wände sind so weit weg, wie die Raumgröße sagt. Hörer im Raum (Ohrhöhe 1,7 m), Quelle 1,8 m daneben
 *      (Höhe 1,4 m); in kleinen Räumen begrenzt. seed > 0 (Option B, Teil 4): anderer Raum gleicher Länge (Breite, Höhe) und anderer
 *      Platz (Hörer bis nahe an die Wand, Quelle in Richtung, Abstand und Höhe geseedet).
 *      Verzögerung = (Abstand − Direktabstand)/343 m/s nach dem Vorlauf, Pegel = earlyLevel · 0,9 · (Direktabstand/Abstand)
 *      · 0,85^(Wandtreffer) · 0,5^(Bodentreffer) — bezogen auf den DIREKTSCHALL (Pegel 1), s. Normierung.
 *      Jede Reflexion ist eine weiche Kopie: Streuung (kurzer, abklingender Rauschstoß, Länge 1,5 ms + 0,15 ms/m · earlySize,
 *      Energieanteil = diffusion; eigener geseedeter Strom) und Tiefpass aus zwei Einpolern, Grenzfrequenz
 *      9000 Hz / Ordnung^0,7 / (1 + Weg/15 m) (Wand- und Luftdämpfung) [H]. Teil 1/2 lieferten ideale Einzelsamples: harte Kopien
 *      des Klangs („Ghostnotes“), dazu fielen wegen spiegelbildlicher Aufstellung Reflexionen exakt zusammen.
 *      Die Reflexionen laufen in einem eigenen Signal neben dem Nachhall durch Breite und Cuts (beides linear).
 *   4. Breite (Mitte/Seite, Seite × width), Pegelausgleich √(2/(1 + width²)) nur für den Nachhall (wird ohnehin normiert).
 *   5. Low-/High-Cut als Butterworth 2. Ordnung (nur wenn nicht neutral), auf Nachhall und Reflexionen.
 *   6. NORMIERUNG (Nachbesserung 19a Teil 2): Der Nachhall wird hier mit der Formel der Web-Audio-Spezifikation normiert
 *      (ConvolverNode `normalize`: 0,00125 · 44100/sr / max(RMS, 0,000125), RMS über beide Kanäle und die ganze IR samt Vorlauf),
 *      die Reflexionen kommen danach unnormiert dazu. Der Aufrufer setzt deshalb `normalize = false` (reverbNormalize(p) === false).
 *      Grund: Mit Browser-Normierung lag der GESAMTE Hall immer ≈ −8 dB unter dem Direktschall, die erste Reflexion bei ≈ −35 dB
 *      (unhörbar), und ein höherer Reflexionspegel hätte den Nachhall leiser gemacht. Jetzt: Nachhall exakt wie mit Browser-Normierung
 *      (unabhängig von earlyLevel), Reflexionen im Verhältnis zum Direktschall wie in der Geometrie.
 *      Mit Reflexionen setzt der Nachhall weich ein (Teil 3): Anstieg sin² von 0 bis zur Mischzeit √(Raumvolumen) ms, Stärke
 *      min(1, 2·earlyLevel); die Normierung gilt für den Nachhall OHNE Anstieg (nach der Mischzeit unabhängig von earlyLevel).
 *   7. Vorlauf (preDelay) als Nullen vor allem.
 *   Degradation (AE-16): ein Laufzeitfeld `irMax` kürzt L (degrade.js setzt es für die neue Synthese; die gespeicherten Daten
 *   bleiben unberührt). Ende der IR: 5-ms-Ausblendung gegen einen Sprung beim Kürzen.
 */

const fin = (v, d) => (Number.isFinite(v) ? v : d);
const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));

export const REVERB_PREDELAY_LEGACY_MS = 5;
export const REVERB_LOWCUT_OFF = 20;
export const REVERB_HIGHCUT_OFF = 20000;
export const REVERB_DAMP_XOVER = [250, 4000];
/** Faktor der Nachhallzeit je Band (tief, mitte, hoch) bei damping 1; dazwischen linear. */
export const REVERB_DAMP_FACTORS = [0, 0.4, 0.85];
export const REVERB_SOUND_SPEED = 343;
export const REVERB_ER_REFLECTION = 0.85;
export const REVERB_EAR_OFFSET_M = 0.09;
/** Nachbesserung 19a Teil 3: Boden schluckt mehr; Geometrie (m); Streuung und Tiefpass je Reflexion. Startwerte [H], Hörliste. */
export const REVERB_FLOOR_REFLECTION = 0.5;
export const REVERB_EAR_HEIGHT_M = 1.7;
export const REVERB_SRC_HEIGHT_M = 1.4;
export const REVERB_SRC_DIST_M = 1.8;
export const REVERB_ER_SCATTER_MS = [1.5, 0.15];   // Grundlänge, je Meter Raumgröße
export const REVERB_ER_LP = { hz: 9000, orderExp: 0.7, distM: 15 };
/** Nachbesserung 19a Teil 4: Bereiche der Variante (seed > 0), s. earlyRoom. Startwerte [H], Hörliste. */
export const REVERB_VAR_WIDTH = [0.45, 0.95];        // Breite · Länge
export const REVERB_VAR_HEIGHT = [0.25, 0.6];        // Höhe · Länge
export const REVERB_VAR_MIN_DIM_M = 2.2;
export const REVERB_VAR_WALL_M = 0.5;                // Mindestabstand Hörer–Wand
export const REVERB_VAR_SRC_DIST_M = [1.2, 3];
export const REVERB_VAR_SRC_HEIGHT_M = [0.4, 2.4];
/** Normierung nach Web-Audio-Spezifikation (ConvolverNode, „normalize“): Kalibrierung, Bezugsrate, Mindestleistung. */
export const REVERB_NORM_GAIN = 0.00125;
export const REVERB_NORM_SR = 44100;
export const REVERB_NORM_MIN_POWER = 0.000125;
/** Nachbesserung 19a: Pulsdichte (je Sekunde) des Velvet-Rauschens bei diffusion 0. Startwert [H], Hörliste. */
export const REVERB_VELVET_MIN = 30;
const END_FADE_S = 0.005;

/** Geklemmte Werte, wie die Synthese sie verwendet. */
export function reverbValues(p) {
  return {
    duration: clamp(0.05, 10, fin(p?.duration, 2.2)),
    decay: clamp(0.1, 10, fin(p?.decay, 2.0)),
    pre: clamp(0, 500, fin(p?.preDelay, REVERB_PREDELAY_LEGACY_MS)) / 1000,
    damping: clamp(0, 1, fin(p?.damping, 0)),
    diffusion: clamp(0, 1, fin(p?.diffusion, 1)),
    earlyLevel: clamp(0, 1, fin(p?.earlyLevel, 0)),
    earlySize: clamp(2, 40, fin(p?.earlySize, 10)),
    width: clamp(0, 1, fin(p?.width, 1)),
    lowCut: clamp(REVERB_LOWCUT_OFF, 2000, fin(p?.lowCut, REVERB_LOWCUT_OFF)),
    highCut: clamp(1000, REVERB_HIGHCUT_OFF, fin(p?.highCut, REVERB_HIGHCUT_OFF)),
    seed: clamp(0, 2147483647, Math.floor(fin(p?.seed, 0))),
    irMax: Number.isFinite(p?.irMax) && p.irMax > 0 ? p.irMax : null
  };
}

/** true = alle neuen Felder neutral → bisherige IR (`_buildIR`), bit-gleich. */
export function reverbIsLegacy(p) {
  const v = reverbValues(p);
  return v.pre === REVERB_PREDELAY_LEGACY_MS / 1000 && v.damping === 0 && v.diffusion === 1 && v.earlyLevel === 0 && v.width === 1
    && v.lowCut === REVERB_LOWCUT_OFF && v.highCut === REVERB_HIGHCUT_OFF && v.seed === 0;
}

/** Anteil x60 der Hüllkurvenlänge, an dem die EDC −60 dB erreicht (≥ 0,5). */
export function reverbX60(decay) {
  return Math.max(0.5, 1 - Math.pow(10, -6 / (2 * decay + 1)));
}

/** Länge des Hüllkurvenkörpers L (s) ohne Vorlauf, nach Degradation (`irMax`). */
export function reverbBodySeconds(p) {
  const v = reverbValues(p);
  const L = v.duration / reverbX60(v.decay);
  return v.irMax !== null ? Math.min(L, Math.max(0.05, v.irMax - v.pre)) : L;   // irMax begrenzt die GESAMTE IR (Vorlauf + Körper)
}

/**
 * IR-Länge (s) für Tail und Kosten. Neue Synthese: Vorlauf + L (+ späteste frühe Reflexion, falls länger).
 * Altdaten: NICHT hier — Registry und cost.js behalten dort ihre bisherigen Ausdrücke (bit-gleiche Kosten/Tails).
 */
export function reverbIRSeconds(p) {
  const v = reverbValues(p);
  let s = v.pre + reverbBodySeconds(p);
  if (v.earlyLevel > 0) s = Math.max(s, v.pre + _erEndSeconds(earlyTaps(p), v));
  return s;
}

/** Stabiler Schlüssel der neuen Synthese (Cache, Hub, Signatur des Hall-Kerns). Altdaten verwenden ihren bisherigen Schlüssel. */
export function reverbIRKey(p) {
  const v = reverbValues(p);
  const es = v.earlyLevel > 0 ? v.earlySize : 0;
  return `g2:${v.duration}|${v.decay}|${v.pre}|${v.damping}|${v.diffusion}|${v.earlyLevel}|${es}|${v.width}|${v.lowCut}|${v.highCut}|${v.seed}|${v.irMax ?? ''}`;
}

/** Automatischer Seed wie beim bisherigen Hall (FNV-1a über Dauer|Abklingen|Vorlauf): Drehen an anderen Reglern mischt das Rauschen nicht neu. */
function _autoSeed(v) {
  const str = `${v.duration}|${v.decay}|${v.pre}`;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function _mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mischzeit (s) des Raums: √(Volumen in m³) ms (Faustformel) — Ende des weichen Einsatzes des Nachhalls. */
export function reverbMixSeconds(size) {
  const d = earlyRoom(size).dims;
  return Math.sqrt(d[0] * d[1] * d[2]) / 1000;
}

/** Konvention der Convolver für den Hall: Altdaten mit Browser-Normierung (bit-gleich), neue Synthese bereits normiert (s. Kopf, 6). */
export function reverbNormalize(p) {
  return reverbIsLegacy(p);
}

/**
 * Raumgeometrie der frühen Reflexionen (m): Quader, Quelle, Hörer (Nachbesserung 19a Teil 3).
 * Hörer im Raum auf Ohrhöhe (≤ 0,6 · Höhe), Quelle daneben (Abstand ≤ 0,3 · kleinere Grundseite, Höhe ≤ 0,5 · Höhe, ≥ 0,3 m von den Wänden).
 * seed 0: Hörer bei 0,58 · Länge / 0,43 · Breite, Quelle in Richtung 2,4 rad, 1,8 m. Keine spiegelbildliche Aufstellung → keine
 * zusammenfallenden Reflexionen. seed > 0: anderer Raum gleicher Länge UND anderer Platz (Nachbesserung 19a Teil 4, `_earlyRoomVariant`).
 */
export function earlyRoom(size, seed = 0) {
  if (seed > 0) return _earlyRoomVariant(size, seed);
  const Lx = Math.max(2.5, size), Ly = Math.max(2.5, size * 0.7), Lz = Math.max(2.5, size * 0.4);
  const fx = 0.58, fy = 0.43;
  const az = 2.4, dist = Math.min(REVERB_SRC_DIST_M, 0.3 * Math.min(Lx, Ly));
  const lis = [fx * Lx, fy * Ly, Math.min(REVERB_EAR_HEIGHT_M, 0.6 * Lz)];
  const src = [lis[0] + dist * Math.cos(az), lis[1] + dist * Math.sin(az), Math.min(REVERB_SRC_HEIGHT_M, 0.5 * Lz)];
  src[0] = Math.max(0.3, Math.min(Lx - 0.3, src[0])); src[1] = Math.max(0.3, Math.min(Ly - 0.3, src[1]));
  return { dims: [Lx, Ly, Lz], src, lis };
}

/**
 * Variante (seed > 0, Nachbesserung 19a Teil 4; Hörtest Nutzer: Prototyp C). Eigener Strom seed ^ 0x5EED5EED, unabhängig vom Rauschen.
 * Die Zufallswerte liegen bewusst eher an den Rändern ihres Bereichs (u → ½ ± ½·√|2u − 1|): systematisch andere Räume statt Mittelwerte.
 * Länge = earlySize; Breite/Höhe REVERB_VAR_WIDTH/REVERB_VAR_HEIGHT · Länge (≥ REVERB_VAR_MIN_DIM_M); Hörer ≥ REVERB_VAR_WALL_M von den
 * Wänden (Wandnähe möglich), Ohrhöhe wie seed 0; Quelle Richtung 0–2π, Abstand REVERB_VAR_SRC_DIST_M (≤ 0,35 · kleinere Grundseite),
 * Höhe REVERB_VAR_SRC_HEIGHT_M (≤ 0,8 · Höhe) → Bodenreflexion je nach Variante etwa 1,5–7 ms. An der Wand gekappte Quelle → Richtung gespiegelt.
 * Mischzeit (reverbMixSeconds) bleibt an der Grundgeometrie: der Nachhall ändert sich durch die Variante nicht.
 */
function _earlyRoomVariant(size, seed) {
  const r0 = _mulberry32((seed ^ 0x5EED5EED) >>> 0);
  const r = () => { const u = 2 * r0() - 1; return 0.5 + 0.5 * Math.sign(u) * Math.sqrt(Math.abs(u)); };
  const span = ([a, b]) => a + (b - a) * r();
  const Lx = Math.max(2.5, size), Ly = Math.max(REVERB_VAR_MIN_DIM_M, size * span(REVERB_VAR_WIDTH)), Lz = Math.max(REVERB_VAR_MIN_DIM_M, size * span(REVERB_VAR_HEIGHT));
  const m = REVERB_VAR_WALL_M, pos = (f, L) => Math.max(m, Math.min(L - m, f * L));
  const lis = [pos(0.08 + 0.84 * r(), Lx), pos(0.08 + 0.84 * r(), Ly), Math.min(REVERB_EAR_HEIGHT_M, 0.6 * Lz)];
  const az = 2 * Math.PI * r(), dist = Math.min(span(REVERB_VAR_SRC_DIST_M), 0.35 * Math.min(Lx, Ly));
  const hs = Math.min(span(REVERB_VAR_SRC_HEIGHT_M), 0.8 * Lz);
  const place = a => {
    const q = [lis[0] + dist * Math.cos(a), lis[1] + dist * Math.sin(a), hs];
    q[0] = Math.max(0.3, Math.min(Lx - 0.3, q[0])); q[1] = Math.max(0.3, Math.min(Ly - 0.3, q[1]));
    return q;
  };
  let src = place(az);
  if (Math.hypot(src[0] - lis[0], src[1] - lis[1]) < 0.8 * dist) src = place(az + Math.PI);   // sonst landet die Quelle am Ohr
  return { dims: [Lx, Ly, Lz], src, lis };
}

/**
 * Frühe Reflexionen: Spiegelquellen 1. und 2. Ordnung. Rückgabe sortiert nach Zeit:
 * [{ t: Verzögerung (s, ab Vorlauf), order, g: [links, rechts], dist: Weg (m, Mittel der Ohren) }] — Zeit je Kanal getrennt: tL, tR.
 * Bodentreffer (z-Achse): m 0/q 1 = Boden, m 1/q 1 = Decke, m ±1/q 0 = Boden + Decke.
 * Bildformel (Allen/Berkley): x = (1 − 2q)·xs + 2m·L, Ordnung |2m − q| je Achse; m ∈ {−1, 0, 1}, q ∈ {0, 1}.
 */
export function earlyTaps(p) {
  const v = reverbValues(p);
  if (!(v.earlyLevel > 0)) return [];
  const { dims, src, lis } = earlyRoom(v.earlySize, v.seed);
  const axis = a => {
    const out = [];
    for (const m of [-1, 0, 1]) for (const q of [0, 1]) {
      const floor = a !== 2 ? 0 : (m === 0 && q === 1) || (q === 0 && m !== 0) ? 1 : 0;
      out.push({ x: (1 - 2 * q) * src[a] + 2 * m * dims[a], o: Math.abs(2 * m - q), floor });
    }
    return out;
  };
  const ax = [axis(0), axis(1), axis(2)];
  const ear = side => [lis[0], lis[1] + side * REVERB_EAR_OFFSET_M, lis[2]];
  const dist = (pt, e) => Math.hypot(pt[0] - e[0], pt[1] - e[1], pt[2] - e[2]);
  const ears = [ear(-1), ear(1)];
  const d0 = ears.map(e => dist(src, e));
  const taps = [];
  for (const a of ax[0]) for (const b of ax[1]) for (const c of ax[2]) {
    const order = a.o + b.o + c.o;
    if (order < 1 || order > 2) continue;
    const pt = [a.x, b.x, c.x];
    const d = ears.map(e => dist(pt, e));
    const tt = d.map((x, i) => (x - d0[i]) / REVERB_SOUND_SPEED);
    const fl = c.floor;
    const g = d.map((x, i) => v.earlyLevel * 0.9 * (d0[i] / x) * Math.pow(REVERB_ER_REFLECTION, order - fl) * Math.pow(REVERB_FLOOR_REFLECTION, fl));
    taps.push({ t: Math.min(tt[0], tt[1]), tL: tt[0], tR: tt[1], order, g, dist: (d[0] + d[1]) / 2 });
  }
  return taps.sort((x, y) => x.t - y.t);
}

/** Grenzfrequenz (Hz) des Tiefpasses einer Reflexion: Wandtreffer und Weglänge. */
export function earlyTapCutoff(tp) {
  return REVERB_ER_LP.hz / Math.pow(tp.order, REVERB_ER_LP.orderExp) / (1 + tp.dist / REVERB_ER_LP.distM);
}
/** Länge (s) der Streuung je Reflexion. */
const _scatterSeconds = v => (REVERB_ER_SCATTER_MS[0] + REVERB_ER_SCATTER_MS[1] * v.earlySize) / 1000;
/** Ende (s ab Vorlauf) der letzten Reflexion samt Streuung und Ausklang des Tiefpasses (6 Zeitkonstanten). */
function _erEndSeconds(taps, v) {
  let e = 0;
  for (const tp of taps) e = Math.max(e, Math.max(tp.tL, tp.tR) + _scatterSeconds(v) + 6 / (2 * Math.PI * earlyTapCutoff(tp)) + 0.001);
  return e;
}

/** Butterworth-Biquad 2. Ordnung (RBJ), Koeffizienten [b0, b1, b2, a1, a2] normiert. */
function _biquad(type, f, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), a = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + a;
  const b0 = type === 'lp' ? (1 - cs) / 2 : (1 + cs) / 2, b1 = type === 'lp' ? 1 - cs : -(1 + cs);
  return [b0 / a0, b1 / a0, b0 / a0, -2 * cs / a0, (1 - a) / a0];
}
function _filter(x, c) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * Synthetisiert die IR. Rückgabe: [Float32Array links, Float32Array rechts], Länge round((pre + max(L, ER)) · sr).
 * Nur für die neue Synthese gedacht; für Altdaten liefert ir-data.js `_buildIR` (der Aufrufer entscheidet über reverbIsLegacy).
 */
export function synthReverbIR(p, sr) {
  const v = reverbValues(p);
  const pre = Math.round(v.pre * sr);
  const bodySec = reverbBodySeconds(p);
  const taps = earlyTaps(p);
  const body = Math.max(1, Math.round(bodySec * sr));
  const erEnd = taps.length ? Math.round(_erEndSeconds(taps, v) * sr) : 0;
  const n = Math.max(body, erEnd);
  const rnd = _mulberry32(v.seed > 0 ? v.seed : _autoSeed(v));
  const fac = REVERB_DAMP_FACTORS.map(k => Math.max(0.05, 1 - k * v.damping));
  const [f1, f2] = REVERB_DAMP_XOVER;
  const lr4 = (x, type, f) => { const c = _biquad(type, f, sr); return _filter(_filter(x, c), c); };   // Linkwitz-Riley 4. Ordnung
  const density = v.diffusion >= 1 ? Infinity : REVERB_VELVET_MIN * Math.pow(sr / REVERB_VELVET_MIN, v.diffusion);   // Pulse je Sekunde
  const fadeN = Math.max(1, Math.round(END_FADE_S * sr));
  const ch = [];
  for (let c = 0; c < 2; c++) {
    // 1 · Rauschen (dicht oder Velvet)
    const x = new Float64Array(body);
    if (density === Infinity) { for (let i = 0; i < body; i++) x[i] = rnd() * 2 - 1; }
    else {
      const Td = sr / density, A = Math.sqrt(Td / 3);
      for (let s = 0; s * Td < body; s++) {
        const pos = Math.floor(s * Td + rnd() * Td), sign = rnd() < 0.5 ? -1 : 1;
        if (pos < body) x[pos] = sign * A;
      }
    }
    // 2 · Bänder und Hüllkurven
    const y = new Float64Array(n);
    const env = (i, k) => { const Lb = body * fac[k], r = 1 - i / Lb; return r > 0 ? Math.pow(r, v.decay) : 0; };
    if (v.damping === 0) { for (let i = 0; i < body; i++) y[i] = x[i] * env(i, 0); }
    else {
      const lo = lr4(x, 'lp', f1), up = lr4(x, 'hp', f1), mid = lr4(up, 'lp', f2), hi = lr4(up, 'hp', f2);
      for (let i = 0; i < body; i++) y[i] = lo[i] * env(i, 0) + mid[i] * env(i, 1) + hi[i] * env(i, 2);
    }
    // Ausblendung am Ende des Körpers (gekürzte IR durch irMax endet sonst mit einem Sprung)
    for (let i = Math.max(0, body - fadeN); i < body; i++) y[i] *= (body - i) / fadeN;
    ch.push(y);
  }
  // 3 · Frühe Reflexionen (eigenes Signal, bezogen auf den Direktschall)
  let er = null;
  if (taps.length) {
    er = [new Float64Array(n), new Float64Array(n)];
    const sc = v.diffusion;                                             // Energieanteil der Streuung
    const Ls = Math.max(1, Math.round(_scatterSeconds(v) * sr));
    const rr = _mulberry32(((v.seed > 0 ? v.seed : _autoSeed(v)) ^ 0x51CA77E5) >>> 0);   // eigener Strom der Streuung
    const pole = fc => Math.exp(-2 * Math.PI * Math.min(fc, sr * 0.45) / sr);
    for (const tp of taps) {
      const fc = earlyTapCutoff(tp), p1 = pole(fc), L = Ls + Math.ceil(6 * sr / (2 * Math.PI * fc)) + 4;
      for (let c = 0; c < 2; c++) {
        const k = Math.round((c === 0 ? tp.tL : tp.tR) * sr); if (k >= n) continue;
        const w = new Float64Array(L);
        w[0] = Math.sqrt(1 - sc);
        if (sc > 0) {   // Streuanteil: kurzes, exponentiell abklingendes Rauschen, Energie sc
          const tau = Ls / 3; let e = 0; const z = new Float64Array(Ls);
          for (let i = 0; i < Ls; i++) { z[i] = (rr() * 2 - 1) * Math.exp(-i / tau); e += z[i] * z[i]; }
          for (let i = 0; i < Ls; i++) w[i] += z[i] * Math.sqrt(sc / e);
        }
        let y1 = 0, y2 = 0;   // zwei Einpoler in Reihe (Wand- und Luftdämpfung)
        for (let i = 0; i < L && k + i < n; i++) { y1 = (1 - p1) * w[i] + p1 * y1; y2 = (1 - p1) * y1 + p1 * y2; er[c][k + i] += y2 * tp.g[c]; }
      }
    }
  }
  // 4 · Breite (Pegelausgleich nur für den Nachhall; er wird in 6 ohnehin normiert)
  const ms = (pair, comp) => {
    for (let i = 0; i < n; i++) {
      const m = (pair[0][i] + pair[1][i]) / 2, s = (pair[0][i] - pair[1][i]) / 2 * v.width;
      pair[0][i] = (m + s) * comp; pair[1][i] = (m - s) * comp;
    }
  };
  if (v.width < 1) { ms(ch, Math.sqrt(2 / (1 + v.width * v.width))); if (er) ms(er, 1); }
  // 5 · Low-/High-Cut
  const cuts = x => {
    if (v.lowCut > REVERB_LOWCUT_OFF) x = _filter(x, _biquad('hp', v.lowCut, sr));
    if (v.highCut < REVERB_HIGHCUT_OFF) x = _filter(x, _biquad('lp', v.highCut, sr));
    return x;
  };
  for (let c = 0; c < 2; c++) { ch[c] = cuts(ch[c]); if (er) er[c] = cuts(er[c]); }
  // 6 · Normierung des Nachhalls wie der Browser (Länge = Vorlauf + Körper, d. h. wie ohne Reflexionen), dann Reflexionen dazu
  let pw = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < body; i++) pw += ch[c][i] * ch[c][i];
  pw = Math.sqrt(pw / (2 * (pre + body)));
  const k = REVERB_NORM_GAIN * (REVERB_NORM_SR / sr) / Math.max(pw, REVERB_NORM_MIN_POWER);
  // Weicher Einsatz des Nachhalls bis zur Mischzeit (nur mit Reflexionen; nach der Normierung, s. Kopf 6)
  let ramp = null;
  if (taps.length) {
    const tMix = reverbMixSeconds(v.earlySize), tF = taps[0].t;
    const w = Math.min(1, 2 * v.earlyLevel), i1 = Math.max(1, Math.round(Math.max(tMix, tF) * sr));
    ramp = i => { const r = i >= i1 ? 1 : Math.sin(0.5 * Math.PI * i / i1) ** 2; return 1 - w * (1 - r); };
  }
  // 7 · Vorlauf
  return ch.map((y, c) => {
    const out = new Float32Array(pre + n);
    for (let i = 0; i < n; i++) out[pre + i] = y[i] * k * (ramp ? ramp(i) : 1) + (er ? er[c][i] : 0);
    return out;
  });
}
