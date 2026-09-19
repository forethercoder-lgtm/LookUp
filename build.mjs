// Генерирует mac/, windows/ и measure/ из template.html.
// Запуск: node build.mjs (результат коммитится, Vercel собирать ничего не нужно).
import fs from "node:fs";

const template = fs.readFileSync(new URL("./template.html", import.meta.url), "utf8");
const [preLive, postLive] = fs.readFileSync(new URL("./measure-sections.html", import.meta.url), "utf8").split("<!--SPLIT-->");

const NAV_APP = `<a href="#setup">Экран</a>
    <a href="#live">Контроль</a>
    <a href="#experiment">Тест</a>
    <a href="../">Система</a>`;
const NAV_MEASURE = `<a href="#guide">Инструкция</a>
    <a href="#live">Старт</a>
    <a href="#mHead">Голова</a>
    <a href="#mScreen">Экран</a>
    <a href="#mDist">Расстояние</a>
    <a href="#mReport">Отчёт</a>`;

const targets = {
  mac: { TITLE: "LookUp для Mac", BADGE: "Mac", PLATFORM: "mac", BODYCLASS: "", NAV: NAV_APP, PRE_LIVE: "", POST_LIVE: "", EXTRA_SCRIPT: "" },
  windows: { TITLE: "LookUp для Windows", BADGE: "Windows", PLATFORM: "windows", BODYCLASS: "", NAV: NAV_APP, PRE_LIVE: "", POST_LIVE: "", EXTRA_SCRIPT: "" },
  measure: {
    TITLE: "LookUp — замер точности", BADGE: "Замер", PLATFORM: "mac", BODYCLASS: "measurePage", NAV: NAV_MEASURE,
    PRE_LIVE: preLive, POST_LIVE: postLive, EXTRA_SCRIPT: '<script type="module" src="../measure.js"></script>',
  },
};

for (const [dirName, vars] of Object.entries(targets)) {
  const dir = new URL(`./${dirName}/`, import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  let html = template;
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`{{${k}}}`, v);
  fs.writeFileSync(new URL("index.html", dir), html);
  console.log("built", dirName);
}
