import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const URL = "http://localhost:5173/WANIMxFBX/";
const WANIM = "C:\\Users\\VTOKU\\Downloads\\takyon take 2.wanim";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/texture/.test(m.text())) errors.push(m.text()); });
await page.goto(URL, { waitUntil: "networkidle" });
await page.setInputFiles("#file-input", { name: "c.wanim", mimeType: "application/octet-stream", buffer: readFileSync(WANIM) });
await page.waitForSelector("#loaded-state:not([hidden])", { timeout: 20000 });
await page.waitForTimeout(2500);
// scroll the panel to the download row
await page.evaluate(() => document.querySelector(".download-row")?.scrollIntoView({ block: "center" }));
await page.waitForTimeout(300);
await page.screenshot({ path: "scripts/download-row.png", clip: { x: 720, y: 0, width: 380, height: 900 } });

// Test all three downloads work.
import { statSync } from "node:fs";
for (const fmt of ["fbx", "vrma", "wanim"]) {
  await page.selectOption("#format", fmt);
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click("#download"),
  ]);
  const path = `scripts/dl-out.${fmt}`;
  await dl.saveAs(path);
  console.log(fmt, "->", dl.suggestedFilename(), (statSync(path).size / 1e6).toFixed(2), "MB");
}
// Re-parse the downloaded .wanim to confirm it is valid.
const { parseWanim } = await import("../src/wanim/parse.ts");
const wb = readFileSync("scripts/dl-out.wanim");
const rt = parseWanim(wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength));
console.log("re-parsed wanim:", rt.times.length, "frames,", rt.characters.length, "char(s), v" + rt.version);
if (errors.length) errors.slice(0, 5).forEach((e) => console.log("ERR", e)); else console.log("no console errors");
await browser.close();
