import type { ConvertedClip } from "./clip.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";
import { quatNormalize, quatDot, quatSlerp } from "./quat.ts";
import { fixFeet, type FeetStats, type FeetEdits } from "./feet.ts";

// Basic mocap cleaning, applied to the converted (≈uniform-rate) clip so it
// shows in the preview and flows to the export.
//
//  - despike: removes single-frame pops / hand-flips (a frame that jumps far
//    from BOTH neighbours while the neighbours agree) by slerping across it.
//  - smooth:  zero-phase Butterworth low-pass (filtfilt) on rotations + hips
//    translation to kill jitter without introducing lag.

export interface CleanOpts {
  despike?: boolean;
  /** Per-frame angular jump (degrees) above which a lone frame is treated as a pop. */
  despikeDeg?: number;
  smooth?: boolean;
  /** Butterworth cutoff in Hz (lower = smoother). */
  cutoffHz?: number;
  /** Clamp wrist rotation to the human range (twist ±90°, swing 85°). */
  limitWrists?: boolean;
  /**
   * Freeze the hand's local rotation to neutral (identity = T-pose relative,
   * so the hand just follows the forearm). For hands flailing from bad
   * tracking; fingers still animate.
   */
  lockWrists?: "left" | "right" | "both";
  /**
   * Clamp forearm (LowerArm) axial twist — pronation/supination — to the human
   * range (±90°). Elbow bend (swing) is left free. Fixes over-rotated forearms
   * from tracking that dumps too much twist onto the lower arm.
   */
  limitLowerArms?: boolean;
  /**
   * Zero the forearm's axial twist entirely while keeping elbow bend, so the
   * forearm stops spinning. For a forearm that twists wildly from bad tracking.
   */
  lockLowerArmTwist?: "left" | "right" | "both";
  /**
   * Pin planted feet (no sliding) and keep them on the floor (no clipping),
   * via two-bone leg IK. Runs last so smoothing can't undo it.
   */
  fixFeet?: boolean;
  /** Per-plant user overrides (removed plants) applied on top of detection. */
  feetEdits?: FeetEdits;
}

/** Filled by cleanClip when passed: what each filter actually changed. */
export interface CleanStats {
  /** Frames replaced by the despike filter (across all bones). */
  despiked: number;
  /** Wrist frames clamped by the limiter. */
  wristClamped: number;
  /** Forearm frames changed by the twist limit/lock. */
  forearmClamped: number;
  /** Mean per-frame change introduced by smoothing, degrees (0 = off). */
  smoothedMeanDeg: number;
  /** What the feet fixer did (undefined = off). */
  feet?: FeetStats;
  /** Frame indices each category touched — drives the timeline tick marks. */
  fixedFrames?: { despike: Set<number>; limit: Set<number> };
}

const DEG2RAD = Math.PI / 180;

function angleBetween(a: Quat, b: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(quatDot(a, b))));
}

function despikeQuats(track: Quat[], thresholdRad: number, frames?: Set<number>): number {
  let fixed = 0;
  for (let i = 1; i < track.length - 1; i++) {
    const prev = track[i - 1];
    const cur = track[i];
    const next = track[i + 1];
    const dPrev = angleBetween(prev, cur);
    const dNext = angleBetween(cur, next);
    const dSpan = angleBetween(prev, next);
    // Lone outlier: far from both neighbours, but the neighbours are close.
    if (dPrev > thresholdRad && dNext > thresholdRad && dSpan < thresholdRad) {
      track[i] = quatSlerp(prev, next, 0.5);
      frames?.add(i);
      fixed++;
    }
  }
  return fixed;
}

/** A one-frame hips position jump that snaps back — same test as the quats. */
const POS_SPIKE_M = 0.05;

function despikePos(track: Vec3[], thresholdM: number, frames?: Set<number>): number {
  const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let fixed = 0;
  for (let i = 1; i < track.length - 1; i++) {
    const prev = track[i - 1];
    const next = track[i + 1];
    if (d(prev, track[i]) > thresholdM && d(track[i], next) > thresholdM && d(prev, next) < thresholdM) {
      track[i] = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2, (prev[2] + next[2]) / 2];
      frames?.add(i);
      fixed++;
    }
  }
  return fixed;
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; }

