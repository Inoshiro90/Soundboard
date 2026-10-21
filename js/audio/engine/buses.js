/**
 * audio/engine/buses.js — Master-Bus und Preview-Bus (Phase 6, AE-07)
 *
 * Nur für LIVE-Contexts (siehe `installBuses` in context.js). Offline-Contexts (Export, Tests, Kalibrierung) bekommen
 * keinen Bus: `outputFor()` liefert dort weiter `ctx.destination` (Live = Preview = Export bleibt Pipeline-Code, der Bus
 * liegt dahinter; Entscheidung a).
 *
 *   Master-Bus:   soundIn (Master-Lautstärke) ┐
 *                 ambientIn (Gain 1)          ├→ Summe → Abgriff (vor dem Begrenzer, L/R) ┐
 *                 musicIn (Gain 1)            ┘                    └→ Safety-Limiter ─────┴→ destination
 *   Preview-Bus:  previewIn → eigener Abgriff + eigener Limiter → destination (PARALLEL zum Master-Bus, nie hindurch:
 *                 ein lautes Preview darf den Live-Begrenzer und das Live-Meter nicht beeinflussen — Invariante 5).
 *
 * Safety-Limiter (P6): latenzfreier Clamp per WaveShaper auf das Ceiling (−0,3 dBFS), Oversampling 'none'. Unterhalb
 * des Ceilings exakt transparent (gemessen in Node: Differenz ≤ −118 dB relativ, nur Float-Rundung), darüber harte
 * Begrenzung = was das Gerät ohnehin täte, nur 0,3 dB früher. Ein Kompressor-Limiter wurde verworfen: der native
 * DynamicsCompressorNode ist nur bei Threshold 0 dB transparent (sonst Auto-Makeup), hält das Ceiling nicht ein
 * (+6 dBFS Eingang → 1,068) und addiert ≈ 8 ms Latenz auf jede Stimme [S, Node]. Der Lookahead-Limiter folgt in P11.
 *
 * Meter-Abgriff VOR dem Begrenzer: Er zeigt den tatsächlichen Pegel auf dem Bus; „Clip“ = Pegel ≥ Ceiling (Entscheidung d),
 * auch bei ausgeschaltetem Begrenzer.
 */

/** Ceiling des Safety-Limiters in dBFS und linear. */
export const CEILING_DB = -0.3;
export const CEILING = Math.pow(10, CEILING_DB / 20);

/** Stützstellen der Clamp-Kurve (ungerade: 0 liegt exakt auf einer Stützstelle → kein Gleichanteil). */
const CURVE_POINTS = 2049;

/** Clamp-Kurve über [−1, 1]; Eingänge darüber hinaus werden vom WaveShaper auf die Endpunkte (= ±ceiling) gesetzt. */
export function makeClampCurve(ceiling = CEILING, points = CURVE_POINTS) {
  const n = points % 2 === 1 ? points : points + 1;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = -1 + 2 * i / (n - 1);
    c[i] = Math.max(-ceiling, Math.min(ceiling, x));
  }
  return c;
}

const _bypassTc = 0.005;   // Umschaltglättung Limiter an/aus (≈ 15 ms bis ~95 %)

/**
 * Baut EINEN Bus mit benannten Eingängen.
 * @param {BaseAudioContext} ctx
 * @param {{inputs:string[], master?:string, limiter?:boolean}} o
 *   `master`: Name des Eingangs, dessen Gain die Master-Lautstärke trägt (Standard: keiner).
 */
