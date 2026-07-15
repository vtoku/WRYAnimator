// Verifies the control-rig layer engine (bone-local channel curves, MoBu
// style) plus the modifiers, on real motion data:
//  - the rig is an input device: IK solves at capture, keys are LOCAL values
//  - override keys PIN the local pose (pop fixes hold on any base motion)
//  - additive keys are local deltas that travel when retimed/copied
//  - envelopes: hold extends; fade keys are local bumps
//  - dirty-range partial rebakes are identical to full rebakes
// Usage: node scripts/rigCheck.mjs [file.wanim]
import { readFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter } = await import("../src/convert/clip.ts");
const {
  makeLayer, getTrack, setPosKey, setRotKey, applyRigLayers, poseAtFrame, nearestFrame,
  retimeKeys, keyFullPose, bakeRange, dirtyRange, reduceKeys, setKeyEase,
  keyEffectorTarget, fullStackPose, belowStackPose, captureBoneKeys, effectorDef, effectorForBone,
} = await import("../src/rig/rig.ts");
void fullStackPose;
const { worldFromLocal } = await import("../src/convert/fk.ts");

const path = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim";
const buf = readFileSync(path);
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const c = convertCharacter(clip, 0);
const frames = c.times.length;
console.log(`clip: ${frames} frames, ${c.duration.toFixed(1)}s`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  if (!ok) failures++;
};

const world = (clip2, f) => worldFromLocal(clip2.parents, poseAtFrame(clip2, f));
const boneI = (name) => c.names.indexOf(name);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const qangle = (a, b) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d)) * (180 / Math.PI);
};
const qmul = (a, b) => [
  a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
  a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
  a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
  a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2],
];
const mm = (v) => (v * 1000).toFixed(2);

const hand = boneI("RightHand");
const tKey = 5;
const fKey = nearestFrame(c, tKey);
const f0 = 0;

// --- 1. IK capture: drag target lands, keys on the chain, locals reproduce ----
{
  const layer = makeLayer("L1");
  layer.extent = "hold";
  const layers = [layer];
  const target = [...world(c, fKey).pos[hand]];
  target[0] += 0.06; target[1] += 0.04;
  keyEffectorTarget(c, layers, 0, "rightHand", fKey, { pos: target });
  const baked = applyRigLayers(c, layers);
  const err = dist(world(baked, fKey).pos[hand], target);
  const rotDrift = qangle(world(baked, fKey).rot[hand], world(c, fKey).rot[hand]);
  const bones = layer.tracks.map((t) => t.bone).sort().join(",");
  check("IK capture: hand lands on the target, keys on the 3 chain bones",
    err < 0.002 && bones === "RightHand,RightLowerArm,RightUpperArm",
    `err ${mm(err)}mm, tracks [${bones}]`);
  check("IK capture: hand world rotation preserved", rotDrift < 0.01, `drift ${rotDrift.toFixed(4)}°`);

  // Isolation: only the chain's locals changed.
  let touched = 0;
  for (let b = 0; b < c.names.length; b++) {
    if (["RightUpperArm", "RightLowerArm", "RightHand"].includes(c.names[b])) continue;
    if (c.localQuat[b].some((q) => Math.hypot(...q) < 0.5)) continue;
    for (let f = 0; f < frames; f += 50) {
      if (qangle(baked.localQuat[b][f], c.localQuat[b][f]) > 0.01) { touched++; break; }
    }
  }
  check("IK capture: everything else untouched", touched === 0, `bones changed=${touched}`);
}

// --- 2. override pins the pose: pop-fix stability ------------------------------
{
  const layer = makeLayer("L1"); // fade 0.5
  layer.mode = "override";
  const layers = [layer];
  // "Fix a pop": key the full pose at the frame, plus the as-is pose around it.
  const fFix = nearestFrame(c, 20);
  const fA = nearestFrame(c, 19.7);
  const fB = nearestFrame(c, 20.3);
  for (const f of [fA, fFix, fB]) keyFullPose(c, layers, 0, c.times[f] - c.times[0], f);
  // Now nudge the fix frame's hand and re-key it.
  const target = [...world(c, fFix).pos[hand]];
  target[1] += 0.05;
  keyEffectorTarget(c, layers, 0, "rightHand", fFix, { pos: target });
  const baked = applyRigLayers(c, layers);
  const errFix = dist(world(baked, fFix).pos[hand], target);
  // Frames at the bracketing keys keep their as-is pose exactly.
  const errA = dist(world(baked, fA).pos[hand], world(c, fA).pos[hand]);
  // Far away: untouched (fade extent).
  const errFar = dist(world(baked, f0).pos[hand], world(c, f0).pos[hand]);
  check("override pop-fix: fixed frame pinned, brackets pinned as-is, far frames untouched",
    errFix < 0.002 && errA < 0.001 && errFar < 1e-9,
    `fix ${mm(errFix)}mm, bracket ${mm(errA)}mm, far ${mm(errFar)}mm`);
}

