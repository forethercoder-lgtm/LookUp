/* Режим «Замер»: сравниваем показания приложения с эталоном и считаем погрешность.
   Основное приложение (app.js) отдаёт состояние в window.__lookup; поправки
   сохраняются в localStorage и подхватываются основным приложением. */
const $ = (id) => document.getElementById(id);
const S = () => window.__lookup;
const HEAD_KEY = "lookup.measure.head.v1";
const DIST_KEY = "lookup.measure.dist.v1";
const REC_SECONDS = 3;
const MAX_SPREAD = 3; // разброс показаний за 3 с (P90−P10), выше — «вы двигались»

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const spreadOf = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.1)]; };
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(d));
const load = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const say = (t) => { $("mMsg").textContent = t; };

/* ------------------------------------------------------------------ */
/* Запись показаний приложения за 3 секунды                            */
/* ------------------------------------------------------------------ */
function sample(getter, btn, done) {
  const vals = [];
  let left = REC_SECONDS;
  const label = btn.textContent;
  btn.disabled = true;
  const t = setInterval(() => {
    const v = getter();
    if (v !== null && v !== undefined) vals.push(v);
    left -= 0.1;
    btn.textContent = Math.max(1, Math.ceil(left)) + " с";
    if (left <= 0.05) {
      clearInterval(t);
      btn.disabled = false;
      btn.textContent = label;
      done(vals);
    }
  }, 100);
}

/* ------------------------------------------------------------------ */
/* 1. Наклон головы                                                    */
/* ------------------------------------------------------------------ */
const defaultRows = () => [
  { name: "Нейтраль", hint: "смотрю на метку", app: null, spread: null, photo: null, refManual: null },
  { name: "Поза 1", hint: "небольшой наклон", app: null, spread: null, photo: null, refManual: null },
  { name: "Поза 2", hint: "средний наклон", app: null, spread: null, photo: null, refManual: null },
  { name: "Поза 3", hint: "сильный наклон", app: null, spread: null, photo: null, refManual: null },
];
let rows = load(HEAD_KEY, null) || defaultRows();
let sel = 0; // строка, для которой загружено фото

const refOf = (i) => {
  const r = rows[i];
  if (i === 0) return 0; // нейтраль — точка отсчёта
  if (r.refManual !== null && r.refManual !== undefined) return r.refManual;
  if (r.photo !== null && rows[0].photo !== null) return r.photo - rows[0].photo;
  return null;
};

function errClass(e) { const a = Math.abs(e); return a <= 3 ? "errGood" : a <= 6 ? "errMid" : "errBad"; }

function renderRows() {
  const tb = $("poseTable").querySelector("tbody");
  tb.innerHTML = "";
  rows.forEach((r, i) => {
    const ref = refOf(i);
    const err = r.app !== null && ref !== null && i > 0 ? r.app - ref : null;
    const tr = document.createElement("tr");
    if (i === sel) tr.className = "activeRow";
    tr.innerHTML = `
      <td>${r.name}<span class="cellNote">${r.hint || ""}</span></td>
      <td>${r.app === null ? "" : fmt(r.app) + "°"}${r.spread !== null && r.spread > MAX_SPREAD ? '<span class="cellNote errBad">двигались</span>' : ""}
        <button class="btn ghost small" data-act="rec" data-i="${i}">Записать</button></td>
      <td>${r.photo === null ? "" : fmt(r.photo) + "°"}
        <button class="btn ghost small" data-act="photo" data-i="${i}">Фото</button></td>
      <td>${i === 0 ? "0" : `<input type="number" step="0.1" data-act="ref" data-i="${i}" value="${r.refManual ?? ""}" placeholder="${ref === null ? "" : fmt(ref)}">`}</td>
      <td>${err === null ? "" : `<span class="${errClass(err)}">${err > 0 ? "+" : ""}${fmt(err)}°</span>`}</td>`;
    tb.appendChild(tr);
  });
  save(HEAD_KEY, rows);
  renderHeadResult();
}

$("poseTable").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const i = Number(b.dataset.i);
  sel = i;
  if (b.dataset.act === "rec") { recordHead(i, b); return; } // таблицу не перерисовываем: на кнопке идёт обратный отсчёт
  $("photoFile").value = ""; $("photoFile").click();
  renderRows();
});
$("poseTable").addEventListener("change", (e) => {
  const inp = e.target.closest("input[data-act=ref]");
  if (!inp) return;
  rows[Number(inp.dataset.i)].refManual = inp.value === "" ? null : Number(inp.value);
  renderRows();
});
$("mAddPose").onclick = () => { rows.push({ name: "Поза " + rows.length, hint: "ещё наклон", app: null, spread: null, photo: null, refManual: null }); renderRows(); };
$("mResetPose").onclick = () => { if (confirm("Стереть все позы?")) { rows = defaultRows(); sel = 0; clearPhoto(); renderRows(); } };

