// Probe: layers-rail geometry — full content visible (no scrollbars, either
// axis) by default, and the rail reaches the bottom of the timeline dock in
// keys view, curves view, tall docks, and short windows.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:4173/";
const WANIM = "public/sample-idle.wanim";

const browser = await chromium.launch();
const errors = [];

async function boot(viewport) {
  const page = await browser.newPage({ viewport });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.setInputFiles("#file-input", {
    name: "sample-idle.wanim",
    mimeType: "application/octet-stream",
    buffer: readFileSync(WANIM),
  });
  await page.waitForSelector("#loaded-state:not([hidden])", { timeout: 20000 });
  await page.waitForSelector("#dock .stats", { timeout: 20000, state: "attached" });
  await page.waitForSelector(".t-rail:not([hidden])", { timeout: 20000 });
  return page;
}

const measure = (page) => page.evaluate(() => {
  const rail = document.querySelector(".t-rail");
  const panels = document.querySelector(".t-panels");
  const dock = document.querySelector(".timeline-dock");
  const r = rail.getBoundingClientRect();
  const p = panels.getBoundingClientRect();
  const d = dock.getBoundingClientRect();
  return {
    vScroll: rail.scrollHeight > rail.clientHeight + 1,
    hScroll: rail.scrollWidth > rail.clientWidth + 1,
    scrollH: rail.scrollHeight, clientH: rail.clientHeight,
    scrollW: rail.scrollWidth, clientW: rail.clientWidth,
    railBottomGap: Math.round(p.bottom - r.bottom),
    panelsToDockGap: Math.round(d.bottom - p.bottom),
    railH: Math.round(r.height), dockH: Math.round(d.height),
    dockClipped: Math.round(d.bottom - window.innerHeight),
  };
});

const results = {};

// 1. Default 1280x800, keys view, then 3 layers.
let page = await boot({ width: 1280, height: 800 });
results["default"] = await measure(page);
await page.click(".t-rail-head .rail-btn");
await page.click(".t-rail-head .rail-btn");
await page.waitForTimeout(200);
results["3 layers"] = await measure(page);
await page.screenshot({ path: "scripts/rail-3layers.png" });

// 2. Curves view beside the rail.
const curvesBtn = page.locator('.t-seg button[data-view="curves"]');
if (await curvesBtn.isEnabled()) {
  await curvesBtn.click();
  await page.waitForTimeout(200);
  results["curves view"] = await measure(page);
  await page.screenshot({ path: "scripts/rail-curves.png" });
  await page.click('.t-seg button[data-view="keys"]');
}

// 3. Tall dock (grip-drag equivalent).
await page.evaluate(() => {
  document.documentElement.style.setProperty("--timeline-height", "440px");
});
await page.waitForTimeout(200);
results["tall dock"] = await measure(page);
await page.close();

// 4. Short window (laptop with OS scaling) with 3 layers.
page = await boot({ width: 1280, height: 620 });
await page.click(".t-rail-head .rail-btn");
await page.click(".t-rail-head .rail-btn");
await page.waitForTimeout(200);
results["short 620"] = await measure(page);
await page.screenshot({ path: "scripts/rail-short.png" });
await page.close();

// 5. Very short window — worst case squeeze.
page = await boot({ width: 1280, height: 520 });
await page.click(".t-rail-head .rail-btn");
await page.click(".t-rail-head .rail-btn");
await page.waitForTimeout(200);
results["short 520"] = await measure(page);
await page.screenshot({ path: "scripts/rail-veryshort.png" });
await page.close();

await browser.close();

let failed = false;
for (const [label, m] of Object.entries(results)) {
  const bad = m.hScroll || m.vScroll || m.railBottomGap > 4 || m.dockClipped > 0;
  if (bad) failed = true;
  console.log((bad ? "FAIL " : "ok   ") + label + ":", JSON.stringify(m));
}
if (errors.length) {
  console.log("CONSOLE ERRORS:", errors.slice(0, 10));
  failed = true;
}
console.log(failed ? "PROBE FAILED" : "OK");
process.exit(failed ? 1 : 0);
