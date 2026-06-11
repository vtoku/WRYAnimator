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
export function retargetProportions(c: ConvertedClip, targetJoints: (Vec3 | null)[]): ConvertedClip {
  const ourWorld = bindWorldPositions(c.parents, c.bindPos);
  const ourHipsY = ourWorld[0][1] || 1;
  const tgtHipsY = targetJoints[0]?.[1] || ourHipsY;
  const s = tgtHipsY / ourHipsY;

  const newBind: Vec3[] = c.bindPos.map((p, i) => {
    const t = targetJoints[i];
    const parent = c.parents[i];
    const tp = parent >= 0 ? targetJoints[parent] : null;
    if (t && (parent < 0 || tp)) {
      return parent < 0
        ? [t[0], t[1], t[2]]
        : [t[0] - tp![0], t[1] - tp![1], t[2] - tp![2]];
    }
    return [p[0] * s, p[1] * s, p[2] * s];
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
 * Resample variable-rate motion onto a fixed frame rate (linear pos, slerp rot).
 * `trimStart`/`trimEnd` (seconds from clip start) restrict the exported range;
 * output time is rebased so the first kept frame is t=0.
 */
export function resample(c: ConvertedClip, fps = 60, trimStart = 0, trimEnd?: number): ResampledClip {
  const t0 = c.times[0];
  const start = Math.max(0, Math.min(c.duration, trimStart));
  const end = Math.max(start, Math.min(c.duration, trimEnd ?? c.duration));
  const duration = end - start;
  const frameCount = Math.max(1, Math.round(duration * fps) + 1);
  const boneCount = c.names.length;

  const localPos: Vec3[][] = Array.from({ length: boneCount }, () => new Array<Vec3>(frameCount));
  const localQuat: Quat[][] = Array.from({ length: boneCount }, () => new Array<Quat>(frameCount));
  const faceTracks = c.face ? c.face.tracks.map(() => new Float32Array(frameCount)) : null;

  let cursor = 0;
  for (let i = 0; i < frameCount; i++) {
    const t = t0 + start + i / fps;
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
