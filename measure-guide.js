/* Пошаговый замер прямо в кадре камеры: инструкция поверх видео, голос,
   обратный отсчёт, сигнал помощнику «снимаем» и автоматическая запись показаний.
   Число поз, повторов, длительность записи и допуск движения берутся из протокола (measure.js).
   Использует состояние основного приложения (window.__lookup) и API таблицы (window.__measure). */
const S = () => window.__lookup;
const M = () => window.__measure;
const stage = document.querySelector(".stage");

const MIN_STEP = 8;          // каждая следующая поза глубже предыдущей минимум на столько градусов
const STILL_MS = 1500;       // сколько нужно быть неподвижным
const STILL_SPREAD = 2.5;    // допустимый разброс за это время, °
const COUNTDOWN = 3;
const POSE_TIMEOUT_MS = 60000;
const RESET_TIMEOUT_MS = 15000;

/* ---------- разметка поверх кадра ---------- */
const box = document.createElement("div");
box.className = "mGuide";
box.hidden = true;
box.setAttribute("role", "status");
box.innerHTML = `
  <div class="mgCard">
    <div class="mgStep" id="mgStep"></div>
    <div class="mgText" id="mgText"></div>
    <div class="mgBig" id="mgBig"></div>
    <div class="mgSub" id="mgSub"></div>
    <div class="mgDots" id="mgDots"></div>
    <div class="mgBtns" id="mgBtns"></div>
  </div>
  <div class="mgFlash" id="mgFlash"></div>`;
stage.appendChild(box);
const $ = (id) => document.getElementById(id);

function ui(o) {
  if ("step" in o) $("mgStep").textContent = o.step;
  if ("text" in o) $("mgText").textContent = o.text;
  if ("big" in o) $("mgBig").textContent = o.big;
  if ("sub" in o) $("mgSub").textContent = o.sub;
  if ("dots" in o) $("mgDots").innerHTML = o.dots.map((s) => `<i class="${s}"></i>`).join("");
  if ("btns" in o) $("mgBtns").innerHTML = o.btns.map(([act, label, ghost]) => `<button class="btn small${ghost ? " ghost" : ""}" data-act="${act}">${label}</button>`).join("");
}
const dotsFor = (total, cur, done) => Array.from({ length: total }, (_, k) => (done.has(k) ? "done" : k === cur ? "on" : ""));

/* ---------- звук и голос ---------- */
let actx = null;
function beep(freq, ms) {
  try {
    actx = actx || new AudioContext();
    actx.resume();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; g.gain.value = 0.12;
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + ms / 1000);
  } catch { /* звук недоступен */ }
}
function say(text) {
  if (!$("mVoice")?.checked) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ru-RU"; u.rate = 1.0;
    speechSynthesis.speak(u);
  } catch { /* голоса нет — остаётся текст и сигналы */ }
}
function flash() {
  const f = $("mgFlash");
  f.classList.add("on");
  setTimeout(() => f.classList.remove("on"), 180);
}

/* ---------- управление ---------- */
class Abort extends Error {}
let guiding = false, aborted = false, skipStep = false, dismissed = false, prevMuted = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = () => { if (aborted) throw new Abort(); };
const show = () => { box.hidden = false; };
const hide = () => { box.hidden = true; };
const range = (a) => Math.max(...a) - Math.min(...a);
const P90_10 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.1)]; };

/* Ждём, пока условие по текущему углу держится holdMs подряд. true — выполнено, false — таймаут или «Пропустить». */
async function until(cond, holdMs, timeoutMs, onTick) {
  const t0 = Date.now();
  let since = null;
  skipStep = false;
  for (;;) {
    await sleep(100); check();
    if (skipStep || Date.now() - t0 > timeoutMs) return false;
    const a = S().angleRaw;
    if (a === null || a === undefined) { since = null; ui({ big: "—", sub: "Лица не видно — вернитесь в кадр" }); continue; }
    ui({ big: Math.round(a) + "°" });
    const info = onTick ? onTick(a) : null;
    if (cond(a)) { since = since ?? Date.now(); if (Date.now() - since >= holdMs) return true; ui({ sub: info ?? "Замрите" }); }
    else { since = null; ui({ sub: info ?? "" }); }
  }
}

