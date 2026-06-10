// Does zeroing all local rotations produce a T-pose? Lay out the skeleton from
// frame-0 bind offsets with identity rotations (world_pos = parent + local_pos)
// and report key joint positions. A T-pose = arms horizontal (hands ~shoulder
// height, wide in X), legs vertical (feet below hips).
import { readFileSync } from "node:fs";
import { parseWanim, HUMAN_BODY_BONES } from "../src/wanim/parse.ts";
import { convertCharacter } from "../src/convert/clip.ts";
import { BONE_PARENTS } from "../src/convert/skeleton.ts";

const file = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim";
const buf = readFileSync(file);
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const c = convertCharacter(clip, 0);

// Identity-rotation layout: cumulative sum of bind (frame-0) local positions.
// Resolve recursively — UpperChest (index 54) parents earlier-indexed bones,
// so a single forward pass would read it before it's computed.
const world = c.bindPos.map(() => null);
function resolve(i) {
  if (world[i]) return world[i];
  const p = BONE_PARENTS[i];
  const base = p >= 0 ? resolve(p) : [0, 0, 0];
  const lp = c.bindPos[i];
  return (world[i] = [base[0] + lp[0], base[1] + lp[1], base[2] + lp[2]]);
}
for (let i = 0; i < BONE_PARENTS.length; i++) resolve(i);

const idx = (n) => HUMAN_BODY_BONES.indexOf(n);
const show = (n) => {
  const w = world[idx(n)];
  console.log(`  ${n.padEnd(14)} [${w.map((v) => v.toFixed(3).padStart(7)).join(", ")}]`);
};
console.log("identity-rotation world positions (x, y, z), meters:");
for (const n of ["Hips", "Spine", "Chest", "Neck", "Head",
  "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
  "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
  "LeftUpperLeg", "LeftLowerLeg", "LeftFoot",
  "RightUpperLeg", "RightLowerLeg", "RightFoot"]) show(n);

// T-pose checks.
const sh = world[idx("LeftShoulder")], lh = world[idx("LeftHand")], rh = world[idx("RightHand")];
const hips = world[idx("Hips")], lf = world[idx("LeftFoot")];
const armDrop = Math.abs(lh[1] - sh[1]);
const armSpan = Math.abs(lh[0] - rh[0]);
const legDown = hips[1] - lf[1];
console.log("\nverdict:");
console.log(`  hand vs shoulder height delta: ${armDrop.toFixed(3)} m  (T-pose: near 0; arms-down: large)`);
console.log(`  hand-to-hand span (X):         ${armSpan.toFixed(3)} m  (T-pose: wide, ~1.2-1.6)`);
console.log(`  hips above feet:               ${legDown.toFixed(3)} m  (legs vertical: ~0.8-1.0)`);
console.log(`  => ${armDrop < 0.15 && armSpan > 0.9 ? "looks like a T-POSE" : "NOT a clean T-pose (arms not horizontal)"}`);
