import { FaceLandmarker, PoseLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";
import { figure } from "./figure.js";
import { pitchFromMatrix, yawFromMatrix, mirroredTilt, distanceFromIpd, solveTilt as solveTiltCore } from "./geometry.js";
import { buildSpine, renderSide, renderFront, sideWords } from "./spine.js";
import { newSession, tickSession, finishSession, buildReport, postureScore, fmtSpan, MIN_SCORE_SEC } from "./insights.js";

const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";
const ROOT = new URL("./", import.meta.url).href; // работает и из /mac/, и из /windows/
const PLATFORM = document.documentElement.dataset.platform === "windows" ? "windows" : "mac";

const GAUGE_MAX = 60;          // градусов на шкале
const CALIB_MIN_N = 8;         // калибровка «смотрим вдаль»: достаточно отсчётов для медианы — без фикс. задержки
const CALIB_TIMEOUT_MS = 4000; // потолок на случай, если лицо/наушники не видны стабильно
const NOD_MIN = 8;             // кивок вниз минимум на столько градусов
const NOD_TIMEOUT_MS = 6000;
const CALIB_MAX_SPREAD = 4;    // разброс значений при калибровке (P90−P10), °
const SMOOTH = 0.35;           // EMA-сглаживание
const MEDIAN_N = 5;            // медиана по 5 отсчётам перед EMA (убирает выбросы)
const HYST = 2;                // гистерезис порога головы, °: вход > порога, выход < порога − 2
const TICK_MS = 100;           // 10 кадров/сек
const FACE_LOST_MS = 1500;     // нет данных дольше — сирена выключается
const DET_FRESH_MS = 400;
const YAW_MAX = 40;            // голова повёрнута в сторону — pitch не считаем
const SLOUCH_ENTER = 0.8, SLOUCH_EXIT = 0.86;  // голова/плечи относительно калибровки
const LEAN_ENTER = 1.3, LEAN_EXIT = 1.22;      // плечи шире в кадре — наклон к экрану
const TILT_ENTER = 12, TILT_EXIT = 9;          // перекос ключиц/плеч, °
const IPD_LEAN_ENTER = 1.25, IPD_LEAN_EXIT = 1.18; // лицо крупнее — наклон к экрану (когда плеч не видно)
const SHOULDER_STALE_MS = 1500;

/* Подготовка: подсказки «придвиньте/отодвиньте», «откройте/прикройте» */
const HFOV_DEG = 63;           // типичный угол обзора веб-камеры ноутбука
const IPD_CM = 6.3;            // среднее расстояние между зрачками
const DIST_OK = [46, 76];      // 18–30 дюймов: OSHA, NIOSH ≥ 18 in, Mayo 20–30 in, CCOHS 40–74 см (см. sources.json)
const FACE_Y_OK = [0.28, 0.58];// где в кадре должно быть лицо (доля высоты)
const LUMA_MIN = 55;           // минимальная яркость кадра (0–255)
const AIM_MAX = 0.14;            // лицо смещено от центра кадра больше чем на 14 % ширины — повернуть ноутбук
const YAW_PREP_MAX = 18;       // голова повёрнута в сторону больше чем на 18° при подготовке
const PREP_HOLD_MS = 1200;
const PREP_SHOULDERS_MS = 6000;// плечи обязательны только первые секунды подготовки
const PREP_TIMEOUT_MS = 12000;

/* Наушники: локальный мост (см. bridge/) шлёт {"pitch": градусы} */
const IMU_URL = "ws://127.0.0.1:8765";
const IMU_STALE_MS = 1000;

const COLORS = { ok: "#2f7d5b", warn: "#b4791f", bad: "#b5423b", idle: "#0a0a0b" };

/* ------------------------------------------------------------------ */
/* Устройства. Пользователь вводит только высоту платформы, остальное  */
/* — типичные значения (расстояние уточняется камерой).                */
/* lid: true → угол раскрытия крышки (90° + φ), иначе наклон монитора φ */
/* ------------------------------------------------------------------ */
// Нормы: центр экрана на 15–20° ниже горизонта глаз, верх экрана на уровне глаз или ниже,
// наклон монитора назад обычно ≤ 10–20° (OSHA; CCOHS: 15°). См. sources.json.
const EYE_H = 45; // высота глаз над столом, см
const DEVICES = {
  mac: {
    laptop: { lid: true, panel: 20, bezel: 1.2, baseH: 1.5, baseD: 22, dist: 55, maxPhi: 45, label: "Крышка" },
  },
  windows: {
    laptop: { lid: true, panel: 19, bezel: 1.5, baseH: 2.0, baseD: 25, dist: 55, maxPhi: 45, label: "Крышка" },
    monitor: { lid: false, panel: 34, bezel: 2, baseH: 6, baseD: 22, dist: 65, maxPhi: 20, label: "Наклон" },
  },
};
let mode = "laptop";
try { if (PLATFORM === "windows" && DEVICES.windows[localStorage.getItem("lookup.mode")]) mode = localStorage.getItem("lookup.mode"); } catch {}
const dev = () => DEVICES[PLATFORM][mode];
let distOverride = null; // расстояние, измеренное камерой
const distNow = () => distOverride ?? dev().dist;

const st = {
  source: null,        // "cam" | "imu" | "sim" | null
  face: null,
  pose: null,
  stream: null,
  phase: "idle",       // idle | loading | prepare | calibrating | nod | monitoring
  nCam: null, nImu: null,           // нейтральные значения (после калибровки)
  signCam: 1, signImu: 1,           // +1: рост значения = наклон вниз
  signed: { cam: true, imu: true },
  angle: null,         // угол с поправкой (его видят экран и сирена)
  angleRaw: null,      // угол без поправки (нужен для замера точности)
  distRaw: null,       // расстояние до экрана по зрачкам, см, без поправки
  lidCam: null,        // угол экрана по камере (φ), без ручного значения
  usingImu: false,
  buf: [],             // окно для медианы
  lidEst: null,
  lastFrame: 0,
  lastFaceAt: 0,
  lastFrameId: null,
  det: null,           // последнее распознавание лица {pitch, yaw, lm, ipdPx, ipdN, at}
  poseSkip: 0,
  badSince: null,
  alerting: false,
  muted: false,
  startedAt: 0,
  lastSetup: null,
  prepT: 0, prepOkSince: 0, distSamples: [],
  calibCam: [], calibImu: [], calibHead: [], calibW: [], calibIpd: [],
  calibStart: 0,
  nodStart: 0,
  base: null,          // калибровка плеч {head, w}
  baseIpd: null,
  sh: null,            // сглаженные метрики плеч
  pts: null,           // сырые точки {ls, rs, nose, at} для ключиц
  shState: null,
  hy: { head: false, slouch: false, lean: false, tilt: false, ipd: false }, // гистерезис
  sessTotal: 0,
  sessSafe: 0,
  sitStart: 0,
  imu: null,           // {pitch, at}
  ws: null, imuWanted: false, retry: null,
  pip: null,
  rec: null,           // текущая записываемая сессия для AI-анализа (insights.js), null вне мониторинга
};

window.__lookup = st; // для отладки из консоли
/* Поправки, которые пользователь получил в режиме «Замер» (/measure/) */
const stored = (k) => { try { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : null; } catch { return null; } };
const corr = () => {
  try { const c = JSON.parse(localStorage.getItem("lookup.corr")); if (c && Number.isFinite(c.k) && Number.isFinite(c.b)) return c; } catch {}
  return { k: 1, b: 0 };
};
const distK = () => stored("lookup.distK") ?? 1;      // коэффициент расстояния
const lidManual = () => stored("lookup.lidManual");    // угол экрана φ, введённый вручную (по «Уровню»)
const getLimit = () => Number($("setLimit").value) || 15;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const hystHigh = (prev, v, enter, exit) => (prev ? v > exit : v > enter);
const hystLow = (prev, v, enter, exit) => (prev ? v < exit : v < enter);

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
  const vol = st.muted ? 0 : (Number($("setVol").value) / 100) * 0.5;
  const t = siren.ctx.currentTime;
  siren.gain.gain.cancelScheduledValues(t);
  siren.gain.gain.setTargetAtTime(on ? vol : 0, t, 0.03);
}

