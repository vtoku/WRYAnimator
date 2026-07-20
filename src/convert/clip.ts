import { type WanimClip, type Vec3, type Quat, HUMAN_BODY_BONES } from "../wanim/parse.ts";
import { BONE_PARENTS } from "./skeleton.ts";
import { quatMul, quatRotate, quatNormalize, quatDot, quatSlerp } from "./quat.ts";

/**
 * A character's motion converted into a right-handed, Y-up space (FBX/three
 * convention) from Warudo's left-handed Unity space. Every bone's transform is
 * LOCAL to its parent; the Hips (root bone) has the character root baked in, so
 * Hips carries full world-space travel and orientation.
 */
export interface ConvertedClip {
  /** Per-frame timestamps (seconds), variable rate as recorded. */
  times: number[];
  duration: number;
  names: string[];
  parents: number[];
  /** localPos[bone][frame] — local translation relative to parent (meters). */
  localPos: Vec3[][];
  /** localQuat[bone][frame] — local rotation, sign-continuous across frames. */
  localQuat: Quat[][];
  /** Per-bone bind translation (frame 0 local position). */
  bindPos: Vec3[];
  /** Recorded face blendshapes (ARKit-style names) aligned to `times`, or null. */
  face: FaceTracks | null;
}

export interface FaceTracks {
  /** Blendshape names as recorded (e.g. "eyeBlinkLeft", "jawOpen"). */
  names: string[];
  /** tracks[nameIndex][frame] — blendshape weight 0..1, aligned to `times`. */
  tracks: Float32Array[];
}

/** Pick the richest blendshape set and flatten it into per-name frame tracks. */
function extractFace(
  blendshapes: Record<string, Record<string, number>[]>,
  frames: number,
): FaceTracks | null {
  const sets = Object.values(blendshapes);
  if (sets.length === 0) return null;
  // Prefer the set with the most channels (the ARKit set), else the first.
  let best = sets[0];
  for (const s of sets) if ((s[0] ? Object.keys(s[0]).length : 0) > (best[0] ? Object.keys(best[0]).length : 0)) best = s;
  if (!best[0]) return null;

  const names = Object.keys(best[0]);
  const tracks = names.map(() => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const frame = best[f] ?? {};
    for (let n = 0; n < names.length; n++) tracks[n][f] = frame[names[n]] ?? 0;
  }
  return { names, tracks };
}

// Unity (left-handed, +Z forward) → right-handed Y-up by negating X (NOT Z).
// Both are valid handedness flips, but the X-mirror keeps the character facing
// +Z with its left side at +x — the convention MotionBuilder's HIK
// characterization requires (a −Z-facing T-pose makes its auto-mapping mirror
// the legs/feet). Positions mirror x; quaternions negate the y,z components.
const flipPos = (p: Vec3): Vec3 => [-p[0], p[1], p[2]];
const flipQuat = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];

function ensureContinuity(track: Quat[]): void {
  for (let i = 1; i < track.length; i++) {
    if (quatDot(track[i - 1], track[i]) < 0) {
      track[i] = [-track[i][0], -track[i][1], -track[i][2], -track[i][3]];
    }
  }
}

export function convertCharacter(clip: WanimClip, characterIndex = 0): ConvertedClip {
  const ch = clip.characters[characterIndex];
  if (!ch) throw new Error(`wanim: character ${characterIndex} not present`);

  const frames = clip.times.length;
  const boneCount = HUMAN_BODY_BONES.length;
  const localPos: Vec3[][] = Array.from({ length: boneCount }, () => new Array<Vec3>(frames));
  const localQuat: Quat[][] = Array.from({ length: boneCount }, () => new Array<Quat>(frames));

  const hasRoot = ch.rootPositions.length === frames && ch.rootRotations.length === frames;

  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < boneCount; b++) {
      let pos = ch.bonePositions[f][b];
      let rot = quatNormalize(ch.boneRotations[f][b]);
      if (b === 0 && hasRoot) {
        // Bake character root into the hips: world = root ∘ hipsLocal.
        const rootPos = ch.rootPositions[f];
        const rootRot = quatNormalize(ch.rootRotations[f]);
        pos = [
          rootPos[0] + quatRotate(rootRot, pos)[0],
          rootPos[1] + quatRotate(rootRot, pos)[1],
          rootPos[2] + quatRotate(rootRot, pos)[2],
        ];
        rot = quatNormalize(quatMul(rootRot, rot));
      }
      localPos[b][f] = flipPos(pos);
      localQuat[b][f] = flipQuat(rot);
    }
  }

  for (let b = 0; b < boneCount; b++) ensureContinuity(localQuat[b]);

  return {
    times: clip.times.slice(),
    duration: frames > 1 ? clip.times[frames - 1] - clip.times[0] : 0,
    names: HUMAN_BODY_BONES.slice(),
    parents: BONE_PARENTS.slice(),
    localPos,
    localQuat,
    bindPos: localPos.map((track) => track[0]),
    face: extractFace(ch.blendshapes, frames),
  };
}

