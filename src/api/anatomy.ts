// Anatomical joint components: read and write a bone's LOCAL rotation as
// numbers an animator would say out loud, instead of a quaternion.
//
// CONVENTION (identity local rotation = T-pose; character faces +Z, left at +X,
// palms down — see CLAUDE.md "Identity local rotations === T-pose"):
//
//   q = swing ⊗ twist
//   twist  — rotation about the bone's LONG AXIS (toward its child: wrist →
//            middle finger, elbow → wrist, knuckle → next knuckle).
//            + = supination (palm-down hand turning thumb-up); − = pronation.
//   swing  — the rest, written as a rotation vector split on two axes ⟂ to the
//            long axis:
//     flex       + = palm-ward (wrist flexion; a finger closing = "curl")
//                − = back-of-hand-ward (wrist extension; finger HYPERextension)
//     deviation  + = toward the thumb side (radial; a finger's "splay")
//                − = toward the little-finger side (ulnar)
//
// All three are in DEGREES and mean the same anatomical motion on the left
// and right sides (the left side's axes are the mirror image). `swing` is the
// total bend, hypot(flex, deviation). Fingers use the same split under the
// names curl (= flex) and splay (= deviation). The thumb's "curl" is the
// rotation that folds it down toward the palm in the T-pose — an
// approximation, since a thumb's true flexion axis is oblique.
//
// The split is exact and invertible for swing < 180°:
//   compose(decompose(q)) === q.
import type { Quat, Vec3 } from "../wanim/parse.ts";
import type { ConvertedClip } from "../convert/clip.ts";
import { quatMul, quatNormalize } from "../convert/quat.ts";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export type AnatomyKind = "wrist" | "forearm" | "finger" | "generic";

export interface BoneAxes {
  bone: number;
  name: string;
  kind: AnatomyKind;
  side: "Left" | "Right" | null;
  /** Long axis in the bone's local frame (unit). */
  axis: Vec3;
  /** Rotation about this axis by +θ = +θ of flex / curl. */
  flexAxis: Vec3;
  /** Rotation about this axis by +θ = +θ of deviation / splay. */
  devAxis: Vec3;
  /** +1 / −1: multiplies the raw twist angle about `axis` so + is supination on both sides. */
  twistSign: number;
}

export interface Anatomy {
  /** Degrees. See the convention at the top of this file. */
  flex: number;
  deviation: number;
  twist: number;
  /** Total swing angle = hypot(flex, deviation), degrees. */
  swing: number;
}

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"];
const SEGMENTS = ["Proximal", "Intermediate", "Distal"];

export const fingerBoneNames = (side: "Left" | "Right"): string[] =>
  FINGERS.flatMap((f) => SEGMENTS.map((s) => `${side}${f}${s}`));

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Name of the child that defines a bone's long axis, or null if it has none. */
function axisChild(name: string): string | null {
  const m = /^(Left|Right)(.*)$/.exec(name);
  if (m) {
    const [, side, rest] = m;
    if (rest === "Hand") return `${side}MiddleProximal`;
    if (rest === "LowerArm") return `${side}Hand`;
    if (rest === "UpperArm") return `${side}LowerArm`;
    if (rest === "Shoulder") return `${side}UpperArm`;
    if (rest === "UpperLeg") return `${side}LowerLeg`;
    if (rest === "LowerLeg") return `${side}Foot`;
    if (rest === "Foot") return `${side}Toes`;
    for (const f of FINGERS) {
      if (rest === `${f}Proximal`) return `${side}${f}Intermediate`;
      if (rest === `${f}Intermediate`) return `${side}${f}Distal`;
      // A distal bone has no child: it continues its parent segment's direction.
      if (rest === `${f}Distal`) return `${side}${f}Distal`;
    }
  }
  return null;
}