/* ------------------------------------------------------------------ */
/* Ключицы и плечи (MediaPipe Pose)                                    */
/* В Pose нет отдельных точек ключиц, поэтому линия ключиц — это       */
/* плечи + основание шеи между ними; наклон линии = перекос.           */
/* ------------------------------------------------------------------ */
function shoulderMetrics(res, now) {
  const p = res.landmarks?.[0];
  if (!p) { st.pts = null; return null; }
  const nose = p[0], ls = p[11], rs = p[12];
  if ((ls.visibility ?? 1) < 0.5 || (rs.visibility ?? 1) < 0.5) { st.pts = null; return null; }
  const w = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (w < 0.05) { st.pts = null; return null; }
  st.pts = { ls, rs, nose, at: now };
  const head = ((ls.y + rs.y) / 2 - nose.y) / w; // выше плеч = больше (идея PosturePal)
  let roll = Math.abs(Math.atan2(ls.y - rs.y, ls.x - rs.x) * 180 / Math.PI);
  if (roll > 90) roll = 180 - roll;
  const tiltS = mirroredTilt({ x: 1 - ls.x, y: ls.y }, { x: 1 - rs.x, y: rs.y }); // как в превью: + правое плечо ниже
  return { head, w, roll, tiltS, at: now };
}

function smoothShoulders(m) {
  if (!m) return;
  const o = st.sh, k = 0.3;
  st.sh = o ? {
    head: o.head + k * (m.head - o.head),
    w: o.w + k * (m.w - o.w),
    roll: o.roll + k * (m.roll - o.roll),
    tiltS: o.tiltS + k * (m.tiltS - o.tiltS),
    at: m.at,
  } : m;
}

// 'ok' | 'slouch' | 'tilt' | null (нет данных). Состояния с гистерезисом.
function shoulderState(now) {
  const s = st.sh, h = st.hy;
  if (!s || !st.base || now - s.at > SHOULDER_STALE_MS) return null;
  h.slouch = hystLow(h.slouch, s.head / st.base.head, SLOUCH_ENTER, SLOUCH_EXIT);
  h.lean = hystHigh(h.lean, s.w / st.base.w, LEAN_ENTER, LEAN_EXIT);
  h.tilt = hystHigh(h.tilt, s.roll, TILT_ENTER, TILT_EXIT);
  if (h.slouch || h.lean) return "slouch";
  if (h.tilt) return "tilt";
  return "ok";
}

/* ------------------------------------------------------------------ */
/* Кадры камеры. MediaStreamTrackProcessor отдаёт кадры и в фоновой    */
/* вкладке (у <video> в фоне кадры могут не обновляться).              */
/* ------------------------------------------------------------------ */
const frames = { reader: null, latest: null, ok: false };

function startFrameReader(track) {
  frames.ok = false;
  if (!("MediaStreamTrackProcessor" in window)) return;
  try {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    frames.reader = reader; frames.ok = true;
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          frames.latest?.close();
          frames.latest = value;
        }
      } catch { /* поток закрыт */ }
    })();
  } catch (e) { console.warn("MediaStreamTrackProcessor недоступен", e); }
}
function stopFrameReader() {
  try { frames.reader?.cancel(); } catch {}
  frames.reader = null;
  try { frames.latest?.close(); } catch {}
  frames.latest = null; frames.ok = false;
}
function grabFrame() {
  if (frames.ok && frames.latest) return { img: frames.latest, id: frames.latest.timestamp, W: frames.latest.displayWidth, H: frames.latest.displayHeight };
  const v = $("video");
  if (v.readyState >= 2) return { img: v, id: v.currentTime, W: v.videoWidth, H: v.videoHeight };
  return null;
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
  const fileset = await FilesetResolver.forVisionTasks(ROOT + "vendor/wasm");
  st.face = await createWithFallback(FaceLandmarker, fileset, ROOT + "models/face_landmarker.task",
    { numFaces: 1, outputFacialTransformationMatrixes: true });
  try {
    st.pose = await createWithFallback(PoseLandmarker, fileset, ROOT + "models/pose_landmarker_lite.task", { numPoses: 1 });
  } catch (e) {
    console.warn("Плечи недоступны", e);
    st.pose = null;
  }
}

async function startCamera() {
  stopAll();
  sirenInit(); // AudioContext можно создать только из клика
  st.startedAt = performance.now();
  setPhase("loading", "Загрузка…");
  $("btnStart").disabled = true;
  try {
    await initModels();
    st.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" }, audio: false,
    });
    const v = $("video");
    v.srcObject = st.stream;
    await v.play();
    startFrameReader(st.stream.getVideoTracks()[0]);
    st.source = "cam";
    resetSession();
    beginPrepare();
    startTicker();
    setRunning(true);
  } catch (e) {
    console.error(e);
    setPhase("idle", "Камера не запустилась");
    $("stageMsg").title = String(e.message || e);
    st.source = null;
  }
  $("btnStart").disabled = false;
}

/* Режим «только наушники»: без камеры, работает и в фоне, и в темноте. */
function startImuOnly() {
  if (!st.ws || st.ws.readyState !== 1) {
    connectPhones();
    msg("Мост не запущен — см. bridge/README");
    return;
  }
  stopAll();
  sirenInit();
  st.source = "imu";
  st.startedAt = performance.now();
  resetSession();
  document.querySelector(".stage").classList.add("noCam");
  beginCalibration();
  startTicker();
  setRunning(true);
}

function startDemo() {
  stopAll();
  sirenInit();
  st.source = "sim";
  st.startedAt = performance.now();
  resetSession();
  $("simBox").hidden = false;
  st.nCam = 0; st.signCam = 1; st.nImu = null; st.base = null; st.lidEst = null;
  finishCalibration();
  startTicker();
  setRunning(true);
}

function stopAll() {
  finalizeSession();
  stopTicker();
  stopFrameReader();
  if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
  st.stream = null;
  st.source = null;
  st.phase = "idle";
  st.pts = null; st.det = null;
  $("video").srcObject = null;
  $("simBox").hidden = true;
  $("prep").hidden = true;
  $("btnCalib").disabled = true;
  clearAlert();
  document.querySelector(".stage").className = "stage glass";
  $("angleNum").textContent = "—";
  $("liveFig").innerHTML = figure(0, COLORS.idle, getLimit());
  setChip("chipHead", "", "Голова");
  setChip("chipSh", "", "Плечи");
  setChip("chipScreen", "", "Экран");
  setStatus("idle", "Ожидание");
  setRunning(false);
  updatePip();
}

const setRunning = (on) => { $("btnStart").textContent = on ? "Стоп" : "Старт"; };

