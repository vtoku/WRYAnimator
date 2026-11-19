// scan — find the problems in a take automatically, as a ranked list an agent
// (or the web app's Scan panel) can act on. Pure TS, no DOM.
//
// Every issue is a time RANGE (adjacent bad frames merged) with its peak, how
// that compares to the rest of the take, and a suggested fix expressed as an
// operation of the session API. Times here are PLAYBACK seconds; Session.scan
// shifts them by the session's timeOffset.
import type { Quat, Vec3 } from "../wanim/parse.ts";
import type { ConvertedClip } from "../convert/clip.ts";
import { cleanClip, type CleanStats } from "../convert/clean.ts";
import { worldFromLocal } from "../convert/fk.ts";
import { quatSlerp } from "../convert/quat.ts";
import { type BoneAxes, type Anatomy, decompose, fingerBoneNames } from "./anatomy.ts";

export type ScanKind =
  | "wrist_hyperbend" | "wrist_axis_flip" | "twist_excess"
  | "finger_hyperextension" | "finger_claw" | "finger_splay" | "finger_freeze"
  | "pop" | "jitter" | "foot_slide" | "floor_penetration" | "root_pop";

export interface ScanThresholds {
  /** Wrist flexion range, degrees: [max extension (negative), max flexion]. */
  wristFlex: [number, number];
  /** Wrist deviation range, degrees: [ulnar (negative), radial]. */
  wristDeviation: [number, number];
  /** Total wrist bend (swing) limit, degrees. */
  wristSwingMax: number;
  /** A flip = the bend direction turning more than this many degrees… */
  axisFlipDeg: number;
  /** …within this many seconds… */
  axisFlipWindowS: number;
  /** …while the wrist is bent at least this far at both ends (direction is noise near neutral). */
  axisFlipMinSwingDeg: number;
  /** |hand twist + forearm twist| beyond this is residual candy-wrap. */
  twistTotalMax: number;
  /** Finger segment curl below this (degrees) is hyperextension (thumb excluded). */
  fingerHyperextDeg: number;
  /** Claw = knuckle bent back past this while the two outer joints together curl past clawOuterDeg. */
  clawKnuckleDeg: number;
  clawOuterDeg: number;
  fingerSplayDeg: number;
  /** All fingers of a hand moving less than freezeDeg per frame for this long. */
  fingerFreezeS: number;
  fingerFreezeDeg: number;
  /** Single-frame spike threshold (same test as the despike filter). */
  popDeg: number;
  /** RMS deviation from the neighbours' midpoint over jitterWindowS, degrees. */
  jitterDeg: number;
  jitterWindowS: number;
  footSlideCm: number;
  floorPenetrationCm: number;
  rootPopCm: number;
  /** Bad frames closer together than this merge into one issue. */
  mergeGapS: number;
}

export const DEFAULT_THRESHOLDS: ScanThresholds = {
  // Mocap wrists on VRM avatars routinely read wider than a goniometer would,
  // so the per-axis ranges are generous; total bend (swing) is the main test.
  wristFlex: [-85, 85],
  wristDeviation: [-65, 50],
  wristSwingMax: 85,
  axisFlipDeg: 60,
  axisFlipWindowS: 0.3,
  axisFlipMinSwingDeg: 45,
  twistTotalMax: 140,
  fingerHyperextDeg: -25,
  clawKnuckleDeg: -10,
  clawOuterDeg: 90,
  fingerSplayDeg: 30,
  fingerFreezeS: 2,
  fingerFreezeDeg: 0.02,
  popDeg: 35,
  jitterDeg: 1,
  jitterWindowS: 0.5,
  footSlideCm: 3,
  floorPenetrationCm: 2,
  rootPopCm: 5,
  mergeGapS: 0.15,
};

export interface ScanOpts {
  /** Playback-time window; issues overlapping it are returned. */
  t0?: number;
  t1?: number;
  /** Only issues involving these bone indexes. */
  bones?: number[];
  kinds?: ScanKind[];
  thresholds?: Partial<ScanThresholds>;
  /** Max issues returned (highest severity first). Default 50. */
  max?: number;
}

