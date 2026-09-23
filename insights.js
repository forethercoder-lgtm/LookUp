/* ------------------------------------------------------------------ */
/* LUP AI: история сессий + анализ осанки.                             */
/* Внутри — алгоритм на правилах, без нейросети и внешнего API: по      */
/* метрикам сессии (доля времени с наклоном, углы, эпизоды, перекос    */
/* плеч) выбирается один из шаблонов ответа и заполняется цифрами.     */
/* ------------------------------------------------------------------ */

export const DAY_MS = 86400000;
export const MIN_SCORE_SEC = 60;       // 1 мин мониторинга — достаточно для оценки и ответа LUP AI

const BUCKETS = ["night", "morning", "afternoon", "evening"];
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
/* Оценка осанки 0…100: доля времени с наклоном, частота эпизодов в    */
/* минуту и доля длинных (> 30 с) эпизодов. null — если меньше минуты. */
/* ------------------------------------------------------------------ */
export function postureScore(agg) {
  if (!agg || agg.dur < MIN_SCORE_SEC) return null;
  const perMin = agg.episodes.length / (agg.dur / 60);
  const longRatio = agg.episodes.length ? agg.episodes.filter((e) => e > 30).length / agg.episodes.length : 0;
  const score = 100 - agg.badPct * 70 - Math.min(15, perMin * 6) - Math.min(15, longRatio * 15);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ------------------------------------------------------------------ */
/* LUP AI: ответ по шаблонам. Уровень — по доле времени с наклоном,    */
/* текст заполняется цифрами сессии, добавки — по перекосу плеч,        */
/* длинному эпизоду и сравнению с прошлой сессией. Вариант заголовка   */
/* выбирается по seed (время начала сессии) — один и тот же для сессии. */
/* ------------------------------------------------------------------ */
export const TIERS = ["excellent", "good", "fair", "poor", "critical"];
export function lupTier(badPct) {
  if (badPct < 0.05) return "excellent";
  if (badPct < 0.15) return "good";
  if (badPct < 0.35) return "fair";
  if (badPct < 0.6) return "poor";
  return "critical";
}

const pct = (x) => Math.round(x * 100);
const deg = (x) => Math.max(0, Math.round(x ?? 0));
export function fmtSpan(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m === 0) return `${s} с`;
  return s ? `${m} мин ${s} с` : `${m} мин`;
}
const times = (n) => (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? `${n} раза` : `${n} раз`);