export function createBus(ctx, { inputs, master = null, limiter = true } = {}) {
  const inGains = {};
  const sum = ctx.createGain();      // Summe aller Eingänge (2 Kanäle explizit)
  sum.channelCount = 2; sum.channelCountMode = 'explicit'; sum.channelInterpretation = 'speakers';
  for (const name of inputs) {
    const g = ctx.createGain(); g.gain.value = 1;
    g.connect(sum);
    inGains[name] = g;
  }

  // Abgriff VOR dem Begrenzer (L/R getrennt). fftSize 2048 ≈ 43 ms: größer als das 30-fps-Rasterintervall → keine Peak-Lücken.
  const splitter = ctx.createChannelSplitter(2);
  const anL = ctx.createAnalyser(), anR = ctx.createAnalyser();
  anL.fftSize = anR.fftSize = 2048; anL.smoothingTimeConstant = anR.smoothingTimeConstant = 0;
  sum.connect(splitter); splitter.connect(anL, 0); splitter.connect(anR, 1);

  // Begrenzer-Pfad und Bypass-Pfad, per Gain überblendet.
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeClampCurve(); shaper.oversample = 'none';
  const limGain = ctx.createGain(), byGain = ctx.createGain();
  limGain.gain.value = limiter ? 1 : 0; byGain.gain.value = limiter ? 0 : 1;
  const out = ctx.createGain(); out.gain.value = 1;
  sum.connect(shaper); shaper.connect(limGain); limGain.connect(out);
  sum.connect(byGain); byGain.connect(out);
  out.connect(ctx.destination);

  let limiterOn = !!limiter, disposed = false;
  const bus = {
    ctx, inputs: inGains, sum, analyserL: anL, analyserR: anR, out,
    get limiterEnabled() { return limiterOn; },
    /** Eingangsknoten `name` (GainNode). */
    input(name) { return inGains[name] || null; },
    /** Safety-Limiter ein-/ausschalten (klickfrei überblendet). */
    setLimiter(on) {
      if (disposed) return;
      limiterOn = !!on;
      const t = ctx.currentTime;
      limGain.gain.cancelScheduledValues(t); byGain.gain.cancelScheduledValues(t);
      limGain.gain.setTargetAtTime(limiterOn ? 1 : 0, t, _bypassTc);
      byGain.gain.setTargetAtTime(limiterOn ? 0 : 1, t, _bypassTc);
    },
    /** Master-Lautstärke (0..1) live, geglättet. Nur für Busse mit `master`. */
    setMasterVolume(v, tc = 0.015) {
      const g = master && inGains[master]; if (!g || disposed) return;
      const val = Math.max(0, Number.isFinite(v) ? v : 1);
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(val, t, tc);
    },
    /** Liest die aktuellen Spitzen (linear, 0..) beider Kanäle aus den Abgriffen. */
    readPeaks(bufL, bufR) {
      bufL = bufL || new Float32Array(anL.fftSize); bufR = bufR || new Float32Array(anR.fftSize);
      anL.getFloatTimeDomainData(bufL); anR.getFloatTimeDomainData(bufR);
      let pl = 0, pr = 0;
      for (let i = 0; i < bufL.length; i++) { const a = Math.abs(bufL[i]); if (a > pl) pl = a; const b = Math.abs(bufR[i]); if (b > pr) pr = b; }
      return { peakL: pl, peakR: pr };
    },
    dispose() {
      if (disposed) return; disposed = true;
      for (const n of [...Object.values(inGains), sum, splitter, anL, anR, shaper, limGain, byGain, out]) { try { n.disconnect(); } catch (e) { /* schon getrennt */ } }
    }
  };
  return bus;
}

// ─── Busse je Context ────────────────────────────────────────

const _buses = new WeakMap();   // ctx → { master, preview }

/** Installiert (idempotent) Master- und Preview-Bus für einen LIVE-Context und gibt sie zurück. */
export function installBuses(ctx, { limiter = true, masterVol = 1 } = {}) {
  let b = _buses.get(ctx);
  if (b) return b;
  const master = createBus(ctx, { inputs: ['sound', 'ambient', 'music'], master: 'sound', limiter });
  const preview = createBus(ctx, { inputs: ['preview'], limiter });
  master.setMasterVolume(masterVol, 0);
  b = { master, preview };
  _buses.set(ctx, b);
  return b;
}

/** Busse des Contexts oder null (Offline-Contexts und Contexts ohne Installation). */
export function busesOf(ctx) { return _buses.get(ctx) || null; }

/** Entfernt die Busse eines Contexts (Tests). */
export function removeBuses(ctx) {
  const b = _buses.get(ctx); if (!b) return;
  b.master.dispose(); b.preview.dispose(); _buses.delete(ctx);
}

/** Welcher Bus-Eingang gehört zu `kind`? ('hub' hängt am Ziel seines Aufrufers; Standard = Sound-Eingang) */
export function inputFor(ctx, kind) {
  const b = _buses.get(ctx); if (!b) return null;
  switch (kind) {
    case 'preview': return b.preview.input('preview');
    case 'ambient': return b.master.input('ambient');
    case 'music':   return b.master.input('music');
    case 'export':  return null;                       // Export läuft nie über den Live-Bus
    default:        return b.master.input('sound');    // 'sound', 'hub'
  }
}

/** Master-Lautstärke live setzen (0..1); tut nichts, wenn noch kein Live-Bus existiert. */
export function setMasterVolume(ctx, v) { _buses.get(ctx)?.master.setMasterVolume(v); }

/** Safety-Limiter beider Busse schalten. */
export function setSafetyLimiter(ctx, on) { const b = _buses.get(ctx); if (!b) return; b.master.setLimiter(on); b.preview.setLimiter(on); }
