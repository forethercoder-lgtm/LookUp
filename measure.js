/* Режим «Замер»: сравниваем показания приложения с эталоном и честно оцениваем погрешность.
   Считает: ошибку (MAE, смещение), 95% границы согласия Bland–Altman с допусковым интервалом,
   повторяемость (Sw, SEM, MDC95), ICC(2,1)/(3,1) с 95% ДИ, неопределённость эталона по фото.
   Формулы и их проверка: stats.js, tests/. Основное приложение (app.js) отдаёт состояние в window.__lookup,
   поправки сохраняются в localStorage и подхватываются основным приложением. */
import { mean, median, sd, blandAltman, repeatability, icc, iccLabel } from "./stats.js";
import { lineAngle, lineAngleSigma } from "./geometry.js";

const $ = (id) => document.getElementById(id);
const S_APP = () => window.__lookup;
const KEY = "lookup.measure.v2";
const LIB_KEY = "lookup.measure.lib.v2";
const DIST_KEY = "lookup.measure.dist.v1";

const PRESETS = {
  quick: { poses: 3, repeats: 1, recSec: 3, maxSpread: 3 },
  standard: { poses: 4, repeats: 2, recSec: 3, maxSpread: 3 },
  research: { poses: 5, repeats: 3, recSec: 5, maxSpread: 2.5 },
};
const REC_MIN_SAMPLES = 8;
const SAMPLE_TARGET_N = 50; // ориентир из литературы по Bland–Altman: около 50 участников × 3 повтора

const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(d));
const sgn = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d));
const load = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* хранилище недоступно */ } };
const say = (t) => { $("mMsg").textContent = t; };
const spreadOf = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.1)]; };
const errClass = (e) => { const a = Math.abs(e); return a <= 3 ? "errGood" : a <= 6 ? "errMid" : "errBad"; };

/* ------------------------------------------------------------------ */
/* Состояние сессии                                                    */
/* ------------------------------------------------------------------ */
const blankTrial = () => ({ app: null, spread: null, marks: [], refManual: null });
const poseName = (p, n) => (p === 0 ? "Нейтраль" : n === 3 ? ["Небольшой наклон", "Средний наклон", "Сильный наклон"][p - 1] : `Наклон ${p} из ${n}`);

function newSession(preset = "standard") {
  return {
    version: 2,
    meta: { participant: "", operator: "", lighting: "", notes: "", created: new Date().toISOString() },
    settings: { preset, ...PRESETS[preset], refMethod: "photo", clickSigma: 2 },
    poses: [],
  };
}
let S = load(KEY, null) || newSession();

function reshape() { // подгоняем число поз и повторов под настройки, сохраняя введённые данные
  const n = S.settings.poses, R = S.settings.repeats;
  while (S.poses.length < n + 1) S.poses.push({ name: "", trials: [] });
  S.poses.length = n + 1;
  S.poses.forEach((p, i) => {
    p.name = poseName(i, n);
    while (p.trials.length < R) p.trials.push(blankTrial());
    p.trials.length = R;
  });
}
reshape();
const persist = () => { save(KEY, S); };

/* ------------------------------------------------------------------ */
/* Эталон и его неопределённость                                       */
/* ------------------------------------------------------------------ */
function markStats(tr) {
  const m = tr.marks || [];
  if (!m.length) return null;
  const d = m.map((x) => x.deg);
  return { deg: mean(d), sig: Math.sqrt(m.reduce((s, x) => s + x.sig * x.sig, 0)) / m.length, n: m.length, sd: m.length > 1 ? sd(d) : null };
}
function neutralBase(sess) {
  const v = sess.poses[0].trials.map(markStats).filter(Boolean);
  return v.length ? { deg: mean(v.map((x) => x.deg)), sig: Math.sqrt(v.reduce((s, x) => s + x.sig * x.sig, 0)) / v.length } : null;
}
function refOf(sess, p, t) {
  const tr = sess.poses[p].trials[t];
  if (p === 0) return { ref: 0, sigma: 0, src: "нейтраль" };
  if (tr.refManual !== null && tr.refManual !== undefined) return { ref: tr.refManual, sigma: null, src: "вручную" };
  if (sess.settings.refMethod === "photo") {
    const m = markStats(tr), b = neutralBase(sess);
    if (m && b) return { ref: m.deg - b.deg, sigma: Math.hypot(m.sig, b.sig), src: "фото" };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Таблица поз                                                         */
/* ------------------------------------------------------------------ */
let sel = { p: 0, t: 0 };

function renderRows() {
  const tb = $("poseTable").querySelector("tbody");
  tb.innerHTML = "";
  const R = S.settings.repeats;
  S.poses.forEach((pose, p) => pose.trials.forEach((tr, t) => {
    const r = refOf(S, p, t);
    const err = tr.app !== null && r && p > 0 ? tr.app - r.ref : null;
    const ms = markStats(tr);
    const tro = document.createElement("tr");
    if (sel.p === p && sel.t === t) tro.className = "activeRow";
    tro.innerHTML = `
      <td>${pose.name}${R > 1 ? `<span class="cellNote">повтор ${t + 1} из ${R}</span>` : ""}</td>
      <td>${tr.app === null ? "" : fmt(tr.app) + "°"}${tr.spread !== null && tr.spread > S.settings.maxSpread ? '<span class="cellNote errBad">двигались</span>' : ""}
        <button class="btn ghost small" data-act="rec" data-p="${p}" data-t="${t}">Записать</button></td>
      <td>${ms ? fmt(ms.deg) + "°" : ""}${ms ? `<span class="cellNote">±${fmt(ms.sig)}${ms.n > 1 ? ` · разметок ${ms.n}` : ""}</span>` : ""}
        <button class="btn ghost small" data-act="photo" data-p="${p}" data-t="${t}">Фото</button></td>
      <td>${p === 0 ? "0" : `<input type="number" step="0.1" data-act="ref" data-p="${p}" data-t="${t}" value="${tr.refManual ?? ""}" placeholder="${r ? fmt(r.ref) : ""}">`}${r && r.sigma ? `<span class="cellNote">±${fmt(r.sigma)}</span>` : ""}</td>
      <td>${err === null ? "" : `<span class="${errClass(err)}">${sgn(err)}°</span>`}</td>`;
    tb.appendChild(tro);
  }));
  persist();
  renderAnalysis();
}

$("poseTable").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const p = Number(b.dataset.p), t = Number(b.dataset.t);
  sel = { p, t };
  if (b.dataset.act === "rec") { recordTrial(p, t, b); return; } // таблицу не перерисовываем: на кнопке идёт отсчёт
  pts = []; img = null; drawPhoto();
  $("photoFile").value = ""; $("photoFile").click();
  renderRows();
});
$("poseTable").addEventListener("change", (e) => {
  const inp = e.target.closest("input[data-act=ref]");
  if (!inp) return;
  S.poses[Number(inp.dataset.p)].trials[Number(inp.dataset.t)].refManual = inp.value === "" ? null : Number(inp.value);
  renderRows();
});
$("mResetPose").onclick = () => {
  if (!confirm("Стереть все измерения этой сессии (настройки и данные участника сохранятся)?")) return;
  S.poses.forEach((p) => { p.trials = p.trials.map(blankTrial); });
  sel = { p: 0, t: 0 }; img = null; pts = []; drawPhoto(); renderRows();
};

