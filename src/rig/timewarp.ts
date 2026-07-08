import type { ConvertedClip } from "../convert/clip.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";
import { quatSlerp } from "../convert/quat.ts";

// Time warp: a speed ramp over the clip. Warp keys pin a playback speed at a
// SOURCE time; speed interpolates linearly between keys and holds past the
// ends. speed 0.5 = half speed (slow-mo, section takes twice as long),
// 2 = double speed. Output is resampled onto a uniform grid at the source's
// average frame rate, so the rest of the pipeline (cleaning, layers, export)
// sees an ordinary clip — just with a different duration.

export interface WarpKey {
  /** Source-clip time this speed applies at (seconds). */
  time: number;
  /** Playback speed multiplier (0.25 – 4). */
  speed: number;
}

export const anyWarp = (keys: WarpKey[]): boolean =>
  keys.length > 0 && keys.some((k) => Math.abs(k.speed - 1) > 1e-3);

function speedAt(keys: WarpKey[], t: number): number {
  if (!keys.length) return 1;
  if (t <= keys[0].time) return keys[0].speed;
  if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].speed;
  let i = 0;
  while (keys[i + 1].time < t) i++;
  const a = keys[i], b = keys[i + 1];
  const frac = (t - a.time) / Math.max(1e-9, b.time - a.time);
  return a.speed + (b.speed - a.speed) * frac;
}

/**
 * Cumulative OUTPUT time at each source frame: dt_out = dt_src / speed.
 * Warp keys live in 0-based source PLAYBACK time; recorded timestamps can
 * start nonzero, so midpoints are normalized before the speed lookup.
 */
function buildCum(times: number[], keys: WarpKey[]): number[] {
  const t0 = times[0];
  const cum = new Array<number>(times.length);
  cum[0] = 0;
  for (let f = 1; f < times.length; f++) {
    const dt = times[f] - times[f - 1];
    const mid = (times[f] + times[f - 1]) / 2 - t0;
    cum[f] = cum[f - 1] + dt / Math.max(0.05, speedAt(keys, mid));
  }
  return cum;
}

/**
 * Bidirectional mapping between SOURCE playback time and WARPED (output)
 * playback time, both 0-based. This is the exact map applyTimeWarp resamples
 * through — use it to place speed keys from the warped playhead and to remap
 * key/range times when the warp changes.
 */
export function warpMaps(
  times: number[],
  warpKeys: WarpKey[],
): { outOf(srcT: number): number; srcOf(outT: number): number; outDuration: number } {
  const keys = [...warpKeys].sort((a, b) => a.time - b.time);
  const n = times.length;
  const t0 = times[0];
  const srcDuration = n > 1 ? times[n - 1] - t0 : 0;
  if (n < 2 || !anyWarp(keys)) {
    const id = (t: number) => Math.max(0, Math.min(srcDuration, t));
    return { outOf: id, srcOf: id, outDuration: srcDuration };
  }
  const cum = buildCum(times, keys);
  const srcT = (f: number) => times[f] - t0;
  const seg = (arr: number[] | ((f: number) => number), v: number): { lo: number; hi: number } => {
    const at = typeof arr === "function" ? arr : (f: number) => arr[f];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at(mid) <= v) lo = mid;
      else hi = mid;
    }
    return { lo, hi };
  };
  const outOf = (s: number): number => {
    if (s <= 0) return 0;
    if (s >= srcDuration) return cum[n - 1];
    const { lo, hi } = seg(srcT, s);
    const span = srcT(hi) - srcT(lo);
    const frac = span > 1e-12 ? (s - srcT(lo)) / span : 0;
    return cum[lo] + (cum[hi] - cum[lo]) * frac;
  };
  const srcOf = (o: number): number => {
    if (o <= 0) return 0;
    if (o >= cum[n - 1]) return srcDuration;
    const { lo, hi } = seg(cum, o);
    const span = cum[hi] - cum[lo];
    const frac = span > 1e-12 ? (o - cum[lo]) / span : 0;
    return srcT(lo) + (srcT(hi) - srcT(lo)) * frac;
  };
  return { outOf, srcOf, outDuration: cum[n - 1] };
}

/** Resample the clip through the speed ramp (copies; original untouched). */
export function applyTimeWarp(clip: ConvertedClip, warpKeys: WarpKey[]): ConvertedClip {
  const keys = [...warpKeys].sort((a, b) => a.time - b.time);
  if (!anyWarp(keys)) return clip;
  const srcFrames = clip.times.length;
  if (srcFrames < 2) return clip;

  const cum = buildCum(clip.times, keys);
  const outDuration = cum[srcFrames - 1];
  const avgFps = (srcFrames - 1) / Math.max(1e-6, clip.duration);
  const outFrames = Math.max(2, Math.round(outDuration * avgFps) + 1);
  const outDt = outDuration / (outFrames - 1);

  // Invert cum → fractional source frame for each output time.
  const srcAt = (tOut: number): { i: number; frac: number } => {
    let lo = 0, hi = srcFrames - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= tOut) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    return { i: lo, frac: span > 1e-12 ? Math.min(1, Math.max(0, (tOut - cum[lo]) / span)) : 0 };
  };

  const bones = clip.names.length;
  const times = new Array<number>(outFrames);
  const localPos: Vec3[][] = Array.from({ length: bones }, () => new Array(outFrames));
  const localQuat: Quat[][] = Array.from({ length: bones }, () => new Array(outFrames));
  const face = clip.face
    ? { names: clip.face.names.slice(), tracks: clip.face.tracks.map(() => new Float32Array(outFrames)) }
    : null;

  for (let f = 0; f < outFrames; f++) {
    const tOut = f * outDt;
    times[f] = tOut;
    const { i, frac } = srcAt(tOut);
    const j = Math.min(srcFrames - 1, i + 1);
    for (let b = 0; b < bones; b++) {
      const pa = clip.localPos[b][i], pb = clip.localPos[b][j];
      localPos[b][f] = [
        pa[0] + (pb[0] - pa[0]) * frac,
        pa[1] + (pb[1] - pa[1]) * frac,
        pa[2] + (pb[2] - pa[2]) * frac,
      ];
      localQuat[b][f] = quatSlerp(clip.localQuat[b][i], clip.localQuat[b][j], frac);
    }
    if (face && clip.face) {
      for (let n = 0; n < clip.face.tracks.length; n++) {
        const a = clip.face.tracks[n][i];
        const b2 = clip.face.tracks[n][j];
        face.tracks[n][f] = a + (b2 - a) * frac;
      }
    }
  }

  return {
    ...clip,
    times,
    duration: outDuration,
    localPos,
    localQuat,
    bindPos: localPos.map((t) => t[0]),
    face,
  };
}
