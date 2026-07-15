import type { ConvertedClip } from "../convert/clip.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";
import { quatMul, quatNormalize, quatSlerp, quatRotate } from "../convert/quat.ts";
import { solveTwoBone, qconj, vadd, vsub, vscale, vlerp, vnorm, vlen } from "../convert/ik.ts";
import { worldFromLocal, type FramePose } from "../convert/fk.ts";

// MotionBuilder-style animation layers, done the way MoBu actually does it:
// layers hold PER-BONE LOCAL channel curves, and the control rig (IK
// effectors, FK cells) is just an INPUT DEVICE. Dragging a hand solves IK
// once, at capture time, and writes the resulting chain's local rotations as
// keys on the layer. Evaluation is pure curve composition in bone-local
// space — no FK, no IK, no dependence on what the base motion is doing:
//
//   additive: local = base_local ⊗ slerp(I, delta, weight·env)   (post-mult)
//   override: local = slerp(base_local, keyed_local, weight·env)
//
// This is what makes corrections stable: an override key PINS the local pose
// (pop fixes hold regardless of the underlying motion), an additive key is a
// relative adjustment like "elbow +20°" that travels correctly when keys are
// retimed, copied, or pasted. Keys interpolate on the layer's own curve
// (slerp + per-key ease), exactly like a DCC.
//
// Each rig effector maps 1:1 to the bone it edits (def.bone). An IK hand drag
// writes keys on the three chain bones — i.e. on the upper-arm, forearm, and
// hand effectors' tracks, which is exactly how MoBu control-rig keys land.

// Known effector ids are listed for autocomplete; finger effectors are
// generated per-hand (see FINGER_EFFECTORS) so the type stays open with the
// `(string & {})` widening — any bone-derived id is a valid effector.
export type EffectorId =
  | "root"
  | "hips" | "leftHand" | "rightHand" | "leftFoot" | "rightFoot" | "head"
  | "spine" | "chest" | "neck"
  | "leftShoulder" | "rightShoulder"
  | "leftUpperArm" | "rightUpperArm" | "leftLowerArm" | "rightLowerArm"
  | "leftUpperLeg" | "rightUpperLeg" | "leftLowerLeg" | "rightLowerLeg"
  | "leftToes" | "rightToes"
  | (string & {});

export interface EffectorDef {
  id: EffectorId;
  label: string;
  /** Bone whose local channels this effector's keys land on. */
  bone: string;
  /** Two-bone chain (root/mid) when the effector is IK-driven. */
  chain?: { root: string; mid: string };
  /**
   * FK bones: where the bone "points" (first existing child in the list) —
   * translate-dragging the handle swings this tip toward the drag, Poser
   * style, so pulling the chest forward LEANS it forward.
   */
  tip?: string[];
  canMove: boolean;
  canRotate: boolean;
}

export const EFFECTORS: EffectorDef[] = [
  { id: "hips", label: "Hips", bone: "Hips", canMove: true, canRotate: true },
  // Root ALIASES the Hips track (its keys land there) but transforms the
  // WHOLE character rigidly about the ground point under the hips — the
  // Poser-style trajectory handle. Listed after "hips" so effectorForBone
  // still resolves Hips keys to the hips effector for display.
  { id: "root", label: "Root", bone: "Hips", canMove: true, canRotate: true },
  { id: "leftHand", label: "Left hand", bone: "LeftHand", chain: { root: "LeftUpperArm", mid: "LeftLowerArm" }, canMove: true, canRotate: true },
  { id: "rightHand", label: "Right hand", bone: "RightHand", chain: { root: "RightUpperArm", mid: "RightLowerArm" }, canMove: true, canRotate: true },
  { id: "leftFoot", label: "Left foot", bone: "LeftFoot", chain: { root: "LeftUpperLeg", mid: "LeftLowerLeg" }, canMove: true, canRotate: true },
  { id: "rightFoot", label: "Right foot", bone: "RightFoot", chain: { root: "RightUpperLeg", mid: "RightLowerLeg" }, canMove: true, canRotate: true },
  { id: "head", label: "Head", bone: "Head", canMove: false, canRotate: true },
  { id: "spine", label: "Spine", bone: "Spine", tip: ["Chest", "UpperChest", "Neck"], canMove: false, canRotate: true },
  { id: "chest", label: "Chest", bone: "Chest", tip: ["UpperChest", "Neck"], canMove: false, canRotate: true },
  { id: "neck", label: "Neck", bone: "Neck", tip: ["Head"], canMove: false, canRotate: true },
  { id: "leftShoulder", label: "Left shoulder", bone: "LeftShoulder", tip: ["LeftUpperArm"], canMove: false, canRotate: true },
  { id: "rightShoulder", label: "Right shoulder", bone: "RightShoulder", tip: ["RightUpperArm"], canMove: false, canRotate: true },
  { id: "leftUpperArm", label: "Left upper arm", bone: "LeftUpperArm", tip: ["LeftLowerArm"], canMove: false, canRotate: true },
  { id: "rightUpperArm", label: "Right upper arm", bone: "RightUpperArm", tip: ["RightLowerArm"], canMove: false, canRotate: true },
  { id: "leftLowerArm", label: "Left forearm", bone: "LeftLowerArm", tip: ["LeftHand"], canMove: false, canRotate: true },
  { id: "rightLowerArm", label: "Right forearm", bone: "RightLowerArm", tip: ["RightHand"], canMove: false, canRotate: true },
  { id: "leftUpperLeg", label: "Left thigh", bone: "LeftUpperLeg", tip: ["LeftLowerLeg"], canMove: false, canRotate: true },
  { id: "rightUpperLeg", label: "Right thigh", bone: "RightUpperLeg", tip: ["RightLowerLeg"], canMove: false, canRotate: true },
  { id: "leftLowerLeg", label: "Left shin", bone: "LeftLowerLeg", tip: ["LeftFoot"], canMove: false, canRotate: true },
  { id: "rightLowerLeg", label: "Right shin", bone: "RightLowerLeg", tip: ["RightFoot"], canMove: false, canRotate: true },
  // Toes: FK rotate-only leaves (no tip child in the 55-bone array).
  { id: "leftToes", label: "Left toes", bone: "LeftToes", canMove: false, canRotate: true },
  { id: "rightToes", label: "Right toes", bone: "RightToes", canMove: false, canRotate: true },
];