function resetSession() {
  st.sessTotal = 0; st.sessSafe = 0; st.badSince = null;
  st.sitStart = performance.now(); st.angle = null; st.angleRaw = null; st.lastFrame = 0; st.buf = [];
  st.lastFaceAt = performance.now(); st.sh = null; st.base = null; st.baseIpd = null; st.pts = null; st.det = null;
  st.hy = { head: false, slouch: false, lean: false, tilt: false, ipd: false };
  st.nCam = null; st.nImu = null;
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
/* Подготовка: подсказки по расстоянию, положению экрана, свету        */
/* ------------------------------------------------------------------ */
let lumaCanvas = null;
function frameLuma(img, W, H) {
  lumaCanvas = lumaCanvas || document.createElement("canvas");
  lumaCanvas.width = 32; lumaCanvas.height = 24;
  const c = lumaCanvas.getContext("2d", { willReadFrequently: true });
  c.drawImage(img, 0, 0, 32, 24);
  const d = c.getImageData(0, 0, 32, 24).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return s / (d.length / 4);
}

function beginPrepare() {
  st.phase = "prepare";
  st.prepT = 0; st.prepOkSince = 0; st.distSamples = [];
  $("prep").hidden = false;
  $("btnCalib").disabled = true;
  msg("Сядьте перед камерой");
}

// Иконки-подсказки (вид сбоку и сверху), рисуются поверх кадра
const ICONS = {
  tiltIn: '<svg viewBox="0 0 64 48"><circle cx="8" cy="22" r="4" fill="#fff" stroke="none"/><line x1="16" y1="40" x2="48" y2="40"/><line x1="48" y1="40" x2="43" y2="10"/><path d="M56 12 Q46 2 32 8"/><path d="M37 3 L32 8 L38 12"/></svg>',
  tiltOut: '<svg viewBox="0 0 64 48"><circle cx="8" cy="22" r="4" fill="#fff" stroke="none"/><line x1="16" y1="40" x2="42" y2="40"/><line x1="42" y1="40" x2="47" y2="10"/><path d="M28 8 Q42 2 56 12"/><path d="M50 8 L56 12 L51 17"/></svg>',
  rotL: '<svg viewBox="0 0 64 48"><g transform="rotate(-20 32 12)"><line x1="12" y1="12" x2="52" y2="12" stroke-width="5"/></g><circle cx="32" cy="40" r="5" fill="#fff" stroke="none"/><path d="M10 26 Q6 16 12 8"/><path d="M6 12 L12 8 L14 15"/></svg>',
  rotR: '<svg viewBox="0 0 64 48"><g transform="rotate(20 32 12)"><line x1="12" y1="12" x2="52" y2="12" stroke-width="5"/></g><circle cx="32" cy="40" r="5" fill="#fff" stroke="none"/><path d="M54 26 Q58 16 52 8"/><path d="M58 12 L52 8 L50 15"/></svg>',
  closer: '<svg viewBox="0 0 64 48"><line x1="12" y1="8" x2="52" y2="8" stroke-width="5"/><circle cx="32" cy="42" r="5" fill="#fff" stroke="none"/><line x1="32" y1="16" x2="32" y2="30"/><path d="M26 25 L32 31 L38 25"/></svg>',
  farther: '<svg viewBox="0 0 64 48"><line x1="12" y1="8" x2="52" y2="8" stroke-width="5"/><circle cx="32" cy="42" r="5" fill="#fff" stroke="none"/><line x1="32" y1="30" x2="32" y2="16"/><path d="M26 21 L32 15 L38 21"/></svg>',
};
function showPrepIcon(kind) {
  const el = $("prepIcon");
  if (!el) return;
  el.hidden = !kind;
  if (kind) el.innerHTML = ICONS[kind];
}

// Время подготовки считаем по тикам (dt ограничен), а не по часам: первый прогон
// моделей может на секунды заблокировать страницу, это не должно съедать таймаут.
function evalPrep(now, g, dt) {
  const d = st.det;
  st.prepT += dt * 1000;
  const items = {};
  let hint = null, icon = null;
  const say = (text, ic) => { if (!hint) { hint = text; icon = ic ?? null; } };

  const faceOk = !!d;
  items.pFace = faceOk ? ["ok", "Лицо"] : ["bad", "Нет лица"];
  if (!faceOk) say("Сядьте перед камерой");

  let distOk = false, frameOk = false, aimOk = false;
  if (d) {
    // расстояние до экрана по расстоянию между зрачками
    if (d.ipdPx && Math.abs(d.yaw) < 20) {
      st.distSamples.push(distanceFromIpd(d.ipdPx, g.W, HFOV_DEG, IPD_CM) * distK());
      if (st.distSamples.length > 30) st.distSamples.shift();
    }
    const cm = st.distSamples.length ? median(st.distSamples) : null;
    if (cm === null) items.pDist = ["", "Дистанция …"];
    else if (cm < DIST_OK[0]) { items.pDist = ["warn", `${Math.round(cm)} см · дальше`]; say("Отодвиньте экран от себя", "farther"); }
    else if (cm > DIST_OK[1]) { items.pDist = ["warn", `${Math.round(cm)} см · ближе`]; say("Придвиньте экран к себе", "closer"); }
    else { distOk = true; items.pDist = ["ok", `${Math.round(cm)} см`]; }
    if (cm === null) distOk = true; // нет оценки — не блокируем

    // положение лица по вертикали: лицо низко — камера смотрит выше лица → экран на себя; высоко → от себя
    const fy = (d.lm[10].y + d.lm[152].y) / 2;
    if (fy > FACE_Y_OK[1]) { items.pFrame = ["warn", "Кадр · на себя"]; say("Наклоните экран на себя", "tiltIn"); }
    else if (fy < FACE_Y_OK[0]) { items.pFrame = ["warn", "Кадр · от себя"]; say("Наклоните экран от себя", "tiltOut"); }
    else { frameOk = true; items.pFrame = ["ok", "Кадр"]; }

    // положение лица по горизонтали (в превью): человек слева/справа от оси камеры → повернуть ноутбук к нему
    const dx = d.fx - 0.5;
    if (dx < -AIM_MAX) { items.pAim = ["warn", "Ось · влево"]; say("Поверните ноутбук влево", "rotL"); }
    else if (dx > AIM_MAX) { items.pAim = ["warn", "Ось · вправо"]; say("Поверните ноутбук вправо", "rotR"); }
    else if (Math.abs(d.yaw) > YAW_PREP_MAX) { items.pAim = ["warn", "Смотрите прямо"]; say("Смотрите прямо на экран"); }
    else { aimOk = true; items.pAim = ["ok", "Ось"]; }
  } else {
    items.pDist = ["", "Дистанция"]; items.pFrame = ["", "Кадр"]; items.pAim = ["", "Ось"];
  }

  const shSeen = st.pts && now - st.pts.at < SHOULDER_STALE_MS;
  const shNeeded = !!st.pose && st.prepT < PREP_SHOULDERS_MS;
  if (!st.pose) items.pSh = ["", "Плечи"];
  else if (shSeen) items.pSh = ["ok", "Плечи"];
  else { items.pSh = ["warn", "Плеч не видно"]; if (d) say("Плеч не видно: отодвиньтесь или наклоните экран на себя", "tiltIn"); }

  const luma = frameLuma(g.img, g.W, g.H);
  const lightOk = luma >= LUMA_MIN;
  items.pLight = lightOk ? ["ok", "Свет"] : ["bad", "Темно"];
  if (!lightOk) say("Добавьте света");

  for (const id in items) setChip(id, items[id][0], items[id][1]);
  const ready = faceOk && distOk && frameOk && aimOk && lightOk && (shSeen || !shNeeded);
  $("stageMsg").textContent = ready ? "Отлично — держитесь так" : (hint || "…");
  setStatus("idle", $("stageMsg").textContent);
  showPrepIcon(ready ? null : icon);

  if (ready) {
    if (!st.prepOkSince) st.prepOkSince = now;
    if (now - st.prepOkSince >= PREP_HOLD_MS) endPrepare();
  } else st.prepOkSince = 0;
  if (st.prepT > PREP_TIMEOUT_MS) endPrepare();
}

function endPrepare() {
  $("prep").hidden = true;
  showPrepIcon(null);
  if (st.distSamples.length >= 5) {
    const cm = Math.round(median(st.distSamples));
    distOverride = Math.max(35, Math.min(90, cm));
    $("distNow").innerHTML = `До экрана ≈ <b>${cm} см</b> (по камере) — учтено в расчёте`;
    renderCalc();
  }
  beginCalibration();
}

/* ------------------------------------------------------------------ */
/* Калибровка: 1) смотрим вдаль  2) кивок вниз (определяет знак угла)  */
/* ------------------------------------------------------------------ */
function beginCalibration() {
  if (!st.source) return;
  st.phase = "calibrating";
  st.calibCam = []; st.calibImu = []; st.calibHead = []; st.calibW = []; st.calibIpd = [];
  st.calibStart = 0;
  st.base = null; st.baseIpd = null; st.buf = [];
  st.hy = { head: false, slouch: false, lean: false, tilt: false, ipd: false };
  $("prep").hidden = true;
  $("btnCalib").disabled = true;
  clearAlert();
  msg("Смотрите вдаль");
  try { if (st.ws?.readyState === 1) st.ws.send("calibrate"); } catch {}
}

const spread = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.1)]; };