// --- 3. additive local deltas travel: retime keeps the relative effect ---------
{
  const layer = makeLayer("L1");
  layer.extent = "hold";
  const layers = [layer];
  // Bend the forearm by rotating the hand's parent chainlessly: use the FK
  // forearm effector with an absolute rot target 20° off current.
  const fore = boneI("RightLowerArm");
  const ang = 20 * Math.PI / 180;
  const w0 = world(c, fKey).rot[fore];
  const spin = [Math.sin(ang / 2), 0, 0, Math.cos(ang / 2)];
  keyEffectorTarget(c, layers, 0, "rightLowerArm", fKey, { rot: qmul(spin, w0) });
  const track = getTrack(layer, "rightLowerArm");
  const delta = track.rotKeys[0].q; // captured local delta
  // Retime far away — the LOCAL delta must produce the same relative change.
  retimeKeys(track, tKey, 40);
  const f40 = nearestFrame(c, 40);
  const baked = applyRigLayers(c, layers);
  const expectLocal = qmul(c.localQuat[fore][f40], delta);
  const err = qangle(baked.localQuat[fore][f40], expectLocal);
  check("additive travel: retimed key applies the same local delta",
    err < 0.01, `local err ${err.toFixed(4)}° after moving t=5→40`);
}

// --- 4. hips: additive pos keys, hold + stacking + fade bumps ------------------
{
  const hips = boneI("Hips");
  const l1 = makeLayer("L1"); l1.extent = "hold";
  const l2 = makeLayer("L2"); l2.extent = "hold";
  setPosKey(getTrack(l1, "hips", true), tKey, [0, 0.05, 0]);
  setPosKey(getTrack(l2, "hips", true), tKey, [0, 0.03, 0]);
  const baked = applyRigLayers(c, [l1, l2]);
  const lift = world(baked, fKey).pos[hips][1] - world(c, fKey).pos[hips][1];
  const liftStart = world(baked, f0).pos[hips][1] - world(c, f0).pos[hips][1];
  check("hips stacking: two additive layers sum; hold extends",
    Math.abs(lift - 0.08) < 0.001 && Math.abs(liftStart - 0.08) < 0.001,
    `lift ${mm(lift)}mm @key, ${mm(liftStart)}mm @start`);

  const lf = makeLayer("F"); // fade 0.5
  const tr = getTrack(lf, "hips", true);
  setPosKey(tr, 5, [0.05, 0, 0]);
  setPosKey(tr, 9, [0, 0.05, 0]);
  const bakedF = applyRigLayers(c, [lf]);
  const at = (t) => dist(world(bakedF, nearestFrame(c, t)).pos[hips], world(c, nearestFrame(c, t)).pos[hips]);
  // Full strength ACROSS the keyed range (values interpolate on the curve);
  // fades to zero only outside first/last key.
  check("fade range: full at keys, interpolated mid-range, zero outside",
    at(5) > 0.045 && at(9) > 0.045 && at(7) > 0.02 && at(0.5) < 0.001 && at(20) < 0.001,
    `@5 ${mm(at(5))} @7 ${mm(at(7))} @9 ${mm(at(9))} @0.5 ${mm(at(0.5))} @20 ${mm(at(20))} mm`);
}

// --- 3b. editing a NON-TOP layer must not absorb the layers above ----------------
{
  const l0 = makeLayer("L0");
  l0.extent = "hold";
  const l1 = makeLayer("L1");
  l1.extent = "hold";
  // L1 (above) bends the spine.
  const ang = 15 * Math.PI / 180;
  setRotKey(getTrack(l1, "spine", true), tKey, [Math.sin(ang / 2), 0, 0, Math.cos(ang / 2)]);
  const layers = [l0, l1];
  // Edit L0 (below): place the hand at a target. Pull TOWARD the shoulder so
  // the target is always inside the arm's reach on any recording.
  const shoulder = world(c, fKey).pos[boneI("RightUpperArm")];
  const handP = world(c, fKey).pos[hand];
  const target = [
    handP[0] + (shoulder[0] - handP[0]) * 0.15,
    handP[1] + (shoulder[1] - handP[1]) * 0.15,
    handP[2] + (shoulder[2] - handP[2]) * 0.15,
  ];
  keyEffectorTarget(c, layers, 0, "rightHand", fKey, { pos: target });
  // With L1 DISABLED, L0's keys alone must reproduce the solved-through-L0
  // result: the hand at the target. If capture had absorbed L1's spine bend,
  // the hand would be off by that bend here (and doubled with L1 on).
  l1.enabled = false;
  const baked = applyRigLayers(c, layers);
  const err = dist(world(baked, fKey).pos[hand], target);
  check("layer scoping: keys on a lower layer don't absorb the layers above",
    err < 0.002, `hand err ${mm(err)}mm with the upper layer muted`);
  l1.enabled = true;
}

