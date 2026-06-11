import { readFileSync } from "node:fs";
globalThis.self = globalThis;
const THREE = await import("three");
const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const buf = readFileSync(process.argv[2] ?? "scripts/Xbot.glb");
const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");

const skinned = [];
let skeleton = null;
gltf.scene.traverse((o) => {
  if (o.isSkinnedMesh) { skinned.push(o); skeleton = o.skeleton; }
});
console.log("skinned meshes:", skinned.map((m) => `${m.name} (verts ${m.geometry.getAttribute("position").count}, morphs ${m.morphTargetDictionary ? Object.keys(m.morphTargetDictionary).length : 0})`).join("; "));
if (skeleton) {
  console.log("bones:", skeleton.bones.length);
  console.log(skeleton.bones.map((b) => b.name).join(", "));
}
// list animations
console.log("animations:", gltf.animations.map((a) => a.name).join(", ") || "none");