function textFor(step) {
  if (step.p === 0) return step.t === 0 ? ["Смотрите на метку на стене. Голова прямо", "Смотрите на метку на стене. Голова прямо. Замрите."] : ["Отведите взгляд и снова смотрите на метку", "Отведите взгляд в сторону и снова смотрите на метку. Замрите."];
  if (step.t > 0) return ["Выпрямитесь и повторите тот же наклон", "Выпрямитесь и повторите тот же наклон. Замрите."];
  return step.p === 1 ? ["Наклоните голову немного вперёд, как кивок. Спина прямая", "Наклоните голову немного вперёд. Спина прямая. Замрите."] : ["Наклонитесь ещё ниже. Спина прямая", "Ещё ниже. Замрите."];
}

async function waitStep(step, ctx, idx, total, done) {
  const [text, speech] = textFor(step);
  const head = `Шаг ${idx + 1} из ${total} · ${step.name}${step.of > 1 ? ` · повтор ${step.repeat}` : ""}`;
  const btns = [["skip", "Пропустить", true], ["cancel", "Отмена", true]];
  ui({ step: head, text, sub: "", dots: dotsFor(total, idx, done), btns });
  say(speech);

  // повтор: сначала вернуться в нейтраль (или отвести взгляд и вернуться), иначе повтор не будет независимым
  if (step.t > 0 && step.p > 0) {
    ui({ sub: "Сначала выпрямитесь" });
    if (!(await until((a) => Math.abs(a) < 4, 600, RESET_TIMEOUT_MS, () => "Сначала выпрямитесь"))) { if (skipStep) return "skip"; }
    ui({ text: "Теперь снова наклоните голову" });
  } else if (step.t > 0 && step.p === 0) {
    ui({ sub: "Отведите взгляд" });
    await until((a) => Math.abs(a) > 4, 300, 8000, () => "Отведите взгляд");
    if (skipStep) return "skip";
    ui({ text: "Снова смотрите на метку" });
    await until((a) => Math.abs(a) < 3, 600, 8000, () => "Снова на метку");
    if (skipStep) return "skip";
  }

  // поза: для позы нужен наклон глубже предыдущей позы (или почти как в первом повторе этой же позы)
  let need = null;
  if (step.p > 0) need = step.t > 0 && ctx.firstApp[step.p] != null ? ctx.firstApp[step.p] - MIN_STEP : ctx.prevPoseApp + MIN_STEP;
  const buf = [];
  const ok = await until((a) => {
    buf.push(a); if (buf.length > STILL_MS / 100) buf.shift();
    if (step.p === 0 && Math.abs(a) > 6) { buf.length = 0; return false; }
    if (need !== null && a < need) { buf.length = 0; return false; }
    return buf.length >= STILL_MS / 100 && range(buf) <= STILL_SPREAD;
  }, 0, POSE_TIMEOUT_MS, (a) => (step.p === 0 && Math.abs(a) > 6 ? "Голова прямо, взгляд на метку" : need !== null && a < need ? "Ниже ↓ — наклон пока маловат" : "Замрите"));
  return ok ? "ok" : "skip";
}

async function countdown() {
  ui({ btns: [["cancel", "Отмена", true]], text: "Помощник — приготовьтесь снимать" });
  for (let n = COUNTDOWN; n >= 1; n--) {
    ui({ big: String(n), sub: "Не двигайтесь" });
    beep(660, 120);
    await sleep(1000); check();
  }
}

async function record(seconds) {
  const vals = [];
  flash(); beep(1100, 350);
  ui({ text: "Снимаем! Не двигайтесь", sub: "Помощник: фото сейчас", btns: [["cancel", "Отмена", true]] });
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(100); check();
    const a = S().angleRaw;
    if (a !== null && a !== undefined) vals.push(a);
    ui({ big: String(Math.max(1, Math.ceil(seconds - (Date.now() - t0) / 1000))) });
  }
  beep(440, 250);
  return vals;
}