function butterworthLowpass(fc: number, fs: number): Biquad {
  const k = Math.tan((Math.PI * fc) / fs);
  const k2 = k * k;
  const a0 = 1 + Math.SQRT2 * k + k2;
  return {
    b0: k2 / a0,
    b1: (2 * k2) / a0,
    b2: k2 / a0,
    a1: (2 * (k2 - 1)) / a0,
    a2: (1 - Math.SQRT2 * k + k2) / a0,
  };
}

function biquadForward(x: number[], q: Biquad): number[] {
  const y = new Array<number>(x.length);
  let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = q.b0 * xi + q.b1 * x1 + q.b2 * x2 - q.a1 * y1 - q.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** Zero-phase filter: forward then backward, so there's no time lag. */
function filtfilt(x: number[], q: Biquad): number[] {
  const fwd = biquadForward(x, q);
  fwd.reverse();
  const back = biquadForward(fwd, q);
  back.reverse();
  return back;
}

function smoothComponents(getN: number, get: (f: number) => number, set: (f: number, v: number) => void, q: Biquad): void {
  const x = new Array<number>(getN);
  for (let f = 0; f < getN; f++) x[f] = get(f);
  const y = filtfilt(x, q);
  for (let f = 0; f < getN; f++) set(f, y[f]);
}

// --- wrist limiting -----------------------------------------------------
// Identity local rotation = T-pose (Warudo records VRM-normalized bones), so
// a Hand bone's local quaternion IS its deviation from neutral. Decompose it
// into twist about the bone's long axis (toward the middle finger) and swing,
// then clamp each to the anatomical range.
const WRIST_TWIST_MAX = 90 * DEG2RAD; // pronation/supination carried at the wrist
const WRIST_SWING_MAX = 85 * DEG2RAD; // flexion/extension + deviation envelope
const FOREARM_TWIST_MAX = 90 * DEG2RAD; // pronation/supination carried at the forearm
const NO_SWING_LIMIT = Math.PI; // swingAngle maxes at π, so this never clamps

function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

// Clamp each frame's local rotation by decomposing into twist about `axis` and
// swing (the remainder), then limiting each to its max. twistMax = 0 hard-locks
// the twist to zero (keeping swing); swingMax = NO_SWING_LIMIT leaves swing free.
function limitTrack(track: Quat[], axis: Vec3, twistMax: number, swingMax: number, frames?: Set<number>): number {
  let clamped = 0;
  const [ax, ay, az] = axis;
  for (let f = 0; f < track.length; f++) {
    const q = track[f];
    // Twist = projection of the rotation onto the bone axis.
    const proj = q[0] * ax + q[1] * ay + q[2] * az;
    let twist: Quat =
      Math.hypot(proj, q[3]) < 1e-9 ? [0, 0, 0, 1] : quatNormalize([ax * proj, ay * proj, az * proj, q[3]]);
    let twistAngle = 2 * Math.atan2(proj, q[3]); // signed, about +axis
    if (twistAngle > Math.PI) twistAngle -= 2 * Math.PI;
    if (twistAngle < -Math.PI) twistAngle += 2 * Math.PI;
    // Swing = remainder.
    const swing = quatMul(q, [-twist[0], -twist[1], -twist[2], twist[3]]);
    const swingAngle = 2 * Math.acos(Math.min(1, Math.abs(swing[3])));

    const twistOver = Math.abs(twistAngle) > twistMax;
    const swingOver = swingAngle > swingMax;
    if (!twistOver && !swingOver) continue;

    if (twistOver) {
      const t = Math.sign(twistAngle) * twistMax;
      const s = Math.sin(t / 2);
      twist = [ax * s, ay * s, az * s, Math.cos(t / 2)];
    }
    const swing2 = swingOver ? quatSlerp([0, 0, 0, 1], swing, swingMax / swingAngle) : swing;
    track[f] = quatNormalize(quatMul(swing2, twist));
    frames?.add(f);
    clamped++;
  }
  return clamped;
}

/** Unit bone axis in the bone's local frame = direction to its named child. */
function boneAxis(c: ConvertedClip, childName: string, fallback: Vec3): Vec3 {
  const child = c.names.indexOf(childName);
  const off = child >= 0 ? c.bindPos[child] : fallback;
  const len = Math.hypot(off[0], off[1], off[2]) || 1;
  return [off[0] / len, off[1] / len, off[2] / len];
}

function limitWrists(c: ConvertedClip, localQuat: Quat[][], frames?: Set<number>): number {
  let clamped = 0;
  for (const side of ["Left", "Right"]) {
    const hand = c.names.indexOf(`${side}Hand`);
    if (hand < 0) continue;
    // Bone axis = direction to the middle finger in the hand's local frame
    // (child bind offsets are already hand-local).
    const axis = boneAxis(c, `${side}MiddleProximal`, [side === "Left" ? 1 : -1, 0, 0]);
    clamped += limitTrack(localQuat[hand], axis, WRIST_TWIST_MAX, WRIST_SWING_MAX, frames);
  }
  return clamped;
}

/**
 * Limit forearm axial twist. `twistMax = 0` locks the twist to zero; swing
 * (elbow bend) is always left free. `sides` selects which forearms to touch.
 */
function limitLowerArms(c: ConvertedClip, localQuat: Quat[][], twistMax: number, sides: readonly string[], frames?: Set<number>): number {
  let clamped = 0;
  for (const side of sides) {
    const fore = c.names.indexOf(`${side}LowerArm`);
    if (fore < 0) continue;
    // Bone axis = direction to the hand (elbow→wrist) in the forearm's frame.
    const axis = boneAxis(c, `${side}Hand`, [side === "Left" ? 1 : -1, 0, 0]);
    clamped += limitTrack(localQuat[fore], axis, twistMax, NO_SWING_LIMIT, frames);
  }
  return clamped;
}

/** A user-applied smoothing pass over one time range. */
export interface RangeSmooth { t0: number; t1: number; cutoffHz: number; }

/**
 * Butterworth-smooth ONLY the frames inside [t0, t1], blending back into the
 * untouched motion over 0.25 s at each edge so there's no seam. Same zero-lag
 * filtfilt as the whole-clip smoother.
 */
export function smoothRange(c: ConvertedClip, r: RangeSmooth): ConvertedClip {
  const frames = c.times.length;
  // r.t0/r.t1 are PLAYBACK time (0-based, from the transport trim); recorded
  // timestamps can start nonzero, so normalize — same invariant as rig keys.
  const off = c.times[0];
  const f0 = c.times.findIndex((t) => t - off >= r.t0 - 0.35);
  let f1 = frames - 1;
  while (f1 > 0 && c.times[f1] - off > r.t1 + 0.35) f1--;
  if (f0 < 0 || f1 - f0 < 8) return c;

  const localQuat = c.localQuat.map((t) => t.map((q) => [...q] as Quat));
  const localPos = c.localPos.map((t) => t.map((p) => [...p] as Vec3));
  const n = f1 - f0 + 1;
  const fs = (n - 1) / Math.max(1e-6, c.times[f1] - c.times[f0]);
  const fc = Math.max(0.5, Math.min(r.cutoffHz, fs / 2 - 0.1));
  const q = butterworthLowpass(fc, fs);
  const BLEND = 0.25;
  const weight = (t: number): number => {
    const inL = Math.min(1, Math.max(0, (t - r.t0) / BLEND + 1));
    const inR = Math.min(1, Math.max(0, (r.t1 - t) / BLEND + 1));
    const w = Math.min(inL, inR);
    return w * w * (3 - 2 * w);
  };

  for (const track of localQuat) {
    let valid = true;
    for (let f = f0; f <= f1; f++) {
      if (Math.hypot(track[f][0], track[f][1], track[f][2], track[f][3]) < 0.5) { valid = false; break; }
    }
    if (!valid) continue;
    for (let comp = 0; comp < 4; comp++) {
      const x = new Array<number>(n);
      for (let i = 0; i < n; i++) x[i] = track[f0 + i][comp];
      const y = filtfilt(x, q);
      for (let i = 0; i < n; i++) {
        const w = weight(c.times[f0 + i] - off);
        track[f0 + i][comp] = x[i] + (y[i] - x[i]) * w;
      }
    }
    for (let f = f0; f <= f1; f++) track[f] = quatNormalize(track[f]);
  }
  const hips = localPos[0];
  for (let comp = 0; comp < 3; comp++) {
    const x = new Array<number>(n);
    for (let i = 0; i < n; i++) x[i] = hips[f0 + i][comp];
    const y = filtfilt(x, q);
    for (let i = 0; i < n; i++) {
      const w = weight(c.times[f0 + i] - off);
      hips[f0 + i][comp] = x[i] + (y[i] - x[i]) * w;
    }
  }
  return { ...c, localQuat, localPos, bindPos: localPos.map((t) => t[0]) };
}

// --- non-destructive scoped filter stack --------------------------------
// A CleanOp is a filter (butterworth / despike / smooth) scoped to a BONE SET
// and a TIME RANGE, applied non-destructively as an ordered list after the
// global cleaning toggles + range smoothing. Every op blends 0.25 s at the
// range edges (smoothRange precedent) so stacking never pops. Zero-norm quats
// are left untouched (safeQuat rule).

export type CleanFilter = "butterworth" | "despike" | "smooth" | "reduce";

export interface CleanOp {
  id: string;
  bones: string[];
  range: { t0: number; t1: number };
  filter: CleanFilter;
  params: { cutoffHz?: number; thresholdDeg?: number; widthFrames?: number; toleranceDeg?: number };
  enabled: boolean;
}

const OP_BLEND = 0.25;

/** Smooth-step blend weight inside [t0,t1], easing over OP_BLEND at each edge. */
function edgeWeight(t: number, t0: number, t1: number): number {
  const inL = Math.min(1, Math.max(0, (t - t0) / OP_BLEND + 1));
  const inR = Math.min(1, Math.max(0, (t1 - t) / OP_BLEND + 1));
  const w = Math.min(inL, inR);
  return w * w * (3 - 2 * w);
}

/** Frame range [f0,f1] covering [t0,t1] plus the blend pad, or null if tiny. */
function rangeFrames(times: number[], t0: number, t1: number): { f0: number; f1: number } | null {
  const off = times[0];
  const f0 = times.findIndex((t) => t - off >= t0 - 0.35);
  let f1 = times.length - 1;
  while (f1 > 0 && times[f1] - off > t1 + 0.35) f1--;
  if (f0 < 0 || f1 - f0 < 4) return null;
  return { f0, f1 };
}

function trackValid(track: Quat[], f0: number, f1: number): boolean {
  for (let f = f0; f <= f1; f++) {
    if (Math.hypot(track[f][0], track[f][1], track[f][2], track[f][3]) < 0.5) return false;
  }
  return true;
}

/** Butterworth filtfilt on one quat track over [f0,f1] with edge blends. */
function butterRange(track: Quat[], times: number[], f0: number, f1: number, cutoffHz: number, t0: number, t1: number): void {
  if (!trackValid(track, f0, f1)) return;
  const off = times[0];
  const n = f1 - f0 + 1;
  const fs = (n - 1) / Math.max(1e-6, times[f1] - times[f0]);
  const fc = Math.max(0.5, Math.min(cutoffHz, fs / 2 - 0.1));
  const q = butterworthLowpass(fc, fs);
  for (let comp = 0; comp < 4; comp++) {
    const x = new Array<number>(n);
    for (let i = 0; i < n; i++) x[i] = track[f0 + i][comp];
    const y = filtfilt(x, q);
    for (let i = 0; i < n; i++) {
      const w = edgeWeight(times[f0 + i] - off, t0, t1);
      track[f0 + i][comp] = x[i] + (y[i] - x[i]) * w;
    }
  }
  for (let f = f0; f <= f1; f++) track[f] = quatNormalize(track[f]);
}

/** Moving-average (box) smoothing on one quat track over [f0,f1] w/ blend. */
function boxRange(track: Quat[], times: number[], f0: number, f1: number, width: number, t0: number, t1: number): void {
  if (!trackValid(track, f0, f1)) return;
  const off = times[0];
  const half = Math.max(1, Math.round(width / 2));
  const src = track.slice(f0, f1 + 1).map((qq) => [...qq] as Quat);
  const n = src.length;
  for (let i = 0; i < n; i++) {
    let ax = 0, ay = 0, az = 0, aw = 0, cnt = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      // Sign-align to the center sample so averaging doesn't cancel.
      const s = src[j];
      const d = s[0] * src[i][0] + s[1] * src[i][1] + s[2] * src[i][2] + s[3] * src[i][3];
      const sgn = d < 0 ? -1 : 1;
      ax += sgn * s[0]; ay += sgn * s[1]; az += sgn * s[2]; aw += sgn * s[3]; cnt++;
    }
    const avg = quatNormalize([ax / cnt, ay / cnt, az / cnt, aw / cnt]);
    const w = edgeWeight(times[f0 + i] - off, t0, t1);
    track[f0 + i] = quatNormalize(quatSlerp(src[i], avg, w));
  }
}