export const effectorDef = (id: EffectorId): EffectorDef => EFFECTORS.find((e) => e.id === id)!;

/** The effector whose keys land on this bone (first match — root aliases
 *  Hips and is listed after, so Hips keys always display as hips keys). */
export const effectorForBone = (bone: string): EffectorDef | undefined =>
  EFFECTORS.find((e) => e.bone === bone);

/** Handle/marker color: orange hips, green center column, blue left, pink right. */
export function effectorColor(id: EffectorId): string {
  if (id === "root") return "#f5b301";
  if (id === "hips") return "#ffaa33";
  if (id === "head" || id === "neck" || id === "spine" || id === "chest") return "#ccee66";
  return id.startsWith("left") ? "#5599ff" : "#ff5588";
}

// ---- keys -------------------------------------------------------------------

/** Interpolation of the segment LEAVING this key (like DCC curve editors). */
export type KeyEase = "linear" | "smooth" | "step";

export interface PosKey { time: number; v: Vec3; ease?: KeyEase; }
export interface RotKey { time: number; q: Quat; ease?: KeyEase; }

const applyEase = (frac: number, ease?: KeyEase): number =>
  ease === "step" ? 0 : ease === "smooth" ? frac * frac * (3 - 2 * frac) : frac;

export interface RigTrack {
  /** Bone whose LOCAL channels these keys drive. */
  bone: string;
  /** Hips only: local (== world) position keys. */
  posKeys: PosKey[];
  /** Local rotation keys: additive = bone-local delta; override = local value. */
  rotKeys: RotKey[];
}

export interface RigLayer {
  name: string;
  mode: "override" | "additive";
  /**
   * "hold" = MoBu style, first/last key extends across the whole clip.
   * "fade" = correction style: each key is a LOCAL bump easing over fadeS.
   */
  extent: "hold" | "fade";
  fadeS: number;
  weight: number; // 0..1
  enabled: boolean;
  tracks: RigTrack[];
}

export function makeLayer(name: string): RigLayer {
  // New layers default to fade — one key makes a LOCAL correction.
  return { name, mode: "additive", extent: "fade", fadeS: 0.5, weight: 1, enabled: true, tracks: [] };
}

export function getBoneTrack(layer: RigLayer, bone: string, create = false): RigTrack | null {
  let t = layer.tracks.find((tr) => tr.bone === bone) ?? null;
  if (!t && create) {
    t = { bone, posKeys: [], rotKeys: [] };
    layer.tracks.push(t);
  }
  return t;
}

/** Track for an effector = the track of its own bone. */
export function getTrack(layer: RigLayer, effector: EffectorId, create = false): RigTrack | null {
  return getBoneTrack(layer, effectorDef(effector).bone, create);
}

const KEY_EPS = 1 / 120; // keys closer than half a frame replace each other

export function setPosKey(track: RigTrack, time: number, v: Vec3): void {
  const i = track.posKeys.findIndex((k) => Math.abs(k.time - time) < KEY_EPS);
  if (i >= 0) track.posKeys[i] = { time, v, ease: track.posKeys[i].ease };
  else {
    track.posKeys.push({ time, v });
    track.posKeys.sort((a, b) => a.time - b.time);
  }
}

