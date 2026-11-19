// Local agent link, end to end in a real browser: the MCP server edits a
// recording, the BUILT web app (vite preview) connects via the #agent= link,
// loads the recording from 127.0.0.1, and follows the edits live.
//
// Usage: npm run build && node scripts/linkCheck.mjs [file.wanim]
// (defaults to the bundled sample; writes scripts/link-shot.png)
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4173;
const SITE = `http://localhost:${PORT}/`;
let sample = process.argv[2];
if (!sample) {
  sample = join(repo, "public", "sample-idle.wanim");
  if (!existsSync(sample)) spawnSync(process.execPath, ["scripts/makeSampleWanim.mjs"], { cwd: repo, stdio: "ignore" });
}
if (!existsSync(join(repo, "dist", "index.html"))) throw new Error("no dist/ — run `npm run build` first");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

// ---- the site (built output) --------------------------------------------------
const preview = spawn(process.execPath, [join(repo, "node_modules", "vite", "bin", "vite.js"), "preview", "--port", String(PORT), "--strictPort"], { cwd: repo, stdio: "ignore" });
for (let i = 0; ; i++) {
  try { if ((await fetch(SITE)).ok) break; } catch { /* not up yet */ }
  if (i > 60) throw new Error("vite preview did not start");
  await new Promise((r) => setTimeout(r, 250));
}

// ---- the agent side: MCP server over stdio ------------------------------------
const mcp = spawn(process.execPath, [join(repo, "cli", "wry.mjs"), "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, WRY_SITE: SITE } });
const pending = new Map();
let buf = "";
mcp.stdout.setEncoding("utf8");
mcp.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  }
});
let id = 0;
const rpc = (method, params) => new Promise((res) => {
  const my = ++id;
  pending.set(my, res);
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
});
const call = async (name, args) => {
  const r = (await rpc("tools/call", { name, arguments: args })).result;
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.structuredContent;
};

const browser = await chromium.launch();
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "linkCheck", version: "0" } });
  const open = await call("wry_open", { file: sample, timeOffset: 0 });
  const view = await call("wry_view", { open: false });
  check("wry_view returns a link to the site with the code in the fragment", view.url.startsWith(`${SITE}#agent=`) && /#agent=\d+-[0-9a-f]{32}$/.test(view.url), view.url.replace(/-[0-9a-f]+$/, "-<token>"));

  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(view.url, { waitUntil: "domcontentloaded" });

  const pill = page.locator(".agent-pill");
  await pill.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForFunction(() => document.querySelector(".agent-pill")?.dataset.state === "ok", null, { timeout: 60000 });
  check("page connects and shows the session live", /live/.test(await pill.textContent()), await pill.textContent());
  await page.waitForSelector("#dock .stats", { timeout: 20000, state: "attached" });
  const frames = await page.evaluate(() => window.__preview && document.querySelector(".transport-overlay .t-time")?.textContent);
  check("the recording loaded from the local process (transport is live)", !!frames, String(frames));
  const layersBefore = await page.locator(".rail-layer").count();

  // The agent edits; the page must follow without a reload.
  const t = open.timeRange.t0 + (open.timeRange.t1 - open.timeRange.t0) * 0.5;
  await call("wry_layer_create", { name: "agent fix", mode: "override", fade: 0.3 });
  await call("wry_key_set", { layer: "agent fix", bone: "RightHand", time: t, value: { flex: 60, deviation: 0 } });
  await page.waitForFunction(() => [...document.querySelectorAll(".rail-layer .rail-name")].some((e) => e.textContent.includes("agent fix")), null, { timeout: 30000 });
  const layersAfter = await page.locator(".rail-layer").count();
  check("an agent edit appears in the page's layer stack, live", layersAfter >= 1, `${layersBefore} → ${layersAfter} layer row(s)`);
  await page.waitForTimeout(600);
  const tc = (await page.textContent(".transport-overlay .t-time")) ?? "";
  const m = /(\d+):(\d+(?:\.\d+)?)/.exec(tc);
  const shown = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  check("the page's playhead moved to where the agent is working", Math.abs(shown - (t - open.timeRange.t0)) < 0.1, `timecode ${tc.trim()} vs ${(t - open.timeRange.t0).toFixed(2)} s`);

  // Undo on the agent side is followed too.
  await call("wry_undo", {}); await call("wry_undo", {});
  await page.waitForFunction(() => ![...document.querySelectorAll(".rail-layer .rail-name")].some((e) => e.textContent.includes("agent fix")), null, { timeout: 30000 });
  check("an agent undo is followed too", true);
  await call("wry_redo", {}); await call("wry_redo", {});
  await page.waitForFunction(() => [...document.querySelectorAll(".rail-layer .rail-name")].some((e) => e.textContent.includes("agent fix")), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(repo, "scripts", "link-shot.png") });
  console.log("screenshot: scripts/link-shot.png");

  // A page from another origin gets nothing.
  const base = `http://127.0.0.1:${view.code.split("-")[0]}/${view.code.split("-")[1]}`;
  const foreign = await fetch(`${base}/rig/${open.session}`, { headers: { Origin: "https://example.com" } });
  check("a foreign origin is refused (403, no CORS header)", foreign.status === 403 && !foreign.headers.get("access-control-allow-origin"));
  const wrong = await fetch(`http://127.0.0.1:${view.code.split("-")[0]}/deadbeef/events`);
  check("a wrong token is refused (404)", wrong.status === 404);
  const post = await fetch(`${base}/rig/${open.session}`, { method: "POST", body: "{}" });
  check("the link is read-only (POST refused)", post.status === 404);

  check("no console errors in the page", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  mcp.stdin.end();
  mcp.kill();
  preview.kill();
}
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
