/* Стикер-фигурка: профиль человека (смотрит вправо), голова наклонена вперёд
   на `deg` градусов. Зелёный сектор — безопасная зона 0–15°: если нос внутри
   сектора, всё хорошо. Понятно без слов. */
export function figure(deg, color = "#12203f", limit = 15) {
  const a = Math.max(-10, Math.min(70, deg));
  const r = a * Math.PI / 180;
  const px = 46, py = 86;                          // основание шеи
  const dir = [Math.sin(r), -Math.cos(r)];         // направление «вверх по шее»
  const at = (t) => [px + dir[0] * t, py + dir[1] * t];
  const [nx, ny] = at(16);                         // верх шеи
  const [hx, hy] = at(38);                         // центр головы
  const sector = (deg2, len) => [px + len * Math.sin(deg2 * Math.PI / 180), py - len * Math.cos(deg2 * Math.PI / 180)];
  const [sx, sy] = sector(limit, 72);
  const f = (n) => n.toFixed(1);
  return `<svg viewBox="0 0 100 130" class="fig" aria-hidden="true">
    <path d="M${px} ${py} L${px} ${py - 72} A72 72 0 0 1 ${f(sx)} ${f(sy)} Z" fill="#1fb86a" opacity=".28"/>
    <line x1="${px}" y1="${py}" x2="${px}" y2="${py - 72}" stroke="#7c8bb3" stroke-width="1.5" stroke-dasharray="3 3"/>
    <path d="M6 130 C6 106 22 94 ${px} ${py - 2} C70 94 88 106 88 130 Z" fill="${color}" opacity=".3"/>
    <line x1="${px}" y1="${py}" x2="${f(nx)}" y2="${f(ny)}" stroke="${color}" stroke-width="16" stroke-linecap="round" opacity=".9"/>
    <g transform="rotate(${f(a)} ${f(hx)} ${f(hy)})">
      <ellipse cx="${f(hx)}" cy="${f(hy)}" rx="17" ry="20" fill="#fff" stroke="${color}" stroke-width="4"/>
      <path d="M${f(hx + 14)} ${f(hy - 2)} l11 6 l-11 4z" fill="${color}"/>
      <circle cx="${f(hx - 2)}" cy="${f(hy + 1)}" r="2.2" fill="${color}"/>
    </g>
  </svg>`;
}
