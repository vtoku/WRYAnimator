import { readFileSync } from "node:fs";
import { parseWanim, HUMAN_BODY_BONES } from "../src/wanim/parse.ts";
import { convertCharacter } from "../src/convert/clip.ts";

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const c = convertCharacter(clip, 0);
  console.log(`\n=== ${file.split(/[\\/]/).pop()} ===`);
  console.log("raw frame-0 local positions (relative to parent), meters:");
  for (const n of ["Spine", "Chest", "UpperChest", "Neck", "Head", "LeftShoulder", "RightShoulder"]) {
    const i = HUMAN_BODY_BONES.indexOf(n);
    const p = c.bindPos[i];
    console.log(`  ${n.padEnd(13)} [${p.map((v) => v.toFixed(4).padStart(8)).join(", ")}]  |len|=${Math.hypot(...p).toFixed(4)}`);
  }
  // Is UpperChest static across the clip? sample a few frames.
  const uc = HUMAN_BODY_BONES.indexOf("UpperChest");
  const ne = HUMAN_BODY_BONES.indexOf("Neck");
  console.log("UpperChest local pos over time:", [0, 1000, 5000].filter((f) => f < clip.times.length)
    .map((f) => `[${c.localPos[uc][f].map((v) => v.toFixed(3)).join(",")}]`).join(" "));
  console.log("Neck local pos over time:      ", [0, 1000, 5000].filter((f) => f < clip.times.length)
    .map((f) => `[${c.localPos[ne][f].map((v) => v.toFixed(3)).join(",")}]`).join(" "));
}
