// Проверка LUP AI: сбор сессии, агрегация, оценка, шаблонный ответ.
// Запуск: node --test tests/insights.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  newSession, tickSession, finishSession, aggregate, byDay, dayKey,
  postureScore, lupAnalysis, lupTier, buildReport, fmtSpan,
  MIN_SCORE_SEC, DAY_MS,
} from "../insights.js";

// Синтетическая сессия: `durSec` секунд тиками по 1 с, доля bad = badFrac.
// chunk — длина одного эпизода (по умолчанию все плохие секунды подряд).
function makeSession(startMs, durSec, badFrac, opts = {}) {
  const s = newSession(startMs, { platform: "mac", sensor: "cam" });
  const badTicks = Math.round(durSec * badFrac);
  const chunk = opts.chunk ?? badTicks;
  let bads = 0;
  for (let i = 0; i < durSec; i++) {
    const inChunk = chunk > 0 && (i % (chunk * 2)) < chunk;
    const bad = inChunk && bads < badTicks;
    if (bad) bads++;
    tickSession(s, {
      dt: 1, angle: opts.angle ?? (bad ? 25 : 5), bad, headBad: bad,
      asymDir: opts.asymDir ?? null, at: startMs + i * 1000,
    });
  }
  finishSession(s, startMs + durSec * 1000);
  return s;
}
const allText = (a) => [a.title, ...a.sections.flatMap((s) => [s.h, ...(s.p ?? []), ...(s.list ?? [])])].join(" ");

test("сбор сессии: суммы, эпизоды, наклоны вперёд", () => {
  const s = makeSession(Date.UTC(2026, 0, 10, 10), 100, 0.3);
  assert.equal(s.dur, 100);
  assert.equal(s.bad, 30);
  assert.equal(s.good, 70);
  assert.deepEqual(s.episodes, [30]);
  assert.equal(s.leanEpisodes, 1);
});

test("несколько эпизодов и незакрытый эпизод при завершении", () => {
  const s = newSession(0, {});
  const pattern = [0, 0, 1, 1, 1, 0, 0, 1];
  pattern.forEach((b, i) => tickSession(s, { dt: 1, angle: 10, bad: !!b, headBad: false, asymDir: null, at: i * 1000 }));
  finishSession(s, 8000);
  assert.deepEqual(s.episodes, [3, 1]);
});

test("перекос плеч считается эпизодами по смене стороны", () => {
  const s = newSession(0, {});
  [null, "left", "left", null, "right", null, "left"].forEach((d, i) => tickSession(s, { dt: 1, angle: 5, bad: false, headBad: false, asymDir: d, at: i * 1000 }));
  finishSession(s, 7000);
  assert.equal(s.leftAsym, 2);
  assert.equal(s.rightAsym, 1);
});

test("aggregate и byDay: суммы и группировка по календарному дню", () => {
  const a = aggregate([makeSession(0, 100, 0.2), makeSession(200000, 200, 0.5)]);
  assert.equal(a.dur, 300);
  assert.equal(a.bad, 120);
  assert.equal(a.maxEpisode, 100);
  assert.equal(aggregate([]).badPct, null);

  const d0 = new Date(2026, 0, 10, 23).getTime(), d1 = new Date(2026, 0, 11, 1).getTime();
  assert.notEqual(dayKey(d0), dayKey(d1));
  const days = byDay([makeSession(d0, 60, 0), makeSession(d1, 60, 0)], 3, d1);
  assert.deepEqual(days.map((d) => d.sessions.length), [0, 1, 1]);
});

test("оценка: нужна минута данных, дальше монотонно убывает с долей наклона", () => {
  assert.equal(MIN_SCORE_SEC, 60);
  assert.equal(postureScore(aggregate([makeSession(0, 50, 0.5)])), null);
  assert.equal(postureScore(aggregate([makeSession(0, 60, 0)])), 100);
  const s = [0.05, 0.3, 0.6, 0.95].map((f) => postureScore(aggregate([makeSession(0, 120, f)])));
  for (let i = 1; i < s.length; i++) assert.ok(s[i] < s[i - 1], `ожидалось убывание: ${s}`);
});

test("уровни LUP AI по доле времени с наклоном", () => {
  assert.equal(lupTier(0), "excellent");
  assert.equal(lupTier(0.1), "good");
  assert.equal(lupTier(0.2), "fair");
  assert.equal(lupTier(0.5), "poor");
  assert.equal(lupTier(0.9), "critical");
});

