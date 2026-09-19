import { FaceLandmarker, PoseLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";

const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";
const GAUGE_MAX = 60;          // градусов на шкале
const CALIB_MS = 3000;         // калибровка: смотрим вдаль
const NOD_MIN = 8;             // кивок вниз минимум на столько градусов
const NOD_TIMEOUT_MS = 6000;
const PASS_RATIO = 0.9;        // тест пройден, если >= 90% времени поза в норме
const SMOOTH = 0.35;           // EMA-сглаживание
const TICK_MS = 100;           // 10 кадров/сек
const FACE_LOST_MS = 1500;     // нет лица дольше — сирена выключается
const SLOUCH_RATIO = 0.8;      // голова опустилась к плечам (доля от калибровки)
const LEAN_RATIO = 1.3;        // плечи стали шире в кадре — наклон к экрану
const TILT_MAX = 12;           // перекос плеч, °
const SHOULDER_STALE_MS = 1500;

/* Допущения калькулятора: пользователь вводит только высоту платформы */
const EYE_H = 45;    // высота глаз над столом, см
const EYE_DIST = 55; // расстояние глаз → петля, см
const PANEL = 20;    // высота дисплея MacBook, см (Air 19 · Pro 14″ 20 · Pro 16″ 22,5)

const st = {
  source: null,        // "cam" | "sim" | null
  face: null,
  pose: null,
  stream: null,
  phase: "idle",       // idle | loading | calibrating | nod | monitoring
  neutral: 0,
  sign: 1,             // +1: рост raw pitch = наклон вниз
  angle: null,
  lidEst: null,        // оценка φ (наклон крышки от вертикали) по камере
  lastFrame: 0,
  lastFaceAt: 0,
  lastVideoTime: -1,
  poseFlip: false,
  badSince: null,
  alerting: false,
  startedAt: 0,
  lastSetup: null,
  calibSamples: [],
  calibHead: [],
  calibW: [],
  calibStart: 0,
  nodStart: 0,
  base: null,          // калибровка плеч {head, w}
  sh: null,            // текущие плечи {head, w, roll, at}
  sessTotal: 0,
  sessSafe: 0,
  sitStart: 0,
  test: null,
};

const getLimit = () => Number($("setLimit").value) || 15;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/* ------------------------------------------------------------------ */
/* Сирена (WebAudio): воет, пока плохая поза, и молчит, когда норма    */
/* ------------------------------------------------------------------ */
const siren = { ctx: null, gain: null };

function sirenInit() { // вызывать из клика пользователя
  if (siren.ctx) { siren.ctx.resume(); return; }
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 900;
  const lfo = ctx.createOscillator();      // качает частоту 550–1250 Гц
  lfo.frequency.value = 1.2;
  const depth = ctx.createGain();
  depth.gain.value = 350;
  lfo.connect(depth).connect(osc.frequency);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);
  osc.start(); lfo.start();
  siren.ctx = ctx; siren.gain = gain;
}

function sirenSet(on) {
  if (!siren.ctx) return;
  const vol = (Number($("setVol").value) / 100) * 0.5;
  const t = siren.ctx.currentTime;
  siren.gain.gain.cancelScheduledValues(t);
  siren.gain.gain.setTargetAtTime(on ? vol : 0, t, 0.03);
}

/* ------------------------------------------------------------------ */
/* Голова: pitch из матрицы позы лица (глаза/лицо)                     */
/* ------------------------------------------------------------------ */
// data — column-major 4x4; столбец 2 = направление «вперёд» лица.
// Знак уточняется кивком при калибровке, поэтому здесь он условный.
function pitchFromMatrix(data) {
  const n = Math.hypot(data[8], data[9], data[10]) || 1;
  return -Math.asin(Math.max(-1, Math.min(1, data[9] / n))) * 180 / Math.PI;
}

/* ------------------------------------------------------------------ */
/* Плечи: сутулость и перекос по MediaPipe Pose                        */
/* ------------------------------------------------------------------ */
function shoulderMetrics(res, now) {
  const p = res.landmarks?.[0];
  if (!p) return null;
  const nose = p[0], ls = p[11], rs = p[12];
  if ((ls.visibility ?? 1) < 0.5 || (rs.visibility ?? 1) < 0.5) return null;
  const w = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (w < 0.05) return null;
  const head = ((ls.y + rs.y) / 2 - nose.y) / w; // выше плеч = больше (идея PosturePal)
  let roll = Math.abs(Math.atan2(ls.y - rs.y, ls.x - rs.x) * 180 / Math.PI);
  if (roll > 90) roll = 180 - roll;
  return { head, w, roll, at: now };
}

