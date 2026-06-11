import type { ResampledClip } from "./clip.ts";
import { bindWorldPositions } from "./clip.ts";
import type { SkinnedMeshExport } from "../fbx/animationFbx.ts";
import type { FaceMeshData } from "../preview/face.ts";
import { toFacecapName } from "../preview/face.ts";

// Measured from Ybot's original head mesh (scripts/measureYbotHead.mjs):
// 26.7cm tall, centered 7.6cm above the Head joint, on a 1.596m head-joint
// height. The facecap head is sized proportionally to the skeleton's actual
// head height so it matches Ybot 1:1 in Ybot-proportions mode and scales for
// any recorded avatar.
export const YBOT_HEAD_HEIGHT_M = 0.267;
export const YBOT_HEAD_LIFT_M = 0.076;
export const YBOT_HEAD_JOINT_Y = 1.596;

/**
 * Bake the facecap head into world-space T-pose coordinates (cm), skinned
 * 100% to the Head bone, with ARKit blendshape channels mapped by name.
 */
export function buildFaceMesh(resampled: ResampledClip, mesh: FaceMeshData): SkinnedMeshExport {
  const headIndex = resampled.names.indexOf("Head");
  const headWorld = bindWorldPositions(resampled.parents, resampled.bindPos)[headIndex];
  // Proportional to the skeleton's head-joint height: 1:1 with Ybot's original
  // head in Ybot-proportions mode, scaled accordingly for recorded avatars.
  const k = headWorld[1] / YBOT_HEAD_JOINT_Y;
  const heightCm = YBOT_HEAD_HEIGHT_M * 100 * k;
  const liftCm = YBOT_HEAD_LIFT_M * 100 * k;
  const scale = heightCm / (mesh.height || 1);
  const [cx, cy, cz] = mesh.center;
  const hx = headWorld[0] * 100;
  const hy = headWorld[1] * 100 + liftCm;
  const hz = headWorld[2] * 100;

  // No rotation: the facecap head faces +Z, the same way the exported body
  // faces (the preview's 180° flips are display-only and cancel out).
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
    name: "FaceMesh",
    positions,
    normals,
    indices: mesh.indices,
    clusters: [{ boneIndex: headIndex, pointIndices, weights }],
    channels,
  };
}
