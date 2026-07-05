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

/** Handle/marker color: orange hips, green center column, blue left, pink right. */
export function effectorColor(id: EffectorId): string {
  if (id === "hips") return "#ffaa33";
  if (id === "head" || id === "neck" || id === "spine" || id === "chest") return "#ccee66";
  return id.startsWith("left") ? "#5599ff" : "#ff5588";
}

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
  /**
   * How keys extend beyond the keyed range. "hold" = MoBu style, the first/
   * last key's value applies to the whole clip (bracket with neutral keys to
   * localize). "fade" = correction style, the adjustment eases in/out over
   * `fadeS` seconds around the keyed range and is zero elsewhere.
   */
  extent: "hold" | "fade";
  /** Fade-in/out duration in seconds (fade extent only). */
  fadeS: number;
  weight: number; // 0..1
  enabled: boolean;
  tracks: RigTrack[];
}

export function makeLayer(name: string): RigLayer {
  // New layers default to fade — one key makes a LOCAL correction.
  return { name, mode: "additive", extent: "fade", fadeS: 0.5, weight: 1, enabled: true, tracks: [] };
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

/** Move the pos+rot keys at `from` to `to` (any keys already at `to` are replaced). */
export function retimeKeys(track: RigTrack, from: number, to: number): void {
  track.posKeys = track.posKeys.filter((k) => Math.abs(k.time - to) > KEY_EPS || Math.abs(k.time - from) < KEY_EPS);
  track.rotKeys = track.rotKeys.filter((k) => Math.abs(k.time - to) > KEY_EPS || Math.abs(k.time - from) < KEY_EPS);
  for (const k of track.posKeys) if (Math.abs(k.time - from) < KEY_EPS) k.time = to;
  for (const k of track.rotKeys) if (Math.abs(k.time - from) < KEY_EPS) k.time = to;
  track.posKeys.sort((a, b) => a.time - b.time);
  track.rotKeys.sort((a, b) => a.time - b.time);
}

/**
 * Influence envelope outside the keyed range: 1 inside, held or smoothly
 * faded to 0 outside, depending on the layer's extent.
 */
function envelope(first: number, last: number, t: number, extent: "hold" | "fade", fadeS: number): number {
  if (t >= first && t <= last) return 1;
  if (extent === "hold") return 1;
  const d = t < first ? first - t : t - last;
  if (d >= fadeS || fadeS <= 0) return 0;
  const x = 1 - d / fadeS;
  return x * x * (3 - 2 * x); // smoothstep
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
  wPos: number,
  wRot: number,
  pv: Vec3 | null,
  rv: Quat | null,
): void {
  const def = effectorDef(effector);
  const bone = names.indexOf(def.bone);
  if (bone < 0) return;
  if (pv && wPos <= 0) pv = null;
  if (rv && wRot <= 0) rv = null;
  if (!pv && !rv) return;

  if (effector === "hips") {
    // Root: world == local, write directly.
    if (pv) pose.pos[bone] = mode === "additive" ? vadd(pose.pos[bone], vscale(pv, wPos)) : vlerp(pose.pos[bone], pv, wPos);
    if (rv) {
      pose.quat[bone] = quatNormalize(
        mode === "additive" ? quatMul(quatSlerp(IDENTITY, rv, wRot), pose.quat[bone]) : quatSlerp(pose.quat[bone], rv, wRot),
      );
    }
    return;
  }

  if (!def.chain) {
    // Rotation-only effector (FK body bone): world-rotation edit in place.
    if (!rv) return;
    const world = worldFromLocal(parents, pose);
    const parentRot = world.rot[parents[bone]];
    const cur = world.rot[bone];
    const desired = mode === "additive" ? quatMul(quatSlerp(IDENTITY, rv, wRot), cur) : quatSlerp(cur, rv, wRot);
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
    const target = mode === "additive" ? vadd(cur, vscale(pv, wPos)) : vlerp(cur, pv, wPos);
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
    const desired = mode === "additive" ? quatMul(quatSlerp(IDENTITY, rv, wRot), cur) : quatSlerp(cur, rv, wRot);
    pose.quat[bone] = quatNormalize(quatMul(qconj(parentRot), desired));
  }
}

/** Per-channel envelope for a track at time t (0 = no influence). */
function trackEnvelopes(track: RigTrack, layer: RigLayer, t: number): { pos: number; rot: number } {
  const env = (keys: { time: number }[]) =>
    keys.length ? envelope(keys[0].time, keys[keys.length - 1].time, t, layer.extent, layer.fadeS) : 0;
  return { pos: env(track.posKeys), rot: env(track.rotKeys) };
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
      const env = trackEnvelopes(track, layer, t);
      if (transient && transient.layerIndex === li && transient.effector === track.effector) {
        // The live gizmo value applies at full envelope at the drag frame.
        if (transient.pos) { pv = transient.pos; env.pos = 1; }
        if (transient.rot) { rv = transient.rot; env.rot = 1; }
      } else if (layer.mode === "additive") {
        // No-op additive values (zero delta / identity rotation — what
        // neutral keys and "Key pose" mostly write) must not cost an FK+IK
        // pass per frame. This is THE fix for laggy edits on keyed-up clips.
        if (pv && Math.abs(pv[0]) + Math.abs(pv[1]) + Math.abs(pv[2]) < 1e-7) pv = null;
        if (rv && 1 - Math.abs(rv[3]) < 1e-10) rv = null;
      }
      if (!pv && !rv) continue;
      applyEffector(pose, names, parents, track.effector, layer.mode, layer.weight * env.pos, layer.weight * env.rot, pv, rv);
    }
  }
}

