/* Пошаговый замер прямо в кадре камеры: инструкция поверх видео, голос,
   обратный отсчёт, сигнал помощнику «снимаем» и автоматическая запись показаний.
   Использует состояние основного приложения (window.__lookup) и таблицу поз
   из measure.js (window.__measure). */
const S = () => window.__lookup;
const M = () => window.__measure;
const stage = document.querySelector(".stage");

const STEPS = [
  { i: 0, name: "Нейтраль", text: "Смотрите на метку на стене. Голова прямо", say: "Смотрите на метку на стене. Голова прямо. Замрите.", min: null },
  { i: 1, name: "Небольшой наклон", text: "Наклоните голову немного вперёд, как кивок. Спина прямая", say: "Наклоните голову немного вперёд. Спина прямая. Замрите.", min: 8 },
  { i: 2, name: "Средний наклон", text: "Наклонитесь ещё ниже", say: "Ещё ниже. Замрите.", min: 8 },
  { i: 3, name: "Сильный наклон", text: "Наклонитесь ещё ниже. Спина прямая", say: "Ещё ниже. Замрите.", min: 8 },
];
const STILL_MS = 1500;       // сколько нужно быть неподвижным
const STILL_SPREAD = 2.5;    // допустимый разброс за это время, °
const COUNTDOWN = 3;
const RECORD_S = 3;
const POSE_TIMEOUT_MS = 60000;

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
const dotsFor = (cur, done) => STEPS.map((_, k) => (done.has(k) ? "done" : k === cur ? "on" : ""));

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
const spread = (a) => Math.max(...a) - Math.min(...a);

async function waitPose(step, prev, cur, done) {
  const buf = [];
  const t0 = Date.now();
  skipStep = false;
  ui({ step: `Шаг ${cur + 1} из ${STEPS.length} · ${step.name}`, text: step.text, sub: "Замрите на 2 секунды — отсчёт начнётся сам", dots: dotsFor(cur, done), btns: [["skip", "Пропустить", true], ["cancel", "Отмена", true]] });
  say(step.say);
  for (;;) {
    await sleep(100); check();
    if (skipStep) return "skip";
    if (Date.now() - t0 > POSE_TIMEOUT_MS) return "skip";
    const a = S().angleRaw;
    if (a === null || a === undefined) { buf.length = 0; ui({ big: "—", sub: "Лица не видно — вернитесь в кадр" }); continue; }
    buf.push(a); if (buf.length > STILL_MS / 100) buf.shift();
    ui({ big: Math.round(a) + "°" });
    const need = step.min === null ? null : prev + step.min;
    if (step.min === null && Math.abs(a) > 6) { ui({ sub: "Голова прямо, взгляд на метку" }); buf.length = 0; continue; }
    if (need !== null && a < need) { ui({ sub: "Ниже ↓ — наклон пока маловат" }); buf.length = 0; continue; }
    if (buf.length < STILL_MS / 100 || spread(buf) > STILL_SPREAD) { ui({ sub: "Замрите" }); continue; }
    return "ok";
  }
}

async function countdown() {
  ui({ btns: [["cancel", "Отмена", true]], text: "Помощник — приготовьтесь снимать" });
  for (let n = COUNTDOWN; n >= 1; n--) {
    ui({ big: String(n), sub: "Не двигайтесь" });
    beep(660, 120);
    await sleep(1000); check();
  }
}

async function record() {
  const vals = [];
  flash(); beep(1100, 350);
  ui({ text: "Снимаем! Не двигайтесь", sub: "Помощник: фото сейчас", btns: [["cancel", "Отмена", true]] });
  const t0 = Date.now();
  while (Date.now() - t0 < RECORD_S * 1000) {
    await sleep(100); check();
    const a = S().angleRaw;
    if (a !== null && a !== undefined) vals.push(a);
    ui({ big: String(Math.max(1, Math.ceil(RECORD_S - (Date.now() - t0) / 1000))) });
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
  const done = new Set();
  let prev = 0, got = 0;
  try {
    ui({ step: "Замер точности", text: "Помощник — телефон с профилем на штативе, приготовьтесь", big: "", sub: "Голос и сигналы подскажут дальше. Смотреть на экран не нужно", dots: dotsFor(-1, done), btns: [["cancel", "Отмена", true]] });
    say("Замер начинается. Помощник, приготовьте телефон.");
    await sleep(3500); check();

    for (let k = 0; k < STEPS.length; k++) {
      const step = STEPS[k];
      for (let attempt = 0; attempt < 2; attempt++) {
        if ((await waitPose(step, prev, k, done)) === "skip") break;
        await countdown();
        const vals = await record();
        if (vals.length < 10) { ui({ text: "Лица не видно — повторим", big: "", sub: "" }); say("Лица не видно. Повторим."); await sleep(2000); check(); continue; }
        const spr = spread(vals.slice().sort((x, y) => x - y).slice(Math.floor(vals.length * 0.1), Math.ceil(vals.length * 0.9)));
        if (spr > M().MAX_SPREAD && attempt === 0) { ui({ text: "Вы двигались — повторим", big: "", sub: "" }); say("Вы двигались. Повторим."); await sleep(2200); check(); continue; }
        const app = M().median(vals);
        M().setApp(step.i, app, spr);
        prev = app; got++; done.add(k);
        ui({ text: "Записано", big: app.toFixed(1) + "°", sub: `Фото для строки «${step.name}» сделано?`, dots: dotsFor(-1, done), btns: [] });
        beep(880, 150);
        await sleep(1500); check();
        break;
      }
    }

    ui({ step: "Готово", text: `Записано точек: ${got} из ${STEPS.length}`, big: "", sub: "Дальше: загрузите фото в таблицу ниже и отметьте на каждом козелок уха и внешний уголок глаза", dots: dotsFor(-1, done), btns: [["photos", "К фото"], ["again", "Повторить", true], ["close", "Закрыть", true]] });
    say(`Готово. Записано точек: ${got}. Теперь загрузите фото в таблицу.`);
  } catch (e) {
    if (!(e instanceof Abort)) console.error(e);
    hide();
  } finally {
    guiding = false;
    s.muted = prevMuted;
    stage.classList.remove("guiding");
    try { speechSynthesis.cancel(); } catch {}
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