export interface ResampledClip {
  fps: number;
  frameCount: number;
  names: string[];
  parents: number[];
  /** localPos[bone][frame] at the fixed rate (meters). */
  localPos: Vec3[][];
  localQuat: Quat[][];
  bindPos: Vec3[];
  /** Face blendshape weights resampled to the fixed rate, or null. */
  face: { names: string[]; tracks: Float32Array[] } | null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Re-proportion the clip onto a different skeleton (e.g. Ybot): replaces the
 * bind offsets with the target's joint layout while keeping the recorded
 * local ROTATIONS (rotations transfer across proportions); the hips world
 * translation is scaled by the hips-height ratio so the root motion matches
 * the new leg length. Bones the target lacks (e.g. Jaw) keep their original
 * offsets scaled uniformly.
 */
export function retargetProportions(
  c: ConvertedClip,
  targetJoints: (Vec3 | null)[],
  opts: { shoulderScale?: number } = {},
): ConvertedClip {
  const ourWorld = bindWorldPositions(c.parents, c.bindPos);
  const ourHipsY = ourWorld[0][1] || 1;
  const tgtHipsY = targetJoints[0]?.[1] || ourHipsY;
  const s = tgtHipsY / ourHipsY;
  const shoulderScale = opts.shoulderScale ?? 1;

  const newBind: Vec3[] = c.bindPos.map((p, i) => {
    const t = targetJoints[i];
    const parent = c.parents[i];
    const tp = parent >= 0 ? targetJoints[parent] : null;
    let bind: Vec3;
    if (t && (parent < 0 || tp)) {
      bind = parent < 0
        ? [t[0], t[1], t[2]]
        : [t[0] - tp![0], t[1] - tp![1], t[2] - tp![2]];
    } else {
      bind = [p[0] * s, p[1] * s, p[2] * s];
    }
    // Optionally narrow the clavicle span (heroic assets attach the arms wide).
    if (shoulderScale !== 1 && /Shoulder|UpperArm/.test(c.names[i])) {
      bind = [bind[0] * shoulderScale, bind[1], bind[2]];
    }
    return bind;
  });

  const frames = c.times.length;
  const localPos: Vec3[][] = c.localPos.map((track, b) => {
    if (b === 0) {
      // Hips world translation: scale the recorded travel by the height ratio.
      return track.map((p): Vec3 => [p[0] * s, p[1] * s, p[2] * s]);
    }
    // Limb bones are rigid: constant new bind offset.
    return new Array(frames).fill(newBind[b]);
  });

  return { ...c, localPos, bindPos: newBind };
}

/**
 * T-pose world joint positions (meters): cumulative bind offsets with identity
 * rotations. Resolved recursively — the bone array is NOT topologically sorted
 * (UpperChest is index 54 but parents earlier-indexed bones).
 */
export function bindWorldPositions(parents: number[], bindPos: Vec3[]): Vec3[] {
  const world: (Vec3 | undefined)[] = new Array(parents.length);
  const resolve = (i: number): Vec3 => {
    const cached = world[i];
    if (cached) return cached;
    const p = parents[i];
    const base: Vec3 = p >= 0 ? resolve(p) : [0, 0, 0];
    const lp = bindPos[i];
    return (world[i] = [base[0] + lp[0], base[1] + lp[1], base[2] + lp[2]]);
  };
  for (let i = 0; i < parents.length; i++) resolve(i);
  return world as Vec3[];
}

/**
 * Some VRMs omit the optional UpperChest (and/or Chest) bone. Warudo then
 * records that bone as a degenerate zero quaternion and packs the entire
 * upper-spine bend into the single bone below it, so the torso folds at one
 * sharp joint — the body reads as "hunched" / bending at an odd spot.
 *
 * This unpacks that concentration: each dead, zero-length intermediate spine
 * bone is given a real position halfway to its child (every joint's world
 * position is preserved in the bind), and a fraction `amount` of its parent's
 * per-frame rotation is moved up onto it, so the fold spreads into a smoother
 * curve instead of one kink. `amount` is the share handed to the upper (dead)
 * joint: 0 leaves the bend on the lower joint (no change), 0.5 splits it
 * evenly (smoothest), 1 moves it entirely to the upper joint. No-op when no
 * such dead bone exists, so it is safe to always offer as a toggle.
 */
export function distributeBonelessSpine(c: ConvertedClip, amount = 0.5): ConvertedClip {
  const a = Math.max(0, Math.min(1, amount));
  const frames = c.times.length;
  const isDegenerate = (q: Quat) => Math.hypot(q[0], q[1], q[2], q[3]) < 0.5;
  const childrenOf = (i: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k < c.parents.length; k++) if (c.parents[k] === i) out.push(k);
    return out;
  };
  const SPINE = new Set(["Chest", "UpperChest"]);
  const dead: number[] = [];
  for (let i = 0; i < c.names.length; i++) {
    if (!SPINE.has(c.names[i])) continue;
    const len = Math.hypot(c.bindPos[i][0], c.bindPos[i][1], c.bindPos[i][2]);
    if (len < 1e-4 && childrenOf(i).length === 1 && c.localQuat[i].every(isDegenerate)) {
      dead.push(i);
    }
  }
  if (dead.length === 0) return c;

