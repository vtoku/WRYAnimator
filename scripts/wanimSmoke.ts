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
console.log(`fbx        ${(fbx.length / 1e6).toFixed(2)} MB binary (MoBu names, T-pose rest)`);

// Sanity: binary FBX header + footer magic.
const head = new TextDecoder().decode(fbx.subarray(0, 20));
if (head !== "Kaydara FBX Binary  ") throw new Error(`bad header: ${JSON.stringify(head)}`);
const version = new DataView(fbx.buffer, fbx.byteOffset + 23, 4).getUint32(0, true);
console.log(`version    ${version}`);
const footMagic = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e];
for (let i = 0; i < footMagic.length; i++) {
  if (fbx[fbx.length - 16 + i] !== footMagic[i]) throw new Error("bad footer magic");
}
console.log("footer     magic OK");

if (out) {
  writeFileSync(out, fbx);
  console.log(`wrote      ${out}`);
}
console.log("OK");
