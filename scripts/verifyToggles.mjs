import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:5173/WANIMxFBX/";
const WANIM = "C:\\Users\\VTOKU\\Downloads\\2026-03-18-03-37-56.wanim";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.setInputFiles("#file-input", {
  name: "clip.wanim",
  mimeType: "application/octet-stream",
  buffer: readFileSync(WANIM),
});
await page.waitForSelector("#loaded-state:not([hidden])", { timeout: 20000 });

await page.selectOption("#names", "motionbuilder");
await page.selectOption("#rest", "tpose");

const [dl] = await Promise.all([
  page.waitForEvent("download", { timeout: 30000 }),
  page.click("#download"),
]);
await dl.saveAs("scripts/verify.fbx");
const fbx = readFileSync("scripts/verify.fbx", "utf8");
await browser.close();

const checks = {
  "LeftArm (MoBu)": fbx.includes('Model::LeftArm"'),
  "LeftForeArm (MoBu)": fbx.includes('Model::LeftForeArm"'),
  "LeftUpLeg (MoBu)": fbx.includes('Model::LeftUpLeg"'),
  "LeftHandThumb1 (MoBu)": fbx.includes('Model::LeftHandThumb1"'),
  "no Unity LeftUpperArm": !fbx.includes('Model::LeftUpperArm"'),
};
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  console.log(`  ${v ? "✓" : "✗"} ${k}`);
  ok = ok && v;
}
// T-pose rest: at least one limb LimbNode default Lcl Rotation is 0,0,0.
const tposeOk = /Model::LeftForeArm[\s\S]*?Lcl Rotation", "Lcl Rotation", "", "A",0,0,0/.test(fbx);
console.log(`  ${tposeOk ? "✓" : "✗"} LeftForeArm rest rotation is 0,0,0 (T-pose)`);
console.log((ok && tposeOk) ? "OK" : "FAIL");
process.exit(ok && tposeOk ? 0 : 1);
