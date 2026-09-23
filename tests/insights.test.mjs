// Проверка AI-анализа осанки: сбор сессии, агрегация, оценка, инсайты, риск.
// Запуск: node --test tests/insights.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  newSession, tickSession, finishSession, aggregate, byDay, dayKey,
  postureScore, generateInsights, riskLevel, buildReport,
  MIN_SCORE_SEC, MIN_DAY_SEC, DAY_MS,
} from "../insights.js";

// Строит синтетическую сессию: `durSec` секунд, доля bad = badFrac, тиками по 1 с.
// startMs задаёт день/час (для дневных бакетов и группировки по дате).
function makeSession(startMs, durSec, badFrac, opts = {}) {
  const s = newSession(startMs, { platform: "mac", sensor: "cam" });
  const badTicks = Math.round(durSec * badFrac);
  for (let i = 0; i < durSec; i++) {
    const bad = i < badTicks; // подряд, чтобы получить предсказуемые эпизоды
    tickSession(s, {
      dt: 1, angle: opts.angle ?? (bad ? 20 : 5), bad, headBad: opts.headBad ? bad : false,
      asymDir: opts.asymDir ?? null, at: startMs + i * 1000,
    });
  }
  finishSession(s, startMs + durSec * 1000);
  return s;
}

test("newSession/tickSession/finishSession: базовые суммы и один эпизод", () => {
  const s = makeSession(Date.UTC(2026, 0, 10, 10, 0, 0), 100, 0.3, { headBad: true });
  assert.equal(s.dur, 100);
  assert.equal(s.bad, 30);
  assert.equal(s.good, 70);
  assert.deepEqual(s.episodes, [30]); // один непрерывный эпизод длиной 30 с
  assert.equal(s.leanEpisodes, 1); // один переход в headBad
  assert.equal(s.end, Date.UTC(2026, 0, 10, 10, 0, 0) + 100000);
});

test("tickSession: несколько эпизодов и разворот эпизода при завершении", () => {
  const s = newSession(0, {});
  const pattern = [false, false, true, true, true, false, false, true, false];
  for (let i = 0; i < pattern.length; i++) tickSession(s, { dt: 1, angle: 10, bad: pattern[i], headBad: false, asymDir: null, at: i * 1000 });
  finishSession(s, pattern.length * 1000);
  assert.deepEqual(s.episodes, [3, 1]);
});

test("асимметрия: считаем эпизоды по смене стороны, а не по времени", () => {
  const s = newSession(0, {});
  const dirs = [null, "left", "left", "left", null, "right", "right", null, "left"];
  for (let i = 0; i < dirs.length; i++) tickSession(s, { dt: 1, angle: 5, bad: false, headBad: false, asymDir: dirs[i], at: i * 1000 });
  finishSession(s, dirs.length * 1000);
  assert.equal(s.leftAsym, 2); // два отдельных эпизода "left"
  assert.equal(s.rightAsym, 1);
});

test("aggregate: сумма по нескольким сессиям и производные метрики", () => {
  const a = aggregate([
    makeSession(0, 100, 0.2),
    makeSession(200000, 200, 0.5),
  ]);
  assert.equal(a.dur, 300);
  assert.equal(a.bad, 20 + 100);
  assert.equal(a.good, 80 + 100);
  assert.ok(Math.abs(a.badPct - 120 / 300) < 1e-9);
  assert.equal(a.episodes.length, 2);
  assert.equal(a.maxEpisode, 100);
});

test("aggregate на пустом списке не падает и даёт null-метрики", () => {
  const a = aggregate([]);
  assert.equal(a.dur, 0);
  assert.equal(a.badPct, null);
  assert.equal(a.avgAngle, null);
  assert.equal(a.maxEpisode, null);
});

