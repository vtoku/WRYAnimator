import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { Vec3 } from "../wanim/parse.ts";
import { bindWorldPositions } from "./clip.ts";
import { MOTIONBUILDER_NAMES } from "./skeleton.ts";
import type { SkinnedMeshExport } from "../fbx/animationFbx.ts";

/**
 * Weighted body mesh, retargeted onto the recording's skeleton.
 *
 * The bundled body is Quaternius' "Animated Base Character" (CC0) — a smooth
 * skinned human. Pipeline (works for ANY humanoid GLB, regardless of how its
 * bind matrices were exported):
 *   1. map source bone names → our HumanBodyBones indices,
 *   2. FK-align the source skeleton's rest pose to OUR T-pose (rotate each
 *      bone so its segment direction matches ours — fixes A-poses and facing),
 *   3. evaluate the skin CPU-side in that aligned pose (true skinning math),
 *   4. transfer each vertex: offset from its bone's joint, STRETCHED along
 *      the bone axis by the segment-length ratio (girth preserved), placed at
 *      our joint, blended by the original weights.
 * Head/eye geometry is dropped — the Face mesh replaces it.
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

// Blender/Rigify-style names (Quaternius) → Unity HumanBodyBones names.
const RIGIFY_MAP: Record<string, string> = {
  hips: "Hips",
  spine001: "Spine",
  spine002: "Chest",
  spine003: "UpperChest",
  neck: "Neck",
  head: "Head",
  shoulderL: "LeftShoulder",
  upper_armL: "LeftUpperArm",
  forearmL: "LeftLowerArm",
  handL: "LeftHand",
  thumb01L: "LeftThumbProximal",
  thumb02L: "LeftThumbIntermediate",
  thumb03L: "LeftThumbDistal",
  f_index01L: "LeftIndexProximal",
  f_index02L: "LeftIndexIntermediate",
  f_index03L: "LeftIndexDistal",
  f_middle01L: "LeftMiddleProximal",
  f_middle02L: "LeftMiddleIntermediate",
  f_middle03L: "LeftMiddleDistal",
  f_ring01L: "LeftRingProximal",
  f_ring02L: "LeftRingIntermediate",
  f_ring03L: "LeftRingDistal",
  f_pinky01L: "LeftLittleProximal",
  f_pinky02L: "LeftLittleIntermediate",
  f_pinky03L: "LeftLittleDistal",
  thighL: "LeftUpperLeg",
  shinL: "LeftLowerLeg",
  footL: "LeftFoot",
  toeL: "LeftToes",
  shoulderR: "RightShoulder",
  upper_armR: "RightUpperArm",
  forearmR: "RightLowerArm",
  handR: "RightHand",
  thumb01R: "RightThumbProximal",
  thumb02R: "RightThumbIntermediate",
  thumb03R: "RightThumbDistal",
  f_index01R: "RightIndexProximal",
  f_index02R: "RightIndexIntermediate",
  f_index03R: "RightIndexDistal",
  f_middle01R: "RightMiddleProximal",
  f_middle02R: "RightMiddleIntermediate",
  f_middle03R: "RightMiddleDistal",
  f_ring01R: "RightRingProximal",
  f_ring02R: "RightRingIntermediate",
  f_ring03R: "RightRingDistal",
  f_pinky01R: "RightLittleProximal",
  f_pinky02R: "RightLittleIntermediate",
  f_pinky03R: "RightLittleDistal",
  thighR: "RightUpperLeg",
  shinR: "RightLowerLeg",
  footR: "RightFoot",
  toeR: "RightToes",
};

function normalizeBoneName(raw: string): string {
  return raw.replace(/^mixamorig:?/, "").replace(/^DEF-/, "").replace(/[. ]/g, "");
}

let gltfCache: Promise<{ scene: THREE.Object3D }> | null = null;

function loadBodyGltf(): Promise<{ scene: THREE.Object3D }> {
  if (gltfCache) return gltfCache;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  gltfCache = loader.loadAsync(`${import.meta.env.BASE_URL}body.glb`);
  return gltfCache;
}

export interface BodyExtract {
  meshes: BodyMeshData[];
  /** Source-skeleton joint world positions per OUR bone index (meters, after T-pose alignment), or null. */
  joints: (Vec3 | null)[];
}