/** Build the anatomical axes for a bone from the clip's rest (bind) skeleton. */
export function boneAxes(clip: ConvertedClip, bone: number): BoneAxes {
  const name = clip.names[bone];
  const sideM = /^(Left|Right)/.exec(name);
  const side = sideM ? (sideM[1] as "Left" | "Right") : null;
  const rest = side ? name.slice(side.length) : name;
  const kind: AnatomyKind =
    rest === "Hand" ? "wrist" : rest === "LowerArm" ? "forearm" : /(Proximal|Intermediate|Distal)$/.test(rest) ? "finger" : "generic";

  // Long axis = bind offset of the defining child, in this bone's local frame.
  const fallback: Vec3 = side === "Left" ? [1, 0, 0] : side === "Right" ? [-1, 0, 0] : [0, 1, 0];
  let axis = fallback;
  const childName = axisChild(name);
  if (childName) {
    const ci = clip.names.indexOf(childName);
    // Distal bones point along their own offset from the intermediate.
    const off = ci >= 0 ? clip.bindPos[ci] : null;
    if (off && Math.hypot(off[0], off[1], off[2]) > 1e-5) axis = norm(off);
  }

  // Palm normal in the T-pose is straight down. Flex axis = axis × palmNormal:
  // rotating about it by +θ swings the bone toward the palm on BOTH sides.
  const palm: Vec3 = [0, -1, 0];
  let flexAxis = cross(axis, palm);
  if (Math.hypot(flexAxis[0], flexAxis[1], flexAxis[2]) < 1e-4) flexAxis = [0, 0, side === "Left" ? -1 : 1];
  flexAxis = norm(flexAxis);
  // Thumb side is forward (+Z) on both hands; the mirror flips the chirality.
  const s = side === "Left" ? -1 : 1;
  const d = cross(axis, flexAxis);
  const devAxis = norm([d[0] * s, d[1] * s, d[2] * s]);
  return { bone, name, kind, side, axis, flexAxis, devAxis, twistSign: s };
}

const isDead = (q: Quat): boolean => q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] < 0.25;

/** Split a local rotation into flex / deviation / twist (degrees). */
export function decompose(ax: BoneAxes, qIn: Quat): Anatomy {
  if (isDead(qIn)) return { flex: 0, deviation: 0, twist: 0, swing: 0 };
  const q = quatNormalize(qIn);
  const a = ax.axis;
  // Twist = the part of the rotation about the long axis (same as clean.ts).
  const proj = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
  const tn = Math.hypot(proj, q[3]);
  const twist: Quat = tn < 1e-9 ? [0, 0, 0, 1] : [(a[0] * proj) / tn, (a[1] * proj) / tn, (a[2] * proj) / tn, q[3] / tn];
  let twistAngle = 2 * Math.atan2(proj, q[3]);
  if (twistAngle > Math.PI) twistAngle -= 2 * Math.PI;
  if (twistAngle < -Math.PI) twistAngle += 2 * Math.PI;
  let swing = quatMul(q, [-twist[0], -twist[1], -twist[2], twist[3]]);
  if (swing[3] < 0) swing = [-swing[0], -swing[1], -swing[2], -swing[3]];
  const sv = Math.hypot(swing[0], swing[1], swing[2]);
  const angle = 2 * Math.atan2(sv, swing[3]);
  const k = sv > 1e-12 ? angle / sv : 0;
  const v: Vec3 = [swing[0] * k, swing[1] * k, swing[2] * k];
  return {
    flex: dot(v, ax.flexAxis) * DEG,
    deviation: dot(v, ax.devAxis) * DEG,
    twist: twistAngle * ax.twistSign * DEG,
    swing: angle * DEG,
  };
}

/** Build a local rotation from flex / deviation / twist (degrees). */
export function compose(ax: BoneAxes, v: { flex: number; deviation: number; twist: number }): Quat {
  const f = v.flex * RAD;
  const d = v.deviation * RAD;
  const rx = ax.flexAxis[0] * f + ax.devAxis[0] * d;
  const ry = ax.flexAxis[1] * f + ax.devAxis[1] * d;
  const rz = ax.flexAxis[2] * f + ax.devAxis[2] * d;
  const angle = Math.hypot(rx, ry, rz);
  const s = angle > 1e-12 ? Math.sin(angle / 2) / angle : 0.5;
  const swing: Quat = [rx * s, ry * s, rz * s, Math.cos(angle / 2)];
  const t = (v.twist * RAD * ax.twistSign) / 2;
  const st = Math.sin(t);
  const twist: Quat = [ax.axis[0] * st, ax.axis[1] * st, ax.axis[2] * st, Math.cos(t)];
  return quatNormalize(quatMul(swing, twist));
}

/**
 * Soft clamp: values inside [lo, hi] by more than `soft` degrees are
 * untouched; the last `soft` degrees ease toward the limit so the clamp has
 * no corner (C1). soft = 0 is a hard clamp.
 */
export function softClamp(x: number, lo: number, hi: number, soft: number): number {
  if (!(soft > 0)) return Math.min(hi, Math.max(lo, x));
  const s = Math.min(soft, (hi - lo) / 2);
  if (x > hi - s) return hi - s * Math.exp(-(x - (hi - s)) / s);
  if (x < lo + s) return lo + s * Math.exp(-((lo + s) - x) / s);
  return x;
}
