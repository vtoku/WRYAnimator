import type { ConvertedClip } from "./clip.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";
import { quatMul, quatRotate } from "./quat.ts";
import { solveTwoBone, vnorm } from "./ik.ts";

// Feet-contact fixing: stops feet sliding while planted (skating) and dipping
// below the floor (penetration). Runs as the LAST cleaning stage so smoothing
// can't re-introduce drift afterwards.
//
// How it works, per foot:
//  1. FK-evaluate the leg chain (hips → upper leg → lower leg → foot → toes)
//     to get world positions per frame. Only rotations are ever written back,
//     so bone lengths and the FBX "rotation curves only" contract are safe.
//  2. Estimate the floor from the data (5th percentile of the foot's lowest
//     point) — the resting joint height varies per avatar, so y=0 can't be
//     assumed.
//  3. Detect contact spans: foot LOW (near the floor) and SLOW (small
//     horizontal velocity), with hysteresis + a minimum duration. A deliberate
//     step is fast, so it breaks the span; slow drift while planted is skating.
//  4. Pin the ankle to its position at the start of each span (blended in/out
//     over ~120 ms) via two-bone IK on the upper/lower leg. The knee stays in
//     its recorded plane (original knee direction = the IK pole); the foot
//     keeps its recorded WORLD orientation so nothing visibly rotates.
//  5. A final pass lifts any frame still below the floor back onto it.

export interface FeetStats {
  /** Contact spans that were pinned. */
  spans: number;
  /** Frames whose leg pose was adjusted. */
  frames: number;
  /** Largest ankle correction applied, cm. */
  maxFixCm: number;
  /** The adjusted frame indices — drives the timeline tick marks. */
  fixedFrames?: number[];
}

// Contact detection tuning (meters, m/s, seconds).
const ENTER_HEIGHT = 0.025; // foot lowest point within 2.5 cm of floor → candidate
const EXIT_HEIGHT = 0.06;   // leaves contact once clearly lifted
const ENTER_SPEED = 0.20;   // horizontal ankle speed below 20 cm/s → planted
const EXIT_SPEED = 0.45;    // a real step is much faster than skating drift
const MIN_SPAN_S = 0.2;     // ignore touch-downs shorter than this
const BLEND_S = 0.12;       // ease the pin in/out to avoid pops

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

interface Chain { hip: number; knee: number; ankle: number; toe: number; }

interface LegPose {
  hipP: Vec3; kneeP: Vec3; ankleP: Vec3; toeP: Vec3;
  thighR: Quat; shinR: Quat; footR: Quat; hipsR: Quat;
}

function legWorld(f: number, ch: Chain, localPos: Vec3[][], localQuat: Quat[][]): LegPose {
  const hipsP = localPos[0][f];
  const hipsR = localQuat[0][f];
  const hipP = add(hipsP, quatRotate(hipsR, localPos[ch.hip][f]));
  const thighR = quatMul(hipsR, localQuat[ch.hip][f]);
  const kneeP = add(hipP, quatRotate(thighR, localPos[ch.knee][f]));
  const shinR = quatMul(thighR, localQuat[ch.knee][f]);
  const ankleP = add(kneeP, quatRotate(shinR, localPos[ch.ankle][f]));
  const footR = quatMul(shinR, localQuat[ch.ankle][f]);
  const toeP = add(ankleP, quatRotate(footR, localPos[ch.toe][f]));
  return { hipP, kneeP, ankleP, toeP, thighR, shinR, footR, hipsR };
}

/**
 * Two-bone IK: move the ankle to `target` by rotating the upper/lower leg,
 * keeping the knee in its recorded plane and the foot's world orientation.
 * Returns the distance actually moved (target may be clamped to leg reach).
 */
function solveLeg(f: number, ch: Chain, target: Vec3, localPos: Vec3[][], localQuat: Quat[][]): number {
  const w = legWorld(f, ch, localPos, localQuat);
  const r = solveTwoBone(
    { parentRot: w.hipsR, rootP: w.hipP, midP: w.kneeP, endP: w.ankleP, rootR: w.thighR, midR: w.shinR, endR: w.footR },
    target,
    vnorm(quatRotate(w.thighR, [0, 0, 1])), // straight-leg fallback: knee forward
  );
  if (!r) return 0;
  localQuat[ch.hip][f] = r.rootLocal;
  localQuat[ch.knee][f] = r.midLocal;
  localQuat[ch.ankle][f] = r.endLocal;
  return r.moved;
}

function percentile(values: number[], p: number): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

interface Span { start: number; end: number; } // [start, end) frame range

