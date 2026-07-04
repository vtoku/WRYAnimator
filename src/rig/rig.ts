import type { ConvertedClip } from "../convert/clip.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";
import { quatMul, quatNormalize, quatSlerp, quatRotate } from "../convert/quat.ts";
import { solveTwoBone, qconj, vadd, vscale, vlerp, vnorm } from "../convert/ik.ts";
import { worldFromLocal, type FramePose } from "../convert/fk.ts";

// A minimal MotionBuilder-style control rig: adjustment layers over the
// cleaned clip. Each layer is override or additive with a weight, and holds
// sparse keys per effector. Keys interpolate linearly (slerp for rotation)
// and HOLD before the first / after the last key — bracket a local fix with
// neutral keys, exactly like MoBu layers.
//
// Additive keys store world-space DELTAS relative to the stack below the
// layer; override keys store absolute world targets, blended in by weight.
// Hands/feet solve through the shared two-bone IK (elbow/knee keep their
// recorded plane, end bone keeps its world rotation unless a rotation key
// says otherwise). Hips writes the root directly; head is rotation-only.

export type EffectorId =
  | "hips" | "leftHand" | "rightHand" | "leftFoot" | "rightFoot" | "head"
  | "spine" | "chest" | "neck"
  | "leftShoulder" | "rightShoulder"
  | "leftUpperArm" | "rightUpperArm" | "leftLowerArm" | "rightLowerArm"
  | "leftUpperLeg" | "rightUpperLeg" | "leftLowerLeg" | "rightLowerLeg";

export interface EffectorDef {
  id: EffectorId;
  label: string;
  /** Bone whose world transform the gizmo edits. */
  bone: string;
  /** Two-bone chain (root/mid) when the effector is IK-driven. */
  chain?: { root: string; mid: string };
  canMove: boolean;
  canRotate: boolean;
}

/**
 * MoBu-style cell set: IK effectors (hips, hands, feet) move AND rotate; the
 * major body bones are FK effectors that rotate in place — translating an FK
 * bone would stretch the skeleton, so reach for the IK effectors instead.
 */
export const EFFECTORS: EffectorDef[] = [
  { id: "hips", label: "Hips", bone: "Hips", canMove: true, canRotate: true },
  { id: "leftHand", label: "Left hand", bone: "LeftHand", chain: { root: "LeftUpperArm", mid: "LeftLowerArm" }, canMove: true, canRotate: true },
  { id: "rightHand", label: "Right hand", bone: "RightHand", chain: { root: "RightUpperArm", mid: "RightLowerArm" }, canMove: true, canRotate: true },
  { id: "leftFoot", label: "Left foot", bone: "LeftFoot", chain: { root: "LeftUpperLeg", mid: "LeftLowerLeg" }, canMove: true, canRotate: true },
  { id: "rightFoot", label: "Right foot", bone: "RightFoot", chain: { root: "RightUpperLeg", mid: "RightLowerLeg" }, canMove: true, canRotate: true },
  { id: "head", label: "Head", bone: "Head", canMove: false, canRotate: true },
  { id: "spine", label: "Spine", bone: "Spine", canMove: false, canRotate: true },
  { id: "chest", label: "Chest", bone: "Chest", canMove: false, canRotate: true },
  { id: "neck", label: "Neck", bone: "Neck", canMove: false, canRotate: true },
  { id: "leftShoulder", label: "Left shoulder", bone: "LeftShoulder", canMove: false, canRotate: true },
  { id: "rightShoulder", label: "Right shoulder", bone: "RightShoulder", canMove: false, canRotate: true },
  { id: "leftUpperArm", label: "Left upper arm", bone: "LeftUpperArm", canMove: false, canRotate: true },
  { id: "rightUpperArm", label: "Right upper arm", bone: "RightUpperArm", canMove: false, canRotate: true },
  { id: "leftLowerArm", label: "Left forearm", bone: "LeftLowerArm", canMove: false, canRotate: true },
  { id: "rightLowerArm", label: "Right forearm", bone: "RightLowerArm", canMove: false, canRotate: true },
  { id: "leftUpperLeg", label: "Left thigh", bone: "LeftUpperLeg", canMove: false, canRotate: true },
  { id: "rightUpperLeg", label: "Right thigh", bone: "RightUpperLeg", canMove: false, canRotate: true },
  { id: "leftLowerLeg", label: "Left shin", bone: "LeftLowerLeg", canMove: false, canRotate: true },
  { id: "rightLowerLeg", label: "Right shin", bone: "RightLowerLeg", canMove: false, canRotate: true },
];

export const effectorDef = (id: EffectorId): EffectorDef => EFFECTORS.find((e) => e.id === id)!;

export interface PosKey { time: number; v: Vec3; }
export interface RotKey { time: number; q: Quat; }

export interface RigTrack {
  effector: EffectorId;
  posKeys: PosKey[]; // sorted by time
  rotKeys: RotKey[];
}