const T = {
  excellent: {
    badge: "Отлично",
    titles: ["Вы настоящий спортик!", "Осанка как у спортсмена!", "Идеально — так держать, спортик!"],
    analysis: (m) => `LUP AI проанализировал вашу сессию: вы настоящий спортик — осанка почти идеальная. За ${m.dur} вы ${m.good}% времени держали голову в безопасной зоне 0–15°, средний наклон — всего ${m.avg}°. Шея, плечи и спина работали так, как и должны при работе за ноутбуком. Это уровень человека, который следит за собой.`,
    effectsTitle: "Что это даёт",
    effects: "Шея держит только вес самой головы — около 5 кг, без лишней нагрузки. Мышцы шеи и верха спины не перенапрягаются, поэтому к вечеру меньше усталости, скованности и головной боли. Дыхание свободнее, концентрация держится дольше. Такая привычка — лучшая защита от сутулости на годы вперёд.",
    advice: [
      "Продолжайте в том же духе — вы задаёте планку.",
      "Каждые 30–40 минут вставайте на 1–2 минуты: даже идеальной позе нужен отдых от неподвижности.",
      "Не меняйте высоту подставки — она подобрана правильно.",
      "Добавьте лёгкую разминку шеи и плеч раз в день, чтобы закрепить результат.",
    ],
  },
  good: {
    badge: "Хорошо",
    titles: ["Хорошая осанка, почти без замечаний", "Неплохо! Осанка в норме большую часть времени"],
    analysis: (m) => `LUP AI проанализировал вашу сессию. За ${m.dur} вы ${m.good}% времени сидели правильно, средний наклон головы — ${m.avg}°. Несколько раз голова всё же уходила вперёд (поза нарушалась ${m.eps}), но наклоны были короткими и вы быстро возвращались в правильное положение.`,
    effectsTitle: "К чему это может привести",
    effects: "Короткие наклоны почти не нагружают шею. Но если они станут чаще и дольше, нагрузка на шейный отдел растёт очень быстро: уже при 15° — около 12 кг, при 30° — около 18 кг. Именно так привычка сутулиться и формируется — незаметно, по несколько секунд за раз.",
    advice: [
      "Как только LookUp подаёт сигнал — выпрямляйтесь сразу, не дожидаясь конца задачи.",
      "Проверьте, что верх экрана на уровне глаз.",
      "Когда читаете текст внизу экрана — прокручивайте его вверх, а не опускайте голову.",
      "Каждые 30–40 минут делайте паузу на 1–2 минуты.",
    ],
  },
  fair: {
    badge: "Средне",
    titles: ["Осанка средняя — есть над чем поработать", "Вы часто наклоняетесь вперёд"],
    analysis: (m) => `LUP AI проанализировал вашу сессию. За ${m.dur} голова ${m.bad}% времени была наклонена сильнее безопасных 15°, средний наклон — ${m.avg}°, максимальный — ${m.max}°. Поза нарушалась ${m.eps}. Это уже не случайные движения, а привычка, которая начинает формироваться.`,
    effectsTitle: "Последствия",
    effects: "В таком положении шея постоянно держит 12–18 кг вместо 5. Мышцы задней поверхности шеи и верха спины работают без отдыха: появляются напряжение и скованность, к концу дня — усталость и головная боль. Если сидеть так каждый день, сутулость постепенно становится вашей обычной позой.",
    advice: [
      "Поднимите экран: верх экрана — на уровне глаз. Введите высоту подставки в блоке «Экран» — сайт посчитает нужный угол.",
      "Реагируйте на сигнал LookUp сразу — через неделю спина начнёт держаться сама.",
      "Каждые 20–30 минут вставайте, расправляйте плечи и сводите лопатки.",
      "Сядьте глубже, спиной к спинке стула — так голове легче держаться прямо.",
    ],
  },
  poor: {
    badge: "Плохо",
    titles: ["Осанка плохая — шея перегружена", "Вы большую часть времени сутулитесь"],
    analysis: (m) => `LUP AI проанализировал вашу сессию. За ${m.dur} вы ${m.bad}% времени сидели с наклоном, средний наклон — ${m.avg}°, голова уходила вперёд до ${m.max}°. Поза нарушалась ${m.eps}. Это уже устойчивая сутулость, а не случайные движения.`,
    effectsTitle: "Последствия",
    effects: "При таком наклоне шея держит 18–22 кг — в 4 раза больше веса головы. Постоянная перегрузка приводит к хроническому напряжению мышц шеи и плеч, головным болям, болям в шее и между лопатками, быстрой утомляемости. Плечи привыкают уходить вперёд, и со временем выпрямиться становится всё труднее.",
    advice: [
      "В первую очередь поднимите экран на подставку — без этого привычка не уйдёт.",
      "Работайте с LookUp постоянно и не выключайте сирену — это ваш тренер осанки.",
      "Каждые 20 минут — перерыв: встаньте, сведите лопатки, потянитесь вверх.",
      "Каждый день 5–10 минут упражнений: подбородок назад («двойной подбородок»), сведение лопаток, планка.",
      "Если шея болит регулярно — покажитесь врачу.",
    ],
  },
  critical: {
    badge: "Критично",
    titles: ["Критическая сутулость — срочно выпрямитесь!", "Шея работает на пределе"],
    analysis: (m) => `LUP AI проанализировал вашу сессию. Почти всё время — ${m.bad}% из ${m.dur} — голова была сильно наклонена вперёд: в среднем на ${m.avg}°, максимум — ${m.max}°. ${m.good < 1 ? "В правильной позе вы не были почти ни секунды." : `В правильной позе вы провели только ${m.good}% времени.`}`,
    effectsTitle: "Последствия",
    effects: "Такая поза нагружает шею до 22–27 кг — в пять раз больше веса самой головы. Если работать так регулярно, это ведёт к постоянным болям в шее и спине, головным болям, онемению и покалыванию в руках. Закрепляются сутулость и «выдвинутая» вперёд голова, а мышцы спины слабеют.",
    advice: [
      "Прямо сейчас: выпрямитесь, отведите плечи назад и поднимите экран.",
      "Поставьте ноутбук на подставку и введите её высоту в блоке «Экран».",
      "Работайте короткими отрезками по 20 минут с перерывами.",
      "Ежедневно делайте упражнения для шеи и спины.",
      "Если есть боль, онемение или покалывание в руках — обратитесь к врачу.",
    ],
  },
};