function smoothShoulders(m) {
  if (!m) return;
  const o = st.sh && st.sh.at ? st.sh : null;
  const k = 0.3;
  st.sh = o ? {
    head: o.head + k * (m.head - o.head),
    w: o.w + k * (m.w - o.w),
    roll: o.roll + k * (m.roll - o.roll),
    at: m.at,
  } : m;
}

// 'ok' | 'slouch' | 'tilt' | null (нет данных)
function shoulderState(now) {
  const s = st.sh;
  if (!s || !st.base || now - s.at > SHOULDER_STALE_MS) return null;
  if (s.head < st.base.head * SLOUCH_RATIO || s.w > st.base.w * LEAN_RATIO) return "slouch";
  if (s.roll > TILT_MAX) return "tilt";
  return "ok";
}

/* ------------------------------------------------------------------ */
/* Датчики: камера + MediaPipe                                         */
/* ------------------------------------------------------------------ */
async function createWithFallback(Cls, fileset, model, extra) {
  const make = (delegate) => Cls.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate }, runningMode: "VIDEO", ...extra,
  });
  try { return await make("GPU"); }
  catch (e) { console.warn("GPU недоступен, CPU", e); return await make("CPU"); }
}

async function initModels() {
  if (st.face) return;
  const fileset = await FilesetResolver.forVisionTasks("./vendor/wasm");
  st.face = await createWithFallback(FaceLandmarker, fileset, "./models/face_landmarker.task",
    { numFaces: 1, outputFacialTransformationMatrixes: true });
  try {
    st.pose = await createWithFallback(PoseLandmarker, fileset, "./models/pose_landmarker_lite.task", { numPoses: 1 });
  } catch (e) {
    console.warn("Плечи недоступны", e);
    st.pose = null;
  }
}

async function startCamera() {
  stopAll();
  sirenInit(); // AudioContext можно создать только из клика
  st.startedAt = performance.now();
  setPhase("loading", "Загружаю модель и камеру…");
  $("btnStart").disabled = true;
  try {
    await initModels();
    st.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" }, audio: false,
    });
    const v = $("video");
    v.srcObject = st.stream;
    await v.play();
    st.source = "cam";
    resetSession();
    beginCalibration();
    startTicker();
    setRunning(true);
  } catch (e) {
    console.error(e);
    setPhase("idle", "Камера не запустилась: " + (e.message || e));
    st.source = null;
  }
  $("btnStart").disabled = false;
}

function startDemo() {
  stopAll();
  sirenInit();
  st.source = "sim";
  st.startedAt = performance.now();
  resetSession();
  $("simBox").hidden = false;
  st.neutral = 0; st.sign = 1; st.base = null; st.lidEst = null;
  finishCalibration();
  startTicker();
  setRunning(true);
}

function stopAll() {
  stopTicker();
  if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
  st.stream = null;
  st.source = null;
  st.test = null;
  st.phase = "idle";
  $("video").srcObject = null;
  $("simBox").hidden = true;
  $("btnCalib").disabled = true;
  $("btnTest").disabled = true;
  $("expProgress").hidden = true;
  clearAlert();
  document.querySelector(".stage").className = "stage glass";
  $("angleNum").textContent = "—";
  setChip("chipHead", "", "Голова —");
  setChip("chipSh", "", "Плечи —");
  setStatus("idle", "Ожидание");
  setRunning(false);
}

const setRunning = (on) => { $("btnStart").textContent = on ? "■ Стоп" : "▶ Старт"; };

function resetSession() {
  st.sessTotal = 0; st.sessSafe = 0; st.badSince = null;
  st.sitStart = performance.now(); st.angle = null; st.lastFrame = 0;
  st.lastFaceAt = performance.now(); st.sh = null; st.base = null;
  clearAlert();
}

