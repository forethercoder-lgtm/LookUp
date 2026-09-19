/* Геометрия и модели без DOM (проверяются тестами в tests/). */

/* ---------- поза головы из матрицы MediaPipe ----------
   data — column-major 4×4; столбец 2 = направление «вперёд» лица (x, y вверх, z к камере).
   Положительный pitch = голова наклонена вниз; знак дополнительно уточняется кивком при калибровке. */
export function pitchFromMatrix(d) {
  const n = Math.hypot(d[8], d[9], d[10]) || 1;
  return -Math.asin(Math.max(-1, Math.min(1, d[9] / n))) * 180 / Math.PI;
}
export const yawFromMatrix = (d) => Math.atan2(d[8], d[10]) * 180 / Math.PI;

/* Наклон линии между точками в «зеркальных» координатах (как в превью камеры), °.
   Положительный, если правая (в превью) точка ниже левой. */
export function mirroredTilt(pLeftPreview, pRightPreview) {
  return Math.atan2(pRightPreview.y - pLeftPreview.y, pRightPreview.x - pLeftPreview.x) * 180 / Math.PI;
}

/* ---------- расстояние до экрана по зрачкам (модель камеры-обскуры) ---------- */
export function distanceFromIpd(ipdPx, imageWidthPx, hfovDeg = 63, ipdCm = 6.3) {
  const f = (imageWidthPx / 2) / Math.tan(hfovDeg * Math.PI / 360); // фокус в пикселях
  return f * ipdCm / ipdPx;
}

/* ---------- угол линии «козелок → уголок глаза» к горизонту (эталон по фото), ° ----------
   + : глаз ниже уха (голова наклонена вниз); не зависит от того, куда смотрит человек. */
export function lineAngle(ear, eye) {
  return Math.atan2(eye.y - ear.y, Math.abs(eye.x - ear.x)) * 180 / Math.PI;
}
// Неопределённость угла из-за ошибки клика на фото: σ_угла ≈ σ_px·√2 / L (рад), L — длина линии в пикселях
export function lineAngleSigma(baselinePx, clickSigmaPx = 1.5) {
  return Math.atan((clickSigmaPx * Math.SQRT2) / baselinePx) * 180 / Math.PI;
}

/* ---------- оптимальный наклон экрана по высоте платформы ----------
   Экран ставится перпендикулярно линии взгляда на его центр: φ (наклон назад от вертикали)
   = угол взгляда вниз. Центр экрана зависит от φ — считаем итерациями. */
export function solveTilt({ H, eyeH, dist, panel, bezel, baseH, maxPhi }) {
  const off = bezel + panel / 2;
  let phi = 0, alpha = 0;
  for (let i = 0; i < 40; i++) {
    const r = phi * Math.PI / 180;
    const cy = H + baseH + off * Math.cos(r);
    const dc = dist + off * Math.sin(r);
    alpha = Math.atan2(eyeH - cy, dc) * 180 / Math.PI; // >0: смотрим вниз
    phi = Math.max(0, Math.min(maxPhi, alpha));
  }
  const r = phi * Math.PI / 180;
  return { phi, alpha, top: H + baseH + (bezel + panel) * Math.cos(r) };
}

/* ---------- нагрузка на шею по расчётной модели Hansraj (2014), кг ----------
   Это модель, а не измерение; точки: 0°→5, 15°→12, 30°→18, 45°→22, 60°→27 (в статье в фунтах). */
export const HANSRAJ = [[0, 5], [15, 12], [30, 18], [45, 22], [60, 27]];
export function loadKg(angle) {
  const a = Math.max(0, Math.min(60, angle));
  for (let i = 1; i < HANSRAJ.length; i++) {
    if (a <= HANSRAJ[i][0]) {
      const [a0, k0] = HANSRAJ[i - 1], [a1, k1] = HANSRAJ[i];
      return k0 + (k1 - k0) * (a - a0) / (a1 - a0);
    }
  }
  return HANSRAJ[HANSRAJ.length - 1][1];
}