export interface RigLayer {
  name: string;
  mode: "override" | "additive";
  weight: number; // 0..1
  enabled: boolean;
  tracks: RigTrack[];
}

export function makeLayer(name: string): RigLayer {
  return { name, mode: "additive", weight: 1, enabled: true, tracks: [] };
}

export function getTrack(layer: RigLayer, effector: EffectorId, create = false): RigTrack | null {
  let t = layer.tracks.find((tr) => tr.effector === effector) ?? null;
  if (!t && create) {
    t = { effector, posKeys: [], rotKeys: [] };
    layer.tracks.push(t);
  }
  return t;
}

const KEY_EPS = 1 / 120; // keys closer than half a frame replace each other

export function setPosKey(track: RigTrack, time: number, v: Vec3): void {
  const i = track.posKeys.findIndex((k) => Math.abs(k.time - time) < KEY_EPS);
  if (i >= 0) track.posKeys[i] = { time, v };
  else {
    track.posKeys.push({ time, v });
    track.posKeys.sort((a, b) => a.time - b.time);
  }
}

export function setRotKey(track: RigTrack, time: number, q: Quat): void {
  const i = track.rotKeys.findIndex((k) => Math.abs(k.time - time) < KEY_EPS);
  if (i >= 0) track.rotKeys[i] = { time, q };
  else {
    track.rotKeys.push({ time, q });
    track.rotKeys.sort((a, b) => a.time - b.time);
  }
}

/** Remove pos+rot keys within `eps` of `time`; returns how many went. */
export function deleteKeysAt(track: RigTrack, time: number, eps: number): number {
  const np = track.posKeys.length, nr = track.rotKeys.length;
  track.posKeys = track.posKeys.filter((k) => Math.abs(k.time - time) > eps);
  track.rotKeys = track.rotKeys.filter((k) => Math.abs(k.time - time) > eps);
  return np - track.posKeys.length + (nr - track.rotKeys.length);
}

/** All key times of a track, merged and deduped (for the chip list). */
export function keyTimes(track: RigTrack): number[] {
  const all = [...track.posKeys.map((k) => k.time), ...track.rotKeys.map((k) => k.time)].sort((a, b) => a - b);
  return all.filter((t, i) => i === 0 || t - all[i - 1] > KEY_EPS);
}

function samplePos(keys: PosKey[], t: number): Vec3 | null {
  if (!keys.length) return null;
  if (t <= keys[0].time) return keys[0].v;
  if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].v;
  let i = 0;
  while (keys[i + 1].time < t) i++;
  const a = keys[i], b = keys[i + 1];
  const frac = (t - a.time) / Math.max(1e-9, b.time - a.time);
  return vlerp(a.v, b.v, frac);
}

function sampleRot(keys: RotKey[], t: number): Quat | null {
  if (!keys.length) return null;
  if (t <= keys[0].time) return keys[0].q;
  if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].q;
  let i = 0;
  while (keys[i + 1].time < t) i++;
  const a = keys[i], b = keys[i + 1];
  const frac = (t - a.time) / Math.max(1e-9, b.time - a.time);
  return quatSlerp(a.q, b.q, frac);
}

const IDENTITY: Quat = [0, 0, 0, 1];

/** Live-drag value injected in place of the sampled keys. */
export interface Transient {
  layerIndex: number; // index into the FULL layer list
  effector: EffectorId;
  pos?: Vec3;
  rot?: Quat;
}

/** Copy one frame's local transforms out of a clip. */
export function poseAtFrame(clip: ConvertedClip, f: number): FramePose {
  const n = clip.names.length;
  const pos = new Array<Vec3>(n);
  const quat = new Array<Quat>(n);
  for (let b = 0; b < n; b++) {
    pos[b] = clip.localPos[b][f];
    quat[b] = clip.localQuat[b][f];
  }
  return { pos, quat };
}

/** Nearest frame index for a playback time. */
export function nearestFrame(clip: ConvertedClip, time: number): number {
  const t = clip.times[0] + Math.max(0, Math.min(clip.duration, time));
  let i = 0;
  while (i < clip.times.length - 2 && clip.times[i + 1] < t) i++;
  return t - clip.times[i] > (clip.times[i + 1] ?? clip.times[i]) - t ? i + 1 : i;
}

