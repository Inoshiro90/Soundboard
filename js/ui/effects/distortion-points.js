/**
 * ui/effects/distortion-points.js — Kurvenpunkte des Waveshapers (Verzerrung, Modus „Waveshaper“, Phase 15b).
 * ---------------------------------------------------------------------------------------------------------------------
 * Eine Zahlentabelle wie die Tap-Tabelle (delay-taps.js): je Punkt Eingang und Ausgang in Prozent (−100 … +100), Entfernen; darunter
 * „+ Punkt“ (höchstens WS_POINTS_MAX). Darüber eine kleine Vorschau der Kennlinie (SVG, nur Ansicht, für Screenreader beschrieben).
 * Die Engine legt eine monoton-kubische Kurve durch die Punkte (engine/distortion-curves.js); Drive und Bias wirken davor, die Vorschau
 * zeigt die Kennlinie selbst (Eingang −1 … +1 → Ausgang).
 *
 * Zustand liegt im Aufrufer (`getPoints`/`setPoints`); jede Änderung läuft über `patchPoint` (schema.js normalizeShaperPoint, klemmt,
 * behält unbekannte Felder). Die reinen Modellfunktionen brauchen kein DOM und sind in Node getestet.
 */
import { WS_POINTS_MAX, WS_POINT_RANGES } from '../../audio/engine/registry.js';
import { normalizeShaperPoint } from '../../audio/engine/schema.js';
import { waveshaperFunction, waveshaperKnots } from '../../audio/engine/distortion-curves.js';
import { el, emitUserEvent } from './controls.js';

export const POINT_COLUMNS = [
  { key: 'x', head: 'Eingang (%)', spoken: 'Eingang in Prozent, minus 100 bis plus 100', factor: 100, step: 1 },
  { key: 'y', head: 'Ausgang (%)', spoken: 'Ausgang in Prozent, minus 100 bis plus 100', factor: 100, step: 1 }
];
export const POINTS_MIN = 2;
const toView = (v, f) => Math.round(v * f * 1000) / 1000;
const r2 = v => Math.round(v * 100) / 100;

/** Neuer Punkt: in der Mitte der größten Lücke (nach x), Ausgang = aktuelle Kurve dort. Eingefügt hinter dem letzten Punkt mit kleinerem x. */
export function newPoint(points) {
  const k = waveshaperKnots(points);
  let best = 0;
  for (let i = 1; i < k.length - 1; i++) if (k[i + 1][0] - k[i][0] > k[best + 1][0] - k[best][0]) best = i;
  const x = r2((k[best][0] + k[best + 1][0]) / 2), y = r2(waveshaperFunction(points)(x));
  return normalizeShaperPoint({ x, y });
}
export const canAddPoint = points => points.length < WS_POINTS_MAX;
export const canRemovePoint = points => points.length > POINTS_MIN;
export function addPoint(points) {
  if (!canAddPoint(points)) return points;
  const p = newPoint(points);
  let at = points.length;
  for (let i = points.length - 1; i >= 0; i--) { if (Number.isFinite(points[i]?.x) && points[i].x < p.x) { at = i + 1; break; } if (i === 0) at = 0; }
  return [...points.slice(0, at), p, ...points.slice(at)];
}
export const removePoint = (points, i) => (canRemovePoint(points) ? points.filter((_, k) => k !== i) : points);
export const patchPoint = (points, i, patch) => (i >= 0 && i < points.length ? points.map((q, k) => (k === i ? normalizeShaperPoint({ ...q, ...patch }) : q)) : points);
export const pointName = (q, i) => `Punkt ${i + 1}: Eingang ${Math.round(q.x * 100)} %, Ausgang ${Math.round(q.y * 100)} %`;

/** SVG-Pfad der Kennlinie im Quadrat size × size (Eingang links → rechts, Ausgang unten → oben). */
export function curvePath(points, size = 120, steps = 96) {
  const f = waveshaperFunction(points), h = size / 2, out = [];
  for (let i = 0; i <= steps; i++) {
    const u = -1 + 2 * i / steps;
    out.push(`${i ? 'L' : 'M'}${r2(h + u * h)} ${r2(h - Math.max(-1, Math.min(1, f(u))) * h)}`);
  }
  return out.join(' ');
}
/** Kurzbeschreibung der Kurve für Screenreader (Ausgang bei −100, −50, 0, +50, +100 % Eingang). */
export function curveSpoken(points) {
  const f = waveshaperFunction(points);
  return 'Kennlinie: ' + [-1, -0.5, 0, 0.5, 1].map(u => `bei ${Math.round(u * 100)} % Eingang ${Math.round(f(u) * 100)} % Ausgang`).join(', ');
}

const SVG = 'http://www.w3.org/2000/svg';
/**
 * @param {{idBase:string, moduleLabel:string, getPoints:()=>Array, setPoints:(p:Array)=>void}} o
 * @returns {{root:HTMLElement, sync:()=>void}}
 */
