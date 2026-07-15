import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:5173/";
const WANIM = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\2026-03-18-03-37-56.wanim";
const OUT = process.argv[3] ?? "scripts/timeline-shot.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
const buf = readFileSync(WANIM);
await page.setInputFiles("#file-input", {
  name: WANIM.split(/[\\/]/).pop(),
  mimeType: "application/octet-stream",
  buffer: buf,
});
await page.waitForSelector(".transport-overlay", { timeout: 20000 });
await page.waitForTimeout(1500);

// Zoom in on the timeline with the wheel over the strip center.
const strip = await page.$(".t-timeline");
const box = await strip.boundingBox();
const cx = box.x + box.width * 0.4;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(80);
}
await page.waitForTimeout(400);

const view = await page.evaluate(() => {
  const p = window.__preview;
  return { ok: !!p };
});
console.log("preview:", JSON.stringify(view));

await page.screenshot({ path: OUT });
console.log("screenshot:", OUT);
await browser.close();
if (errors.length) {
  console.log("CONSOLE ERRORS:");
  for (const e of errors.slice(0, 10)) console.log("  ", e);
  process.exit(1);
}
console.log("OK");