/* ---------- запись показаний приложения ---------- */
function sample(getter, btn, done, seconds) {
  const vals = [];
  let left = seconds;
  const label = btn.textContent;
  btn.disabled = true;
  const t = setInterval(() => {
    const v = getter();
    if (v !== null && v !== undefined) vals.push(v);
    left -= 0.1;
    btn.textContent = Math.max(1, Math.ceil(left)) + " с";
    if (left <= 0.05) { clearInterval(t); btn.disabled = false; btn.textContent = label; done(vals); }
  }, 100);
}

function setTrial(p, t, app, spread) {
  const tr = S.poses[p]?.trials[t];
  if (!tr) return;
  tr.app = app; tr.spread = spread; sel = { p, t };
  renderRows();
}

function recordTrial(p, t, btn) {
  const s = S_APP();
  if (!s || s.phase !== "monitoring" || s.angleRaw === null) {
    say("Сначала нажмите «Старт» в блоке «Контроль» и дождитесь «Готово» (калибровка).");
    return;
  }
  const secs = S.settings.recSec;
  say(`«${S.poses[p].name}»: не двигайтесь ${secs} с, помощник снимает фото.`);
  window.__frameNote?.(`«${S.poses[p].name}»: не двигайтесь, помощник снимает фото`, secs);
  sample(() => S_APP().angleRaw, btn, (vals) => {
    if (vals.length < REC_MIN_SAMPLES) { say("Мало данных — лицо не видно? Повторите."); return; }
    const spr = spreadOf(vals);
    setTrial(p, t, median(vals), spr);
    const tr = S.poses[p].trials[t];
    say(spr > S.settings.maxSpread
      ? `Показание ${fmt(tr.app)}°, но разброс ${fmt(spr)}° — вы двигались. Повторите запись и фото.`
      : `Записано: ${fmt(tr.app)}°. Теперь загрузите фото этой позы (кнопка «Фото»).`);
  }, secs);
}

/* ------------------------------------------------------------------ */
/* Фото-угломер с лупой и оценкой ошибки разметки                      */
/* ------------------------------------------------------------------ */
const canvas = $("photoCanvas"), ctx = canvas.getContext("2d");
const loupe = $("photoLoupe"), lctx = loupe.getContext("2d");
let img = null, natural = 1, imgId = 0, pts = [];

function drawPhoto() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!img) return;
  const u = canvas.width / 640;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const tr = S.poses[sel.p]?.trials[sel.t];
  for (const m of tr?.marks || []) { // прежние разметки этого фото — бледнее
    if (m.img !== imgId) continue;
    ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 2 * u;
    ctx.beginPath(); ctx.moveTo(m.ear.x, m.ear.y); ctx.lineTo(m.eye.x, m.eye.y); ctx.stroke();
  }
  if (pts.length) {
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2 * u; ctx.setLineDash([6 * u, 6 * u]);
    ctx.beginPath(); ctx.moveTo(pts[0].x - 120 * u, pts[0].y); ctx.lineTo(pts[0].x + 120 * u, pts[0].y); ctx.stroke(); // горизонт
    ctx.setLineDash([]);
  }
  if (pts.length === 2) {
    ctx.strokeStyle = "#0a0a0b"; ctx.lineWidth = 4 * u;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * u; ctx.stroke();
  }
  pts.forEach((p, k) => {
    ctx.fillStyle = "#0a0a0b"; ctx.beginPath(); ctx.arc(p.x, p.y, 7 * u, 0, 7); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = `bold ${11 * u}px sans-serif`; ctx.textAlign = "center"; ctx.fillText(String(k + 1), p.x, p.y + 4 * u);
  });
}

