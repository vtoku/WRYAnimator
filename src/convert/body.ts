import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { Vec3 } from "../wanim/parse.ts";
import { bindWorldPositions } from "./clip.ts";
import { MOTIONBUILDER_NAMES } from "./skeleton.ts";
import type { SkinnedMeshExport } from "../fbx/animationFbx.ts";

/**
 * The Mixamo Xbot/Ybot body (three.js example model), retargeted onto the
 * recording's skeleton: per-vertex linear-blend re-bake from Xbot's bind pose
 * into OUR T-pose world space, with weights remapped from mixamorig bones to
 * the HumanBodyBones indices. Head/eye triangles are dropped — the facecap
 * head replaces them.
 */
export interface BodyMeshData {
  name: string;
  /** World-space positions in OUR T-pose bind (meters). */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per-vertex 4 influences: OUR bone indices + weights. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

let cache: Promise<BodyMeshData[]> | null = null;

export function buildBodyData(
  parents: number[],
  bindPos: Vec3[],
  unityNames: string[],
): Promise<BodyMeshData[]> {
  if (cache) return cache;
  cache = (async () => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}body.glb`);
    return extractBodyMeshes(gltf.scene, parents, bindPos, unityNames);
  })();
  return cache;
}

/** Pure retarget/extract step (also usable from node checks on a parsed GLTF). */
export function extractBodyMeshes(
  scene: THREE.Object3D,
  parents: number[],
  bindPos: Vec3[],
  unityNames: string[],
): BodyMeshData[] {
  {
    const gltf = { scene };
    gltf.scene.updateWorldMatrix(true, true);

    const ourWorld = bindWorldPositions(parents, bindPos);

    // mixamorig name (sans prefix) → our bone index, via the MoBu name map.
    const mobuToIndex = new Map<string, number>();
    unityNames.forEach((u, i) => mobuToIndex.set(MOTIONBUILDER_NAMES[u] ?? u, i));

    const headIdx = unityNames.indexOf("Head");
    const eyeIdx = [unityNames.indexOf("LeftEye"), unityNames.indexOf("RightEye")];

    const meshes: BodyMeshData[] = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;

      const skeleton = m.skeleton;
      // Per-GLB-bone: our bone index (walk up unmapped helper bones like
      // HeadTop_End / Toe_End / HandThumb4) and whether it's part of the head.
      const boneOurIndex = skeleton.bones.map((b) => {
        let cur: THREE.Object3D | null = b;
        while (cur) {
          const stripped = cur.name.replace(/^mixamorig:?/, "");
          const idx = mobuToIndex.get(stripped);
          if (idx !== undefined) return idx;
          cur = cur.parent;
        }
        return 0; // fall back to hips
      });
      const boneIsHead = boneOurIndex.map((i) => i === headIdx || eyeIdx.includes(i));

      // Per-bone re-bake = uniform height scale + translation (ourJoint −
      // s·xbotJoint). The full translate∘inverseBind form mixes Xbot's armature
      // scale (cm vs m) into the result; scale-then-delta keeps orientation
      // intact, blends smoothly across weights, and sizes Xbot's volume to the
      // recorded character. Both rigs are Y-up T-poses.
      const jointWorld = skeleton.bones.map((_, j) =>
        new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(skeleton.boneInverses[j]).invert()),
      );
      const xbotHips = jointWorld[skeleton.bones.findIndex((b) => /Hips$/.test(b.name))] ?? jointWorld[0];
      const s = xbotHips.y > 1e-3 ? ourWorld[0][1] / xbotHips.y : 1;
      const deltas = skeleton.bones.map((_, j) => {
        const t = ourWorld[boneOurIndex[j]];
        return new THREE.Vector3(
          t[0] - jointWorld[j].x * s,
          t[1] - jointWorld[j].y * s,
          t[2] - jointWorld[j].z * s,
        );
      });

      const geo = m.geometry;
      const pos = geo.getAttribute("position");
      const nrm = geo.getAttribute("normal");
      const sIdx = geo.getAttribute("skinIndex");
      const sWgt = geo.getAttribute("skinWeight");
      const count = pos.count;
      // GLTFLoader binds skins with bindMatrix = mesh.matrixWorld at load, so
      // bindMatrix alone maps mesh-local → skeleton-bind world space.
      const bindMatrix = m.bindMatrix;

      const outPos = new Float32Array(count * 3);
      const outNrm = new Float32Array(count * 3);
      const outIdx = new Uint16Array(count * 4);
      const outWgt = new Float32Array(count * 4);
      const headWeight = new Float32Array(count);

      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      const normalMat = new THREE.Matrix3().getNormalMatrix(bindMatrix);

      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(bindMatrix).multiplyScalar(s);
        n.fromBufferAttribute(nrm, i).applyMatrix3(normalMat).normalize();
        for (let k = 0; k < 4; k++) {
          const j = sIdx.getComponent(i, k);
          const w = sWgt.getComponent(i, k);
          if (w === 0) continue;
          v.addScaledVector(deltas[j], w);
          outIdx[i * 4 + k] = boneOurIndex[j];
          outWgt[i * 4 + k] = w;
          if (boneIsHead[j]) headWeight[i] += w;
        }
        outPos[i * 3] = v.x; outPos[i * 3 + 1] = v.y; outPos[i * 3 + 2] = v.z;
        outNrm[i * 3] = n.x; outNrm[i * 3 + 1] = n.y; outNrm[i * 3 + 2] = n.z;
      }

      // Drop head triangles (facecap head replaces them), then compact verts.
      const srcIndices = geo.index
        ? (geo.index.array as ArrayLike<number>)
        : Array.from({ length: count }, (_, i) => i);
      const keptTris: number[] = [];
      for (let t = 0; t < srcIndices.length; t += 3) {
        const a = srcIndices[t], b = srcIndices[t + 1], c = srcIndices[t + 2];
        const hw = (headWeight[a] + headWeight[b] + headWeight[c]) / 3;
        if (hw < 0.5) keptTris.push(a, b, c);
      }
      const remap = new Int32Array(count).fill(-1);
      let next = 0;
      for (const vi of keptTris) if (remap[vi] < 0) remap[vi] = next++;
      const positions = new Float32Array(next * 3);
      const normals = new Float32Array(next * 3);
      const skinIndex = new Uint16Array(next * 4);
      const skinWeight = new Float32Array(next * 4);
      for (let i = 0; i < count; i++) {
        const r = remap[i];
        if (r < 0) continue;
        positions.set(outPos.subarray(i * 3, i * 3 + 3), r * 3);
        normals.set(outNrm.subarray(i * 3, i * 3 + 3), r * 3);
        skinIndex.set(outIdx.subarray(i * 4, i * 4 + 4), r * 4);
        skinWeight.set(outWgt.subarray(i * 4, i * 4 + 4), r * 4);
      }
      const indices = new Uint32Array(keptTris.length);
      for (let t = 0; t < keptTris.length; t++) indices[t] = remap[keptTris[t]];

      meshes.push({
        name: m.name.replace(/^Beta_/, "Body"),
        positions,
        normals,
        indices,
        skinIndex,
        skinWeight,
      });
    });

    return meshes;
  }
}

/** Convert preview-space body data (meters) into FBX skinned-mesh exports (cm). */
export function bodyToSkinnedMeshExports(meshes: BodyMeshData[]): SkinnedMeshExport[] {
  return meshes.map((m) => {
    const positions = new Float64Array(m.positions.length);
    for (let i = 0; i < m.positions.length; i++) positions[i] = m.positions[i] * 100;
    const normals = new Float64Array(m.normals.length);
    normals.set(m.normals);

    // Gather per-bone clusters from the per-vertex influences.
    const byBone = new Map<number, { idx: number[]; w: number[] }>();
    const count = m.positions.length / 3;
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 4; k++) {
        const w = m.skinWeight[i * 4 + k];
        if (w < 1e-4) continue;
        const bone = m.skinIndex[i * 4 + k];
        let entry = byBone.get(bone);
        if (!entry) byBone.set(bone, (entry = { idx: [], w: [] }));
        entry.idx.push(i);
        entry.w.push(w);
      }
    }
    const clusters = [...byBone.entries()].map(([boneIndex, e]) => ({
      boneIndex,
      pointIndices: Int32Array.from(e.idx),
      weights: Float64Array.from(e.w),
    }));

    return { name: m.name, positions, normals, indices: m.indices, clusters };
  });
}
