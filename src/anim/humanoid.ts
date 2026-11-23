// Bone rotations → Unity humanoid "muscle" space (BETA).
//
// A humanoid .anim stores no bone rotations: it stores ~95 normalized muscle
// values plus a body position/rotation ("RootT"/"RootQ"), and Unity rebuilds
// each avatar's bones from them. Unity does not publish that math. What is
// here was measured against Unity itself (scripts/unity/AnimProbe.cs run in
// batch mode — see scripts/animCheck.mjs):
//
//   bone local = preQ ⊗ ZYRoll(dof · sign) ⊗ conj(postQ)
//     ZYRoll(x, y, z) = swing(0, ty, tz, 1) ⊗ roll(tx, 0, 0, 1), t = tan(angle / 2)
//     muscle = angle / max (angle ≥ 0) or angle / −min (angle < 0), in degrees
//   limbs (upper, lower, end): half of the upper bone's roll is applied at the
//     lower bone (about the upper bone's axis) and half of the lower bone's
//     roll at the hand / foot (about the lower bone's axis) — Unity's default
//     twist distribution of 0.5. Verified to < 0.05° on random muscle values.
//   body position = Σ weight · joint position (fixed per-joint weights), ÷ humanScale
//   body rotation = frame from the upper-leg and upper-arm joints, relative to the T-pose's
//
// preQ / postQ are exact for the reference avatar the probe ran on. For another
// skeleton they are re-aimed along that skeleton's own bone directions, which
// reproduces Unity's postQ closely; the T-pose muscle offsets are assumed equal
// to the reference's, which is where the remaining error on other avatars
// comes from (hands about 2° on the second avatar it was checked on). Everything in this file is in UNITY space (left-handed).
import { HUMAN_BODY_BONES, type Quat, type Vec3 } from "../wanim/parse.ts";
import { DOF_SIGN, MUSCLE_FROM_BONE, MUSCLE_MAX, MUSCLE_MIN, MUSCLE_NAMES, POST_Q, PRE_Q, REF_BIND } from "./unityAvatarData.ts";

export const MUSCLE_COUNT = MUSCLE_NAMES.length;
const RAD = Math.PI / 180;
/** Sine of the limb bend over which the upper-bone roll fades from the carried roll to the bend plane (about 0.25°–0.85°). */
export const STRAIGHT_FADE: [number, number] = [0.004, 0.015];
/** Unity's default upper/lower arm and leg twist distribution. */
const TWIST = 0.5;