export interface ScanIssue {
  kind: ScanKind;
  side: "Left" | "Right" | null;
  bones: string[];
  tStart: number;
  tEnd: number;
  frameStart: number;
  frameEnd: number;
  peakTime: number;
  /** The measured quantity at its worst, in `unit`. */
  peakValue: number;
  measure: string;
  unit: string;
  /** Where the same measure sits across the WHOLE take: 1st / 50th / 99th percentile. */
  takeRange: { p1: number; p50: number; p99: number } | null;
  /** The limit it broke (a [min, max] range or a single bound), or null. */
  humanLimit: number | [number, number] | null;
  /** 0 = at the threshold; 1 ≈ twice as far out as the threshold allows. Higher is worse. */
  severity: number;
  detail: string;
  /** A session-API operation that addresses it, or null when there is no safe automatic fix. */
  suggestedFix: Record<string, unknown> | null;
}

const DEG = 180 / Math.PI;
const r = (v: number, d = 2): number => { const k = 10 ** d; return Math.round(v * k) / k; };
const isDead = (q: Quat): boolean => q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] < 0.25;
const angleDeg = (a: Quat, b: Quat): number =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * DEG;

function percentiles(values: ArrayLike<number>): { p1: number; p50: number; p99: number } {
  const s = Float64Array.from(values as ArrayLike<number>).sort();
  const at = (p: number): number => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : 0);
  return { p1: r(at(0.01)), p50: r(at(0.5)), p99: r(at(0.99)) };
}

/** Merge flagged frames into [f0, f1] runs, bridging gaps shorter than gapS. */
function runs(flag: Uint8Array, times: number[], gapS: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  let last = -1;
  for (let f = 0; f < flag.length; f++) {
    if (!flag[f]) continue;
    if (start >= 0 && times[f] - times[last] > gapS) { out.push([start, last]); start = -1; }
    if (start < 0) start = f;
    last = f;
  }
  if (start >= 0) out.push([start, last]);
  return out;
}