function recordHead(i, btn) {
  const s = S();
  if (!s || s.phase !== "monitoring" || s.angleRaw === null) {
    say("Сначала нажмите «Старт» в блоке «Контроль» и дождитесь «Готово» (калибровка).");
    return;
  }
  say(`Строка «${rows[i].name}»: не двигайтесь ${REC_SECONDS} секунды, помощник снимает фото.`);
  sample(() => S().angleRaw, btn, (vals) => {
    if (vals.length < 10) { say("Мало данных — лицо не видно? Повторите."); return; }
    rows[i].app = median(vals);
    rows[i].spread = spreadOf(vals);
    say(rows[i].spread > MAX_SPREAD
      ? `Показание ${fmt(rows[i].app)}°, но разброс ${fmt(rows[i].spread)}° — вы двигались. Повторите запись и фото.`
      : `Записано: ${fmt(rows[i].app)}°. Теперь загрузите фото этой позы (кнопка «Фото»).`);
    renderRows();
  });
}

/* ---------- фото-угломер ---------- */
const canvas = $("photoCanvas");
const ctx = canvas.getContext("2d");
let img = null;
let pts = [];

function clearPhoto() {
  img = null; pts = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("photoHint").textContent = "Нажмите «Фото» в строке таблицы.";
}

function drawPhoto() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!img) return;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (pts.length) {
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(pts[0].x - 120, pts[0].y); ctx.lineTo(pts[0].x + 120, pts[0].y); ctx.stroke(); // горизонт
    ctx.setLineDash([]);
  }
  if (pts.length === 2) {
    ctx.strokeStyle = "#0a0a0b"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
  }
  pts.forEach((p, k) => {
    ctx.fillStyle = "#0a0a0b"; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(k + 1), p.x, p.y + 4);
  });
}

// Угол линии «козелок → внешний уголок глаза» к горизонту, ° (+: глаз ниже уха, голова наклонена вниз).
// Не зависит от того, в какую сторону смотрит человек.
function lineAngle(ear, eye) {
  return Math.atan2(eye.y - ear.y, Math.abs(eye.x - ear.x)) * 180 / Math.PI;
}

$("photoFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const im = new Image();
  im.onload = () => {
    img = im; pts = [];
    canvas.height = Math.round(canvas.width * im.naturalHeight / im.naturalWidth);
    drawPhoto();
    $("photoHint").textContent = `Строка «${rows[sel].name}»: нажмите на козелок уха (1), затем на внешний уголок глаза (2).`;
    URL.revokeObjectURL(im.src);
  };
  im.onerror = () => say("Не удалось открыть фото.");
  im.src = URL.createObjectURL(file);
});

