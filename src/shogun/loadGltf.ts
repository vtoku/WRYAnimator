import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

// Ported verbatim from VRMxShogun (src/vrm/loadGltf.ts).
// Parse a VRM/GLB ArrayBuffer with three's GLTFLoader. VRM-specific extensions
// are ignored by the loader, but the mesh, skeleton, and skin weights come
// through intact — which is exactly the input the Shogun FBX exporter needs.
export function loadGltf(buffer: ArrayBuffer): Promise<GLTF> {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(buffer, "", resolve, reject);
  });
}