export function createDistortionPointsControl({ idBase, moduleLabel, getPoints, setPoints }) {
  const root = el('div', 'fx-taps fx-points');
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('class', 'fx-points__preview'); svg.setAttribute('role', 'img');
  svg.setAttribute('id', `${idBase}-preview`);
  const grid = document.createElementNS(SVG, 'path'); grid.setAttribute('class', 'fx-points__grid'); grid.setAttribute('d', 'M0 60 H120 M60 0 V120 M0 120 L120 0');
  const line = document.createElementNS(SVG, 'path'); line.setAttribute('class', 'fx-points__curve');
  const dots = document.createElementNS(SVG, 'g'); dots.setAttribute('class', 'fx-points__dots');
  svg.append(grid, line, dots);

  const wrap = el('div', 'fx-taps__wrap');
  const table = el('table', 'fx-taps__table');
  const cap = el('caption', 'fx-sr-only'); cap.textContent = `${moduleLabel}: Kurvenpunkte`;
  const thead = el('thead'), hr = el('tr');
  for (const [txt, cls] of [['Nr.', ''], ...POINT_COLUMNS.map(c => [c.head, '']), ['Entfernen', 'fx-taps__c-del']]) {
    const th = el('th', cls || null, { scope: 'col' }); th.textContent = txt; hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = el('tbody');
  table.append(cap, thead, tbody); wrap.appendChild(table);
  const foot = el('div', 'fx-taps__foot');
  const addBtn = el('button', 'btn btn--sm btn--ghost fx-taps__add', { type: 'button', 'aria-label': `${moduleLabel}: Kurvenpunkt hinzufügen` }); addBtn.textContent = '+ Punkt';
  foot.appendChild(addBtn);
  const live = el('p', 'fx-sr-only', { role: 'status', 'aria-live': 'polite' });
  root.append(svg, wrap, foot, live);

  let rows = [];
  const paintPreview = () => {
    const pts = getPoints();
    line.setAttribute('d', curvePath(pts));
    dots.textContent = '';
    for (const [x, y] of waveshaperKnots(pts)) {
      const c = document.createElementNS(SVG, 'circle');
      c.setAttribute('cx', String(r2(60 + x * 60))); c.setAttribute('cy', String(r2(60 - y * 60))); c.setAttribute('r', '2.5');
      dots.appendChild(c);
    }
    svg.setAttribute('aria-label', `${moduleLabel}: ${curveSpoken(pts)}`);
  };
  const paintRow = (r, q, i) => {
    r.nr.textContent = String(i + 1);
    for (const c of POINT_COLUMNS) { r[c.key].value = String(toView(q[c.key], c.factor)); r[c.key].setAttribute('aria-label', `Punkt ${i + 1} ${c.spoken}`); }
    r.del.setAttribute('aria-label', `${pointName(q, i)} entfernen`);
    r.del.disabled = !canRemovePoint(getPoints());
  };
  const patch = (i, p) => { const next = patchPoint(getPoints(), i, p); setPoints(next); paintPreview(); return next[i]; };

  const buildRows = () => {
    tbody.textContent = ''; rows = [];
    getPoints().forEach((q, i) => {
      const tr = el('tr', 'fx-taps__row'), nr = el('span');
      const r = { tr, nr };
      const cells = [['', nr]];
      for (const c of POINT_COLUMNS) {
        const [lo, hi] = WS_POINT_RANGES[c.key];
        r[c.key] = el('input', 'fx-taps__num', { type: 'number', id: `${idBase}-${c.key}-${i}`, min: toView(lo, c.factor), max: toView(hi, c.factor), step: c.step, value: toView(q[c.key], c.factor), inputmode: 'decimal' });
        cells.push(['', r[c.key]]);
      }
      r.del = el('button', 'btn btn--sm btn--ghost fx-taps__del', { type: 'button', id: `${idBase}-del-${i}` }); r.del.textContent = '✕';
      cells.push(['fx-taps__c-del', r.del]);
      for (const [cls, node] of cells) { const td = el('td', cls || null); td.appendChild(node); tr.appendChild(td); }
      tbody.appendChild(tr); rows.push(r);
      for (const c of POINT_COLUMNS) {
        const input = r[c.key];
        input.addEventListener('input', e => { if (e.fxUser) return; const v = parseFloat(input.value); if (Number.isFinite(v)) patch(i, { [c.key]: v / c.factor }); });
        input.addEventListener('change', () => { const v = parseFloat(input.value); const nq = patch(i, { [c.key]: Number.isFinite(v) ? v / c.factor : getPoints()[i][c.key] }); paintRow(r, nq, i); });
      }
      r.del.addEventListener('click', () => {
        if (!canRemovePoint(getPoints())) return;
        const name = pointName(getPoints()[i], i);
        setPoints(removePoint(getPoints(), i)); sync(); live.textContent = `${name} entfernt`;
        emitUserEvent(root, 'input');
        (tbody.querySelector('input[type=number]') || addBtn).focus?.();
      });
      paintRow(r, q, i);
    });
  };
  addBtn.addEventListener('click', () => {
    if (!canAddPoint(getPoints())) return;
    const old = getPoints(), next = addPoint(old);
    setPoints(next); sync();
    const at = next.findIndex(q => !old.includes(q));
    live.textContent = `Punkt hinzugefügt (${getPoints().length} Punkte)`;
    emitUserEvent(root, 'input');
    rows[Math.max(0, at)]?.y.focus();
  });

  const sync = () => { buildRows(); paintPreview(); addBtn.disabled = !canAddPoint(getPoints()); };
  return { root, sync };
}
