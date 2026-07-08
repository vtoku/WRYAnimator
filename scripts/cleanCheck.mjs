// Verifies the cleaning filters actually work on real motion data:
//  - despike: a synthetic 1-frame pop injected into a wrist track must be removed
//  - butterworth: smoothness (RMS of 2nd differences of joint angle) must drop,
//    while max deviation from the original stays bounded (no gross distortion)
//  - wrist limit: post-clean wrist twist/swing must be inside the human range
// Usage: node scripts/cleanCheck.mjs [file.wanim]
import { readFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter } = await import("../src/convert/clip.ts");
const { cleanClip } = await import("../src/convert/clean.ts");

const path = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim";
const buf = readFileSync(path);
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const c = convertCharacter(clip, 0);
const frames = c.times.length;
console.log(`clip: ${frames} frames, ${c.duration.toFixed(1)}s`);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b)))) * (180 / Math.PI);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  if (!ok) failures++;
};

// --- 1. despike removes an injected pop -----------------------------------
{
  const hand = c.names.indexOf("RightHand");
  const f = Math.floor(frames / 2);
  const injected = structuredClone(c);
  // 90° flip about X for exactly one frame.
  const s = Math.sin(Math.PI / 4), w = Math.cos(Math.PI / 4);
  const q = injected.localQuat[hand][f];
  injected.localQuat[hand][f] = [
    w * q[0] + s * q[3], w * q[1] - s * q[2], w * q[2] + s * q[1], w * q[3] - s * q[0],
  ];
  const popBefore = angle(injected.localQuat[hand][f], c.localQuat[hand][f]);
  const cleaned = cleanClip(injected, { despike: true, despikeDeg: 35 });
  const popAfter = angle(cleaned.localQuat[hand][f], c.localQuat[hand][f]);
  check("despike: injected 1-frame 90° wrist pop removed",
    popBefore > 80 && popAfter < 10,
    `before=${popBefore.toFixed(1)}° after=${popAfter.toFixed(1)}°`);
}

// --- 2. butterworth smooths without distorting -----------------------------
{
  const smoothness = (track) => {
    let sum = 0;
    for (let f = 1; f < track.length - 1; f++) {
      const d = angle(track[f - 1], track[f]) - angle(track[f], track[f + 1]);
      sum += d * d;
    }
    return Math.sqrt(sum / (track.length - 2));
  };
  const cleaned = cleanClip(c, { smooth: true, cutoffHz: 7 });
  let beforeAvg = 0, afterAvg = 0, maxDev = 0, n = 0;
  for (let b = 0; b < c.names.length; b++) {
    // Skip degenerate (zero-norm) tracks — unused bones in some recordings;
    // the angle metric is meaningless there and the filter leaves them alone.
    if (c.localQuat[b].some((q) => Math.hypot(...q) < 0.5)) continue;
    beforeAvg += smoothness(c.localQuat[b]);
    afterAvg += smoothness(cleaned.localQuat[b]);
    for (let f = 0; f < frames; f++) maxDev = Math.max(maxDev, angle(c.localQuat[b][f], cleaned.localQuat[b][f]));
    n++;
  }
  beforeAvg /= n; afterAvg /= n;
  check("butterworth: smoothness improves (RMS 2nd-diff of angle drops)",
    afterAvg < beforeAvg * 0.8,
    `before=${beforeAvg.toFixed(4)} after=${afterAvg.toFixed(4)} (${((1 - afterAvg / beforeAvg) * 100).toFixed(0)}% less jitter)`);
  // Momentary deviation up to ~35° is the filter legitimately attenuating
  // fast whips at 7Hz; gross corruption (NaN/sign flips) shows as 90-180°.
  check("butterworth: no gross distortion", maxDev < 45, `max deviation=${maxDev.toFixed(1)}°`);

  // Zero-phase: the filtered hips X track must not lag the original.
  const hips = 0;
  const xs = c.localPos[hips].map((p) => p[0]);
  const ys = cleaned.localPos[hips].map((p) => p[0]);
  let best = 0, bestLag = 0;
  for (let lag = -5; lag <= 5; lag++) {
    let s2 = 0;
    for (let f = Math.max(0, -lag); f < frames - Math.max(0, lag); f++) s2 += xs[f + lag] * ys[f];
    if (s2 > best) { best = s2; bestLag = lag; }
  }
  check("butterworth: zero phase (no lag on hips track)", bestLag === 0, `best correlation at lag=${bestLag}`);
}

