// Build an FBX with the embedded blendshape head and round-trip it through
// FBXLoader to confirm the morph mesh + morph animation tracks survive.
import { readFileSync } from "node:fs";
globalThis.self = globalThis;
const THREE = await import("three");
const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter, resample } = await import("../src/convert/clip.ts");
const { writeAnimationFbx } = await import("../src/fbx/animationFbx.ts");
const { toFacecapName } = await import("../src/preview/face.ts");

// --- extract face mesh data (mirrors loadFaceMeshData) ---
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const glbBuf = readFileSync("public/facecap-head.glb");
const gltf = await loader.parseAsync(glbBuf.buffer.slice(glbBuf.byteOffset, glbBuf.byteOffset + glbBuf.byteLength), "");
let mesh = null;
gltf.scene.updateWorldMatrix(true, true);
gltf.scene.traverse((o) => { if (o.isMesh && o.morphTargetDictionary) mesh = o; });
const src = mesh.geometry;
const posAttr = src.getAttribute("position");
const positions = new Float32Array(posAttr.array);
const normals = new Float32Array(src.getAttribute("normal").array);
const indices = src.index ? new Uint32Array(src.index.array) : Uint32Array.from({ length: posAttr.count }, (_, i) => i);
const matW = mesh.matrixWorld, v = new THREE.Vector3();
for (let i = 0; i < positions.length; i += 3) { v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matW); positions[i] = v.x; positions[i + 1] = v.y; positions[i + 2] = v.z; }
const nmat = new THREE.Matrix3().getNormalMatrix(matW);
for (let i = 0; i < normals.length; i += 3) { v.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix3(nmat).normalize(); normals[i] = v.x; normals[i + 1] = v.y; normals[i + 2] = v.z; }
const box = new THREE.Box3().setFromArray(positions);
const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
const morphs = {};
const linear = new THREE.Matrix3().setFromMatrix4(matW);
for (const [name, idx] of Object.entries(mesh.morphTargetDictionary)) {
  const a = src.morphAttributes.position[idx]; if (!a) continue;
  const d = new Float32Array(a.array);
  for (let i = 0; i < d.length; i += 3) { v.set(d[i], d[i + 1], d[i + 2]).applyMatrix3(linear); d[i] = v.x; d[i + 1] = v.y; d[i + 2] = v.z; }
  morphs[name] = d;
}
const meshData = { positions, indices, center: [c.x, c.y, c.z], height: size.y, morphs };
console.log("face mesh: control points", positions.length / 3, "tris", indices.length / 3, "morphs", Object.keys(morphs).length);

// --- wanim → resampled ---
const buf = readFileSync(process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim");
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const resampled = resample(convertCharacter(clip, 0), 30);

// --- build channels ---
const channels = [];
resampled.face.names.forEach((name, n) => {
  const deltas = morphs[toFacecapName(name)]; if (!deltas) return;
  const weights = resampled.face.tracks[n];
  let moved = 0; for (let i = 0; i < weights.length; i++) moved = Math.max(moved, Math.abs(weights[i]));
  if (moved < 0.01) return;
  channels.push({ name, deltas, weights });
});
console.log("animated channels:", channels.length);

const fbx = writeAnimationFbx(resampled, {
  takeName: "Take 001", tposeRest: true,
  face: { positions, normals, indices, center: meshData.center, height: meshData.height, channels },
  headIndex: resampled.names.indexOf("Head"),
});
console.log("fbx size", (fbx.length / 1e6).toFixed(2), "MB");
if (process.argv[3]) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.argv[3], fbx);
  console.log("wrote", process.argv[3]);
}

// --- round-trip ---
const group = new FBXLoader().parse(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), "");
let morphMeshes = 0, morphTargetNames = 0;
group.traverse((o) => { if (o.isMesh && o.morphTargetInfluences) { morphMeshes++; morphTargetNames += Object.keys(o.morphTargetDictionary ?? {}).length; } });
const clipOut = group.animations[0];
const morphTracks = (clipOut?.tracks ?? []).filter((t) => /morphTargetInfluences/.test(t.name));
console.log("morph meshes:", morphMeshes, "morph targets:", morphTargetNames);
console.log("clip tracks:", clipOut?.tracks.length, "of which morph tracks:", morphTracks.length);
if (morphMeshes < 1) throw new Error("no morph mesh imported");
if (morphTracks.length < 1) throw new Error("no morph animation tracks");
console.log("OK");
