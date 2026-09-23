// Генерирует mac/, windows/, measure/ (из template.html) и sources/ (из sources.json).
// Запуск: node build.mjs (результат коммитится, Vercel собирать ничего не нужно).
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const write = (dirName, html) => {
  const dir = new URL(`./${dirName}/`, import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(new URL("index.html", dir), html);
  console.log("built", dirName);
};

const template = read("./template.html");
const [preLive, postLive] = read("./measure-sections.html").split("<!--SPLIT-->");

const NAV_APP = `<a href="#setup">Экран</a>
    <a href="#live">Контроль</a>
    <a href="#spine">Позвоночник</a>
    <a href="#insights">LUP AI</a>
    <a href="../sources/">Источники</a>
    <a href="../">Система</a>`;
const NAV_MEASURE = `<a href="#guide">Инструкция</a>
    <a href="#live">Старт</a>
    <a href="#mHead">Голова</a>
    <a href="#mScreen">Экран</a>
    <a href="#mDist">Расстояние</a>
    <a href="#mReport">Отчёт</a>
    <a href="../sources/">Источники</a>`;

const targets = {
  mac: { TITLE: "LookUp для Mac", BADGE: "Mac", PLATFORM: "mac", BODYCLASS: "", NAV: NAV_APP, PRE_LIVE: "", POST_LIVE: "", EXTRA_SCRIPT: "" },
  windows: { TITLE: "LookUp для Windows", BADGE: "Windows", PLATFORM: "windows", BODYCLASS: "", NAV: NAV_APP, PRE_LIVE: "", POST_LIVE: "", EXTRA_SCRIPT: "" },
  measure: {
    TITLE: "LookUp — замер точности", BADGE: "Замер", PLATFORM: "mac", BODYCLASS: "measurePage", NAV: NAV_MEASURE,
    PRE_LIVE: preLive, POST_LIVE: postLive, EXTRA_SCRIPT: ['<script type="module" src="../measure.js"></script>', '<script type="module" src="../measure-guide.js"></script>'].join("\n"),
  },
};

for (const [dirName, vars] of Object.entries(targets)) {
  let html = template;
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`{{${k}}}`, v);
  write(dirName, html);
}

/* ---------- страница «Источники» из sources.json ---------- */
const S = JSON.parse(read("./sources.json"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const item = (it) => `
      <article class="card glass srcItem">
        <div class="srcMeta">
          <span class="chip ${it.status === "checked" ? "ok" : "warn"}">${it.status === "checked" ? "Проверено на странице" : "По выдаче поиска"}</span>
          <span class="srcOrg">${esc(it.org)}</span>
        </div>
        <h3><a href="${it.url}" target="_blank" rel="noopener">${esc(it.name)}</a></h3>
        <p>${esc(it.says)}</p>
        <p class="srcUse"><b>В LookUp:</b> ${esc(it.use)}</p>
      </article>`;
const sourcesPage = `<!DOCTYPE html>
<html lang="ru" data-platform="mac">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LookUp — источники</title>
<meta name="description" content="Откуда взяты нормы и цифры LookUp: официальные рекомендации США и Канады, исследования, ограничения.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%230a0a0b%22/%3E%3Cpath d=%22M12 17V7M7.5 11.5 12 7l4.5 4.5%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E">
<link rel="stylesheet" href="../style.css">
</head>
<body>
<div class="bg" aria-hidden="true"><i></i><i></i><i></i></div>
<header class="top glass">
  <a class="brand" href="../">
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#0a0a0b"/><path d="M12 17V7M7.5 11.5 12 7l4.5 4.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    LookUp <em class="badge">Источники</em>
  </a>
  <nav><a href="../mac/">Mac</a><a href="../windows/">Windows</a><a href="../measure/">Замер</a></nav>
</header>
<main>
  <section class="hero" style="padding-bottom:0">
    <div>
      <h1>Источники</h1>
      <p class="lead">Откуда взяты нормы и цифры. Обновлено ${S.updated}.</p>
    </div>
  </section>
  <section>
    <div class="card glass legendCard">
      <span class="chip ok">Проверено на странице</span> ${esc(S.legend.checked.split(": ")[1])}<br>
      <span class="chip warn">По выдаче поиска</span> ${esc(S.legend.search.split(": ")[1])}
    </div>
  </section>
${S.groups.map((g) => `  <section>
    <h2>${esc(g.title)}</h2>
    <div class="srcGrid">${g.items.map(item).join("")}
    </div>
  </section>`).join("\n")}
  <section>
    <h2>Ограничения</h2>
    <div class="card glass">
      <ul class="plain">${S.limits.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    </div>
  </section>
</main>
<footer>LookUp — не медицинское устройство и не заменяет консультацию врача. Боль, отдающая в руку, онемение или слабость — к врачу.</footer>
</body>
</html>
`;
write("sources", sourcesPage);
