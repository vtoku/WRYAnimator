// Confirms the Chest alignment tilt: angle between the source rest direction
// and (old) ourAxis-to-direct-child vs (new) our-dir-to-mapped-children.
import { readFileSync } from "node:fs";
globalThis.self = globalThis;
const THREE = await import("three");
const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
const { parseWanim, HUMAN_BODY_BONES } = await import("../src/wanim/parse.ts");
const { convertCharacter, bindWorldPositions } = await import("../src/convert/clip.ts");
const { parseVrmHumanoid, sanitizeGlb } = await import("../src/vrm/vrmHumanoid.ts");
const { boneUnityFromAssociations } = await import("../src/convert/body.ts");

const wbuf = readFileSync("C:\\Users\\VTOKU\\Downloads\\takyon take 2.wanim");
const clip = convertCharacter(parseWanim(wbuf.buffer.slice(wbuf.byteOffset, wbuf.byteOffset + wbuf.byteLength)));
const ourWorld = bindWorldPositions(clip.parents, clip.bindPos);
const vbuf = readFileSync("C:\\Users\\VTOKU\\Downloads\\AshtonMartenARKIT.vrm");
const ab = sanitizeGlb(vbuf.buffer.slice(vbuf.byteOffset, vbuf.byteOffset + vbuf.byteLength));
const nodeMap = parseVrmHumanoid(ab);
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await loader.parseAsync(ab, "");
gltf.scene.updateWorldMatrix(true, true);
const boneUnity = boneUnityFromAssociations(gltf, nodeMap);

const idx = (n) => HUMAN_BODY_BONES.indexOf(n);
const w = (n) => new THREE.Vector3(...ourWorld[idx(n)]);
for (const n of ["Spine","Chest","UpperChest","Neck","LeftShoulder","RightShoulder"])
  console.log(`  ${n}(${idx(n)}) parent ${HUMAN_BODY_BONES[clip.parents[idx(n)]]}:`, w(n).toArray().map(v=>v.toFixed(3)).join(","));
console.log("Chest==UpperChest pos?", w("Chest").distanceTo(w("UpperChest")).toFixed(4), "m apart");
console.log("");
// our direction Chest -> direct child (UpperChest) vs Chest -> mapped children (Neck + shoulders)
const chest = w("Chest");
// Old target = ourAxis[Chest]: toward UpperChest, but that's zero-length here,
// so it falls back to (Chest - Spine).
let toUpperChest = w("UpperChest").clone().sub(chest);
if (toUpperChest.lengthSq() < 1e-8) toUpperChest = chest.clone().sub(w("Spine"));
toUpperChest.normalize();
const toMapped = new THREE.Vector3();
for (const n of ["Neck", "LeftShoulder", "RightShoulder"]) toMapped.add(w(n).clone().sub(chest));
toMapped.normalize();
const ang = (THREE.MathUtils.radToDeg(toUpperChest.angleTo(toMapped))).toFixed(1);
console.log("Chest -> UpperChest (old target):", toUpperChest.toArray().map(v=>v.toFixed(3)).join(","));
console.log("Chest -> Neck+shoulders (new target):", toMapped.toArray().map(v=>v.toFixed(3)).join(","));
console.log("tilt between old and new target:", ang, "deg");

// --- Measure the SOURCE VRM's actual chest->children direction (yaw-aligned) ---
// Find the source bone mapped to our Chest, its joint, and mapped-children joints.
const bones = [];
gltf.scene.traverse((o) => { if (o.isBone) bones.push(o); });
const srcUnity = new Map();
boneUnity.forEach((u, obj) => srcUnity.set(obj, u));
const chestSrc = bones.find((b) => srcUnity.get(b) === "Chest")
  ?? bones.find((b) => /chest/i.test(b.name) && !/upper/i.test(b.name));
console.log("\nsource Chest bone:", chestSrc?.name);
if (chestSrc) {
  const cj = chestSrc.getWorldPosition(new THREE.Vector3());
  // its bone children that map to Neck / shoulders
  const kids = [];
  chestSrc.traverse((o) => {
    if (o === chestSrc || !o.isBone) return;
    const u = srcUnity.get(o);
    if (u === "Neck" || u === "LeftShoulder" || u === "RightShoulder") kids.push(o);
  });
  const dir = new THREE.Vector3();
  for (const k of kids) dir.add(k.getWorldPosition(new THREE.Vector3()).sub(cj));
  dir.normalize();
  // global yaw to +Z (toes heading) — approximate with the body facing; assume already +Z for VRM rest.
  console.log("source Chest->{neck,shoulders} dir (world):", dir.toArray().map(v=>v.toFixed(3)).join(","));
  console.log("  vs our new target:", toMapped.toArray().map(v=>v.toFixed(3)).join(","));
  console.log("  rotation the transfer bakes in:", THREE.MathUtils.radToDeg(dir.angleTo(toMapped)).toFixed(1),
    "deg  (sign: src z", dir.z.toFixed(3), "-> our z", toMapped.z.toFixed(3), ")");
}
