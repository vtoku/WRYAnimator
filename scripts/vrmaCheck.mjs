// Structural check for the VRMA exporter: real wanim → resample → writeVrma,
// then parse the GLB back and validate the VRMC_vrm_animation layout.
// Usage: node scripts/vrmaCheck.mjs [file.wanim] [out.vrma]
import { readFileSync, writeFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter, resample } = await import("../src/convert/clip.ts");
const { augmentFaceForVrm } = await import("../src/convert/vrmFaceMap.ts");
const { writeVrma } = await import("../src/vrma/writeVrma.ts");
const { parseGlbChunks } = await import("../src/vrm/vrmHumanoid.ts");

const path = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim";
const buf = readFileSync(path);
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const converted = convertCharacter(clip, 0);
const resampled = resample(converted, 30);
const augFace = resampled.face ? augmentFaceForVrm(resampled.face) : undefined;
const vrma = writeVrma(resampled, augFace);
console.log(`vrma size ${(vrma.length / 1e6).toFixed(2)} MB, ${resampled.frameCount} frames @30fps`);

const chunks = parseGlbChunks(vrma.buffer.slice(vrma.byteOffset, vrma.byteOffset + vrma.byteLength));
const json = chunks.json;
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  if (!ok) failures++;
};

const ext = json.extensions?.VRMC_vrm_animation;
check("VRMC_vrm_animation extension present", !!ext && json.extensionsUsed?.includes("VRMC_vrm_animation"));
const hb = ext?.humanoid?.humanBones ?? {};
check("humanoid bones mapped", Object.keys(hb).length === 55, `${Object.keys(hb).length} bones`);
check("hips mapped + thumb renames", !!hb.hips && !!hb.leftThumbMetacarpal && !!hb.rightThumbDistal);
for (const [name, ref] of Object.entries(hb)) {
  if (ref.node == null || !json.nodes[ref.node]) { check(`bone node valid: ${name}`, false); break; }
}

const anim = json.animations?.[0];
const presets = Object.keys(ext?.expressions?.preset ?? {});
const customs = Object.keys(ext?.expressions?.custom ?? {});
const expected = 55 + 1 + presets.length + customs.length;
check("channel count = 55 rot + 1 hips trans + expressions",
  anim?.channels?.length === expected,
  `${anim?.channels?.length} channels; presets [${presets.join(",")}], ${customs.length} customs`);

// All channel targets/samplers/accessors resolve.
let refsOk = true;
for (const ch of anim.channels) {
  const s = anim.samplers[ch.sampler];
  if (!json.nodes[ch.target.node] || !json.accessors[s.input] || !json.accessors[s.output]) refsOk = false;
}
check("all channel/sampler/accessor refs resolve", refsOk);

const timeAcc = json.accessors[anim.samplers[0].input];
check("time accessor has min/max and right duration",
  Array.isArray(timeAcc.min) && Math.abs(timeAcc.max[0] - (resampled.frameCount - 1) / 30) < 1e-3,
  `duration=${timeAcc.max?.[0]?.toFixed(2)}s`);

// Buffer views fit in the BIN chunk.
const fits = json.bufferViews.every((bv) => bv.byteOffset + bv.byteLength <= chunks.bin.length);
check("buffer views fit BIN chunk", fits, `bin=${chunks.bin.length} bytes`);

// Rest pose is a T-pose: hips node translation ≈ recorded hips height.
const hipsNode = json.nodes[hb.hips.node];
check("hips rest height sane", hipsNode.translation[1] > 0.5 && hipsNode.translation[1] < 1.5,
  `y=${hipsNode.translation[1].toFixed(3)}m`);

if (process.argv[3]) { writeFileSync(process.argv[3], vrma); console.log("wrote", process.argv[3]); }
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