// --- 3c. time base: keys live in PLAYBACK time even when timestamps don't start at 0
{
  // Synthesize a clip whose timestamps start at +0.75 s (some recorders do).
  const shifted = { ...c, times: c.times.map((t) => t + 0.75) };
  const layer = makeLayer("T"); // fade 0.5 — sensitive to any time offset
  const layers = [layer];
  const fT = nearestFrame(shifted, tKey);
  const shoulderT = world(c, fT).pos[boneI("RightUpperArm")];
  const handT = world(c, fT).pos[hand];
  const target = [
    handT[0] + (shoulderT[0] - handT[0]) * 0.15,
    handT[1] + (shoulderT[1] - handT[1]) * 0.15,
    handT[2] + (shoulderT[2] - handT[2]) * 0.15,
  ];
  keyEffectorTarget(shifted, layers, 0, "rightHand", fT, { pos: target });
  const baked = applyRigLayers(shifted, layers);
  const err = dist(world(baked, fT).pos[hand], target);
  check("time base: key lands at its frame despite a nonzero first timestamp",
    err < 0.002, `hand err ${mm(err)}mm (offset recordings)`);
}

// --- 3d. mode switch converts keys: the pose survives additive ⇄ override --------
{
  const { convertLayerMode } = await import("../src/rig/rig.ts");
  const layer = makeLayer("M");
  layer.extent = "hold";
  const layers = [layer];
  const shoulder = world(c, fKey).pos[boneI("RightUpperArm")];
  const handP = world(c, fKey).pos[hand];
  const target = [
    handP[0] + (shoulder[0] - handP[0]) * 0.15,
    handP[1] + (shoulder[1] - handP[1]) * 0.15,
    handP[2] + (shoulder[2] - handP[2]) * 0.15,
  ];
  keyEffectorTarget(c, layers, 0, "rightHand", fKey, { pos: target }); // additive keys
  const before = world(applyRigLayers(c, layers), fKey).pos[hand];
  convertLayerMode(c, layers, 0, "override");
  const afterOv = world(applyRigLayers(c, layers), fKey).pos[hand];
  convertLayerMode(c, layers, 0, "additive");
  const afterBack = world(applyRigLayers(c, layers), fKey).pos[hand];
  check("mode switch: pose preserved additive→override→additive",
    layer.mode === "additive" && dist(before, afterOv) < 0.001 && dist(before, afterBack) < 0.001,
    `override drift ${mm(dist(before, afterOv))}mm, round-trip ${mm(dist(before, afterBack))}mm`);
}

// --- 4b. OVERRIDE SECTION HOLDS: keyed span pins the pose, no mid-span collapse --
{
  const layer = makeLayer("S"); // fade 0.5
  layer.mode = "override";
  const layers = [layer];
  const fA = nearestFrame(c, 10);
  const fB = nearestFrame(c, 20);
  // Key the SAME pose (the t=10 pose) at both ends of the section.
  const poseA = fullStackPose(c, layers, fA);
  const bones = ["RightUpperArm", "RightLowerArm", "RightHand"];
  captureBoneKeys(c, layers, 0, bones, poseA, fA, c.times[fA] - c.times[0]);
  captureBoneKeys(c, layers, 0, bones, poseA, fB, c.times[fB] - c.times[0]);
  const baked = applyRigLayers(c, layers);
  // Across the whole section the arm's LOCALS must equal the keyed pose —
  // frozen — even though the base motion underneath keeps dancing.
  const arm = boneI("RightUpperArm");
  let worst = 0;
  for (const t of [10, 12.5, 15, 17.5, 20]) {
    const f = nearestFrame(c, t);
    worst = Math.max(worst, qangle(baked.localQuat[arm][f], poseA.quat[arm]));
  }
  const outside = qangle(baked.localQuat[arm][nearestFrame(c, 30)], c.localQuat[arm][nearestFrame(c, 30)]);
  check("override section: pose held across the whole keyed span, released outside",
    worst < 0.01 && outside < 0.01,
    `worst in-span drift ${worst.toFixed(4)}°, outside drift ${outside.toFixed(4)}°`);
}