  const localQuat = c.localQuat.map((t) => t.map((q) => [...q] as Quat));
  const localPos = c.localPos.map((t) => t.map((p) => [...p] as Vec3));
  const bindPos = c.bindPos.map((p) => [...p] as Vec3);

  for (const d of dead) {
    const p = c.parents[d];
    const child = childrenOf(d)[0];
    // (1) Give the dead bone half the child's offset → it sits midway, and the
    // child keeps the rest, so all world joint positions are preserved in bind.
    const half: Vec3 = [bindPos[child][0] / 2, bindPos[child][1] / 2, bindPos[child][2] / 2];
    bindPos[d] = half;
    bindPos[child] = [bindPos[child][0] - half[0], bindPos[child][1] - half[1], bindPos[child][2] - half[2]];
    for (let f = 0; f < frames; f++) {
      localPos[d][f] = [...bindPos[d]] as Vec3;
      localPos[child][f] = [...bindPos[child]] as Vec3;
    }
    // (2) Move a fraction `a` of the parent's rotation up onto the dead bone:
    // parent keeps R^(1-a), dead takes R^a. They share R's axis, so
    // R^(1-a)·R^a = R and the child chain's orientation is unchanged.
    if (p >= 0) {
      for (let f = 0; f < frames; f++) {
        const R = localQuat[p][f];
        localQuat[p][f] = quatSlerp([0, 0, 0, 1], R, 1 - a);
        localQuat[d][f] = quatSlerp([0, 0, 0, 1], R, a);
      }
    }
  }
  return { ...c, localQuat, localPos, bindPos };
}

/**
 * Resample variable-rate motion onto a fixed frame rate (linear pos, slerp rot).
 * `trimStart`/`trimEnd` (seconds from clip start) restrict the exported range;
 * output time is rebased so the first kept frame is t=0. `speed` retimes the
 * export by scaling the sampling step: speed S means output duration =
 * trimmed duration / S (2× plays twice as fast) — no timewarp keys involved.
 */
export function resample(c: ConvertedClip, fps = 60, trimStart = 0, trimEnd?: number, speed = 1): ResampledClip {
  const t0 = c.times[0];
  const start = Math.max(0, Math.min(c.duration, trimStart));
  const end = Math.max(start, Math.min(c.duration, trimEnd ?? c.duration));
  const s = Math.max(0.01, speed);
  const duration = (end - start) / s;
  const frameCount = Math.max(1, Math.round(duration * fps) + 1);
  const boneCount = c.names.length;

  const localPos: Vec3[][] = Array.from({ length: boneCount }, () => new Array<Vec3>(frameCount));
  const localQuat: Quat[][] = Array.from({ length: boneCount }, () => new Array<Quat>(frameCount));
  const faceTracks = c.face ? c.face.tracks.map(() => new Float32Array(frameCount)) : null;

  let cursor = 0;
  for (let i = 0; i < frameCount; i++) {
    const t = t0 + start + (i * s) / fps;
    // advance cursor so c.times[cursor] <= t < c.times[cursor+1]
    while (cursor < c.times.length - 2 && c.times[cursor + 1] < t) cursor++;
    const ta = c.times[cursor];
    const tb = c.times[cursor + 1] ?? ta;
    const span = tb - ta;
    const frac = span > 1e-9 ? Math.max(0, Math.min(1, (t - ta) / span)) : 0;

    for (let b = 0; b < boneCount; b++) {
      const pa = c.localPos[b][cursor];
      const pb = c.localPos[b][cursor + 1] ?? pa;
      localPos[b][i] = [lerp(pa[0], pb[0], frac), lerp(pa[1], pb[1], frac), lerp(pa[2], pb[2], frac)];
      const qa = c.localQuat[b][cursor];
      const qb = c.localQuat[b][cursor + 1] ?? qa;
      localQuat[b][i] = quatSlerp(qa, qb, frac);
    }
    if (faceTracks && c.face) {
      for (let n = 0; n < faceTracks.length; n++) {
        const a = c.face.tracks[n][cursor];
        const b = c.face.tracks[n][cursor + 1] ?? a;
        faceTracks[n][i] = lerp(a, b, frac);
      }
    }
  }

  return {
    fps,
    frameCount,
    names: c.names,
    parents: c.parents,
    localPos,
    localQuat,
    bindPos: c.bindPos,
    face: c.face && faceTracks ? { names: c.face.names, tracks: faceTracks } : null,
  };
}