/* Тикер в Web Worker: таймеры воркера не замедляются в фоновой вкладке. */
let ticker = null;
function startTicker() {
  stopTicker();
  const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${TICK_MS});`], { type: "text/javascript" }));
  ticker = new Worker(url);
  URL.revokeObjectURL(url);
  ticker.onmessage = () => tick(performance.now());
}
function stopTicker() { if (ticker) ticker.terminate(); ticker = null; }

/* ------------------------------------------------------------------ */
/* Калибровка: 1) смотрим вдаль  2) кивок вниз (определяет знак угла)  */
/* ------------------------------------------------------------------ */
function beginCalibration() {
  if (!st.source) return;
  st.phase = "calibrating";
  st.calibSamples = []; st.calibHead = []; st.calibW = [];
  st.calibStart = 0;
  st.base = null;
  $("btnCalib").disabled = true;
  clearAlert();
  msg("Сядьте прямо и смотрите вдаль");
}

function beginNod() {
  st.neutral = median(st.calibSamples);
  st.base = st.calibHead.length >= 5 ? { head: median(st.calibHead), w: median(st.calibW) } : null;
  st.phase = "nod";
  st.nodStart = 0;
  msg("Теперь кивните вниз");
}

function finishCalibration() {
  st.phase = "monitoring";
  const setup = (performance.now() - st.startedAt) / 1000;
  st.lastSetup = setup;
  $("setupTime").innerHTML = setup.toFixed(1) + " с " +
    (setup < 30 ? '<span class="pass">✓</span>' : '<span class="fail">✗</span>');
  $("btnCalib").disabled = false;
  $("btnTest").disabled = false;
  $("expHint").textContent = st.source === "sim" ? "Демо: результаты не сохраняются." : "Готово. Работайте как обычно.";
  updateLidEstimate();
  msg("Готово");
}

function msg(text) {
  $("stageMsg").textContent = text;
  setStatus("idle", text);
}

/* ------------------------------------------------------------------ */
/* Главный цикл                                                        */
/* ------------------------------------------------------------------ */
let poseSkip = 0;
function tick(now) {
  if (!st.source) return;
  let raw = null, landmarks = null;

  if (st.source === "sim") {
    raw = Number($("simSlider").value);
    $("simVal").textContent = raw;
  } else {
    const v = $("video");
    if (v.readyState >= 2 && v.currentTime !== st.lastVideoTime) {
      st.lastVideoTime = v.currentTime;
      const res = st.face.detectForVideo(v, now);
      const m = res.facialTransformationMatrixes?.[0];
      if (m) {
        raw = pitchFromMatrix(m.data);
        landmarks = res.faceLandmarks?.[0];
      }
      if (st.pose && (poseSkip++ % 2 === 0)) {
        try { smoothShoulders(shoulderMetrics(st.pose.detectForVideo(v, now), now)); } catch (e) { console.warn(e); }
      }
    }
  }

  const dt = st.lastFrame ? Math.min(0.25, (now - st.lastFrame) / 1000) : 0;
  st.lastFrame = now;

  if (raw !== null) {
    st.lastFaceAt = now;
    handleSample(raw, dt, now);
  } else if (st.source === "cam" && now - st.lastFaceAt > FACE_LOST_MS) {
    clearAlert();
    setStatus("idle", "Лица не видно");
  }
  drawOverlay(landmarks);
  updateSitTimer(now);
}

function handleSample(raw, dt, now) {
  if (st.phase === "calibrating") {
    if (!st.calibStart) st.calibStart = now;
    st.calibSamples.push(raw);
    if (st.sh && now - st.sh.at < SHOULDER_STALE_MS) { st.calibHead.push(st.sh.head); st.calibW.push(st.sh.w); }
    if (now - st.calibStart >= CALIB_MS) beginNod();
    return;
  }
  if (st.phase === "nod") {
    if (!st.nodStart) st.nodStart = now;
    const dev = raw - st.neutral;
    if (Math.abs(dev) >= NOD_MIN) {
      st.sign = dev > 0 ? 1 : -1; // кивок вниз = «плюс»
      finishCalibration();
    } else if (now - st.nodStart > NOD_TIMEOUT_MS) {
      finishCalibration(); // знак остаётся прежним
      msg("Кивок не замечен — знак по умолчанию");
    }
    return;
  }
  if (st.phase !== "monitoring") return;

  const a = (raw - st.neutral) * st.sign;
  st.angle = st.angle === null ? a : st.angle + SMOOTH * (a - st.angle);

  const limit = getLimit();
  const headBad = st.angle > limit;
  const sh = shoulderState(now);
  const bad = headBad || sh === "slouch" || sh === "tilt";
  const reason = headBad ? "Поднимите голову!" : sh === "slouch" ? "Выпрямите спину!" : "Выровняйте плечи!";

  st.sessTotal += dt;
  if (!bad) st.sessSafe += dt;

  updateGauge(st.angle, limit);
  setChip("chipHead", headBad ? "bad" : "ok", headBad ? "Голова: наклон" : "Голова: ок");
  const shText = { ok: ["ok", "Плечи: ок"], slouch: ["bad", "Плечи: сутулость"], tilt: ["warn", "Плечи: перекос"] }[sh] || ["", "Плечи —"];
  setChip("chipSh", shText[0], shText[1]);
  updateAlert(bad, reason, now);
  updateTest(bad, st.angle, dt);
  $("sessSafe").textContent = st.sessTotal > 1 ? Math.round(100 * st.sessSafe / st.sessTotal) + " %" : "—";
}

/* ------------------------------------------------------------------ */
/* Сигнал: после задержки сирена воет, пока поза плохая                */
/* ------------------------------------------------------------------ */
function updateAlert(bad, reason, now) {
  const delay = (Number($("setDelay").value) || 0) * 1000;
  if (bad) {
    if (st.badSince === null) st.badSince = now;
    if (now - st.badSince >= delay) {
      $("alertBanner").textContent = reason;
      if (!st.alerting) { st.alerting = true; $("alertBanner").hidden = false; sirenSet(true); }
    }
  } else {
    clearAlert();
  }
}

function clearAlert() {
  st.badSince = null;
  st.alerting = false;
  $("alertBanner").hidden = true;
  sirenSet(false);
}

function updateSitTimer(now) {
  const s = Math.floor((now - st.sitStart) / 1000);
  $("sitTime").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function setChip(id, cls, text) {
  const c = $(id);
  c.className = "chip" + (cls ? " " + cls : "");
  c.textContent = text;
}

/* ------------------------------------------------------------------ */
/* Спидометр                                                           */
/* ------------------------------------------------------------------ */
function polar(cx, cy, r, deg) { // deg: 0 = слева, 180 = справа
  const a = Math.PI - (deg * Math.PI / 180);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}
function arcPath(cx, cy, r, d0, d1) {
  const [x0, y0] = polar(cx, cy, r, d0), [x1, y1] = polar(cx, cy, r, d1);
  return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
}
function svgEl(name, attrs, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent.appendChild(e);
  return e;
}
function buildGauge(limit) {
  const g = $("gauge");
  g.innerHTML = "";
  const cx = 120, cy = 128, r = 92;
  const d = (deg) => Math.min(180, deg / GAUGE_MAX * 180);
  const zones = [[0, limit, "#1fb86a"], [limit, limit * 2, "#f5a524"], [limit * 2, GAUGE_MAX, "#f0483e"]];
  for (const [a, b, c] of zones) {
    svgEl("path", { d: arcPath(cx, cy, r, d(a), d(b)), stroke: c, "stroke-width": 16, fill: "none", "stroke-linecap": "butt" }, g);
  }
  svgEl("line", { id: "needle", x1: cx, y1: cy, stroke: "#12203f", "stroke-width": 4, "stroke-linecap": "round" }, g);
  svgEl("circle", { cx, cy, r: 7, fill: "#12203f" }, g);
  for (const t of [0, limit, GAUGE_MAX]) {
    const [x, y] = polar(cx, cy, r + 18, d(t));
    svgEl("text", { x, y: y + 4, "text-anchor": "middle", fill: "#5a6a90", "font-size": 11 }, g).textContent = t + "°";
  }
  g.dataset.limit = limit;
  setNeedle(0);
}
function setNeedle(angle) {
  const n = $("needle");
  if (!n) return;
  const deg = Math.max(0, Math.min(GAUGE_MAX, angle)) / GAUGE_MAX * 180;
  const [x, y] = polar(120, 128, 82, deg);
  n.setAttribute("x2", x); n.setAttribute("y2", y);
}
function updateGauge(angle, limit) {
  if (Number($("gauge").dataset.limit) !== limit) buildGauge(limit);
  setNeedle(angle);
  $("angleNum").textContent = Math.round(angle);
  const zone = angle <= limit ? "ok" : angle <= limit * 2 ? "warn" : "bad";
  setStatus(zone, { ok: "Безопасный наклон", warn: "Наклон растёт", bad: "Опасный наклон" }[zone]);
  document.querySelector(".stage").className = "stage glass " + zone;
}
function setStatus(cls, text) {
  const s = $("status");
  s.className = "status " + cls;
  s.textContent = text;
}
function setPhase(phase, text) { st.phase = phase; msg(text); }

/* ------------------------------------------------------------------ */
/* Оверлей: линия «лоб — подбородок»                                   */
/* ------------------------------------------------------------------ */
function drawOverlay(lm) {
  const c = $("overlay"), v = $("video");
  const w = v.videoWidth || 640, h = v.videoHeight || 480;
  if (c.width !== w) { c.width = w; c.height = h; }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  const pt = (i) => [lm[i].x * w, lm[i].y * h];
  const pts = [pt(10), pt(1), pt(152)];
  ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[2]); ctx.stroke();
  ctx.fillStyle = "#fff";
  for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); }
}

/* ------------------------------------------------------------------ */
/* Тест «с / без»                                                      */
/* ------------------------------------------------------------------ */
const RUNS_KEY = "lookup.runs.v2";
const loadRuns = () => { try { return JSON.parse(localStorage.getItem(RUNS_KEY)) || []; } catch { return []; } };
const saveRuns = (r) => { try { localStorage.setItem(RUNS_KEY, JSON.stringify(r)); } catch {} };

function startTest() {
  if (st.phase !== "monitoring" || st.test) return;
  st.test = { dur: Number($("expDur").value), t: 0, safe: 0, sum: 0, max: 0, mode: $("expMode").value, limit: getLimit() };
  $("btnTest").disabled = true;
  $("expProgress").hidden = false;
  $("expHint").textContent = "Идёт тест — работайте как обычно…";
}

function updateTest(bad, angle, dt) {
  const t = st.test;
  if (!t) return;
  t.t += dt;
  if (!bad) t.safe += dt;
  t.sum += angle * dt;
  t.max = Math.max(t.max, angle);
  $("expBar").style.width = Math.min(100, 100 * t.t / t.dur) + "%";
  if (t.t >= t.dur) finishTest();
}

function finishTest() {
  const t = st.test; st.test = null;
  $("btnTest").disabled = false;
  $("expProgress").hidden = true;
  const run = {
    ts: Date.now(), mode: t.mode, dur: t.dur, limit: t.limit,
    safeRatio: t.safe / t.t, mean: t.sum / t.t, max: t.max, setup: st.lastSetup,
  };
  if (st.source === "cam") {
    const runs = loadRuns(); runs.push(run); saveRuns(runs);
    $("expHint").textContent = "Тест сохранён.";
  } else {
    $("expHint").textContent = `Демо: ${Math.round(run.safeRatio * 100)} % в норме (не сохранено).`;
  }
  renderRuns();
}

function renderRuns() {
  const runs = loadRuns();
  const tb = $("runsTable").querySelector("tbody");
  tb.innerHTML = "";
  for (const r of runs.slice().reverse()) {
    const ok = r.safeRatio >= PASS_RATIO;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.mode === "with" ? "С LookUp" : "Без"}</td>
      <td>${Math.round(r.safeRatio * 100)} %</td><td>${r.mean.toFixed(1)}°</td><td>${r.max.toFixed(0)}°</td>
      <td class="${ok ? "pass" : "fail"}">${ok ? "✓" : "✗"}</td>`;
    tb.appendChild(tr);
  }
  const avg = (mode) => {
    const xs = runs.filter((r) => r.mode === mode).map((r) => r.safeRatio);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const a = avg("without"), b = avg("with");
  const chart = $("cmpChart");
  chart.innerHTML = "";
  for (const [label, v, color] of [["Без", a, "linear-gradient(180deg,#ff8a80,#f0483e)"], ["С LookUp", b, "linear-gradient(180deg,#5ee0a0,#1fb86a)"]]) {
    const d = document.createElement("div");
    d.className = "bar";
    d.innerHTML = `<b>${v === null ? "—" : Math.round(v * 100) + " %"}</b><i style="height:${v === null ? 0 : v * 150}px;background:${color}"></i><em>${label}</em>`;
    chart.appendChild(d);
  }
  $("cmpText").textContent = a !== null && b !== null
    ? `С LookUp время в норме ${b >= a ? "выросло" : "снизилось"} на ${Math.abs(Math.round((b - a) * 100))} п.п.`
    : "Сделайте по одному тесту в каждом условии.";
}

