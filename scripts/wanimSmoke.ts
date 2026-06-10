// Smoke test: parse a real .wanim file and print a summary.
// Usage: node --experimental-strip-types scripts/wanimSmoke.ts <file.wanim>
import { readFileSync } from "node:fs";
import { parseWanim, HUMAN_BODY_BONES } from "../src/wanim/parse.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --experimental-strip-types scripts/wanimSmoke.ts <file.wanim>");
  process.exit(1);
}

const buf = readFileSync(file);
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const frames = clip.times.length;
const duration = clip.times[frames - 1] - clip.times[0];
console.log(`version    ${clip.version}`);
console.log(`frames     ${frames}`);
console.log(`duration   ${duration.toFixed(2)}s (${((frames - 1) / duration).toFixed(1)} fps avg)`);
console.log(`characters ${clip.characters.length}`);
for (const ch of clip.characters) {
  const sets = Object.entries(ch.blendshapes).map(
    ([name, f]) => `${name}(${Object.keys(f[0] ?? {}).length} shapes)`,
  );
  console.log(`  bones ${ch.bonePositions[0].length}, blendshape sets: ${sets.join(", ") || "none"}`);
  const hips = ch.bonePositions[0][0];
  const knee = ch.bonePositions[0][HUMAN_BODY_BONES.indexOf("LeftLowerLeg")];
  console.log(`  frame0 hips pos [${hips.map((v) => v.toFixed(3)).join(", ")}]`);
  console.log(`  frame0 LeftLowerLeg local offset [${knee.map((v) => v.toFixed(3)).join(", ")}]`);
}
console.log("OK");
