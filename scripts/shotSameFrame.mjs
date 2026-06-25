import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const URL = "http://localhost:5173/WANIMxFBX/";
const WANIM = "C:\\Users\\VTOKU\\Downloads\\takyon take 2.wanim";
const VRM = "C:\\Users\\VTOKU\\Downloads\\AshtonMartenARKIT.vrm";
const T = Number(process.argv[2] ?? 3.5); // seconds

async function shot({ vrm, noGapRot, out }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  if (noGapRot) await page.addInitScript(() => { window.__noGapRot = true; });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.setInputFiles("#file-input", { name: "c.wanim", mimeType: "application/octet-stream", buffer: readFileSync(WANIM) });
  await page.waitForSelector("#loaded-state:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(1000);
  if (vrm) {
    await page.selectOption("#body", "vrm").catch(() => {});
    await page.setInputFiles("#bodyfile", { name: "v.vrm", mimeType: "application/octet-stream", buffer: readFileSync(VRM) });
    await page.waitForTimeout(4000);
  } else {
    await page.waitForTimeout(2500);
  }
  // Set up the camera FIRST (while still playing — pose doesn't matter yet).
  const cv = await page.$("#viewport canvas"); const b = await cv.boundingBox();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 11; i++) await page.mouse.wheel(0, 240);
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 140, cy, { steps: 18 }); await page.mouse.up();
  // Pause + seek precisely via the test hook (deterministic).
  await page.evaluate((t) => { const p = window.__preview; p.pause(); p.seek(t); }, T);
  await page.waitForTimeout(250);
  await page.screenshot({ path: out });
  console.log(out, "tc=", await page.textContent(".transport-overlay .t-time").catch(() => "?"));
  await browser.close();
}
await shot({ vrm: false, out: "scripts/sf-xbot.png" });
await shot({ vrm: true, noGapRot: false, out: "scripts/sf-vrm.png" });
