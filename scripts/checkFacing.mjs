// Which way does the Xbot body face in world space? (Our skeleton faces +Z:
// toes have larger z than ankles.) Compare Xbot toe vs ankle world z.
import { readFileSync } from "node:fs";
globalThis.self = globalThis;
const THREE = await import("three");
const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const b = readFileSync("public/body.glb");
const gltf = await loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
gltf.scene.updateWorldMatrix(true, true);

let skeleton = null;
gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skeleton = o.skeleton; });
const get = (name) => {
  const j = skeleton.bones.findIndex((x) => x.name === name);
  return new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(skeleton.boneInverses[j]).invert());
};
const foot = get("mixamorigLeftFoot");
const toe = get("mixamorigLeftToeBase");
const hips = get("mixamorigHips");
const head = get("mixamorigHead");
const lArm = get("mixamorigLeftArm");
const rArm = get("mixamorigRightArm");
console.log("LeftFoot   ", foot.toArray().map((v) => v.toFixed(3)).join(", "));
console.log("LeftToeBase", toe.toArray().map((v) => v.toFixed(3)).join(", "));
console.log("=> toes point", toe.z > foot.z ? "+Z (same as our skeleton)" : "-Z (OPPOSITE of our skeleton)");
console.log("hips y", hips.y.toFixed(3), "head y", head.y.toFixed(3));
console.log("LeftArm x", lArm.x.toFixed(3), " RightArm x", rArm.x.toFixed(3), " (ours: LeftUpperArm x<0)");