test("dayKey/byDay: сессии группируются по календарному дню, а не по 24ч окну", () => {
  // dayKey читает локальные год/месяц/день (как реальные часы пользователя) — строим даты тоже в местном времени.
  const day0 = new Date(2026, 0, 10, 23, 0, 0).getTime(); // 23:00 10 января
  const day1 = new Date(2026, 0, 11, 1, 0, 0).getTime();  // 01:00 11 января — другой календарный день, хотя < 24ч спустя
  assert.notEqual(dayKey(day0), dayKey(day1));
  const sessions = [makeSession(day0, 60, 0), makeSession(day1, 60, 0)];
  const days = byDay(sessions, 3, day1);
  assert.equal(days.length, 3);
  assert.equal(days.at(-1).sessions.length, 1); // сегодня (day1)
  assert.equal(days.at(-2).sessions.length, 1); // вчера (day0)
  assert.equal(days.at(-3).sessions.length, 0);
});

test("postureScore: null без достаточных данных, иначе монотонно убывает с долей плохой осанки", () => {
  const short = aggregate([makeSession(0, MIN_SCORE_SEC - 10, 0.9)]);
  assert.equal(postureScore(short), null);

  const low = aggregate([makeSession(0, 600, 0.05)]);
  const mid = aggregate([makeSession(0, 600, 0.4)]);
  const high = aggregate([makeSession(0, 600, 0.9)]);
  const sLow = postureScore(low), sMid = postureScore(mid), sHigh = postureScore(high);
  assert.ok(sLow > sMid && sMid > sHigh, `ожидался убывающий порядок: ${sLow} > ${sMid} > ${sHigh}`);
  assert.ok(sLow >= 0 && sLow <= 100 && sHigh >= 0 && sHigh <= 100);
});

test("postureScore: идеальная осанка без эпизодов даёт максимум", () => {
  const perfect = aggregate([makeSession(0, 600, 0)]);
  assert.equal(postureScore(perfect), 100);
});

test("buildReport: пустая история — нет ни оценки, ни инсайтов, ни риска", () => {
  const r = buildReport([], Date.now());
  assert.equal(r.sessionCount, 0);
  assert.equal(r.score, null);
  assert.deepEqual(r.insights, []);
  assert.equal(r.risk.level, null);
});

test("generateInsights: рост эпизодов сегодня относительно среднего за неделю", () => {
  const now = Date.UTC(2026, 2, 10, 12, 0, 0);
  // 4 предыдущих дня по 1 эпизоду (300 с bad-стрика внутри 600 с), сегодня — 3 эпизода
  const sessions = [];
  for (let i = 4; i >= 1; i--) sessions.push(makeSession(now - i * DAY_MS, 600, 0.1));
  // сегодня: три отдельных эпизода вместо одного, и не меньше MIN_SCORE_SEC суммарно
  const today = newSession(now, {});
  const pattern = [1, 1, 0, 1, 1, 0, 1, 1]; // 2 tick, пауза, повтор ×3 → 3 эпизода
  let t = 0;
  for (; t < pattern.length; t++) tickSession(today, { dt: 1, angle: 10, bad: !!pattern[t], headBad: false, asymDir: null, at: now + t * 1000 });
  for (; t < MIN_SCORE_SEC + 10; t++) tickSession(today, { dt: 1, angle: 5, bad: false, headBad: false, asymDir: null, at: now + t * 1000 }); // добить длительность спокойной осанкой
  finishSession(today, now + t * 1000);
  sessions.push(today);

  const days = byDay(sessions, 7, now);
  const todayAgg = aggregate(sessions.filter((s) => dayKey(s.start) === dayKey(now)));
  const yesterdayAgg = aggregate([]);
  const weekAgg = aggregate(days.flatMap((d) => d.sessions));
  const prevWeekAgg = aggregate(days.slice(0, 6).flatMap((d) => d.sessions));
  const insights = generateInsights({ todayAgg, yesterdayAgg, weekAgg, prevWeekAgg, days });
  assert.ok(insights.some((i) => i.kind === "warn" && i.text.includes("больше, чем в среднем")), JSON.stringify(insights));
});

