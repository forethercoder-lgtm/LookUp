/* Схематичная модель позвоночника по измеренным наклону головы и плечам.
   ВАЖНО: это иллюстрация (кинематическая цепочка из 12 грудных и 7 шейных позвонков), а не снимок и не
   диагностика. Типичные значения (грудной кифоз 40°, шейный лордоз 20°, доля затылочного сустава 30 %,
   добавочный кифоз при сутулости до 14°) выбраны для наглядности, а не измерены. */
import { HEAD_PATH } from "./figure.js";
import { loadKg } from "./geometry.js";

export const SPINE = {
  T: 12, C: 7,           // число грудных и шейных позвонков
  hT: 19, hC: 15,        // длина звена, px (позвонок + диск)
  wT: 26, wC: 22,        // ширина тела позвонка, px
  kyph: 40, lord: 20,    // нейтральные кифоз и лордоз, ° (иллюстративно)
  slouchKyph: 14,        // добавочный кифоз при индексе сутулости 1, °
  shareCerv: 0.7,        // доля остаточного наклона, приходящаяся на C2–C7; остальное — затылочный сустав
  base: { x: 150, y: 470 },
  W: 380, H: 500,
  view: [45, 30, 270, 470],   // видимая область viewBox: x, y, ширина, высота
};

/* Цепочка позвонков снизу вверх (T12 … T1, C7 … C1).
   input: { headFlex: наклон головы, ° (+ вперёд); slouch: индекс сутулости 0…1.5 } */
export function buildSpine({ headFlex = 0, slouch = 0 } = {}) {
  const { T, C, kyph, lord } = SPINE;
  const dK = SPINE.slouchKyph * slouch;
  const kp0 = kyph / T, kp = (kyph + dK) / T, rc0 = -lord / C;
  const start = -((T - 1) * kp0 + C * rc0);          // нейтраль: C1 вертикален, голова прямо
  const angT1 = start + (T - 1) * kp;
  const dT1 = angT1 - (start + (T - 1) * kp0);       // на сколько наклонилась верхняя часть грудного отдела
  const resid = headFlex - dT1;                       // остаток наклона головы должен обеспечить шейный отдел
  const cervFlex = SPINE.shareCerv * resid, occ = resid - cervFlex;
  const rc = rc0 + cervFlex / C;

  const verts = [];
  let x = SPINE.base.x, y = SPINE.base.y;
  const push = (name, region, ang, h, w) => {
    const dx = Math.sin(ang * Math.PI / 180), dy = -Math.cos(ang * Math.PI / 180);
    verts.push({ name, region, ang, w, h, x: x + dx * h / 2, y: y + dy * h / 2 });
    x += dx * h; y += dy * h;
  };
  for (let i = 0; i < T; i++) push("T" + (T - i), "T", start + i * kp, SPINE.hT, SPINE.wT);
  for (let j = 1; j <= C; j++) push("C" + (C + 1 - j), "C", angT1 + j * rc, SPINE.hC, SPINE.wC);

  const t3 = verts[T - 3];
  return {
    verts,
    neck: { x, y },                                   // верх C1 — точка, вокруг которой поворачивается голова
    headAng: headFlex,
    shoulder: { x: t3.x + 38 + 18 * slouch, y: t3.y + 8 },
    metrics: { headFlex, cervFlex, occ, dK, dT1, slouch, loadKg: loadKg(Math.max(0, headFlex)) },
  };
}

/* ---------- цвета ---------- */
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (a) => "#" + a.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (c1, c2, t) => { const a = hex(c1), b = hex(c2); return toHex(a.map((v, i) => v + (b[i] - v) * t)); };
const BASE = "#2a2a2e", WARN = "#b4791f", BAD = "#b5423b";
// отклонение ориентации позвонка от нейтрали, °: до 2 — тёмный, дальше плавно к янтарному и красному
export function devColor(dev) {
  const t = Math.max(0, Math.min(1, (dev - 2) / 18));
  return t < 0.5 ? mix(BASE, WARN, t / 0.5) : mix(WARN, BAD, (t - 0.5) / 0.5);
}

/* Отклонения по позвонкам относительно эталонной цепочки (нейтраль или запомненная поза) */
export function deviations(cur, ref) { return cur.verts.map((v, i) => Math.abs(v.ang - ref.verts[i].ang)); }

