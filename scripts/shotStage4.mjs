import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:5173/";
const WANIM = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\2026-03-18-03-37-56.wanim";

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

// Pin planted feet -> plant chips + timeline underlines.
await page.check("#fixFeet");
await page.waitForTimeout(2500);
const plants = await page.$$eval("#plantList .rig-key", (els) => els.length);
console.log("plant chips:", plants);
// Zoom in so the plant underlines are visible.
const strip = await page.$(".t-timeline");
const box = await strip.boundingBox();
await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
await page.waitForTimeout(400);
await page.screenshot({ path: "scripts/plants-shot.png" });
console.log("screenshot: scripts/plants-shot.png");

// Export tab -> key reduction analysis.
await page.click("#menubar .menu-btn:has-text('File')");
await page.click(".menu-panel .menu-item:has-text('Export...')");
await page.waitForTimeout(200);
await page.click("#reduceAnalyze");
await page.waitForTimeout(500);
const total = await page.textContent("#reduceStats");
console.log("reduction:", total.replace(/\s+/g, " ").slice(0, 200));
await page.screenshot({ path: "scripts/reduce-shot.png" });
console.log("screenshot: scripts/reduce-shot.png");

await browser.close();
if (errors.length) { console.log("CONSOLE ERRORS:"); for (const e of errors.slice(0, 10)) console.log("  ", e); process.exit(1); }
console.log("OK");
