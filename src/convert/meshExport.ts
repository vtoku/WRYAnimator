import type { ResampledClip } from "./clip.ts";
import { bindWorldPositions } from "./clip.ts";
import type { SkinnedMeshExport } from "../fbx/animationFbx.ts";
import type { FaceMeshData } from "../preview/face.ts";
import { toFacecapName } from "../preview/face.ts";

// Measured from the bundled body's original head mesh
// (scripts/measureBodyHead.mjs against public/body.glb): 28.5cm tall,
// centered 11.5cm above the Head joint, at a 1.512m head-joint height.
// The facecap head is sized proportionally to the skeleton's actual head
// height so it matches the body's own head 1:1 in body-proportions mode.
export const BODY_HEAD_HEIGHT_M = 0.267;
export const BODY_HEAD_LIFT_M = 0.076;
export const BODY_HEAD_JOINT_Y = 1.596;

/**
 * Bake the facecap head into world-space T-pose coordinates (cm), skinned
 * 100% to the Head bone, with ARKit blendshape channels mapped by name.
 */
export function buildFaceMesh(resampled: ResampledClip, mesh: FaceMeshData): SkinnedMeshExport {
  const headIndex = resampled.names.indexOf("Head");
  const headWorld = bindWorldPositions(resampled.parents, resampled.bindPos)[headIndex];
  // Proportional to the skeleton's head-joint height: 1:1 with the bundled
  // body's own head in body-proportions mode, scaled for recorded avatars.
  const k = headWorld[1] / BODY_HEAD_JOINT_Y;
  const heightCm = BODY_HEAD_HEIGHT_M * 100 * k;
  const liftCm = BODY_HEAD_LIFT_M * 100 * k;
  const scale = heightCm / (mesh.height || 1);
  const [cx, cy, cz] = mesh.center;
  const hx = headWorld[0] * 100;
  const hy = headWorld[1] * 100 + liftCm;
  const hz = headWorld[2] * 100;

  // No rotation: the facecap head and the exported skeleton both face +Z.
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = (mesh.positions[i] - cx) * scale + hx;
    positions[i + 1] = (mesh.positions[i + 1] - cy) * scale + hy;
    positions[i + 2] = (mesh.positions[i + 2] - cz) * scale + hz;
  }
  const normals = new Float64Array(mesh.normals.length);
  normals.set(mesh.normals);

  const channels: NonNullable<SkinnedMeshExport["channels"]> = [];
  resampled.face?.names.forEach((name, n) => {
    const src = mesh.morphs[toFacecapName(name)];
    if (!src) return;
    const weights = resampled.face!.tracks[n];
    let moved = 0;
    for (let i = 0; i < weights.length; i++) moved = Math.max(moved, Math.abs(weights[i]));
    if (moved < 0.01) return;
    const deltas = new Float64Array(src.length);
    for (let i = 0; i < src.length; i++) deltas[i] = src[i] * scale;
    channels.push({ name, deltas, weights });
  });

  const pointCount = mesh.positions.length / 3;
  const pointIndices = new Int32Array(pointCount);
  for (let i = 0; i < pointCount; i++) pointIndices[i] = i;
  const weights = new Float64Array(pointCount).fill(1);

  return {
    // "Face" matches the VRM/VRoid mesh-naming convention so downstream
    // tools that key blendshapes off the VRM face mesh name find it.
    name: "Face",
    positions,
    normals,
    indices: mesh.indices,
    clusters: [{ boneIndex: headIndex, pointIndices, weights }],
    channels,
  };
}