$("photoFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const im = new Image();
  im.onload = () => {
    img = im; pts = []; imgId++; natural = im.naturalWidth;
    canvas.width = Math.min(im.naturalWidth, 1600);              // высокое разрешение: точнее клик
    canvas.height = Math.round(canvas.width * im.naturalHeight / im.naturalWidth);
    drawPhoto();
    $("photoHint").textContent = `«${S.poses[sel.p].name}»${S.settings.repeats > 1 ? `, повтор ${sel.t + 1}` : ""}: нажмите на козелок уха (1), затем на внешний уголок глаза (2). Рядом появится лупа.`;
    URL.revokeObjectURL(im.src);
  };
  im.onerror = () => say("Не удалось открыть фото.");
  im.src = URL.createObjectURL(file);
});

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height, cssW: r.width };
}

canvas.addEventListener("click", (e) => {
  if (!img) return;
  const c = canvasPoint(e);
  if (pts.length >= 2) pts = [];
  pts.push({ x: c.x, y: c.y });
  drawPhoto();
  if (pts.length === 1) { $("photoHint").textContent = "Теперь нажмите на внешний уголок глаза (2)."; return; }
  // разметка завершена: угол, длина линии в пикселях исходного фото и неопределённость от ошибки клика
  const Lorig = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) * natural / canvas.width;
  const sigOrig = S.settings.clickSigma * natural / c.cssW;
  const deg = lineAngle(pts[0], pts[1]);
  const tr = S.poses[sel.p].trials[sel.t];
  tr.marks.push({ deg, L: Lorig, sig: lineAngleSigma(Lorig, sigOrig), ear: pts[0], eye: pts[1], img: imgId });
  $("photoHint").textContent = `Разметка ${tr.marks.length}: ${fmt(deg)}° к горизонту (длина линии ${fmt(Lorig, 0)} px, ошибка клика даёт ±${fmt(tr.marks.at(-1).sig)}°). Можно разметить ещё раз — по разбросу оценим ошибку разметки.`;
  renderRows();
});
canvas.addEventListener("mousemove", (e) => { // лупа: увеличенный участок рядом с курсором
  if (!img) return;
  const c = canvasPoint(e), half = 20 * canvas.width / 640;
  loupe.hidden = false;
  lctx.clearRect(0, 0, 140, 140);
  lctx.drawImage(canvas, c.x - half, c.y - half, half * 2, half * 2, 0, 0, 140, 140);
  lctx.strokeStyle = "rgba(255,255,255,.95)"; lctx.lineWidth = 1;
  lctx.beginPath(); lctx.moveTo(70, 0); lctx.lineTo(70, 140); lctx.moveTo(0, 70); lctx.lineTo(140, 70); lctx.stroke();
  lctx.strokeStyle = "rgba(10,10,11,.6)";
  lctx.beginPath(); lctx.moveTo(70, 56); lctx.lineTo(70, 84); lctx.moveTo(56, 70); lctx.lineTo(84, 70); lctx.stroke();
});
canvas.addEventListener("mouseleave", () => { loupe.hidden = true; });
$("photoUndo").onclick = () => { const tr = S.poses[sel.p].trials[sel.t]; tr.marks.pop(); pts = []; drawPhoto(); renderRows(); };
$("photoClear").onclick = () => { pts = []; drawPhoto(); if (img) $("photoHint").textContent = "Нажмите на козелок уха (1), затем на внешний уголок глаза (2)."; };

/* ------------------------------------------------------------------ */
/* Анализ                                                              */
/* ------------------------------------------------------------------ */
function collect(sessions) {
  const out = { pairs: [], groups: [], refGroups: [], sigmas: [], neutral: [], sessions: sessions.length, participants: new Set(), matrixRows: [] };
  sessions.forEach((sess, si) => {
    out.participants.add(sess.meta?.participant || `#${si + 1}`);
    sess.poses.forEach((pose, p) => {
      const apps = pose.trials.filter((tr) => tr.app !== null).map((tr) => tr.app);
      if (apps.length >= 2) out.groups.push(apps);
      if (p === 0) out.neutral.push(...apps);
      pose.trials.forEach((tr, t) => {
        if (tr.marks && tr.marks.length >= 2) out.refGroups.push(tr.marks.map((m) => m.deg));
        if (p === 0 || tr.app === null) return;
        const r = refOf(sess, p, t);
        if (!r) return;
        out.pairs.push({ a: tr.app, r: r.ref });
        if (r.sigma) out.sigmas.push(r.sigma);
      });
      out.matrixRows.push(apps);
    });
  });
  return out;
}

function analyze(sessions) {
  const c = collect(sessions);
  const res = { c, n: c.pairs.length };
  res.ba = blandAltman(c.pairs);
  res.rep = repeatability(c.groups);
  res.refRep = repeatability(c.refGroups);
  res.refSigma = c.sigmas.length ? Math.sqrt(mean(c.sigmas.map((x) => x * x))) : null;
  // ICC повторяемости приложения: строки — позы (или пары «сессия+поза»), столбцы — повторы
  for (const k of [4, 3, 2]) {
    const rows = c.matrixRows.filter((r) => r.length >= k).map((r) => r.slice(0, k));
    if (rows.length >= 3) { res.iccRep = icc(rows); res.iccRep.k = k; break; }
  }
  // ICC согласия приложения и эталона: два «метода» по одним и тем же измерениям
  if (c.pairs.length >= 5) res.iccAgree = icc(c.pairs.map((p) => [p.a, p.r]));
  res.neutralMean = c.neutral.length ? mean(c.neutral) : null;
  return res;
}

