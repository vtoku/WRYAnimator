import * as THREE from "three";
import { loadGltf } from "./loadGltf.ts";
import { extractSpringNodeIndices } from "./springs.ts";
import { buildModel } from "./export.ts";
import type { BuildInput } from "./build.ts";
import { sanitizeGlb, parseGlbChunks, parseVrmHumanoid } from "../vrm/vrmHumanoid.ts";

// Orchestrator glue for the Shogun target-rig export. This is the piece that
// VRMxShogun kept in its own main.ts: GLTFLoader parse + node maps + VRM
// version handling, feeding the ported rebake (build.ts) and ASCII writer
// (asciiFbx.ts). It consumes the raw VRM/GLB bytes and depends on nothing under
// src/convert or src/rig.
//
// Output is Y-up (matching the VRM rest pose) with meters->cm and
// UnitScaleFactor=1 — a static skeleton + skinned mesh, no animation.

export interface ShogunExportResult {
  fbx: string;
  boneCount: number;
  totalVertices: number;
  springBoneCount: number;
  strippedSprings: boolean;
  version: "0.x" | "1.0" | null;
}

/** Which VRM spec (if any) the JSON declares. Null for a plain GLB. */
export function detectVrmVersion(json: any): "0.x" | "1.0" | null {
  const ext = json?.extensions;
  if (!ext) return null;
  if (ext.VRMC_vrm) return "1.0";
  if (ext.VRM) return "0.x";
  return null;
}

/** True when the bytes are a VRM (either spec). Used to gate the Export row. */
export function isVrmBody(bytes: ArrayBuffer): boolean {
  const chunks = parseGlbChunks(sanitizeGlb(bytes));
  return chunks ? detectVrmVersion(chunks.json) !== null : false;
}

// Node-index <-> object maps from GLTFLoader associations, so the export uses
// authoritative glTF node names + hierarchy (not GLTFLoader's sanitized names).
function buildNodeMaps(gltf: any): {
  nodeToObj: Map<number, THREE.Object3D>;
  objToNode: Map<THREE.Object3D, number>;
} {
  const nodeToObj = new Map<number, THREE.Object3D>();
  const objToNode = new Map<THREE.Object3D, number>();
  const assoc: Map<any, any> | undefined = gltf.parser?.associations;
  if (assoc) {
    for (const [obj, m] of assoc) {
      if (m && typeof m.nodes === "number") {
        nodeToObj.set(m.nodes, obj as THREE.Object3D);
        objToNode.set(obj as THREE.Object3D, m.nodes);
      }
    }
  }
  return { nodeToObj, objToNode };
}

/**
 * Build a Shogun target-rig ASCII FBX from raw VRM/GLB bytes.
 * @param bytes the VRM/GLB file bytes (e.g. userBodyBytes.data)
 * @param opts.stripSprings drop VRM spring bones onto their nearest kept parent
 */
export async function exportShogunFbx(
  bytes: ArrayBuffer,
  opts: { stripSprings: boolean },
): Promise<ShogunExportResult> {
  // Patch invalid NaN/Infinity in the JSON chunk before either parser sees it.
  const buffer = sanitizeGlb(bytes);
  const chunks = parseGlbChunks(buffer);
  const json: any = chunks?.json ?? {};
  const version = detectVrmVersion(json);
  const humanoidMap = parseVrmHumanoid(buffer);

  const gltf = await loadGltf(buffer);

  // Normalize VRM 0.x forward axis to match VRM 1.0 (three-vrm does the same).
  if (version === "0.x") gltf.scene.rotateY(Math.PI);

  // Bad accessor min/max (e.g. from NaN) yields wrong bounds; recompute from the
  // actual vertices so nothing is culled during the world-position bake.
  gltf.scene.traverse((o: any) => {
    if (o.isMesh && o.geometry) {
      o.geometry.computeBoundingBox();
      o.geometry.computeBoundingSphere();
      o.frustumCulled = false;
    }
  });

  const { nodeToObj, objToNode } = buildNodeMaps(gltf);
  const springNodes = extractSpringNodeIndices(json);

  const input: BuildInput = {
    scene: gltf.scene,
    json,
    nodeToObj,
    objToNode,
    springNodes,
    stripSprings: opts.stripSprings,
    humanoidBoneNames: humanoidMap ? [...humanoidMap.values()] : [],
    // Y-up output matching the VRM rest pose (UpAxis stays Y either way).
    rotateExport: false,
  };

  const { result, toFbx } = buildModel(input);
  return {
    fbx: toFbx(),
    boneCount: result.model.boneCount,
    totalVertices: result.model.totalVertices,
    springBoneCount: result.springBoneCount,
    strippedSprings: opts.stripSprings && springNodes.size > 0,
    version,
  };
}