// buildBodyData results depend on the skeleton's bind, so cache per-bind.
let bodyCache: { key: string; data: Promise<BodyExtract> } | null = null;

export function buildBodyData(
  parents: number[],
  bindPos: Vec3[],
  unityNames: string[],
): Promise<BodyExtract> {
  const key = bindPos.map((p) => p.map((v) => v.toFixed(4)).join(",")).join(";");
  if (bodyCache?.key === key) return bodyCache.data;
  const data = loadBodyGltf().then((gltf) =>
    extractBodyMeshes(gltf.scene, parents, bindPos, unityNames),
  );
  bodyCache = { key, data };
  return data;
}

/** Pure step (also usable from node checks on a parsed GLTF scene). */
export function extractBodyMeshes(
  scene: THREE.Object3D,
  parents: number[],
  bindPos: Vec3[],
  unityNames: string[],
): BodyExtract {
  scene.updateWorldMatrix(true, true);
  const ourWorld = bindWorldPositions(parents, bindPos);

  // Unity name → our index, plus MoBu names (covers Mixamo-style rigs).
  const nameToIndex = new Map<string, number>();
  unityNames.forEach((u, i) => {
    nameToIndex.set(u, i);
    nameToIndex.set(MOTIONBUILDER_NAMES[u] ?? u, i);
  });

  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) skinnedMeshes.push(m);
  });
  if (skinnedMeshes.length === 0) return { meshes: [], joints: unityNames.map(() => null) };
  const skeleton = skinnedMeshes[0].skeleton;

  // Source bone → our bone (walk up through unmapped helpers like HeadTop_End).
  const boneOurIndex = skeleton.bones.map((b) => {
    let cur: THREE.Object3D | null = b;
    while (cur) {
      const idx = nameToIndex.get(normalizeBoneName(cur.name)) ?? nameToIndex.get(RIGIFY_MAP[normalizeBoneName(cur.name)] ?? "");
      if (idx !== undefined) return idx;
      cur = cur.parent;
    }
    return 0;
  });
  const directlyMapped = skeleton.bones.map((b) => {
    const n = normalizeBoneName(b.name);
    return nameToIndex.has(n) || nameToIndex.has(RIGIFY_MAP[n] ?? "");
  });

  const headIdx = unityNames.indexOf("Head");
  const eyeIdx = [unityNames.indexOf("LeftEye"), unityNames.indexOf("RightEye")];
  const boneIsHead = boneOurIndex.map((i) => i === headIdx || eyeIdx.includes(i));

  // Our skeleton's children + segment axes (T-pose).
  const ourChildren: number[][] = unityNames.map(() => []);
  parents.forEach((p, i) => {
    if (p >= 0) ourChildren[p].push(i);
  });
  const ourAxis: (THREE.Vector3 | null)[] = unityNames.map((_, m) => {
    const dir = new THREE.Vector3();
    for (const c of ourChildren[m]) {
      dir.add(new THREE.Vector3(
        ourWorld[c][0] - ourWorld[m][0],
        ourWorld[c][1] - ourWorld[m][1],
        ourWorld[c][2] - ourWorld[m][2],
      ));
    }
    if (dir.lengthSq() < 1e-8 && parents[m] >= 0) {
      dir.set(
        ourWorld[m][0] - ourWorld[parents[m]][0],
        ourWorld[m][1] - ourWorld[parents[m]][1],
        ourWorld[m][2] - ourWorld[parents[m]][2],
      );
    }
    return dir.lengthSq() > 1e-8 ? dir.normalize() : null;
  });

  // Canonical T-pose target axis per bone. Aligning to the RECORDED avatar's
  // bind axes instead imports its quirks (VRM toe joints below the floor →
  // feet sink; drifting spine → caved chest; non-lateral arms → lumpy T).
  const alignmentTarget = (unityName: string, cur: THREE.Vector3): THREE.Vector3 | null => {
    if (/^Left(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/.test(unityName)) {
      return new THREE.Vector3(1, 0, 0);
    }
    if (/^Right(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/.test(unityName)) {
      return new THREE.Vector3(-1, 0, 0);
    }
    if (/^(Spine|Chest|UpperChest|Neck)$/.test(unityName)) return new THREE.Vector3(0, 1, 0);
    if (/UpperLeg|LowerLeg/.test(unityName)) return new THREE.Vector3(0, -1, 0);
    if (/Foot|Toes/.test(unityName)) {
      // Keep the model's natural foot pitch; turn the heading to +Z.
      const horiz = Math.hypot(cur.x, cur.z);
      return new THREE.Vector3(0, cur.y, horiz).normalize();
    }
    return null; // Hips/Head/etc: leave as authored
  };

  // --- 2. FK-align the source rest pose to a canonical T-pose ---------------
  // Visit bones parents-first; rotate each so its (mean child) segment
  // direction matches the canonical T-pose direction in world space.
  const order = [...skeleton.bones].sort((a, b) => {
    const depth = (o: THREE.Object3D) => {
      let d = 0;
      for (let p = o.parent; p; p = p.parent) d++;
      return d;
    };
    return depth(a) - depth(b);
  });
  const childBones = (b: THREE.Bone) => b.children.filter((c) => (c as THREE.Bone).isBone) as THREE.Bone[];
  const tmpQ = new THREE.Quaternion();
  const parentQ = new THREE.Quaternion();

  // First, yaw the whole rig so it faces +Z (detected from the feet heading) —
  // the per-bone pass skips the hips, so pelvis verts would keep the rest
  // facing otherwise.
  {
    const heading = new THREE.Vector3();
    skeleton.bones.forEach((b, j) => {
      if (!directlyMapped[j]) return;
      const u = unityNames[boneOurIndex[j]];
      if (u !== "LeftToes" && u !== "RightToes") return;
      const parentBone = b.parent as THREE.Bone;
      if (!parentBone?.isBone) return;
      heading.add(b.getWorldPosition(new THREE.Vector3()).sub(parentBone.getWorldPosition(new THREE.Vector3())));
    });
    heading.y = 0;
    if (heading.lengthSq() > 1e-8) {
      heading.normalize();
      const yaw = Math.atan2(heading.x, heading.z); // angle from +Z
      // World-space yaw, conjugated into the root bone's local frame —
      // rotateOnWorldAxis assumes an unrotated parent, but Blender exports
      // sit under a -90° X armature node.
      tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
      order[0].parent!.getWorldQuaternion(parentQ);
      const local = parentQ.clone().invert().multiply(tmpQ).multiply(parentQ);
      order[0].quaternion.premultiply(local);
      scene.updateWorldMatrix(true, true);
    }
  }

  for (const b of order) {
    const j = skeleton.bones.indexOf(b);
    const m = boneOurIndex[j];
    if (!directlyMapped[j]) continue;
    const kids = childBones(b).filter((c) => {
      const cj = skeleton.bones.indexOf(c);
      return cj >= 0 && directlyMapped[cj] && boneOurIndex[cj] !== m;
    });
    if (kids.length === 0) continue;
    scene.updateWorldMatrix(true, true);
    const own = b.getWorldPosition(new THREE.Vector3());
    const cur = new THREE.Vector3();
    for (const c of kids) cur.add(c.getWorldPosition(new THREE.Vector3()).sub(own));
    if (cur.lengthSq() < 1e-10) continue;
    cur.normalize();
    const target = alignmentTarget(unityNames[m], cur);
    if (!target) continue;
    // World-space corrective rotation, applied in the bone's local frame.
    tmpQ.setFromUnitVectors(cur, target);
    b.parent!.getWorldQuaternion(parentQ);
    const localCorrection = parentQ.clone().invert().multiply(tmpQ).multiply(parentQ);
    b.quaternion.premultiply(localCorrection);
  }
  scene.updateWorldMatrix(true, true);
  for (const m of skinnedMeshes) m.skeleton.update();

  // Aligned source joint positions (world, meters).
  const jointWorld = skeleton.bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
  const joints: (Vec3 | null)[] = unityNames.map(() => null);
  skeleton.bones.forEach((_, j) => {
    if (directlyMapped[j] && joints[boneOurIndex[j]] === null) {
      const p = jointWorld[j];
      joints[boneOurIndex[j]] = [p.x, p.y, p.z];
    }
  });

  // Per-bone girth trim (perpendicular-to-axis), applied during transfer.
  const girthFor = (mi: number): number => {
    const u = unityNames[mi];
    if (/^(Chest|UpperChest)$|Shoulder/.test(u)) return 0.9;
    if (/UpperArm|LowerArm/.test(u)) return 0.9;
    return 1;
  };

  // Per-bone segment-length stretch ratio (mean over children on both sides).
  const segLen = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const srcChildren = skeleton.bones.map((b) =>
    childBones(b).map((c) => skeleton.bones.indexOf(c)).filter((x) => x >= 0),
  );
  const boneScale = skeleton.bones.map((b, j) => {
    const m = boneOurIndex[j];
    let xLen = mean(srcChildren[j].map((cj) => jointWorld[j].distanceTo(jointWorld[cj])));
    if (xLen < 1e-4 && b.parent && (b.parent as THREE.Bone).isBone) {
      const pj = skeleton.bones.indexOf(b.parent as THREE.Bone);
      if (pj >= 0) xLen = jointWorld[pj].distanceTo(jointWorld[j]);
    }
    let oLen = mean(ourChildren[m].map((cm) => segLen(ourWorld[m], ourWorld[cm])));
    if (oLen < 1e-4 && parents[m] >= 0) oLen = segLen(ourWorld[parents[m]], ourWorld[m]);
    if (xLen < 1e-4 || oLen < 1e-4) return 1;
    return Math.min(2.5, Math.max(0.3, oLen / xLen));
  });

  // --- 3+4. evaluate skin in the aligned pose; transfer vertices -----------
  const meshes: BodyMeshData[] = [];
  for (const m of skinnedMeshes) {
    const geo = m.geometry;
    const pos = geo.getAttribute("position");
    const sIdx = geo.getAttribute("skinIndex");
    const sWgt = geo.getAttribute("skinWeight");
    const count = pos.count;

    const outPos = new Float32Array(count * 3);
    const outIdx = new Uint16Array(count * 4);
    const outWgt = new Float32Array(count * 4);
    const headWeight = new Float32Array(count);

    const v = new THREE.Vector3();
    const acc = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      // True skinned world position in the aligned pose.
      v.fromBufferAttribute(pos, i);
      m.applyBoneTransform(i, v);
      m.localToWorld(v);
      acc.set(0, 0, 0);
      let wsum = 0;
      for (let k = 0; k < 4; k++) {
        const j = sIdx.getComponent(i, k);
        const w = sWgt.getComponent(i, k);
        if (w === 0) continue;
        const mi = boneOurIndex[j];
        const ax = ourAxis[mi] ?? Y_UP;
        const ox = v.x - jointWorld[j].x;
        const oy = v.y - jointWorld[j].y;
        const oz = v.z - jointWorld[j].z;
        const axial = ox * ax.x + oy * ax.y + oz * ax.z;
        // Axial part stretched by the segment ratio; perpendicular part
        // (girth) trimmed per bone — the asset's heroic upper body reads
        // oversized next to the face head.
        const g = girthFor(mi);
        const px = (ox - ax.x * axial) * g;
        const py = (oy - ax.y * axial) * g;
        const pz = (oz - ax.z * axial) * g;
        const na = axial * boneScale[j];
        acc.x += w * (ourWorld[mi][0] + px + ax.x * na);
        acc.y += w * (ourWorld[mi][1] + py + ax.y * na);
        acc.z += w * (ourWorld[mi][2] + pz + ax.z * na);
        outIdx[i * 4 + k] = mi;
        outWgt[i * 4 + k] = w;
        wsum += w;
        if (boneIsHead[j]) headWeight[i] += w;
      }
      if (wsum > 1e-6) acc.multiplyScalar(1 / wsum);
      outPos[i * 3] = acc.x; outPos[i * 3 + 1] = acc.y; outPos[i * 3 + 2] = acc.z;
    }

    // Drop only the HEAD geometry: triangles whose verts are all weighted to
    // head bones AND sit above the head joint (keeps the whole neck; the cut
    // follows the mesh's horizontal loop at the head joint and hides inside
    // the Face mesh). Then compact verts.
    const cutY = ourWorld[headIdx] ? ourWorld[headIdx][1] - 0.015 : Infinity;
    const srcIndices = geo.index
      ? (geo.index.array as ArrayLike<number>)
      : Array.from({ length: count }, (_, i) => i);
    const keptTris: number[] = [];
    const aboveCut = (vi: number) =>
      headWeight[vi] > 0.5 && outPos[vi * 3 + 1] > cutY;
    for (let t = 0; t < srcIndices.length; t += 3) {
      const a = srcIndices[t], b2 = srcIndices[t + 1], c2 = srcIndices[t + 2];
      if (aboveCut(a) && aboveCut(b2) && aboveCut(c2)) continue;
      keptTris.push(a, b2, c2);
    }
    const remap = new Int32Array(count).fill(-1);
    let next = 0;
    for (const vi of keptTris) if (remap[vi] < 0) remap[vi] = next++;
    if (next === 0) continue;
    const positions = new Float32Array(next * 3);
    const skinIndex = new Uint16Array(next * 4);
    const skinWeight = new Float32Array(next * 4);
    for (let i = 0; i < count; i++) {
      const r = remap[i];
      if (r < 0) continue;
      positions.set(outPos.subarray(i * 3, i * 3 + 3), r * 3);
      skinIndex.set(outIdx.subarray(i * 4, i * 4 + 4), r * 4);
      skinWeight.set(outWgt.subarray(i * 4, i * 4 + 4), r * 4);
    }
    const indices = new Uint32Array(keptTris.length);
    for (let t = 0; t < keptTris.length; t++) indices[t] = remap[keptTris[t]];

    // Recompute smooth normals on the transferred geometry.
    const tmpGeo = new THREE.BufferGeometry();
    tmpGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    tmpGeo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    tmpGeo.computeVertexNormals();
    const normals = new Float32Array(tmpGeo.getAttribute("normal").array as ArrayLike<number>);
    tmpGeo.dispose();

    meshes.push({
      name: meshes.length === 0 ? "Body" : `Body${meshes.length + 1}`,
      positions,
      normals,
      indices,
      skinIndex,
      skinWeight,
    });
  }

  return { meshes, joints };
}