function beginNod() {
  st.nCam = st.calibCam.length >= 5 ? median(st.calibCam) : null;
  st.nImu = st.calibImu.length >= 5 ? median(st.calibImu) : null;
  if (st.nCam === null && st.nImu === null) { beginCalibration(); return; } // данных нет — заново
  // человек двигался при калибровке — нейтраль будет неточной, повторяем
  if ((st.nCam !== null && spread(st.calibCam) > CALIB_MAX_SPREAD) || (st.nImu !== null && spread(st.calibImu) > CALIB_MAX_SPREAD)) {
    beginCalibration();
    msg("Замрите на 3 секунды");
    return;
  }
  st.base = st.calibHead.length >= 5 ? { head: median(st.calibHead), w: median(st.calibW) } : null;
  st.baseIpd = st.calibIpd.length >= 5 ? median(st.calibIpd) : null;
  st.signed = { cam: st.nCam === null, imu: st.nImu === null };
  st.phase = "nod";
  st.nodStart = 0;
  msg("Кивните вниз");
}

function finishCalibration() {
  st.phase = "monitoring";
  // AI-анализ (insights.js) пишет только для реальных источников, не для демо-режима
  st.rec = st.source !== "sim" ? newSession(Date.now(), { platform: PLATFORM }) : null;
  const setup = (performance.now() - st.startedAt) / 1000;
  st.lastSetup = setup;
  $("setupTime").innerHTML = setup.toFixed(1) + " с " +
    (setup < 30 ? '<span class="pass">✓</span>' : '<span class="fail">✗</span>');
  $("btnCalib").disabled = false;
  updateScreenAdvice();
  msg(st.nImu !== null ? "Готово · наушники" : "Готово");
}

function msg(text) {
  $("stageMsg").textContent = text;
  setStatus("idle", text);
}

/* ------------------------------------------------------------------ */
/* Главный цикл                                                        */
/* ------------------------------------------------------------------ */
function detect(g, now) {
  const res = st.face.detectForVideo(g.img, now);
  const m = res.facialTransformationMatrixes?.[0];
  const lm = res.faceLandmarks?.[0];
  if (m && lm) {
    let ipdPx = null;
    if (lm.length >= 478) ipdPx = Math.hypot((lm[468].x - lm[473].x) * g.W, (lm[468].y - lm[473].y) * g.H);
    const yaw = yawFromMatrix(m.data);
    st.det = { pitch: pitchFromMatrix(m.data), yaw, lm, ipdPx, ipdN: ipdPx ? ipdPx / g.W : null, at: now, W: g.W, H: g.H };
    // наклон головы вбок и положение лица — в зеркальных координатах, как в превью
    const headTilt = mirroredTilt({ x: 1 - lm[263].x, y: lm[263].y }, { x: 1 - lm[33].x, y: lm[33].y });
    st.det.headTilt = headTilt;
    st.det.fx = 1 - (lm[10].x + lm[152].x) / 2;
    if (ipdPx && Math.abs(yaw) < 20) { // расстояние до экрана по зрачкам (нужна поправка distK)
      const cm = distanceFromIpd(ipdPx, g.W, HFOV_DEG, IPD_CM);
      st.distRaw = st.distRaw === null ? cm : st.distRaw * 0.8 + cm * 0.2;
    }
  } else st.det = null;
  if (st.pose && (st.poseSkip++ % 2 === 0)) {
    try { smoothShoulders(shoulderMetrics(st.pose.detectForVideo(g.img, now), now)); } catch (e) { console.warn(e); }
  }
}

function tick(now) {
  if (!st.source) return;
  const dt = st.lastFrame ? Math.min(0.25, (now - st.lastFrame) / 1000) : 0;
  st.lastFrame = now;
  let cam = null, imu = null, turned = false;

  if (st.source === "sim") {
    cam = Number($("simSlider").value);
    $("simVal").textContent = cam;
  } else {
    if (st.source === "cam") {
      const g = grabFrame();
      if (g && g.id !== st.lastFrameId) {
        st.lastFrameId = g.id;
        try { detect(g, now); }
        catch (e) {
          if (frames.ok) { console.warn("VideoFrame не подошёл, перехожу на <video>", e); frames.ok = false; }
          else console.warn(e);
        }
      }
      if (st.det && now - st.det.at < DET_FRESH_MS) {
        st.lastFaceAt = now;
        if (Math.abs(st.det.yaw) > YAW_MAX) turned = true; else cam = st.det.pitch;
      }
      if (st.phase === "prepare" && g) evalPrep(now, g, dt);
    }
    if (st.imu && now - st.imu.at < IMU_STALE_MS) { imu = st.imu.pitch; st.lastFaceAt = now; }
  }

  if (cam === null && imu === null) {
    if (turned) { clearAlert(); setStatus("idle", "↔ Смотрите на экран"); }
    else if (st.phase !== "prepare" && now - st.lastFaceAt > FACE_LOST_MS) {
      clearAlert();
      setStatus("idle", st.source === "imu" ? "Нет данных с наушников" : "Лица не видно");
    }
  } else {
    handleSample({ cam, imu }, dt, now);
  }

  st.shState = st.phase === "monitoring" ? shoulderState(now) : null;
  drawOverlay(now);
  paintImuChip(now);
  updateSitTimer(now);
  updatePip();
  renderSpine(now);
  if (st.phase === "monitoring" && now - lastInsightsRender > 2000) { lastInsightsRender = now; renderInsights(); checkpointSession(); }
}
let lastInsightsRender = 0;

