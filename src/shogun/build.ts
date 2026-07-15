import * as THREE from "three";

// Ported from VRMxShogun (src/convert/build.ts). The bone rebake: world-align
// every joint so bind pose has identity rotation, with local translation = the
// world offset from parent, and skin clusters recomputed from those world
// positions (TransformLink = bone world bind, Transform = its inverse). The
// ORIGINAL glTF node names and hierarchy are preserved verbatim — renaming
// breaks name-keyed streaming retarget back into Unity/Warudo.
//
// The only change from the original is that this variant takes a plain list of
// humanoid bone names instead of a VrmInfo object, so src/shogun/ depends on
// nothing under src/convert. The rebake output is byte-identical.

// glTF is meters; we author the FBX in centimeters and declare UnitScaleFactor=1
// so the avatar imports at a correct, predictable human size.
const METERS_TO_CM = 100;

export interface ExportBone {
  id: number;
  name: string; // ORIGINAL glTF node name (dots/case preserved) — never renamed
  parentIndex: number; // index into bones[], -1 if root
  worldPos: [number, number, number]; // rebaked world position, cm
}

export interface ExportCluster {
  boneIndex: number;
  indexes: number[];
  weights: number[];
}

export interface ExportMesh {
  name: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  polygonVertexIndex: number[];
  vertexCount: number;
  color: [number, number, number];
  clusters: ExportCluster[];
}

export interface ExportModel {
  bones: ExportBone[];
  meshes: ExportMesh[];
  boneCount: number;
  totalVertices: number;
}

export interface BuildInput {
  scene: THREE.Object3D;
  json: any;
  /** glTF node index -> three.js object (from GLTFLoader associations). */
  nodeToObj: Map<number, THREE.Object3D>;
  /** three.js object -> glTF node index. */
  objToNode: Map<THREE.Object3D, number>;
  /** spring bone node indices (for stripping / display). */
  springNodes: Set<number>;
  stripSprings: boolean;
  /** VRM humanoid bone names, reported back for the meta line (cosmetic). */
  humanoidBoneNames?: string[];
  /** export the skeleton only (no meshes/skinning). */
  skeletonOnly?: boolean;
  /** pre-rotate the exported FBX +90° about X (face-down fix for Z-up Shogun). */
  rotateExport?: boolean;
}

export interface BuildResult {
  model: ExportModel;
  humanoidBones: string[];
  springBoneCount: number;
}

function collectSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh);
  });
  return out;
}

export function buildExportModel(input: BuildInput, idGen: () => number): BuildResult {
  const { scene, json, nodeToObj, objToNode } = input;
  scene.updateMatrixWorld(true);

  const nodes: any[] = json.nodes ?? [];
  const parentOfNode = new Map<number, number>();
  nodes.forEach((n, i) => {
    for (const c of n.children ?? []) parentOfNode.set(c, i);
  });

  // Skeleton = every skin joint PLUS all of its ancestors in the node tree, so
  // intermediate non-joint nodes (twist/sub/helper bones) are kept and the
  // hierarchy matches the VRM exactly.
  const jointSet = new Set<number>();
  for (const skin of json.skins ?? []) {
    for (const j of skin.joints ?? []) jointSet.add(j);
  }
  const exportSet = new Set<number>();
  for (const j of jointSet) {
    let cur: number | undefined = j;
    while (cur !== undefined && !exportSet.has(cur)) {
      exportSet.add(cur);
      cur = parentOfNode.get(cur);
    }
  }

  const strip = input.stripSprings && input.springNodes.size > 0 ? input.springNodes : null;
  const isKept = (n: number) => exportSet.has(n) && !strip?.has(n);

  // nearest ancestor node that survives (for parenting + reweight)
  const nearestKept = (n: number): number | undefined => {
    let p = parentOfNode.get(n);
    while (p !== undefined) {
      if (isKept(p)) return p;
      p = parentOfNode.get(p);
    }
    return undefined;
  };

  // ordered kept nodes, parent-first
  const orderedKept: number[] = [];
  const keptIndex = new Map<number, number>();
  const visit = (n: number) => {
    if (keptIndex.has(n) || !isKept(n)) return;
    const p = parentOfNode.get(n);
    if (p !== undefined && isKept(p)) visit(p);
    keptIndex.set(n, orderedKept.length);
    orderedKept.push(n);
  };
  for (const n of exportSet) if (isKept(n)) visit(n);

  // any node -> export index its weights land on (kept -> itself, stripped -> ancestor)
  const nodeToExport = new Map<number, number>();
  for (const n of exportSet) {
    if (isKept(n)) {
      nodeToExport.set(n, keptIndex.get(n)!);
    } else {
      const a = nearestKept(n);
      if (a !== undefined) nodeToExport.set(n, keptIndex.get(a)!);
    }
  }

  // Rebake: keep each node's world position, discard rotation (identity).
  const tmp = new THREE.Vector3();
  const exportBones: ExportBone[] = orderedKept.map((n) => {
    const obj = nodeToObj.get(n);
    if (obj) obj.matrixWorld.decompose(tmp, new THREE.Quaternion(), new THREE.Vector3());
    else tmp.set(0, 0, 0);
    const pa = nearestKept(n);
    return {
      id: idGen(),
      name: nodes[n]?.name ?? `node_${n}`,
      parentIndex: pa !== undefined ? keptIndex.get(pa)! : -1,
      worldPos: [tmp.x * METERS_TO_CM, tmp.y * METERS_TO_CM, tmp.z * METERS_TO_CM],
    };
  });

  const skinned = collectSkinnedMeshes(scene);
  let totalVertices = 0;
  const meshes: ExportMesh[] = input.skeletonOnly
    ? []
    : skinned.map((mesh, mi) => buildMesh(mesh, mi, objToNode, nodeToExport));
  for (const m of meshes) totalVertices += m.vertexCount;

  const springBoneCount = [...input.springNodes].filter((n) => exportSet.has(n)).length;

  return {
    model: { bones: exportBones, meshes, boneCount: exportBones.length, totalVertices },
    humanoidBones: input.humanoidBoneNames ?? [],
    springBoneCount,
  };
}

