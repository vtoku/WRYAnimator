// Browser check for face blendshape keys: drive the BUILT app (vite preview),
// key a blendshape from the Rig tab's Face panel, export WANIM, and confirm
// the corrected value is in the file while the other channels are kept.
//   npm run build && node scripts/faceWebProbe.mjs <file.wanim> [screenshot.png]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const { parseWanim } = await import("../src/wanim/parse.ts");

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wanim = process.argv[2];
const shot = process.argv[3];
if (!wanim) { console.error("usage: faceWebProbe <file.wanim> [screenshot.png]"); process.exit(2); }
const PORT = 4181;
const SITE = `http://localhost:${PORT}/`;
if (!existsSync(join(repo, "dist", "index.html"))) throw new Error("no dist/ — run `npm run build` first");
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`); if (!ok) failures++; };
const parse = (path) => { const b = readFileSync(path); return parseWanim(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

const preview = spawn(process.execPath, [join(repo, "node_modules", "vite", "bin", "vite.js"), "preview", "--port", String(PORT), "--strictPort"], { cwd: repo, stdio: "ignore" });
for (let i = 0; ; i++) {
  try { if ((await fetch(SITE)).ok) break; } catch { /* not up yet */ }
  if (i > 60) throw new Error("vite preview did not start");
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.setInputFiles("#file-input", wanim);
  await page.waitForSelector("#facePanel", { timeout: 60000, state: "attached" });
  await page.waitForSelector("#dock .stats", { timeout: 60000, state: "attached" });
  await page.click('.dock-tab[data-tab="rig"]');
  await page.waitForFunction(() => document.querySelectorAll("#faceChan option").length > 10, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  check("Face panel shows on the Rig tab", await page.isVisible("#facePanel"));
  const chan = await page.$eval("#faceChan", (s) => s.value);
  check("a blendshape is preselected", !!chan, chan);

  const setSlider = (v) => page.evaluate((val) => {
    const el = document.getElementById("faceVal");
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, v);
  await page.keyboard.press("Home"); // pause at the first frame
  await page.waitForTimeout(400);
  const before = Number(await page.$eval("#faceVal", (e) => e.value));
  const target = before > 50 ? 10 : 90;
  await setSlider(target);
  await page.waitForTimeout(600);
  const info = await page.$eval("#faceKeyInfo", (e) => e.textContent);
  check("dragging Value keys the blendshape", /^1 key on this layer · key at playhead/.test(info), info);
  check("the slider reads back the keyed value", Number(await page.$eval("#faceVal", (e) => e.value)) === target, `${before}% → ${target}%`);
  check("the channel is marked as keyed", (await page.$eval("#faceChan", (s) => s.selectedOptions[0].text)).startsWith("● "));
  if (shot) await page.screenshot({ path: shot });

  const exportWanim = async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120000 }),
      page.evaluate(() => {
        const sel = document.getElementById("format");
        sel.value = "wanim";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        document.getElementById("download").click();
      }),
    ]);
    return parse(await download.path());
  };
  const src = parse(wanim);
  const srcSet = Object.values(src.characters[0].blendshapes)[0];
  const out = await exportWanim();
  const outSet = Object.values(out.characters[0].blendshapes)[0];
  check("WANIM export has the corrected value at the playhead", Math.abs(outSet[0][chan] - target / 100) < 0.03, `${outSet[0][chan].toFixed(3)}`);
  check("WANIM export keeps every blendshape channel", Object.keys(outSet[0]).length === Object.keys(srcSet[0]).length, `${Object.keys(outSet[0]).length} of ${Object.keys(srcSet[0]).length}`);
  const others = Object.keys(srcSet[0]).filter((k) => k !== chan);
  const worst = Math.max(...others.map((k) => Math.abs(outSet[0][k] - srcSet[0][k])));
  check("other channels match the recording", worst < 1e-3, `worst ${worst.toExponential(1)}`);

  await page.click("#faceKeyDel");
  await page.waitForTimeout(500);
  check("Delete key removes it", (await page.$eval("#faceKeyInfo", (e) => e.textContent)) === "No keys on this layer.");
  check("the value returns to the recording", Number(await page.$eval("#faceVal", (e) => e.value)) === before);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600);
  check("undo brings the key back", /^1 key/.test(await page.$eval("#faceKeyInfo", (e) => e.textContent)));
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  preview.kill();
}
console.log(failures ? `${failures} FAILED` : "faceWebProbe OK");
process.exit(failures ? 1 : 0);