function downloadCsv() {
  const rows = [["timestamp", "condition", "duration_s", "limit_deg", "ok_ratio", "mean_deg", "max_deg", "setup_s"]];
  for (const r of loadRuns()) {
    rows.push([new Date(r.ts).toISOString(), r.mode, r.dur, r.limit, r.safeRatio.toFixed(3), r.mean.toFixed(2), r.max.toFixed(1), r.setup?.toFixed(1) ?? ""]);
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }));
  a.download = "lookup_runs.csv"; a.click();
  URL.revokeObjectURL(a.href);
}

/* ------------------------------------------------------------------ */
/* График нагрузки на шею                                              */
/* ------------------------------------------------------------------ */
function renderLoadChart() {
  const data = [[0, 5], [15, 12], [30, 18], [45, 22], [60, 27]]; // Hansen 2014
  const el = $("loadChart");
  el.innerHTML = "";
  for (const [deg, kg] of data) {
    const color = deg <= 15 ? "linear-gradient(180deg,#5ee0a0,#1fb86a)" : deg <= 30 ? "linear-gradient(180deg,#ffd166,#f5a524)" : "linear-gradient(180deg,#ff8a80,#f0483e)";
    const d = document.createElement("div");
    d.className = "bar";
    d.innerHTML = `<b>${kg}</b><i style="height:${kg / 27 * 150}px;background:${color}"></i><em>${deg}°</em>`;
    el.appendChild(d);
  }
}

