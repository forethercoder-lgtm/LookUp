// Проверка модели позвоночника: геометрия, инварианты, монотонность. Запуск: node --test tests/spine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildSpine, deviations, devColor, renderSide, renderFront, sideWords, SPINE } from "../spine.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ожидалось ${b}±${tol}, получено ${a}`);

test("нейтраль: 19 позвонков, голова прямо, C1 вертикален", () => {
  const s = buildSpine({});
  assert.equal(s.verts.length, SPINE.T + SPINE.C);
  assert.equal(s.verts[0].name, "T12");
  assert.equal(s.verts.at(-1).name, "C1");
  near(s.verts.at(-1).ang, 0, 1e-9, "C1");
  near(s.headAng, 0, 1e-12);
  near(s.metrics.cervFlex, 0, 1e-12);
  near(s.metrics.dT1, 0, 1e-12);
});

test("суммарный кифоз и лордоз нейтрали соответствуют заданным", () => {
  const s = buildSpine({});
  const T = SPINE.T;
  near(s.verts[T - 1].ang - s.verts[0].ang, (T - 1) * SPINE.kyph / T, 1e-9, "кифоз T12→T1");
  near(s.verts.at(-1).ang - s.verts[T - 1].ang, -SPINE.lord, 1e-9, "лордоз T1→C1");
});

test("наклон головы: голова = измеренный угол, остаток делится между C2–C7 и затылочным суставом", () => {
  for (const a of [5, 15, 30, 45, 60]) {
    const s = buildSpine({ headFlex: a });
    near(s.headAng, a, 1e-12);
    near(s.metrics.cervFlex + s.metrics.occ, a, 1e-9, "сумма долей");
    near(s.metrics.cervFlex, SPINE.shareCerv * a, 1e-9);
    // ориентация C1 + вклад затылочного сустава = угол головы
    near(s.verts.at(-1).ang + s.metrics.occ, a, 1e-9, `C1+occ при ${a}`);
  }
});

test("сутулость: грудной кифоз растёт, а при том же угле головы шея компенсирует (голова не меняет ориентацию)", () => {
  const n = buildSpine({}), sl = buildSpine({ slouch: 1 });
  assert.ok(sl.verts[SPINE.T - 1].ang > n.verts[SPINE.T - 1].ang + 10, "T1 наклонился вперёд");
  near(sl.headAng, 0, 1e-12);
  assert.ok(sl.metrics.cervFlex < 0, "шея разгибается, чтобы голова осталась прямо");
  assert.ok(sl.neck.x > n.neck.x + 20, "голова вынесена вперёд по цепочке");
  assert.ok(sl.shoulder.x > n.shoulder.x, "плечо выдвинуто вперёд");
});

test("отклонения позвонков от нейтрали: ноль в нейтрали, растут с наклоном", () => {
  const n = buildSpine({});
  assert.ok(deviations(n, n).every((d) => d === 0));
  const d30 = deviations(buildSpine({ headFlex: 30 }), n), d60 = deviations(buildSpine({ headFlex: 60 }), n);
  for (let i = 0; i < d30.length; i++) assert.ok(d60[i] >= d30[i] - 1e-9, `позвонок ${i}`);
  assert.ok(d60.at(-1) > d30.at(-1));
  // грудные позвонки при чистом наклоне головы не двигаются
  for (let i = 0; i < SPINE.T; i++) near(d30[i], 0, 1e-9, `T${SPINE.T - i}`);
});

test("цвет отклонения: монотонный переход тёмный → янтарный → красный", () => {
  assert.equal(devColor(0), devColor(2));
  assert.notEqual(devColor(10), devColor(0));
  assert.equal(devColor(30), "#b5423b");
  assert.equal(devColor(20), "#b5423b");
});

test("SVG строится без NaN и с нужными частями", () => {
  for (const a of [-5, 0, 22, 60]) {
    const svg = renderSide(buildSpine({ headFlex: a, slouch: 0.7 }), null);
    assert.ok(!svg.includes("NaN"), "NaN в боковом виде");
    assert.equal((svg.match(/<rect /g) || []).length, 2 * (SPINE.T + SPINE.C), "тень + текущая цепочка");
  }
  const fr = renderFront({ shoulderTilt: 6, headTilt: -9 });
  assert.ok(!fr.includes("NaN"));
  assert.ok(fr.includes("<ellipse"));
});

test("подписи сторон", () => {
  assert.equal(sideWords(0.5, 0.5).sh, "плечи ровно");
  assert.ok(sideWords(5, 0).sh.startsWith("правое плечо ниже"));
  assert.ok(sideWords(-5, 0).sh.startsWith("левое плечо ниже"));
  assert.ok(sideWords(0, 7).hd.includes("к правому"));
  assert.ok(sideWords(0, -7).hd.includes("к левому"));
});
