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

let gltfCache: Promise<{ scene: THREE.Object3D }> | null = null;

function loadBodyGltf(): Promise<{ scene: THREE.Object3D }> {
  if (gltfCache) return gltfCache;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  gltfCache = loader.loadAsync(`${import.meta.env.BASE_URL}body.glb`);
  return gltfCache;
}

// buildBodyData results depend on the skeleton's bind, so cache per-bind.
let bodyCache: { key: string; data: Promise<BodyMeshData[]> } | null = null;

export function buildBodyData(
  parents: number[],
  bindPos: Vec3[],
  unityNames: string[],
): Promise<BodyMeshData[]> {
  const key = bindPos.map((p) => p.map((v) => v.toFixed(4)).join(",")).join(";");
  if (bodyCache?.key === key) return bodyCache.data;
  const data = loadBodyGltf().then((gltf) =>
    extractBodyMeshes(gltf.scene, parents, bindPos, unityNames),
  );
  bodyCache = { key, data };
  return data;
}

/** Xbot joint world positions per OUR bone index (meters; null if unmapped). */
export function bodyJointsForBones(scene: THREE.Object3D, unityNames: string[]): (Vec3 | null)[] {
  scene.updateWorldMatrix(true, true);
  let skeleton: THREE.Skeleton | null = null;
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) skeleton = m.skeleton;
  });
  if (!skeleton) return unityNames.map(() => null);
  const sk = skeleton as THREE.Skeleton;
  const byName = new Map<string, number>();
  sk.bones.forEach((b, j) => byName.set(b.name.replace(/^mixamorig:?/, ""), j));
  return unityNames.map((u) => {
    const j = byName.get(MOTIONBUILDER_NAMES[u] ?? u);
    if (j === undefined) return null;
    const p = new THREE.Vector3().setFromMatrixPosition(
      new THREE.Matrix4().copy(sk.boneInverses[j]).invert(),
    );
    return [p.x, p.y, p.z];
  });
}

/** Browser-side cached loader for the Xbot joints. */
let jointsCache: Promise<(Vec3 | null)[]> | null = null;
export function getBodyJoints(unityNames: string[]): Promise<(Vec3 | null)[]> {
  if (jointsCache) return jointsCache;
  jointsCache = loadBodyGltf().then((gltf) => bodyJointsForBones(gltf.scene, unityNames));
  return jointsCache;
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

      // Per-bone re-bake: v' = ourJoint + s_j · (v − xbotJoint), where s_j is
      // the SEGMENT length ratio (our bone length / Xbot bone length). Pure
      // translation alone squashes the torso / bloats the hips wherever the
      // two rigs' joint spacing differs; per-segment scale maps each mesh
      // chunk to the recorded character's proportions. Both rigs are Y-up
      // T-poses, so no rotation is needed.
      const jointWorld = skeleton.bones.map((_, j) =>
        new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(skeleton.boneInverses[j]).invert()),
      );
      const xbotChild = skeleton.bones.map((b) => {
        const childBone = b.children.find((c) => (c as THREE.Bone).isBone);
        return childBone ? skeleton.bones.indexOf(childBone as THREE.Bone) : -1;
      });
      const ourChild: number[] = unityNames.map(() => -1);
      parents.forEach((p, i) => {
        if (p >= 0 && ourChild[p] < 0) ourChild[p] = i;
      });
      const segLen = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const boneScale = skeleton.bones.map((b, j) => {
        const m = boneOurIndex[j];
        // Segment = joint→first child; for leaves use the parent segment.
        let xLen = 0;
        if (xbotChild[j] >= 0) xLen = jointWorld[j].distanceTo(jointWorld[xbotChild[j]]);
        else if (b.parent && (b.parent as THREE.Bone).isBone) {
          const pj = skeleton.bones.indexOf(b.parent as THREE.Bone);
          if (pj >= 0) xLen = jointWorld[pj].distanceTo(jointWorld[j]);
        }
        let oLen = 0;
        if (ourChild[m] >= 0) oLen = segLen(ourWorld[m], ourWorld[ourChild[m]]);
        else if (parents[m] >= 0) oLen = segLen(ourWorld[parents[m]], ourWorld[m]);
        if (xLen < 1e-4 || oLen < 1e-4) return 1;
        return Math.min(2.5, Math.max(0.3, oLen / xLen));
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
      const acc = new THREE.Vector3();
      const normalMat = new THREE.Matrix3().getNormalMatrix(bindMatrix);

      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(bindMatrix);
        n.fromBufferAttribute(nrm, i).applyMatrix3(normalMat).normalize();
        acc.set(0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const j = sIdx.getComponent(i, k);
          const w = sWgt.getComponent(i, k);
          if (w === 0) continue;
          // Offset from the Xbot joint, segment-scaled, placed at our joint.
          // No rotation: the converted skeleton is turned to face +Z (HIK
          // requirement), the same way Xbot faces.
          const m = boneOurIndex[j];
          const sc = boneScale[j];
          acc.x += w * (ourWorld[m][0] + (v.x - jointWorld[j].x) * sc);
          acc.y += w * (ourWorld[m][1] + (v.y - jointWorld[j].y) * sc);
          acc.z += w * (ourWorld[m][2] + (v.z - jointWorld[j].z) * sc);
          outIdx[i * 4 + k] = m;
          outWgt[i * 4 + k] = w;
          if (boneIsHead[j]) headWeight[i] += w;
        }
        outPos[i * 3] = acc.x; outPos[i * 3 + 1] = acc.y; outPos[i * 3 + 2] = acc.z;
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
