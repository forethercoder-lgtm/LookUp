// Генерирует mac/index.html и windows/index.html из template.html.
// Запуск: node build.mjs (результат коммитится, Vercel собирать ничего не нужно).
import fs from "node:fs";

const template = fs.readFileSync(new URL("./template.html", import.meta.url), "utf8");
const targets = {
  mac: { TITLE: "LookUp для Mac", BADGE: "Mac" },
  windows: { TITLE: "LookUp для Windows", BADGE: "Windows" },
};

for (const [platform, vars] of Object.entries(targets)) {
  const dir = new URL(`./${platform}/`, import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  const html = template
    .replaceAll("{{PLATFORM}}", platform)
    .replaceAll("{{TITLE}}", vars.TITLE)
    .replaceAll("{{BADGE}}", vars.BADGE);
  fs.writeFileSync(new URL("index.html", dir), html);
  console.log("built", platform);
}
