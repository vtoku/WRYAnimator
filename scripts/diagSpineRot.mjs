// How much does each spine bone rotate in the recording? If UpperChest carries
// real rotation, a VRM body without that bone can't follow it -> shear/hunch.
import { readFileSync } from "node:fs";
const { parseWanim, HUMAN_BODY_BONES } = await import("../src/wanim/parse.ts");
const { convertCharacter } = await import("../src/convert/clip.ts");
const buf = readFileSync("C:\\Users\\VTOKU\\Downloads\\takyon take 2.wanim");
const clip = convertCharacter(parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
const idx = (n) => HUMAN_BODY_BONES.indexOf(n);
const angOf = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180 / Math.PI);
// frame near 3.5s
let f = clip.times.findIndex((t) => t >= 3.5);
if (f < 0) f = Math.floor(clip.times.length / 2);
console.log("frame", f, "t=", clip.times[f].toFixed(2));
for (const n of ["Hips", "Spine", "Chest", "UpperChest", "Neck", "Head"]) {
  const q = clip.localQuat[idx(n)][f];
  // peak / min over whole clip too
  let peak = 0, lo = 999;
  for (const qq of clip.localQuat[idx(n)]) { const a = angOf(qq); peak = Math.max(peak, a); lo = Math.min(lo, a); }
  console.log(`  ${n}: @frame ${angOf(q).toFixed(1)}deg  (range ${lo.toFixed(1)}..${peak.toFixed(1)})  q=[${q.map(v=>v.toFixed(3)).join(",")}]`);
}
// Is UpperChest constant? sample a few frames
console.log("\nUpperChest quat across clip:");
for (const ff of [0, Math.floor(clip.times.length*0.25), Math.floor(clip.times.length*0.5), Math.floor(clip.times.length*0.75), clip.times.length-1]) {
  const q = clip.localQuat[idx("UpperChest")][ff];
  console.log(`  f${ff}: [${q.map(v=>v.toFixed(4)).join(", ")}]`);
}
console.log("\nbind offsets (local pos) for UpperChest & Neck:");
console.log("  UpperChest:", clip.bindPos[idx("UpperChest")].map(v=>v.toFixed(4)).join(","));
console.log("  Neck:", clip.bindPos[idx("Neck")].map(v=>v.toFixed(4)).join(","));
