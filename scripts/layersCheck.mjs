// Layers rail: adding, configuring, renaming, reordering, duplicating and
// deleting layers — all without opening a dropdown.
//
// Usage: npm run build && node scripts/layersCheck.mjs
// (drives the BUILT app via vite preview; writes scripts/layers-shot.png)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4174;
const SITE = `http://localhost:${PORT}/`;
if (!existsSync(join(repo, "dist", "index.html"))) throw new Error("no dist/ — run `npm run build` first");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

const preview = spawn(process.execPath, [join(repo, "node_modules", "vite", "bin", "vite.js"), "preview", "--port", String(PORT), "--strictPort"], { cwd: repo, stdio: "ignore" });
for (let i = 0; ; i++) {
  try { if ((await fetch(SITE)).ok) break; } catch { /* not up yet */ }
  if (i > 60) throw new Error("vite preview did not start");
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.waitForSelector("#dock .stats", { timeout: 20000, state: "attached" });
  await page.waitForSelector(".t-rail:not([hidden])", { timeout: 20000 });

  const names = () => page.$$eval(".rail-layer", (rows) => rows.map((r) => (r.querySelector(".rail-name")?.textContent ?? "") + ":" + (r.querySelector(".rail-chip")?.textContent ?? "")));
  const start = await names();
  check("a fresh session starts with one layer and both add buttons", start.length === 1 && (await page.locator(".rail-add").count()) === 2, JSON.stringify(start));
  check("no dropdown menus in the layers rail", (await page.locator(".t-rail select").count()) === 0);

  await page.click(".rail-add:has-text('Override')");
  let now = await names();
  check("+ Override adds an override layer in one click, on top and active",
    now.length === 2 && now[0].endsWith(":OVR") && (await page.locator(".rail-layer.active .rail-chip").textContent()) === "OVR", JSON.stringify(now));
  await page.click(".rail-add:has-text('Additive')");
  now = await names();
  check("+ Additive adds an additive layer in one click", now.length === 3 && now[0].endsWith(":ADD"), JSON.stringify(now));

  // Mode / extent are segmented toggles.
  await page.click(".rail-detail .rail-seg button:has-text('Override')");
  check("Mode toggle switches the active layer with one click", (await page.locator(".rail-layer.active .rail-chip").textContent()) === "OVR");
  await page.click(".rail-detail .rail-seg button:has-text('Hold')");
  check("Extent → Hold hides the fade slider", (await page.locator(".rail-detail .rail-fade").count()) === 0);
  await page.click(".rail-detail .rail-seg button:has-text('Fade')");
  check("Extent → Fade brings it back", (await page.locator(".rail-detail .rail-fade").count()) === 1);

  // Rename by double-click; typing must not fire editor hotkeys.
  await page.dblclick(".rail-layer.active .rail-name");
  await page.waitForSelector(".rail-rename");
  await page.keyboard.type("Wrist fix");
  await page.keyboard.press("Enter");
  now = await names();
  check("double-click renames a layer", now[0].startsWith("Wrist fix:"), JSON.stringify(now));

  // Reorder, duplicate, delete.
  await page.click(".rail-act:has-text('↓')");
  now = await names();
  check("↓ moves the layer down and keeps it active", now[1].startsWith("Wrist fix:") && (await page.locator(".rail-layer.active .rail-name").textContent()) === "Wrist fix", JSON.stringify(now));
  await page.click(".rail-act:has-text('Duplicate')");
  now = await names();
  check("Duplicate copies the layer above it", now.length === 4 && now.includes("Wrist fix copy:OVR"), JSON.stringify(now));
  await page.screenshot({ path: join(repo, "scripts", "layers-shot.png") });
  console.log("screenshot: scripts/layers-shot.png");
  await page.click(".rail-act:has-text('Delete')");
  now = await names();
  check("Delete removes it", now.length === 3 && !now.includes("Wrist fix copy:OVR"), JSON.stringify(now));

  // Undo covers all of it.
  await page.keyboard.press("Control+z");
  now = await names();
  check("Ctrl+Z restores the deleted layer", now.length === 4, JSON.stringify(now));

  // Deleting everything leaves the header and a hint, so layers can be added again.
  for (let i = 0; i < 6 && (await page.locator(".rail-layer").count()) > 0; i++) {
    await page.click(".rail-layer >> nth=0");
    await page.click(".rail-act:has-text('Delete')");
  }
  check("with no layers the add buttons and a hint remain",
    (await page.locator(".rail-layer").count()) === 0 && (await page.locator(".rail-add").count()) === 2 && (await page.locator(".rail-empty").count()) === 1);
  await page.click(".rail-add:has-text('Additive')");
  check("and a layer can be added again", (await page.locator(".rail-layer").count()) === 1);

  const scroll = await page.$eval(".t-rail", (r) => ({ h: r.scrollWidth > r.clientWidth + 1 }));
  check("the rail does not scroll sideways", !scroll.h);
  check("no console errors in the page", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  preview.kill();
}
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