function applyEffector(
  pose: FramePose,
  names: string[],
  parents: number[],
  effector: EffectorId,
  mode: "override" | "additive",
  weight: number,
  pv: Vec3 | null,
  rv: Quat | null,
): void {
  const def = effectorDef(effector);
  const bone = names.indexOf(def.bone);
  if (bone < 0) return;

  if (effector === "hips") {
    // Root: world == local, write directly.
    if (pv) pose.pos[bone] = mode === "additive" ? vadd(pose.pos[bone], vscale(pv, weight)) : vlerp(pose.pos[bone], pv, weight);
    if (rv) {
      pose.quat[bone] = quatNormalize(
        mode === "additive" ? quatMul(quatSlerp(IDENTITY, rv, weight), pose.quat[bone]) : quatSlerp(pose.quat[bone], rv, weight),
      );
    }
    return;
  }

  if (!def.chain) {
    // Rotation-only effector (head): world-rotation edit on the bone.
    if (!rv) return;
    const world = worldFromLocal(parents, pose);
    const parentRot = world.rot[parents[bone]];
    const cur = world.rot[bone];
    const desired = mode === "additive" ? quatMul(quatSlerp(IDENTITY, rv, weight), cur) : quatSlerp(cur, rv, weight);
    pose.quat[bone] = quatNormalize(quatMul(qconj(parentRot), desired));
    return;
  }

  // IK effector (hand/foot).
  const root = names.indexOf(def.chain.root);
  const mid = names.indexOf(def.chain.mid);
  if (root < 0 || mid < 0) return;
  let world = worldFromLocal(parents, pose);

  if (pv) {
    const cur = world.pos[bone];
    const target = mode === "additive" ? vadd(cur, vscale(pv, weight)) : vlerp(cur, pv, weight);
    // Straight-chain pole fallback: knees bend forward, elbows backward.
    const fallback = quatRotate(world.rot[root], [0, 0, effector.endsWith("Foot") || effector.endsWith("foot") ? 1 : -1]);
    const r = solveTwoBone(
      {
        parentRot: world.rot[parents[root]],
        rootP: world.pos[root], midP: world.pos[mid], endP: cur,
        rootR: world.rot[root], midR: world.rot[mid], endR: world.rot[bone],
      },
      target,
      vnorm(fallback),
    );
    if (r) {
      pose.quat[root] = r.rootLocal;
      pose.quat[mid] = r.midLocal;
      pose.quat[bone] = r.endLocal;
      if (rv) world = worldFromLocal(parents, pose); // rot edit needs fresh parents
    }
  }

  if (rv) {
    const parentRot = world.rot[mid];
    const cur = world.rot[bone];
    const desired = mode === "additive" ? quatMul(quatSlerp(IDENTITY, rv, weight), cur) : quatSlerp(cur, rv, weight);
    pose.quat[bone] = quatNormalize(quatMul(qconj(parentRot), desired));
  }
}

/**
 * Apply the layer stack to a single-frame pose, in place. `transient`
 * substitutes the live gizmo value for one effector in one layer while
 * dragging. Layer order = list order; disabled/zero-weight layers skip.
 */
export function applyLayersToPose(
  pose: FramePose,
  names: string[],
  parents: number[],
  layers: RigLayer[],
  t: number,
  transient?: Transient | null,
): void {
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    if (!layer.enabled || layer.weight <= 0) continue;
    for (const track of layer.tracks) {
      let pv = samplePos(track.posKeys, t);
      let rv = sampleRot(track.rotKeys, t);
      if (transient && transient.layerIndex === li && transient.effector === track.effector) {
        if (transient.pos) pv = transient.pos;
        if (transient.rot) rv = transient.rot;
      }
      if (!pv && !rv) continue;
      applyEffector(pose, names, parents, track.effector, layer.mode, layer.weight, pv, rv);
    }
  }
}

export function hasRigContent(layers: RigLayer[]): boolean {
  return layers.some(
    (l) => l.enabled && l.weight > 0 && l.tracks.some((tr) => tr.posKeys.length + tr.rotKeys.length > 0),
  );
}

/** Bake the layer stack into a new clip (originals untouched). */
export function applyRigLayers(clip: ConvertedClip, layers: RigLayer[]): ConvertedClip {
  if (!hasRigContent(layers)) return clip;
  const frames = clip.times.length;
  const localPos = clip.localPos.map((t) => t.map((p) => [...p] as Vec3));
  const localQuat = clip.localQuat.map((t) => t.map((q) => [...q] as Quat));
  for (let f = 0; f < frames; f++) {
    const pose: FramePose = {
      pos: localPos.map((t) => t[f]),
      quat: localQuat.map((t) => t[f]),
    };
    applyLayersToPose(pose, clip.names, clip.parents, layers, clip.times[f]);
    for (let b = 0; b < clip.names.length; b++) {
      localPos[b][f] = pose.pos[b];
      localQuat[b][f] = pose.quat[b];
    }
  }
  return { ...clip, localPos, localQuat, bindPos: localPos.map((t) => t[0]) };
}

/**
 * Effector world state through the layers BELOW `layerIndex` at frame f —
 * the reference additive deltas are captured against.
 */
export function effectorBaseWorld(
  clip: ConvertedClip,
  layers: RigLayer[],
  layerIndex: number,
  effector: EffectorId,
  f: number,
): { pos: Vec3; rot: Quat } {
  const pose = poseAtFrame(clip, f);
  applyLayersToPose(pose, clip.names, clip.parents, layers.slice(0, layerIndex), clip.times[f]);
  const world = worldFromLocal(clip.parents, pose);
  const bone = clip.names.indexOf(effectorDef(effector).bone);
  return { pos: world.pos[bone], rot: world.rot[bone] };
}