const metric = (v, l) => `<div class="metric"><b>${v}</b><span>${l}</span></div>`;
const iccText = (r, label) => r && r.icc21 !== undefined
  ? `${label}: ICC(2,1) <b>${fmt(r.icc21, 2)}</b> (95% ДИ ${fmt(r.ci21[0], 2)}–${fmt(r.ci21[1], 2)}) — ${iccLabel(r.ci21[0])} по нижней границе; ICC(3,1) ${fmt(r.icc31, 2)} (${fmt(r.ci31[0], 2)}–${fmt(r.ci31[1], 2)}); k=${r.k}, n=${r.n}`
  : "";

function baSvg(ba) { // график Bland–Altman: разность от среднего двух методов
  const W = 560, H = 270, L = 48, Rr = 96, T = 14, B = 36;
  const xs = ba.means, ys = ba.diffs;
  const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3;
  const lo = Math.min(...ys, ba.tol[0]) - 1, hi = Math.max(...ys, ba.tol[1]) + 1;
  const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - Rr), Y = (v) => H - B - (v - lo) / (hi - lo) * (H - B - T);
  const line = (v, dash, col, label) => `<line x1="${L}" x2="${W - Rr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${col}" stroke-width="1.5" ${dash ? `stroke-dasharray="${dash}"` : ""}/><text x="${W - Rr + 6}" y="${(Y(v) + 4).toFixed(1)}" font-size="11" fill="${col}">${label}</text>`;
  const zero = lo < 0 && hi > 0 ? `<line x1="${L}" x2="${W - Rr}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="#a1a1aa" stroke-width="1"/>` : "";
  const dots = xs.map((x, i) => `<circle cx="${X(x).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="4.5" fill="#0a0a0b" fill-opacity=".8"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="baSvg" role="img" aria-label="График Bland–Altman">
    <rect x="${L}" y="${T}" width="${W - L - Rr}" height="${H - B - T}" fill="rgba(255,255,255,.4)" stroke="rgba(10,10,11,.1)"/>
    ${zero}${line(ba.tol[1], "2 4", "#b4791f", `${sgn(ba.tol[1])} допуск`)}${line(ba.loa[1], "6 4", "#6b6b73", `${sgn(ba.loa[1])} +1,96 SD`)}${line(ba.bias, "", "#0a0a0b", `${sgn(ba.bias)} смещение`)}${line(ba.loa[0], "6 4", "#6b6b73", `${sgn(ba.loa[0])} −1,96 SD`)}${line(ba.tol[0], "2 4", "#b4791f", `${sgn(ba.tol[0])} допуск`)}
    ${dots}
    <text x="${(L + (W - Rr)) / 2}" y="${H - 8}" font-size="11.5" fill="#6b6b73" text-anchor="middle">среднее двух методов, °</text>
    <text x="12" y="${H / 2}" font-size="11.5" fill="#6b6b73" text-anchor="middle" transform="rotate(-90 12 ${H / 2})">приложение − эталон, °</text>
    <text x="${L}" y="${H - B + 14}" font-size="10.5" fill="#6b6b73">${fmt(x0, 0)}</text><text x="${W - Rr}" y="${H - B + 14}" font-size="10.5" fill="#6b6b73" text-anchor="end">${fmt(x1, 0)}</text>
  </svg>`;
}

function notes(res) {
  const ba = res.ba, out = [];
  if (ba.n < 10) out.push(`Точек всего ${ba.n}: интервалы очень широкие и неточные. Допусковый интервал («95% ошибок с уверенностью 95%») строже обычных границ согласия и лучше подходит для малых выборок.`);
  if (res.refSigma !== null && res.refSigma > 0.5 * ba.sd) out.push(`Неопределённость эталона (±${fmt(res.refSigma)}°) сопоставима с разбросом ошибок приложения: часть «ошибки» приходится на разметку фото. Увеличьте разрешение фото, используйте лупу, размечайте несколько раз.`);
  if (Math.abs(ba.propR) > 0.5 && ba.n >= 6) out.push(`Ошибка зависит от величины угла (наклон регрессии разности на среднее ${fmt(ba.propSlope, 2)}): нужна поправка вида «k×показание + b», а не только смещение.`);
  if (res.neutralMean !== null && Math.abs(res.neutralMean) > 2) out.push(`Показание нейтрали ${sgn(res.neutralMean)}° при калибровке в 0°: калибровка сдвинулась или вы двигались.`);
  return out;
}

function verdict(ba) {
  if (ba.mae <= 3) return "Ошибка небольшая: порог 15° работает с запасом.";
  if (ba.mae <= 6) return "Ошибка умеренная: сирена может срабатывать при 15° ± ошибка. Примените поправку и оставьте задержку сирены 2–3 с.";
  return `Ошибка большая (в 95% случаев от ${sgn(ba.loa[0])}° до ${sgn(ba.loa[1])}°): одной камеры спереди мало. Нужен датчик в наушниках (Mac + AirPods) или съёмка профиля второй камерой.`;
}