/* ------------------------------------------------------------------ */
/* Калькулятор: высота платформы → угол крышки                         */
/* ------------------------------------------------------------------ */
const BEZEL = 1.2;   // рамка под дисплеем, см
const BASE_H = 1.5;  // высота корпуса над платформой у петли, см
const BASE_D = 22;   // глубина корпуса (для схемы), см

/* Экран ставится перпендикулярно линии взгляда на его центр: φ (наклон крышки
   от вертикали) = угол взгляда вниз. Центр экрана зависит от φ — считаем
   итерациями. */
function solveTilt(H) {
  const off = BEZEL + PANEL / 2;
  let phi = 0, alpha = 0;
  for (let i = 0; i < 30; i++) {
    const r = phi * Math.PI / 180;
    const cy = H + BASE_H + off * Math.cos(r);
    const dc = EYE_DIST + off * Math.sin(r);
    alpha = Math.atan2(EYE_H - cy, dc) * 180 / Math.PI; // >0: смотрим вниз
    phi = Math.max(0, Math.min(45, alpha));
  }
  const r = phi * Math.PI / 180;
  return { phi, alpha, top: H + BASE_H + (BEZEL + PANEL) * Math.cos(r) };
}

function bestHeight() { // максимальная высота, при которой верх экрана не выше глаз
  let best = 0;
  for (let H = 0; H <= 80; H += 0.5) if (solveTilt(H).top <= EYE_H) best = H;
  return best;
}