// --- 3. wrist limit clamps to human range ----------------------------------
{
  const cleaned = cleanClip(c, { limitWrists: true });
  let worstTwist = 0, worstSwing = 0, clamped = 0;
  for (const side of ["Left", "Right"]) {
    const hand = c.names.indexOf(`${side}Hand`);
    const mid = c.names.indexOf(`${side}MiddleProximal`);
    const off = c.bindPos[mid];
    const len = Math.hypot(...off);
    const ax = off.map((v) => v / len);
    for (let f = 0; f < frames; f++) {
      const q = cleaned.localQuat[hand][f];
      const proj = q[0] * ax[0] + q[1] * ax[1] + q[2] * ax[2];
      let tw = Math.abs(2 * Math.atan2(proj, q[3]));
      if (tw > Math.PI) tw = 2 * Math.PI - tw;
      // swing = q * conj(twist); |w| gives the swing angle
      const tn = Math.hypot(ax[0] * proj, ax[1] * proj, ax[2] * proj, q[3]) || 1;
      const t = [ax[0] * proj / tn, ax[1] * proj / tn, ax[2] * proj / tn, q[3] / tn];
      const sw = Math.abs(t[3] * q[3] + t[0] * q[0] + t[1] * q[1] + t[2] * q[2]);
      const swingA = 2 * Math.acos(Math.min(1, sw));
      worstTwist = Math.max(worstTwist, tw);
      worstSwing = Math.max(worstSwing, swingA);
      if (angle(cleaned.localQuat[hand][f], c.localQuat[hand][f]) > 0.5) clamped++;
    }
  }
  const deg = 180 / Math.PI;
  check("wrist limit: twist within ±90°+ε", worstTwist * deg < 91, `worst twist=${(worstTwist * deg).toFixed(1)}°`);
  check("wrist limit: swing within 85°+ε", worstSwing * deg < 86, `worst swing=${(worstSwing * deg).toFixed(1)}°`);
  console.log(`      (clamped ${clamped} of ${frames * 2} wrist frames in this recording)`);
}

// --- 4. forearm twist limit clamps pronation/supination --------------------
{
  const deg = 180 / Math.PI;
  const twistOf = (q, ax) => {
    const proj = q[0] * ax[0] + q[1] * ax[1] + q[2] * ax[2];
    let tw = Math.abs(2 * Math.atan2(proj, q[3]));
    if (tw > Math.PI) tw = 2 * Math.PI - tw;
    return tw;
  };
  const cleaned = cleanClip(c, { limitLowerArms: true });
  let worstTwist = 0, clamped = 0;
  for (const side of ["Left", "Right"]) {
    const fore = c.names.indexOf(`${side}LowerArm`);
    const hand = c.names.indexOf(`${side}Hand`);
    const off = c.bindPos[hand];
    const len = Math.hypot(...off);
    const ax = off.map((v) => v / len);
    for (let f = 0; f < frames; f++) {
      worstTwist = Math.max(worstTwist, twistOf(cleaned.localQuat[fore][f], ax));
      if (angle(cleaned.localQuat[fore][f], c.localQuat[fore][f]) > 0.5) clamped++;
    }
  }
  check("forearm limit: twist within ±90°+ε", worstTwist * deg < 91, `worst twist=${(worstTwist * deg).toFixed(1)}°`);
  console.log(`      (clamped ${clamped} of ${frames * 2} forearm frames in this recording)`);

  // Lock: chosen side's forearm twist must be driven to ~0, other side untouched.
  const locked = cleanClip(c, { lockLowerArmTwist: "right" });
  const rf = c.names.indexOf("RightLowerArm"), lf = c.names.indexOf("LeftLowerArm");
  const rax = (() => { const o = c.bindPos[c.names.indexOf("RightHand")]; const l = Math.hypot(...o); return o.map((v) => v / l); })();
  const lax = (() => { const o = c.bindPos[c.names.indexOf("LeftHand")]; const l = Math.hypot(...o); return o.map((v) => v / l); })();
  let maxLockedTwist = 0, leftChanged = 0;
  for (let f = 0; f < frames; f++) {
    maxLockedTwist = Math.max(maxLockedTwist, twistOf(locked.localQuat[rf][f], rax));
    if (angle(locked.localQuat[lf][f], c.localQuat[lf][f]) > 0.5) leftChanged++;
  }
  check("forearm lock: right twist ~0", maxLockedTwist * deg < 1, `worst locked twist=${(maxLockedTwist * deg).toFixed(2)}°`);
  check("forearm lock: left forearm untouched", leftChanged === 0, `left frames changed=${leftChanged}`);
}