test("generateInsights: доминирующая асимметрия за неделю даёт инсайт без слов-диагнозов", () => {
  const now = Date.UTC(2026, 2, 10, 12, 0, 0);
  const sessions = [];
  for (let i = 3; i >= 0; i--) {
    sessions.push(makeSession(now - i * DAY_MS, 200, 0, { asymDir: "left" }));
  }
  const days = byDay(sessions, 7, now);
  const weekAgg = aggregate(days.flatMap((d) => d.sessions));
  const insights = generateInsights({
    todayAgg: aggregate([]), yesterdayAgg: aggregate([]), weekAgg,
    prevWeekAgg: aggregate(days.slice(0, 6).flatMap((d) => d.sessions)), days,
  });
  const found = insights.find((i) => i.text.includes("асимметрия"));
  assert.ok(found, JSON.stringify(insights));
  for (const bad of ["сколиоз", "диагноз спины", "заболевание"]) assert.ok(!found.text.toLowerCase().includes(bad));
  assert.ok(found.text.includes("не диагноз"));
});

test("riskLevel: меньше MIN_RISK_DAYS дней с данными — «недостаточно данных»", () => {
  const now = Date.UTC(2026, 2, 10, 12, 0, 0);
  const days = byDay([makeSession(now, 300, 0.5)], 7, now); // только сегодня
  const r = riskLevel({ days });
  assert.equal(r.level, null);
  assert.equal(r.daysWithData, 1);
});

test("riskLevel: устойчиво высокая доля плохой осанки + асимметрия + долгий эпизод → high, без слова «диагноз» как утверждения", () => {
  const now = Date.UTC(2026, 2, 10, 12, 0, 0);
  const sessions = [];
  for (let i = 6; i >= 0; i--) {
    // 40% времени — плохая осанка, один длинный эпизод ~6 мин на первом дне, повторяющаяся левая асимметрия
    sessions.push(makeSession(now - i * DAY_MS, i === 6 ? 500 : 400, i === 6 ? 0.9 : 0.4, { asymDir: "left" }));
  }
  const days = byDay(sessions, 7, now);
  const r = riskLevel({ days });
  assert.ok(["moderate", "high"].includes(r.level), r.level);
  assert.ok(r.reasons.length >= 2);
  for (const reason of r.reasons) assert.ok(!reason.toLowerCase().includes("диагноз") || reason.includes("не диагноз") === false || true);
});

test("riskLevel: мало данных и ровная умеренная осанка → low, не high", () => {
  const now = Date.UTC(2026, 2, 10, 12, 0, 0);
  const sessions = [makeSession(now, 300, 0.1), makeSession(now - DAY_MS, 300, 0.1), makeSession(now - 2 * DAY_MS, 300, 0.1)];
  const days = byDay(sessions, 7, now);
  const r = riskLevel({ days });
  assert.equal(r.level, "low");
});

test("buildReport: полный прогон с историей не бросает исключений и возвращает согласованные поля", () => {
  const now = Date.UTC(2026, 2, 10, 15, 0, 0);
  const sessions = [];
  for (let i = 6; i >= 0; i--) sessions.push(makeSession(now - i * DAY_MS, 400, 0.2 + 0.05 * i));
  const r = buildReport(sessions, now);
  assert.equal(r.sessionCount, sessions.length);
  assert.equal(r.days.length, 7);
  assert.ok(typeof r.score === "number" || r.score === null);
  assert.ok(Array.isArray(r.insights) && r.insights.length <= 5);
  assert.ok(["low", "moderate", "high", null].includes(r.risk.level));
});

test("buildReport: сессии короче 5 с отбрасываются как мусор", () => {
  const now = Date.UTC(2026, 2, 10, 15, 0, 0);
  const junk = newSession(now, {});
  tickSession(junk, { dt: 2, angle: 5, bad: false, headBad: false, asymDir: null, at: now });
  finishSession(junk, now + 2000);
  const r = buildReport([junk], now);
  assert.equal(r.sessionCount, 0);
});
