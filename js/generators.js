/**
 * generators.js — Noise-Generator-Bausteine für die Ambient-Ebene (P2).
 *
 * Kapselt das Laden/Instanziieren des noise-generator-processor.js
 * AudioWorklets. Lautstärke wird bewusst NICHT hier gesteuert (siehe
 * Worklet-Kommentar) — der zurückgegebene Node liefert rohes Rauschen bei
 * Einheitslautstärke; ambient.js verbindet ihn wie jeden anderen
 * Track-Typ über einen externen GainNode (_ambientTargetGain()), damit
 * Master-Volume und Auto Duck einheitlich greifen.
 */

const NOISE_TYPE_MAP = { white: 0, pink: 1, brown: 2 };
const NOISE_WORKLET_URL = './js/worklets/noise-generator-processor.js';

// Pro AudioContext einzeln verfolgt (Worklet-Module sind context-gebunden,
// siehe audio/context.js ensurePitchWorkletFor() für dasselbe Muster).
const _readyContexts = new WeakSet();
const _loadingContexts = new WeakMap();

async function _ensureNoiseWorklet(ctx) {
  if (_readyContexts.has(ctx)) return true;
  if (_loadingContexts.has(ctx)) return _loadingContexts.get(ctx);
  const p = ctx.audioWorklet.addModule(NOISE_WORKLET_URL)
    .then(() => { _readyContexts.add(ctx); return true; })
    .catch(e => { console.warn('[generators] Noise-Worklet nicht verfügbar:', e.message); return false; })
    .finally(() => _loadingContexts.delete(ctx));
  _loadingContexts.set(ctx, p);
  return p;
}

/**
 * Baut einen Noise-Generator-AudioWorkletNode für den gegebenen Context.
 * @param {BaseAudioContext} ctx
 * @param {'white'|'pink'|'brown'} generatorType
 * @returns {Promise<AudioWorkletNode|null>} null, wenn das Worklet-Modul nicht geladen werden konnte
 */
export async function buildNoiseGenerator(ctx, generatorType = 'pink') {
  const ok = await _ensureNoiseWorklet(ctx);
  if (!ok) return null;
  const node = new AudioWorkletNode(ctx, 'noise-generator-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  const typeParam = node.parameters.get('type');
  typeParam.setValueAtTime(NOISE_TYPE_MAP[generatorType] ?? 1, ctx.currentTime);
  return node;
}

/** Wechselt den Rauschtyp eines bereits laufenden Generator-Nodes (kein Neustart nötig). */
export function setNoiseGeneratorType(node, generatorType) {
  if (!node?.parameters) return;
  const typeParam = node.parameters.get('type');
  if (typeParam) typeParam.setValueAtTime(NOISE_TYPE_MAP[generatorType] ?? 1, node.context.currentTime);
}

/**
 * P3: Tone Generator — erzeugt einen Testton oder Sweep als fertigen
 * AudioBuffer (Mono), der wie eine importierte Datei über
 * persistEdit()/saveSlotAudio() in einen Slot geschrieben werden kann
 * (kein eigener "Generator-Sound-Typ", siehe Plan-Begründung: volle
 * Kompatibilität mit Trim/Effekten/Export ohne Sonderfall).
 *
 * WICHTIG (Sweep): die Momentanfrequenz wird zwar pro Sample aus der
 * gewünschten Sweep-Kurve berechnet, aber die Phase wird per
 * Vorwärts-Akkumulation (`phase += 2π·freq/sr`) fortgeschrieben statt
 * naiv `sin(2π·freq·t)` einzusetzen — bei zeitvariabler Frequenz würde
 * Letzteres hörbare Sprünge/Klicks erzeugen, weil die tatsächliche
 * Phasensteigung (das Integral der Momentanfrequenz) von `freq·t`
 * abweicht, sobald sich `freq` über die Zeit ändert.
 *
 * @param {BaseAudioContext} ctx
 * @param {object} [opts]
 * @param {'sine'|'square'|'triangle'|'sawtooth'} [opts.waveform='sine']
 * @param {number} [opts.frequency=440] - Für Festton (kein Sweep)
 * @param {number} [opts.startFrequency] - Gesetzt zusammen mit endFrequency -> Sweep
 * @param {number} [opts.endFrequency]
 * @param {number} [opts.durationSec=2]
 * @param {number} [opts.amplitudeDb=-12]
 * @returns {AudioBuffer}
 */
export function generateToneBuffer(ctx, opts = {}) {
  const {
    waveform = 'sine', frequency = 440, startFrequency, endFrequency,
    durationSec = 2, amplitudeDb = -12
  } = opts;
  const sr = ctx.sampleRate;
  const length = Math.max(1, Math.round(durationSec * sr));
  const buffer = ctx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);
  const amp = Math.pow(10, Math.min(0, amplitudeDb) / 20);
  const isSweep = startFrequency != null && endFrequency != null && startFrequency > 0 && endFrequency > 0;

  let phase = 0;
  const TWO_PI = 2 * Math.PI;
  for (let i = 0; i < length; i++) {
    const freq = isSweep
      ? startFrequency * Math.pow(endFrequency / startFrequency, i / length) // logarithmischer Sweep
      : frequency;

    let sample;
    switch (waveform) {
      case 'square':   sample = Math.sin(phase) >= 0 ? 1 : -1; break;
      case 'triangle': sample = (2 / Math.PI) * Math.asin(Math.sin(phase)); break;
      case 'sawtooth': sample = 2 * ((phase / TWO_PI) % 1) - 1; break;
      case 'sine':
      default:         sample = Math.sin(phase);
    }
    data[i] = amp * sample;

    phase += TWO_PI * freq / sr;
    if (phase > TWO_PI) phase -= TWO_PI; // hält den Wertebereich klein (Float64-Präzision bei langen Buffern)
  }
  return buffer;
}
