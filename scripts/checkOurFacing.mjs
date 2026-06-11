import { readFileSync } from "node:fs";
const { parseWanim, HUMAN_BODY_BONES } = await import("../src/wanim/parse.ts");
const { convertCharacter, bindWorldPositions } = await import("../src/convert/clip.ts");
const { BONE_PARENTS } = await import("../src/convert/skeleton.ts");

for (const f of ["C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim", "C:\\Users\\VTOKU\\Downloads\\2026-03-18-03-37-56.wanim"]) {
  const b = readFileSync(f);
  const clip = parseWanim(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const c = convertCharacter(clip, 0);
  const w = bindWorldPositions(BONE_PARENTS, c.bindPos);
  const idx = (n) => HUMAN_BODY_BONES.indexOf(n);
  const p = (n) => w[idx(n)].map((v) => v.toFixed(3)).join(", ");
  console.log(`=== ${f.split("\\").pop()}`);
  console.log("  LeftFoot    ", p("LeftFoot"));
  console.log("  LeftToes    ", p("LeftToes"));
  console.log("  LeftUpperArm", p("LeftUpperArm"));
  console.log("  LeftEye     ", p("LeftEye"), " (eyes sit forward of head)");
  console.log("  Head        ", p("Head"));
  const toeDz = w[idx("LeftToes")][2] - w[idx("LeftFoot")][2];
  const eyeDz = w[idx("LeftEye")][2] - w[idx("Head")][2];
  console.log(`  toes dz=${toeDz.toFixed(3)} eyes dz=${eyeDz.toFixed(3)} -> faces ${toeDz > 0 ? "+Z" : "-Z"} / eyes say ${eyeDz > 0 ? "+Z" : "-Z"}`);
  console.log(`  left arm x=${w[idx("LeftUpperArm")][0].toFixed(3)}`);
}
