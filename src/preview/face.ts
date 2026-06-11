import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// The facecap head (three.js example model, by Face Cap / Bannaflak) carries
// the 52 ARKit blendshapes as morph targets, but names them with _L/_R suffixes
// where Warudo's recordings use Apple's Left/Right. Center shapes match as-is.
export function toFacecapName(arkit: string): string {
  return arkit.replace(/Left$/, "_L").replace(/Right$/, "_R");
}

/** Base mesh + per-morph deltas extracted from the facecap head, for FBX export. */
export interface FaceMeshData {
  /** Flat control-point positions (xyz), in the model's own units. */
  positions: Float32Array;
  /** Flat per-control-point normals (xyz). */
  normals: Float32Array;
  /** Triangle control-point indices (flat, 3 per face). */
  indices: Uint32Array;
  /** Bounds center + height, for seating the head on the skeleton. */
  center: [number, number, number];
  height: number;
  /** Morphs keyed by facecap morph name → flat per-control-point delta xyz. */
  morphs: Record<string, Float32Array>;
}

let meshDataCache: Promise<FaceMeshData> | null = null;

/** Load (cached) the facecap head geometry + morph deltas for FBX embedding. */
export async function loadFaceMeshData(): Promise<FaceMeshData> {
  if (meshDataCache) return meshDataCache;
  meshDataCache = (async () => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}facecap-head.glb`);
    let mesh: THREE.Mesh | null = null;
    gltf.scene.updateWorldMatrix(true, true);
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary) mesh = m;
    });
    if (!mesh) throw new Error("facecap head has no morph mesh");
    const m = mesh as THREE.Mesh;

    const src = m.geometry;
    const posAttr = src.getAttribute("position");
    const positions = new Float32Array(posAttr.array as ArrayLike<number>);
    const indices = src.index
      ? new Uint32Array(src.index.array as ArrayLike<number>)
      : Uint32Array.from({ length: posAttr.count }, (_, i) => i);

    // Bake the mesh's world matrix into the control points so seating matches preview math.
    const mat = m.matrixWorld;
    const v = new THREE.Vector3();
    for (let i = 0; i < positions.length; i += 3) {
      v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(mat);
      positions[i] = v.x; positions[i + 1] = v.y; positions[i + 2] = v.z;
    }

    const normalAttr = src.getAttribute("normal");
    const normals = new Float32Array(positions.length);
    if (normalAttr) {
      normals.set(normalAttr.array as ArrayLike<number>);
      const nm = new THREE.Matrix3().getNormalMatrix(mat);
      for (let i = 0; i < normals.length; i += 3) {
        v.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix3(nm).normalize();
        normals[i] = v.x; normals[i + 1] = v.y; normals[i + 2] = v.z;
      }
    }

    const box = new THREE.Box3();
    box.setFromArray(positions as unknown as number[]);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const morphs: Record<string, Float32Array> = {};
    const dict = m.morphTargetDictionary!;
    const morphPos = src.morphAttributes.position ?? [];
    // Linear part (rotation + scale, no translation) for transforming deltas.
    const linear = new THREE.Matrix3().setFromMatrix4(mat);
    for (const [name, idx] of Object.entries(dict)) {
      const attr = morphPos[idx];
      if (!attr) continue;
      const deltas = new Float32Array(attr.array as ArrayLike<number>);
      for (let i = 0; i < deltas.length; i += 3) {
        v.set(deltas[i], deltas[i + 1], deltas[i + 2]).applyMatrix3(linear);
        deltas[i] = v.x; deltas[i + 1] = v.y; deltas[i + 2] = v.z;
      }
      morphs[name] = deltas;
    }

    return {
      positions,
      normals,
      indices,
      center: [c.x, c.y, c.z],
      height: size.y,
      morphs,
    };
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

    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.morphTargetDictionary) this.morphMesh = mesh;
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
