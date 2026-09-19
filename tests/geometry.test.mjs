// Проверка геометрии на синтетических данных с известным ответом. Запуск: node --test tests/geometry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { pitchFromMatrix, yawFromMatrix, mirroredTilt, distanceFromIpd, lineAngle, lineAngleSigma, solveTilt, loadKg } from "../geometry.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ожидалось ${b}±${tol}, получено ${a}`);
const rad = (d) => d * Math.PI / 180;

// column-major 4×4 из вращения Rx(a) и Ry(b): R = Ry(b)·Rx(a)
function matrix(pitchDeg, yawDeg) {
  const a = rad(pitchDeg), b = rad(yawDeg);
  const Rx = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const R = Ry.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * Rx[k][j], 0)));
  const d = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) d[c * 4 + r] = R[r][c];
  d[15] = 1;
  return d;
}

test("pitch/yaw из матрицы: восстановление заданных углов", () => {
  for (const p of [-30, -10, 0, 5, 15, 30, 45, 60]) {
    for (const y of [-25, 0, 20]) {
      near(pitchFromMatrix(matrix(p, y)), p, 1e-9, `pitch ${p}/${y}`);
      near(yawFromMatrix(matrix(p, y)), y, 1e-9, `yaw ${p}/${y}`);
    }
  }
});

test("pitch не меняется от масштаба матрицы", () => {
  const m = matrix(20, 0).map((v, i) => (i < 15 ? v * 3.7 : v));
  near(pitchFromMatrix(m), 20, 1e-9);
});

test("расстояние по зрачкам: обратная задача камеры-обскуры", () => {
  // камера 640 px, обзор 63°, зрачки 6.3 см; при 55 см зрачки в кадре: f·6.3/55
  const f = 320 / Math.tan(rad(31.5));
  for (const dist of [40, 55, 70, 90]) {
    const ipdPx = f * 6.3 / dist;
    near(distanceFromIpd(ipdPx, 640), dist, 1e-9);
  }
});

test("чувствительность расстояния к допущениям (бюджет ошибок)", () => {
  const f = 320 / Math.tan(rad(31.5));
  const ipdPx = f * 6.3 / 55; // «истинные» 55 см при обзоре 63° и зрачках 6.3 см
  const bad = (hfov, ipdCm) => distanceFromIpd(ipdPx, 640, hfov, ipdCm);
  // если принятый обзор уже реального (55° вместо 63°) — расстояние завышается, шире (75°) — занижается: ±18–20 %
  const narrow = bad(55, 6.3) / 55 - 1, wide = bad(75, 6.3) / 55 - 1;
  assert.ok(narrow > 0.15 && narrow < 0.22, `обзор 55°: ${narrow}`);
  assert.ok(wide < -0.15 && wide > -0.25, `обзор 75°: ${wide}`);
  // зрачки 5.8…6.8 см: ошибка ≈ ±8 %
  near(bad(63, 5.8) / 55 - 1, 5.8 / 6.3 - 1, 1e-9);
});

test("угол линии козелок–глаз к горизонту", () => {
  near(lineAngle({ x: 100, y: 200 }, { x: 200, y: 200 }), 0, 1e-12);
  near(lineAngle({ x: 100, y: 200 }, { x: 200, y: 200 + 100 * Math.tan(rad(12)) }), 12, 1e-9);
  // человек смотрит влево: глаз левее уха — угол тот же
  near(lineAngle({ x: 300, y: 200 }, { x: 200, y: 200 + 100 * Math.tan(rad(12)) }), 12, 1e-9);
  // глаз выше уха — отрицательный (голова откинута)
  near(lineAngle({ x: 100, y: 200 }, { x: 200, y: 200 - 100 * Math.tan(rad(7)) }), -7, 1e-9);
});

test("неопределённость эталона от ошибки клика", () => {
  // линия 100 px, ошибка клика 1.5 px → σ ≈ 1.2°; линия 400 px → ≈ 0.3°
  near(lineAngleSigma(100, 1.5), Math.atan(1.5 * Math.SQRT2 / 100) * 180 / Math.PI, 1e-12);
  assert.ok(lineAngleSigma(100, 1.5) > 1.1 && lineAngleSigma(100, 1.5) < 1.3);
  assert.ok(lineAngleSigma(400, 1.5) < 0.31);
});

test("наклон плеч в зеркальных координатах", () => {
  near(mirroredTilt({ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }), 0, 1e-12);
  assert.ok(mirroredTilt({ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.55 }) > 0, "правое (в превью) ниже → положительный");
  assert.ok(mirroredTilt({ x: 0.3, y: 0.55 }, { x: 0.7, y: 0.5 }) < 0);
});

const MAC = { eyeH: 45, dist: 55, panel: 20, bezel: 1.2, baseH: 1.5, maxPhi: 45 };

test("наклон экрана: экран перпендикулярен линии взгляда", () => {
  for (const H of [5, 10, 15, 20, 25]) {
    const s = solveTilt({ H, ...MAC });
    if (s.alpha < 0 || s.phi >= MAC.maxPhi) continue;
    // независимая проверка: нормаль экрана и направление на центр экрана
    const r = rad(s.phi), off = MAC.bezel + MAC.panel / 2;
    const cx = MAC.dist + off * Math.sin(r), cy = H + MAC.baseH + off * Math.cos(r);
    const sight = Math.atan2(MAC.eyeH - cy, cx);        // угол взгляда вниз
    near(sight, rad(s.alpha), 1e-9, `H=${H}`);
    near(s.phi, s.alpha, 1e-6, `φ = α при H=${H}`);
  }
});

test("наклон экрана: монотонность и ограничения монитора", () => {
  let prev = Infinity;
  for (let H = 0; H <= 40; H += 5) {
    const s = solveTilt({ H, ...MAC });
    assert.ok(s.alpha <= prev + 1e-9, "чем выше платформа, тем меньше угол взгляда вниз");
    prev = s.alpha;
  }
  // монитор: наклон назад не больше maxPhi
  const mon = solveTilt({ H: 0, eyeH: 45, dist: 65, panel: 34, bezel: 2, baseH: 6, maxPhi: 20 });
  assert.ok(mon.phi <= 20 + 1e-9);
});

test("нагрузка по модели Hansraj: узлы и интерполяция", () => {
  near(loadKg(0), 5, 1e-12); near(loadKg(15), 12, 1e-12); near(loadKg(30), 18, 1e-12);
  near(loadKg(45), 22, 1e-12); near(loadKg(60), 27, 1e-12);
  near(loadKg(7.5), 8.5, 1e-12);
  near(loadKg(-5), 5, 1e-12); near(loadKg(90), 27, 1e-12);
});
