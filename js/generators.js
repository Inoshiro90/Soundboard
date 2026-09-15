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
// siehe audio.js ensurePitchWorkletFor() für dasselbe Muster).
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