/**
 * Keyframe reduction on a quat track over [f0,f1]: pick the frames the motion
 * actually needs (Douglas-Peucker split until every in-between sits within
 * `tolRad` of the slerp between kept frames), then rewrite the in-betweens AS
 * that slerp. The clip stays dense, but between real poses the motion becomes
 * clean interpolation — micro-jitter drops out and the curves flatten.
 */
function reduceRange(track: Quat[], times: number[], f0: number, f1: number, tolRad: number, t0: number, t1: number): void {
  if (!trackValid(track, f0, f1)) return;
  const off = times[0];
  const src = track.slice(f0, f1 + 1).map((q) => [...q] as Quat);
  const n = src.length;
  const segFrac = (a: number, b: number, i: number) =>
    (times[f0 + i] - times[f0 + a]) / Math.max(1e-9, times[f0 + b] - times[f0 + a]);
  const kept = [0, n - 1];
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    let worst = -1;
    let worstD = tolRad;
    for (let i = a + 1; i < b; i++) {
      const d = angleBetween(quatSlerp(src[a], src[b], segFrac(a, b, i)), src[i]);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) { kept.push(worst); stack.push([a, worst], [worst, b]); }
  }
  kept.sort((x, y) => x - y);
  for (let s = 0; s < kept.length - 1; s++) {
    const a = kept[s], b = kept[s + 1];
    for (let i = a + 1; i < b; i++) {
      const w = edgeWeight(times[f0 + i] - off, t0, t1);
      if (w <= 0) continue; // keep frames outside the blend bit-identical
      const y = quatSlerp(src[a], src[b], segFrac(a, b, i));
      track[f0 + i] = quatNormalize(quatSlerp(src[i], y, w));
    }
  }
}

