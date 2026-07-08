// DCC-boot probe: editor visible immediately, session auto-restore on reload,
// "Load another file" returns to the empty editor and forgets the session.
// Usage: node scripts/bootCheck.mjs [file.wanim]   (dev server must be running)
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:5173/";
const WANIM = process.argv[2] ?? "C:\\Users\\chaes\\Downloads\\BlackSheep-2-2026-05-24-19-05-57.wanim";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // one context = persistent IndexedDB
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

// 1. Boot: editor chrome + viewport canvas + drop overlay, all with NO file.
await page.goto(URL, { waitUntil: "networkidle" });
const bootEditor = await page.$eval("#loaded-state", (el) => !el.hidden);
const bootCanvas = !!(await page.$("#viewport canvas"));
const bootOverlay = await page.$eval("#empty-state", (el) => !el.hidden);
const bootOpenBtn = !!(await page.$("#ebOpen"));
console.log("boot: editor", bootEditor, "· canvas", bootCanvas, "· overlay", bootOverlay, "· toolbar Open", bootOpenBtn);

// 2. Load a file through the overlay's input — overlay hides, editor populates.
await page.setInputFiles("#file-input", {
  name: WANIM.split(/[\\/]/).pop(),
  mimeType: "application/octet-stream",
  buffer: readFileSync(WANIM),
});
await page.waitForSelector("#dock .stats", { timeout: 20000, state: "attached" });
const overlayGone = await page.$eval("#empty-state", (el) => el.hidden);
console.log("after load: overlay hidden", overlayGone);
await page.waitForTimeout(2500); // let saveLastSession + reclean settle

// 3. Reload: the session must reopen WITHOUT any file input.
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#dock .stats", { timeout: 30000, state: "attached" });
const restoredName = await page.$eval("#dock h2", (el) => el.textContent);
const note = await page.$eval("#rigCacheNote", (el) => el.textContent).catch(() => "");
console.log("restore: stats visible · name", JSON.stringify(restoredName), "· note", JSON.stringify(note));

// 4. "Load another file" (Info tab) → empty editor again, session forgotten.
await page.click('.dock-tab[data-tab="info"]');
await page.click("#reset");
await page.waitForTimeout(1200);
const overlayBack = await page.$eval("#empty-state", (el) => !el.hidden);
console.log("reset: overlay back", overlayBack);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const staysEmpty = await page.$eval("#empty-state", (el) => !el.hidden);
console.log("reload after reset: stays empty", staysEmpty);

await page.screenshot({ path: "scripts/boot-shot.png" });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
const ok = bootEditor && bootCanvas && bootOverlay && bootOpenBtn && overlayGone && restoredName && overlayBack && staysEmpty && !errors.length;
console.log(ok ? "OK" : "PROBE FAILED");
process.exit(ok ? 0 : 1);