// --- 5. neutral capture = no-op; keyFullPose locks without changing ------------
{
  const layer = makeLayer("L1");
  const layers = [layer];
  const below = belowStackPose(c, layers, 0, fKey);
  captureBoneKeys(c, layers, 0, ["RightHand", "Hips"], below, fKey, tKey, true);
  keyFullPose(c, layers, 0, tKey, fKey);
  const baked = applyRigLayers(c, layers);
  let worst = 0;
  for (let b = 0; b < c.names.length; b++) {
    if (c.localQuat[b].some((q) => Math.hypot(...q) < 0.5)) continue;
    worst = Math.max(worst, dist(world(baked, fKey).pos[b], world(c, fKey).pos[b]));
  }
  check("neutral + key full pose: pose unchanged, keys everywhere",
    worst < 0.002 && layer.tracks.length >= 17, `${layer.tracks.length} tracks, drift ${mm(worst)}mm`);
}

// --- 6. weight scaling on override -----------------------------------------------
{
  const foot = boneI("LeftFoot");
  const layer = makeLayer("L1");
  layer.mode = "override";
  layer.extent = "hold";
  const layers = [layer];
  const target = [...world(c, fKey).pos[foot]];
  target[0] += 0.04; target[1] += 0.06;
  keyEffectorTarget(c, layers, 0, "leftFoot", fKey, { pos: target });
  const bakedFull = applyRigLayers(c, layers);
  const errFull = dist(world(bakedFull, fKey).pos[foot], target);
  layer.weight = 0.5;
  const bakedHalf = applyRigLayers(c, layers);
  const half = dist(world(bakedHalf, fKey).pos[foot], world(c, fKey).pos[foot]);
  const full = Math.hypot(0.04, 0.06);
  check("override weight: 100% lands, 50% goes about halfway",
    errFull < 0.002 && Math.abs(half - full / 2) < 0.012,
    `err ${mm(errFull)}mm, half ${mm(half)}mm of ${mm(full)}mm`);
}

// --- 7. ease + euler round-trip + reduce -----------------------------------------
{
  const { quatToEulerZYX, eulerZYXToQuat } = await import("../src/convert/quat.ts");
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const a = Math.sin(i * 1.7) * 2, b = Math.cos(i * 0.9) * 1.2, cc = Math.sin(i * 2.3) * 2.8;
    const n = Math.hypot(a, b, cc, 1);
    const q = [a / n, b / n, cc / n, 1 / n];
    worst = Math.max(worst, qangle(q, eulerZYXToQuat(quatToEulerZYX(q))));
  }
  check("euler ZYX round-trip exact", worst < 1e-4, `worst ${worst.toExponential(1)}°`);

  const hips = boneI("Hips");
  const layer = makeLayer("L1");
  layer.extent = "hold";
  const tr = getTrack(layer, "hips", true);
  setPosKey(tr, 4, [0, 0, 0]);
  setPosKey(tr, 6, [0, 0.1, 0]);
  const fMid = nearestFrame(c, 5);
  const linLift = world(applyRigLayers(c, [layer]), fMid).pos[hips][1] - world(c, fMid).pos[hips][1];
  setKeyEase(tr, 4, "step");
  const stepLift = world(applyRigLayers(c, [layer]), fMid).pos[hips][1] - world(c, fMid).pos[hips][1];
  setKeyEase(tr, 4, "smooth");
  const fQ = nearestFrame(c, 4.5);
  const smoothQ = world(applyRigLayers(c, [layer]), fQ).pos[hips][1] - world(c, fQ).pos[hips][1];
  setKeyEase(tr, 4, "linear");
  const linQ = world(applyRigLayers(c, [layer]), fQ).pos[hips][1] - world(c, fQ).pos[hips][1];
  check("ease: step holds, smooth lags linear early in the segment",
    Math.abs(stepLift) < 0.0005 && Math.abs(linLift - 0.05) < 0.003 && smoothQ < linQ - 0.005,
    `step ${mm(stepLift)}mm, linear-mid ${mm(linLift)}mm, quarter smooth ${mm(smoothQ)} < ${mm(linQ)}`);

  const lr = makeLayer("R");
  const trr = getTrack(lr, "hips", true);
  for (let i = 0; i <= 8; i++) setPosKey(trr, i, [0, i * 0.01, 0]);
  setPosKey(trr, 10, [0, 0, 0]);
  const removed = reduceKeys(trr, 0.001);
  check("key reducer: straight ramp collapses, corner survives",
    removed >= 7 && trr.posKeys.length <= 4 && trr.posKeys.some((k) => Math.abs(k.time - 8) < 0.01),
    `removed ${removed}, ${trr.posKeys.length} left`);
}

