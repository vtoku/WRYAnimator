import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { makeAvatarMaterial } from "./materials.ts";
import { type FaceMeshData, faceMeshDataFromScene } from "../convert/faceMeshData.ts";

// The facecap head (three.js example model, by Face Cap / Bannaflak) carries
// the 52 ARKit blendshapes as morph targets, but names them with _L/_R suffixes
// where Warudo's recordings use Apple's Left/Right. Center shapes match as-is.
export function toFacecapName(arkit: string): string {
  return arkit.replace(/Left$/, "_L").replace(/Right$/, "_R");
}

// The extraction lives in convert/ (pure, shared with the headless CLI).
export type { FaceMeshData };

let meshDataCache: Promise<FaceMeshData> | null = null;

/** Load (cached) the facecap head geometry + morph deltas for FBX embedding. */
export async function loadFaceMeshData(): Promise<FaceMeshData> {
  if (meshDataCache) return meshDataCache;
  meshDataCache = (async () => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}facecap-head.glb`);
    return faceMeshDataFromScene(gltf.scene);
  })();
  return meshDataCache;
}

/**
 * A detached head model seated at the skeleton's Head joint and driven by the
 * recorded ARKit blendshape weights. Geometry/morphs only — textures are
 * stripped from the bundled GLB so it loads without a Basis transcoder.
 */
export class FaceOverlay {
  readonly group = new THREE.Group();
  private morphMesh: THREE.Mesh | null = null;
  /** weight track index → morph influence index (built from the clip's names). */
  private indexMap: Int32Array | null = null;

  private constructor(model: THREE.Object3D) {
    // Normalize: recenter on the model's bounds and scale to unit height so the
    // caller can size it in metres regardless of the source model's units.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const inner = new THREE.Group();
    inner.add(model);
    model.position.sub(center);
    const s = 1 / (size.y || 1);
    inner.scale.setScalar(s);
    this.group.add(inner);

    // Same champagne finish as the body (the GLB ships textureless).
    const avatarMat = makeAvatarMaterial();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = mesh.material;
      if (Array.isArray(old)) old.forEach((m) => m.dispose());
      else (old as THREE.Material | undefined)?.dispose();
      mesh.material = avatarMat;
      if (mesh.morphTargetDictionary) this.morphMesh = mesh;
    });
  }

  static async load(): Promise<FaceOverlay> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const url = `${import.meta.env.BASE_URL}facecap-head.glb`;
    const gltf = await loader.loadAsync(url);
    return new FaceOverlay(gltf.scene);
  }

  hasMorphs(): boolean {
    return this.morphMesh != null;
  }

  /** Build the name→morph-index lookup for a clip's blendshape track order. */
  bindNames(names: string[]): void {
    const dict = this.morphMesh?.morphTargetDictionary;
    this.indexMap = new Int32Array(names.length).fill(-1);
    if (!dict) return;
    names.forEach((n, i) => {
      const idx = dict[toFacecapName(n)];
      this.indexMap![i] = idx === undefined ? -1 : idx;
    });
  }

  /** Apply one frame of blendshape weights (same order as bindNames). */
  applyWeights(weights: ArrayLike<number>): void {
    const mesh = this.morphMesh;
    const map = this.indexMap;
    if (!mesh || !map || !mesh.morphTargetInfluences) return;
    const influences = mesh.morphTargetInfluences;
    influences.fill(0);
    for (let i = 0; i < map.length; i++) {
      const target = map[i];
      if (target >= 0) influences[target] = weights[i];
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
  }
}
