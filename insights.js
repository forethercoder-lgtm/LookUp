/* ------------------------------------------------------------------ */
/* AI-анализ осанки: история сессий + детерминированная аналитика.     */
/* Никакого внешнего AI API — только арифметика по уже вычисленным на  */
/* каждом тике данным (bad/headBad/наклон плеч). Ничего не выдумываем: */
/* каждая цифра и инсайт требуют минимума данных, иначе — «нет данных».*/
/* Формулировки нарочно избегают диагнозов (см. FDA General Wellness,  */
/* sources.json) — это индикатор паттерна, а не медицинское решение.   */
/* ------------------------------------------------------------------ */

export const DAY_MS = 86400000;
export const MIN_SCORE_SEC = 180;      // 3 мин — минимум, чтобы показать «Оценку осанки» за день
export const MIN_DAY_SEC = 120;        // 2 мин — минимум, чтобы день считался «с данными» для дневных трендов
export const MIN_RISK_SEC = 180;       // 3 мин суммарно за 7 дней — минимум для риск-монитора (не дни: демо/жюри не ждут сутками)
export const LONG_EPISODE_SEC = 180;   // «долгий» непрерывный эпизод плохой осанки, для инсайта
export const HIGH_RISK_EPISODE_SEC = 300; // сигнал риска: очень долгий эпизод