// ---- quaternion helpers (Hamilton product, [x, y, z, w]) ---------------------------
const mul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const norm = (q: Quat): Quat => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n < 1e-12 ? [0, 0, 0, 1] : [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
const rot = (q: Quat, v: Vec3): Vec3 => {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const vnorm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rollX = (a: number): Quat => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const wrapPi = (a: number): number => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const isDead = (q: Quat): boolean => q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] < 0.25;

/** Shortest rotation taking direction a to direction b. */
function fromTo(a: Vec3, b: Vec3): Quat {
  const u = vnorm(a), v = vnorm(b);
  const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  if (d < -0.999999) return [0, 0, 0, 1]; // opposite: not a small re-aim, leave the reference frame
  const c = cross(u, v);
  return norm([c[0], c[1], c[2], 1 + d]);
}

/** ZYRoll angles (radians) → quaternion. */
function zyRollQuat(x: number, y: number, z: number): Quat {
  const tx = Math.tan(x / 2), ty = Math.tan(y / 2), tz = Math.tan(z / 2);
  return norm([tx, ty + tx * tz, tz - tx * ty, 1]);
}
/** Quaternion → ZYRoll angles (radians): roll about X, then the swing's Y and Z. */
function zyRollAngles(q: Quat): Vec3 {
  if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
  const n = Math.hypot(q[0], q[3]);
  if (n < 1e-9) return [0, 2 * Math.atan2(q[1], 1e-9), 2 * Math.atan2(q[2], 1e-9)];
  const tw: Quat = [q[0] / n, 0, 0, q[3] / n];
  const sw = mul(q, conj(tw));
  return [2 * Math.atan2(tw[0], tw[3]), 2 * Math.atan2(sw[1], sw[3]), 2 * Math.atan2(sw[2], sw[3])];
}

// ---- skeleton tables ----------------------------------------------------------------
const N = HUMAN_BODY_BONES as readonly string[];
const B = N.length;
const bi = (name: string): number => N.indexOf(name);

/**
 * Which joint a bone's axis points at: usually a child; the hand continues the forearm.
 * `to` lists fallbacks for optional bones — a Chest without an UpperChest aims at the Neck.
 */
const AXIS_TARGET: Array<{ bone: number; from: number; to: number[] }> = [];
/** Bones that reuse another bone's re-aim (finger tips share the middle segment's axes). */
const AXIS_SHARE = new Map<number, number>();
{
  const child = (a: string, ...b: string[]): void => { AXIS_TARGET.push({ bone: bi(a), from: bi(a), to: b.map(bi) }); };
  child("Hips", "Spine", "Chest"); child("Spine", "Chest", "UpperChest", "Neck"); child("Chest", "UpperChest", "Neck"); child("UpperChest", "Neck", "Head"); child("Neck", "Head");
  for (const s of ["Left", "Right"]) {
    child(`${s}Shoulder`, `${s}UpperArm`); child(`${s}UpperArm`, `${s}LowerArm`); child(`${s}LowerArm`, `${s}Hand`);
    AXIS_TARGET.push({ bone: bi(`${s}Hand`), from: bi(`${s}LowerArm`), to: [bi(`${s}Hand`)] });
    child(`${s}UpperLeg`, `${s}LowerLeg`); child(`${s}LowerLeg`, `${s}Foot`);
    for (const f of ["Thumb", "Index", "Middle", "Ring", "Little"]) {
      child(`${s}${f}Proximal`, `${s}${f}Intermediate`); child(`${s}${f}Intermediate`, `${s}${f}Distal`);
      AXIS_SHARE.set(bi(`${s}${f}Distal`), bi(`${s}${f}Intermediate`));
    }
  }
}
/** [upper, lower, end] limb chains with twist distribution. */
const LIMBS: number[][] = ["Left", "Right"].flatMap((s) => [
  [bi(`${s}UpperArm`), bi(`${s}LowerArm`), bi(`${s}Hand`)],
  [bi(`${s}UpperLeg`), bi(`${s}LowerLeg`), bi(`${s}Foot`)],
]);
/**
 * Unity's body-centre weights per joint (sum 82.5), recovered exactly from Unity. The arm
 * asymmetry is Unity's own. A joint the avatar lacks hands its weight to its children in equal
 * parts (measured for UpperChest → Neck + both Shoulders; assumed for the other optional bones).
 */
const MASS: Record<string, number> = {
  Spine: 5.25, Chest: 7.25, UpperChest: 9, Neck: 3.5, Head: 4.5,
  LeftUpperLeg: 9, RightUpperLeg: 9, LeftLowerLeg: 7, RightLowerLeg: 7, LeftFoot: 2.8, RightFoot: 2.8, LeftToes: 0.2, RightToes: 0.2,
  LeftShoulder: 3.25, RightShoulder: 3.25, LeftUpperArm: 2, RightUpperArm: 1.25, LeftLowerArm: 1, RightLowerArm: 1.75,
  LeftHand: 1.25, RightHand: 1.25,
};
function massWeights(parents: number[], present: boolean[]): number[] {
  const w = N.map((n) => MASS[n] ?? 0);
  const kids = (b: number): number[] => parents.map((p, i) => (p === b ? i : -1)).filter((i) => i >= 0 && (MASS[N[i]] ?? 0) > 0);
  // Parents first, so a weight can cascade through several missing joints.
  for (const b of topoOrder(parents)) {
    if (present[b] || !w[b]) continue;
    const to = kids(b);
    if (to.length) for (const c of to) w[c] += w[b] / to.length;
    else if (parents[b] >= 0) w[parents[b]] += w[b];
    w[b] = 0;
  }
  const sum = w.reduce((a, x) => a + x, 0) || 1;
  return w.map((x) => x / sum);
}

/** Rotation matrix columns (right, up, forward) → quaternion. */
function basisQuat(x: Vec3, y: Vec3, z: Vec3): Quat {
  const tr = x[0] + y[1] + z[2];
  let q: Quat;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]; }
  else if (x[0] > y[1] && x[0] > z[2]) { const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2; q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (y[1] > z[2]) { const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2; q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s]; }
  return norm(q);
}