export function setRotKey(track: RigTrack, time: number, q: Quat): void {
  const i = track.rotKeys.findIndex((k) => Math.abs(k.time - time) < KEY_EPS);
  if (i >= 0) track.rotKeys[i] = { time, q, ease: track.rotKeys[i].ease };
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

/** All key times of a track, merged and deduped. */
export function keyTimes(track: RigTrack): number[] {
  const all = [...track.posKeys.map((k) => k.time), ...track.rotKeys.map((k) => k.time)].sort((a, b) => a - b);
  return all.filter((t, i) => i === 0 || t - all[i - 1] > KEY_EPS);
}

/** Move the pos+rot keys at `from` to `to`. Local values travel correctly as-is. */
export function retimeKeys(track: RigTrack, from: number, to: number): void {
  track.posKeys = track.posKeys.filter((k) => Math.abs(k.time - to) > KEY_EPS || Math.abs(k.time - from) < KEY_EPS);
  track.rotKeys = track.rotKeys.filter((k) => Math.abs(k.time - to) > KEY_EPS || Math.abs(k.time - from) < KEY_EPS);
  for (const k of track.posKeys) if (Math.abs(k.time - from) < KEY_EPS) k.time = to;
  for (const k of track.rotKeys) if (Math.abs(k.time - from) < KEY_EPS) k.time = to;
  track.posKeys.sort((a, b) => a.time - b.time);
  track.rotKeys.sort((a, b) => a.time - b.time);
}

/**
 * Remove keys whose absence the sampled curve wouldn't notice. Greedy sweep
 * until stable; first and last keys always survive.
 */
export function reduceKeys(track: RigTrack, posTol = 0.005, rotTol = 1 * Math.PI / 180): number {
  let removed = 0;
  const sweep = <K extends { time: number }>(
    keys: K[],
    err: (removedKey: K, rest: K[]) => number,
    tol: number,
  ): K[] => {
    let out = keys;
    for (let changed = true; changed && out.length > 2; ) {
      changed = false;
      for (let i = 1; i < out.length - 1; i++) {
        const rest = out.filter((_, j) => j !== i);
        if (err(out[i], rest) < tol) {
          out = rest;
          removed++;
          changed = true;
          break;
        }
      }
    }
    return out;
  };
  track.posKeys = sweep(
    track.posKeys,
    (k, rest) => {
      const v = samplePos(rest, k.time)!;
      return Math.hypot(v[0] - k.v[0], v[1] - k.v[1], v[2] - k.v[2]);
    },
    posTol,
  );
  track.rotKeys = sweep(
    track.rotKeys,
    (k, rest) => {
      const q = sampleRot(rest, k.time)!;
      const d = Math.abs(q[0] * k.q[0] + q[1] * k.q[1] + q[2] * k.q[2] + q[3] * k.q[3]);
      return 2 * Math.acos(Math.min(1, d));
    },
    rotTol,
  );
  return removed;
}

/** Set the ease of the pos+rot keys at `time`. */
export function setKeyEase(track: RigTrack, time: number, ease: KeyEase): void {
  for (const k of track.posKeys) if (Math.abs(k.time - time) < KEY_EPS) k.ease = ease;
  for (const k of track.rotKeys) if (Math.abs(k.time - time) < KEY_EPS) k.ease = ease;
}

// ---- sampling ----------------------------------------------------------------

function samplePos(keys: PosKey[], t: number): Vec3 | null {
  if (!keys.length) return null;
  if (t <= keys[0].time) return keys[0].v;
  if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].v;
  let i = 0;
  while (keys[i + 1].time < t) i++;
  const a = keys[i], b = keys[i + 1];
  const frac = applyEase((t - a.time) / Math.max(1e-9, b.time - a.time), a.ease);
  return vlerp(a.v, b.v, frac);
}

function sampleRot(keys: RotKey[], t: number): Quat | null {
  if (!keys.length) return null;
  if (t <= keys[0].time) return keys[0].q;
  if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].q;
  let i = 0;
  while (keys[i + 1].time < t) i++;
  const a = keys[i], b = keys[i + 1];
  const frac = applyEase((t - a.time) / Math.max(1e-9, b.time - a.time), a.ease);
  return quatSlerp(a.q, b.q, frac);
}

/** Public sampling for the curve editor's interpolation preview. */
export const sampleTrackPos = samplePos;
export const sampleTrackRot = sampleRot;

/**
 * Influence envelope. Hold: 1 everywhere. Fade: FULL strength across the
 * whole keyed range — keyed sections HOLD their pose, values interpolate on
 * the layer's own curve between keys — easing to zero only OUTSIDE the
 * first/last key. (An earlier version dipped to zero in large gaps between
 * keys; that collapsed override sections back to the base mid-span. With
 * bone-local curves, in-range interpolation is well-behaved — don't dip.)
 */
