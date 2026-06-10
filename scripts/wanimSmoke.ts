// Smoke test: parse a real .wanim, convert + resample, write FBX, sanity-check.
// Usage: node --experimental-strip-types scripts/wanimSmoke.ts <file.wanim> [outFbx]
import { readFileSync, writeFileSync } from "node:fs";
import { parseWanim } from "../src/wanim/parse.ts";
import { convertCharacter, resample } from "../src/convert/clip.ts";
import { writeAnimationFbx } from "../src/fbx/animationFbx.ts";
import { remapNames } from "../src/convert/skeleton.ts";

const file = process.argv[2];
const out = process.argv[3];
if (!file) {
  console.error("usage: node --experimental-strip-types scripts/wanimSmoke.ts <file.wanim> [outFbx]");
  process.exit(1);
}

const buf = readFileSync(file);
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const frames = clip.times.length;
const duration = clip.times[frames - 1] - clip.times[0];
console.log(`frames     ${frames}`);
console.log(`duration   ${duration.toFixed(2)}s (${((frames - 1) / duration).toFixed(1)} fps avg)`);
console.log(`characters ${clip.characters.length}`);

const converted = convertCharacter(clip, 0);
const resampled = resample(converted, 60);
console.log(`resampled  ${resampled.frameCount} frames @ ${resampled.fps} fps`);

const hips0 = resampled.localPos[0][0].map((v) => (v * 100).toFixed(1));
console.log(`hips(cm)   [${hips0.join(", ")}] at frame 0`);

const mbNames = remapNames(resampled.names, "motionbuilder");
const fbx = writeAnimationFbx(resampled, { takeName: "Take 001", names: mbNames, tposeRest: true });
const lines = fbx.split("\n").length;
console.log(`fbx        ${(fbx.length / 1e6).toFixed(2)} MB, ${lines} lines (MoBu names, T-pose rest)`);
for (const need of ["LeftArm", "LeftForeArm", "LeftUpLeg", "Spine1", "LeftHandThumb1"]) {
  if (!fbx.includes(`Model::${need}`)) throw new Error(`MoBu name missing: ${need}`);
}
console.log(`names      MoBu scheme present (LeftArm, LeftForeArm, LeftUpLeg, Spine1, LeftHandThumb1)`);

// Sanity: balanced { } braces, expected sections present.
let depth = 0;
for (const ch of fbx) {
  if (ch === "{") depth++;
  else if (ch === "}") depth--;
  if (depth < 0) throw new Error("unbalanced braces (extra closing)");
}
if (depth !== 0) throw new Error(`unbalanced braces (depth ${depth} at EOF)`);
for (const section of ["Objects:", "Connections:", "AnimationStack:", "AnimationCurve:", "Takes:"]) {
  if (!fbx.includes(section)) throw new Error(`missing section: ${section}`);
}
const curveNodes = (fbx.match(/AnimationCurveNode:/g) ?? []).length;
const curves = (fbx.match(/AnimationCurve: /g) ?? []).length;
console.log(`curves     ${curveNodes} nodes, ${curves} curves`);

if (out) {
  writeFileSync(out, fbx);
  console.log(`wrote      ${out}`);
}
console.log("OK");