export function lupAnalysis(agg, { prev = null, seed = 0 } = {}) {
  if (!agg || agg.dur < MIN_SCORE_SEC) return null;
  const tier = lupTier(agg.badPct);
  const t = T[tier];
  const m = {
    dur: fmtSpan(agg.dur), good: pct(agg.goodPct), bad: pct(agg.badPct),
    avg: deg(agg.avgAngle), max: deg(agg.maxAngle), eps: times(agg.episodes.length),
  };
  const analysis = [t.analysis(m)];

  if (tier !== "excellent" && agg.maxEpisode !== null && agg.maxEpisode >= 20) {
    analysis.push(`Самый долгий непрерывный наклон длился ${fmtSpan(agg.maxEpisode)} — всё это время шея была под повышенной нагрузкой.`);
  }
  const asym = agg.leftAsym + agg.rightAsym;
  if (asym >= 2) {
    const side = agg.leftAsym >= agg.rightAsym ? "левое" : "правое";
    analysis.push(`Ещё LUP AI заметил перекос плеч: чаще опускалось ${side} плечо (${times(Math.max(agg.leftAsym, agg.rightAsym))}). Держите плечи на одной линии и не опирайтесь на один локоть.`);
  }
  if (prev && prev.dur >= MIN_SCORE_SEC) {
    const was = pct(prev.badPct), now = pct(agg.badPct), d = was - now;
    if (d >= 5) analysis.push(`По сравнению с прошлой сессией доля времени с наклоном снизилась с ${was}% до ${now}% — прогресс заметен.`);
    else if (d <= -5) analysis.push(`По сравнению с прошлой сессией доля времени с наклоном выросла с ${was}% до ${now}% — соберитесь.`);
    else analysis.push("Результат примерно такой же, как в прошлой сессии.");
  }

  const title = t.titles[Math.abs(Math.floor(seed)) % t.titles.length];
  return {
    tier, badge: t.badge, title,
    sections: [
      { h: "Анализ", p: analysis },
      { h: t.effectsTitle, p: [t.effects] },
      { h: "Что делать", list: t.advice },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Единая точка входа для UI: считает всё из сырых сессий один раз.    */
/* ------------------------------------------------------------------ */
export function buildReport(sessions, nowMs = Date.now()) {
  const clean = (sessions || []).filter((s) => s && s.dur > 0).sort((a, b) => a.start - b.start);
  const todayKey = dayKey(nowMs);
  const days = byDay(clean, 7, nowMs);
  const latest = clean.at(-1) ?? null;
  const prev = clean.slice(0, -1).reverse().find((s) => s.dur >= MIN_SCORE_SEC) ?? null;
  const latestAgg = latest ? aggregate([latest]) : null;

  return {
    today: aggregate(clean.filter((s) => dayKey(s.start) === todayKey)),
    days,
    weekAgg: aggregate(days.flatMap((d) => d.sessions)),
    latest, latestAgg,
    score: latestAgg ? postureScore(latestAgg) : null,
    lup: latestAgg ? lupAnalysis(latestAgg, { prev: prev ? aggregate([prev]) : null, seed: latest.start / 1000 }) : null,
    sessionCount: clean.length,
  };
}
