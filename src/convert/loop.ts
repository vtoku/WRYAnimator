import type { ConvertedClip } from "./clip.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";
import { quatSlerp, quatNormalize } from "./quat.ts";

// Make loop: turn the trim range [t0, t1] into a clean cycle. Over the last
// blendS seconds each bone's local quat is blended toward its value one
// loop-length earlier — q(t) = slerp(q(t), q(t − loopLen), w(t)) with a
// smoothstep w rising 0→1 toward the loop end — so frame(t1) matches
// frame(t0) in value AND velocity (w' = 0 at both blend edges, so the blend
// adds no velocity discontinuity of its own). Hips local position blends the
// same way; "in-place" additionally subtracts the accumulated root XZ drift
// across the loop as a linear ramp so the seam doesn't teleport.
//
// Applied non-destructively during the display rebuild (after cleanOps,
// before proportions/modifiers/layers). Times are PLAYBACK (0-based) like
// every other range in the pipeline; recordings can start nonzero.

export interface LoopOp {
  t0: number;
  t1: number;
  /** Blend window in seconds before t1 (clamped to half the loop length). */
  blendS: number;
  /** Subtract accumulated root XZ drift so the loop plays in place. */
  inPlace: boolean;
}

const isDegenerate = (q: Quat) => Math.hypot(q[0], q[1], q[2], q[3]) < 0.5;

export function makeLoop(c: ConvertedClip, op: LoopOp): ConvertedClip {
  const frames = c.times.length;
  if (frames < 3) return c;
  const off = c.times[0];
  const t0 = Math.max(0, Math.min(c.duration, op.t0));
  const t1 = Math.max(t0, Math.min(c.duration, op.t1));
  const loopLen = t1 - t0;
  const blend = Math.min(Math.max(0, op.blendS), loopLen / 2);
  if (loopLen < 0.1 || blend < 1e-3) return c;

  // Snapshot for sampling one loop earlier (reads must not see writes).
  const srcQuat = c.localQuat;
  const srcPos = c.localPos;
  const localQuat = c.localQuat.map((tr) => tr.map((q) => [...q] as Quat));
  const localPos = c.localPos.map((tr) => tr.map((p) => [...p] as Vec3));

  /** Segment + fraction for a playback time (binary search on times). */
  const sampleAt = (t: number): { i: number; j: number; frac: number } => {
    const abs = off + t;
    let lo = 0, hi = frames - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c.times[mid] <= abs) lo = mid;
      else hi = mid;
    }
    const span = c.times[hi] - c.times[lo];
    return { i: lo, j: hi, frac: span > 1e-9 ? Math.min(1, Math.max(0, (abs - c.times[lo]) / span)) : 0 };
  };
  const smoothstep = (x: number) => x * x * (3 - 2 * x);
  const hipsAt = (s: { i: number; j: number; frac: number }): Vec3 => {
    const a = srcPos[0][s.i], b = srcPos[0][s.j];
    return [a[0] + (b[0] - a[0]) * s.frac, a[1] + (b[1] - a[1]) * s.frac, a[2] + (b[2] - a[2]) * s.frac];
  };

  // In-place: linear drift ramp over [t0, t1], held at full past t1 so the
  // tail stays continuous with the loop end (export trims it off anyway).
  const pStart = hipsAt(sampleAt(t0));
  const pEnd = hipsAt(sampleAt(t1));
  const drift: Vec3 = op.inPlace ? [pEnd[0] - pStart[0], 0, pEnd[2] - pStart[2]] : [0, 0, 0];
  const rampAt = (t: number) => Math.min(1, Math.max(0, (t - t0) / loopLen));
  if (op.inPlace) {
    for (let f = 0; f < frames; f++) {
      const r = rampAt(c.times[f] - off);
      if (r <= 0) continue;
      localPos[0][f][0] -= drift[0] * r;
      localPos[0][f][2] -= drift[2] * r;
    }
  }

  const bones = c.names.length;
  for (let f = 0; f < frames; f++) {
    const t = c.times[f] - off;
    if (t < t1 - blend - 1e-9 || t > t1 + 1e-9) continue;
    // Saturate slightly before t1 so the final frames ride exactly on the
    // reference cycle — the seam then matches in velocity, not just value.
    const w = smoothstep(Math.min(1, (t - (t1 - blend)) / (blend * 0.95)));
    if (w <= 0) continue;
    const s = sampleAt(t - loopLen);
    for (let b = 0; b < bones; b++) {
      const qa = srcQuat[b][s.i];
      const qb = srcQuat[b][s.j];
      if (isDegenerate(qa) || isDegenerate(qb) || isDegenerate(localQuat[b][f])) continue;
      const ref = quatSlerp(qa, qb, s.frac);
      localQuat[b][f] = quatNormalize(quatSlerp(localQuat[b][f], ref, w));
    }
    // Hips position: same blend; the reference gets the drift ramp of ITS
    // OWN time so in-place blending stays self-consistent.
    const ref = hipsAt(s);
    if (op.inPlace) {
      const r = rampAt(t - loopLen);
      ref[0] -= drift[0] * r;
      ref[2] -= drift[2] * r;
    }
    const cur = localPos[0][f];
    localPos[0][f] = [
      cur[0] + (ref[0] - cur[0]) * w,
      cur[1] + (ref[1] - cur[1]) * w,
      cur[2] + (ref[2] - cur[2]) * w,
    ];
  }

  return { ...c, localQuat, localPos, bindPos: localPos.map((tr) => tr[0]) };
}