function resultHtml(res, compact = false) {
  const ba = res.ba;
  if (ba.mae === undefined) return `Пока ${res.n} из 3 нужных точек (показание приложения + эталон).`;
  const parts = [`<div class="metrics">
      ${metric(`±${fmt(ba.mae)}°`, "средняя ошибка (MAE)")}
      ${metric(`${sgn(ba.bias)}°`, `смещение, 95% ДИ ${sgn(ba.biasCI[0])}…${sgn(ba.biasCI[1])}`)}
      ${metric(`${sgn(ba.loa[0])}…${sgn(ba.loa[1])}°`, "95% границы согласия")}
      ${metric(`${sgn(ba.tol[0])}…${sgn(ba.tol[1])}°`, `допусковый интервал 95/95 (k=${fmt(ba.tolK, 2)})`)}
    </div>
    <p>${verdict(ba)}</p>`];
  if (ba.fit && Number.isFinite(ba.fit.slope)) parts.push(`<p class="note">Поправка: угол = ${fmt(ba.fit.slope, 2)} × показание ${ba.fit.intercept >= 0 ? "+" : "−"} ${fmt(Math.abs(ba.fit.intercept))}° (r = ${fmt(ba.fit.r, 2)}).</p>`);
  if (!compact) for (const n of notes(res)) parts.push(`<p class="note warnNote">${n}</p>`);
  return parts.join("");
}

function relHtml(res) {
  const rows = [];
  if (res.rep.groups) rows.push(`<div class="metrics">
      ${metric(`${fmt(res.rep.sw)}°`, `SEM (Sw), групп ${res.rep.groups}`)}
      ${metric(`${fmt(res.rep.mdc95)}°`, "MDC95 = 1,96·√2·SEM")}
      ${res.refSigma !== null ? metric(`±${fmt(res.refSigma)}°`, "неопределённость эталона") : ""}
      ${res.refRep.groups ? metric(`${fmt(res.refRep.sw)}°`, "разброс разметки фото (Sw)") : ""}
    </div>
    <p class="note">MDC95 — минимальное изменение угла, которое приложение отличает от собственного шума. Для сравнения: у клинического CROM SEM около 2–3°, MDC90 около 4–5° (вращение шеи).</p>`);
  const a = iccText(res.iccRep, "Повторяемость приложения");
  const b = iccText(res.iccAgree, "Согласие с эталоном");
  if (a) rows.push(`<p>${a}</p>`);
  if (b) rows.push(`<p>${b}</p>`);
  if (!res.rep.groups && !a) rows.push('<p class="note">Для повторяемости (SEM, MDC, ICC) нужны повторы одной позы: поставьте «Повторы» 2 и больше в протоколе.</p>');
  return rows.join("");
}

let lastRes = null;
function renderAnalysis() {
  const res = analyze([S]);
  lastRes = res;
  $("headResult").innerHTML = resultHtml(res);
  $("baPlot").innerHTML = res.ba.mae !== undefined ? baSvg(res.ba) : "";
  $("relResult").innerHTML = relHtml(res);
  const f = res.ba.fit;
  $("mApplyCorr").disabled = !(f && res.ba.n >= 4 && f.slope >= 0.6 && f.slope <= 1.6 && Math.abs(f.intercept) <= 10);
  renderLib();
}

$("mApplyCorr").onclick = () => {
  const f = lastRes?.ba?.fit;
  if (!f) return;
  save("lookup.corr", { k: f.slope, b: f.intercept });
  say("Поправка применена: основное приложение теперь показывает исправленный угол. Проверьте замером ещё раз на другом участнике.");
};
$("mResetCorr").onclick = () => { try { localStorage.removeItem("lookup.corr"); } catch { /* нет доступа */ } say("Поправка сброшена."); };

/* ------------------------------------------------------------------ */
/* Протокол и данные участника                                         */
/* ------------------------------------------------------------------ */
function syncForm() {
  const s = S.settings;
  $("pPreset").value = s.preset; $("pPoses").value = s.poses; $("pRepeats").value = s.repeats; $("pRec").value = s.recSec;
  $("pSpread").value = s.maxSpread; $("pRef").value = s.refMethod; $("pSigma").value = s.clickSigma;
  $("mId").value = S.meta.participant; $("mOp").value = S.meta.operator; $("mLight").value = S.meta.lighting; $("mNotes").value = S.meta.notes;
}
const clamp = (v, a, b, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };
function readSettings(fromPreset) {
  const s = S.settings;
  if (fromPreset && PRESETS[$("pPreset").value]) Object.assign(s, PRESETS[$("pPreset").value], { preset: $("pPreset").value });
  else {
    s.poses = clamp($("pPoses").value, 1, 8, s.poses); s.repeats = clamp($("pRepeats").value, 1, 4, s.repeats);
    s.recSec = clamp($("pRec").value, 1, 15, s.recSec); s.maxSpread = clamp($("pSpread").value, 0.5, 8, s.maxSpread);
    const match = Object.entries(PRESETS).find(([, v]) => v.poses === s.poses && v.repeats === s.repeats && v.recSec === s.recSec && v.maxSpread === s.maxSpread);
    s.preset = match ? match[0] : "custom";
  }
  s.refMethod = $("pRef").value; s.clickSigma = clamp($("pSigma").value, 0.5, 6, s.clickSigma);
  reshape(); syncForm(); renderRows();
}
$("pPreset").onchange = () => readSettings(true);
for (const id of ["pPoses", "pRepeats", "pRec", "pSpread", "pRef", "pSigma"]) $(id).onchange = () => readSettings(false);
for (const [id, key] of [["mId", "participant"], ["mOp", "operator"], ["mLight", "lighting"], ["mNotes", "notes"]]) {
  $(id).oninput = () => { S.meta[key] = $(id).value.trim(); persist(); };
}

