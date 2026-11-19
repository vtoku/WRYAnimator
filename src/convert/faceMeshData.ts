import * as THREE from "three";

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

/**
 * Extract the morph head's geometry + morph deltas from a parsed GLTF scene.
 * Pure (no loading) so the browser (preview/face.ts) and the headless CLI
 * (cli/core.mjs) share one implementation.
 */
export function faceMeshDataFromScene(scene: THREE.Object3D): FaceMeshData {
  let mesh: THREE.Mesh | null = null;
  scene.updateWorldMatrix(true, true);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.morphTargetDictionary) mesh = m;
  });
  if (!mesh) throw new Error("facecap head has no morph mesh");
  const m = mesh as THREE.Mesh;

  const src = m.geometry;
  const posAttr = src.getAttribute("position");
  const count = posAttr.count;
  // ALWAYS read through the attribute accessors — meshopt-decoded GLBs use
  // INTERLEAVED attributes, where `.array` is the mixed pos/normal/uv buffer
  // (copying it raw shreds the mesh into slivers).
  const positions = new Float32Array(count * 3);
  const mat = m.matrixWorld;
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(mat);
    positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
  }
  const indices = src.index
    ? new Uint32Array(src.index.array as ArrayLike<number>)
    : Uint32Array.from({ length: count }, (_, i) => i);

  const normalAttr = src.getAttribute("normal");
  const normals = new Float32Array(count * 3);
  if (normalAttr) {
    const nm = new THREE.Matrix3().getNormalMatrix(mat);
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(normalAttr, i).applyMatrix3(nm).normalize();
      normals[i * 3] = v.x; normals[i * 3 + 1] = v.y; normals[i * 3 + 2] = v.z;
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
    const deltas = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix3(linear);
      deltas[i * 3] = v.x; deltas[i * 3 + 1] = v.y; deltas[i * 3 + 2] = v.z;
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
}
