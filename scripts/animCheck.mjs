// Humanoid .anim exporter check.
//
//   node scripts/animCheck.mjs [file.wanim] [--unity <scratchProjectDir>] [--seconds 6] [--fps 30]
//
// Always: structural checks on the writer's output and a round trip through
// our own model of Unity's muscle math (muscles → bones → compare).
// With --unity (needs a local Unity editor; see scripts/animUnity.mjs): Unity
// imports the .anim, samples it on an avatar built from the same skeleton, and
// the bones Unity produces are compared with the source motion. That is the
// real acceptance test — run it after touching src/anim/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWanim } from "../src/wanim/parse.ts";
import { convertCharacter, resample } from "../src/convert/clip.ts";
import { writeUnityAnim } from "../src/anim/writeAnim.ts";
import { buildHumanoidRig, poseToHuman, musclesToLocal, MUSCLE_COUNT, muscleAttribute } from "../src/anim/humanoid.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const unityDir = opt("--unity", null);
const seconds = Number(opt("--seconds", "6"));
const fps = Number(opt("--fps", "30"));
const start = Number(opt("--start", "-1"));
const file = args[0] ?? join(repo, "public", "sample-idle.wanim");

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };

const buf = readFileSync(file);
const conv = convertCharacter(parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), 0);
const t0 = start >= 0 ? Math.min(start, Math.max(0, conv.duration - seconds)) : Math.max(0, conv.duration / 2 - seconds / 2);
const clip = resample(conv, fps, t0, Math.min(conv.duration, t0 + seconds));
const F = clip.frameCount, B = clip.names.length;
console.log(`${file}\n${F} frames @ ${fps} fps from ${t0.toFixed(2)} s`);

// ---- writer output ---------------------------------------------------------------
const { bytes, report } = writeUnityAnim(clip, { name: "animCheck", face: clip.face });
const text = new TextDecoder().decode(bytes);
console.log(JSON.stringify(report));
ok(text.startsWith("%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!74 &7400000\nAnimationClip:"), "header is a Unity AnimationClip");
const attrs = [...text.matchAll(/^    attribute: (.+)$/gm)].map((m) => m[1]);
ok(attrs.filter((a) => !a.startsWith("blendShape.")).length === MUSCLE_COUNT + 7, `${MUSCLE_COUNT} muscle curves + RootT/RootQ (${attrs.length} curves in all)`);
ok(new Set(attrs).size === attrs.length, "no duplicate curve attributes");
ok(attrs.includes("LeftHand.Index.1 Stretched") && attrs.includes("RightHand.Thumb.Spread") && !attrs.some((a) => /^(Left|Right) (Thumb|Index)/.test(a)), "finger curves use the LeftHand.Index.1 Stretched form");
ok(Array.from({ length: MUSCLE_COUNT }, (_, m) => muscleAttribute(m)).every((a) => attrs.includes(a)), "every muscle has a curve");
ok(!/: (NaN|-?Infinity)\b|\de[-+]\d/.test(text.replace(/^.*(attribute|m_Name).*$/gm, "")), "no NaN / Infinity / exponent-form numbers");
ok(report.keys <= report.keysBeforeReduction && report.keys >= attrs.length, `key reduction: ${report.keys} of ${report.keysBeforeReduction} keys kept`);
ok(clip.face ? report.blendshapeCurves > 0 && /classID: 137/.test(text) : true, `blendshape curves: ${report.blendshapeCurves}`);
ok(report.hipsHeightM > 0.3 && report.hipsHeightM < 2.5, `T-pose hips height ${report.hipsHeightM} m (${report.hipsHeightFrom})`);

