// Browser check for the "Unity .anim (beta)" export: drive the BUILT app
// (vite preview), pick the format, download, and sanity-check the file.
//   npm run build && node scripts/animWebProbe.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4179;
const SITE = `http://localhost:${PORT}/`;
if (!existsSync(join(repo, "dist", "index.html"))) throw new Error("no dist/ — run `npm run build` first");
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`); if (!ok) failures++; };

const preview = spawn(process.execPath, [join(repo, "node_modules", "vite", "bin", "vite.js"), "preview", "--port", String(PORT), "--strictPort"], { cwd: repo, stdio: "ignore" });
for (let i = 0; ; i++) {
  try { if ((await fetch(SITE)).ok) break; } catch { /* not up yet */ }
  if (i > 60) throw new Error("vite preview did not start");
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.waitForSelector("#dock .stats", { timeout: 20000, state: "attached" });
  const options = await page.$$eval("#format option", (o) => o.map((x) => `${x.value}=${x.textContent}`));
  check("format menu offers the beta-labelled Unity .anim", options.includes("anim=Unity .anim (beta)"), options.join(", "));
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.evaluate(() => {
      const sel = document.getElementById("format");
      sel.value = "anim";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("download").click();
    }),
  ]);
  const name = download.suggestedFilename();
  const text = readFileSync(await download.path(), "utf8");
  check("download is named *.anim", name.endsWith(".anim"), name);
  check("file is a Unity AnimationClip", text.startsWith("%YAML 1.1") && text.includes("AnimationClip:"));
  check("has muscle, root and finger curves", ["attribute: Spine Front-Back", "attribute: RootT.y", "attribute: LeftHand.Index.1 Stretched"].every((a) => text.includes(a)));
  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`${name}: ${(text.length / 1024).toFixed(0)} KB`);
} finally {
  await browser.close();
  preview.kill();
}
console.log(failures ? `${failures} FAILED` : "animWebProbe OK");
process.exit(failures ? 1 : 0);