// --- 5. feet fix: penetration removed, skating pinned ----------------------
{
  const { BONE_PARENTS } = await import("../src/convert/skeleton.ts");
  const { quatMul, quatRotate } = await import("../src/convert/quat.ts");
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  // Independent FK (recursive — bone array isn't topologically sorted).
  const worldOf = (clip2, bone, f, cache) => {
    if (cache[bone]) return cache[bone];
    const p = BONE_PARENTS[bone];
    let pos, rot;
    if (p < 0) { pos = clip2.localPos[bone][f]; rot = clip2.localQuat[bone][f]; }
    else {
      const par = worldOf(clip2, p, f, cache);
      pos = add(par.pos, quatRotate(par.rot, clip2.localPos[bone][f]));
      rot = quatMul(par.rot, clip2.localQuat[bone][f]);
    }
    return (cache[bone] = { pos, rot });
  };
  const feetTracks = (clip2) => {
    const out = {};
    for (const side of ["Left", "Right"]) out[side] = { ankle: [], low: [] };
    for (let f = 0; f < frames; f++) {
      const cache = {};
      for (const side of ["Left", "Right"]) {
        const a = worldOf(clip2, c.names.indexOf(`${side}Foot`), f, cache).pos;
        const t = worldOf(clip2, c.names.indexOf(`${side}Toes`), f, cache).pos;
        out[side].ankle.push(a);
        out[side].low.push(Math.min(a[1], t[1]));
      }
    }
    return out;
  };
  const pct = (arr, p) => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length * p)];

  const stats = { despiked: 0, wristClamped: 0, forearmClamped: 0, smoothedMeanDeg: 0 };
  const cleaned = cleanClip(c, { fixFeet: true }, stats);
  const before = feetTracks(c);
  const after = feetTracks(cleaned);

  let driftBefore = 0, driftAfter = 0, penBefore = 0, penAfter = 0;
  for (const side of ["Left", "Right"]) {
    const ground = pct(before[side].low, 0.05);
    penBefore = Math.max(penBefore, ground - Math.min(...before[side].low));
    penAfter = Math.max(penAfter, ground - Math.min(...after[side].low));

    // Plant spans on ORIGINAL data: low + slow (independent of feet.ts logic).
    const speed = before[side].ankle.map((a, f) => {
      if (!f) return 0;
      const dt = Math.max(1e-4, c.times[f] - c.times[f - 1]);
      return Math.hypot(a[0] - before[side].ankle[f - 1][0], a[2] - before[side].ankle[f - 1][2]) / dt;
    });
    let start = -1;
    for (let f = 0; f <= frames; f++) {
      const planted = f < frames && before[side].low[f] < ground + 0.02 && speed[f] < 0.12;
      if (planted) { if (start < 0) start = f; continue; }
      if (start >= 0) {
        if (c.times[f - 1] - c.times[start] >= 0.5) {
          // Core of the span (skip 150ms blend edges): XZ path length.
          const lo = start + Math.round(0.15 * 60), hi = f - 1 - Math.round(0.15 * 60);
          for (let k = lo + 1; k <= hi; k++) {
            const pl = (tr) => Math.hypot(tr[k][0] - tr[k - 1][0], tr[k][2] - tr[k - 1][2]);
            driftBefore += pl(before[side].ankle);
            driftAfter += pl(after[side].ankle);
          }
        }
        start = -1;
      }
    }
  }
  const cm = (v) => (v * 100).toFixed(1);
  console.log(`      feet: ${stats.feet.spans} spans pinned, ${stats.feet.frames} frames, max fix ${stats.feet.maxFixCm.toFixed(1)} cm`);
  check("feet: penetration removed", penAfter < 0.006, `worst below-ground before=${cm(penBefore)}cm after=${cm(penAfter)}cm`);
  check("feet: planted-foot drift mostly gone", driftAfter < driftBefore * 0.3, `in-plant path before=${cm(driftBefore)}cm after=${cm(driftAfter)}cm`);

  // Only leg-chain rotations may change; everything else must be untouched.
  const legs = new Set(["LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "RightUpperLeg", "RightLowerLeg", "RightFoot"]);
  let touched = 0;
  for (let b = 0; b < c.names.length; b++) {
    if (legs.has(c.names[b])) continue;
    // Degenerate (zero-norm) tracks make the angle metric read 180° between
    // identical quats — skip them (unused bones like Jaw in some recordings).
    if (c.localQuat[b].some((q) => Math.hypot(...q) < 0.5)) continue;
    for (let f = 0; f < frames; f++) {
      if (angle(cleaned.localQuat[b][f], c.localQuat[b][f]) > 0.01) { touched++; break; }
    }
  }
  check("feet: non-leg bones untouched", touched === 0, `bones changed outside legs=${touched}`);
}

// --- 6. range smoothing works when timestamps don't start at zero ----------
// Recordings can begin at a nonzero timestamp; smoothRange takes PLAYBACK
// (0-based) times from the transport trim, so it must normalize internally.
{
  const { smoothRange } = await import("../src/convert/clean.ts");
  const OFFSET = 5.0;
  const shifted = { ...c, times: c.times.map((t) => t + OFFSET) };
  const r = { t0: c.duration * 0.25, t1: c.duration * 0.75, cutoffHz: 3 };
  const hand = c.names.indexOf("RightHand");
  const findFrame = (clip2, t) => {
    const base = clip2.times[0];
    let f = 0;
    while (f < clip2.times.length - 1 && clip2.times[f] - base < t) f++;
    return f;
  };
  const f0 = findFrame(shifted, r.t0), f1 = findFrame(shifted, r.t1);
  const outShifted = smoothRange(shifted, r);
  const outZero = smoothRange({ ...c, times: c.times.map((t) => t - c.times[0]) }, r);
  const changed = (a, b) => {
    let sum = 0;
    for (let f = f0; f <= f1; f++) sum += angle(a.localQuat[hand][f], b.localQuat[hand][f]);
    return sum;
  };
  const dShifted = changed(shifted, outShifted);
  const dZero = changed(c, outZero);
  check("smoothRange: acts on nonzero-start recordings", dShifted > 1e-6, `in-range change=${dShifted.toFixed(3)}°`);
  check(
    "smoothRange: nonzero-start matches zero-start",
    Math.abs(dShifted - dZero) < Math.max(1e-6, dZero * 1e-6),
    `zero-start=${dZero.toFixed(3)}° shifted=${dShifted.toFixed(3)}°`,
  );
}

// --- 7. despike removes an injected HIPS TRANSLATION pop -------------------
{
  const injected = structuredClone(c);
  const f = Math.floor(frames / 3);
  const orig = [...injected.localPos[0][f]];
  injected.localPos[0][f] = [orig[0] + 0.25, orig[1] + 0.1, orig[2]]; // ~27cm pop
  const stats = { despiked: 0, wristClamped: 0, forearmClamped: 0, smoothedMeanDeg: 0 };
  const cleaned = cleanClip(injected, { despike: true }, stats);
  const dist = Math.hypot(
    cleaned.localPos[0][f][0] - orig[0],
    cleaned.localPos[0][f][1] - orig[1],
    cleaned.localPos[0][f][2] - orig[2],
  );
  check("despike: hips translation pop removed", dist < 0.03, `residual=${(dist * 100).toFixed(1)}cm, despiked=${stats.despiked}`);
  check("despike: pop frame reported in fixedFrames", !!stats.fixedFrames?.despike.has(f), `despike marks=${stats.fixedFrames?.despike.size ?? 0}`);
}

// --- 8. warp maps: exact inverse, and nonzero-start invariance --------------
{
  const { warpMaps, applyTimeWarp } = await import("../src/rig/timewarp.ts");
  const keys = [{ time: Math.min(1, c.duration * 0.2), speed: 0.5 }, { time: Math.min(3, c.duration * 0.6), speed: 2 }];
  const m = warpMaps(c.times, keys);
  let worst = 0;
  for (let i = 0; i <= 20; i++) {
    const s = (c.duration * i) / 20;
    worst = Math.max(worst, Math.abs(m.srcOf(m.outOf(s)) - s));
  }
  check("warpMaps: outOf/srcOf round-trip", worst < 1e-6, `worst=${worst.toExponential(2)}s`);
  const warped = applyTimeWarp(c, keys);
  check(
    "warpMaps: outDuration matches applyTimeWarp",
    Math.abs(m.outDuration - warped.duration) < 1e-6,
    `map=${m.outDuration.toFixed(4)}s clip=${warped.duration.toFixed(4)}s`,
  );
  // Nonzero-start recording: the same 0-based speed keys must produce the
  // same warp (keys were compared against ABSOLUTE midpoints before the fix).
  const shifted = { ...c, times: c.times.map((t) => t + 7) };
  const warpedShifted = applyTimeWarp(shifted, keys);
  check(
    "timewarp: nonzero-start duration matches zero-start",
    Math.abs(warpedShifted.duration - warped.duration) < 1e-6,
    `zero=${warped.duration.toFixed(4)}s shifted=${warpedShifted.duration.toFixed(4)}s`,
  );
}

if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