/** Same reduction for the hips position track (linear, tolerance in meters). */
function reducePosRange(hips: Vec3[], times: number[], f0: number, f1: number, tolM: number, t0: number, t1: number): void {
  const off = times[0];
  const src = hips.slice(f0, f1 + 1).map((p) => [...p] as Vec3);
  const n = src.length;
  const segFrac = (a: number, b: number, i: number) =>
    (times[f0 + i] - times[f0 + a]) / Math.max(1e-9, times[f0 + b] - times[f0 + a]);
  const lerpAt = (a: number, b: number, i: number): Vec3 => {
    const f = segFrac(a, b, i);
    return [src[a][0] + (src[b][0] - src[a][0]) * f, src[a][1] + (src[b][1] - src[a][1]) * f, src[a][2] + (src[b][2] - src[a][2]) * f];
  };
  const kept = [0, n - 1];
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    let worst = -1;
    let worstD = tolM;
    for (let i = a + 1; i < b; i++) {
      const y = lerpAt(a, b, i);
      const d = Math.hypot(y[0] - src[i][0], y[1] - src[i][1], y[2] - src[i][2]);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) { kept.push(worst); stack.push([a, worst], [worst, b]); }
  }
  kept.sort((x, y) => x - y);
  for (let s = 0; s < kept.length - 1; s++) {
    const a = kept[s], b = kept[s + 1];
    for (let i = a + 1; i < b; i++) {
      const w = edgeWeight(times[f0 + i] - off, t0, t1);
      if (w <= 0) continue; // keep frames outside the blend bit-identical
      const y = lerpAt(a, b, i);
      for (let c = 0; c < 3; c++) hips[f0 + i][c] = src[i][c] + (y[c] - src[i][c]) * w;
    }
  }
}

