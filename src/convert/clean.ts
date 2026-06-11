import type { ConvertedClip } from "./clip.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";
import { quatNormalize, quatDot, quatSlerp } from "./quat.ts";

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
}

const DEG2RAD = Math.PI / 180;

function angleBetween(a: Quat, b: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(quatDot(a, b))));
}

function despikeQuats(track: Quat[], thresholdRad: number): void {
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
    }
  }
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

export function cleanClip(c: ConvertedClip, opts: CleanOpts): ConvertedClip {
  const frames = c.times.length;
  if (frames < 5) return c;

  // Deep-copy the tracks we mutate.
  const localQuat = c.localQuat.map((t) => t.map((q) => [...q] as Quat));
  const localPos = c.localPos.map((t) => t.map((p) => [...p] as Vec3));

  if (opts.despike) {
    const thr = (opts.despikeDeg ?? 35) * DEG2RAD;
    for (const t of localQuat) despikeQuats(t, thr);
  }

  if (opts.smooth) {
    const fs = c.duration > 0 ? (frames - 1) / c.duration : 60;
    const fc = Math.max(0.5, Math.min(opts.cutoffHz ?? 7, fs / 2 - 0.1));
    const q = butterworthLowpass(fc, fs);
    // Rotations: filter each quaternion component, then renormalize per frame.
    for (const t of localQuat) {
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
  }

  return { ...c, localQuat, localPos, bindPos: localPos.map((t) => t[0]) };
}