let uid = 0;
const f1 = (n) => n.toFixed(1);

/* Вид сбоку. ghost — цепочка, которую показываем серой тенью (нейтраль или запомненная поза) */
export function renderSide(cur, ghost, opts = {}) {
  const id = "sp" + (++uid);
  const ref = ghost || buildSpine({});
  const dev = deviations(cur, ref);
  const rect = (v, attrs) => `<rect x="${f1(-v.w / 2)}" y="${f1(-v.h * 0.39)}" width="${v.w}" height="${f1(v.h * 0.78)}" rx="5" transform="translate(${f1(v.x)} ${f1(v.y)}) rotate(${f1(v.ang)})" ${attrs}/>`;
  const ghostSvg = ref.verts.map((v) => rect(v, 'fill="none" stroke="rgba(10,10,11,.28)" stroke-width="1.2" stroke-dasharray="3 3"')).join("");
  const curSvg = cur.verts.map((v, i) => rect(v, `fill="${devColor(dev[i])}" stroke="rgba(255,255,255,.5)" stroke-width="1"`)).join("");
  const headT = (h) => `translate(${f1(h.neck.x)} ${f1(h.neck.y)}) rotate(${f1(h.headAng)}) scale(1.14)`;
  const c1 = cur.verts[cur.verts.length - 1], c7 = cur.verts[SPINE.T], t1 = cur.verts[SPINE.T - 1], t12 = cur.verts[0];
  const label = (v, txt) => `<text x="${f1(v.x + 30)}" y="${f1(v.y + 4)}" font-size="11" fill="#6b6b73">${txt}</text>`;
  const headCol = devColor(Math.abs(cur.headAng - ref.headAng));
  return `<svg viewBox="${SPINE.view.join(" ")}" class="spineSvg" role="img" aria-label="Модель позвоночника, вид сбоку">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d3d42"/><stop offset=".6" stop-color="#151517"/><stop offset="1" stop-color="#050506"/></linearGradient></defs>
    <line x1="${SPINE.base.x}" y1="${SPINE.base.y + 12}" x2="${SPINE.base.x}" y2="40" stroke="rgba(10,10,11,.22)" stroke-width="1.2" stroke-dasharray="4 4"/>
    <g>${ghostSvg}</g>
    <path d="${HEAD_PATH}" transform="${headT(ref)}" fill="none" stroke="rgba(10,10,11,.28)" stroke-width="1.4" stroke-dasharray="3 3"/>
    <line x1="${f1(ref.shoulder.x)}" y1="${f1(ref.shoulder.y)}" x2="${f1(cur.verts[SPINE.T - 3].x)}" y2="${f1(cur.verts[SPINE.T - 3].y)}" stroke="rgba(10,10,11,.2)" stroke-width="1.2" stroke-dasharray="3 3"/>
    <circle cx="${f1(ref.shoulder.x)}" cy="${f1(ref.shoulder.y)}" r="9" fill="none" stroke="rgba(10,10,11,.28)" stroke-width="1.2" stroke-dasharray="3 3"/>
    <g>${curSvg}</g>
    <line x1="${f1(cur.verts[SPINE.T - 3].x)}" y1="${f1(cur.verts[SPINE.T - 3].y)}" x2="${f1(cur.shoulder.x)}" y2="${f1(cur.shoulder.y)}" stroke="#2a2a2e" stroke-width="5" stroke-linecap="round"/>
    <circle cx="${f1(cur.shoulder.x)}" cy="${f1(cur.shoulder.y)}" r="11" fill="url(#${id})"/>
    <path d="${HEAD_PATH}" transform="${headT(cur)}" fill="url(#${id})"/>
    ${label(c1, "C1")}${label(c7, "C7")}${label(t1, "T1")}${label(t12, "T12")}
    <text x="${f1(cur.neck.x - 96)}" y="${f1(cur.neck.y - 62)}" font-size="20" font-weight="650" fill="${headCol === BASE ? "#0a0a0b" : headCol}">${Math.round(cur.headAng)}°</text>
  </svg>`;
}

/* Вид спереди «как в зеркале»: наклон плеч и наклон головы вбок.
   shoulderTilt, headTilt — ° в зеркальных координатах (+ : правая в превью сторона ниже / голова к правой стороне превью) */