function envelope(keys: Array<{ time: number }>, t: number, extent: "hold" | "fade", fadeS: number): number {
  if (!keys.length) return 0;
  if (extent === "hold") return 1;
  const first = keys[0].time;
  const last = keys[keys.length - 1].time;
  if (t >= first && t <= last) return 1;
  const fade = Math.max(1e-6, fadeS);
  const d = t < first ? first - t : t - last;
  if (d >= fade) return 0;
  const x = 1 - d / fade;
  return x * x * (3 - 2 * x);
}

const IDENTITY: Quat = [0, 0, 0, 1];

// ---- evaluation (pure curve composition — no FK, no IK) -----------------------

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

/**
 * Apply the layer stack to a single-frame pose, in place. Per bone, per
 * layer: sample the layer's local curve, compose by mode, scaled by
 * weight × envelope. Nothing here needs world space.
 */
export function applyLayersToPose(
  pose: FramePose,
  names: string[],
  parents: number[],
  layers: RigLayer[],
  t: number,
): void {
  void parents;
  for (const layer of layers) {
    if (!layer.enabled || layer.weight <= 0) continue;
    for (const track of layer.tracks) {
      const b = names.indexOf(track.bone);
      if (b < 0) continue;
      const envR = envelope(track.rotKeys, t, layer.extent, layer.fadeS);
      const wR = layer.weight * envR;
      if (wR > 0) {
        const rv = sampleRot(track.rotKeys, t);
        if (rv && !(layer.mode === "additive" && 1 - Math.abs(rv[3]) < 1e-10)) {
          pose.quat[b] = quatNormalize(
            layer.mode === "additive"
              ? quatMul(pose.quat[b], quatSlerp(IDENTITY, rv, wR))
              : quatSlerp(pose.quat[b], rv, wR),
          );
        }
      }
      if (track.posKeys.length && track.bone === "Hips") {
        const envP = envelope(track.posKeys, t, layer.extent, layer.fadeS);
        const wP = layer.weight * envP;
        if (wP > 0) {
          const pv = samplePos(track.posKeys, t);
          if (pv && !(layer.mode === "additive" && Math.abs(pv[0]) + Math.abs(pv[1]) + Math.abs(pv[2]) < 1e-7)) {
            pose.pos[b] = layer.mode === "additive" ? vadd(pose.pos[b], vscale(pv, wP)) : vlerp(pose.pos[b], pv, wP);
          }
        }
      }
    }
  }
}

export function hasRigContent(layers: RigLayer[]): boolean {
  return layers.some(
    (l) => l.enabled && l.weight > 0 && l.tracks.some((tr) => tr.posKeys.length + tr.rotKeys.length > 0),
  );
}

// ---- baking --------------------------------------------------------------------

/** A time window a rig edit dirtied; bake only frames inside it. */
export interface TimeRange { t0: number; t1: number; }

function makeBakeStep(
  base: ConvertedClip,
  layers: RigLayer[],
  outPos: Vec3[][],
  outQuat: Quat[][],
  range?: TimeRange,
): (f: number) => void {
  const bones = base.names.length;
  const active = layers.filter((l) => l.enabled && l.weight > 0);
  // Influence windows: outside ALL of them a frame is pure base.
  const windows: TimeRange[] = [];
  for (const layer of active) {
    for (const track of layer.tracks) {
      const times = keyTimes(track);
      if (!times.length) continue;
      if (layer.extent === "hold") windows.push({ t0: -Infinity, t1: Infinity });
      else windows.push({ t0: times[0] - layer.fadeS, t1: times[times.length - 1] + layer.fadeS });
    }
  }
  const t0 = range ? range.t0 : -Infinity;
  const t1 = range ? range.t1 : Infinity;

  return (f: number) => {
    // Keys live in PLAYBACK time (0-based); recordings' timestamps may not
    // start at zero, so normalize — otherwise every key is off by times[0].
    const t = base.times[f] - base.times[0];
    if (t < t0 || t > t1) return; // outside the edit — keep the previous bake
    if (!windows.some((w) => t >= w.t0 && t <= w.t1)) {
      for (let b = 0; b < bones; b++) {
        outPos[b][f] = base.localPos[b][f];
        outQuat[b][f] = base.localQuat[b][f];
      }
      return;
    }
    const pose = poseAtFrame(base, f);
    applyLayersToPose(pose, base.names, base.parents, layers, t);
    for (let b = 0; b < bones; b++) {
      outPos[b][f] = pose.pos[b];
      outQuat[b][f] = pose.quat[b];
    }
  };
}

export function bakeRange(
  base: ConvertedClip,
  layers: RigLayer[],
  outPos: Vec3[][],
  outQuat: Quat[][],
  range?: TimeRange,
): void {
  const step = makeBakeStep(base, layers, outPos, outQuat, range);
  for (let f = 0; f < base.times.length; f++) step(f);
}