test("LUP AI молчит, пока нет минуты данных", () => {
  assert.equal(lupAnalysis(aggregate([makeSession(0, 59, 0.5)])), null);
  assert.notEqual(lupAnalysis(aggregate([makeSession(0, 60, 0.5)])), null);
});

test("хорошая осанка → «спортик», большой текст из трёх разделов", () => {
  const a = lupAnalysis(aggregate([makeSession(0, 90, 0)]), { seed: 0 });
  assert.equal(a.tier, "excellent");
  assert.match(a.title, /спорт/i);
  for (const seed of [0, 1, 2]) assert.ok(allText(lupAnalysis(aggregate([makeSession(0, 90, 0)]), { seed })).includes("спортик"));
  assert.equal(a.sections.length, 3);
  assert.ok(allText(a).length > 600, "ответ должен быть развёрнутым");
});

test("плохая осанка: в тексте цифры сессии, последствия и что делать", () => {
  const agg = aggregate([makeSession(0, 120, 0.9, { angle: 35 })]);
  const a = lupAnalysis(agg);
  assert.equal(a.tier, "critical");
  const t = allText(a);
  assert.ok(t.includes("90%"), t);
  assert.ok(t.includes("35°"), t);
  assert.ok(t.includes("2 мин"), t);
  assert.deepEqual(a.sections.map((s) => s.h), ["Анализ", "Последствия", "Что делать"]);
  assert.ok(a.sections[2].list.length >= 4);
});

test("в ответах нет оговорок «индикатор / не диагноз / не лечение»", () => {
  for (const f of [0, 0.1, 0.25, 0.5, 0.9]) {
    const t = allText(lupAnalysis(aggregate([makeSession(0, 120, f, { asymDir: "left", chunk: 5 })]))).toLowerCase();
    for (const w of ["индикатор", "не диагноз", "не лечение", "не медицинск"]) assert.ok(!t.includes(w), `«${w}» в ответе для ${f}`);
  }
});

test("персональные добавки: перекос плеч, долгий эпизод, сравнение с прошлой сессией", () => {
  const sessions = [0, 1, 2].map((i) => makeSession(i * 1000, 60, 0.3, { asymDir: "right", chunk: 6 }));
  const agg = aggregate(sessions);
  const withAsym = allText(lupAnalysis(agg));
  assert.ok(withAsym.includes("правое плечо"), withAsym);

  const long = allText(lupAnalysis(aggregate([makeSession(0, 120, 0.5)])));
  assert.ok(long.includes("Самый долгий непрерывный наклон длился 1 мин"), long);

  const better = allText(lupAnalysis(aggregate([makeSession(0, 60, 0.1)]), { prev: aggregate([makeSession(0, 60, 0.5)]) }));
  assert.ok(better.includes("снизилась с 50% до 10%"), better);
  const worse = allText(lupAnalysis(aggregate([makeSession(0, 60, 0.5)]), { prev: aggregate([makeSession(0, 60, 0.1)]) }));
  assert.ok(worse.includes("выросла с 10% до 50%"), worse);
});

test("один и тот же ответ для одной и той же сессии (без случайности)", () => {
  const agg = aggregate([makeSession(0, 90, 0.2)]);
  assert.deepEqual(lupAnalysis(agg, { seed: 12345 }), lupAnalysis(agg, { seed: 12345 }));
});

test("buildReport: пустая история, живая короткая сессия, последняя сессия и прошлая для сравнения", () => {
  const empty = buildReport([], Date.now());
  assert.equal(empty.sessionCount, 0);
  assert.equal(empty.lup, null);

  const now = Date.UTC(2026, 2, 10, 12);
  const old = makeSession(now - 3600e3, 120, 0.6);
  const cur = makeSession(now - 600e3, 120, 0.05);
  const r = buildReport([cur, old], now); // порядок не важен — сортируется по времени
  assert.equal(r.latest.id, cur.id);
  assert.equal(r.lup.tier, "good");
  assert.ok(allText(r.lup).includes("снизилась"), "сравнение с прошлой сессией");
  assert.equal(typeof r.score, "number");
  assert.equal(r.days.length, 7);

  const short = makeSession(now, 20, 0.5);
  const r2 = buildReport([old, short], now);
  assert.equal(r2.latest.id, short.id);
  assert.equal(r2.lup, null, "короче минуты — анализа нет");
});

test("fmtSpan", () => {
  assert.equal(fmtSpan(42), "42 с");
  assert.equal(fmtSpan(60), "1 мин");
  assert.equal(fmtSpan(72), "1 мин 12 с");
  assert.equal(fmtSpan(DAY_MS / 1000 / 24), "60 мин");
});
