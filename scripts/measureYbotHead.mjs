// Measure the Ybot head mesh (the verts we drop) in world space: height span
// and center relative to the Head joint — to size/seat the facecap head.
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

const box = new THREE.Box3();
let headJointY = 0;
gltf.scene.traverse((m) => {
  if (!m.isSkinnedMesh) return;
  const sk = m.skeleton;
  const headBones = new Set();
  sk.bones.forEach((bn, j) => {
    if (/Head|Eye/.test(bn.name)) headBones.add(j);
    if (bn.name === "mixamorigHead") {
      const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(sk.boneInverses[j]).invert());
      headJointY = p.y;
    }
  });
  const pos = m.geometry.getAttribute("position");
  const sIdx = m.geometry.getAttribute("skinIndex");
  const sWgt = m.geometry.getAttribute("skinWeight");
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    let hw = 0;
    for (let k = 0; k < 4; k++) if (headBones.has(sIdx.getComponent(i, k))) hw += sWgt.getComponent(i, k);
    if (hw > 0.5) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.bindMatrix);
      box.expandByPoint(v.clone());
    }
  }
});
const size = box.getSize(new THREE.Vector3());
const center = box.getCenter(new THREE.Vector3());
console.log("Ybot head bbox size (m):", size.toArray().map((x) => x.toFixed(3)).join(", "));
console.log("center y:", center.y.toFixed(3), " head joint y:", headJointY.toFixed(3));
console.log("=> height", (size.y * 100).toFixed(1), "cm; center is", ((center.y - headJointY) * 100).toFixed(1), "cm above the Head joint");