export interface HumanoidRig {
  parents: number[];
  /** Parent-relative bind offsets, Unity space (Hips = [0, T-pose hips height, 0]). */
  bind: Vec3[];
  pre: Quat[];
  post: Quat[];
  /** Parents before children. */
  order: number[];
  /** Body-centre weight per joint (sums to 1). */
  massW: number[];
  /** Unity's Animator.humanScale for this skeleton: the body centre's height in the T-pose. */
  humanScale: number;
  /** Body orientation of the T-pose (the reference the body rotation is measured from). */
  refOrient: Quat;
}

export interface HumanPoseFrame {
  muscles: Float64Array;
  /** Body centre ÷ humanScale (RootT). */
  bodyPos: Vec3;
  /** RootQ. */
  bodyRot: Quat;
  /**
   * Limb twist carried from the previous frame (per limb: valid, upper roll, the upper bone's own
   * roll, lower roll). Pass the previous frame's result back in as `out` to keep it.
   */
  limbState?: Float64Array;
}

function topoOrder(parents: number[]): number[] {
  const order: number[] = [];
  const seen = new Uint8Array(parents.length);
  const visit = (b: number): void => {
    if (seen[b]) return;
    if (parents[b] >= 0) visit(parents[b]);
    seen[b] = 1;
    order.push(b);
  };
  for (let b = 0; b < parents.length; b++) visit(b);
  return order;
}

function jointPositions(rig: HumanoidRig, world: Quat[], hips: Vec3): Vec3[] {
  const p: Vec3[] = new Array(B);
  for (const b of rig.order) {
    const par = rig.parents[b];
    if (par < 0) { p[b] = hips; continue; }
    const o = rot(world[par], rig.bind[b]);
    p[b] = [p[par][0] + o[0], p[par][1] + o[1], p[par][2] + o[2]];
  }
  return p;
}
function bodyCentre(rig: HumanoidRig, p: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (let b = 0; b < B; b++) { const w = rig.massW[b]; if (!w) continue; c[0] += w * p[b][0]; c[1] += w * p[b][1]; c[2] += w * p[b][2]; }
  return c;
}
function bodyOrient(p: Vec3[]): Quat {
  const ll = p[bi("LeftUpperLeg")], rl = p[bi("RightUpperLeg")], la = p[bi("LeftUpperArm")], ra = p[bi("RightUpperArm")];
  const up = vnorm([la[0] + ra[0] - ll[0] - rl[0], la[1] + ra[1] - ll[1] - rl[1], la[2] + ra[2] - ll[2] - rl[2]]);
  const right = vnorm([rl[0] - ll[0] + ra[0] - la[0], rl[1] - ll[1] + ra[1] - la[1], rl[2] - ll[2] + ra[2] - la[2]]);
  const fwd = vnorm(cross(right, up));
  return basisQuat(cross(up, fwd), up, fwd);
}

/**
 * Build the muscle axes for a skeleton.
 * `bind` = parent-relative T-pose offsets in Unity space; `hipsHeight` = the hips' height above
 * the ground in the T-pose (meters); `present` = which bones the avatar actually has (default all).
 */
export function buildHumanoidRig(parents: number[], bindUnity: Vec3[], hipsHeight: number, present?: boolean[]): HumanoidRig {
  const order = topoOrder(parents);
  const bind = bindUnity.map((v) => [v[0], v[1], v[2]] as Vec3);
  bind[0] = [0, hipsHeight, 0];
  // T-pose joint positions of this skeleton and of the reference (identity rotations).
  const tpos = (bd: number[][] | Vec3[]): Vec3[] => {
    const p: Vec3[] = new Array(B);
    for (const b of order) { const par = parents[b]; p[b] = par < 0 ? [0, 0, 0] : [p[par][0] + bd[b][0], p[par][1] + bd[b][1], p[par][2] + bd[b][2]]; }
    return p;
  };
  const mine = tpos(bind), ref = tpos(REF_BIND);
  const aim: Quat[] = N.map(() => [0, 0, 0, 1] as Quat);
  for (const t of AXIS_TARGET) {
    // First candidate that is a real joint away (an absent bone sits on top of its parent).
    const d = (p: Vec3[]): Vec3 => {
      for (const to of t.to) {
        const v: Vec3 = [p[to][0] - p[t.from][0], p[to][1] - p[t.from][1], p[to][2] - p[t.from][2]];
        if (Math.hypot(v[0], v[1], v[2]) >= 1e-5) return v;
      }
      return [0, 0, 0];
    };
    const a = d(ref), b = d(mine);
    if (Math.hypot(a[0], a[1], a[2]) < 1e-5 || Math.hypot(b[0], b[1], b[2]) < 1e-5) continue;
    aim[t.bone] = fromTo(a, b);
  }
  for (const [bone, src] of AXIS_SHARE) aim[bone] = aim[src];
  const pre = N.map((_, b) => norm(mul(aim[b], PRE_Q[b] as Quat)));
  const post = N.map((_, b) => norm(mul(aim[b], POST_Q[b] as Quat)));

  const massW = massWeights(parents, present ?? N.map(() => true));
  const rig: HumanoidRig = { parents, bind, pre, post, order, massW, humanScale: 1, refOrient: [0, 0, 0, 1] };
  const ident = N.map(() => [0, 0, 0, 1] as Quat);
  const tp = jointPositions(rig, ident, [0, hipsHeight, 0]);
  rig.humanScale = bodyCentre(rig, tp)[1];
  rig.refOrient = bodyOrient(tp);
  return rig;
}