/**
 * Key the ACTIVE layer's full effective pose at time t: every effector in
 * the skeleton gets its current effective value keyed (existing adjustments
 * at their faded/held strength, everything else neutral). Locks the pose so
 * later keys elsewhere can't disturb this moment.
 */
export function keyFullPose(clip: ConvertedClip, layers: RigLayer[], layerIndex: number, t: number, f: number): void {
  const layer = layers[layerIndex];
  for (const def of EFFECTORS) {
    if (clip.names.indexOf(def.bone) < 0) continue;
    const track = getTrack(layer, def.id, true)!;
    const env = trackEnvelopes(track, layer, t);
    const rawP = samplePos(track.posKeys, t);
    const rawR = sampleRot(track.rotKeys, t);
    if (layer.mode === "additive") {
      if (def.canMove) setPosKey(track, t, rawP ? vscale(rawP, env.pos) : [0, 0, 0]);
      if (def.canRotate) setRotKey(track, t, rawR ? quatSlerp(IDENTITY, rawR, env.rot) : IDENTITY);
    } else {
      const base = effectorBaseWorld(clip, layers, layerIndex, def.id, f);
      if (def.canMove) setPosKey(track, t, rawP ? vlerp(base.pos, rawP, env.pos) : base.pos);
      if (def.canRotate) setRotKey(track, t, rawR ? quatSlerp(base.rot, rawR, env.rot) : base.rot);
    }
  }
}

export function hasRigContent(layers: RigLayer[]): boolean {
  return layers.some(
    (l) => l.enabled && l.weight > 0 && l.tracks.some((tr) => tr.posKeys.length + tr.rotKeys.length > 0),
  );
}

/** A time window a rig edit dirtied; bake only frames inside it. */
export interface TimeRange { t0: number; t1: number; }

/**
 * Bake the layer stack from `base` into `outPos`/`outQuat` IN PLACE, only for
 * frames within `range` (whole clip when omitted). Frames in range that no
 * track influences are reset to the base — so a partial bake over an edit's
 * dirty window leaves every other frame's previous bake intact. This is what
 * keeps edits on heavily-keyed clips responsive: an edit re-bakes its
 * neighborhood, not the whole recording.
 */
export function bakeRange(
  base: ConvertedClip,
  layers: RigLayer[],
  outPos: Vec3[][],
  outQuat: Quat[][],
  range?: TimeRange,
): void {
  const frames = base.times.length;
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

  for (let f = 0; f < frames; f++) {
    const t = base.times[f];
    if (t < t0 || t > t1) continue; // outside the edit — keep the previous bake
    if (!windows.some((w) => t >= w.t0 && t <= w.t1)) {
      // No layer touches this frame — reset to base.
      for (let b = 0; b < bones; b++) {
        outPos[b][f] = base.localPos[b][f];
        outQuat[b][f] = base.localQuat[b][f];
      }
      continue;
    }
    const pose = poseAtFrame(base, f);
    applyLayersToPose(pose, base.names, base.parents, layers, t);
    for (let b = 0; b < bones; b++) {
      outPos[b][f] = pose.pos[b];
      outQuat[b][f] = pose.quat[b];
    }
  }
}

/**
 * The time window whose baked result changes when a key at `time` on `track`
 * is added, replaced, moved, or removed: to the neighbor keys on either side,
 * pushed out by the fade (or to the clip ends on a hold layer, where the
 * first/last key extends outward).
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