/** Scoped despike over [f0,f1] only. */
function despikeRange(track: Quat[], f0: number, f1: number, thresholdRad: number): void {
  for (let i = Math.max(1, f0); i <= Math.min(track.length - 2, f1); i++) {
    const dPrev = angleBetween(track[i - 1], track[i]);
    const dNext = angleBetween(track[i], track[i + 1]);
    const dSpan = angleBetween(track[i - 1], track[i + 1]);
    if (dPrev > thresholdRad && dNext > thresholdRad && dSpan < thresholdRad) {
      track[i] = quatSlerp(track[i - 1], track[i + 1], 0.5);
    }
  }
}

/** Apply one op's filter to its bone set within its range, in place. */
function applyOpInPlace(times: number[], localQuat: Quat[][], localPos: Vec3[][], names: string[], op: CleanOp): void {
  const fr = rangeFrames(times, op.range.t0, op.range.t1);
  if (!fr) return;
  const { f0, f1 } = fr;
  const { t0, t1 } = op.range;
  for (const bone of op.bones) {
    const bi = names.indexOf(bone);
    if (bi < 0) continue;
    const track = localQuat[bi];
    if (op.filter === "butterworth") butterRange(track, times, f0, f1, op.params.cutoffHz ?? 5, t0, t1);
    else if (op.filter === "smooth") boxRange(track, times, f0, f1, op.params.widthFrames ?? 5, t0, t1);
    else if (op.filter === "reduce") reduceRange(track, times, f0, f1, (op.params.toleranceDeg ?? 1) * DEG2RAD, t0, t1);
    else despikeRange(track, f0, f1, (op.params.thresholdDeg ?? 35) * DEG2RAD);
    // Hips carries root travel — reduce its position track alongside
    // (1° tolerance ≈ 0.5 cm, matching the analysis panel's ratio).
    if (bi === 0 && op.filter === "reduce") {
      reducePosRange(localPos[0], times, f0, f1, (op.params.toleranceDeg ?? 1) * 0.005, t0, t1);
    }
    // Hips carries root travel — filter its position track too.
    if (bi === 0 && (op.filter === "butterworth" || op.filter === "smooth")) {
      const off = times[0];
      const n = f1 - f0 + 1;
      const fs = (n - 1) / Math.max(1e-6, times[f1] - times[f0]);
      const fc = Math.max(0.5, Math.min(op.params.cutoffHz ?? 5, fs / 2 - 0.1));
      const q = butterworthLowpass(fc, fs);
      const hips = localPos[0];
      for (let comp = 0; comp < 3; comp++) {
        const x = new Array<number>(n);
        for (let i = 0; i < n; i++) x[i] = hips[f0 + i][comp];
        const y = filtfilt(x, q);
        for (let i = 0; i < n; i++) {
          const w = edgeWeight(times[f0 + i] - off, t0, t1);
          hips[f0 + i][comp] = x[i] + (y[i] - x[i]) * w;
        }
      }
    }
  }
}