// ---- our own round trip ------------------------------------------------------------
const uq = (q) => [q[0], -q[1], -q[2], q[3]];
const up = (p) => [-p[0], p[1], p[2]];
const mul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const rot = (q, v) => { const r = mul(mul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [r[0], r[1], r[2]]; };
const ang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
const dead = (q) => q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] < 0.25;
const bindU = clip.bindPos.map(up);
const rig = buildHumanoidRig(clip.parents, bindU, report.hipsHeightM, clip.names.map((_, b) => !dead(clip.localQuat[b][0])));
const idx = (n) => clip.names.indexOf(n);
function fk(q, hips) {
  const w = [], p = [];
  const get = (b) => { if (w[b]) return; const par = clip.parents[b]; if (par < 0) { w[b] = q(b); p[b] = hips; return; } get(par); w[b] = mul(w[par], q(b)); const o = rot(w[par], bindU[b]); p[b] = [p[par][0] + o[0], p[par][1] + o[1], p[par][2] + o[2]]; };
  for (let b = 0; b < B; b++) get(b);
  return { w, p };
}
const srcFrame = (f) => fk((b) => (dead(clip.localQuat[b][f]) ? [0, 0, 0, 1] : uq(clip.localQuat[b][f])), up(clip.localPos[0][f]));
const VIS_ROT = ["Hips", "Chest", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot"];
const VIS_POS = ["Head", "LeftLowerArm", "RightLowerArm", "LeftHand", "RightHand", "LeftLowerLeg", "RightLowerLeg", "LeftFoot", "RightFoot"];
function compare(label, poseAt, n, limits) {
  let maxRot = 0, maxPos = 0, rotAt = "", posAt = "";
  for (let i = 0; i < n; i++) {
    const { f, w, p } = poseAt(i);
    const s = srcFrame(f);
    for (const name of VIS_ROT) { const b = idx(name); const e = ang(s.w[b], w[b]); if (e > maxRot) { maxRot = e; rotAt = `${name} f${f}`; } }
    for (const name of VIS_POS) { const b = idx(name); const e = Math.hypot(s.p[b][0] - p[b][0], s.p[b][1] - p[b][1], s.p[b][2] - p[b][2]) * 1000; if (e > maxPos) { maxPos = e; posAt = `${name} f${f}`; } }
  }
  ok(maxRot < limits.rot, `${label}: hips / chest / head / hands / feet world rotation within ${limits.rot}° (worst ${maxRot.toFixed(3)}° ${rotAt})`);
  ok(maxPos < limits.pos, `${label}: head / elbow / wrist / knee / ankle position within ${limits.pos} mm (worst ${maxPos.toFixed(2)} mm ${posAt})`);
}
{
  const local = new Array(B);
  let human;
  compare("own model", (f) => {
    for (let b = 0; b < B; b++) local[b] = uq(clip.localQuat[b][f]);
    human = poseToHuman(rig, local, up(clip.localPos[0][f]), human); // carried forward: limb twist is tracked through time
    const h = human;
    const q = musclesToLocal(rig, h.muscles);
    // Place the hips from the body transform the way Unity does: rebuild with hips at the origin, then solve.
    const src = srcFrame(f);
    q[0] = src.w[0];
    const r = fk((b) => q[b], up(clip.localPos[0][f]));
    return { f, w: r.w, p: r.p };
  }, F, { rot: 0.05, pos: Math.round(20 * report.hipsHeightM) });
}

// ---- Unity ----------------------------------------------------------------------------
if (unityDir) {
  const dir = resolve(unityDir);
  mkdirSync(dir, { recursive: true });
  const present = clip.names.map((_, b) => !dead(clip.localQuat[b][0]));
  const bind = []; for (let b = 0; b < B; b++) bind.push(...(b === 0 ? [0, report.hipsHeightM, 0] : bindU[b]));
  const inJson = join(dir, "animcheck-in.json"), outJson = join(dir, "animcheck-out.json"), animPath = join(dir, "animcheck.anim");
  writeFileSync(inJson, JSON.stringify({ names: clip.names, parents: clip.parents, bind, present, poses: [], labels: [] }));
  writeFileSync(animPath, bytes);
  const r = spawnSync(process.execPath, [join(repo, "scripts", "animUnity.mjs"), "verify", dir, inJson, outJson, animPath, String(F)], { encoding: "utf8" });
  console.log(r.stdout.trim());
  ok(r.status === 0, "Unity imported and sampled the clip");
  if (r.status === 0) {
    const v = JSON.parse(readFileSync(outJson, "utf8"));
    ok(v.isHuman, "Unity sees a humanoid (muscle) clip");
    ok(v.bindings >= MUSCLE_COUNT + 7, `Unity lists ${v.bindings} curve bindings (muscles + root${report.blendshapeCurves ? " + blendshapes" : ""})`);
    ok(Math.abs(v.length - report.durationS) < 1 / fps, `clip length ${v.length.toFixed(3)} s`);
    compare("UNITY playback", (i) => {
      const s = v.samples[i];
      const f = Math.min(F - 1, Math.round(s.t * fps));
      const r2 = fk((b) => s.q.slice(b * 4, b * 4 + 4), s.hips);
      return { f, w: r2.w, p: r2.p };
      // Exact on the avatar the muscle axes were measured on; a few degrees on others (see humanoid.ts).
    }, v.samples.length, { rot: 4, pos: Math.round(20 * report.hipsHeightM) });
  }
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nanimCheck OK");
process.exit(failed ? 1 : 0);