/**
 * Chunked bake: same result as bakeRange but yields to the event loop every
 * ~budgetMs, so big rebakes never freeze the UI. Returns false if cancelled.
 */
export async function bakeRangeAsync(
  base: ConvertedClip,
  layers: RigLayer[],
  outPos: Vec3[][],
  outQuat: Quat[][],
  range?: TimeRange,
  isStale?: () => boolean,
  budgetMs = 12,
): Promise<boolean> {
  const step = makeBakeStep(base, layers, outPos, outQuat, range);
  const frames = base.times.length;
  let f = 0;
  while (f < frames) {
    const sliceEnd = performance.now() + budgetMs;
    while (f < frames && performance.now() < sliceEnd) step(f++);
    if (f < frames) {
      await new Promise((r) => setTimeout(r, 0));
      if (isStale?.()) return false;
    }
  }
  return true;
}

/**
 * The time window whose baked result changes when a key at `time` on `track`
 * is added, replaced, moved, or removed.
 */
export function dirtyRange(layer: RigLayer, track: RigTrack, time: number): TimeRange {
  let prev = -Infinity;
  let next = Infinity;
  for (const k of keyTimes(track)) {
    if (k < time - 1e-6) prev = k;
    else if (k > time + 1e-6) { next = k; break; }
  }
  if (layer.extent === "hold") return { t0: prev, t1: next };
  return {
    t0: (prev === -Infinity ? time : prev) - layer.fadeS,
    t1: (next === Infinity ? time : next) + layer.fadeS,
  };
}

export const unionRange = (a: TimeRange, b: TimeRange): TimeRange => ({
  t0: Math.min(a.t0, b.t0),
  t1: Math.max(a.t1, b.t1),
});

/** Bake the layer stack into a new clip (originals untouched). */
export function applyRigLayers(clip: ConvertedClip, layers: RigLayer[]): ConvertedClip {
  if (!hasRigContent(layers)) return clip;
  const localPos = clip.localPos.map((t) => t.map((p) => [...p] as Vec3));
  const localQuat = clip.localQuat.map((t) => t.map((q) => [...q] as Quat));
  bakeRange(clip, layers, localPos, localQuat);
  return { ...clip, localPos, localQuat, bindPos: localPos.map((t) => t[0]) };
}

// ---- capture: the rig as an input device --------------------------------------

/** Deep-copy a frame pose (solving mutates in place). */
export function clonePose(pose: FramePose): FramePose {
  return { pos: pose.pos.map((p) => [...p] as Vec3), quat: pose.quat.map((q) => [...q] as Quat) };
}

/** A frame's PLAYBACK time (keys and envelopes live in this time base). */
export const frameTime = (clip: ConvertedClip, f: number): number => clip.times[f] - clip.times[0];

/** Pose through the FULL enabled stack at frame f. */
export function fullStackPose(clip: ConvertedClip, layers: RigLayer[], f: number): FramePose {
  const pose = poseAtFrame(clip, f);
  applyLayersToPose(pose, clip.names, clip.parents, layers, frameTime(clip, f));
  return pose;
}

/**
 * Pose through the stack UP TO AND INCLUDING `layerIndex` at frame f — the
 * reference a drag on that layer solves against. Solving on the FULL stack
 * would absorb the layers ABOVE into the captured keys, and they'd then
 * apply twice at bake.
 */
export function stackPoseThrough(clip: ConvertedClip, layers: RigLayer[], layerIndex: number, f: number): FramePose {
  const pose = poseAtFrame(clip, f);
  applyLayersToPose(pose, clip.names, clip.parents, layers.slice(0, layerIndex + 1), frameTime(clip, f));
  return pose;
}

/** Pose through the layers BELOW `layerIndex` at frame f. */
export function belowStackPose(clip: ConvertedClip, layers: RigLayer[], layerIndex: number, f: number): FramePose {
  const pose = poseAtFrame(clip, f);
  applyLayersToPose(pose, clip.names, clip.parents, layers.slice(0, layerIndex), frameTime(clip, f));
  return pose;
}

/** Effector world state through the layers below `layerIndex` at frame f. */
export function effectorBaseWorld(
  clip: ConvertedClip,
  layers: RigLayer[],
  layerIndex: number,
  effector: EffectorId,
  f: number,
): { pos: Vec3; rot: Quat } {
  const pose = belowStackPose(clip, layers, layerIndex, f);
  const world = worldFromLocal(clip.parents, pose);
  const bone = clip.names.indexOf(effectorDef(effector).bone);
  return { pos: world.pos[bone], rot: world.rot[bone] };
}

export interface EffectorTarget {
  /** Absolute world position for the effector's bone (IK / hips / FK-swing tip pull). */
  pos?: Vec3;
  /** Absolute world rotation for the effector's bone. */
  rot?: Quat;
}

