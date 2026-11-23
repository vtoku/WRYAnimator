// Build the input for the Unity muscle probe (scripts/unity/AnimProbe.cs):
// our skeleton in UNITY space (left-handed) plus a set of poses whose
// HumanPose (muscles, body position/rotation) Unity will report as ground truth.
//
// Usage: node scripts/animProbeInput.mjs <file.wanim> <out.json> [realFrames=240]
import { readFileSync, writeFileSync } from "node:fs";
import { parseWanim } from "../src/wanim/parse.ts";
import { convertCharacter } from "../src/convert/clip.ts";

const [file, out, nReal = "240"] = process.argv.slice(2);
if (!file || !out) { console.error("usage: animProbeInput.mjs <file.wanim> <out.json> [realFrames]"); process.exit(2); }
const buf = readFileSync(file);
const clip = convertCharacter(parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), 0);
const B = clip.names.length;
const F = clip.times.length;

// converted (right-handed, X mirrored) → Unity (left-handed)
const uPos = (p) => [-p[0], p[1], p[2]];
const uQuat = (q) => [q[0], -q[1], -q[2], q[3]];
const dead = (q) => q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] < 0.25;

const present = clip.names.map((_, b) => !dead(clip.localQuat[b][0]));
const bind = [];
for (let b = 0; b < B; b++) bind.push(...uPos(b === 0 ? [0, clip.bindPos[0][1], 0] : clip.bindPos[b]));

const ident = () => { const q = []; for (let b = 0; b < B; b++) q.push(0, 0, 0, 1); return q; };
const hips0 = [0, clip.bindPos[0][1], 0];
const poses = [];
const labels = [];
poses.push({ hips: hips0, q: ident() }); labels.push("tpose");

// Single-axis probes: every present bone, ±25° about each local axis (Unity space).
const axisQ = (axis, deg) => { const h = (deg * Math.PI) / 360; const q = [0, 0, 0, Math.cos(h)]; q[axis] = Math.sin(h); return q; };
for (let b = 0; b < B; b++) {
  if (!present[b]) continue;
  for (let axis = 0; axis < 3; axis++) for (const deg of [25, -25]) {
    const q = ident();
    q.splice(b * 4, 4, ...axisQ(axis, deg));
    poses.push({ hips: hips0, q }); labels.push(`${clip.names[b]}:${"xyz"[axis]}${deg > 0 ? "+" : ""}${deg}`);
  }
}
// Root probes: hips translated, hips yawed.
{ const q = ident(); poses.push({ hips: [0.3, hips0[1] + 0.1, -0.2], q }); labels.push("root:translate"); }

// Real frames, evenly spread.
const n = Math.min(Number(nReal), F);
for (let i = 0; i < n; i++) {
  const f = Math.floor((i * (F - 1)) / Math.max(1, n - 1));
  const q = [];
  for (let b = 0; b < B; b++) q.push(...(present[b] ? uQuat(clip.localQuat[b][f]) : [0, 0, 0, 1]));
  poses.push({ hips: uPos(clip.localPos[0][f]), q }); labels.push(`frame:${f}`);
}

writeFileSync(out, JSON.stringify({ names: clip.names, parents: clip.parents, bind, present, poses, labels }));
console.log(`wrote ${out}: ${B} bones (${present.filter(Boolean).length} present), ${poses.length} poses, hips height ${hips0[1].toFixed(4)} m`);
console.log("absent:", clip.names.filter((_, b) => !present[b]).join(", ") || "none");