const dofToMuscle = (bone: number, k: number, angle: number): number => {
  const m = MUSCLE_FROM_BONE[bone][k];
  const v = (angle / RAD) * DOF_SIGN[bone][k];
  return v >= 0 ? v / MUSCLE_MAX[m] : v / -MUSCLE_MIN[m];
};
const muscleToDof = (bone: number, k: number, muscles: ArrayLike<number>): number => {
  const m = MUSCLE_FROM_BONE[bone][k];
  if (m < 0) return 0;
  const v = muscles[m];
  return (v >= 0 ? v * MUSCLE_MAX[m] : v * -MUSCLE_MIN[m]) * DOF_SIGN[bone][k] * RAD;
};

/**
 * Unity's muscles → bone LOCAL rotations for this rig (Hips = identity; place
 * it with the body transform). This is the model that was verified against
 * Unity's own SetHumanPose.
 */
export function musclesToLocal(rig: HumanoidRig, muscles: ArrayLike<number>): Quat[] {
  const q: Quat[] = new Array(B);
  const dof = (b: number): Vec3 => [muscleToDof(b, 0, muscles), muscleToDof(b, 1, muscles), muscleToDof(b, 2, muscles)];
  for (let b = 0; b < B; b++) {
    if (b === 0) { q[b] = [0, 0, 0, 1]; continue; }
    const d = dof(b);
    q[b] = mul(mul(rig.pre[b], zyRollQuat(d[0], d[1], d[2])), conj(rig.post[b]));
  }
  for (const [u, l, e] of LIMBS) {
    const du = dof(u), dl = dof(l), de = dof(e);
    q[u] = mul(mul(rig.pre[u], zyRollQuat(du[0] * (1 - TWIST), du[1], du[2])), conj(rig.post[u]));
    const twU = mul(mul(rig.post[u], rollX(du[0] * TWIST)), conj(rig.post[u]));
    const twL = mul(mul(rig.post[l], rollX(dl[0] * TWIST)), conj(rig.post[l]));
    q[l] = mul(twU, mul(mul(rig.pre[l], zyRollQuat(dl[0] * (1 - TWIST), dl[1], dl[2])), conj(rig.post[l])));
    q[e] = mul(twL, mul(mul(rig.pre[e], zyRollQuat(de[0], de[1], de[2])), conj(rig.post[e])));
  }
  return q;
}

/**
 * A limb roll past half a turn is the same joint pose as the roll a full turn back, but split
 * differently between the two bones (each takes half), so it leaves the limb wrung. Following
 * the previous frame keeps tracking glitches from popping the limb; letting go once the roll is
 * well past half a turn keeps one glitch from leaving it wrung for the rest of the take. The
 * 45° margin stops a roll that hovers around ±180° from flipping back and forth.
 */
const ROLL_LIMIT = Math.PI * 1.25;
const settle = (x: number): number => (Math.abs(x) > ROLL_LIMIT ? wrapPi(x) : x);

const LIMB_OF = new Map<number, number[]>();
for (const limb of LIMBS) for (const b of limb) LIMB_OF.set(b, limb);
const smoothstep = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * One pose → Unity's human pose. `local` = bone local rotations (Unity space,
 * identity = T-pose; Hips = its world rotation), `hips` = hips world position.
 *
 * Bones are fitted in hierarchy order against WORLD targets: each bone is
 * projected onto the muscles it actually has, and its children are then
 * fitted relative to what Unity will rebuild, not to the recording — so a
 * degree of freedom a bone lacks (a shoulder cannot roll) is picked up by the
 * next bone down instead of being lost.
 *
 * Limb twist is not unique (see below), so it is tracked through time: call
 * this for consecutive frames and pass each result back in as `out`.
 */