/** A limb held in place while something else is dragged (Poser-style pin). */
export interface PinTarget {
  effector: EffectorId;
  /** World position the chain end must stay at. */
  pos: Vec3;
  /** World rotation the chain end keeps (a planted foot doesn't twist). */
  rot: Quat;
}

/**
 * World targets for the given pinned effectors, read from `pose` — capture
 * these BEFORE a drag starts so pins hold their original spot all drag long.
 */
export function capturePinTargets(
  pose: FramePose,
  names: string[],
  parents: number[],
  pinIds: EffectorId[],
): PinTarget[] {
  if (!pinIds.length) return [];
  const world = worldFromLocal(parents, pose);
  const out: PinTarget[] = [];
  for (const id of pinIds) {
    const def = effectorDef(id);
    if (!def.chain) continue; // only two-bone limbs can be pinned
    const b = names.indexOf(def.bone);
    if (b < 0) continue;
    out.push({ effector: id, pos: [...world.pos[b]] as Vec3, rot: [...world.rot[b]] as Quat });
  }
  return out;
}

/**
 * Solve the effector onto absolute world targets, IN PLACE on `pose`.
 * This runs at CAPTURE time (drags) — never during evaluation/baking.
 * `pins` are limbs re-solved back onto their captured world targets AFTER
 * the primary edit (planted feet stay planted while the hips drop).
 * Returns the bones whose locals were written.
 */
export function solveEffectorOnPose(
  pose: FramePose,
  names: string[],
  parents: number[],
  effector: EffectorId,
  target: EffectorTarget,
  pins: PinTarget[] = [],
): string[] {
  const def = effectorDef(effector);
  const bone = names.indexOf(def.bone);
  if (bone < 0 || (!target.pos && !target.rot)) return [];
  const written: string[] = [];

  if (effector === "root") {
    // Rigid whole-character transform about the ground point under the hips.
    // Only the Hips track is written; the body follows by FK inheritance and
    // pinned limbs are put back by the pins pass below.
    const p0 = pose.pos[bone];
    const r0 = pose.quat[bone];
    const pivot0: Vec3 = [p0[0], 0, p0[2]];
    const newRot = target.rot ? quatNormalize([...target.rot] as Quat) : r0;
    const deltaR = target.rot ? quatMul(newRot, qconj(r0)) : IDENTITY;
    const newPivot = target.pos ? ([...target.pos] as Vec3) : pivot0;
    pose.pos[bone] = vadd(newPivot, quatRotate(deltaR, vsub(p0, pivot0)));
    pose.quat[bone] = newRot;
    written.push(def.bone);
  } else if (effector === "hips") {
    if (target.pos) pose.pos[bone] = [...target.pos] as Vec3;
    if (target.rot) pose.quat[bone] = quatNormalize([...target.rot] as Quat);
    written.push(def.bone);
  } else if (!def.chain) {
    // FK bone: world-rotation target → local.
    if (!target.rot) return [];
    const world = worldFromLocal(parents, pose);
    pose.quat[bone] = quatNormalize(quatMul(qconj(world.rot[parents[bone]]), target.rot));
    written.push(def.bone);
  } else {
    // IK effector.
    const root = names.indexOf(def.chain.root);
    const mid = names.indexOf(def.chain.mid);
    if (root < 0 || mid < 0) return [];
    let world = worldFromLocal(parents, pose);

    if (target.pos) {
      const fallback = quatRotate(world.rot[root], [0, 0, effector.endsWith("Foot") ? 1 : -1]);
      const r = solveTwoBone(
        {
          parentRot: world.rot[parents[root]],
          rootP: world.pos[root], midP: world.pos[mid], endP: world.pos[bone],
          rootR: world.rot[root], midR: world.rot[mid], endR: world.rot[bone],
        },
        target.pos,
        vnorm(fallback),
      );
      if (r) {
        pose.quat[root] = r.rootLocal;
        pose.quat[mid] = r.midLocal;
        pose.quat[bone] = r.endLocal;
        written.push(def.chain.root, def.chain.mid, def.bone);
        if (target.rot) world = worldFromLocal(parents, pose);
      }
    }
    if (target.rot) {
      pose.quat[bone] = quatNormalize(quatMul(qconj(world.rot[mid]), target.rot));
      if (!written.includes(def.bone)) written.push(def.bone);
    }
  }

  // Pins pass: re-solve each pinned limb back onto its captured world target.
  // Chains are disjoint, so one world snapshot after the primary edit serves
  // them all; the end bone keeps the PINNED world rotation (solveTwoBone
  // preserves endR), so a planted foot doesn't twist while the body moves.
  const activePins = pins.filter((p) => p.effector !== effector);
  if (activePins.length && written.length) {
    const world = worldFromLocal(parents, pose);
    for (const pin of activePins) {
      const pdef = effectorDef(pin.effector);
      if (!pdef.chain) continue;
      const pRoot = names.indexOf(pdef.chain.root);
      const pMid = names.indexOf(pdef.chain.mid);
      const pEnd = names.indexOf(pdef.bone);
      if (pRoot < 0 || pMid < 0 || pEnd < 0) continue;
      const fallback = quatRotate(world.rot[pRoot], [0, 0, pin.effector.endsWith("Foot") ? 1 : -1]);
      const r = solveTwoBone(
        {
          parentRot: world.rot[parents[pRoot]],
          rootP: world.pos[pRoot], midP: world.pos[pMid], endP: world.pos[pEnd],
          rootR: world.rot[pRoot], midR: world.rot[pMid], endR: pin.rot,
        },
        pin.pos,
        vnorm(fallback),
      );
      if (r) {
        pose.quat[pRoot] = r.rootLocal;
        pose.quat[pMid] = r.midLocal;
        pose.quat[pEnd] = r.endLocal;
        for (const b of [pdef.chain.root, pdef.chain.mid, pdef.bone]) {
          if (!written.includes(b)) written.push(b);
        }
      }
    }
  }
  return written;
}