// --- 8. partial (dirty-range) rebake === full rebake -------------------------------
{
  const layer = makeLayer("L1"); // fade 0.5
  const tr = getTrack(layer, "hips", true);
  setPosKey(tr, 3, [0.03, 0, 0]);
  setPosKey(tr, 6, [0, 0.05, 0]);
  setPosKey(tr, 9, [0.02, 0.02, 0]);
  const layers = [layer];
  const pos = c.localPos.map((t) => t.map((p) => [...p]));
  const quat = c.localQuat.map((t) => t.map((q) => [...q]));
  bakeRange(c, layers, pos, quat);
  const dirty = dirtyRange(layer, tr, 6);
  setPosKey(tr, 6, [0, -0.04, 0.03]);
  bakeRange(c, layers, pos, quat, dirty);
  const full = applyRigLayers(c, layers);
  let worst = 0;
  for (let b = 0; b < c.names.length; b++) {
    if (c.localQuat[b].some((q) => Math.hypot(...q) < 0.5)) continue;
    for (let f = 0; f < frames; f += 7) {
      worst = Math.max(worst, dist(pos[b][f], full.localPos[b][f]));
      const d = 1 - Math.abs(quat[b][f][0]*full.localQuat[b][f][0] + quat[b][f][1]*full.localQuat[b][f][1] + quat[b][f][2]*full.localQuat[b][f][2] + quat[b][f][3]*full.localQuat[b][f][3]);
      worst = Math.max(worst, d);
    }
  }
  check("partial rebake: identical to a full rebake", worst < 1e-9, `worst deviation ${worst.toExponential(1)}`);
}

// --- 9. bake performance: pure curve composition, no IK ---------------------------
{
  const layer = makeLayer("P");
  layer.extent = "hold";
  keyFullPose(c, [layer], 0, tKey, fKey);
  const t0 = performance.now();
  applyRigLayers(c, [layer]);
  const ms = performance.now() - t0;
  check("bake perf: full-pose layer over the whole clip is fast", ms < 900, `${ms.toFixed(0)} ms for ${frames} frames × ${layer.tracks.length} tracks`);
}

// --- 10. modifiers -----------------------------------------------------------------
{
  const { applyModifiers, defaultModifiers, applyReach } = await import("../src/rig/modifiers.ts");
  const { applyTimeWarp } = await import("../src/rig/timewarp.ts");
  const { cleanClip, smoothRange } = await import("../src/convert/clean.ts");

  {
    const mir = applyModifiers(c, { ...defaultModifiers(), mirror: true });
    const w0 = world(c, fKey), w1 = world(mir, fKey);
    const lh = boneI("LeftHand"), rh = boneI("RightHand"), hips = boneI("Hips");
    const target = [-w0.pos[rh][0], w0.pos[rh][1], w0.pos[rh][2]];
    const err = dist(w1.pos[lh], target);
    const hipsX = Math.abs(w1.pos[hips][0] + w0.pos[hips][0]);
    check("mirror: L hand = x-mirrored R hand, hips x flipped",
      err < 0.05 && hipsX < 1e-6, `hand err ${mm(err)}mm, hips ${mm(hipsX)}mm`);
  }
  {
    const smoothed = cleanClip(c, { smooth: true, cutoffHz: 1 });
    const rh = boneI("RightHand");
    const before = dist(world(smoothed, fKey).pos[rh], world(c, fKey).pos[rh]);
    const reached = applyReach(smoothed, c, { ...defaultModifiers(), reach: { leftHand: 0, rightHand: 1, leftFoot: 0, rightFoot: 0 } });
    const after = dist(world(reached, fKey).pos[rh], world(c, fKey).pos[rh]);
    const lhDrift = dist(world(reached, fKey).pos[boneI("LeftHand")], world(smoothed, fKey).pos[boneI("LeftHand")]);
    check("reach 100%: hand returns to the raw path, other limbs untouched",
      before > 0.003 && after < before * 0.1 && lhDrift < 1e-9,
      `off-path ${mm(before)}→${mm(after)}mm, left hand drift ${mm(lhDrift)}mm`);
  }
  {
    const warped = applyTimeWarp(c, [{ time: 0, speed: 0.5 }]);
    const ratio = warped.duration / c.duration;
    const rh = boneI("RightHand");
    const err = dist(world(warped, nearestFrame(warped, 10)).pos[rh], world(c, nearestFrame(c, 5)).pos[rh]);
    check("time warp: 0.5x doubles duration, out@10s == src@5s",
      Math.abs(ratio - 2) < 0.02 && err < 0.01, `ratio ${ratio.toFixed(3)}, pose err ${mm(err)}mm`);
  }
  {
    const sm = smoothRange(c, { t0: 20, t1: 30, cutoffHz: 2 });
    const rh = boneI("RightHand");
    // Max displacement across the range — a single instant is recording-
    // dependent (the hand can sit on a smoothing zero-crossing right there).
    let movedIn = 0;
    for (let t = 21; t <= 29; t++) {
      movedIn = Math.max(movedIn, dist(world(sm, nearestFrame(c, t)).pos[rh], world(c, nearestFrame(c, t)).pos[rh]));
    }
    const movedOut = dist(world(sm, nearestFrame(c, 50)).pos[rh], world(c, nearestFrame(c, 50)).pos[rh]);
    check("range smooth: changes inside the range only",
      movedIn > 0.002 && movedOut < 1e-12, `inside(max) ${mm(movedIn)}mm, outside ${mm(movedOut)}mm`);
  }
  {
    const { applyModifiers: am, defaultModifiers: dm } = await import("../src/rig/modifiers.ts");
    const baked = am(c, { ...dm(), hipsHeightCm: -6 });
    const w0 = world(c, fKey), w1 = world(baked, fKey);
    const hips = boneI("Hips"), lank = boneI("LeftFoot"), rank = boneI("RightFoot");
    const drop = w0.pos[hips][1] - w1.pos[hips][1];
    const ankleDrift = Math.max(dist(w0.pos[lank], w1.pos[lank]), dist(w0.pos[rank], w1.pos[rank]));
    check("modifier hips -6cm: hips drop, feet planted",
      Math.abs(drop - 0.06) < 0.002 && ankleDrift < 0.002, `drop ${mm(drop)}mm, ankle ${mm(ankleDrift)}mm`);
  }
}