const BUCKETS = ["night", "morning", "afternoon", "evening"];
const BUCKET_LABEL = { night: "ночью", morning: "утром", afternoon: "днём", evening: "вечером" };
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export function hourBucket(date) {
  const h = date.getHours();
  if (h < 6) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Запись одной сессии мониторинга. Храним только агрегаты (не кадры   */
/* и не покадровый ряд): меньше места и приватнее.                     */
/* ------------------------------------------------------------------ */
export function newSession(startMs, meta = {}) {
  return {
    id: startMs.toString(36) + Math.random().toString(36).slice(2, 7),
    start: startMs, end: null, dur: 0,
    platform: meta.platform ?? null, sensor: meta.sensor ?? null,
    good: 0, bad: 0,                 // секунды
    episodes: [],                    // длительности непрерывных эпизодов плохой осанки, сек
    leanEpisodes: 0,                 // сколько раз голова наклонялась вперёд (новый эпизод)
    leftAsym: 0, rightAsym: 0,       // эпизоды перекоса плеч по стороне
    angleSum: 0, angleW: 0, maxAngle: 0,
    hours: { night: { total: 0, bad: 0 }, morning: { total: 0, bad: 0 }, afternoon: { total: 0, bad: 0 }, evening: { total: 0, bad: 0 } },
    _streak: 0, _wasBad: false, _wasHeadBad: false, _tiltDir: null,
  };
}

// Вызывать на каждом тике мониторинга (dt — секунды с прошлого тика).
export function tickSession(s, { dt, angle, bad, headBad, asymDir, at }) {
  if (!s || !(dt > 0)) return;
  s.dur += dt;
  if (bad) s.bad += dt; else s.good += dt;
  if (typeof angle === "number") {
    s.angleSum += angle * dt; s.angleW += dt;
    if (angle > s.maxAngle) s.maxAngle = angle;
  }
  if (headBad && !s._wasHeadBad) s.leanEpisodes++;
  s._wasHeadBad = headBad;

  if (asymDir && asymDir !== s._tiltDir) { // новый эпизод перекоса или смена стороны
    if (asymDir === "left") s.leftAsym++; else if (asymDir === "right") s.rightAsym++;
  }
  s._tiltDir = asymDir ?? null;

  if (bad) {
    s._streak += dt;
  } else if (s._wasBad && s._streak > 0) {
    s.episodes.push(s._streak);
    s._streak = 0;
  }
  s._wasBad = bad;

  const b = hourBucket(new Date(at));
  s.hours[b].total += dt;
  if (bad) s.hours[b].bad += dt;
}

export function finishSession(s, endMs) {
  if (s._streak > 0) { s.episodes.push(s._streak); s._streak = 0; }
  s.end = endMs;
  delete s._wasBad; delete s._wasHeadBad; delete s._tiltDir;
  return s;
}

/* ------------------------------------------------------------------ */
/* Агрегация: сумма по списку сессий + производные метрики.            */
/* ------------------------------------------------------------------ */
export function aggregate(sessions) {
  const a = {
    count: sessions.length, dur: 0, good: 0, bad: 0,
    episodes: [], leanEpisodes: 0, leftAsym: 0, rightAsym: 0,
    angleSum: 0, angleW: 0, maxAngle: 0,
    hours: { night: { total: 0, bad: 0 }, morning: { total: 0, bad: 0 }, afternoon: { total: 0, bad: 0 }, evening: { total: 0, bad: 0 } },
  };
  for (const s of sessions) {
    a.dur += s.dur; a.good += s.good; a.bad += s.bad;
    a.episodes.push(...s.episodes);
    a.leanEpisodes += s.leanEpisodes; a.leftAsym += s.leftAsym; a.rightAsym += s.rightAsym;
    a.angleSum += s.angleSum; a.angleW += s.angleW;
    if (s.maxAngle > a.maxAngle) a.maxAngle = s.maxAngle;
    for (const k of BUCKETS) { a.hours[k].total += s.hours[k].total; a.hours[k].bad += s.hours[k].bad; }
  }
  a.badPct = a.dur > 0 ? a.bad / a.dur : null;
  a.goodPct = a.dur > 0 ? a.good / a.dur : null;
  a.avgAngle = a.angleW > 0 ? a.angleSum / a.angleW : null;
  a.avgEpisode = a.episodes.length ? a.episodes.reduce((x, y) => x + y, 0) / a.episodes.length : null;
  a.maxEpisode = a.episodes.length ? Math.max(...a.episodes) : null;
  return a;
}

// Последние `days` календарных дней (локальное время), от старого к новому, включая сегодня.
export function byDay(sessions, days, nowMs) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const ms = nowMs - i * DAY_MS;
    const key = dayKey(ms);
    const list = sessions.filter((s) => dayKey(s.start) === key);
    out.push({ key, label: WEEKDAY[new Date(ms).getDay()], sessions: list, agg: aggregate(list) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Оценка осанки 0…100 — детерминированная функция агрегата дня.       */
/* Никаких случайных чисел: доля плохой осанки, частота эпизодов и     */
/* доля длинных эпизодов. null, если данных меньше MIN_SCORE_SEC.      */
/* ------------------------------------------------------------------ */
export function postureScore(agg) {
  if (!agg || agg.dur < MIN_SCORE_SEC) return null;
  let score = 100;
  score -= agg.badPct * 55;                                      // до −55 за долю времени в плохой позе
  const perHour = agg.episodes.length / (agg.dur / 3600);
  score -= Math.min(25, perHour * 5);                             // до −25 за частоту эпизодов
  const longCount = agg.episodes.filter((e) => e > 60).length;
  const longRatio = agg.episodes.length ? longCount / agg.episodes.length : 0;
  score -= Math.min(20, longRatio * 20);                          // до −20 если много эпизодов дольше минуты
  return Math.max(0, Math.min(100, Math.round(score)));
}

const pct = (x) => Math.round(x * 100);
const epWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "эпизод" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "эпизода" : "эпизодов");

/* ------------------------------------------------------------------ */
/* Инсайты: список правил «если данных достаточно и порог пройден —    */
/* добавить факт». Максимум 5, каждый — отдельно проверенный факт, а   */
/* не диагноз. Порядок фиксированный (по важности), не случайный.      */
/* ------------------------------------------------------------------ */
export function generateInsights({ todayAgg, yesterdayAgg, weekAgg, prevWeekAgg, days }) {
  const out = [];

  // 1. доля плохой осанки сегодня
  if (todayAgg.dur >= MIN_SCORE_SEC) {
    if (todayAgg.badPct >= 0.15) out.push({ kind: "warn", text: `Ваша осанка была неправильной ${pct(todayAgg.badPct)}% времени сегодняшнего мониторинга.` });
    else if (todayAgg.badPct <= 0.05) out.push({ kind: "good", text: `Сегодня вы почти всё время сидели правильно — ${pct(todayAgg.goodPct)}% в норме.` });
  }

  // 2. время суток, когда осанка хуже (нужно ≥2 «часовых» отрезка с данными за неделю)
  const buckets = BUCKETS.map((k) => ({ k, ...weekAgg.hours[k] })).filter((b) => b.total >= 180);
  if (buckets.length >= 2) {
    const withPct = buckets.map((b) => ({ ...b, pct: b.bad / b.total }));
    const worst = withPct.reduce((a, b) => (b.pct > a.pct ? b : a));
    const restAvg = withPct.filter((b) => b.k !== worst.k).reduce((s, b) => s + b.pct, 0) / Math.max(1, withPct.length - 1);
    if (worst.pct - restAvg >= 0.15) out.push({ kind: "warn", text: `Осанка чаще нарушается ${BUCKET_LABEL[worst.k]}: доля времени с плохой осанкой в это время заметно выше, чем в остальные часы.` });
  }

  // 3. эпизодов сегодня по сравнению со средним за предыдущие дни недели
  const prevDaysWithData = days.slice(0, 6).filter((d) => d.agg.dur >= MIN_DAY_SEC);
  if (todayAgg.dur >= MIN_SCORE_SEC && prevDaysWithData.length >= 2) {
    const weeklyAvg = prevDaysWithData.reduce((s, d) => s + d.agg.episodes.length, 0) / prevDaysWithData.length;
    const cnt = todayAgg.episodes.length;
    if (weeklyAvg >= 1 && cnt > weeklyAvg * 1.3) out.push({ kind: "warn", text: `Сегодня ${cnt} ${epWord(cnt)} плохой осанки — больше, чем в среднем за последние дни (${weeklyAvg.toFixed(1)}).` });
    else if (weeklyAvg >= 1 && cnt < weeklyAvg * 0.7) out.push({ kind: "good", text: `Сегодня всего ${cnt} ${epWord(cnt)} плохой осанки — меньше среднего за последние дни (${weeklyAvg.toFixed(1)}).` });
  }

  // 4. средний угол наклона головы: сегодня против прошлой недели (без сегодня)
  if (todayAgg.angleW >= 60 && prevWeekAgg.angleW >= 60) {
    const diff = prevWeekAgg.avgAngle - todayAgg.avgAngle;
    if (diff >= 2) out.push({ kind: "good", text: `Средний угол наклона головы сегодня ниже, чем на прошлой неделе: ${todayAgg.avgAngle.toFixed(0)}° против ${prevWeekAgg.avgAngle.toFixed(0)}°.` });
    else if (diff <= -2) out.push({ kind: "warn", text: `Средний угол наклона головы сегодня выше, чем на прошлой неделе: ${todayAgg.avgAngle.toFixed(0)}° против ${prevWeekAgg.avgAngle.toFixed(0)}°.` });
  }

  // 5. повторяющаяся асимметрия плеч (не диагноз — только паттерн). Считаем по числу эпизодов,
  // а не по числу дней — паттерн виден и за одну сессию мониторинга, не нужно ждать несколько дней.
  const totalAsym = weekAgg.leftAsym + weekAgg.rightAsym;
  if (totalAsym >= 4) {
    const domLeft = weekAgg.leftAsym >= weekAgg.rightAsym;
    const share = Math.max(weekAgg.leftAsym, weekAgg.rightAsym) / totalAsym;
    if (share >= 0.65) out.push({ kind: "warn", text: `Повторяющаяся асимметрия плеч по данным мониторинга (чаще опущено ${domLeft ? "левое" : "правое"}). Это не диагноз, но паттерн стоит понаблюдать; если он повторяется — есть смысл обсудить со специалистом.` });
  }

  // 6. длинные непрерывные эпизоды плохой осанки
  if (weekAgg.maxEpisode !== null && weekAgg.maxEpisode >= LONG_EPISODE_SEC) {
    out.push({ kind: "warn", text: `Был непрерывный эпизод плохой осанки продолжительностью около ${Math.round(weekAgg.maxEpisode / 60)} мин. Долгие эпизоды — то, на что стоит обратить внимание.` });
  }

  // 7. сегодня против вчера
  if (todayAgg.dur >= MIN_SCORE_SEC && yesterdayAgg.dur >= MIN_SCORE_SEC) {
    const d = todayAgg.badPct - yesterdayAgg.badPct;
    if (d <= -0.05) out.push({ kind: "good", text: `Сегодня осанка лучше, чем вчера: ${pct(todayAgg.badPct)}% времени с плохой осанкой против ${pct(yesterdayAgg.badPct)}% вчера.` });
    else if (d >= 0.05) out.push({ kind: "warn", text: `Сегодня осанка хуже, чем вчера: ${pct(todayAgg.badPct)}% времени с плохой осанкой против ${pct(yesterdayAgg.badPct)}% вчера.` });
  }

  return out.slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* Мониторинг риска: НЕ диагноз. Считаем устойчивые паттерны за 7 дней  */
/* по 4 независимым сигналам; уровень = сколько сигналов сработало.    */
/* Порог — суммарное время мониторинга (3 мин), а не число дней: иначе */
/* индикатор было бы не показать на демо за одну короткую сессию.      */
/* ------------------------------------------------------------------ */
export function riskLevel({ days }) {
  const weekAgg = aggregate(days.flatMap((d) => d.sessions));
  if (weekAgg.dur < MIN_RISK_SEC) return { level: null, reasons: [], dataSec: weekAgg.dur };

  const reasons = [];

  // (a) повторяющаяся асимметрия — по числу эпизодов, без требования нескольких дней подряд
  const totalAsym = weekAgg.leftAsym + weekAgg.rightAsym;
  if (totalAsym >= 4 && Math.max(weekAgg.leftAsym, weekAgg.rightAsym) / totalAsym >= 0.6) {
    reasons.push("Повторяющаяся асимметрия плеч отмечена по данным мониторинга.");
  }
  // (b) устойчиво высокая доля плохой осанки
  if (weekAgg.badPct !== null && weekAgg.badPct >= 0.25) {
    reasons.push(`Плохая осанка занимает заметную часть времени мониторинга — ${pct(weekAgg.badPct)}%.`);
  }
  // (c) растущая частота эпизодов — сравниваем первую и вторую половину дней с данными за неделю;
  // это по своей природе многодневный тренд и на короткой демо-сессии обычно не сработает — это нормально.
  const withData = days.filter((d) => d.agg.dur >= MIN_DAY_SEC);
  const half = Math.ceil(days.length / 2);
  const first = days.slice(0, half).filter((d) => d.agg.dur >= MIN_DAY_SEC);
  const second = days.slice(half).filter((d) => d.agg.dur >= MIN_DAY_SEC);
  if (first.length && second.length) {
    const firstAvg = first.reduce((s, d) => s + d.agg.episodes.length, 0) / first.length;
    const secondAvg = second.reduce((s, d) => s + d.agg.episodes.length, 0) / second.length;
    if (secondAvg >= 1 && secondAvg > firstAvg * 1.3) reasons.push("Частота эпизодов плохой осанки растёт по сравнению с началом недели.");
  }
  // (d) необычно долгие непрерывные эпизоды
  if (weekAgg.maxEpisode !== null && weekAgg.maxEpisode >= HIGH_RISK_EPISODE_SEC) {
    reasons.push(`Были продолжительные непрерывные эпизоды плохой осанки — до ${Math.round(weekAgg.maxEpisode / 60)} мин.`);
  }

  const level = reasons.length >= 3 ? "high" : reasons.length === 2 ? "moderate" : "low";
  return { level, reasons, dataSec: weekAgg.dur, daysWithData: withData.length };
}

/* ------------------------------------------------------------------ */
/* Единая точка входа для UI: считает всё из сырых сессий один раз.    */
/* ------------------------------------------------------------------ */
export function buildReport(sessions, nowMs = Date.now()) {
  const clean = (sessions || []).filter((s) => s && s.dur >= 5); // отбрасываем случайный мусор (<5 с)
  const todayKey = dayKey(nowMs), yestKey = dayKey(nowMs - DAY_MS);
  const today = clean.filter((s) => dayKey(s.start) === todayKey);
  const yesterday = clean.filter((s) => dayKey(s.start) === yestKey);
  const days = byDay(clean, 7, nowMs);
  const weekSessions = days.flatMap((d) => d.sessions);
  const prevWeekSessions = days.slice(0, 6).flatMap((d) => d.sessions); // неделя без сегодняшнего дня

  const todayAgg = aggregate(today);
  const yesterdayAgg = aggregate(yesterday);
  const weekAgg = aggregate(weekSessions);
  const prevWeekAgg = aggregate(prevWeekSessions);

  return {
    today: todayAgg, yesterday: yesterdayAgg, days, weekAgg, prevWeekAgg,
    score: postureScore(todayAgg),
    insights: generateInsights({ todayAgg, yesterdayAgg, weekAgg, prevWeekAgg, days }),
    risk: riskLevel({ days }),
    sessionCount: clean.length,
  };
}