/** Share of a hand's local twist that anatomically belongs to the forearm. */
export const WRIST_TWIST_SHARE = 0.6;

/**
 * Move a share of the hand's local TWIST (pronation/supination, about its
 * finger axis) onto the forearm, preserving the hand's world rotation — in a
 * real arm the forearm carries most of that rotation, so a wrist rotate-drag
 * should visibly turn the forearm too. Returns the forearm bone name when
 * anything was moved, for the capture's written-bones list.
 */
export function distributeWristTwist(
  clip: ConvertedClip,
  pose: FramePose,
  effector: EffectorId,
  share = WRIST_TWIST_SHARE,
): string | null {
  if (effector !== "leftHand" && effector !== "rightHand") return null;
  const side = effector === "leftHand" ? "Left" : "Right";
  const hand = clip.names.indexOf(`${side}Hand`);
  const fore = clip.names.indexOf(`${side}LowerArm`);
  if (hand < 0 || fore < 0) return null;
  // Bone axis = direction to the middle finger in the hand's local frame.
  const child = clip.names.indexOf(`${side}MiddleProximal`);
  const off = child >= 0 ? clip.bindPos[child] : ([side === "Left" ? 1 : -1, 0, 0] as Vec3);
  const len = Math.hypot(off[0], off[1], off[2]) || 1;
  const ax = off[0] / len, ay = off[1] / len, az = off[2] / len;

  const q = pose.quat[hand];
  const proj = q[0] * ax + q[1] * ay + q[2] * az;
  if (Math.hypot(proj, q[3]) < 1e-9) return null;
  const twist = quatNormalize([ax * proj, ay * proj, az * proj, q[3]] as Quat);
  const twistAngle = 2 * Math.acos(Math.min(1, Math.abs(twist[3])));
  if (twistAngle < 1e-4) return null;
  const swing = quatMul(q, qconj(twist));
  const moved = quatSlerp(IDENTITY, twist, share);
  // hand' = swing ⊗ twist^(1-share); forearm ⊗= swing ⊗ twist^share ⊗ swingᵀ
  // keeps the hand's world rotation bit-exact while the forearm turns.
  pose.quat[hand] = quatNormalize(quatMul(swing, quatSlerp(IDENTITY, twist, 1 - share)));
  const carry = quatMul(quatMul(swing, moved), qconj(swing));
  pose.quat[fore] = quatNormalize(quatMul(pose.quat[fore], carry));
  return `${side}LowerArm`;
}

/**
 * Write layer keys reproducing `solvedPose` for the given bones at time t:
 * additive stores conj(below_local) ⊗ solved_local (bone-local delta),
 * override stores the solved local value. Returns the dirtied window.
 */
export function captureBoneKeys(
  clip: ConvertedClip,
  layers: RigLayer[],
  layerIndex: number,
  bones: string[],
  solvedPose: FramePose,
  f: number,
  t: number,
  withHipsPos = false,
): TimeRange | null {
  const layer = layers[layerIndex];
  if (!layer) return null;
  const below = belowStackPose(clip, layers, layerIndex, f);
  let dirty: TimeRange | null = null;
  for (const boneName of bones) {
    const b = clip.names.indexOf(boneName);
    if (b < 0) continue;
    const track = getBoneTrack(layer, boneName, true)!;
    const before = dirtyRange(layer, track, t);
    const rot =
      layer.mode === "additive"
        ? quatNormalize(quatMul(qconj(below.quat[b]), solvedPose.quat[b]))
        : quatNormalize(solvedPose.quat[b]);
    setRotKey(track, t, rot);
    if (withHipsPos && boneName === "Hips") {
      const pos = layer.mode === "additive" ? vsub(solvedPose.pos[b], below.pos[b]) : ([...solvedPose.pos[b]] as Vec3);
      setPosKey(track, t, pos);
    }
    const after = dirtyRange(layer, track, t);
    const range = unionRange(before, after);
    dirty = dirty ? unionRange(dirty, range) : range;
  }
  return dirty;
}

