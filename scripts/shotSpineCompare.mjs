import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const URL = "http://localhost:5173/WANIMxFBX/";
const WANIM = "C:\\Users\\VTOKU\\Downloads\\takyon take 2.wanim";
const VRM = "C:\\Users\\VTOKU\\Downloads\\AshtonMartenARKIT.vrm";

async function shot(useVrm, outName) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.setInputFiles("#file-input", { name: "c.wanim", mimeType: "application/octet-stream", buffer: readFileSync(WANIM) });
  await page.waitForSelector("#loaded-state:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(1200);
  if (useVrm) {
    await page.selectOption("#body", "vrm").catch(() => {});
    await page.setInputFiles("#bodyfile", { name: "v.vrm", mimeType: "application/octet-stream", buffer: readFileSync(VRM) });
    await page.waitForTimeout(4000);
  } else {
    await page.waitForTimeout(2500);
  }
  // Pause, then seek to the very start (t=0, rest/T-pose).
  await page.click("#viewport .transport-overlay button").catch(() => {});
  const tl = await page.$("#viewport .transport-overlay .t-timeline, #viewport .transport-overlay .t-track, #viewport .transport-overlay");
  // Click far-left of the transport bar to seek near 0.
  const tb = await (await page.$("#viewport .transport-overlay")).boundingBox();
  await page.mouse.click(tb.x + 70, tb.y + tb.height / 2);
  await page.waitForTimeout(300);
  // Orbit to side view.
  const cv = await page.$("#viewport canvas"); const b = await cv.boundingBox();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 11; i++) await page.mouse.wheel(0, 240);
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 130, cy, { steps: 18 }); await page.mouse.up();
  await page.waitForTimeout(500);
  await page.screenshot({ path: outName });
  console.log(outName, "tc=", await page.textContent("#viewport .transport-overlay .t-time").catch(() => "?"));
  await browser.close();
}
await shot(false, "scripts/spine-xbot.png");
await shot(true, "scripts/spine-vrm.png");