export function renderFront({ shoulderTilt = 0, headTilt = 0 } = {}) {
  const id = "fr" + (++uid);
  const cx = 130, sy = 205, half = 92;
  const rad = (d) => d * Math.PI / 180;
  const pts = (t) => ({
    L: { x: cx - half * Math.cos(rad(t)), y: sy - half * Math.sin(rad(t)) },
    R: { x: cx + half * Math.cos(rad(t)), y: sy + half * Math.sin(rad(t)) },
  });
  const cur = pts(shoulderTilt), gh = pts(0);
  const my = (cur.L.y + cur.R.y) / 2;
  // плечи со скруглёнными краями (дельты) и линией трапеции к шее
  const torso = (p, my2) => `M${f1(p.L.x - 4)} 300 L${f1(p.L.x - 4)} ${f1(p.L.y + 46)} Q${f1(p.L.x - 8)} ${f1(p.L.y + 2)} ${f1(p.L.x + 18)} ${f1(p.L.y - 3)} Q${f1(cx - 54)} ${f1(my2 - 16)} ${cx - 16} ${f1(my2 - 27)} L${cx + 16} ${f1(my2 - 27)} Q${f1(cx + 54)} ${f1(my2 - 16)} ${f1(p.R.x - 18)} ${f1(p.R.y - 3)} Q${f1(p.R.x + 8)} ${f1(p.R.y + 2)} ${f1(p.R.x + 4)} ${f1(p.R.y + 46)} L${f1(p.R.x + 4)} 300 Z`;
  const neckTop = { x: cx, y: my - 62 };
  const hc = { x: neckTop.x + 40 * Math.sin(rad(headTilt)), y: neckTop.y - 40 * Math.cos(rad(headTilt)) };
  const ghostHead = { x: cx, y: (sy - 62) - 40 };
  return `<svg viewBox="0 0 260 300" class="spineSvg" role="img" aria-label="Плечи и голова спереди, как в зеркале">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d3d42"/><stop offset=".6" stop-color="#151517"/><stop offset="1" stop-color="#050506"/></linearGradient></defs>
    <line x1="${cx}" y1="20" x2="${cx}" y2="300" stroke="rgba(10,10,11,.22)" stroke-width="1.2" stroke-dasharray="4 4"/>
    <path d="${torso(gh, sy)}" fill="none" stroke="rgba(10,10,11,.28)" stroke-width="1.2" stroke-dasharray="3 3"/>
    <ellipse cx="${cx}" cy="${ghostHead.y}" rx="27" ry="34" fill="none" stroke="rgba(10,10,11,.28)" stroke-width="1.2" stroke-dasharray="3 3"/>
    <path d="${torso(cur, my)}" fill="url(#${id})"/>
    <line x1="${cx}" y1="${f1(my - 28)}" x2="${f1(neckTop.x)}" y2="${f1(neckTop.y)}" stroke="#151517" stroke-width="22" stroke-linecap="round"/>
    <ellipse cx="${f1(hc.x)}" cy="${f1(hc.y)}" rx="27" ry="34" transform="rotate(${f1(headTilt)} ${f1(hc.x)} ${f1(hc.y)})" fill="url(#${id})"/>
    <line x1="${f1(cur.L.x)}" y1="${f1(cur.L.y)}" x2="${f1(cur.R.x)}" y2="${f1(cur.R.y)}" stroke="#fff" stroke-opacity=".55" stroke-width="1.6"/>
  </svg>`;
}

/* Подписи для плеч и наклона головы (в зеркальной системе = стороны самого человека) */
export function sideWords(shoulderTilt, headTilt) {
  const sh = Math.abs(shoulderTilt) < 1.5 ? "плечи ровно" : shoulderTilt > 0 ? `правое плечо ниже на ${Math.abs(shoulderTilt).toFixed(0)}°` : `левое плечо ниже на ${Math.abs(shoulderTilt).toFixed(0)}°`;
  const hd = Math.abs(headTilt) < 2 ? "голова прямо" : headTilt > 0 ? `голова к правому плечу на ${Math.abs(headTilt).toFixed(0)}°` : `голова к левому плечу на ${Math.abs(headTilt).toFixed(0)}°`;
  return { sh, hd };
}