function handleSample({ cam, imu }, dt, now) {
  if (st.phase === "calibrating") {
    if (!st.calibStart) st.calibStart = now;
    if (cam !== null) st.calibCam.push(cam);
    if (imu !== null) st.calibImu.push(imu);
    if (st.sh && now - st.sh.at < SHOULDER_STALE_MS) { st.calibHead.push(st.sh.head); st.calibW.push(st.sh.w); }
    if (st.det?.ipdN) st.calibIpd.push(st.det.ipdN);
    // не ждём фиксированные 3 с: как только набрали достаточно отсчётов — калибруемся сразу
    const n = Math.max(st.calibCam.length, st.calibImu.length);
    if (n >= CALIB_MIN_N || now - st.calibStart >= CALIB_TIMEOUT_MS) beginNod();
    return;
  }
  if (st.phase === "nod") {
    if (!st.nodStart) st.nodStart = now;
    if (!st.signed.cam && cam !== null) {
      const dv = cam - st.nCam;
      if (Math.abs(dv) >= NOD_MIN) { st.signCam = dv > 0 ? 1 : -1; st.signed.cam = true; }
    }
    if (!st.signed.imu && imu !== null) {
      const dv = imu - st.nImu;
      if (Math.abs(dv) >= NOD_MIN) { st.signImu = dv > 0 ? 1 : -1; st.signed.imu = true; }
    }
    if (st.signed.cam && st.signed.imu) finishCalibration();
    else if (now - st.nodStart > NOD_TIMEOUT_MS) { finishCalibration(); msg("Кивок не замечен"); }
    return;
  }
  if (st.phase !== "monitoring") return;

  // Голова: наушники точнее камеры (абсолютный датчик), камера — запасной источник
  const aImu = imu !== null && st.nImu !== null ? (imu - st.nImu) * st.signImu : null;
  const aCam = cam !== null && st.nCam !== null ? (cam - st.nCam) * st.signCam : null;
  const a = aImu ?? aCam;
  st.usingImu = aImu !== null;
  if (a === null) return;
  st.buf.push(a); if (st.buf.length > MEDIAN_N) st.buf.shift();
  const m = median(st.buf);
  st.angleRaw = st.angleRaw === null ? m : st.angleRaw + SMOOTH * (m - st.angleRaw);
  const c = corr();
  st.angle = c.k * st.angleRaw + c.b; // поправка из режима «Замер»

  const limit = getLimit();
  st.hy.head = hystHigh(st.hy.head, st.angle, limit, limit - HYST);
  const headBad = st.hy.head;
  const sh = shoulderState(now);

  // «Наклон к экрану» по размеру лица — когда плеч не видно
  let lean = false;
  if (sh === null && st.baseIpd && st.det?.ipdN) {
    st.hy.ipd = hystHigh(st.hy.ipd, st.det.ipdN / st.baseIpd, IPD_LEAN_ENTER, IPD_LEAN_EXIT);
    lean = st.hy.ipd;
  }

  const bad = headBad || sh === "slouch" || sh === "tilt" || lean;
  const reason = headBad ? "↑ Голову выше!" : sh === "slouch" ? "Выпрямитесь!" : sh === "tilt" ? "↔ Ровнее плечи!" : "↔ Отодвиньтесь от экрана!";

  if (st.rec) {
    st.rec.sensor = st.usingImu ? "imu" : "cam";
    const asymDir = sh === "tilt" ? (st.sh.tiltS > 0 ? "right" : "left") : null;
    tickSession(st.rec, { dt, angle: st.angle, bad, headBad, asymDir, at: Date.now() });
  }

  st.sessTotal += dt;
  if (!bad) st.sessSafe += dt;

  updateGauge(st.angle, limit, headBad);
  setChip("chipHead", headBad ? "bad" : "ok", headBad ? "Голова · наклон" : "Голова");
  const shChip = lean ? ["bad", "Плечи · близко"] :
    { ok: ["ok", "Плечи"], slouch: ["bad", "Плечи · сутулость"], tilt: ["warn", "Плечи · перекос"] }[sh] || ["", "Плечи"];
  setChip("chipSh", shChip[0], shChip[1]);
  updateAlert(bad, reason, now);
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
/* Спидометр и живая фигурка                                           */
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
  const zones = [[0, limit, COLORS.ok], [limit, limit * 2, COLORS.warn], [limit * 2, GAUGE_MAX, COLORS.bad]];
  for (const [a, b, c] of zones) {
    svgEl("path", { d: arcPath(cx, cy, r, d(a), d(b)), stroke: c, "stroke-width": 16, fill: "none" }, g);
  }
  svgEl("line", { id: "needle", x1: cx, y1: cy, stroke: "#0a0a0b", "stroke-width": 4, "stroke-linecap": "round" }, g);
  svgEl("circle", { cx, cy, r: 7, fill: "#0a0a0b" }, g);
  for (const t of [0, limit, GAUGE_MAX]) {
    const [x, y] = polar(cx, cy, r + 18, d(t));
    svgEl("text", { x, y: y + 4, "text-anchor": "middle", fill: "#6b6b73", "font-size": 11 }, g).textContent = t + "°";
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
function updateGauge(angle, limit, headBad) {
  if (Number($("gauge").dataset.limit) !== limit) buildGauge(limit);
  setNeedle(angle);
  $("angleNum").textContent = Math.round(angle);
  const zone = !headBad ? "ok" : angle <= limit * 2 ? "warn" : "bad";
  $("liveFig").innerHTML = figure(angle, COLORS[zone], limit);
  setStatus(zone, { ok: "В норме", warn: "Наклон растёт", bad: "Опасно" }[zone]);
  document.querySelector(".stage").className = "stage glass" + (st.source === "imu" ? " noCam " : " ") + zone;
}
function setStatus(cls, text) {
  const s = $("status");
  s.className = "status " + cls;
  s.textContent = text;
}
function setPhase(phase, text) { st.phase = phase; msg(text); }

/* ------------------------------------------------------------------ */
/* Оверлей: лоб–подбородок + ключицы («V» от основания шеи к плечам)   */
/* ------------------------------------------------------------------ */
function drawOverlay(now) {
  const c = $("overlay"), v = $("video");
  const W = v.videoWidth || 640, H = v.videoHeight || 480;
  if (c.width !== W) { c.width = W; c.height = H; }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  if (st.source !== "cam") return;
  ctx.lineCap = "round";

  const lm = st.det && now - st.det.at < DET_FRESH_MS ? st.det.lm : null;
  if (lm) {
    const pt = (i) => [lm[i].x * W, lm[i].y * H];
    const pts = [pt(10), pt(1), pt(152)];
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[2]); ctx.stroke();
    ctx.fillStyle = "#fff";
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
  }

  const p = st.pts;
  if (p && now - p.at < SHOULDER_STALE_MS) {
    const ls = [p.ls.x * W, p.ls.y * H], rs = [p.rs.x * W, p.rs.y * H];
    const wPx = Math.hypot(ls[0] - rs[0], ls[1] - rs[1]);
    const notch = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2 + 0.08 * wPx]; // основание шеи
    const color = { ok: COLORS.ok, slouch: COLORS.bad, tilt: COLORS.warn }[st.shState] || "#fff";
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(...ls); ctx.lineTo(...notch); ctx.lineTo(...rs); ctx.stroke();
    ctx.setLineDash([5, 6]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(...notch); ctx.lineTo(p.nose.x * W, p.nose.y * H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    for (const [x, y] of [ls, rs, notch]) { ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); }
  }
}

/* ------------------------------------------------------------------ */
/* Наушники: приём наклона головы от локального моста                  */
/* ------------------------------------------------------------------ */
function connectPhones() {
  if (st.ws) return;
  st.imuWanted = true;
  try { localStorage.setItem("lookup.phones", "1"); } catch {}
  let ws;
  try { ws = new WebSocket(IMU_URL); } catch { st.retry = setTimeout(connectPhones, 3000); return; }
  st.ws = ws;
  let opened = false;
  ws.onopen = () => { opened = true; paintImuChip(performance.now()); };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (typeof m.pitch === "number") st.imu = { pitch: m.pitch, at: performance.now() };
    } catch { /* игнорируем мусор */ }
  };
  ws.onclose = () => {
    st.ws = null;
    paintImuChip(performance.now());
    // с https-сайта Chrome блокирует localhost, пока не разрешена «локальная сеть»
    if (!opened && !st.source && location.protocol === "https:" && !st.wsHinted) {
      st.wsHinted = true;
      msg("Мост не найден. Разрешите доступ к локальной сети или откройте localhost:8080");
    }
    if (st.imuWanted) st.retry = setTimeout(connectPhones, 2000);
  };
  ws.onerror = () => {};
  paintImuChip(performance.now());
}

function disconnectPhones() {
  st.imuWanted = false;
  try { localStorage.removeItem("lookup.phones"); } catch {}
  clearTimeout(st.retry);
  st.ws?.close();
  st.ws = null; st.imu = null;
  paintImuChip(performance.now());
}

function paintImuChip(now) {
  const live = st.imu && now - st.imu.at < IMU_STALE_MS;
  const open = st.ws && st.ws.readyState === 1;
  $("btnPhones").textContent = st.imuWanted ? "Наушники ✓" : "Наушники";
  if (!st.imuWanted) return setChip("chipImu", "", "Наушники");
  if (!open) return setChip("chipImu", "warn", "Наушники · мост?");
  if (!live) return setChip("chipImu", "warn", "Наушники · нет данных");
  if (st.phase === "monitoring" && st.nImu === null) return setChip("chipImu", "warn", "Наушники · нажмите «Заново»");
  setChip("chipImu", "ok", st.usingImu ? "Наушники · датчик" : "Наушники");
}