function buildMesh(
  mesh: THREE.SkinnedMesh,
  meshIndex: number,
  objToNode: Map<THREE.Object3D, number>,
  nodeToExport: Map<number, number>,
): ExportMesh {
  const geo = mesh.geometry as THREE.BufferGeometry;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nrm = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const skinIndex = geo.getAttribute("skinIndex") as THREE.BufferAttribute | undefined;
  const skinWeight = geo.getAttribute("skinWeight") as THREE.BufferAttribute | undefined;
  const vertexCount = pos.count;

  const world = mesh.matrixWorld;
  const normalMat = new THREE.Matrix3().getNormalMatrix(world);

  const positions = new Array<number>(vertexCount * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < vertexCount; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(world);
    positions[i * 3] = v.x * METERS_TO_CM;
    positions[i * 3 + 1] = v.y * METERS_TO_CM;
    positions[i * 3 + 2] = v.z * METERS_TO_CM;
  }

  const triIndices: number[] = [];
  if (geo.index) {
    const idx = geo.index;
    for (let i = 0; i < idx.count; i += 3) {
      triIndices.push(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
    }
  } else {
    for (let i = 0; i < vertexCount; i++) triIndices.push(i);
  }

  const polygonVertexIndex: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const n = new THREE.Vector3();
  for (let tt = 0; tt < triIndices.length; tt += 3) {
    const tri = [triIndices[tt], triIndices[tt + 1], triIndices[tt + 2]];
    for (let k = 0; k < 3; k++) {
      const vi = tri[k];
      polygonVertexIndex.push(k === 2 ? -(vi + 1) : vi);
      if (nrm) {
        n.fromBufferAttribute(nrm, vi).applyMatrix3(normalMat).normalize();
        normals.push(n.x, n.y, n.z);
      } else {
        normals.push(0, 1, 0);
      }
      if (uv) {
        uvs.push(uv.getX(vi), 1 - uv.getY(vi));
      } else {
        uvs.push(0, 0);
      }
    }
  }

  // exportBoneIndex -> (vertexIndex -> summed weight); summing matters when
  // stripping reroutes multiple influences onto the same kept parent.
  const acc = new Map<number, Map<number, number>>();
  if (skinIndex && skinWeight) {
    const localBones = mesh.skeleton.bones;
    for (let i = 0; i < vertexCount; i++) {
      for (let c = 0; c < 4; c++) {
        const w = skinWeight.getComponent(i, c);
        if (w <= 0) continue;
        const bone = localBones[skinIndex.getComponent(i, c)];
        const node = bone ? objToNode.get(bone) : undefined;
        const gIdx = node !== undefined ? nodeToExport.get(node) : undefined;
        if (gIdx === undefined) continue;
        let vm = acc.get(gIdx);
        if (!vm) {
          vm = new Map();
          acc.set(gIdx, vm);
        }
        vm.set(i, (vm.get(i) ?? 0) + w);
      }
    }
  }

  const clusters: ExportCluster[] = [];
  for (const [boneIndex, vm] of acc) {
    const indexes: number[] = [];
    const weights: number[] = [];
    for (const [vi, w] of vm) {
      indexes.push(vi);
      weights.push(w);
    }
    clusters.push({ boneIndex, indexes, weights });
  }

  const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
  const single = Array.isArray(mat) ? mat[0] : mat;
  const color =
    single && (single as any).color
      ? [(single as any).color.r, (single as any).color.g, (single as any).color.b]
      : [0.8, 0.8, 0.8];

  return {
    name: mesh.name || `mesh_${meshIndex}`,
    positions,
    normals,
    uvs,
    polygonVertexIndex,
    vertexCount,
    color: color as [number, number, number],
    clusters,
  };
}