export function scanClip(clip: ConvertedClip, opts: ScanOpts, axesOf: (bone: number) => BoneAxes): ScanIssue[] {
  const th: ScanThresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const F = clip.times.length;
  const off = clip.times[0] ?? 0;
  const T = clip.times.map((t) => t - off);
  const idx = (n: string): number => clip.names.indexOf(n);
  const want = (k: ScanKind): boolean => !opts.kinds || opts.kinds.includes(k);
  const issues: ScanIssue[] = [];
  if (F < 3) return issues;

  const push = (
    kind: ScanKind, side: "Left" | "Right" | null, bones: string[], f0: number, f1: number, peakF: number,
    peakValue: number, measure: string, unit: string, take: ArrayLike<number> | null,
    humanLimit: ScanIssue["humanLimit"], severity: number, detail: string, fix: Record<string, unknown> | null,
  ): void => {
    issues.push({
      kind, side, bones, tStart: r(T[f0], 4), tEnd: r(T[f1], 4), frameStart: f0, frameEnd: f1,
      peakTime: r(T[peakF], 4), peakValue: r(peakValue), measure, unit,
      takeRange: take ? percentiles(take) : null, humanLimit, severity: r(Math.max(0, severity), 3), detail, suggestedFix: fix,
    });
  };
  const anatomyTrack = (bone: number): Anatomy[] => {
    const ax = axesOf(bone);
    return clip.localQuat[bone].map((q) => decompose(ax, q));
  };
  const pad = (f0: number, f1: number, s: number): { t0: number; t1: number } =>
    ({ t0: r(Math.max(0, T[f0] - s), 4), t1: r(Math.min(T[F - 1], T[f1] + s), 4) });

  // ---- wrists ------------------------------------------------------------------
  for (const side of ["Left", "Right"] as const) {
    const hand = idx(`${side}Hand`);
    if (hand < 0 || isDead(clip.localQuat[hand][0])) continue;
    const an = anatomyTrack(hand);
    const flex = an.map((a) => a.flex);
    const dev = an.map((a) => a.deviation);
    const swing = an.map((a) => a.swing);

    if (want("wrist_hyperbend")) {
      // Degrees past its limit, per measure. Total bend ("swing") is the
      // headline: it is what reads as "bent back unnaturally" whatever the axis.
      const over = (f: number): { m: string; v: number; x: number; lim: [number, number] | number } => {
        const c: Array<{ m: string; v: number; x: number; lim: [number, number] | number }> = [
          { m: "swing", v: swing[f], x: swing[f] - th.wristSwingMax, lim: th.wristSwingMax },
          { m: "flex", v: flex[f], x: Math.max(flex[f] - th.wristFlex[1], th.wristFlex[0] - flex[f]), lim: th.wristFlex },
          { m: "deviation", v: dev[f], x: Math.max(dev[f] - th.wristDeviation[1], th.wristDeviation[0] - dev[f]), lim: th.wristDeviation },
        ];
        return c.reduce((a, b) => (b.x > a.x ? b : a));
      };
      const flag = new Uint8Array(F);
      for (let f = 0; f < F; f++) if (over(f).x > 0) flag[f] = 1;
      for (const [f0, f1] of runs(flag, T, th.mergeGapS)) {
        let peak = f0;
        for (let f = f0; f <= f1; f++) if (over(f).x > over(peak).x) peak = f;
        const o = over(peak);
        const take = o.m === "flex" ? flex : o.m === "deviation" ? dev : swing;
        push("wrist_hyperbend", side, [`${side}Hand`], f0, f1, peak, o.v, o.m, "deg", take, o.lim, o.x / 15,
          `${side} wrist ${o.m === "swing" ? "total bend" : o.m} ${r(o.v, 1)}° at its worst ` +
          `(flex ${r(flex[peak], 1)}°, deviation ${r(dev[peak], 1)}°, total bend ${r(swing[peak], 1)}°)`,
          { op: "limit.apply", bones: [`${side}Hand`], ...pad(f0, f1, 0.1), limits: { flex: [-70, 70], deviation: [-40, 30] }, softness: 8, blend: 0.25 });
      }
    }

    if (want("wrist_axis_flip")) {
      // Direction of the bend in the (flex, deviation) plane; a tracking flip
      // swaps it to another axis within a few frames while staying bent.
      const flag = new Uint8Array(F);
      const turn = new Float32Array(F);
      const dirDiff = (a: number, b: number): number => {
        const d = Math.abs(Math.atan2(dev[a], flex[a]) - Math.atan2(dev[b], flex[b])) * DEG;
        return d > 180 ? 360 - d : d;
      };
      for (let f = 0; f < F; f++) {
        if (swing[f] < th.axisFlipMinSwingDeg) continue;
        for (let g = f + 1; g < F && T[g] - T[f] <= th.axisFlipWindowS; g++) {
          // The wrist must STAY bent the whole way: a real motion that changes
          // direction passes through neutral; a tracking flip does not.
          if (swing[g] < th.axisFlipMinSwingDeg) break;
          const d = dirDiff(f, g);
          if (d > th.axisFlipDeg) {
            for (let k = f; k <= g; k++) { flag[k] = 1; if (d > turn[k]) turn[k] = d; }
          }
        }
      }
      for (const [f0, f1] of runs(flag, T, th.mergeGapS)) {
        let peak = f0;
        for (let f = f0; f <= f1; f++) if (turn[f] > turn[peak]) peak = f;
        // A clean pose to hold from: the last frame before the flip that is inside the limits.
        let donor = f0;
        for (let f = f0 - 1; f >= 0 && T[f0] - T[f] < 1; f--) {
          donor = f;
          if (swing[f] < th.wristSwingMax * 0.8 && T[f0] - T[f] >= 0.1) break;
        }
        push("wrist_axis_flip", side, [`${side}Hand`], f0, f1, peak, turn[peak], "bend direction change", "deg",
          null, th.axisFlipDeg, (turn[peak] - th.axisFlipDeg) / th.axisFlipDeg + 0.5,
          `${side} wrist bend direction turns ${r(turn[peak], 0)}° within ${th.axisFlipWindowS} s ` +
          `(flex/deviation ${r(flex[f0], 0)}°/${r(dev[f0], 0)}° → ${r(flex[f1], 0)}°/${r(dev[f1], 0)}°) — a tracking flip`,
          { op: "hold.insert", bones: [`${side}Hand`], donorTime: r(T[donor], 4), ...pad(f0, f1, 0.05), blendIn: 0.15, blendOut: 0.15 });
      }
    }

    if (want("twist_excess")) {
      const fore = idx(`${side}LowerArm`);
      const foreTw = fore >= 0 && !isDead(clip.localQuat[fore][0]) ? anatomyTrack(fore).map((a) => a.twist) : null;
      const total = an.map((a, f) => a.twist + (foreTw ? foreTw[f] : 0));
      const flag = new Uint8Array(F);
      for (let f = 0; f < F; f++) if (Math.abs(total[f]) > th.twistTotalMax) flag[f] = 1;
      for (const [f0, f1] of runs(flag, T, th.mergeGapS)) {
        let peak = f0;
        for (let f = f0; f <= f1; f++) if (Math.abs(total[f]) > Math.abs(total[peak])) peak = f;
        push("twist_excess", side, [`${side}Hand`, `${side}LowerArm`], f0, f1, peak, total[peak], "hand + forearm twist", "deg",
          total, [-th.twistTotalMax, th.twistTotalMax], (Math.abs(total[peak]) - th.twistTotalMax) / th.twistTotalMax * 4,
          `${side} hand + forearm roll ${r(total[peak], 0)}° (hand ${r(an[peak].twist, 0)}°, forearm ${r(foreTw ? foreTw[peak] : 0, 0)}°)`,
          { op: "limit.apply", bones: [`${side}Hand`], ...pad(f0, f1, 0.1), limits: { twist: [-80, 80] }, softness: 8, blend: 0.3 });
      }
    }
  }

  // ---- fingers -----------------------------------------------------------------
  for (const side of ["Left", "Right"] as const) {
    const names = fingerBoneNames(side);
    const bones = names.map(idx);
    if (bones.some((b) => b < 0) || bones.every((b) => isDead(clip.localQuat[b][0]))) continue;
    const an = bones.map((b) => (isDead(clip.localQuat[b][0]) ? null : anatomyTrack(b)));
    const fingerFix = (f0: number, f1: number, involved: string[]): Record<string, unknown> =>
      ({ op: "limit.apply", bones: involved, ...pad(f0, f1, 0.1), softness: 5, blend: 0.2 });

    const report = (kind: ScanKind, value: (seg: number, f: number) => number | null, measure: string, limit: ScanIssue["humanLimit"], sev: (v: number) => number, word: string): void => {
      if (!want(kind)) return;
      const flag = new Uint8Array(F);
      const worstSeg = new Int16Array(F).fill(-1);
      const worst = new Float32Array(F);
      for (let f = 0; f < F; f++) {
        for (let s = 0; s < bones.length; s++) {
          const v = value(s, f);
          if (v === null) continue;
          const sv = sev(v);
          if (sv > 0 && (worstSeg[f] < 0 || sv > sev(worst[f]))) { worstSeg[f] = s; worst[f] = v; flag[f] = 1; }
        }
      }
      for (const [f0, f1] of runs(flag, T, th.mergeGapS)) {
        let peak = f0;
        const involved = new Set<string>();
        for (let f = f0; f <= f1; f++) {
          if (worstSeg[f] < 0) continue;
          for (let s = 0; s < bones.length; s++) { const v = value(s, f); if (v !== null && sev(v) > 0) involved.add(names[s]); }
          if (worstSeg[peak] < 0 || sev(worst[f]) > sev(worst[peak])) peak = f;
        }
        const seg = worstSeg[peak];
        const take: number[] = [];
        for (let f = 0; f < F; f++) { const v = value(seg, f); if (v !== null) take.push(v); }
        push(kind, side, [...involved], f0, f1, peak, worst[peak], measure, "deg", take, limit, sev(worst[peak]),
          `${names[seg]} ${word} ${r(worst[peak], 0)}°${involved.size > 1 ? ` (+${involved.size - 1} more finger bone(s))` : ""}`,
          fingerFix(f0, f1, [...involved]));
      }
    };

    report("finger_hyperextension",
      // Not the thumb (the first three bones): its curl axis is only approximate.
      (s, f) => (s >= 3 && an[s] ? an[s]![f].flex : null), "curl", th.fingerHyperextDeg,
      (v) => (th.fingerHyperextDeg - v) / 30,
      "curl");
    report("finger_splay",
      (s, f) => (s >= 3 && s % 3 === 0 && an[s] ? an[s]![f].deviation : null), "splay", [-th.fingerSplayDeg, th.fingerSplayDeg],
      (v) => (Math.abs(v) - th.fingerSplayDeg) / 30,
      "splay");

    if (want("finger_claw")) {
      // Per finger (not the thumb): knuckle bent back while the outer joints curl hard.
      const flag = new Uint8Array(F);
      const score = new Float32Array(F);
      const who = new Int16Array(F).fill(-1);
      for (let f = 0; f < F; f++) {
        for (let fi = 1; fi < 5; fi++) {
          const p = an[fi * 3], m = an[fi * 3 + 1], d = an[fi * 3 + 2];
          if (!p || !m || !d) continue;
          const knuckle = p[f].flex;
          const outer = m[f].flex + d[f].flex;
          if (knuckle < th.clawKnuckleDeg && outer > th.clawOuterDeg) {
            const sc = (th.clawKnuckleDeg - knuckle) / 30 + (outer - th.clawOuterDeg) / 90;
            if (sc > score[f]) { score[f] = sc; who[f] = fi; }
            flag[f] = 1;
          }
        }
      }
      for (const [f0, f1] of runs(flag, T, th.mergeGapS)) {
        let peak = f0;
        const involved = new Set<string>();
        for (let f = f0; f <= f1; f++) {
          if (who[f] < 0) continue;
          for (let k = 0; k < 3; k++) involved.add(names[who[f] * 3 + k]);
          if (score[f] > score[peak]) peak = f;
        }
        const fi = who[peak];
        if (fi < 0) continue;
        const knuckle = an[fi * 3]!.map((a) => a.flex);
        push("finger_claw", side, [...involved], f0, f1, peak, knuckle[peak], "knuckle curl", "deg", knuckle, th.clawKnuckleDeg, score[peak],
          `${names[fi * 3].replace("Proximal", "")} clawed: knuckle ${r(knuckle[peak], 0)}° with outer joints curled ${r(an[fi * 3 + 1]![peak].flex + an[fi * 3 + 2]![peak].flex, 0)}°`,
          fingerFix(f0, f1, [...involved]));
      }
    }

    if (want("finger_freeze")) {
      const flag = new Uint8Array(F);
      for (let f = 1; f < F; f++) {
        let moving = false;
        for (const b of bones) {
          const tr = clip.localQuat[b];
          if (isDead(tr[f])) continue;
          if (angleDeg(tr[f - 1], tr[f]) > th.fingerFreezeDeg) { moving = true; break; }
        }
        if (!moving) flag[f] = 1;
      }
      for (const [f0, f1] of runs(flag, T, 0.03)) {
        const dur = T[f1] - T[f0];
        if (dur < th.fingerFreezeS) continue;
        push("finger_freeze", side, [`${side}Fingers`], f0, f1, f0, r(dur), "frozen duration", "s", null, th.fingerFreezeS, Math.min(1, dur / 10) * 0.5,
          `${side} fingers do not move at all for ${r(dur, 1)} s (finger tracking likely dropped)`, null);
      }
    }
  }

  // ---- pops and jitter (per bone, merged across bones) -----------------------------
  const live = clip.names.map((_, b) => b).filter((b) => !clip.localQuat[b].some(isDead));
  if (want("pop")) {
    const flag = new Uint8Array(F);
    const size = new Float32Array(F);
    const who: string[][] = [];
    for (const b of live) {
      const tr = clip.localQuat[b];
      for (let f = 1; f < F - 1; f++) {
        const dp = angleDeg(tr[f - 1], tr[f]);
        const dn = angleDeg(tr[f], tr[f + 1]);
        if (dp > th.popDeg && dn > th.popDeg && angleDeg(tr[f - 1], tr[f + 1]) < th.popDeg) {
          flag[f] = 1;
          size[f] = Math.max(size[f], Math.min(dp, dn));
          (who[f] ??= []).push(clip.names[b]);
        }
      }
    }
    for (const [f0, f1] of runs(flag, T, 0.05)) {
      let peak = f0;
      const involved = new Set<string>();
      for (let f = f0; f <= f1; f++) { (who[f] ?? []).forEach((n) => involved.add(n)); if (size[f] > size[peak]) peak = f; }
      push("pop", null, [...involved], f0, f1, peak, size[peak], "single-frame jump", "deg", null, th.popDeg, size[peak] / th.popDeg - 0.5,
        `single-frame pop of ${r(size[peak], 0)}° on ${[...involved].slice(0, 4).join(", ")}${involved.size > 4 ? ` +${involved.size - 4}` : ""}`,
        { op: "filter.add", kind: "despike", bones: [...involved], ...pad(f0, f1, 0.1), params: { thresholdDeg: th.popDeg } });
    }
  }

  if (want("jitter")) {
    const fps = (F - 1) / Math.max(1e-6, T[F - 1]);
    const half = Math.max(2, Math.round((th.jitterWindowS * fps) / 2));
    for (const b of live) {
      const tr = clip.localQuat[b];
      // High-frequency content: how far each frame sits from its neighbours' midpoint.
      const sq = new Float64Array(F + 1);
      for (let f = 1; f < F - 1; f++) {
        const d = angleDeg(tr[f], quatSlerp(tr[f - 1], tr[f + 1], 0.5));
        sq[f + 1] = sq[f] + d * d;
      }
      sq[F] = sq[F - 1];
      const flag = new Uint8Array(F);
      const rms = new Float32Array(F);
      for (let f = half; f < F - half; f++) {
        rms[f] = Math.sqrt((sq[f + half + 1] - sq[f - half]) / (2 * half + 1));
        if (rms[f] > th.jitterDeg) flag[f] = 1;
      }
      for (const [f0, f1] of runs(flag, T, th.mergeGapS)) {
        let peak = f0;
        for (let f = f0; f <= f1; f++) if (rms[f] > rms[peak]) peak = f;
        push("jitter", null, [clip.names[b]], f0, f1, peak, rms[peak], "high-frequency RMS", "deg", rms, th.jitterDeg, (rms[peak] / th.jitterDeg - 1) * 0.5,
          `${clip.names[b]} jitters ±${r(rms[peak], 1)}° (frame-to-frame noise) for ${r(T[f1] - T[f0], 2)} s`,
          { op: "filter.add", kind: "butterworth", bones: [clip.names[b]], ...pad(f0, f1, 0.15), params: { cutoffHz: 6 } });
      }
    }
  }

  // ---- feet and root -----------------------------------------------------------
  const wantFeet = want("foot_slide") || want("floor_penetration");
  if (wantFeet || want("root_pop")) {
    const feet = (["Left", "Right"] as const).map((side) => ({ side, bone: idx(`${side}Foot`) })).filter((x) => x.bone >= 0);
    const world: Vec3[][] = feet.map(() => new Array<Vec3>(F));
    if (wantFeet && feet.length) {
      for (let f = 0; f < F; f++) {
        const w = worldFromLocal(clip.parents, { pos: clip.localPos.map((t) => t[f]), quat: clip.localQuat.map((t) => t[f]) });
        feet.forEach((ft, i) => { world[i][f] = w.pos[ft.bone]; });
      }
    }
    if (want("floor_penetration")) {
      feet.forEach((ft, i) => {
        const y = world[i].map((p) => p[1]);
        // The floor is where this foot rests: its 5th-percentile height.
        const sorted = Float64Array.from(y).sort();
        const floor = sorted[Math.floor(sorted.length * 0.05)];
        const flag = new Uint8Array(F);
        for (let f = 0; f < F; f++) if ((floor - y[f]) * 100 > th.floorPenetrationCm) flag[f] = 1;
        for (const [f0, f1] of runs(flag, T, th.mergeGapS)) {
          let peak = f0;
          for (let f = f0; f <= f1; f++) if (y[f] < y[peak]) peak = f;
          const cm = (floor - y[peak]) * 100;
          push("floor_penetration", ft.side, [`${ft.side}Foot`], f0, f1, peak, cm, "depth below resting floor", "cm", null, th.floorPenetrationCm,
            cm / th.floorPenetrationCm - 1, `${ft.side} foot dips ${r(cm, 1)} cm below its resting floor height`,
            { op: "export", note: "whole-clip feet fix: `wry convert --fix-feet` (resampled output) or the editor's Fix feet toggle; there is no scoped feet operation yet" });
        }
      });
    }
    if (want("foot_slide") && feet.length) {
      const stats: CleanStats = { despiked: 0, wristClamped: 0, forearmClamped: 0, smoothedMeanDeg: 0 };
      cleanClip(clip, { fixFeet: true }, stats);
      for (const p of stats.feet?.plants ?? []) {
        const i = feet.findIndex((ft) => ft.side === p.side);
        if (i < 0) continue;
        let f0 = 0;
        while (f0 < F - 1 && T[f0] < p.t0) f0++;
        let f1 = f0;
        while (f1 < F - 1 && T[f1 + 1] <= p.t1) f1++;
        const a = world[i][f0];
        let peak = f0;
        let far = 0;
        for (let f = f0; f <= f1; f++) {
          const d = Math.hypot(world[i][f][0] - a[0], world[i][f][2] - a[2]) * 100;
          if (d > far) { far = d; peak = f; }
        }
        if (far > th.footSlideCm) {
          push("foot_slide", p.side, [`${p.side}Foot`], f0, f1, peak, far, "drift while planted", "cm", null, th.footSlideCm, far / th.footSlideCm - 1,
            `${p.side} foot slides ${r(far, 1)} cm during a ${r(T[f1] - T[f0], 2)} s plant`,
            { op: "export", note: "whole-clip feet fix: `wry convert --fix-feet` (resampled output) or the editor's Fix feet toggle; there is no scoped feet operation yet" });
        }
      }
    }
    if (want("root_pop")) {
      const hips = clip.localPos[0];
      const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100;
      const flag = new Uint8Array(F);
      const size = new Float32Array(F);
      for (let f = 1; f < F - 1; f++) {
        const dp = dist(hips[f - 1], hips[f]);
        const dn = dist(hips[f], hips[f + 1]);
        if (dp > th.rootPopCm && dn > th.rootPopCm && dist(hips[f - 1], hips[f + 1]) < th.rootPopCm) { flag[f] = 1; size[f] = Math.min(dp, dn); }
      }
      for (const [f0, f1] of runs(flag, T, 0.05)) {
        let peak = f0;
        for (let f = f0; f <= f1; f++) if (size[f] > size[peak]) peak = f;
        push("root_pop", null, ["Hips"], f0, f1, peak, size[peak], "single-frame root jump", "cm", null, th.rootPopCm, size[peak] / th.rootPopCm - 0.5,
          `hips jump ${r(size[peak], 1)} cm for one frame and snap back`,
          { op: "filter.add", kind: "butterworth", bones: ["Hips"], ...pad(f0, f1, 0.1), params: { cutoffHz: 8 } });
      }
    }
  }

  // ---- filter, rank, cap ---------------------------------------------------------
  const t0 = opts.t0 ?? -Infinity;
  const t1 = opts.t1 ?? Infinity;
  const boneNames = opts.bones ? new Set(opts.bones.map((b) => clip.names[b])) : null;
  const expand = (n: string): string[] => {
    const g = /^(Left|Right)Fingers$/.exec(n);
    return g ? fingerBoneNames(g[1] as "Left" | "Right") : [n];
  };
  return issues
    .filter((i) => i.tEnd >= t0 - 1e-9 && i.tStart <= t1 + 1e-9)
    .filter((i) => !boneNames || i.bones.flatMap(expand).some((n) => boneNames.has(n)))
    .sort((a, b) => b.severity - a.severity || a.tStart - b.tStart)
    .slice(0, opts.max ?? 50);
}
