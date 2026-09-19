/* Фигурка: чёрный силуэт человека в профиль (смотрит вправо). Голова наклоняется
   вперёд на `deg` градусов, шея изгибается вместе с ней. Светлый сектор —
   безопасная зона 0–15°, тонкая дуга снаружи показывает текущее отклонение
   (цвет дуги — состояние). Без слов понятно, где голова. */
let uid = 0;

// Плечи и грудь в профиль (спина слева, грудь справа); шея входит сверху.
const TORSO = "M10 170 C10 142 24 126 46 118 C52 116 56 112 57 108 L69 108 C71 112 76 115 84 118 C100 124 110 137 114 152 L116 170 Z";

// Голова в локальных координатах: начало — верх шеи (затылочный сустав), вверх = минус по y.
export const HEAD_PATH = HEAD_POINTS();
function HEAD_POINTS() { return [
  "M-8 10 L-9 2",
  "C-15 -1 -23 -11 -23 -27",           // затылок
  "C-23 -45 -11 -56 4 -56",            // темя
  "C15 -56 21 -47 21 -37",             // лоб
  "C21 -34 22 -32 23 -29",             // надбровье
  "L29 -20",                           // спинка носа
  "C30 -18 29 -16 26 -16",             // кончик носа
  "L21 -15",
  "C22 -13 22 -11 20 -10",             // верхняя губа
  "C21 -8 20 -7 19 -6",
  "C20 -4 19 -2 16 -1",                // подбородок
  "C14 2 8 4 3 3",                     // нижняя челюсть
  "L8 12 L8 16 L-8 16 Z",              // горло; низ спрятан внутри шеи
].join(" "); }
const HEAD = HEAD_PATH;

const W = 150, H = 170;
const PX = 60, PY = 112;   // основание шеи
const NECK = 17;           // длина шеи
const R = 86;              // радиус сектора и дуги

export function figure(deg, color = "#0a0a0b", limit = 15) {
  const id = "f" + (++uid);
  const a = Math.max(-10, Math.min(70, deg));
  const rad = (d) => d * Math.PI / 180;
  const f = (n) => n.toFixed(1);
  // шея наклоняется на половину угла головы, голова — на весь угол
  const ax = PX + NECK * Math.sin(rad(a * 0.5)), ay = PY - NECK * Math.cos(rad(a * 0.5));
  const pt = (d) => [PX + R * Math.sin(rad(d)), PY - R * Math.cos(rad(d))];
  const [lx, ly] = pt(limit);
  const [ex, ey] = pt(a);
  const arc = a > 0.5
    ? `<path d="M${PX} ${PY - R} A${R} ${R} 0 0 1 ${f(ex)} ${f(ey)}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round"/>`
    : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="fig" aria-hidden="true">
    <defs>
      <linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="30" y1="20" x2="130" y2="170">
        <stop offset="0" stop-color="#3d3d42"/><stop offset=".5" stop-color="#151517"/><stop offset="1" stop-color="#050506"/>
      </linearGradient>
      <mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
        <g fill="#fff" stroke="none">
          <path d="${TORSO}"/>
          <line x1="${PX}" y1="${PY + 4}" x2="${f(ax)}" y2="${f(ay)}" stroke="#fff" stroke-width="21" stroke-linecap="round"/>
          <path d="${HEAD}" transform="translate(${f(ax)} ${f(ay)}) rotate(${f(a)}) scale(1.14)"/>
        </g>
      </mask>
    </defs>
    <path d="M${PX} ${PY} L${PX} ${PY - R} A${R} ${R} 0 0 1 ${f(lx)} ${f(ly)} Z" fill="rgba(10,10,11,.08)"/>
    <line x1="${PX}" y1="${PY}" x2="${PX}" y2="${PY - R - 5}" stroke="rgba(10,10,11,.28)" stroke-width="1.2" stroke-dasharray="3 3"/>
    ${arc}
    <rect width="${W}" height="${H}" fill="url(#${id}g)" mask="url(#${id}m)"/>
  </svg>`;
}
