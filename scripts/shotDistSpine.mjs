import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const URL = "http://localhost:5173/WANIMxFBX/";
const WANIM = "C:\\Users\\VTOKU\\Downloads\\takyon take 2.wanim";
const VRM = "C:\\Users\\VTOKU\\Downloads\\AshtonMartenARKIT.vrm";
const T = Number(process.argv[2] ?? 3.5);

async function shot(dist, out) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.setInputFiles("#file-input", { name: "c.wanim", mimeType: "application/octet-stream", buffer: readFileSync(WANIM) });
  await page.waitForSelector("#loaded-state:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.selectOption("#body", "vrm").catch(() => {});
  await page.setInputFiles("#bodyfile", { name: "v.vrm", mimeType: "application/octet-stream", buffer: readFileSync(VRM) });
  await page.waitForTimeout(4000);
  if (dist) {
    await page.evaluate(() => document.getElementById("distSpine").click());
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  // camera: zoom out, side view
  const cv = await page.$("#viewport canvas"); const b = await cv.boundingBox();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 11; i++) await page.mouse.wheel(0, 240);
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 140, cy, { steps: 18 }); await page.mouse.up();
  await page.evaluate((t) => { const p = window.__preview; p.pause(); p.seek(t); }, T);
  await page.waitForTimeout(250);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 400, height: 900 } });
  console.log(out, "dist=", dist, "tc=", await page.textContent(".transport-overlay .t-time").catch(() => "?"));
  await browser.close();
}
await shot(false, "scripts/ds-off.png");
await shot(true, "scripts/ds-on.png");
