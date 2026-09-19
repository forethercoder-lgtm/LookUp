import { FaceLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";

const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";
const GAUGE_MAX = 60;          // градусов на шкале
const CALIB_MS = 3000;         // длительность калибровки
const PASS_RATIO = 0.9;        // тест пройден, если >= 90% времени угол <= порога
const SMOOTH = 0.35;           // EMA-сглаживание угла
const TICK_MS = 100;           // 10 кадров/сек хватает для позы головы
const FACE_LOST_MS = 1500;     // нет лица дольше — сирена выключается

const st = {
  source: null,        // "cam" | "sim" | null
  landmarker: null,
  stream: null,
  phase: "idle",       // idle | loading | calibrating | monitoring
  neutral: 0,
  sign: 1,
  angle: null,         // угол относительно калибровки
  lastFrame: 0,
  lastFaceAt: 0,
  lastVideoTime: -1,
  badSince: null,
  alerting: false,
  startedAt: 0,        // для таймера подготовки
  lastSetup: null,
  calibSamples: [],
  calibStart: 0,
  sessTotal: 0,
  sessSafe: 0,
  sitStart: 0,
  test: null,
};

const getLimit = () => Number($("setLimit").value) || 15;

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
  const lfo = ctx.createOscillator();      // качает частоту 550–1250 Гц, ~1,2 раза в сек
  lfo.frequency.value = 1.2;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 350;
  lfo.connect(lfoDepth).connect(osc.frequency);
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
/* Геометрия: pitch головы из матрицы трансформации MediaPipe          */
/* ------------------------------------------------------------------ */
// data — column-major 4x4. Столбец 2 = ось Z лица (направление «вперёд»).
// Положительный pitch = голова наклонена вниз.
function pitchFromMatrix(data) {
  const zx = data[8], zy = data[9], zz = data[10];
  const n = Math.hypot(zx, zy, zz) || 1;
  return -Math.asin(Math.max(-1, Math.min(1, zy / n))) * 180 / Math.PI;
}

/* ------------------------------------------------------------------ */
/* Датчик: камера + MediaPipe                                          */
/* ------------------------------------------------------------------ */
async function initLandmarker() {
  if (st.landmarker) return;
  const fileset = await FilesetResolver.forVisionTasks("./vendor/wasm");
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: "./models/face_landmarker.task", delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
  });
  try {
    st.landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch (e) {
    console.warn("GPU недоступен, переключаюсь на CPU", e);
    st.landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU"));
  }
}

async function startCamera() {
  stopAll();
  sirenInit(); // AudioContext можно создать только из клика
  st.startedAt = performance.now();
  setPhase("loading", "Загружаю модель и камеру…");
  $("btnStart").disabled = true;
  try {
    await initLandmarker();
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
    setPhase("idle", "Не удалось запустить камеру: " + (e.message || e) + ". Можно включить «Демо без камеры».");
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
  st.neutral = 0;
  st.sign = 1;
  finishCalibration(0);
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
  document.querySelector(".stage").className = "stage";
  $("angleNum").textContent = "—";
  setStatus("idle", "Ожидание");
  setRunning(false);
}

function setRunning(on) {
  $("btnStart").textContent = on ? "■ Стоп" : "▶ Старт";
}

function resetSession() {
  st.sessTotal = 0; st.sessSafe = 0; st.badSince = null;
  st.sitStart = performance.now(); st.angle = null; st.lastFrame = 0;
  st.lastFaceAt = performance.now();
  clearAlert();
}

/* Тикер в Web Worker: таймеры воркера браузер не замедляет в фоновой вкладке,
   в отличие от requestAnimationFrame. */
let ticker = null;
function startTicker() {
  stopTicker();
  const src = `setInterval(() => postMessage(0), ${TICK_MS});`;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  ticker = new Worker(url);
  URL.revokeObjectURL(url);
  ticker.onmessage = () => tick(performance.now());
}
function stopTicker() {
  if (ticker) ticker.terminate();
  ticker = null;
}

/* ------------------------------------------------------------------ */
/* Калибровка                                                          */
/* ------------------------------------------------------------------ */
function beginCalibration() {
  if (!st.source) return;
  st.phase = "calibrating";
  st.calibSamples = [];
  st.calibStart = 0;
  $("btnCalib").disabled = true;
  clearAlert();
  setStatus("idle", "Калибровка: сядьте прямо, смотрите вдаль");
  $("stageMsg").textContent = "Калибровка: смотрите прямо вдаль, не двигайтесь 3 секунды…";
}

function finishCalibration(neutral) {
  st.neutral = neutral;
  st.phase = "monitoring";
  const setup = (performance.now() - st.startedAt) / 1000;
  st.lastSetup = setup;
  $("setupTime").innerHTML = setup.toFixed(1) + " с " +
    (setup < 30 ? '<span class="pass">✓ &lt; 30</span>' : '<span class="fail">✗ ≥ 30</span>');
  $("btnCalib").disabled = false;
  $("btnTest").disabled = false;
  $("expHint").textContent = st.source === "sim"
    ? "Демо-режим: тест можно запустить, но результаты не сохраняются."
    : "Готово. Работайте как обычно и запустите тест.";
  $("stageMsg").textContent = "Наклоните голову вниз — стрелка должна расти. Если наоборот — «Инвертировать знак».";
}

/* ------------------------------------------------------------------ */
/* Главный цикл                                                        */
/* ------------------------------------------------------------------ */
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
      const res = st.landmarker.detectForVideo(v, now);
      const m = res.facialTransformationMatrixes?.[0];
      if (m) {
        raw = pitchFromMatrix(m.data);
        landmarks = res.faceLandmarks?.[0];
      }
    }
  }

  const dt = st.lastFrame ? Math.min(0.25, (now - st.lastFrame) / 1000) : 0;
  st.lastFrame = now;

  if (raw !== null) {
    st.lastFaceAt = now;
    handleSample(raw, dt, now);
  } else if (st.source === "cam") {
    if (now - st.lastFaceAt > FACE_LOST_MS) {
      clearAlert();
      setStatus("idle", "Лицо не найдено");
    }
  }
  drawOverlay(landmarks);
  updateSitTimer(now);
}

