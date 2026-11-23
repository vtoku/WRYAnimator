// Run scripts/unity/AnimProbe.cs in a scratch Unity project (batch mode).
// Developer tool for the humanoid .anim exporter — needs a local Unity editor.
//
//   node scripts/animUnity.mjs run    <projectDir> <probe-in.json> <probe-out.json>
//   node scripts/animUnity.mjs verify <projectDir> <probe-in.json> <verify-out.json> <clip.anim> [samples]
//
// UNITY_EXE overrides the editor path. The project directory is created if
// missing (first run imports for a minute or two).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mode, projArg, inJson, outJson, clipPath, samples] = process.argv.slice(2);
if (!["run", "verify", "forward"].includes(mode) || !projArg || !inJson || !outJson || (mode !== "run" && !clipPath)) {
  console.error("usage: animUnity.mjs run|verify|forward <projectDir> <in.json> <out.json> [clip.anim | muscles.json] [samples]");
  process.exit(2);
}
const METHOD = { run: "AnimProbe.Run", verify: "AnimProbe.Verify", forward: "AnimProbe.Forward" }[mode];

function findUnity() {
  if (process.env.UNITY_EXE) return process.env.UNITY_EXE;
  const hub = "C:\\Program Files\\Unity\\Hub\\Editor";
  if (existsSync(hub)) {
    const versions = readdirSync(hub).filter((v) => existsSync(join(hub, v, "Editor", "Unity.exe"))).sort();
    const pick = versions.find((v) => v.startsWith("2022.3")) ?? versions[versions.length - 1];
    if (pick) return join(hub, pick, "Editor", "Unity.exe");
  }
  throw new Error("no Unity editor found — set UNITY_EXE");
}

const proj = resolve(projArg);
mkdirSync(join(proj, "Assets", "Editor"), { recursive: true });
mkdirSync(join(proj, "Packages"), { recursive: true });
const manifest = join(proj, "Packages", "manifest.json");
if (!existsSync(manifest)) {
  writeFileSync(manifest, JSON.stringify({ dependencies: { "com.unity.modules.animation": "1.0.0", "com.unity.modules.jsonserialize": "1.0.0" } }));
}
copyFileSync(join(repo, "scripts", "unity", "AnimProbe.cs"), join(proj, "Assets", "Editor", "AnimProbe.cs"));

const env = { ...process.env, ANIM_PROBE_IN: resolve(inJson), ANIM_PROBE_OUT: resolve(outJson) };
if (mode === "verify") {
  copyFileSync(resolve(clipPath), join(proj, "Assets", "Ours.anim"));
  env.ANIM_PROBE_CLIP = "Assets/Ours.anim";
  env.ANIM_PROBE_SAMPLES = samples ?? "60";
}
if (mode === "forward") env.ANIM_PROBE_FWD = resolve(clipPath);
const log = join(proj, `unity-${mode}.log`);
const exe = findUnity();
const r = spawnSync(exe, ["-batchmode", "-nographics", "-projectPath", proj, "-executeMethod", METHOD, "-logFile", log, "-quit"], { env, stdio: "ignore" });
const text = existsSync(log) ? readFileSync(log, "utf8") : "";
const lines = text.split(/\r?\n/).filter((l) => /ANIMPROBE|error CS|Exception:/.test(l));
console.log([...new Set(lines)].slice(0, 12).join("\n"));
console.log(`unity ${exe.match(/Editor\\([^\\]+)\\/)?.[1] ?? ""} exit ${r.status} — log: ${log}`);
process.exit(r.status === 0 && /ANIMPROBE \w+ ok/.test(text) ? 0 : 1);
