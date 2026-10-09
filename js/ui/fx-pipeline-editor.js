/**
 * ui/fx-pipeline-editor.js — Pipeline-ÜBERSICHT (Ebene 1): Quelle → Medium → Umgebung → Hörer
 * ---------------------------------------------------------------------------------------------
 * Zeigt vier kompakte Stufen-Karten: Icon, Name, Ein/Aus-Schalter, Statuszeile („3 Layer · Monster, Manuell, Chor“)
 * und „Layer verwalten“. Keine Preset-Auswahl, keine Parameter, keine Aktionsleisten — das liegt in den Modals der
 * Ebenen 2 und 3 (dialogs/fx-pipeline-modals.js). Die Reihenfolge der Karten ist die Reihenfolge der Verarbeitung.
 *
 * Der Editor besitzt den DRAFT (ein v2-Effektobjekt des gerade bearbeiteten Sounds/Ambient-Tracks/Musikstücks).
 * Der Draft ändert sich nur über (a) den Stufen-Schalter hier, (b) commitStage() — „Übernehmen“ im Stufen-Modal —
 * und (c) setDraft() beim Öffnen. Der Dialog (dialogs/sound-modal.js) liest ihn über readEffectsFromUI().
 *
 * Nur DOM-APIs mit textContent (Preset-/Layer-Namen können benutzerdefiniert sein) — kein innerHTML mit Nutzerdaten
 * (Icons kommen aus dem eigenen Registry-Markup, iconSvg()).
 */

import { STAGE_ORDER, PIPELINE_STAGES, resolvePlan } from '../audio/fx-pipeline.js';
import { getPresetById } from '../presets.js';
import { iconSvg } from './icons.js';

const S = { fx: null, hooks: null, wired: false };

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ─── ZUSTAND ─────────────────────────────────────────────────

export function getDraft() { return S.fx; }

/** Setzt den Draft (Besitz geht an den Editor über). */
export function setDraft(fx) { S.fx = fx; }

/** Ersetzt den Draft durch eine Kopie. */
export function replaceDraft(fx) { S.fx = fx; }

export function setHooks(hooks) { S.hooks = hooks; }

/**
 * Übernimmt EINE Stufe (aus der Arbeitskopie des Stufen-Modals) in den Draft. Andere Stufen bleiben unberührt.
 * @param {string} stage
 * @param {{enabled:boolean, layers:object[]}} stageObj  wird kopiert
 */
export function commitStage(stage, stageObj) {
  if (!S.fx || !S.fx.stages[stage]) return;
  S.fx.stages[stage] = JSON.parse(JSON.stringify(stageObj));
  render(); S.hooks?.changed?.();
}

export function opToggleStage(stage, on) {
  if (!S.fx?.stages[stage]) return;
  S.fx.stages[stage].enabled = !!on;
  render(); S.hooks?.changed?.();
}

// ─── STATUSZEILE ─────────────────────────────────────────────

/** Anzeigename eines Layers (Preset-Name, „Manuell“ oder Hinweis auf ein gelöschtes Preset). */
export function layerLabel(layer) {
  if (layer.presetId) return getPresetById(layer.presetId)?.name || 'Gelöschtes Preset';
  return 'Manuell';
}

const STATUS_MAX_CHARS = 44;

/**
 * Kompakte Statuszeile einer Stufe: „Keine Layer“ · „1 Layer · Monster“ · „3 Layer · Monster, Manuell, Chor“.
 * Lange Listen werden gekürzt („Monster, Manuell +2“). Layer, die einzeln ausgeschaltet sind, werden gezählt
 * und am Ende vermerkt („· 1 aus“). Eine ausgeschaltete Stufe behält ihre Zusammenfassung (Konfiguration bleibt sichtbar).
 */
export function stageStatusText(stageObj) {
  const layers = stageObj?.layers || [];
  if (!layers.length) return 'Keine Layer';
  const head = `${layers.length} Layer`;
  const names = layers.map(layerLabel);
  let shown = names.slice();
  let text = shown.join(', ');
  while (text.length > STATUS_MAX_CHARS && shown.length > 1) {
    shown = shown.slice(0, -1);
    text = `${shown.join(', ')} +${names.length - shown.length}`;
  }
  if (text.length > STATUS_MAX_CHARS) text = text.slice(0, STATUS_MAX_CHARS - 1) + '…';
  const off = layers.filter(l => !l.enabled).length;
  return `${head} · ${text}${off ? ` · ${off} aus` : ''}`;
}

// ─── RENDER ──────────────────────────────────────────────────

function _stageCard(stage) {
  const meta = PIPELINE_STAGES[stage];
  const st = S.fx.stages[stage];
  const card = el('section', 'fx-stage' + (st.enabled ? '' : ' is-off'));
  card.dataset.stage = stage;
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', meta.label);

  const icon = el('span', 'fx-stage__icon'); icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = iconSvg(meta.icon);

  const main = el('div', 'fx-stage__main');
  main.appendChild(el('span', 'fx-stage__title', meta.label));
  const status = el('span', 'fx-stage__status', (st.enabled ? '' : 'Aus · ') + stageStatusText(st));
  status.title = meta.hint;
  main.appendChild(status);

  const sw = el('label', 'fx-toggle sm-inline-toggle fx-stage__switch'); sw.title = `${meta.label} ein/aus`;
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.setAttribute('role', 'switch'); cb.className = 'fx-stage__toggle';
  cb.checked = st.enabled; cb.setAttribute('aria-label', `${meta.label} ein/aus`);
  sw.append(cb, el('span', 'fx-toggle__track'));

  const manage = el('button', 'btn btn--sm fx-stage__manage', 'Layer verwalten');
  manage.type = 'button'; manage.dataset.act = 'manage';
  manage.setAttribute('aria-label', `${meta.label}: Layer verwalten`);

  card.append(icon, main, sw, manage);
  return card;
}

/** Lesbare Reihenfolge der tatsächlichen Verarbeitung (aus dem aufgelösten Plan, nicht aus der UI abgeleitet). */
function _renderSequence(host) {
  let text = '';
  try {
    const plan = resolvePlan({ ...S.fx, enabled: true });
    const parts = plan.steps.map(s => `${PIPELINE_STAGES[s.stage].label}: ${s.presetId ? (getPresetById(s.presetId)?.name || '?') : 'Manuell'}`);
    text = parts.length ? parts.join(' → ') : 'Keine aktiven Layer — Originalklang';
  } catch (e) { text = ''; }
  host.textContent = text;
  host.title = text;
}

export function render() {
  const mount = document.getElementById('fxPipelineStages');
  if (!mount || !S.fx) return;
  mount.replaceChildren(...STAGE_ORDER.map(_stageCard));
  const seq = document.getElementById('fxPipelineSequence'); if (seq) _renderSequence(seq);
}

// ─── EVENTS (einmalig, delegiert — überleben jedes Re-Render) ─

/** @param {{openStage:(stage:string)=>void, changed?:()=>void}} hooks */
export function initFxPipelineEditor(hooks) {
  S.hooks = hooks;
  const mount = document.getElementById('fxPipelineStages');
  if (!mount || S.wired) return;
  S.wired = true;
  mount.setAttribute('role', 'list');

  mount.addEventListener('click', e => {
    const btn = e.target.closest('[data-act="manage"]');
    if (btn) S.hooks?.openStage?.(btn.closest('.fx-stage').dataset.stage);
  });
  mount.addEventListener('change', e => {
    const t = e.target;
    if (t.classList.contains('fx-stage__toggle')) opToggleStage(t.closest('.fx-stage').dataset.stage, t.checked);
  });
}