/**
 * Scan [t0, t1] for the frame pair (i, j), j − i ≥ minLenS, with the smallest
 * pose distance (sum of per-bone local quat angles + a weighted hips height
 * delta). Downsampled — every `stride`-th frame, widened further on long
 * clips so the O(n²) scan stays a few hundred ms. Pure and synchronous; the
 * caller defers it off the UI thread like a reclean.
 */
export function findLoopPoint(
  c: ConvertedClip,
  t0: number,
  t1: number,
  minLenS = 1,
  stride = 4,
): { t0: number; t1: number; score: number } | null {
  const frames = c.times.length;
  if (frames < 3) return null;
  const off = c.times[0];
  const f0 = c.times.findIndex((t) => t - off >= t0);
  let f1 = frames - 1;
  while (f1 > 0 && c.times[f1] - off > t1) f1--;
  if (f0 < 0 || f1 <= f0) return null;

  // Cap the sample count so worst-case cost is bounded regardless of length.
  const MAX_SAMPLES = 700;
  let step = Math.max(1, stride);
  if ((f1 - f0) / step > MAX_SAMPLES) step = Math.ceil((f1 - f0) / MAX_SAMPLES);
  const samples: number[] = [];
  for (let f = f0; f <= f1; f += step) samples.push(f);
  if (samples.length < 3) return null;

  // Valid (non-degenerate everywhere) bone tracks only; degenerate quats read
  // as identity elsewhere but poison an angle metric.
  const boneIdx: number[] = [];
  for (let b = 0; b < c.names.length; b++) {
    let ok = true;
    for (const f of samples) if (isDegenerate(c.localQuat[b][f])) { ok = false; break; }
    if (ok) boneIdx.push(b);
  }
  if (!boneIdx.length) return null;

  const HEIGHT_W = 5; // rad-equivalent per meter of hips height difference
  let best: { i: number; j: number; score: number } | null = null;
  for (let a = 0; a < samples.length; a++) {
    const fa = samples[a];
    const ta = c.times[fa] - off;
    for (let b2 = a + 1; b2 < samples.length; b2++) {
      const fb = samples[b2];
      if (c.times[fb] - off - ta < minLenS) continue;
      let score = Math.abs(c.localPos[0][fa][1] - c.localPos[0][fb][1]) * HEIGHT_W;
      if (best && score >= best.score) continue; // height alone already loses
      for (const bi of boneIdx) {
        const qa = c.localQuat[bi][fa];
        const qb = c.localQuat[bi][fb];
        const d = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
        score += 2 * Math.acos(Math.min(1, d));
        if (best && score >= best.score) break;
      }
      if (!best || score < best.score) best = { i: fa, j: fb, score };
    }
  }
  if (!best) return null;
  return { t0: c.times[best.i] - off, t1: c.times[best.j] - off, score: best.score };
}