function renderCalc() {
  const H = Math.max(0, Number($("cH").value) || 0);
  const L = getLimit();
  const s = solveTilt(H);
  $("rLid").textContent = Math.round(90 + s.phi) + "°";
  $("rAlpha").textContent = Math.round(Math.max(0, s.alpha)) + "°";
  const v = $("rVerdict");
  if (s.alpha < 0) { v.className = "status warn"; v.textContent = "Слишком высоко"; }
  else if (s.alpha <= L) { v.className = "status ok"; v.textContent = "В норме"; }
  else { v.className = "status bad"; v.textContent = "Слишком низко"; }
  drawCalcSvg(H, s, L);
  updateLidEstimate();
}

/* Угол крышки по камере: если человек смотрит вдаль головой прямо, то камера в
   крышке видит лицо повёрнутым на угол наклона крышки. Оценка приблизительная. */
function updateLidEstimate() {
  const el = $("lidNow");
  if (st.source !== "cam" || st.phase !== "monitoring") return;
  st.lidEst = Math.max(0, Math.min(45, -st.neutral * st.sign));
  const now = Math.round(90 + st.lidEst);
  const need = Math.round(90 + solveTilt(Math.max(0, Number($("cH").value) || 0)).phi);
  const diff = need - now;
  el.innerHTML = `По камере крышка ≈ <b>${now}°</b>, нужно <b>${need}°</b>` +
    (Math.abs(diff) >= 5 ? ` — ${diff > 0 ? "откройте" : "прикройте"} на ${Math.abs(diff)}°` : " ✓");
}