/* ------------------------------------------------------------------ */
/* Фоновый режим: мини-окно поверх всех окон (Document PiP, Chrome/Edge) */
/* ------------------------------------------------------------------ */
async function togglePip() {
  if (st.pip) { st.pip.close(); return; }
  if (!("documentPictureInPicture" in window)) { msg("Фоновое окно есть в Chrome и Edge"); return; }
  try {
    const w = await window.documentPictureInPicture.requestWindow({ width: 260, height: 360 });
    for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
      const c = w.document.createElement("link");
      c.rel = "stylesheet"; c.href = l.href;
      w.document.head.append(c);
    }
    w.document.documentElement.dataset.platform = PLATFORM;
    w.document.body.innerHTML = `
      <div class="bg"><i></i><i></i><i></i></div>
      <div class="pipRoot">
        <div id="pAlert" class="alertBanner" hidden></div>
        <div class="figLive" id="pFig"></div>
        <div class="big"><span id="pNum">—</span>°</div>
        <div id="pStatus" class="status">—</div>
        <div class="chips" id="pChips"></div>
        <div class="row" style="justify-content:center">
          <button id="pMute" class="btn ghost small">Тише</button>
          <button id="pStop" class="btn small">Стоп</button>
        </div>
      </div>`;
    w.document.getElementById("pMute").onclick = (e) => {
      st.muted = !st.muted;
      e.target.textContent = st.muted ? "Звук" : "Тише";
      sirenSet(st.alerting);
    };
    w.document.getElementById("pStop").onclick = () => stopAll();
    w.addEventListener("pagehide", () => { st.pip = null; $("btnPip").textContent = "Фон"; });
    st.pip = w;
    $("btnPip").textContent = "Закрыть окно";
    updatePip();
  } catch (e) {
    console.warn(e);
    msg("Не удалось открыть окно");
  }
}

function updatePip() {
  const w = st.pip;
  if (!w) return;
  try {
    const q = (id) => w.document.getElementById(id);
    const zone = st.angle === null ? "idle" : !st.hy.head ? "ok" : st.angle <= getLimit() * 2 ? "warn" : "bad";
    q("pFig").innerHTML = figure(st.angle ?? 0, COLORS[zone], getLimit());
    q("pNum").textContent = st.angle === null ? "—" : Math.round(st.angle);
    q("pAlert").hidden = !st.alerting;
    q("pAlert").textContent = $("alertBanner").textContent;
    q("pStatus").className = $("status").className;
    q("pStatus").textContent = $("status").textContent;
    q("pChips").innerHTML = ["chipHead", "chipSh", "chipImu"]
      .map((id) => `<span class="${$(id).className}">${$(id).textContent}</span>`).join("");
  } catch { st.pip = null; }
}

/* ------------------------------------------------------------------ */
/* Модель позвоночника (схема) по наклону головы и плечам              */
/* ------------------------------------------------------------------ */
let lastSpine = 0, spineSnap = null;
// индекс сутулости 0…1,5: 1 — порог «сутулость» (голова опустилась к плечам или плечи стали шире в кадре)
function slouchIndex(now) {
  const s = st.sh;
  if (!s || !st.base || now - s.at > SHOULDER_STALE_MS) return null;
  const a = (1 - s.head / st.base.head) / (1 - SLOUCH_ENTER);
  const b = (s.w / st.base.w - 1) / (LEAN_ENTER - 1);
  return Math.max(0, Math.min(1.5, Math.max(a, b)));
}
function currentSpineInput(now) {
  const on = st.phase === "monitoring";
  const si = on ? slouchIndex(now) : null;
  return {
    headFlex: on && st.angle !== null ? st.angle : 0,
    slouch: si ?? 0,
    shoulderTilt: on && st.sh && now - st.sh.at < SHOULDER_STALE_MS ? st.sh.tiltS : 0,
    headTilt: on && st.det && now - st.det.at < DET_FRESH_MS ? st.det.headTilt ?? 0 : 0,
    shoulders: si !== null,
  };
}
function renderSpine(now) {
  if (!$("spineSide") || now - lastSpine < 200) return;
  lastSpine = now;
  const inp = currentSpineInput(now);
  const cur = buildSpine(inp);
  $("spineSide").innerHTML = renderSide(cur, spineSnap ? buildSpine(spineSnap) : null);
  $("spineFront").innerHTML = renderFront(inp);
  const w = sideWords(inp.shoulderTilt, inp.headTilt);
  $("swShoulders").textContent = st.phase === "monitoring" && st.sh ? w.sh : "Плечи";
  $("swHead").textContent = st.phase === "monitoring" ? w.hd : "Голова";
  const m = cur.metrics;
  const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v)) + "°";
  $("mHeadFlex").textContent = Math.round(m.headFlex) + "°";
  $("mCerv").textContent = sgn(m.cervFlex);
  $("mThor").textContent = inp.shoulders ? sgn(m.dK) : "—";
  $("mLoad").textContent = m.loadKg.toFixed(0);
  $("spineGhostNote").textContent = spineSnap ? `Тень: запомненная поза (${Math.round(spineSnap.headFlex)}°)` : "Тень: нейтраль";
}
$("spineSnap")?.addEventListener("click", () => {
  const i = currentSpineInput(performance.now());
  spineSnap = { headFlex: i.headFlex, slouch: i.slouch };
  lastSpine = 0;
});
$("spineClear")?.addEventListener("click", () => { spineSnap = null; lastSpine = 0; });

/* ------------------------------------------------------------------ */
/* AI-анализ осанки: история сессий (insights.js) — сохранение,        */
/* завершение текущей записи и отрисовка дашборда.                     */
/* ------------------------------------------------------------------ */
const SESS_KEY = "lookup.sessions.v1";
const SESS_MAX = 400;       // старые сессии обрезаем, чтобы localStorage не разрастался
const SESS_MIN_DUR = 20;    // сек — короче не сохраняем (случайный клик «Старт»/«Стоп»)
const CURRENT_KEY = "lookup.session.current"; // «чекпойнт» незавершённой сессии — на случай краша вкладки
const loadSessions = () => { try { return JSON.parse(localStorage.getItem(SESS_KEY)) || []; } catch { return []; } };
const saveSessions = (arr) => { try { localStorage.setItem(SESS_KEY, JSON.stringify(arr.slice(-SESS_MAX))); } catch {} };

// Периодически пишем текущую (ещё не завершённую) сессию в localStorage, пока идёт мониторинг:
// если вкладка закроется без beforeunload (краш, принудительное закрытие) — прогресс не потеряется.
function checkpointSession() {
  if (!st.rec) return;
  try { localStorage.setItem(CURRENT_KEY, JSON.stringify({ session: st.rec, at: Date.now() })); } catch {}
}
function clearCheckpoint() { try { localStorage.removeItem(CURRENT_KEY); } catch {} }

// При загрузке страницы: если остался чекпойнт от сессии, которую не успели штатно завершить
// (закрыли вкладку без beforeunload, авария вкладки/браузера) — досчитываем и сохраняем её как есть.
function recoverInterruptedSession() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(CURRENT_KEY)); } catch { raw = null; }
  clearCheckpoint();
  if (!raw?.session) return;
  const rec = finishSession(raw.session, raw.at ?? Date.now());
  if (rec.dur >= SESS_MIN_DUR) {
    const arr = loadSessions();
    arr.push(rec);
    saveSessions(arr);
  }
}

function finalizeSession() {
  if (!st.rec) return;
  finishSession(st.rec, Date.now());
  if (st.rec.dur >= SESS_MIN_DUR) {
    const arr = loadSessions();
    arr.push(st.rec);
    saveSessions(arr);
  }
  clearCheckpoint();
  st.rec = null;
  renderInsights();
}

const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h} ч ${m} м`;
  if (m > 0) return `${m} м`;
  return `${s} с`;
};
const fmtWhen = (ms) => {
  const d = new Date(ms), now = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return `Сегодня, ${time}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return `Вчера, ${time}`;
  return `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}, ${time}`;
};

