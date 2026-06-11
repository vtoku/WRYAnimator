// Full-FBX check: build a body+face skinned FBX through the real src modules,
// round-trip via FBXLoader, optionally write to disk for the MoBu check.
// Usage: node scripts/faceFbxCheck.mjs <file.wanim> [out.fbx]
import { readFileSync, writeFileSync } from "node:fs";
globalThis.self = globalThis;
const THREE = await import("three");
const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter, resample, retargetProportions } = await import("../src/convert/clip.ts");
const { writeAnimationFbx } = await import("../src/fbx/animationFbx.ts");
const { buildFaceMesh } = await import("../src/convert/meshExport.ts");
const { extractBodyMeshes, bodyToSkinnedMeshExports } = await import("../src/convert/body.ts");

const loadGlb = async (path) => {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const b = readFileSync(path);
  return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
};

// --- face mesh data (same extraction as loadFaceMeshData, node-side) ---
const faceGltf = await loadGlb("public/facecap-head.glb");
let fmesh = null;
faceGltf.scene.updateWorldMatrix(true, true);
faceGltf.scene.traverse((o) => { if (o.isMesh && o.morphTargetDictionary) fmesh = o; });
// Read via accessors — meshopt GLBs use interleaved attributes; raw `.array`
// copies shred the mesh.
const src = fmesh.geometry;
const posAttr = src.getAttribute("position");
const nrmAttr = src.getAttribute("normal");
const vcount = posAttr.count;
const positions = new Float32Array(vcount * 3);
const normals = new Float32Array(vcount * 3);
const matW = fmesh.matrixWorld, v = new THREE.Vector3();
const nmat = new THREE.Matrix3().getNormalMatrix(matW);
for (let i = 0; i < vcount; i++) {
  v.fromBufferAttribute(posAttr, i).applyMatrix4(matW);
  positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
  v.fromBufferAttribute(nrmAttr, i).applyMatrix3(nmat).normalize();
  normals[i * 3] = v.x; normals[i * 3 + 1] = v.y; normals[i * 3 + 2] = v.z;
}
const indices = src.index ? new Uint32Array(src.index.array) : Uint32Array.from({ length: vcount }, (_, i) => i);
const box = new THREE.Box3().setFromArray(positions);
const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
const morphs = {};
const lin = new THREE.Matrix3().setFromMatrix4(matW);
for (const [name, idx] of Object.entries(fmesh.morphTargetDictionary)) {
  const a = src.morphAttributes.position[idx]; if (!a) continue;
  const d = new Float32Array(vcount * 3);
  for (let i = 0; i < vcount; i++) { v.fromBufferAttribute(a, i).applyMatrix3(lin); d[i * 3] = v.x; d[i * 3 + 1] = v.y; d[i * 3 + 2] = v.z; }
  morphs[name] = d;
}
const faceData = { positions, normals, indices, center: [c.x, c.y, c.z], height: size.y, morphs };

// --- wanim → resampled ---
const buf = readFileSync(process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim");
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
let converted = convertCharacter(clip, 0);
let bodyGltfEarly, bodyBoneUnity;
if (process.env.WANIM_BODY_FILE) {
  const { sanitizeGlb, parseVrmHumanoid } = await import("../src/vrm/vrmHumanoid.ts");
  const { boneUnityFromAssociations } = await import("../src/convert/body.ts");
  const raw = readFileSync(process.env.WANIM_BODY_FILE);
  const clean = sanitizeGlb(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const nodeMap = parseVrmHumanoid(clean);
  const loader2 = new GLTFLoader();
  loader2.setMeshoptDecoder(MeshoptDecoder);
  bodyGltfEarly = await loader2.parseAsync(clean, "");
  bodyBoneUnity = nodeMap ? boneUnityFromAssociations(bodyGltfEarly, nodeMap) : undefined;
  console.log("body source:", process.env.WANIM_BODY_FILE.split("\\").pop(), "humanoid bones:", bodyBoneUnity?.size ?? 0);
} else {
  bodyGltfEarly = await loadGlb("public/body.glb");
}
if (process.env.WANIM_PROPORTIONS === "body") {
  const probe = extractBodyMeshes(bodyGltfEarly.scene, converted.parents, converted.bindPos, converted.names, bodyBoneUnity);
  converted = retargetProportions(converted, probe.joints);
  console.log("proportions: body skeleton");
}
const resampled = resample(converted, 30);

// --- meshes --- (a user VRM keeps its own head, so no facecap Face mesh)
const meshes = process.env.WANIM_BODY_FILE ? [] : [buildFaceMesh(resampled, faceData)];
const bodyData = extractBodyMeshes(bodyGltfEarly.scene, resampled.parents, resampled.bindPos, resampled.names, bodyBoneUnity, {
  keepHead: !!process.env.WANIM_BODY_FILE,
}).meshes;
console.log("body meshes:", bodyData.map((m) => `${m.name}(${m.positions.length / 3}v ${m.indices.length / 3}t)`).join(", "));
meshes.push(...bodyToSkinnedMeshExports(bodyData));
if (!process.env.WANIM_BODY_FILE) console.log("face channels:", meshes[0].channels.length);

const fbx = writeAnimationFbx(resampled, { takeName: "Take 001", tposeRest: true, meshes });
console.log("fbx size", (fbx.length / 1e6).toFixed(2), "MB");

// --- round-trip ---
const group = new FBXLoader().parse(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), "");
let bones = 0, skinned = 0, morphMeshes = 0;
group.traverse((o) => {
  if (o.isBone) bones++;
  if (o.isSkinnedMesh) skinned++;
  if (o.isMesh && o.morphTargetInfluences?.length) morphMeshes++;
});
const clips = group.animations;
console.log("round-trip: bones", bones, "skinnedMeshes", skinned, "morphMeshes", morphMeshes, "clips", clips.map((cl) => `${cl.name}:${cl.duration.toFixed(2)}s/${cl.tracks.length}tr`).join(", "));
// body mesh bbox sanity: should stand ~1.5-1.9m tall at origin
const bodyMesh = (() => { let r = null; group.traverse((o) => { if (o.isSkinnedMesh && /Body/.test(o.name) && !r) r = o; }); return r; })();
if (bodyMesh) {
  bodyMesh.geometry.computeBoundingBox();
  const bb = bodyMesh.geometry.boundingBox;
  console.log("body bbox y:", bb.min.y.toFixed(1), "..", bb.max.y.toFixed(1), "cm; z:", bb.min.z.toFixed(1), "..", bb.max.z.toFixed(1));
}
if (bones < 50) throw new Error("bones missing");
if (skinned < 2) throw new Error(`expected face + body skinned meshes, got ${skinned}`);
if (process.argv[3]) { writeFileSync(process.argv[3], fbx); console.log("wrote", process.argv[3]); }
console.log("OK");
