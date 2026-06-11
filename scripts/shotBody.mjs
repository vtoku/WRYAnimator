import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const URL = process.env.APP_URL ?? "http://localhost:5173/WANIMxFBX/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.setInputFiles("#file-input", { name: "clip.wanim", mimeType: "application/octet-stream", buffer: readFileSync("C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim") });
await page.waitForSelector("#loaded-state:not([hidden])", { timeout: 20000 });
await page.waitForTimeout(3500); // body + face async load
await page.screenshot({ path: "scripts/body-shot.png" });
if (errors.length) { console.log("ERRORS:"); errors.slice(0, 6).forEach((e) => console.log(" ", e)); }
else console.log("no console errors");
await browser.close();