// ---- pins, root, wrist twist (Poser-style rig behaviors) --------------------
{
  const fKey = Math.floor(frames / 2);
  const mm = (v) => (v * 1000).toFixed(2);
  const hips = boneI("Hips"), lank = boneI("LeftFoot"), rank = boneI("RightFoot");

  // 1. Pinned feet: dropping the hips 10 cm keeps both feet planted.
  {
    const layers = [makeLayer("pin-test")];
    const w0 = world(c, fKey);
    const target = [w0.pos[hips][0], w0.pos[hips][1] - 0.1, w0.pos[hips][2]];
    keyEffectorTarget(c, layers, 0, "hips", fKey, { pos: target }, ["leftFoot", "rightFoot"]);
    const baked = applyRigLayers(c, layers);
    const w1 = world(baked, fKey);
    const drop = w0.pos[hips][1] - w1.pos[hips][1];
    const feet = Math.max(dist(w0.pos[lank], w1.pos[lank]), dist(w0.pos[rank], w1.pos[rank]));
    const legKeys = ["LeftUpperLeg", "LeftLowerLeg", "LeftFoot"].every(
      (b) => layers[0].tracks.some((tr) => tr.bone === b && tr.rotKeys.length));
    check("pins: hips −10cm with pinned feet — feet stay planted",
      Math.abs(drop - 0.1) < 0.002 && feet < 0.002 && legKeys,
      `drop ${mm(drop)}mm, worst foot drift ${mm(feet)}mm, leg keys ${legKeys}`);
  }

  // 2. Root translate: whole character shifts rigidly.
  {
    const layers = [makeLayer("root-move")];
    const w0 = world(c, fKey);
    const pivot = [w0.pos[hips][0], 0, w0.pos[hips][2]];
    keyEffectorTarget(c, layers, 0, "root", fKey, { pos: [pivot[0] + 0.5, 0, pivot[2]] });
    const w1 = world(applyRigLayers(c, layers), fKey);
    const dHips = [w1.pos[hips][0] - w0.pos[hips][0], w1.pos[hips][1] - w0.pos[hips][1], w1.pos[hips][2] - w0.pos[hips][2]];
    const dFoot = [w1.pos[lank][0] - w0.pos[lank][0], w1.pos[lank][1] - w0.pos[lank][1], w1.pos[lank][2] - w0.pos[lank][2]];
    check("root: +50cm X translates the whole character rigidly",
      Math.abs(dHips[0] - 0.5) < 0.002 && Math.abs(dHips[1]) < 0.002 &&
      Math.abs(dFoot[0] - 0.5) < 0.002 && Math.abs(dFoot[1]) < 0.002,
      `hips Δ(${mm(dHips[0])}, ${mm(dHips[1])})mm foot Δ(${mm(dFoot[0])}, ${mm(dFoot[1])})mm`);
  }

  // 3. Root yaw 90° about the ground pivot: foot orbits the pivot, height kept.
  {
    const layers = [makeLayer("root-yaw")];
    const w0 = world(c, fKey);
    const s = Math.sin(Math.PI / 4), w = Math.cos(Math.PI / 4);
    const yaw90 = [0, s, 0, w]; // +90° about Y
    keyEffectorTarget(c, layers, 0, "root", fKey, { rot: qmul(yaw90, w0.rot[hips]) });
    const w1 = world(applyRigLayers(c, layers), fKey);
    const pivot = [w0.pos[hips][0], 0, w0.pos[hips][2]];
    // Expected foot position = yaw90 about the pivot.
    const rel = [w0.pos[lank][0] - pivot[0], w0.pos[lank][1], w0.pos[lank][2] - pivot[2]];
    const expect = [pivot[0] + rel[2], rel[1], pivot[2] - rel[0]]; // +90° yaw: (x,z)→(z,−x)
    const err = dist(w1.pos[lank], expect);
    check("root: 90° yaw orbits the body about the ground pivot", err < 0.003, `foot err ${mm(err)}mm`);
  }

  // 4. Wrist twist distribution: hand world rotation preserved, forearm turns.
  {
    const layers = [makeLayer("twist")];
    const hand = boneI("RightHand"), fore = boneI("RightLowerArm");
    const w0 = world(c, fKey);
    // Twist the hand 60° about its own finger axis (world).
    const mid = boneI("RightMiddleProximal");
    const off = mid >= 0 ? c.bindPos[mid] : [-1, 0, 0];
    const len = Math.hypot(off[0], off[1], off[2]) || 1;
    const axisWorld = ((q, v) => { // rotate local axis into world
      const tx = 2 * (q[1] * v[2] - q[2] * v[1]), ty = 2 * (q[2] * v[0] - q[0] * v[2]), tz = 2 * (q[0] * v[1] - q[1] * v[0]);
      return [v[0] + q[3] * tx + (q[1] * tz - q[2] * ty), v[1] + q[3] * ty + (q[2] * tx - q[0] * tz), v[2] + q[3] * tz + (q[0] * ty - q[1] * tx)];
    })(w0.rot[hand], [off[0] / len, off[1] / len, off[2] / len]);
    const a = Math.PI / 3, sn = Math.sin(a / 2);
    const twistW = [axisWorld[0] * sn, axisWorld[1] * sn, axisWorld[2] * sn, Math.cos(a / 2)];
    const targetRot = qmul(twistW, w0.rot[hand]);
    keyEffectorTarget(c, layers, 0, "rightHand", fKey, { rot: targetRot });
    const w1 = world(applyRigLayers(c, layers), fKey);
    const handErr = qangle(w1.rot[hand], targetRot);
    const foreTurn = qangle(w1.rot[fore], w0.rot[fore]);
    check("wrist twist: hand lands on target, forearm carries its share",
      handErr < 0.1 && foreTurn > 20,
      `hand err ${handErr.toFixed(2)}°, forearm turned ${foreTurn.toFixed(1)}° (expect ~36°)`);
  }
}

