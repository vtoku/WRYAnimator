// DCC-boot probe: the editor is on screen immediately with the menu bar, no
// landing/dropzone, and a DISABLED transport; loading a file enables it and
// hides the dim prompt; the session auto-restores on reload; "Load another
// file" returns to the empty editor and forgets the session. Also asserts the
// Help shortcuts overlay lists every entry of the shared SHORTCUTS table.
// Usage: node scripts/bootCheck.mjs [file.wanim]   (dev server must be running)
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL ?? "http://localhost:5173/";
const WANIM = process.argv[2] ?? process.env.WANIM_SAMPLE ??
  `${process.env.USERPROFILE ?? ""}\\Downloads\\2026-03-18-03-37-56.wanim`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // one context = persistent IndexedDB
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

// 1. Boot: editor chrome + canvas + dim prompt, menu bar, NO dropzone, and a
//    disabled transport — all with no file loaded.
await page.goto(URL, { waitUntil: "networkidle" });
const bootEditor = await page.$eval("#loaded-state", (el) => !el.hidden);
const bootCanvas = !!(await page.$("#viewport canvas"));
const bootPrompt = await page.$eval("#empty-state", (el) => !el.hidden);
const menuLabels = await page.$$eval("#menubar .menu-btn", (b) => b.map((x) => x.textContent));
const bootMenus = ["File", "Edit", "View", "Help"].every((l) => menuLabels.includes(l));
const noDropzone = !(await page.$("#dropzone"));
const transportDisabledEmpty = await page.$eval(".transport-overlay .t-play", (b) => b.disabled).catch(() => false);
console.log("boot: editor", bootEditor, "· canvas", bootCanvas, "· prompt", bootPrompt,
  "· menus", bootMenus, "· no dropzone", noDropzone, "· transport disabled", transportDisabledEmpty);

// 1b. Help > Keyboard shortcuts overlay lists every shared-table entry.
// By label, not index — menu count changes as menus are added (Time, etc.).
await page.click("#menubar .menu-btn:has-text('Help')");
await page.waitForSelector(".menu-panel");
await page.click(".menu-panel .menu-item"); // first Help item = Keyboard shortcuts
await page.waitForSelector(".shortcuts-body");
const overlayKeys = await page.$$eval(".shortcuts-body kbd", (k) => k.map((x) => x.textContent));
const tableKeys = await page.evaluate(() => (window.__shortcuts ?? []).map((s) => s.keys));
const missingKeys = tableKeys.filter((k) => !overlayKeys.includes(k));
console.log("shortcuts overlay: table entries", tableKeys.length, "· missing", JSON.stringify(missingKeys));
await page.keyboard.press("Escape");

// 2. Load a file through the input — prompt hides, transport enables, dock fills.
await page.setInputFiles("#file-input", {
  name: WANIM.split(/[\\/]/).pop(),
  mimeType: "application/octet-stream",
  buffer: readFileSync(WANIM),
});
await page.waitForSelector("#dock .stats", { timeout: 20000, state: "attached" });
const promptGone = await page.$eval("#empty-state", (el) => el.hidden);
const transportEnabled = await page.$eval(".transport-overlay .t-play", (b) => !b.disabled).catch(() => false);
console.log("after load: prompt hidden", promptGone, "· transport enabled", transportEnabled);
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
const promptBack = await page.$eval("#empty-state", (el) => !el.hidden);
console.log("reset: prompt back", promptBack);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const staysEmpty = await page.$eval("#empty-state", (el) => !el.hidden);
console.log("reload after reset: stays empty", staysEmpty);

// 5. Body-only session: a VRM with no recording gives a working session with
//    the Shogun export; dropping a recording on top upgrades in place.
const VRM = process.env.VRM_SAMPLE ?? `${process.env.USERPROFILE ?? ""}\\Downloads\\Flayon.vrm`;
let bodyOnlyOk = true;
try {
  readFileSync(VRM);
} catch {
  console.log("body-only: SKIP (no VRM sample at", VRM + ")");
}
if (bodyOnlyOk) {
  try {
    await page.setInputFiles("#file-input", {
      name: VRM.split(/[\\/]/).pop(),
      mimeType: "application/octet-stream",
      buffer: readFileSync(VRM),
    });
    await page.waitForSelector("#shogunDl", { timeout: 30000, state: "attached" });
    await page.click('.dock-tab[data-tab="export"]');
    await page.waitForSelector("#shogunDl", { timeout: 5000, state: "visible" });
    const promptHiddenBody = await page.$eval("#empty-state", (el) => el.hidden);
    const transportStillOff = await page.$eval(".transport-overlay .t-play", (b) => b.disabled).catch(() => true);
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.click("#shogunDl"),
    ]);
    const shogunName = dl.suggestedFilename();
    // Upgrade in place: drop the recording, full session appears.
    await page.setInputFiles("#file-input", {
      name: WANIM.split(/[\\/]/).pop(),
      mimeType: "application/octet-stream",
      buffer: readFileSync(WANIM),
    });
    await page.waitForSelector("#dock .stats", { timeout: 30000, state: "attached" });
    const upgradedTransport = await page.$eval(".transport-overlay .t-play", (b) => !b.disabled).catch(() => false);
    console.log("body-only: prompt hidden", promptHiddenBody, "· transport off", transportStillOff,
      "· shogun dl", JSON.stringify(shogunName), "· upgraded", upgradedTransport);
    bodyOnlyOk = promptHiddenBody && transportStillOff && shogunName.endsWith("-shogun.fbx") && upgradedTransport;
  } catch (e) {
    console.log("body-only: FAILED", String(e));
    bodyOnlyOk = false;
  }
}

await page.screenshot({ path: "scripts/boot-shot.png" });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
const ok = bootEditor && bootCanvas && bootPrompt && bootMenus && noDropzone && transportDisabledEmpty
  && missingKeys.length === 0 && promptGone && transportEnabled && restoredName && promptBack && staysEmpty
  && bodyOnlyOk && !errors.length;
console.log(ok ? "OK" : "PROBE FAILED");
process.exit(ok ? 0 : 1);