canvas.addEventListener("click", (e) => {
  if (!img) return;
  const r = canvas.getBoundingClientRect();
  const p = { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  if (pts.length >= 2) pts = [];
  pts.push(p);
  drawPhoto();
  if (pts.length === 1) $("photoHint").textContent = "Теперь нажмите на внешний уголок глаза (2).";
  if (pts.length === 2) {
    const a = lineAngle(pts[0], pts[1]);
    rows[sel].photo = a;
    $("photoHint").textContent = `Угол линии к горизонту: ${fmt(a)}°. ${sel === 0 ? "Это нейтраль — от неё считаются остальные позы." : ""}`;
    renderRows();
  }
});
$("photoClear").onclick = () => { pts = []; drawPhoto(); if (img) $("photoHint").textContent = "Нажмите на козелок уха (1), затем на внешний уголок глаза (2)."; };

/* ---------- статистика ---------- */
function headStats() {
  const p = [];
  rows.forEach((r, i) => { const ref = refOf(i); if (r.app !== null && ref !== null) p.push({ app: r.app, ref, i }); });
  if (p.length < 3) return { n: p.length };
  const errs = p.map((q) => q.app - q.ref);
  const out = {
    n: p.length,
    mae: mean(errs.map(Math.abs)),
    bias: mean(errs),
    max: Math.max(...errs.map(Math.abs)),
    rmse: Math.sqrt(mean(errs.map((e) => e * e))),
  };
  // линейная поправка ref = k·app + b (метод наименьших квадратов)
  const mx = mean(p.map((q) => q.app)), my = mean(p.map((q) => q.ref));
  const vx = p.reduce((s, q) => s + (q.app - mx) ** 2, 0);
  if (vx > 1) {
    const k = p.reduce((s, q) => s + (q.app - mx) * (q.ref - my), 0) / vx;
    const b = my - k * mx;
    out.k = k; out.b = b;
    out.maeCorr = mean(p.map((q) => Math.abs(k * q.app + b - q.ref)));
    out.corrOk = k >= 0.6 && k <= 1.6 && Math.abs(b) <= 10 && p.length >= 4;
  }
  return out;
}

function verdict(mae) {
  if (mae <= 3) return "Хорошо: порог 15° работает с небольшим запасом.";
  if (mae <= 6) return "Приемлемо: сирена может срабатывать при 15° ± ошибка. Примените поправку и оставьте задержку сирены 2–3 с.";
  return "Слабо: одной камеры спереди мало. Нужен датчик в наушниках (Mac + AirPods) или съёмка профиля второй камерой.";
}

function renderHeadResult() {
  const h = headStats();
  const el = $("headResult");
  if (h.mae === undefined) {
    el.innerHTML = `Пока ${h.n} из 3 нужных точек (показание приложения + эталон).`;
    $("mApplyCorr").disabled = true;
    return;
  }
  el.innerHTML = `
    <div class="metrics">
      <div class="metric"><b>±${fmt(h.mae)}°</b><span>средняя ошибка (MAE)</span></div>
      <div class="metric"><b>${h.bias > 0 ? "+" : ""}${fmt(h.bias)}°</b><span>смещение (приложение − эталон)</span></div>
      <div class="metric"><b>${fmt(h.max)}°</b><span>максимальная ошибка</span></div>
      ${h.maeCorr !== undefined ? `<div class="metric"><b>±${fmt(h.maeCorr)}°</b><span>ошибка после поправки</span></div>` : ""}
    </div>
    <p>${verdict(h.mae)}</p>
    ${h.k !== undefined ? `<p class="note">Поправка: угол = ${fmt(h.k, 2)} × показание ${h.b >= 0 ? "+" : "−"} ${fmt(Math.abs(h.b))}°. ${h.corrOk ? "" : "Для применения нужно минимум 4 точки и разумные значения (k от 0,6 до 1,6, смещение до 10°) — повторите замер аккуратнее."}</p>` : ""}`;
  $("mApplyCorr").disabled = !h.corrOk;
}

$("mApplyCorr").onclick = () => {
  const h = headStats();
  if (!h.corrOk) return;
  save("lookup.corr", { k: h.k, b: h.b });
  say("Поправка применена: основное приложение теперь показывает исправленный угол. Проверьте замером ещё раз.");
};
$("mResetCorr").onclick = () => { try { localStorage.removeItem("lookup.corr"); } catch {} say("Поправка сброшена."); };

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
  const cam = S()?.lidCam;
  $("lidResult").innerHTML = `Уровень: экран наклонён назад на <b>${fmt(phi)}°</b> (угол раскрытия крышки ${fmt(90 + phi, 0)}°).<br>` +
    (cam === null || cam === undefined
      ? "Оценка камеры пока недоступна: сделайте «Старт» и калибровку выше."
      : `Камера оценила <b>${fmt(cam)}°</b>. Разница: <b>${fmt(cam - phi)}°</b>. ${Math.abs(cam - phi) <= 4 ? "Оценка камеры годится." : "Лучше использовать значение по «Уровню»."}`);
};
$("lidUse").onclick = () => {
  const phi = lidPhi();
  if (phi === null) { $("lidResult").textContent = "Введите показание «Уровня»."; return; }
  try { localStorage.setItem("lookup.lidManual", String(phi)); } catch {}
  $("lidResult").textContent = `Сохранено: основное приложение будет использовать наклон экрана ${fmt(phi)}° вместо оценки камеры.`;
};
$("lidReset").onclick = () => { try { localStorage.removeItem("lookup.lidManual"); } catch {} $("lidResult").textContent = "Ручное значение сброшено — снова оценка камеры."; };

/* ------------------------------------------------------------------ */
/* 3. Расстояние                                                       */
/* ------------------------------------------------------------------ */
let dists = load(DIST_KEY, []);

function distK() { // расстояние ∝ 1/размер зрачков: K = Σ(ref·est)/Σ(est²)
  if (dists.length < 2) return null;
  const num = dists.reduce((s, d) => s + d.ref * d.est, 0), den = dists.reduce((s, d) => s + d.est * d.est, 0);
  return num / den;
}