/**
 * One-call capture: solve the effector to absolute targets at frame f on the
 * full stack, then key the affected bones. Used by tests and any programmatic
 * edits; the viewport drag does the same thing in two steps (live preview).
 * `pinIds` = limbs held at their pre-edit world spot (captured from the
 * pre-solve pose, exactly like a drag captures them at pointer-down).
 */
export function keyEffectorTarget(
  clip: ConvertedClip,
  layers: RigLayer[],
  layerIndex: number,
  effector: EffectorId,
  f: number,
  target: EffectorTarget,
  pinIds: EffectorId[] = [],
): TimeRange | null {
  const pose = stackPoseThrough(clip, layers, layerIndex, f);
  const pins = capturePinTargets(pose, clip.names, clip.parents, pinIds);
  const bones = solveEffectorOnPose(pose, clip.names, clip.parents, effector, target, pins);
  if (!bones.length) return null;
  if (target.rot && (effector === "leftHand" || effector === "rightHand")) {
    const extra = distributeWristTwist(clip, pose, effector);
    if (extra && !bones.includes(extra)) bones.push(extra);
  }
  // Root rotates about the ground pivot, so it moves the hips POSITION too.
  const withHipsPos = effector === "root" || (effector === "hips" && !!target.pos);
  return captureBoneKeys(clip, layers, layerIndex, bones, pose, f, frameTime(clip, f), withHipsPos);
}

/**
 * Switch a layer's mode, CONVERTING every key so the pose it produces is
 * preserved: additive delta ⇄ override local value, translated against the
 * below-stack at each key's frame. Without this, flipping the dropdown
 * reinterprets deltas as absolute locals (or vice versa) and the pose breaks.
 */
export function convertLayerMode(
  clip: ConvertedClip,
  layers: RigLayer[],
  layerIndex: number,
  newMode: "override" | "additive",
): void {
  const layer = layers[layerIndex];
  if (!layer || layer.mode === newMode) return;
  for (const track of layer.tracks) {
    const b = clip.names.indexOf(track.bone);
    if (b < 0) continue;
    for (const k of track.rotKeys) {
      const below = belowStackPose(clip, layers, layerIndex, nearestFrame(clip, k.time));
      k.q =
        newMode === "override"
          ? quatNormalize(quatMul(below.quat[b], k.q)) // value = base ⊗ delta
          : quatNormalize(quatMul(qconj(below.quat[b]), k.q)); // delta = base⁻¹ ⊗ value
    }
    if (track.bone === "Hips") {
      for (const k of track.posKeys) {
        const below = belowStackPose(clip, layers, layerIndex, nearestFrame(clip, k.time));
        k.v = newMode === "override" ? vadd(below.pos[b], k.v) : vsub(k.v, below.pos[b]);
      }
    }
  }
  layer.mode = newMode;
}

/**
 * Key the full current pose (every effector bone) at time t — locks the pose
 * so edits elsewhere can't disturb this moment. Captures the stack THROUGH
 * the edited layer (layers above must not get absorbed and applied twice).
 */
export function keyFullPose(clip: ConvertedClip, layers: RigLayer[], layerIndex: number, t: number, f: number): void {
  const pose = stackPoseThrough(clip, layers, layerIndex, f);
  // Dedupe: root aliases the Hips bone.
  const bones = [...new Set(EFFECTORS.map((e) => e.bone))].filter((b) => clip.names.indexOf(b) >= 0);
  captureBoneKeys(clip, layers, layerIndex, bones, pose, f, t, true);
}

// ---- FK drag reference ----------------------------------------------------------

/**
 * Joint position + tip direction of an FK bone through the FULL layer stack
 * at frame f — the reference a Poser-style translate-drag swings around.
 */
export function fkDragRef(
  clip: ConvertedClip,
  layers: RigLayer[],
  layerIndex: number,
  effector: EffectorId,
  f: number,
): { joint: Vec3; tip: Vec3 } | null {
  const def = effectorDef(effector);
  const bone = clip.names.indexOf(def.bone);
  if (bone < 0) return null;
  const pose = stackPoseThrough(clip, layers, layerIndex, f);
  const world = worldFromLocal(clip.parents, pose);
  const joint = world.pos[bone];
  if (def.tip) {
    for (const t of def.tip) {
      const ti = clip.names.indexOf(t);
      if (ti >= 0 && vlen(vsub(world.pos[ti], joint)) > 0.02) return { joint, tip: world.pos[ti] };
    }
  }
  return { joint, tip: vadd(joint, quatRotate(world.rot[bone], [0, 0.18, 0])) };
}