/** Replay the ordered filter stack on a copy of the clip. */
export function applyCleanOps(c: ConvertedClip, ops: CleanOp[]): ConvertedClip {
  const active = ops.filter((o) => o.enabled && o.bones.length);
  if (!active.length) return c;
  const localQuat = c.localQuat.map((t) => t.map((q) => [...q] as Quat));
  const localPos = c.localPos.map((t) => t.map((p) => [...p] as Vec3));
  for (const op of active) applyOpInPlace(c.times, localQuat, localPos, c.names, op);
  return { ...c, localQuat, localPos, bindPos: localPos.map((t) => t[0]) };
}

export function cleanClip(c: ConvertedClip, opts: CleanOpts, stats?: CleanStats): ConvertedClip {
  const frames = c.times.length;
  if (frames < 5) return c;

  // Deep-copy the tracks we mutate.
  const localQuat = c.localQuat.map((t) => t.map((q) => [...q] as Quat));
  const localPos = c.localPos.map((t) => t.map((p) => [...p] as Vec3));

  // Collect which frames each category touched, for the timeline tick marks.
  const marks = stats ? { despike: new Set<number>(), limit: new Set<number>() } : undefined;
  if (stats) stats.fixedFrames = marks;

  if (opts.lockWrists) {
    for (const side of ["Left", "Right"] as const) {
      if (opts.lockWrists !== "both" && opts.lockWrists !== side.toLowerCase()) continue;
      const hand = c.names.indexOf(`${side}Hand`);
      if (hand < 0) continue;
      for (let f = 0; f < frames; f++) localQuat[hand][f] = [0, 0, 0, 1];
    }
  }

  if (opts.limitWrists) {
    const n = limitWrists(c, localQuat, marks?.limit);
    if (stats) stats.wristClamped = n;
  }

  if (opts.limitLowerArms || opts.lockLowerArmTwist) {
    let n = 0;
    if (opts.limitLowerArms) n += limitLowerArms(c, localQuat, FOREARM_TWIST_MAX, ["Left", "Right"], marks?.limit);
    if (opts.lockLowerArmTwist) {
      const sides = opts.lockLowerArmTwist === "both" ? ["Left", "Right"] : [opts.lockLowerArmTwist === "left" ? "Left" : "Right"];
      n += limitLowerArms(c, localQuat, 0, sides, marks?.limit);
    }
    if (stats) stats.forearmClamped = n;
  }

  if (opts.despike) {
    const thr = (opts.despikeDeg ?? 35) * DEG2RAD;
    let n = 0;
    for (const t of localQuat) n += despikeQuats(t, thr, marks?.despike);
    // Hips translation (root motion) pops too — same lone-outlier test.
    n += despikePos(localPos[0], POS_SPIKE_M, marks?.despike);
    if (stats) stats.despiked = n;
  }

  if (opts.smooth) {
    const before = stats ? localQuat.map((t) => t.map((qq) => [...qq] as Quat)) : null;
    const fs = c.duration > 0 ? (frames - 1) / c.duration : 60;
    const fc = Math.max(0.5, Math.min(opts.cutoffHz ?? 7, fs / 2 - 0.1));
    const q = butterworthLowpass(fc, fs);
    // Rotations: filter each quaternion component, then renormalize per frame.
    // Tracks with degenerate frames (zero-norm quats — unused bones like Jaw
    // in some recordings) are left untouched: filtering + normalizing garbage
    // produces NaN/flips (caught by scripts/cleanCheck.mjs).
    for (const t of localQuat) {
      let valid = true;
      for (let f = 0; f < frames; f++) {
        if (Math.hypot(t[f][0], t[f][1], t[f][2], t[f][3]) < 0.5) { valid = false; break; }
      }
      if (!valid) continue;
      for (let comp = 0; comp < 4; comp++) {
        smoothComponents(frames, (f) => t[f][comp], (f, v) => { t[f][comp] = v; }, q);
      }
      for (let f = 0; f < frames; f++) t[f] = quatNormalize(t[f]);
    }
    // Hips translation (root motion) only — other bones are rigid bind offsets.
    const hips = localPos[0];
    for (let comp = 0; comp < 3; comp++) {
      smoothComponents(frames, (f) => hips[f][comp], (f, v) => { hips[f][comp] = v; }, q);
    }
    if (stats && before) {
      let sum = 0, n = 0;
      for (let b = 0; b < localQuat.length; b++) {
        for (let f = 0; f < frames; f++) {
          const d = angleBetween(before[b][f], localQuat[b][f]);
          if (Number.isFinite(d)) { sum += d; n++; }
        }
      }
      stats.smoothedMeanDeg = n ? (sum / n) / DEG2RAD : 0;
    }
  }

  // Feet last: pinning must survive every other filter untouched.
  if (opts.fixFeet) {
    const fs: FeetStats = { spans: 0, frames: 0, maxFixCm: 0 };
    fixFeet(c, localPos, localQuat, fs, opts.feetEdits);
    if (stats) stats.feet = fs;
  }

  return { ...c, localQuat, localPos, bindPos: localPos.map((t) => t[0]) };
}
