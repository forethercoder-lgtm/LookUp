// Проверка статистики по известным эталонным значениям. Запуск: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { zInv, tInv, fInv, chi2Inv, tolFactor, icc, blandAltman, repeatability, mean, sd, linfit } from "../stats.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ожидалось ${b}±${tol}, получено ${a}`);

test("квантиль нормального распределения", () => {
  near(zInv(0.975), 1.959964, 1e-5);
  near(zInv(0.5), 0, 1e-9);
  near(zInv(0.995), 2.575829, 1e-5);
  near(zInv(0.001), -3.090232, 1e-5);
});

test("квантили t (таблицы)", () => {
  near(tInv(0.975, 1), 12.706, 0.01);
  near(tInv(0.975, 5), 2.571, 0.001);
  near(tInv(0.975, 10), 2.228, 0.001);
  near(tInv(0.975, 30), 2.042, 0.001);
  near(tInv(0.025, 10), -2.228, 0.001);
});

test("квантили F (таблицы, 0,975)", () => {
  near(fInv(0.975, 5, 15), 3.58, 0.01);
  near(fInv(0.975, 10, 10), 3.717, 0.01);
  near(fInv(0.975, 3, 20), 3.859, 0.01);
  near(fInv(0.975, 2, 10), 5.456, 0.01);
});

test("квантили хи-квадрат (таблицы)", () => {
  near(chi2Inv(0.05, 9), 3.325, 0.005);
  near(chi2Inv(0.05, 29), 17.708, 0.01);
  near(chi2Inv(0.95, 10), 18.307, 0.01);
});

test("допусковый множитель 95%/95% (двусторонний нормальный; таблицы)", () => {
  // значения из стандартных таблиц; формула Howe даёт погрешность порядка десятых долей процента
  const table = { 10: 3.379, 20: 2.752, 30: 2.549, 50: 2.379, 100: 2.233 };
  for (const [n, k] of Object.entries(table)) near(tolFactor(Number(n)), k, k * 0.012, `n=${n}`);
});

test("ICC: пример Shrout & Fleiss (1979): 6 объектов × 4 эксперта", () => {
  const m = [[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]];
  const r = icc(m);
  near(r.icc11, 0.17, 0.005, "ICC(1,1)");
  near(r.icc21, 0.29, 0.005, "ICC(2,1)");
  near(r.icc31, 0.71, 0.005, "ICC(3,1)");
  // 95% ДИ (R: psych::ICC, тот же набор данных)
  near(r.ci21[0], 0.019, 0.02, "ДИ ICC(2,1) нижняя");
  near(r.ci21[1], 0.76, 0.02, "ДИ ICC(2,1) верхняя");
  near(r.ci31[0], 0.342, 0.02, "ДИ ICC(3,1) нижняя");
  near(r.ci31[1], 0.946, 0.02, "ДИ ICC(3,1) верхняя");
});

test("Bland–Altman: простые данные с известным ответом", () => {
  // разности: +1, +2, +3, +2, +2 → bias 2, SD 0.7071
  const pairs = [[11, 10], [22, 20], [33, 30], [42, 40], [52, 50]].map(([a, r]) => ({ a, r }));
  const b = blandAltman(pairs);
  near(b.bias, 2, 1e-12);
  near(b.sd, Math.sqrt(0.5), 1e-12);
  near(b.loa[0], 2 - 1.96 * Math.sqrt(0.5), 1e-12);
  near(b.mae, 2, 1e-12);
  near(b.rmse, Math.sqrt(4.4), 1e-12);
  assert.ok(b.tol[1] - b.tol[0] > b.loa[1] - b.loa[0], "допусковый интервал шире обычных границ согласия (малая выборка)");
});

test("Bland–Altman: точная поправка при чистой линейной ошибке", () => {
  // приложение = 1.1·эталон + 2 → регрессия эталона на приложение возвращает поправку
  const refs = [0, 10, 20, 30, 40, 50];
  const pairs = refs.map((r) => ({ a: 1.1 * r + 2, r }));
  const f = blandAltman(pairs).fit;
  near(f.slope, 1 / 1.1, 1e-9);
  near(f.intercept, -2 / 1.1, 1e-9);
  near(f.r, 1, 1e-12);
});

test("повторяемость: Sw, SEM, MDC95", () => {
  // группы с известной дисперсией: [1,3] → s²=2 (df 1); [10,14] → s²=8 (df 1) → pooled = sqrt((2+8)/2)=sqrt(5)
  const r = repeatability([[1, 3], [10, 14], [7]]);
  assert.equal(r.groups, 2);
  near(r.sw, Math.sqrt(5), 1e-12);
  near(r.mdc95, 1.96 * Math.SQRT2 * Math.sqrt(5), 1e-12);
  near(r.rc, 2.77 * Math.sqrt(5), 1e-12);
});

test("вспомогательные: mean, sd, linfit", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  near(sd([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 1e-5);
  const f = linfit([1, 2, 3], [2, 4, 6]);
  near(f.slope, 2, 1e-12); near(f.intercept, 0, 1e-12); near(f.r, 1, 1e-12);
});