/* LUP AI: ответ «печатается», как у чат-бота — один раз на сессию; дальше цифры обновляются молча. */
let lupKey = null, lupBusy = false, lupTimer = null;
function lupHtml(a) {
  return `<span class="lupBadge ${a.tier}">${a.badge}</span><h4>${a.title}</h4>` + a.sections.map((s) =>
    `<h5>${s.h}</h5>` + (s.p ? s.p.map((x) => `<p>${x}</p>`).join("") : "") + (s.list ? `<ul>${s.list.map((x) => `<li>${x}</li>`).join("")}</ul>` : ""),
  ).join("");
}
function typeInto(el, html) {
  el.innerHTML = html;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, n.textContent]); n.textContent = ""; }
  let i = 0, pos = 0;
  clearInterval(lupTimer);
  lupTimer = setInterval(() => {
    for (let budget = 14; budget > 0 && i < nodes.length;) {
      const [node, full] = nodes[i];
      const take = Math.min(budget, full.length - pos);
      pos += take; budget -= take;
      node.textContent = full.slice(0, pos);
      if (pos >= full.length) { i++; pos = 0; }
    }
    if (i >= nodes.length) { clearInterval(lupTimer); lupBusy = false; }
  }, 16);
}
function renderLup(report) {
  const body = $("lupBody"), meta = $("lupMeta");
  const s = report.latest;
  const live = !!(st.rec && s && s.id === st.rec.id);
  if (!report.lup) {
    lupKey = null; lupBusy = false; clearInterval(lupTimer); clearTimeout(lupTimer);
    const dur = s ? s.dur : 0;
    if (live) {
      meta.textContent = `анализ через ${fmtSpan(MIN_SCORE_SEC - dur)}`;
      body.innerHTML = `<p class="lupWait lupThinking">LUP AI собирает данные о вашей осанке</p><div class="lupBar"><i style="width:${Math.min(100, dur / MIN_SCORE_SEC * 100)}%"></i></div>`;
    } else {
      meta.textContent = "";
      body.innerHTML = `<p class="lupWait">Последняя сессия была короче минуты. Нажмите «Старт» и посидите за ноутбуком хотя бы минуту — LUP AI разберёт вашу осанку.</p>`;
    }
    return;
  }
  meta.textContent = `${live ? "идёт мониторинг · " : ""}${fmtWhen(s.start)} · ${fmtSpan(s.dur)}`;
  const html = lupHtml(report.lup);
  if (s.id !== lupKey) { // новая сессия: «думает», потом печатает
    lupKey = s.id; lupBusy = true;
    clearInterval(lupTimer);
    body.innerHTML = `<p class="lupWait lupThinking">LUP AI анализирует вашу осанку</p>`;
    lupTimer = setTimeout(() => typeInto(body, html), 1100);
  } else if (!lupBusy) {
    body.innerHTML = html;
  }
}

