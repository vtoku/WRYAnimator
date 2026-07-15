import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:5173/";
const WANIM = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\2026-03-18-03-37-56.wanim";
const OUT = process.argv[3] ?? "scripts/channels-shot.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
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

// Open the curve panel (cycle the Keys/Curves toggle to "curves").
const toggle = await page.$(".t-dope-toggle");
for (let i = 0; i < 3; i++) {
  const label = (await toggle.textContent())?.trim();
  if (label?.startsWith("Curves")) break;
  await toggle.click();
  await page.waitForTimeout(150);
}
// Switch to Channels mode.
await page.click('.cv-mode button[data-mode="channels"]');
await page.waitForTimeout(300);

// Search for a finger; select several finger rows (re-query each click since
// the tree re-renders on selection change).
await page.fill(".cv-search", "index");
await page.waitForTimeout(250);
for (let i = 0; i < 4; i++) {
  const row = page.locator(".cv-row").nth(i);
  if (await row.count()) { await row.click({ modifiers: ["Control"] }); await page.waitForTimeout(100); }
}
await page.waitForTimeout(300);

const info = await page.evaluate(() => {
  const canvas = document.querySelector(".t-curves canvas");
  const rows = document.querySelectorAll(".cv-row").length;
  return { hasCanvas: !!canvas, rows };
});
console.log("channels:", JSON.stringify(info));

await page.screenshot({ path: OUT });
console.log("screenshot:", OUT);
await browser.close();
if (errors.length) {
  console.log("CONSOLE ERRORS:");
  for (const e of errors.slice(0, 10)) console.log("  ", e);
  process.exit(1);
}
console.log("OK");
