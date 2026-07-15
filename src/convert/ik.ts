import type { Quat, Vec3 } from "../wanim/parse.ts";
import { quatMul, quatNormalize, quatRotate } from "./quat.ts";

// Shared IK / vector helpers used by the feet-contact fixer and the control
// rig. The two-bone solver is the exact math proven by the feet filter
// (cleanCheck): swing the root so the mid joint lands on the law-of-cosines
// circle (original mid direction = pole, so knees/elbows keep their recorded
// plane), swing the mid so the end lands on the target, and preserve the end
// bone's WORLD rotation so hands/feet don't visibly rotate.

export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vlen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a: Vec3): Vec3 => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Shortest-arc rotation taking unit vector a onto unit vector b. */
export function quatFromTo(a: Vec3, b: Vec3): Quat {
  const d = vdot(a, b);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    // Antiparallel: 180° about any axis perpendicular to a.
    const ref: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const c: Vec3 = [a[1] * ref[2] - a[2] * ref[1], a[2] * ref[0] - a[0] * ref[2], a[0] * ref[1] - a[1] * ref[0]];
    const l = vlen(c) || 1;
    return [c[0] / l, c[1] / l, c[2] / l, 0];
  }
  const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return quatNormalize([c[0], c[1], c[2], 1 + d]);
}

export interface ChainWorld {
  /** World rotation of the chain root's PARENT (hips for legs, shoulder for arms). */
  parentRot: Quat;
  rootP: Vec3; midP: Vec3; endP: Vec3;
  rootR: Quat; midR: Quat; endR: Quat;
}

export interface TwoBoneResult {
  rootLocal: Quat;
  midLocal: Quat;
  /** End local that PRESERVES the end bone's world rotation. */
  endLocal: Quat;
  /** New mid/end world rotations (for chaining a rotation edit after). */
  midWorld: Quat;
  /** Where the end joint actually landed (target clamped to reach). */
  endWorld: Vec3;
  /** Distance the end joint moved from its input position. */
  moved: number;
}

/**
 * Two-bone IK on world-space chain state; returns new local rotations or
 * null when the chain is degenerate (zero-length bones or zero reach).
 * `poleFallback` orients the mid joint when root→target passes through the
 * original mid (straight chain) — pass the chain's natural bend direction.
 */
export function solveTwoBone(w: ChainWorld, target: Vec3, poleFallback: Vec3, poleTarget?: Vec3): TwoBoneResult | null {
  const L1 = vlen(vsub(w.midP, w.rootP));
  const L2 = vlen(vsub(w.endP, w.midP));
  if (L1 < 1e-6 || L2 < 1e-6) return null;

  const to = vsub(target, w.rootP);
  let d = vlen(to);
  if (d < 1e-6) return null;
  const dir = vscale(to, 1 / d);
  d = Math.min(Math.max(d, Math.abs(L1 - L2) * 1.0001 + 1e-6), (L1 + L2) * 0.9999);
  const reach = vadd(w.rootP, vscale(dir, d)); // actual (reach-clamped) end target

  // Pole direction: an explicit poleTarget (pole-vector handle) points the mid
  // joint toward it; otherwise keep the original mid direction. Both projected
  // perpendicular to root→target so bone lengths are preserved.
  const kd = poleTarget ? vsub(poleTarget, w.rootP) : vsub(w.midP, w.rootP);
  let pole = vsub(kd, vscale(dir, vdot(kd, dir)));
  const pl = vlen(pole);
  pole = pl > 1e-6 ? vscale(pole, 1 / pl) : vnorm(poleFallback);

  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const b = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const midNew = vadd(w.rootP, vadd(vscale(dir, a), vscale(pole, b)));

  // Swing the root so the mid lands at midNew, then the mid so the end lands
  // at reach; write back as locals. End keeps its original world rotation.
  const s1 = quatFromTo(vnorm(vsub(w.midP, w.rootP)), vnorm(vsub(midNew, w.rootP)));
  const rootR2 = quatMul(s1, w.rootR);
  const endSwung = vadd(midNew, quatRotate(s1, vsub(w.endP, w.midP)));
  const s2 = quatFromTo(vnorm(vsub(endSwung, midNew)), vnorm(vsub(reach, midNew)));
  const midR2 = quatMul(s2, quatMul(s1, w.midR));

  return {
    rootLocal: quatNormalize(quatMul(qconj(w.parentRot), rootR2)),
    midLocal: quatNormalize(quatMul(qconj(rootR2), midR2)),
    endLocal: quatNormalize(quatMul(qconj(midR2), w.endR)),
    midWorld: midR2,
    endWorld: reach,
    moved: vlen(vsub(reach, w.endP)),
  };
}