async function runGuide() {
  const s = S();
  if (guiding || !s) return;
  if (s.phase !== "monitoring" || s.angleRaw === null) {
    show();
    ui({ step: "Замер", text: "Сначала нажмите «Старт» и пройдите калибровку", big: "", sub: "", dots: [], btns: [["close", "Закрыть", true]] });
    return;
  }
  guiding = true; aborted = false;
  prevMuted = s.muted; s.muted = true;        // на время замера сирена молчит
  stage.classList.add("guiding");
  show();
  beep(660, 100); // разрешает звук (жест пользователя)
  const plan = M().getPlan();
  const settings = M().getSettings();
  const done = new Set();
  const ctx = { prevPoseApp: 0, firstApp: {} };
  let got = 0;
  try {
    const minutes = Math.max(1, Math.round(plan.length * (COUNTDOWN + settings.recSec + 4) / 60));
    ui({ step: "Замер точности", text: "Помощник — телефон с профилем на штативе, приготовьтесь", big: "", sub: `Шагов: ${plan.length} (≈ ${minutes} мин). Голос и сигналы подскажут дальше`, dots: dotsFor(plan.length, -1, done), btns: [["cancel", "Отмена", true]] });
    say("Замер начинается. Помощник, приготовьте телефон.");
    await sleep(3500); check();

    for (let k = 0; k < plan.length; k++) {
      const step = plan[k];
      for (let attempt = 0; attempt < 2; attempt++) {
        if ((await waitStep(step, ctx, k, plan.length, done)) === "skip") break;
        await countdown();
        const vals = await record(settings.recSec);
        if (vals.length < 8) { ui({ text: "Лица не видно — повторим", big: "", sub: "" }); say("Лица не видно. Повторим."); await sleep(2000); check(); continue; }
        const spr = P90_10(vals);
        if (spr > settings.maxSpread && attempt === 0) { ui({ text: "Вы двигались — повторим", big: "", sub: "" }); say("Вы двигались. Повторим."); await sleep(2200); check(); continue; }
        const app = M().median(vals);
        M().setTrial(step.p, step.t, app, spr);
        if (step.p > 0) { if (step.t === 0) ctx.firstApp[step.p] = app; ctx.prevPoseApp = ctx.firstApp[step.p] ?? app; }
        got++; done.add(k);
        ui({ text: "Записано", big: app.toFixed(1) + "°", sub: `Фото для «${step.name}»${step.of > 1 ? `, повтор ${step.repeat}` : ""} сделано?`, dots: dotsFor(plan.length, -1, done), btns: [] });
        beep(880, 150);
        await sleep(1500); check();
        break;
      }
    }

    ui({ step: "Готово", text: `Записано точек: ${got} из ${plan.length}`, big: "", sub: "Дальше: загрузите фото в таблицу ниже и отметьте на каждом козелок уха и внешний уголок глаза", dots: dotsFor(plan.length, -1, done), btns: [["photos", "К фото"], ["again", "Повторить", true], ["close", "Закрыть", true]] });
    say(`Готово. Записано точек: ${got}. Теперь загрузите фото в таблицу.`);
  } catch (e) {
    if (!(e instanceof Abort)) console.error(e);
    hide();
  } finally {
    guiding = false;
    s.muted = prevMuted;
    stage.classList.remove("guiding");
    try { speechSynthesis.cancel(); } catch { /* нет речи */ }
  }
}

/* Короткая подсказка в кадре на время одиночной записи (кнопки «Записать» в таблицах) */
async function frameNote(text, seconds) {
  if (guiding) return;
  show();
  ui({ step: "Запись", text, sub: "", dots: [], btns: [] });
  for (let n = seconds; n >= 1; n--) { ui({ big: String(n) }); beep(660, 100); await sleep(1000); }
  if (!guiding) hide();
}

/* ---------- кнопки внутри кадра ---------- */
box.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "start" || act === "again") { dismissed = true; runGuide(); }
  if (act === "later") { dismissed = true; hide(); }
  if (act === "skip") skipStep = true;
  if (act === "cancel") { aborted = true; hide(); }
  if (act === "close") { if (!guiding) hide(); }
  if (act === "photos") { hide(); $("mHead")?.scrollIntoView({ behavior: "smooth" }); }
});
$("mGuideStart")?.addEventListener("click", () => { dismissed = true; runGuide(); });

/* После калибровки сам предлагаем начать замер — прямо в кадре */
let idleShown = false;
setInterval(() => {
  const s = S();
  const ready = s && s.phase === "monitoring" && s.angleRaw !== null && s.angleRaw !== undefined;
  if (guiding) return;
  if (ready && !dismissed && !idleShown) {
    idleShown = true;
    show();
    ui({ step: "Калибровка готова", text: "Начать замер точности?", big: "", sub: "Помощник с телефоном должен быть на месте. Дальше подскажет голос", dots: [], btns: [["start", "Начать замер"], ["later", "Позже", true]] });
  }
  if (!ready) { idleShown = false; dismissed = false; if (!box.hidden && !s?.source) hide(); }
}, 400);

window.__frameNote = frameNote;
