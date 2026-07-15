import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:5173/";
const WANIM = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\2026-03-18-03-37-56.wanim";
const OUT = process.argv[3] ?? "scripts/filters-shot.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
const buf = readFileSync(WANIM);
await page.setInputFiles("#file-input", { name: WANIM.split(/[\\/]/).pop(), mimeType: "application/octet-stream", buffer: buf });
await page.waitForSelector(".transport-overlay", { timeout: 20000 });
await page.waitForTimeout(1500);

// Open curves -> Channels, then select the Right hand group.
const toggle = await page.$(".t-dope-toggle");
for (let i = 0; i < 3; i++) {
  if ((await toggle.textContent())?.trim().startsWith("Curves")) break;
  await toggle.click(); await page.waitForTimeout(120);
}
await page.click('.cv-mode button[data-mode="channels"]');
await page.waitForTimeout(200);
await page.fill(".cv-search", "hand");
await page.waitForTimeout(200);
await page.locator(".cv-group", { hasText: "Right hand" }).first().click();
await page.waitForTimeout(200);

const sel = await page.evaluate(() => document.querySelectorAll(".cv-row.sel").length);
console.log("selected rows:", sel);

// Set a trim window so the filter is scoped, then add a Butterworth filter.
await page.click(".t-setin");        // trim start at playhead (~0)
await page.waitForTimeout(100);
// Seek to ~40% and set out.
await page.evaluate(() => window.__preview.seek(window.__preview.getTime() + 40));
await page.waitForTimeout(100);
await page.click(".t-setout");
await page.waitForTimeout(100);

await page.click('.dock-tab[data-tab="clean"]');
await page.click("#filterAdd");
await page.waitForTimeout(600);

const ops = await page.$$eval("#filterList .rig-key", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
console.log("filter ops:", JSON.stringify(ops));

await page.screenshot({ path: OUT });
console.log("screenshot:", OUT);
await browser.close();
if (errors.length) { console.log("CONSOLE ERRORS:"); for (const e of errors.slice(0, 10)) console.log("  ", e); process.exit(1); }
console.log("OK");
