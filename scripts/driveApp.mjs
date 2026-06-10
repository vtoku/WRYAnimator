import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:5173/WANIMxFBX/";
const WANIM = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\2026-03-18-03-37-56.wanim";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
console.log("title:", await page.title());

// Inject the file via the hidden input (DataTransfer drop is flaky headless).
const buf = readFileSync(WANIM);
await page.setInputFiles("#file-input", {
  name: WANIM.split(/[\\/]/).pop(),
  mimeType: "application/octet-stream",
  buffer: buf,
});

// Wait for the loaded UI to appear.
await page.waitForSelector("#loaded-state:not([hidden])", { timeout: 20000 });
await page.waitForSelector("#panel .stats", { timeout: 20000 });
console.log("loaded-state visible");

const stats = await page.$$eval("#panel .stats div", (els) =>
  els.map((d) => d.textContent.replace(/\s+/g, " ").trim()),
);
console.log("stats:", JSON.stringify(stats));

// Confirm canvas exists and has drawn (non-zero size).
const canvas = await page.$eval("#viewport canvas", (c) => ({ w: c.width, h: c.height }));
console.log("canvas:", JSON.stringify(canvas));

// Confirm animation advances: read timecode twice.
const tc1 = await page.textContent("#timecode");
await page.waitForTimeout(1200);
const tc2 = await page.textContent("#timecode");
console.log("timecode:", tc1, "->", tc2, tc1 !== tc2 ? "(advancing)" : "(STATIC!)");

await page.screenshot({ path: "scripts/preview-shot.png" });
console.log("screenshot: scripts/preview-shot.png");

// Test the download button.
const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 30000 }),
  page.click("#download"),
]);
const fname = download.suggestedFilename();
const path = "scripts/downloaded.fbx";
await download.saveAs(path);
const size = readFileSync(path).length;
console.log("download:", fname, (size / 1e6).toFixed(2), "MB");

await browser.close();

if (errors.length) {
  console.log("CONSOLE ERRORS:");
  for (const e of errors.slice(0, 10)) console.log("  ", e);
}
if (tc1 === tc2) throw new Error("animation did not advance");
if (size < 1e6) throw new Error("download too small");
if (errors.length) throw new Error(`${errors.length} console errors`);
console.log("OK");