/* ------------------------------------------------------------------ */
/* Сессия: JSON, набор сессий                                          */
/* ------------------------------------------------------------------ */
const stripMarks = (sess) => JSON.parse(JSON.stringify(sess, (k, v) => (k === "ear" || k === "eye" || k === "img" ? undefined : v)));
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}
const fileStem = () => `lookup_${S.meta.participant || "session"}_${new Date().toISOString().slice(0, 10)}`;

$("mSaveJson").onclick = () => {
  const out = { app: "LookUp", exportedAt: new Date().toISOString(), ...stripMarks(S) };
  download(fileStem() + ".json", JSON.stringify(out, null, 1), "application/json");
};
$("mLoadJson").onclick = () => { $("mJsonFile").value = ""; $("mJsonFile").click(); };
const validSession = (o) => o && Array.isArray(o.poses) && o.settings && o.poses.every((p) => Array.isArray(p.trials));

$("mJsonFile").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  const loaded = [];
  for (const f of files) {
    try {
      const o = JSON.parse(await f.text());
      if (Array.isArray(o.sessions)) loaded.push(...o.sessions.filter(validSession));
      else if (validSession(o)) loaded.push(o);
    } catch { /* нечитаемый файл пропускаем */ }
  }
  if (!loaded.length) { say("В файлах нет подходящих сессий LookUp."); return; }
  if (files.length === 1 && loaded.length === 1) {
    S = { ...newSession(), ...loaded[0], version: 2 };
    S.settings = { ...newSession().settings, ...S.settings };
    for (const p of S.poses) for (const t of p.trials) t.marks = t.marks || [];
    reshape(); syncForm(); renderRows();
    say("Сессия загружена.");
  } else {
    lib.push(...loaded); save(LIB_KEY, lib); renderLib();
    say(`Добавлено сессий в набор: ${loaded.length}.`);
  }
});