function drawCalcSvg(H, s, L) {
  const W = 480, HT = 280, pad = 16;
  const xMax = EYE_DIST + 32, yMax = Math.max(EYE_H, s.top) + 8;
  const k = Math.min((W - 2 * pad) / xMax, (HT - 2 * pad) / yMax);
  const X = (x) => pad + x * k, Y = (y) => HT - pad - y * k;
  const r = s.phi * Math.PI / 180;
  const lidLen = BEZEL + PANEL + 1;
  const hx = EYE_DIST, hy = H + BASE_H;
  const tx = hx + lidLen * Math.sin(r), ty = hy + lidLen * Math.cos(r);
  const cxs = hx + (BEZEL + PANEL / 2) * Math.sin(r), cys = hy + (BEZEL + PANEL / 2) * Math.cos(r);
  const cone = [X(EYE_DIST + 30), Y(EYE_H - (EYE_DIST + 30) * Math.tan(L * Math.PI / 180))];
  const good = s.alpha <= L;
  $("calcSvg").innerHTML = `
    <line x1="${X(-4)}" y1="${Y(0)}" x2="${X(xMax)}" y2="${Y(0)}" stroke="#7c8bb3" stroke-width="3" stroke-linecap="round"/>
    <rect x="${X(EYE_DIST - BASE_D)}" y="${Y(H)}" width="${(BASE_D + 2) * k}" height="${Math.max(1, H * k)}" rx="4" fill="#7c8bb3" opacity=".45"/>
    <rect x="${X(EYE_DIST - BASE_D)}" y="${Y(H + BASE_H)}" width="${BASE_D * k}" height="${BASE_H * k}" rx="2" fill="#fff" stroke="#9aa8cc"/>
    <line x1="${X(hx)}" y1="${Y(hy)}" x2="${X(tx)}" y2="${Y(ty)}" stroke="#12203f" stroke-width="5" stroke-linecap="round"/>
    <line x1="${X(0)}" y1="${Y(EYE_H)}" x2="${X(EYE_DIST + 30)}" y2="${Y(EYE_H)}" stroke="#9aa8cc" stroke-dasharray="3 5"/>
    <line x1="${X(0)}" y1="${Y(EYE_H)}" x2="${cone[0]}" y2="${cone[1]}" stroke="#1fb86a" stroke-dasharray="6 4" opacity=".7"/>
    <line x1="${X(0)}" y1="${Y(EYE_H)}" x2="${X(cxs)}" y2="${Y(cys)}" stroke="${good ? "#1fb86a" : "#f0483e"}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${X(0)}" cy="${Y(EYE_H)}" r="8" fill="#12203f"/>
    <text x="${X(EYE_DIST - BASE_D) + 6}" y="${Y(0) - 6}" fill="#5a6a90" font-size="12">${H} см</text>`;
}

/* ------------------------------------------------------------------ */
/* События                                                             */
/* ------------------------------------------------------------------ */
$("btnStart").onclick = () => (st.source ? stopAll() : startCamera());
$("btnDemo").onclick = startDemo;
$("btnCalib").onclick = beginCalibration;
$("btnInvert").onclick = () => { st.sign *= -1; st.angle = null; updateLidEstimate(); };
$("btnTest").onclick = startTest;
$("btnCsv").onclick = downloadCsv;
$("btnClear").onclick = () => { if (confirm("Удалить все сохранённые запуски?")) { saveRuns([]); renderRuns(); } };
$("btnTestSiren").onclick = () => { sirenInit(); sirenSet(true); setTimeout(() => sirenSet(st.alerting), 1500); };
$("setVol").oninput = () => sirenSet(st.alerting);
$("setLimit").oninput = () => { buildGauge(getLimit()); renderCalc(); };
$("cH").oninput = () => { $("cHr").value = $("cH").value; renderCalc(); };
$("cHr").oninput = () => { $("cH").value = $("cHr").value; renderCalc(); };
$("btnBest").onclick = () => { $("cH").value = $("cHr").value = bestHeight(); renderCalc(); };

buildGauge(getLimit());
renderLoadChart();
renderCalc();
renderRuns();