// ---- hand pose: curl keys only that hand's finger locals ----------------------
{
  const { keyHandPose, hasHandFingers, handFingerBones } = await import("../src/rig/hands.ts");
  if (hasHandFingers(c.names, "Right")) {
    const layer = makeLayer("hand");
    layer.extent = "hold";
    const layers = [layer];
    const fH = nearestFrame(c, 8);
    const before = c.localQuat.map((tr) => [...tr[fH]]);
    keyHandPose(c, layers, 0, "Right", { curl: 0.6, spread: 0, thumbCurl: 0 }, fH, c.times[fH] - c.times[0]);
    const baked = applyRigLayers(c, layers);
    const rightFingers = new Set(handFingerBones(c.names, "Right"));
    let movedFingers = 0, touchedOther = 0, worstOther = 0;
    for (let b = 0; b < c.names.length; b++) {
      if (c.localQuat[b].some((q) => Math.hypot(...q) < 0.5)) continue; // degenerate/zero quats
      const moved = qangle(baked.localQuat[b][fH], before[b]);
      if (rightFingers.has(c.names[b])) { if (moved > 0.5) movedFingers++; }
      else if (moved > 0.01) { touchedOther++; worstOther = Math.max(worstOther, moved); }
    }
    check("hand pose: curl moves only the right hand's finger locals",
      movedFingers >= 8 && touchedOther === 0,
      `fingers moved ${movedFingers}, other bones touched ${touchedOther} (worst ${worstOther.toExponential(1)}°)`);
  } else {
    check("hand pose: (skipped — recording has no right-hand fingers)", true, "");
  }
}

