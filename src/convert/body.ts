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
 * The bundled body is Quaternius' "Animated Base Character" (CC0) ??? a smooth
 * skinned human. Pipeline (works for ANY humanoid GLB, regardless of how its
 * bind matrices were exported):
 *   1. map source bone names ??? our HumanBodyBones indices,
 *   2. FK-align the source skeleton's rest pose to OUR T-pose (rotate each
 *      bone so its segment direction matches ours ??? fixes A-poses and facing),
 *   3. evaluate the skin CPU-side in that aligned pose (true skinning math),
 *   4. transfer each vertex: offset from its bone's joint, STRETCHED along
 *      the bone axis by the segment-length ratio (girth preserved), placed at
 *      our joint, blended by the original weights.
 * Head/eye geometry is dropped ??? the Face mesh replaces it.
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

// Blender/Rigify-style names (Quaternius) ??? Unity HumanBodyBones names.
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

// Quaternius "modular" rig names (UpperArmL, WristR, Abdomen, Torso, Index1L…)
// → Unity HumanBodyBones names.
const MODULAR_BASE: Record<string, string> = {
  Hips: "Hips",
  Abdomen: "Spine",
  Torso: "Chest",
  Chest: "UpperChest",
  Neck: "Neck",
  Head: "Head",
  Shoulder: "Shoulder",
  UpperArm: "UpperArm",
  LowerArm: "LowerArm",
  Wrist: "Hand",
  UpperLeg: "UpperLeg",
  LowerLeg: "LowerLeg",
  Foot: "Foot",
  Toe: "Toes",
  ToeBase: "Toes",
};
const MODULAR_FINGER: Record<string, string> = {
  Thumb: "Thumb",
  Index: "Index",
  Middle: "Middle",
  Ring: "Ring",
  Pinky: "Little",
};
function modularToUnity(name: string): string | null {
  const side = name.match(/^(.*?)([LR])$/);
  const base = side ? side[1] : name;
  const prefix = side ? (side[2] === "L" ? "Left" : "Right") : "";
  const finger = base.match(/^(Thumb|Index|Middle|Ring|Pinky)([123])$/);
  if (finger && prefix) {
    const seg = ["Proximal", "Intermediate", "Distal"][Number(finger[2]) - 1];
    return `${prefix}${MODULAR_FINGER[finger[1]]}${seg}`;
  }
  const mapped = MODULAR_BASE[base];
  if (!mapped) return null;
  if (/^(Hips|Spine|Chest|UpperChest|Neck|Head)$/.test(mapped)) return prefix ? null : mapped;
  return prefix ? `${prefix}${mapped}` : null;
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

  // Unity name ??? our index, plus MoBu names (covers Mixamo-style rigs).
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

  // Capture the REST state in plain world space, using the asset's OWN
  // skinning for the rest shape (whatever its bind convention — 2017-era
  // Quaternius and some Blender exports ship degenerate inverse binds, so we
  // never rely on them after this point).
  for (const m of skinnedMeshes) m.skeleton.update();
  const restWorldVerts = skinnedMeshes.map((m) => {
    const pos = m.geometry.getAttribute("position");
    const out = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      m.applyBoneTransform(i, v);
      m.localToWorld(v);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    return out;
  });
  const childBones = (b: THREE.Bone) =>
    b.children.filter((c) => (c as THREE.Bone).isBone) as THREE.Bone[];
  const segLen = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  // Rest-space direction from each Foot joint toward its foot-vertex centroid
  // (used to orient feet on rigs without toe bones).
  const footRestDir = new Map<number, THREE.Vector3>();
  {
    const sums = new Map<number, { c: THREE.Vector3; n: number }>();
    skinnedMeshes.forEach((m, mi3) => {
      const sIdx = m.geometry.getAttribute("skinIndex");
      const sWgt = m.geometry.getAttribute("skinWeight");
      const rest = restWorldVerts[mi3];
      for (let i = 0; i < rest.length / 3; i++) {
        for (let k = 0; k < 4; k++) {
          const j = sIdx.getComponent(i, k);
          if (sWgt.getComponent(i, k) < 0.4) continue;
          if (!/Foot/.test(skeleton.bones[j]?.name ?? "")) continue;
          let e = sums.get(j);
          if (!e) sums.set(j, (e = { c: new THREE.Vector3(), n: 0 }));
          e.c.x += rest[i * 3]; e.c.y += rest[i * 3 + 1]; e.c.z += rest[i * 3 + 2];
          e.n++;
        }
      }
    });
    sums.forEach((e, j) => {
      const ankle = skeleton.bones[j].getWorldPosition(new THREE.Vector3());
      const dir = e.c.multiplyScalar(1 / e.n).sub(ankle);
      if (dir.lengthSq() > 1e-8) footRestDir.set(j, dir.normalize());
    });
  }

  // Resolve a source bone name → our index via all known naming families.
  const resolveName = (raw: string): number | undefined => {
    const n = normalizeBoneName(raw);
    return (
      nameToIndex.get(n) ??
      nameToIndex.get(RIGIFY_MAP[n] ?? "") ??
      nameToIndex.get(modularToUnity(n) ?? "")
    );
  };
  // Source bone → our bone (walk up through unmapped helpers like HeadTop_End).
  const boneOurIndex = skeleton.bones.map((b) => {
    let cur: THREE.Object3D | null = b;
    while (cur) {
      const idx = resolveName(cur.name);
      if (idx !== undefined) return idx;
      cur = cur.parent;
    }
    return 0;
  });
  const directlyMapped = skeleton.bones.map((b) => resolveName(b.name) !== undefined);

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

  // --- 2+3. Closed-form world-space delta per bone (NO scene-graph edits —
  // hierarchy mutation with non-uniform scales shears across rig conventions):
  //   D_j = T(ourJoint_m) . Stretch(ourAxis_m, r_j) . R(G.restDir_j -> ourAxis_m) . G . T(-restJoint_j)
  // where G is a global yaw turning the rest pose to face +Z.
  const restJoint = skeleton.bones.map((b) => b.getWorldPosition(new THREE.Vector3()));

  // Rest segment direction per bone: mean over mapped children; childless feet
  // use the foot-vertex centroid; otherwise the parent segment.
  const restDir: (THREE.Vector3 | null)[] = skeleton.bones.map((b, j) => {
    const dir = new THREE.Vector3();
    let used = 0;
    for (const c of childBones(b)) {
      const cj = skeleton.bones.indexOf(c);
      if (cj < 0 || !directlyMapped[cj] || boneOurIndex[cj] === boneOurIndex[j]) continue;
      dir.add(restJoint[cj].clone().sub(restJoint[j]));
      used++;
    }
    if (used === 0 && footRestDir.has(j)) dir.copy(footRestDir.get(j)!);
    if (dir.lengthSq() < 1e-10 && b.parent && (b.parent as THREE.Bone).isBone) {
      const pj = skeleton.bones.indexOf(b.parent as THREE.Bone);
      if (pj >= 0) dir.subVectors(restJoint[j], restJoint[pj]);
    }
    return dir.lengthSq() > 1e-10 ? dir.normalize() : null;
  });
  const restLen = skeleton.bones.map((b, j) => {
    const ls: number[] = [];
    for (const c of childBones(b)) {
      const cj = skeleton.bones.indexOf(c);
      if (cj < 0 || !directlyMapped[cj] || boneOurIndex[cj] === boneOurIndex[j]) continue;
      ls.push(restJoint[cj].distanceTo(restJoint[j]));
    }
    if (ls.length === 0 && b.parent && (b.parent as THREE.Bone).isBone) {
      const pj = skeleton.bones.indexOf(b.parent as THREE.Bone);
      if (pj >= 0) ls.push(restJoint[pj].distanceTo(restJoint[j]));
    }
    return mean(ls);
  });

  // Global yaw: rest forward heading (toes relative to feet, or foot-vertex
  // centroids) turned to +Z.
  const G = new THREE.Matrix4();
  {
    const heading = new THREE.Vector3();
    skeleton.bones.forEach((b, j) => {
      if (!directlyMapped[j]) return;
      const u = unityNames[boneOurIndex[j]];
      if (u !== "LeftToes" && u !== "RightToes") return;
      const parentBone = b.parent as THREE.Bone;
      if (!parentBone?.isBone) return;
      const pj = skeleton.bones.indexOf(parentBone);
      if (pj >= 0) heading.add(restJoint[j].clone().sub(restJoint[pj]));
    });
    if (heading.lengthSq() < 1e-8) {
      footRestDir.forEach((d) => heading.add(d));
    }
    heading.y = 0;
    if (heading.lengthSq() > 1e-8) {
      heading.normalize();
      G.makeRotationY(-Math.atan2(heading.x, heading.z));
    }
  }

  // Yawed rest joints/dirs.
  const yawedJoint = restJoint.map((p) => p.clone().applyMatrix4(G));
  const gRot = new THREE.Matrix3().setFromMatrix4(G);
  const yawedDir = restDir.map((d) => (d ? d.clone().applyMatrix3(gRot) : null));

  // T-pose the JOINT TABLE (pure vector math): walk parents-first accumulating
  // per-chain rotations that take each segment to its canonical T-pose
  // direction (arms ±X, spine +Y, legs −Y, feet keep pitch but head +Z).
  // Without this, A-pose rests would become the exported bind layout and the
  // T-pose rest/HIK characterization would be wrong.
  const canonicalAxis = (unityName: string, cur: THREE.Vector3): THREE.Vector3 | null => {
    if (/^Left(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/.test(unityName)) {
      return new THREE.Vector3(1, 0, 0);
    }
    if (/^Right(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/.test(unityName)) {
      return new THREE.Vector3(-1, 0, 0);
    }
    if (/^(Spine|Chest|UpperChest|Neck)$/.test(unityName)) return new THREE.Vector3(0, 1, 0);
    if (/UpperLeg|LowerLeg/.test(unityName)) return new THREE.Vector3(0, -1, 0);
    if (/Foot|Toes/.test(unityName)) {
      const horiz = Math.hypot(cur.x, cur.z);
      return new THREE.Vector3(0, cur.y, horiz).normalize();
    }
    return null;
  };
  const depthOf = (o: THREE.Object3D) => {
    let d = 0;
    for (let p = o.parent; p; p = p.parent) d++;
    return d;
  };
  const depthOrder = [...skeleton.bones].sort((a, b) => depthOf(a) - depthOf(b));
  const tposeJoint = restJoint.map(() => new THREE.Vector3());
  const chainRot = restJoint.map(() => new THREE.Quaternion());
  for (const b of depthOrder) {
    const j = skeleton.bones.indexOf(b);
    const parentBone = b.parent as THREE.Bone;
    const pj = parentBone?.isBone ? skeleton.bones.indexOf(parentBone) : -1;
    if (pj >= 0) {
      chainRot[j].copy(chainRot[pj]);
      tposeJoint[j]
        .copy(yawedJoint[j])
        .sub(yawedJoint[pj])
        .applyQuaternion(chainRot[j])
        .add(tposeJoint[pj]);
    } else {
      tposeJoint[j].copy(yawedJoint[j]);
    }
    if (!directlyMapped[j]) continue;
    // This bone's own alignment, applied to everything below it.
    const cur = new THREE.Vector3();
    let used = 0;
    for (const c of childBones(b)) {
      const cj = skeleton.bones.indexOf(c);
      if (cj < 0 || !directlyMapped[cj] || boneOurIndex[cj] === boneOurIndex[j]) continue;
      cur.add(yawedJoint[cj].clone().sub(yawedJoint[j]).applyQuaternion(chainRot[j]));
      used++;
    }
    if (used === 0 && yawedDir[j]) cur.copy(yawedDir[j]!).applyQuaternion(chainRot[j]);
    if (cur.lengthSq() < 1e-10) continue;
    cur.normalize();
    const tgt = canonicalAxis(unityNames[boneOurIndex[j]], cur);
    if (tgt) chainRot[j].premultiply(new THREE.Quaternion().setFromUnitVectors(cur, tgt));
  }
  const joints: (Vec3 | null)[] = unityNames.map(() => null);
  skeleton.bones.forEach((_, j) => {
    if (directlyMapped[j] && joints[boneOurIndex[j]] === null) {
      const p = tposeJoint[j];
      joints[boneOurIndex[j]] = [p.x, p.y, p.z];
    }
  });

  // Per-bone world delta matrices.
  const stretchAlong = (a: THREE.Vector3, r: number): THREE.Matrix4 => {
    const k = r - 1;
    return new THREE.Matrix4().set(
      1 + k * a.x * a.x, k * a.x * a.y, k * a.x * a.z, 0,
      k * a.y * a.x, 1 + k * a.y * a.y, k * a.y * a.z, 0,
      k * a.z * a.x, k * a.z * a.y, 1 + k * a.z * a.z, 0,
      0, 0, 0, 1,
    );
  };
  const boneDelta = skeleton.bones.map((_, j) => {
    const m = boneOurIndex[j];
    const D = new THREE.Matrix4().makeTranslation(-restJoint[j].x, -restJoint[j].y, -restJoint[j].z);
    D.premultiply(G);
    const dst = ourAxis[m];
    const dir = yawedDir[j];
    if (dst && dir) {
      const q = new THREE.Quaternion().setFromUnitVectors(dir, dst);
      D.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
      let oLen = mean(ourChildren[m].map((cm) => segLen(ourWorld[m], ourWorld[cm])));
      if (oLen < 1e-4 && parents[m] >= 0) oLen = segLen(ourWorld[parents[m]], ourWorld[m]);
      if (oLen > 1e-4 && restLen[j] > 1e-4) {
        const r = Math.min(4, Math.max(0.1, oLen / restLen[j]));
        D.premultiply(stretchAlong(dst, r));
      }
    }
    D.premultiply(new THREE.Matrix4().makeTranslation(ourWorld[m][0], ourWorld[m][1], ourWorld[m][2]));
    return D;
  });


  // --- 4. deform: world-space per-bone deltas applied to the captured rest
  // vertices, blended by the authored weights. Convention-free: only world
  // matrices are involved, never the asset's bind matrices.
  const meshes: BodyMeshData[] = [];
  for (let mi2 = 0; mi2 < skinnedMeshes.length; mi2++) {
    const m = skinnedMeshes[mi2];
    // Modular packs ship the swappable head as separate sub-meshes (incl.
    // earrings/glasses) — skip the whole section; the Face mesh replaces it.
    if (/(^|_)(Head|Ears?)(_|$)/i.test(m.name)) continue;
    const rest = restWorldVerts[mi2];
    const geo = m.geometry;
    const sIdx = geo.getAttribute("skinIndex");
    const sWgt = geo.getAttribute("skinWeight");
    const count = rest.length / 3;

    const outPos = new Float32Array(count * 3);
    const outIdx = new Uint16Array(count * 4);
    const outWgt = new Float32Array(count * 4);
    const headWeight = new Float32Array(count);

    const v = new THREE.Vector3();
    const acc = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      acc.set(0, 0, 0);
      let wsum = 0;
      for (let k = 0; k < 4; k++) {
        const j = sIdx.getComponent(i, k);
        const w = sWgt.getComponent(i, k);
        if (w === 0) continue;
        v.set(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]).applyMatrix4(boneDelta[j]);
        acc.addScaledVector(v, w);
        wsum += w;
        outIdx[i * 4 + k] = boneOurIndex[j];
        outWgt[i * 4 + k] = w;
        if (boneIsHead[j]) headWeight[i] += w;
      }
      if (wsum > 1e-6) acc.multiplyScalar(1 / wsum);
      else acc.set(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]);
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
      // Drop tris touching ANY removed head vert ??? keeping boundary-crossing
      // tris leaves upward spikes around the neck.
      if (aboveCut(a) || aboveCut(b2) || aboveCut(c2)) continue;
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