function renderInsights() {
  if (!$("insightsBody")) return; // страница «Замер»: секции нет
  const live = st.rec ? [{ ...st.rec, episodes: st.rec._streak > 0 ? [...st.rec.episodes, st.rec._streak] : st.rec.episodes }] : [];
  const stored = loadSessions();
  const report = buildReport(stored.concat(live), Date.now());
  const has = report.sessionCount > 0;
  $("insightsEmpty").hidden = has;
  $("insightsBody").hidden = !has;
  if (!has) return;

  renderLup(report);

  const ring = $("iScoreRing");
  if (report.score === null) {
    $("iScore").textContent = "—";
    $("iScoreNote").textContent = "Оценка появится после минуты мониторинга.";
    ring.style.setProperty("--score", 0);
    ring.style.setProperty("--ring-color", "var(--faint)");
  } else {
    $("iScore").textContent = report.score;
    $("iScoreNote").textContent = "Доля времени в правильной позе, частота и длительность наклонов за последнюю сессию.";
    ring.style.setProperty("--score", report.score);
    ring.style.setProperty("--ring-color", report.score >= 75 ? "var(--ok)" : report.score >= 50 ? "var(--warn)" : "var(--bad)");
  }

  const t = report.today;
  $("iTime").textContent = t.dur > 0 ? fmtDur(t.dur) : "—";
  $("iGoodPct").textContent = t.dur > 0 ? Math.round(t.goodPct * 100) + " %" : "—";
  $("iBadPct").textContent = t.dur > 0 ? Math.round(t.badPct * 100) + " %" : "—";
  $("iEpisodes").textContent = t.dur > 0 ? String(t.episodes.length) : "—";
  $("iAvgEpisode").textContent = t.avgEpisode !== null ? Math.round(t.avgEpisode) + " с" : "—";

  const week = $("insightsWeek");
  week.innerHTML = "";
  for (const d of report.days) {
    const score = postureScore(d.agg);
    const color = score === null ? "var(--faint)" : score >= 75 ? "var(--ok)" : score >= 50 ? "var(--warn)" : "var(--bad)";
    const div = document.createElement("div");
    div.className = "bar";
    div.innerHTML = `<b>${score === null ? "—" : score}</b><i style="height:${score === null ? 4 : Math.max(4, score / 100 * 130)}px;background:${color}"></i><em>${d.label}</em>`;
    week.appendChild(div);
  }

  const runs = stored.slice().reverse().slice(0, 20);
  const tb = $("historyTable").querySelector("tbody");
  tb.innerHTML = "";
  for (const s of runs) {
    const good = s.dur > 0 ? Math.round((s.good / s.dur) * 100) : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmtWhen(s.start)}</td><td>${fmtDur(s.dur)}</td><td>${good} %</td><td>${s.episodes.length}</td>`;
    tb.appendChild(tr);
  }
  $("historyEmpty").hidden = runs.length > 0;
  $("historyTable").hidden = runs.length === 0;
  const w = report.weekAgg;
  $("historyWeekSummary").textContent = w.dur > 0
    ? `Последние 7 дней: ${fmtDur(w.dur)} мониторинга, ${Math.round(w.goodPct * 100)} % в норме, ${w.episodes.length} эпизодов.`
    : "";
}

/* ------------------------------------------------------------------ */
/* График нагрузки на шею: фигурки вместо подписей                     */
/* ------------------------------------------------------------------ */
function renderLoadChart() {
  const data = [[0, 5], [15, 12], [30, 18], [45, 22], [60, 27]]; // Hansraj 2014
  // Бары окрашены по той же шкале ok/warn/bad, что чипы и спидометр в «Контроле»,
  // а не отдельной серой шкалой — чтобы «безопасно / растёт / высоко» читалось сразу.
  const grads = {
    ok: ["linear-gradient(180deg,#eaf5ef,#cfe9dc)", "linear-gradient(180deg,#cfe9dc,#8fc7ac)"],
    warn: ["linear-gradient(180deg,#f6e3bd,#e0b264)"],
    bad: ["linear-gradient(180deg,#e9bdb6,#cf8377)", "linear-gradient(180deg,#cf8377,#b5423b)"],
  };
  const el = $("loadChart");
  el.innerHTML = "";
  const seen = { ok: 0, warn: 0, bad: 0 };
  data.forEach(([deg, kg]) => {
    const zone = deg <= 15 ? "ok" : deg <= 30 ? "warn" : "bad";
    const grad = grads[zone][seen[zone]++] ?? grads[zone][0];
    const d = document.createElement("div");
    d.className = "bar";
    d.innerHTML = `<b>${kg}</b><i style="height:${kg / 27 * 130}px;background:${grad}"></i>${figure(deg, COLORS[zone])}<em>${deg}°</em>`;
    el.appendChild(d);
  });
}

/* ------------------------------------------------------------------ */
/* Калькулятор: высота платформы → угол экрана                         */
/* ------------------------------------------------------------------ */
/* Экран ставится перпендикулярно линии взгляда на его центр: φ (наклон
   назад от вертикали) = угол взгляда вниз. Центр экрана зависит от φ —
   считаем итерациями. У монитора φ ограничен (maxPhi). */
function solveTilt(H) {
  const d = dev();
  return solveTiltCore({ H, eyeH: EYE_H, dist: distNow(), panel: d.panel, bezel: d.bezel, baseH: d.baseH, maxPhi: d.maxPhi });
}

function bestHeight() { // максимальная высота, при которой верх экрана не выше глаз
  let best = 0;
  for (let H = 0; H <= 80; H += 0.5) if (solveTilt(H).top <= EYE_H) best = H;
  return best;
}

const screenDeg = (phi) => Math.round(dev().lid ? 90 + phi : phi);

function renderCalc() {
  const d = dev();
  const H = Math.max(0, Number($("cH").value) || 0);
  const L = getLimit();
  const s = solveTilt(H);
  $("rLabel").textContent = d.label;
  $("rLid").textContent = screenDeg(s.phi) + "°";
  $("rAlpha").textContent = Math.round(Math.max(0, s.alpha)) + "°";
  const zone = s.alpha <= L ? "ok" : "bad";
  $("calcFig").innerHTML = figure(Math.max(0, s.alpha), COLORS[s.alpha < 0 ? "warn" : zone], L);
  const v = $("rVerdict");
  if (s.alpha < 0) { v.className = "status warn"; v.textContent = "↓ Слишком высоко"; }
  else if (s.alpha <= L) { v.className = "status ok"; v.textContent = "В норме"; }
  else { v.className = "status bad"; v.textContent = "↑ Поднимите платформу"; }
  drawCalcSvg(H, s, L);
  updateScreenAdvice();
}

/* Угол экрана по камере: если смотреть вдаль головой прямо, камера в экране
   видит лицо повёрнутым на угол наклона экрана. Оценка приблизительная. */
function updateScreenAdvice() {
  const d = dev();
  const el = $("lidNow");
  if (st.phase !== "monitoring") return;
  if (st.source === "cam" && st.nCam !== null) st.lidCam = Math.max(0, Math.min(45, -st.nCam * st.signCam));
  const manual = lidManual();
  const est = manual ?? st.lidCam;
  if (est === null || est === undefined) return;
  st.lidEst = Math.max(0, Math.min(45, est));
  const cur = screenDeg(st.lidEst);
  const need = screenDeg(solveTilt(Math.max(0, Number($("cH").value) || 0)).phi);
  const diff = need - cur;
  const ok = Math.abs(diff) < 5;
  const arrow = diff > 0 ? `экран от себя на ${diff}°` : `экран на себя на ${Math.abs(diff)}°`;
  el.innerHTML = `${manual !== null ? "Вы ввели" : "По камере"}: ${d.lid ? "крышка" : "монитор"} ≈ <b>${cur}°</b> → нужно <b>${need}°</b> ${ok ? "✓" : "— наклоните " + arrow}`;
  setChip("chipScreen", ok ? "ok" : "warn", `Экран ${cur}° → ${need}° ${ok ? "✓" : "· " + arrow}`);
}

function drawCalcSvg(H, s, L) {
  const d = dev();
  const dist = distNow();
  const W = 480, HT = 280, pad = 16;
  const xMax = dist + 32, yMax = Math.max(EYE_H, s.top) + 8;
  const k = Math.min((W - 2 * pad) / xMax, (HT - 2 * pad) / yMax);
  const X = (x) => pad + x * k, Y = (y) => HT - pad - y * k;
  const r = s.phi * Math.PI / 180;
  const lidLen = d.bezel + d.panel + 1;
  const hx = dist, hy = H + d.baseH;
  const tx = hx + lidLen * Math.sin(r), ty = hy + lidLen * Math.cos(r);
  const cxs = hx + (d.bezel + d.panel / 2) * Math.sin(r), cys = hy + (d.bezel + d.panel / 2) * Math.cos(r);
  const cone = [X(dist + 30), Y(EYE_H - (dist + 30) * Math.tan(L * Math.PI / 180))];
  const good = s.alpha <= L;
  $("calcSvg").innerHTML = `
    <line x1="${X(-4)}" y1="${Y(0)}" x2="${X(xMax)}" y2="${Y(0)}" stroke="#a1a1aa" stroke-width="3" stroke-linecap="round"/>
    <rect x="${X(dist - d.baseD)}" y="${Y(H)}" width="${(d.baseD + 2) * k}" height="${Math.max(1, H * k)}" rx="4" fill="#0a0a0b" opacity=".14"/>
    <rect x="${X(dist - d.baseD)}" y="${Y(H + d.baseH)}" width="${d.baseD * k}" height="${d.baseH * k}" rx="2" fill="#fff" stroke="#a1a1aa"/>
    <line x1="${X(hx)}" y1="${Y(hy)}" x2="${X(tx)}" y2="${Y(ty)}" stroke="#0a0a0b" stroke-width="5" stroke-linecap="round"/>
    <line x1="${X(0)}" y1="${Y(EYE_H)}" x2="${X(dist + 30)}" y2="${Y(EYE_H)}" stroke="#a1a1aa" stroke-dasharray="3 5"/>
    <line x1="${X(0)}" y1="${Y(EYE_H)}" x2="${cone[0]}" y2="${cone[1]}" stroke="#2f7d5b" stroke-dasharray="6 4" opacity=".7"/>
    <line x1="${X(0)}" y1="${Y(EYE_H)}" x2="${X(cxs)}" y2="${Y(cys)}" stroke="${good ? "#2f7d5b" : "#b5423b"}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${X(0)}" cy="${Y(EYE_H)}" r="8" fill="#0a0a0b"/>
    <text x="${X(dist - d.baseD) + 6}" y="${Y(0) - 6}" fill="#6b6b73" font-size="12">${H} см</text>`;
}

/* ------------------------------------------------------------------ */
/* Режим устройства (только Windows: ноутбук / монитор)                */
/* ------------------------------------------------------------------ */
function setupModeSwitch() {
  if (PLATFORM !== "windows") return;
  const seg = $("modeSeg");
  seg.hidden = false;
  const paint = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  seg.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    try { localStorage.setItem("lookup.mode", mode); } catch {}
    paint();
    renderCalc();
  };
  paint();
}

/* ------------------------------------------------------------------ */
/* События                                                             */
/* ------------------------------------------------------------------ */
$("btnStart").onclick = () => (st.source ? stopAll() : startCamera());
$("btnNoCam").onclick = startImuOnly;
$("btnPhones").onclick = () => (st.imuWanted ? disconnectPhones() : connectPhones());
$("btnPip").onclick = togglePip;
$("btnSkip").onclick = () => { if (st.phase === "prepare") endPrepare(); };
$("btnDemo").onclick = startDemo;
$("btnCalib").onclick = beginCalibration;
$("btnInvert").onclick = () => { st.signCam *= -1; st.signImu *= -1; st.angle = null; st.angleRaw = null; st.buf = []; updateScreenAdvice(); };
$("btnTestSiren").onclick = () => { sirenInit(); sirenSet(true); setTimeout(() => sirenSet(st.alerting), 1500); };
$("setVol").oninput = () => sirenSet(st.alerting);
$("setLimit").oninput = () => { buildGauge(getLimit()); renderCalc(); };
$("cH").oninput = () => { $("cHr").value = $("cH").value; renderCalc(); };
$("cHr").oninput = () => { $("cH").value = $("cHr").value; renderCalc(); };
$("btnBest").onclick = () => { $("cH").value = $("cHr").value = bestHeight(); renderCalc(); };
window.addEventListener("beforeunload", finalizeSession); // сохраняем текущую сессию, если вкладку просто закрыли

$("heroFig").innerHTML = figure(8, COLORS.ok);
$("liveFig").innerHTML = figure(0, COLORS.idle);
setupModeSwitch();
buildGauge(getLimit());
renderLoadChart();
renderCalc();
recoverInterruptedSession();
renderInsights();
try { if (localStorage.getItem("lookup.phones") === "1") connectPhones(); } catch {}