function detectSpans(times: number[], lowY: number[], ankle: Vec3[], ground: number): Span[] {
  const frames = times.length;
  // Horizontal ankle speed, box-smoothed ±2 frames to ride over jitter.
  const rawSpeed = new Array<number>(frames).fill(0);
  for (let f = 1; f < frames; f++) {
    const dt = Math.max(1e-4, times[f] - times[f - 1]);
    rawSpeed[f] = Math.hypot(ankle[f][0] - ankle[f - 1][0], ankle[f][2] - ankle[f - 1][2]) / dt;
  }
  const speed = rawSpeed.map((_, f) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) { s += rawSpeed[k]; n++; }
    return s / n;
  });

  const spans: Span[] = [];
  let start = -1;
  for (let f = 0; f <= frames; f++) {
    const inContact =
      f < frames &&
      (start < 0
        ? lowY[f] < ground + ENTER_HEIGHT && speed[f] < ENTER_SPEED
        : lowY[f] < ground + EXIT_HEIGHT && speed[f] < EXIT_SPEED);
    if (inContact) {
      if (start < 0) start = f;
    } else if (start >= 0) {
      if (times[f - 1] - times[start] >= MIN_SPAN_S) spans.push({ start, end: f });
      start = -1;
    }
  }
  return spans;
}

/**
 * Fix feet contacts in-place on the (already copied) localPos/localQuat
 * tracks. Mutates leg-chain rotations only.
 */
export function fixFeet(c: ConvertedClip, localPos: Vec3[][], localQuat: Quat[][], stats?: FeetStats): void {
  const frames = c.times.length;
  const adjusted = new Set<number>(); // frame keys, side-tagged
  let spanCount = 0;
  let maxFix = 0;

  for (const side of ["Left", "Right"]) {
    const ch: Chain = {
      hip: c.names.indexOf(`${side}UpperLeg`),
      knee: c.names.indexOf(`${side}LowerLeg`),
      ankle: c.names.indexOf(`${side}Foot`),
      toe: c.names.indexOf(`${side}Toes`),
    };
    if (ch.hip < 0 || ch.knee < 0 || ch.ankle < 0) continue;
    const hasToe = ch.toe >= 0;

    // FK snapshot of the (post-smoothing) leg.
    const ankle: Vec3[] = new Array(frames);
    const lowY: number[] = new Array(frames);
    for (let f = 0; f < frames; f++) {
      const w = legWorld(f, ch, localPos, localQuat);
      ankle[f] = w.ankleP;
      lowY[f] = hasToe ? Math.min(w.ankleP[1], w.toeP[1]) : w.ankleP[1];
    }
    const ground = percentile(lowY, 0.05);

    // 1. Pin each contact span to where the foot first landed.
    const spans = detectSpans(c.times, lowY, ankle, ground);
    for (const s of spans) {
      // Anchor = mean ankle over the first ~100 ms (settle-in), height from
      // the whole span so brief dips don't set it low.
      let ax = 0, az = 0, n = 0;
      for (let f = s.start; f < s.end && c.times[f] - c.times[s.start] <= 0.1; f++) { ax += ankle[f][0]; az += ankle[f][2]; n++; }
      const ys = [];
      for (let f = s.start; f < s.end; f++) ys.push(ankle[f][1]);
      const anchor: Vec3 = [ax / n, percentile(ys, 0.5), az / n];

      spanCount++;
      const t0 = c.times[s.start], t1 = c.times[s.end - 1];
      for (let f = s.start; f < s.end; f++) {
        const tIn = (c.times[f] - t0) / BLEND_S;
        const tOut = (t1 - c.times[f]) / BLEND_S;
        const wgt = Math.min(1, tIn, tOut);
        if (wgt <= 0) continue;
        const smooth = wgt * wgt * (3 - 2 * wgt); // smoothstep
        const target: Vec3 = [
          ankle[f][0] + (anchor[0] - ankle[f][0]) * smooth,
          ankle[f][1] + (anchor[1] - ankle[f][1]) * smooth,
          ankle[f][2] + (anchor[2] - ankle[f][2]) * smooth,
        ];
        const moved = solveLeg(f, ch, target, localPos, localQuat);
        if (moved > 1e-4) { adjusted.add(f * 2 + (side === "Left" ? 0 : 1)); maxFix = Math.max(maxFix, moved); }
      }
    }

    // 2. Lift anything still below the floor (swing-phase clips, span edges).
    for (let f = 0; f < frames; f++) {
      const w = legWorld(f, ch, localPos, localQuat);
      const low = hasToe ? Math.min(w.ankleP[1], w.toeP[1]) : w.ankleP[1];
      const pen = ground - low;
      if (pen <= 0.001) continue;
      const moved = solveLeg(f, ch, add(w.ankleP, [0, pen, 0]), localPos, localQuat);
      if (moved > 1e-4) { adjusted.add(f * 2 + (side === "Left" ? 0 : 1)); maxFix = Math.max(maxFix, moved); }
    }
  }

  if (stats) {
    stats.spans = spanCount;
    stats.frames = adjusted.size;
    stats.maxFixCm = maxFix * 100;
    // Keys are frame*2+side — decode and dedupe to plain frame indices.
    stats.fixedFrames = [...new Set([...adjusted].map((k) => k >> 1))];
  }
}