const Y_UP = new THREE.Vector3(0, 1, 0);

/** Convert preview-space body data (meters) into FBX skinned-mesh exports (cm). */
export function bodyToSkinnedMeshExports(meshes: BodyMeshData[]): SkinnedMeshExport[] {
  return meshes.map((m) => {
    const positions = new Float64Array(m.positions.length);
    for (let i = 0; i < m.positions.length; i++) positions[i] = m.positions[i] * 100;
    const normals = new Float64Array(m.normals.length);
    normals.set(m.normals);

    // Gather per-bone clusters; merge duplicate influences per vertex.
    const byBone = new Map<number, Map<number, number>>();
    const count = m.positions.length / 3;
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 4; k++) {
        const w = m.skinWeight[i * 4 + k];
        if (w < 1e-4) continue;
        const bone = m.skinIndex[i * 4 + k];
        let entry = byBone.get(bone);
        if (!entry) byBone.set(bone, (entry = new Map()));
        entry.set(i, (entry.get(i) ?? 0) + w);
      }
    }
    const clusters = [...byBone.entries()].map(([boneIndex, perVert]) => ({
      boneIndex,
      pointIndices: Int32Array.from(perVert.keys()),
      weights: Float64Array.from(perVert.values()),
    }));

    return { name: m.name, positions, normals, indices: m.indices, clusters };
  });
}

/** Browser-side cached loader for the body-skeleton joints (for proportions). */
export function getBodyJoints(
  parents: number[],
  bindPos: Vec3[],
  unityNames: string[],
): Promise<(Vec3 | null)[]> {
  return buildBodyData(parents, bindPos, unityNames).then((d) => d.joints);
}