function handleSample(raw, dt, now) {
  if (st.phase === "calibrating") {
    if (!st.calibStart) st.calibStart = now;
    st.calibSamples.push(raw);
    const left = Math.max(0, CALIB_MS - (now - st.calibStart));
    setStatus("idle", `Калибровка… ${(left / 1000).toFixed(1)} с`);
    if (left === 0) {
      const s = [...st.calibSamples].sort((a, b) => a - b);
      finishCalibration(s[Math.floor(s.length / 2)]); // медиана устойчива к морганию
    }
    return;
  }
  if (st.phase !== "monitoring") return;

  const a = (raw - st.neutral) * st.sign;
  st.angle = st.angle === null ? a : st.angle + SMOOTH * (a - st.angle);

  const limit = getLimit();
  st.sessTotal += dt;
  if (st.angle <= limit) st.sessSafe += dt;

  updateGauge(st.angle, limit);
  updateAlert(st.angle, limit, now);
  updateTest(st.angle, limit, dt);
  $("sessSafe").textContent = st.sessTotal > 1 ? Math.round(100 * st.sessSafe / st.sessTotal) + " %" : "—";
}

/* ------------------------------------------------------------------ */
/* Сигнал: после задержки сирена воет, пока угол > порога              */
/* ------------------------------------------------------------------ */
function updateAlert(angle, limit, now) {
  const delay = (Number($("setDelay").value) || 0) * 1000;
  if (angle > limit) {
    if (st.badSince === null) st.badSince = now;
    if (!st.alerting && now - st.badSince >= delay) {
      st.alerting = true;
      $("alertBanner").hidden = false;
      sirenSet(true);
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
function buildGauge(limit) {
  const g = $("gauge");
  g.innerHTML = "";
  const cx = 120, cy = 128, r = 92;
  const d = (deg) => Math.min(180, deg / GAUGE_MAX * 180);
  const zones = [
    [0, limit, "var(--green)"],
    [limit, limit * 2, "var(--amber)"],
    [limit * 2, GAUGE_MAX, "var(--red)"],
  ];
  for (const [a, b, c] of zones) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", arcPath(cx, cy, r, d(a), d(b)));
    p.setAttribute("stroke", c); p.setAttribute("stroke-width", 16);
    p.setAttribute("fill", "none");
    g.appendChild(p);
  }
  const needle = document.createElementNS(SVGNS, "line");
  needle.setAttribute("id", "needle");
  needle.setAttribute("x1", cx); needle.setAttribute("y1", cy);
  needle.setAttribute("stroke", "#fff"); needle.setAttribute("stroke-width", 4);
  needle.setAttribute("stroke-linecap", "round");
  g.appendChild(needle);
  const hub = document.createElementNS(SVGNS, "circle");
  hub.setAttribute("cx", cx); hub.setAttribute("cy", cy); hub.setAttribute("r", 7); hub.setAttribute("fill", "#fff");
  g.appendChild(hub);
  for (const t of [0, limit, GAUGE_MAX]) {
    const [x, y] = polar(cx, cy, r + 18, d(t));
    const tx = document.createElementNS(SVGNS, "text");
    tx.setAttribute("x", x); tx.setAttribute("y", y + 4); tx.setAttribute("text-anchor", "middle");
    tx.setAttribute("fill", "#9fb0dd"); tx.setAttribute("font-size", 11);
    tx.textContent = t + "°";
    g.appendChild(tx);
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
  const text = { ok: "Безопасный наклон", warn: "Наклон растёт", bad: "Опасный наклон" }[zone];
  setStatus(zone, text);
  document.querySelector(".stage").className = "stage " + zone;
}
function setStatus(cls, text) {
  const s = $("status");
  s.className = "status " + cls;
  s.textContent = text;
}
function setPhase(phase, msg) {
  st.phase = phase;
  $("stageMsg").textContent = msg;
  setStatus("idle", msg);
}

/* ------------------------------------------------------------------ */
/* Оверлей: три ключевые точки лица и линия «лоб — подбородок»         */
/* ------------------------------------------------------------------ */
function drawOverlay(lm) {
  const c = $("overlay"), v = $("video");
  const w = v.videoWidth || 640, h = v.videoHeight || 480;
  if (c.width !== w) { c.width = w; c.height = h; }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  const pt = (i) => [lm[i].x * w, lm[i].y * h];
  const [fx, fy] = pt(10), [nx, ny] = pt(1), [cx, cy] = pt(152);
  ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(cx, cy); ctx.stroke();
  ctx.fillStyle = "#4c7dff";
  for (const [x, y] of [[fx, fy], [nx, ny], [cx, cy]]) {
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
  }
}

/* ------------------------------------------------------------------ */
/* Эксперимент «с / без»                                               */
/* ------------------------------------------------------------------ */
const RUNS_KEY = "lookup.runs.v1";
const loadRuns = () => { try { return JSON.parse(localStorage.getItem(RUNS_KEY)) || []; } catch { return []; } };
const saveRuns = (r) => { try { localStorage.setItem(RUNS_KEY, JSON.stringify(r)); } catch {} };

function startTest() {
  if (st.phase !== "monitoring" || st.test) return;
  st.test = { dur: Number($("expDur").value), t: 0, safe: 0, sum: 0, max: 0, mode: $("expMode").value, limit: getLimit() };
  $("btnTest").disabled = true;
  $("expProgress").hidden = false;
  $("expHint").textContent = "Идёт тест — работайте как обычно…";
}

function updateTest(angle, limit, dt) {
  const t = st.test;
  if (!t) return;
  t.t += dt;
  if (angle <= limit) t.safe += dt;
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
    $("expHint").textContent = "Тест завершён и сохранён.";
  } else {
    $("expHint").textContent = `Демо-тест: ${Math.round(run.safeRatio * 100)} % в безопасной зоне (не сохранён).`;
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
  for (const [label, v, color] of [["Без", a, "var(--red)"], ["С LookUp", b, "var(--green)"]]) {
    const d = document.createElement("div");
    d.className = "bar";
    d.innerHTML = `<b>${v === null ? "—" : Math.round(v * 100) + " %"}</b><i style="height:${v === null ? 0 : v * 150}px;background:${color}"></i><em>${label}</em>`;
    chart.appendChild(d);
  }
  $("cmpText").textContent = a !== null && b !== null
    ? `С LookUp время в безопасной зоне ${b >= a ? "выросло" : "снизилось"} на ${Math.abs(Math.round((b - a) * 100))} п.п.`
    : "Сделайте по одному тесту в каждом условии, чтобы увидеть сравнение.";
}

function downloadCsv() {
  const rows = [["timestamp", "condition", "duration_s", "limit_deg", "safe_ratio", "mean_deg", "max_deg", "setup_s"]];
  for (const r of loadRuns()) {
    rows.push([new Date(r.ts).toISOString(), r.mode, r.dur, r.limit, r.safeRatio.toFixed(3), r.mean.toFixed(2), r.max.toFixed(1), r.setup?.toFixed(1) ?? ""]);
  }
  const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "lookup_runs.csv"; a.click();
  URL.revokeObjectURL(a.href);
}

/* ------------------------------------------------------------------ */
/* Раздел «Проблема»: график нагрузки                                  */
/* ------------------------------------------------------------------ */
function renderLoadChart() {
  const data = [[0, 5], [15, 12], [30, 18], [45, 22], [60, 27]]; // Hansen 2014
  const max = 27;
  const el = $("loadChart");
  el.innerHTML = "";
  for (const [deg, kg] of data) {
    const color = deg <= 15 ? "var(--green)" : deg <= 30 ? "var(--amber)" : "var(--red)";
    const d = document.createElement("div");
    d.className = "bar";
    d.innerHTML = `<b>${kg} кг</b><i style="height:${kg / max * 150}px;background:${color}"></i><em>${deg}°</em>`;
    el.appendChild(d);
  }
}

/* ------------------------------------------------------------------ */
/* Калькулятор подставки для MacBook                                   */
/* ------------------------------------------------------------------ */
// panel — высота видимой части дисплея, см (приблизительно).
const MACS = {
  air13: { panel: 19.0 },
  pro14: { panel: 20.0 },
  pro16: { panel: 22.5 },
};
const BEZEL = 1.2;   // нижняя рамка до дисплея, см
const BASE_H = 1.5;  // высота корпуса над платформой у петли, см
const BASE_D = 22;   // глубина корпуса (для схемы), см

/* Крышка раскрыта на угол φ от вертикали; оптимально экран перпендикулярен
   линии взгляда, то есть φ = угол взгляда вниз на центр экрана.
   Считаем неподвижной точкой: центр экрана зависит от φ. */
function solveTilt(H, E, d, panel) {
  const off = BEZEL + panel / 2;
  let phi = 0, alpha = 0, cy = 0, dc = 0;
  for (let i = 0; i < 30; i++) {
    const r = phi * Math.PI / 180;
    cy = H + BASE_H + off * Math.cos(r);   // высота центра экрана над столом
    dc = d + off * Math.sin(r);            // расстояние до центра экрана
    alpha = Math.atan2(E - cy, dc) * 180 / Math.PI; // >0: смотрим вниз
    phi = Math.max(0, Math.min(45, alpha));
  }
  const r = phi * Math.PI / 180;
  const top = H + BASE_H + (BEZEL + panel) * Math.cos(r);
  return { phi, alpha, cy, top };
}

function bestHeights(E, d, panel, limit) {
  let hMin = null, hOpt = 0;
  for (let H = 0; H <= 80; H += 0.5) {
    const s = solveTilt(H, E, d, panel);
    if (hMin === null && s.alpha <= limit) hMin = H;
    if (s.top <= E) hOpt = H;   // верх экрана не выше глаз
  }
  return { hMin, hOpt };
}

function renderCalc() {
  const mac = MACS[$("cMac").value];
  const H = Number($("cH").value) || 0;
  const E = Number($("cEye").value), D = Number($("cDist").value), L = getLimit();
  const s = solveTilt(H, E, D, mac.panel);
  const { hMin, hOpt } = bestHeights(E, D, mac.panel, L);

  const lid = 90 + s.phi;
  $("rLid").textContent = Math.round(lid) + "°";
  const tilt = Math.max(0, s.alpha);
  $("rAlpha").textContent = Math.round(tilt) + "°";

  const v = $("rVerdict");
  if (s.alpha < 0) {
    v.className = "status warn";
    v.textContent = "Экран выше глаз — платформа слишком высокая";
  } else if (s.alpha <= L) {
    v.className = "status ok";
    v.textContent = `Хорошо: наклон головы ≤ ${L}°`;
  } else {
    v.className = "status bad";
    v.textContent = `Мало: наклон ${Math.round(s.alpha)}° > ${L}°`;
  }
  $("rHint").innerHTML =
    `Минимальная высота для ≤ ${L}°: <b>${hMin === null ? "—" : hMin + " см"}</b>. ` +
    `Рекомендуем: <b>${hOpt} см</b> (верх экрана на уровне глаз).`;
  $("btnBest").dataset.h = hOpt;
  drawCalcSvg({ H, E, D, mac, s, L });
}

function drawCalcSvg({ H, E, D, mac, s, L }) {
  const W = 480, HT = 280, pad = 16;
  const xMax = D + 32, yMax = Math.max(E, s.top) + 8;
  const k = Math.min((W - 2 * pad) / xMax, (HT - 2 * pad) / yMax);
  const X = (x) => pad + x * k, Y = (y) => HT - pad - y * k;
  const r = s.phi * Math.PI / 180;
  const lidLen = BEZEL + mac.panel + 1;
  const hx = D, hy = H + BASE_H;                              // петля
  const tx = hx + lidLen * Math.sin(r), ty = hy + lidLen * Math.cos(r); // верх крышки
  const cxs = hx + (BEZEL + mac.panel / 2) * Math.sin(r);     // центр экрана
  const cys = hy + (BEZEL + mac.panel / 2) * Math.cos(r);
  const cone = (deg) => [X(D + 30), Y(E - (D + 30) * Math.tan(deg * Math.PI / 180))];
  const [cx1, cy1] = cone(L);
  $("calcSvg").innerHTML = `
    <line x1="${X(-4)}" y1="${Y(0)}" x2="${X(xMax)}" y2="${Y(0)}" stroke="#4a5f9a" stroke-width="3"/>
    <rect x="${X(D - BASE_D)}" y="${Y(H)}" width="${(BASE_D + 2) * k}" height="${Math.max(1, H * k)}" fill="#3a4f8a" opacity=".8"/>
    <rect x="${X(D - BASE_D)}" y="${Y(H + BASE_H)}" width="${BASE_D * k}" height="${BASE_H * k}" fill="#cfdaff"/>
    <line x1="${X(hx)}" y1="${Y(hy)}" x2="${X(tx)}" y2="${Y(ty)}" stroke="#e8eeff" stroke-width="5" stroke-linecap="round"/>
    <line x1="${X(0)}" y1="${Y(E)}" x2="${X(D + 30)}" y2="${Y(E)}" stroke="#4a5f9a" stroke-dasharray="3 5"/>
    <line x1="${X(0)}" y1="${Y(E)}" x2="${cx1}" y2="${cy1}" stroke="#2ecc71" stroke-dasharray="6 4" opacity=".8"/>
    <line x1="${X(0)}" y1="${Y(E)}" x2="${X(cxs)}" y2="${Y(cys)}" stroke="${s.alpha <= L ? "#2ecc71" : "#ff4d5e"}" stroke-width="3"/>
    <circle cx="${X(0)}" cy="${Y(E)}" r="8" fill="#e8eeff"/>
    <text x="${X(0) + 12}" y="${Y(E) - 8}" fill="#9fb0dd" font-size="11">глаз ${E} см</text>
    <text x="${X(D - BASE_D) + 4}" y="${Y(0) - 4}" fill="#cfdaff" font-size="11">платформа ${H} см</text>
    <text x="${X(D + 30) - 4}" y="${cy1 - 6}" fill="#2ecc71" font-size="11" text-anchor="end">${L}° — предел</text>`;
}

/* ------------------------------------------------------------------ */
/* Привязка событий                                                    */
/* ------------------------------------------------------------------ */
$("btnStart").onclick = () => (st.source ? stopAll() : startCamera());
$("btnDemo").onclick = startDemo;
$("btnCalib").onclick = beginCalibration;
$("btnInvert").onclick = () => { st.sign *= -1; st.angle = null; };
$("btnTest").onclick = startTest;
$("btnCsv").onclick = downloadCsv;
$("btnClear").onclick = () => { if (confirm("Удалить все сохранённые запуски?")) { saveRuns([]); renderRuns(); } };
$("btnTestSiren").onclick = () => { sirenInit(); sirenSet(true); setTimeout(() => sirenSet(st.alerting), 1500); };
$("setVol").oninput = () => sirenSet(st.alerting);
$("setLimit").oninput = () => { buildGauge(getLimit()); renderCalc(); };
$("btnExample").onclick = () => {
  $("cMac").value = "air13"; $("cEye").value = 45; $("cDist").value = 55; $("cH").value = 20;
  renderCalc();
};
$("btnBest").onclick = () => { $("cH").value = $("btnBest").dataset.h; renderCalc(); };
for (const id of ["cMac", "cH", "cEye", "cDist"]) $(id).oninput = renderCalc;

buildGauge(getLimit());
renderLoadChart();
renderCalc();
renderRuns();