// ---- per-finger FK: gizmo-style FK capture writes only that finger bone --------
{
  const fingerBone = "RightIndexProximal";
  if (boneI(fingerBone) >= 0) {
    const layer = makeLayer("finger");
    layer.extent = "hold";
    const layers = [layer];
    const fF = nearestFrame(c, 8);
    const bi = boneI(fingerBone);
    // Rotate the finger 25° about world X off its current world rotation.
    const w0 = world(c, fF).rot[bi];
    const a = 25 * Math.PI / 180;
    const spin = [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
    keyEffectorTarget(c, layers, 0, effectorForBone(fingerBone).id, fF, { rot: qmul(spin, w0) });
    const tracks = layer.tracks.map((t) => t.bone);
    const baked = applyRigLayers(c, layers);
    const err = qangle(world(baked, fF).rot[bi], qmul(spin, w0));
    check("per-finger FK: rotation lands, keys only that finger bone",
      err < 0.2 && tracks.length === 1 && tracks[0] === fingerBone,
      `world err ${err.toFixed(3)}°, tracks [${tracks.join(",")}]`);
  } else {
    check("per-finger FK: (skipped — no right index finger)", true, "");
  }
}

// ---- IK/FK blend + pole vectors -------------------------------------------------
{
  const { keyPoleTarget, poleWorld } = await import("../src/rig/rig.ts");

  // Blend 0: a hand reach writes NO chain root/mid keys (pure FK).
  {
    const layer = makeLayer("blend0");
    layer.extent = "hold";
    const layers = [layer];
    const target = [...world(c, fKey).pos[hand]];
    target[0] += 0.06; target[1] += 0.04;
    keyEffectorTarget(c, layers, 0, "rightHand", fKey, { pos: target }, [], 0);
    const rootMid = layer.tracks.filter((t) => t.bone === "RightUpperArm" || t.bone === "RightLowerArm" && t.rotKeys.length);
    check("IK/FK blend 0: reach writes no chain root/mid keys",
      rootMid.length === 0, `chain-root/mid tracks written = ${rootMid.length}`);
  }
  // Blend 1: reach writes the full chain and lands (baseline sanity).
  {
    const layer = makeLayer("blend1");
    layer.extent = "hold";
    const layers = [layer];
    const target = [...world(c, fKey).pos[hand]];
    target[0] += 0.05; target[1] += 0.03;
    keyEffectorTarget(c, layers, 0, "rightHand", fKey, { pos: target }, [], 1);
    const baked = applyRigLayers(c, layers);
    const err = dist(world(baked, fKey).pos[hand], target);
    const bones = layer.tracks.map((t) => t.bone).sort().join(",");
    check("IK/FK blend 1: reach lands and keys the whole chain",
      err < 0.002 && bones === "RightHand,RightLowerArm,RightUpperArm", `err ${mm(err)}mm, [${bones}]`);
  }
  // Pole vector at blend 1: bend plane swings, end joint stays put.
  {
    const layer = makeLayer("pole");
    layer.extent = "hold";
    const layers = [layer];
    const p0 = poleWorld(c, poseAtFrame(c, fKey), "rightHand");
    const endBefore = world(c, fKey).pos[hand];
    // Shove the pole handle well sideways so the bend plane clearly swings.
    const poleTarget = [p0[0] + 0.3, p0[1], p0[2] + 0.15];
    keyPoleTarget(c, layers, 0, "rightHand", fKey, poleTarget);
    const baked = applyRigLayers(c, layers);
    const endAfter = world(baked, fKey).pos[hand];
    const endDrift = dist(endBefore, endAfter);
    const bones = layer.tracks.map((t) => t.bone).sort().join(",");
    // The mid joint should have actually moved (plane changed).
    const midBefore = world(c, fKey).pos[boneI("RightLowerArm")];
    const midAfter = world(baked, fKey).pos[boneI("RightLowerArm")];
    check("pole vector: end joint stays within 1 mm, elbow swings, chain keyed",
      endDrift < 0.001 && bones === "RightHand,RightLowerArm,RightUpperArm" && dist(midBefore, midAfter) > 0.005,
      `end drift ${mm(endDrift)}mm, elbow moved ${mm(dist(midBefore, midAfter))}mm`);
  }
}

if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