function renderDist() {
  const tb = $("distTable").querySelector("tbody");
  tb.innerHTML = dists.map((d) => {
    const e = d.est - d.ref, pct = 100 * e / d.ref;
    return `<tr><td>${fmt(d.ref, 0)}</td><td>${fmt(d.est, 0)}</td><td class="${errClass(pct / 3)}">${e > 0 ? "+" : ""}${fmt(e, 0)} см (${fmt(pct, 0)}%)</td></tr>`;
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
  const s = S();
  const ref = parseFloat($("distRef").value);
  if (!Number.isFinite(ref)) { $("distResult").textContent = "Сначала введите расстояние по рулетке."; return; }
  if (!s || s.source !== "cam" || s.distRaw === null) { $("distResult").textContent = "Нужна работающая камера: нажмите «Старт» выше и смотрите на экран."; return; }
  sample(() => S().distRaw, $("distRec"), (vals) => {
    if (vals.length < 10) { $("distResult").textContent = "Мало данных — лицо не видно."; return; }
    dists.push({ ref, est: mean(vals) });
    renderDist();
  });
};
$("distApply").onclick = () => {
  const k = distK();
  if (k === null) return;
  try { localStorage.setItem("lookup.distK", String(k)); } catch {}
  $("distResult").innerHTML += "<br>Сохранено: основное приложение применяет этот коэффициент.";
};
$("distReset").onclick = () => { dists = []; try { localStorage.removeItem("lookup.distK"); } catch {} renderDist(); };

/* ------------------------------------------------------------------ */
/* Отчёт                                                               */
/* ------------------------------------------------------------------ */
function buildReport() {
  const h = headStats();
  const k = distK();
  const phi = lidPhi();
  const cam = S()?.lidCam;
  const L = [];
  L.push(`LookUp — замер точности, ${new Date().toLocaleString("ru-RU")}`);
  L.push(`Браузер: ${navigator.userAgent.split(") ").pop()}`);
  L.push("");
  L.push("Наклон головы (приложение ↔ эталон по фото):");
  if (h.mae === undefined) L.push(`  данных мало (${h.n} точек, нужно 3+)`);
  else {
    L.push(`  точек: ${h.n}; средняя ошибка ±${fmt(h.mae)}°; смещение ${fmt(h.bias)}°; максимум ${fmt(h.max)}°`);
    if (h.k !== undefined) L.push(`  поправка: ${fmt(h.k, 2)}×показание ${h.b >= 0 ? "+" : "−"}${fmt(Math.abs(h.b))}°; ошибка после поправки ±${fmt(h.maeCorr)}°`);
    L.push(`  вывод: ${verdict(h.mae)}`);
  }
  rows.forEach((r, i) => { const ref = refOf(i); L.push(`  ${r.name}: приложение ${fmt(r.app)}°, эталон ${fmt(ref)}°`); });
  L.push("");
  L.push("Угол экрана:");
  L.push(phi === null ? "  не измерялся" : `  уровень ${fmt(phi)}° (крышка ${fmt(90 + phi, 0)}°); камера ${cam === null || cam === undefined ? "—" : fmt(cam) + "°"}`);
  L.push("");
  L.push("Расстояние до экрана:");
  if (!dists.length) L.push("  не измерялось");
  else {
    dists.forEach((d) => L.push(`  рулетка ${fmt(d.ref, 0)} см, приложение ${fmt(d.est, 0)} см`));
    L.push(`  коэффициент ${k === null ? "—" : fmt(k, 2)}`);
  }
  L.push("");
  L.push("Метод: эталон — угол линии «козелок → внешний уголок глаза» на фото профиля относительно нейтрального фото; расстояние — рулетка; экран — «Уровень» телефона.");
  return L.join("\n");
}

$("repBuild").onclick = () => { $("reportText").textContent = buildReport(); };
$("repCopy").onclick = async () => {
  $("reportText").textContent = buildReport();
  try { await navigator.clipboard.writeText($("reportText").textContent); $("repCopy").textContent = "Скопировано"; setTimeout(() => ($("repCopy").textContent = "Скопировать"), 1500); }
  catch { /* буфер недоступен — текст можно выделить вручную */ }
};
$("repCsv").onclick = () => {
  const out = [["type", "name", "app", "reference", "error"]];
  rows.forEach((r, i) => { const ref = refOf(i); out.push(["head", r.name, r.app ?? "", ref ?? "", r.app !== null && ref !== null ? (r.app - ref).toFixed(2) : ""]); });
  dists.forEach((d) => out.push(["distance_cm", "", d.est.toFixed(1), d.ref, (d.est - d.ref).toFixed(1)]));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.map((r) => r.join(",")).join("\n")], { type: "text/csv" }));
  a.download = "lookup_measure.csv"; a.click();
  URL.revokeObjectURL(a.href);
};

renderRows();
renderDist();
