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
}

// Unity (left-handed, +Z forward) → right-handed Y-up: negate Z.
// A position mirrors directly; a rotation quaternion's x,y components flip sign.
const flipPos = (p: Vec3): Vec3 => [p[0], p[1], -p[2]];
const flipQuat = (q: Quat): Quat => [-q[0], -q[1], q[2], q[3]];

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
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Resample variable-rate motion onto a fixed frame rate (linear pos, slerp rot). */
export function resample(c: ConvertedClip, fps = 60): ResampledClip {
  const t0 = c.times[0];
  const duration = c.duration;
  const frameCount = Math.max(1, Math.round(duration * fps) + 1);
  const boneCount = c.names.length;

  const localPos: Vec3[][] = Array.from({ length: boneCount }, () => new Array<Vec3>(frameCount));
  const localQuat: Quat[][] = Array.from({ length: boneCount }, () => new Array<Quat>(frameCount));

  let cursor = 0;
  for (let i = 0; i < frameCount; i++) {
    const t = t0 + i / fps;
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
  }

  return {
    fps,
    frameCount,
    names: c.names,
    parents: c.parents,
    localPos,
    localQuat,
    bindPos: c.bindPos,
  };
}