let lib = load(LIB_KEY, []);
function renderLib() {
  const el = $("libResult");
  if (!lib.length) { el.innerHTML = "Набор пуст."; return; }
  const res = analyze(lib);
  const people = res.c.participants.size;
  el.innerHTML = `Сессий: <b>${lib.length}</b>, участников: <b>${people}</b>, пар «приложение–эталон»: <b>${res.n}</b>.` +
    (people < SAMPLE_TARGET_N ? ` <span class="warnNote">Для выводов о точности на людях по литературе нужно около ${SAMPLE_TARGET_N} участников × 3 повтора; сейчас ${people}. Повторы одного человека зависимы, поэтому интервалы приблизительные.</span>` : "") +
    `<div>${resultHtml(res, true)}</div>${res.ba.mae !== undefined ? baSvg(res.ba) : ""}${relHtml(res)}`;
}
$("libAdd").onclick = () => {
  if (!analyze([S]).n) { say("В текущей сессии нет ни одной пары «приложение–эталон»."); return; }
  lib.push(stripMarks(S)); save(LIB_KEY, lib); renderLib();
  say(`Сессия добавлена в набор (всего ${lib.length}).`);
};
$("libExport").onclick = () => download(`lookup_set_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: "LookUp", exportedAt: new Date().toISOString(), sessions: lib }, null, 1), "application/json");
$("libClear").onclick = () => { if (confirm("Очистить набор сессий?")) { lib = []; save(LIB_KEY, lib); renderLib(); } };

/* ------------------------------------------------------------------ */
/* 2. Угол экрана                                                      */
/* ------------------------------------------------------------------ */
function lidPhi() { // наклон экрана назад от вертикали φ по «Уровню»
  const x = parseFloat($("lidLevel").value);
  if (!Number.isFinite(x)) return null;
  const phi = $("lidMode").value === "vertical" ? x : (x <= 90 ? 90 - x : x - 90);
  return Math.max(0, Math.min(60, phi));
}
$("lidCmp").onclick = () => {
  const phi = lidPhi();
  if (phi === null) { $("lidResult").textContent = "Введите показание «Уровня»."; return; }
  const cam = S_APP()?.lidCam;
  $("lidResult").innerHTML = `Уровень: экран наклонён назад на <b>${fmt(phi)}°</b> (угол раскрытия крышки ${fmt(90 + phi, 0)}°).<br>` +
    (cam === null || cam === undefined
      ? "Оценка камеры пока недоступна: сделайте «Старт» и калибровку выше."
      : `Камера оценила <b>${fmt(cam)}°</b>. Разница: <b>${sgn(cam - phi)}°</b>. ${Math.abs(cam - phi) <= 4 ? "Оценка камеры годится." : "Лучше использовать значение по «Уровню»."}`);
};
$("lidUse").onclick = () => {
  const phi = lidPhi();
  if (phi === null) { $("lidResult").textContent = "Введите показание «Уровня»."; return; }
  try { localStorage.setItem("lookup.lidManual", String(phi)); } catch { /* нет доступа */ }
  $("lidResult").textContent = `Сохранено: основное приложение будет использовать наклон экрана ${fmt(phi)}° вместо оценки камеры.`;
};
$("lidReset").onclick = () => { try { localStorage.removeItem("lookup.lidManual"); } catch { /* нет доступа */ } $("lidResult").textContent = "Ручное значение сброшено — снова оценка камеры."; };

/* ------------------------------------------------------------------ */
/* 3. Расстояние                                                       */
/* ------------------------------------------------------------------ */
let dists = load(DIST_KEY, []);
function distK() { // расстояние ∝ 1/размер зрачков: K = Σ(ref·est)/Σ(est²)
  if (dists.length < 2) return null;
  return dists.reduce((s, d) => s + d.ref * d.est, 0) / dists.reduce((s, d) => s + d.est * d.est, 0);
}
function renderDist() {
  $("distTable").querySelector("tbody").innerHTML = dists.map((d) => {
    const e = d.est - d.ref, pct = 100 * e / d.ref;
    return `<tr><td>${fmt(d.ref, 0)}</td><td>${fmt(d.est, 0)}</td><td class="${errClass(pct / 3)}">${sgn(e, 0)} см (${fmt(pct, 0)}%)</td></tr>`;
  }).join("");
  const k = distK();
  if (k === null) { $("distResult").textContent = `Записей: ${dists.length}. Нужно минимум 2, лучше 3 на разных расстояниях.`; $("distApply").disabled = true; }
  else {
    const before = mean(dists.map((d) => Math.abs(d.est - d.ref) / d.ref * 100));
    const after = mean(dists.map((d) => Math.abs(d.est * k - d.ref) / d.ref * 100));
    $("distResult").innerHTML = `Коэффициент <b>${fmt(k, 2)}</b>. Средняя ошибка: ${fmt(before, 0)}% → после поправки ${fmt(after, 0)}%.`;
    $("distApply").disabled = !(k >= 0.6 && k <= 1.6 && dists.length >= 3);
  }
  save(DIST_KEY, dists);
}
$("distRec").onclick = () => {
  const s = S_APP(), ref = parseFloat($("distRef").value);
  if (!Number.isFinite(ref)) { $("distResult").textContent = "Сначала введите расстояние по рулетке."; return; }
  if (!s || s.source !== "cam" || s.distRaw === null) { $("distResult").textContent = "Нужна работающая камера: нажмите «Старт» выше и смотрите на экран."; return; }
  window.__frameNote?.("Смотрите на экран, не двигайтесь", S.settings.recSec);
  sample(() => S_APP().distRaw, $("distRec"), (vals) => {
    if (vals.length < REC_MIN_SAMPLES) { $("distResult").textContent = "Мало данных — лицо не видно."; return; }
    dists.push({ ref, est: mean(vals) });
    renderDist();
  }, S.settings.recSec);
};
$("distApply").onclick = () => {
  const k = distK();
  if (k === null) return;
  try { localStorage.setItem("lookup.distK", String(k)); } catch { /* нет доступа */ }
  $("distResult").innerHTML += "<br>Сохранено: основное приложение применяет этот коэффициент.";
};
$("distReset").onclick = () => { dists = []; try { localStorage.removeItem("lookup.distK"); } catch { /* нет доступа */ } renderDist(); };

/* ------------------------------------------------------------------ */
/* Отчёт                                                               */
/* ------------------------------------------------------------------ */
function summaryLines(res, title) {
  const L = [title];
  const ba = res.ba;
  if (ba.mae === undefined) { L.push(`  данных мало (${res.n} пар, нужно 3+)`); return L; }
  L.push(`  пар: ${ba.n}; MAE ±${fmt(ba.mae)}°; RMSE ${fmt(ba.rmse)}°; максимум ${fmt(ba.maxAbs)}°`);
  L.push(`  смещение ${sgn(ba.bias)}° (95% ДИ ${sgn(ba.biasCI[0])}…${sgn(ba.biasCI[1])}°); SD разностей ${fmt(ba.sd)}°`);
  L.push(`  95% границы согласия: ${sgn(ba.loa[0])}…${sgn(ba.loa[1])}°; допусковый интервал 95/95: ${sgn(ba.tol[0])}…${sgn(ba.tol[1])}° (k=${fmt(ba.tolK, 2)})`);
  if (ba.fit && Number.isFinite(ba.fit.slope)) L.push(`  поправка: ${fmt(ba.fit.slope, 2)}×показание ${ba.fit.intercept >= 0 ? "+" : "−"}${fmt(Math.abs(ba.fit.intercept))}°; r=${fmt(ba.fit.r, 2)}; наклон разности от среднего ${fmt(ba.propSlope, 2)}`);
  if (res.refSigma !== null) L.push(`  неопределённость эталона (оценка по ошибке клика): ±${fmt(res.refSigma)}°`);
  if (res.refRep.groups) L.push(`  разброс повторной разметки фото: Sw ${fmt(res.refRep.sw)}°`);
  if (res.rep.groups) L.push(`  повторяемость приложения: Sw=SEM ${fmt(res.rep.sw)}°; MDC95 ${fmt(res.rep.mdc95)}°; групп ${res.rep.groups}`);
  if (res.iccRep) L.push(`  ${iccText(res.iccRep, "ICC повторяемости").replace(/<\/?b>/g, "")}`);
  if (res.iccAgree) L.push(`  ${iccText(res.iccAgree, "ICC согласия с эталоном").replace(/<\/?b>/g, "")}`);
  L.push(`  вывод: ${verdict(ba)}`);
  return L;
}

function buildReport() {
  const res = analyze([S]);
  const cam = S_APP()?.lidCam, phi = lidPhi(), k = distK();
  const L = [];
  L.push(`LookUp — замер точности, ${new Date().toLocaleString("ru-RU")}`);
  L.push(`Браузер: ${navigator.userAgent.split(") ").pop()}`);
  L.push(`Участник: ${S.meta.participant || "—"}; оператор: ${S.meta.operator || "—"}; освещение: ${S.meta.lighting || "—"}; заметки: ${S.meta.notes || "—"}`);
  L.push(`Протокол: ${S.settings.poses} поз × ${S.settings.repeats} повтор(а), запись ${S.settings.recSec} с, допуск движения ${S.settings.maxSpread}°, эталон: ${S.settings.refMethod === "photo" ? "фото (козелок → внешний уголок глаза)" : "ввод вручную"}, точность клика ${S.settings.clickSigma} px`);
  L.push("");
  L.push(...summaryLines(res, "Наклон головы (приложение ↔ эталон):"));
  if (res.neutralMean !== null) L.push(`  показание нейтрали: ${sgn(res.neutralMean)}° (должно быть около 0°)`);
  S.poses.forEach((pose, p) => pose.trials.forEach((tr, t) => { const r = refOf(S, p, t); L.push(`  ${pose.name}, повтор ${t + 1}: приложение ${fmt(tr.app)}°, эталон ${fmt(r?.ref)}°${r?.sigma ? ` ±${fmt(r.sigma)}` : ""}`); }));
  L.push("");
  L.push("Угол экрана:");
  L.push(phi === null ? "  не измерялся" : `  уровень ${fmt(phi)}° (крышка ${fmt(90 + phi, 0)}°); камера ${cam === null || cam === undefined ? "—" : fmt(cam) + "°"}`);
  L.push("");
  L.push("Расстояние до экрана:");
  if (!dists.length) L.push("  не измерялось");
  else { dists.forEach((d) => L.push(`  рулетка ${fmt(d.ref, 0)} см, приложение ${fmt(d.est, 0)} см`)); L.push(`  коэффициент ${k === null ? "—" : fmt(k, 2)}`); }
  if (lib.length) {
    L.push("");
    const pooled = analyze(lib);
    L.push(...summaryLines(pooled, `Набор сессий (${lib.length} сессий, ${pooled.c.participants.size} участников):`));
    if (pooled.c.participants.size < SAMPLE_TARGET_N) L.push(`  ВНИМАНИЕ: участников ${pooled.c.participants.size} из ~${SAMPLE_TARGET_N} по литературным ориентирам; повторы одного человека зависимы.`);
  }
  L.push("");
  L.push("Метод: эталон — угол линии «козелок → внешний уголок глаза» на фото профиля относительно нейтрального фото (или ручной ввод); расстояние — рулетка; экран — «Уровень» телефона.");
  L.push("Статистика: Bland–Altman (границы согласия, допусковый интервал по Howe), Sw/SEM/MDC95, ICC по McGraw & Wong, трактовка по Koo & Li (2016). Формулы проверены тестами (tests/).");
  L.push("Ограничения: это оценка характеристик приложения в указанных условиях, а не клиническая валидация. LookUp — не медицинское устройство. Эталон по фото — не рентген и не гониометр.");
  return L.join("\n");
}
$("repBuild").onclick = () => { $("reportText").textContent = buildReport(); };
$("repCopy").onclick = async () => {
  $("reportText").textContent = buildReport();
  try { await navigator.clipboard.writeText($("reportText").textContent); $("repCopy").textContent = "Скопировано"; setTimeout(() => ($("repCopy").textContent = "Скопировать"), 1500); }
  catch { /* буфер недоступен — текст можно выделить вручную */ }
};
$("repCsv").onclick = () => {
  const out = [["participant", "pose", "trial", "app_deg", "app_spread", "reference_deg", "reference_sigma", "reference_source", "error_deg"]];
  S.poses.forEach((pose, p) => pose.trials.forEach((tr, t) => {
    const r = refOf(S, p, t);
    out.push([S.meta.participant, pose.name, t + 1, tr.app ?? "", tr.spread === null ? "" : tr.spread.toFixed(2), r ? r.ref.toFixed(2) : "", r?.sigma ? r.sigma.toFixed(2) : "", r?.src ?? "", tr.app !== null && r && p > 0 ? (tr.app - r.ref).toFixed(2) : ""]);
  }));
  dists.forEach((d) => out.push(["", "distance_cm", "", d.est.toFixed(1), "", d.ref, "", "рулетка", (d.est - d.ref).toFixed(1)]));
  download(fileStem() + ".csv", out.map((r) => r.join(",")).join("\n"), "text/csv");
};

/* ------------------------------------------------------------------ */
/* API для пошагового замера в кадре (measure-guide.js)                */
/* ------------------------------------------------------------------ */
window.__measure = {
  median, setTrial,
  getSettings: () => S.settings,
  getPlan: () => S.poses.flatMap((pose, p) => pose.trials.map((_, t) => ({ p, t, name: pose.name, repeat: t + 1, of: S.settings.repeats }))),
  getTrialApp: (p, t) => S.poses[p]?.trials[t]?.app ?? null,
};

syncForm();
renderRows();
renderDist();