export function poseToHuman(rig: HumanoidRig, local: Quat[], hips: Vec3, out?: HumanPoseFrame): HumanPoseFrame {
  const res = out ?? { muscles: new Float64Array(MUSCLE_COUNT), bodyPos: [0, 0, 0] as Vec3, bodyRot: [0, 0, 0, 1] as Quat };
  const mus = res.muscles;
  mus.fill(0);
  const state = (res.limbState ??= new Float64Array(LIMBS.length * 4));
  const { parents, pre, post, order } = rig;
  const loc = (b: number): Quat => (isDead(local[b]) ? [0, 0, 0, 1] : norm(local[b]));
  // Target world rotations (the recording) and rebuilt world rotations (what Unity will produce).
  const W: Quat[] = new Array(B), R: Quat[] = new Array(B);
  for (const b of order) W[b] = parents[b] < 0 ? loc(b) : mul(W[parents[b]], loc(b));
  const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0];

  for (const b of order) {
    const par = parents[b];
    if (par < 0) { R[b] = W[b]; continue; }
    const limb = LIMB_OF.get(b);
    if (limb) {
      if (b !== limb[0]) continue; // lower + end are solved with the upper bone
      const [u, l, e] = limb;
      const Rp = R[par];
      // -- upper bone: swing is exact; roll (humeral / femoral twist) is decided below.
      const aU = zyRollAngles(mul(mul(conj(pre[u]), mul(conj(Rp), W[u])), post[u]));
      const S = mul(pre[u], zyRollQuat(0, aU[1], aU[2]));
      // -- the lower bone has no side swing: its direction fixes the upper roll and the bend.
      const tdir = rot(mul(conj(Rp), W[l]), rot(post[l], X));
      const d = rot(conj(S), tdir);
      const C = mul(conj(post[u]), pre[l]);
      const c1 = rot(C, X), c2 = rot(C, Y);
      const naiveL = zyRollAngles(mul(mul(conj(pre[l]), loc(l)), post[l]));
      const a0 = Math.atan2(c2[0], c1[0]);
      const span = Math.acos(Math.max(-1, Math.min(1, d[0] / (Math.hypot(c1[0], c2[0]) || 1))));
      // Two bends reach the same direction: +θ with roll x, or −θ with roll x + 180° (flexed, or
      // hyperextended with the limb turned over). Recordings do hyperextend, and the recorded
      // bone's own roll does not follow the bend plane reliably, so the choice is made by
      // CONTINUITY: stay with the roll carried from the previous frame, moved by however much
      // the bone itself rolled since. The first frame takes the flexed solution.
      const si = LIMBS.indexOf(limb) * 4;
      const had = state[si] === 1;
      const carried = had ? state[si + 1] + wrapPi(aU[0] - state[si + 2]) : aU[0];
      const solve = (z: number): { z: number; v: Vec3; x: number } => {
        const v: Vec3 = [Math.cos(z) * c1[0] + Math.sin(z) * c2[0], Math.cos(z) * c1[1] + Math.sin(z) * c2[1], Math.cos(z) * c1[2] + Math.sin(z) * c2[2]];
        return { z: wrapPi(z), v, x: Math.atan2(d[2], d[1]) - Math.atan2(v[2], v[1]) };
      };
      const sA = solve(a0 + span), sB = solve(a0 - span);
      const flexed = (c: { z: number }): number => dofToMuscle(l, 2, c.z);
      const pick = had
        ? (Math.abs(wrapPi(sA.x - carried)) <= Math.abs(wrapPi(sB.x - carried)) ? sA : sB)
        : (flexed(sA) <= flexed(sB) ? sA : sB);
      const zL = pick.z, v = pick.v;
      // Within a degree or so of a straight limb the bend plane is undefined (and noisy): fade to the
      // carried roll there. `bend` is the sine of the bend.
      const bend = Math.min(Math.hypot(v[1], v[2]), Math.hypot(d[1], d[2]));
      let xU = carried + smoothstep(STRAIGHT_FADE[0], STRAIGHT_FADE[1], bend) * wrapPi(pick.x - carried);
      xU = settle(xU);
      const qU = mul(mul(pre[u], zyRollQuat(xU * (1 - TWIST), aU[1], aU[2])), conj(post[u]));
      const twU = mul(mul(post[u], rollX(xU * TWIST)), conj(post[u]));
      R[u] = mul(Rp, qU);
      // -- lower roll (forearm / shin twist): whatever leaves the hand / foot with no roll of its own.
      const endAngles = (xL: number): { a: Vec3; RL: Quat; qE0: Quat } => {
        const qL = mul(twU, mul(mul(pre[l], zyRollQuat(xL * (1 - TWIST), 0, zL)), conj(post[l])));
        const RL = mul(R[u], qL);
        const twL = mul(mul(post[l], rollX(xL * TWIST)), conj(post[l]));
        const a = zyRollAngles(mul(mul(conj(pre[e]), mul(conj(twL), mul(conj(RL), W[e]))), post[e]));
        return { a, RL, qE0: twL };
      };
      const endOwn = zyRollAngles(mul(mul(conj(pre[e]), loc(e)), post[e]));
      // Start from the previous frame's value: the solutions are a full turn apart, and the nearest
      // one keeps the forearm / shin from flipping when the hand's roll passes ±180°.
      let x0 = had ? state[si + 3] : naiveL[0] + endOwn[0];
      let r0 = endAngles(x0);
      let x1 = x0 + r0.a[0];
      let r1 = endAngles(x1);
      for (let it = 0; it < 8 && Math.abs(r1.a[0]) > 1e-6; it++) {
        const denom = r1.a[0] - r0.a[0];
        if (Math.abs(denom) < 1e-12) break;
        const x2 = x1 - (r1.a[0] * (x1 - x0)) / denom;
        x0 = x1; r0 = r1; x1 = x2; r1 = endAngles(x1);
      }
      const best = Math.abs(r1.a[0]) <= Math.abs(r0.a[0]) ? { x: x1, r: r1 } : { x: x0, r: r0 };
      let xL = best.x;
      // Nearest full-turn equivalent of the previous frame, then the same settling rule as above.
      xL = settle(had ? state[si + 3] + wrapPi(xL - state[si + 3]) : wrapPi(xL));
      if (xL !== best.x) best.r = endAngles(xL);
      state[si] = 1; state[si + 1] = xU; state[si + 2] = aU[0]; state[si + 3] = xL;
      R[l] = best.r.RL;
      const qE = mul(best.r.qE0, mul(mul(pre[e], zyRollQuat(0, best.r.a[1], best.r.a[2])), conj(post[e])));
      R[e] = mul(R[l], qE);
      mus[MUSCLE_FROM_BONE[u][0]] = dofToMuscle(u, 0, xU);
      mus[MUSCLE_FROM_BONE[u][1]] = dofToMuscle(u, 1, aU[1]);
      mus[MUSCLE_FROM_BONE[u][2]] = dofToMuscle(u, 2, aU[2]);
      mus[MUSCLE_FROM_BONE[l][0]] = dofToMuscle(l, 0, xL);
      mus[MUSCLE_FROM_BONE[l][2]] = dofToMuscle(l, 2, zL);
      mus[MUSCLE_FROM_BONE[e][1]] = dofToMuscle(e, 1, best.r.a[1]);
      mus[MUSCLE_FROM_BONE[e][2]] = dofToMuscle(e, 2, best.r.a[2]);
      continue;
    }
    const a = zyRollAngles(mul(mul(conj(pre[b]), mul(conj(R[par]), W[b])), post[b]));
    const map = MUSCLE_FROM_BONE[b];
    for (let k = 0; k < 3; k++) { if (map[k] < 0) a[k] = 0; else mus[map[k]] = dofToMuscle(b, k, a[k]); }
    R[b] = mul(R[par], mul(mul(pre[b], zyRollQuat(a[0], a[1], a[2])), conj(post[b])));
  }

  // Body transform, measured on the pose Unity will rebuild.
  const p = jointPositions(rig, R, hips);
  const c = bodyCentre(rig, p);
  res.bodyPos = [c[0] / rig.humanScale, c[1] / rig.humanScale, c[2] / rig.humanScale];
  res.bodyRot = norm(mul(bodyOrient(p), conj(rig.refOrient)));
  return res;
}

/** Attribute name of a muscle curve inside a .anim (fingers use "LeftHand.Index.1 Stretched"). */
export function muscleAttribute(m: number): string {
  const n = MUSCLE_NAMES[m];
  const f = /^(Left|Right) (Thumb|Index|Middle|Ring|Little) (.+)$/.exec(n);
  return f ? `${f[1]}Hand.${f[2]}.${f[3]}` : n;
}
export { MUSCLE_NAMES };
