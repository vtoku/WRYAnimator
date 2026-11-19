// Probe the DEPLOYED site: does https://wryanimator.com connect to a local
// agent session (https page → http://127.0.0.1) and follow an edit?
//
// Usage: node scripts/liveLinkProbe.mjs [file.wanim] [siteUrl]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sample = process.argv[2] ?? join(repo, "public", "sample-idle.wanim");
const SITE = process.argv[3] ?? "https://wryanimator.com/";

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
const rpc = (method, params) => new Promise((res) => { const my = ++id; pending.set(my, res); mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`); });
const call = async (name, args) => {
  const r = (await rpc("tools/call", { name, arguments: args })).result;
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.structuredContent;
};

const browser = await chromium.launch();
let ok = false;
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "liveLinkProbe", version: "0" } });
  const open = await call("wry_open", { file: sample, timeOffset: 0 });
  const view = await call("wry_view", { open: false });
  console.log("site:", SITE);
  // Chrome asks the user to let a public site reach local programs ("Local
  // Network Access"); automation has nobody to click Allow, so grant it here.
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  let granted = "none";
  for (const perm of ["local-network-access", "loopback-network", "local-network"]) {
    try { await context.grantPermissions([perm], { origin: new URL(SITE).origin }); granted = perm; break; } catch { /* name not known to this Chromium */ }
  }
  console.log("permission granted:", granted);
  const page = await context.newPage();
  const logs = [];
  page.on("response", (r) => { if (r.status() >= 400) logs.push(`http ${r.status()}: ${r.url().replace(/\/[0-9a-f]{32}\//, "/<token>/")}`); });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
  page.on("requestfailed", (r) => logs.push(`requestfailed: ${r.url().replace(/\/[0-9a-f]{32}\//, "/<token>/")} ${r.failure()?.errorText}`));
  await page.goto(view.url, { waitUntil: "domcontentloaded" });
  const version = await page.locator("text=/v\\d+\\.\\d+\\.\\d+/").first().textContent().catch(() => "?");
  const hasMenu = await page.evaluate(() => typeof document.querySelector(".agent-pill") !== "undefined" && !!document.querySelector(".agent-pill"));
  console.log("page version:", version?.trim(), "| agent pill present:", hasMenu);
  try {
    await page.waitForFunction(() => document.querySelector(".agent-pill")?.dataset.state === "ok", null, { timeout: 45000 });
    console.log("pill:", await page.locator(".agent-pill").textContent());
    const t = open.timeRange.t0 + (open.timeRange.t1 - open.timeRange.t0) * 0.5;
    await call("wry_layer_create", { name: "agent fix", mode: "override", fade: 0.3 });
    await call("wry_key_set", { layer: "agent fix", bone: "RightHand", time: t, value: { flex: 60, deviation: 0 } });
    await page.waitForFunction(() => [...document.querySelectorAll(".rail-layer .rail-name")].some((e) => e.textContent.includes("agent fix")), null, { timeout: 30000 });
    console.log("live edit followed: the agent's layer appeared in the page");
    console.log("add buttons in rail:", await page.locator(".rail-add").count());
    ok = true;
  } catch (err) {
    console.log("NOT CONNECTED:", err.message.split("\n")[0]);
    console.log("pill:", await page.locator(".agent-pill").textContent().catch(() => "(none)"));
  }
  await page.screenshot({ path: join(repo, "scripts", "live-link-shot.png") });
  for (const l of logs.slice(0, 8)) console.log("  ", l);
} finally {
  await browser.close();
  mcp.stdin.end();
  mcp.kill();
}
console.log(ok ? "OK" : "FAILED");
process.exit(ok ? 0 : 1);
