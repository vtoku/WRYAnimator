// Verifies the control-rig layer engine on real motion data:
//  - additive keys offset the effector by the delta (and HOLD past the ends)
//  - neutral keys bracket an adjustment so it stays local
//  - override keys place the effector at the absolute target, scaled by weight
//  - layers stack in order
//  - position keys preserve the end bone's world rotation
//  - only the involved chain changes
// Usage: node scripts/rigCheck.mjs [file.wanim]
import { readFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter } = await import("../src/convert/clip.ts");
const { makeLayer, getTrack, setPosKey, setRotKey, applyRigLayers, poseAtFrame, nearestFrame, retimeKeys, keyFullPose, bakeRange, dirtyRange } =
  await import("../src/rig/rig.ts");
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
const mm = (v) => (v * 1000).toFixed(2);

const hand = boneI("RightHand");
const tKey = 5;
const fKey = nearestFrame(c, tKey);
const f0 = 0;

// --- 1. additive key offsets the hand; HOLD extends it across the clip -----
{
  const layer = makeLayer("L1");
  layer.extent = "hold";
  setPosKey(getTrack(layer, "rightHand", true), tKey, [0.06, 0.04, 0]);
  const baked = applyRigLayers(c, [layer]);
  const dAtKey = dist(world(baked, fKey).pos[hand], world(c, fKey).pos[hand]);
  const dAtStart = dist(world(baked, f0).pos[hand], world(c, f0).pos[hand]);
  const expect = Math.hypot(0.06, 0.04);
  check("additive: hand moves by the delta at the key",
    Math.abs(dAtKey - expect) < 0.004, `moved ${mm(dAtKey)}mm expect ${mm(expect)}mm`);
  check("additive hold: single key HOLDS at clip start",
    Math.abs(dAtStart - expect) < 0.006, `moved ${mm(dAtStart)}mm at t=0`);
}

// --- 1b. fade extent: a single key is a LOCAL correction --------------------
{
  const layer = makeLayer("L1"); // default fade, 0.5s
  setPosKey(getTrack(layer, "rightHand", true), tKey, [0.06, 0.04, 0]);
  const baked = applyRigLayers(c, [layer]);
  const expect = Math.hypot(0.06, 0.04);
  const dAtKey = dist(world(baked, fKey).pos[hand], world(c, fKey).pos[hand]);
  const fMid = nearestFrame(c, tKey + 0.25);
  const dMid = dist(world(baked, fMid).pos[hand], world(c, fMid).pos[hand]);
  const fOut = nearestFrame(c, tKey + 1.0);
  const dOut = dist(world(baked, fOut).pos[hand], world(c, fOut).pos[hand]);
  const dStart = dist(world(baked, f0).pos[hand], world(c, f0).pos[hand]);
  check("fade: full delta at the key", Math.abs(dAtKey - expect) < 0.004, `moved ${mm(dAtKey)}mm`);
  check("fade: partial mid-fade, zero outside",
    dMid > expect * 0.2 && dMid < expect * 0.85 && dOut < 0.001 && dStart < 0.001,
    `mid ${mm(dMid)}mm, +1s ${mm(dOut)}mm, t=0 ${mm(dStart)}mm`);

  // retime: move the key +2s — influence follows
  retimeKeys(getTrack(layer, "rightHand"), tKey, tKey + 2);
  const baked2 = applyRigLayers(c, [layer]);
  const fNew = nearestFrame(c, tKey + 2);
  const dNew = dist(world(baked2, fNew).pos[hand], world(c, fNew).pos[hand]);
  const dOld = dist(world(baked2, fKey).pos[hand], world(c, fKey).pos[hand]);
  check("retime: key moved in time", Math.abs(dNew - expect) < 0.004 && dOld < 0.001,
    `new ${mm(dNew)}mm, old spot ${mm(dOld)}mm`);
}

// --- 1c. key full pose: locking the pose changes nothing ---------------------
{
  const layer = makeLayer("L1");
  const layers = [layer];
  keyFullPose(c, layers, 0, tKey, fKey);
  const nTracks = layer.tracks.length;
  const baked = applyRigLayers(c, layers);
  let worst = 0;
  for (let b = 0; b < c.names.length; b++) {
    if (c.localQuat[b].some((q) => Math.hypot(...q) < 0.5)) continue; // dead bones
    worst = Math.max(worst, dist(world(baked, fKey).pos[b], world(c, fKey).pos[b]));
  }
  check("key full pose: keys every effector, pose unchanged",
    nTracks >= 17 && worst < 0.002, `${nTracks} tracks, worst drift ${mm(worst)}mm`);
}

// --- 2. neutral keys keep the adjustment local ------------------------------
{
  const layer = makeLayer("L1");
  const tr = getTrack(layer, "rightHand", true);
  setPosKey(tr, 2, [0, 0, 0]);
  setPosKey(tr, tKey, [0.06, 0.04, 0]);
  setPosKey(tr, 8, [0, 0, 0]);
  const baked = applyRigLayers(c, [layer]);
  const dOutside = dist(world(baked, f0).pos[hand], world(c, f0).pos[hand]);
  const dAtKey = dist(world(baked, fKey).pos[hand], world(c, fKey).pos[hand]);
  check("neutral keys: untouched outside the bracket", dOutside < 0.0005, `moved ${mm(dOutside)}mm at t=0`);
  check("neutral keys: full delta at the key", Math.abs(dAtKey - Math.hypot(0.06, 0.04)) < 0.004, `moved ${mm(dAtKey)}mm`);
}

// --- 3. override places the foot at the absolute target, scaled by weight ---
{
  const foot = boneI("LeftFoot");
  const target = [...world(c, fKey).pos[foot]];
  target[1] += 0.06; target[0] += 0.04;
  const layer = makeLayer("L1");
  layer.mode = "override";
  setPosKey(getTrack(layer, "leftFoot", true), tKey, target);
  const baked = applyRigLayers(c, [layer]);
  const err = dist(world(baked, fKey).pos[foot], target);
  check("override: foot lands on the absolute target", err < 0.002, `error ${mm(err)}mm`);

  layer.weight = 0.5;
  const baked2 = applyRigLayers(c, [layer]);
  const half = dist(world(baked2, fKey).pos[foot], world(c, fKey).pos[foot]);
  const full = Math.hypot(0.04, 0.06);
  check("override: weight 50% goes halfway", Math.abs(half - full / 2) < 0.005, `moved ${mm(half)}mm of ${mm(full)}mm`);
}

// --- 4. layers stack in order ------------------------------------------------
{
  const l1 = makeLayer("L1"), l2 = makeLayer("L2");
  setPosKey(getTrack(l1, "hips", true), tKey, [0, 0.05, 0]);
  setPosKey(getTrack(l2, "hips", true), tKey, [0, 0.03, 0]);
  const baked = applyRigLayers(c, [l1, l2]);
  const hips = boneI("Hips");
  const lift = world(baked, fKey).pos[hips][1] - world(c, fKey).pos[hips][1];
  check("stacking: two additive hips layers sum", Math.abs(lift - 0.08) < 0.001, `lift ${mm(lift)}mm expect 80.00mm`);
}

// --- 5. position keys preserve the hand's world rotation ---------------------
{
  const layer = makeLayer("L1");
  setPosKey(getTrack(layer, "rightHand", true), tKey, [0.06, 0.04, 0]);
  const baked = applyRigLayers(c, [layer]);
  const rotDrift = qangle(world(baked, fKey).rot[hand], world(c, fKey).rot[hand]);
  check("IK move: hand world rotation preserved", rotDrift < 0.01, `drift ${rotDrift.toFixed(4)}°`);
}

// --- 6. head rotation key: rotates in place ----------------------------------
{
  const head = boneI("Head");
  const yaw = 20 * Math.PI / 180;
  const layer = makeLayer("L1");
  setRotKey(getTrack(layer, "head", true), tKey, [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
  const baked = applyRigLayers(c, [layer]);
  const ang = qangle(world(baked, fKey).rot[head], world(c, fKey).rot[head]);
  const posDrift = dist(world(baked, fKey).pos[head], world(c, fKey).pos[head]);
  check("head rot: world rotation changes by the delta", Math.abs(ang - 20) < 0.1, `rotated ${ang.toFixed(2)}° expect 20°`);
  check("head rot: head joint does not translate", posDrift < 1e-6, `drift ${mm(posDrift)}mm`);
}

// --- 6b. FK effector: upper-arm rotation swings the whole arm in place --------
{
  const arm = boneI("LeftUpperArm");
  const handL = boneI("LeftHand");
  const ang = 25 * Math.PI / 180;
  const layer = makeLayer("L1");
  setRotKey(getTrack(layer, "leftUpperArm", true), tKey, [0, 0, Math.sin(ang / 2), Math.cos(ang / 2)]);
  const baked = applyRigLayers(c, [layer]);
  const rotChange = qangle(world(baked, fKey).rot[arm], world(c, fKey).rot[arm]);
  const jointDrift = dist(world(baked, fKey).pos[arm], world(c, fKey).pos[arm]);
  const handMoved = dist(world(baked, fKey).pos[handL], world(c, fKey).pos[handL]);
  const legDrift = dist(world(baked, fKey).pos[boneI("LeftFoot")], world(c, fKey).pos[boneI("LeftFoot")]);
  check("FK arm rot: world rotation changes by the delta", Math.abs(rotChange - 25) < 0.1, `rotated ${rotChange.toFixed(2)}°`);
  check("FK arm rot: joint stays in place, hand follows FK",
    jointDrift < 1e-9 && handMoved > 0.05 && legDrift < 1e-9,
    `joint drift ${mm(jointDrift)}mm, hand moved ${mm(handMoved)}mm`);
}

// --- 7. a hand edit leaves the legs alone -------------------------------------
{
  const layer = makeLayer("L1");
  setPosKey(getTrack(layer, "rightHand", true), tKey, [0.06, 0.04, 0]);
  const baked = applyRigLayers(c, [layer]);
  let worst = 0;
  for (const b of ["LeftUpperLeg", "LeftFoot", "RightUpperLeg", "RightFoot", "Head", "Hips", "LeftHand"]) {
    worst = Math.max(worst, dist(world(baked, fKey).pos[boneI(b)], world(c, fKey).pos[boneI(b)]));
  }
  check("isolation: hand edit leaves the rest of the body", worst < 1e-6, `worst other-bone drift ${mm(worst)}mm`);
}

// --- 1d. key easing + euler round-trip -----------------------------------------
{
  const { setKeyEase } = await import("../src/rig/rig.ts");
  const { quatToEulerZYX, eulerZYXToQuat } = await import("../src/convert/quat.ts");
  // Euler round-trip on 200 random-ish quats
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const a = Math.sin(i * 1.7) * 2, b = Math.cos(i * 0.9) * 1.2, cc = Math.sin(i * 2.3) * 2.8;
    const n = Math.hypot(a, b, cc, 1);
    const q = [a / n, b / n, cc / n, 1 / n];
    const back = eulerZYXToQuat(quatToEulerZYX(q));
    worst = Math.max(worst, qangle(q, back));
  }
  check("euler ZYX round-trip exact", worst < 1e-4, `worst ${worst.toExponential(1)}°`);

  // Step ease holds until the next key; smooth differs from linear mid-segment.
  const layer = makeLayer("L1");
  layer.extent = "hold";
  const tr = getTrack(layer, "hips", true);
  setPosKey(tr, 4, [0, 0, 0]);
  setPosKey(tr, 6, [0, 0.1, 0]);
  const hips = boneI("Hips");
  const fMid = nearestFrame(c, 5);
  const linLift = world(applyRigLayers(c, [layer]), fMid).pos[hips][1] - world(c, fMid).pos[hips][1];
  setKeyEase(tr, 4, "step");
  const stepLift = world(applyRigLayers(c, [layer]), fMid).pos[hips][1] - world(c, fMid).pos[hips][1];
  setKeyEase(tr, 4, "smooth");
  const fQ = nearestFrame(c, 4.5); // quarter point: smooth < linear
  const smoothQ = world(applyRigLayers(c, [layer]), fQ).pos[hips][1] - world(c, fQ).pos[hips][1];
  setKeyEase(tr, 4, "linear");
  const linQ = world(applyRigLayers(c, [layer]), fQ).pos[hips][1] - world(c, fQ).pos[hips][1];
  check("ease: step holds, smooth lags linear early in the segment",
    Math.abs(stepLift) < 0.0005 && Math.abs(linLift - 0.05) < 0.003 && smoothQ < linQ - 0.005,
    `step ${mm(stepLift)}mm, linear-mid ${mm(linLift)}mm, quarter smooth ${mm(smoothQ)} < linear ${mm(linQ)}`);
}

// --- 7b. partial (dirty-range) rebake === full rebake --------------------------
{
  const layer = makeLayer("L1"); // fade 0.5s
  const tr = getTrack(layer, "rightHand", true);
  setPosKey(tr, 3, [0.03, 0, 0]);
  setPosKey(tr, 6, [0, 0.05, 0]);
  setPosKey(tr, 9, [0.02, 0.02, 0]);
  const layers = [layer];

  // Baked state before the edit (in-place arrays, like the app's display clip).
  const pos = c.localPos.map((t) => t.map((p) => [...p]));
  const quat = c.localQuat.map((t) => t.map((q) => [...q]));
  bakeRange(c, layers, pos, quat);

  // Edit the middle key, then bake ONLY its dirty window in place.
  const dirty = dirtyRange(layer, tr, 6);
  setPosKey(tr, 6, [0, -0.04, 0.03]);
  bakeRange(c, layers, pos, quat, dirty);

  // Reference: full bake from scratch with the edited keys.
  const full = applyRigLayers(c, layers);
  let worst = 0;
  for (let b = 0; b < c.names.length; b++) {
    // Degenerate zero-quat tracks (missing bones) break the dot metric.
    if (c.localQuat[b].some((q) => Math.hypot(...q) < 0.5)) continue;
    for (let f = 0; f < frames; f += 7) {
      worst = Math.max(worst, dist(pos[b][f], full.localPos[b][f]));
      const d = 1 - Math.abs(quat[b][f][0]*full.localQuat[b][f][0] + quat[b][f][1]*full.localQuat[b][f][1] + quat[b][f][2]*full.localQuat[b][f][2] + quat[b][f][3]*full.localQuat[b][f][3]);
      worst = Math.max(worst, d);
    }
  }
  check("partial rebake: identical to a full rebake", worst < 1e-9, `worst deviation ${worst.toExponential(1)}`);

  // And it must be much cheaper: count frames the dirty window covers.
  const covered = c.times.filter((t) => t >= dirty.t0 && t <= dirty.t1).length;
  check("partial rebake: dirty window is a small slice", covered < frames / 4, `${covered} of ${frames} frames`);
}

// --- 8. modifiers -------------------------------------------------------------
{
  const { applyModifiers, defaultModifiers } = await import("../src/rig/modifiers.ts");
  const hips = boneI("Hips"), lknee = boneI("LeftLowerLeg"), rknee = boneI("RightLowerLeg");
  const lank = boneI("LeftFoot"), rank = boneI("RightFoot");
  const lelbow = boneI("LeftLowerArm"), lwrist = boneI("LeftHand"), lshoulder = boneI("LeftUpperArm");

  // A straight limb has nothing to swing about its end-to-end axis, so run
  // the in/out tests at the frame where the joint is most bent (largest
  // perpendicular offset of the mid joint from the root→end line).
  const bentFrame = (root, mid, end) => {
    let best = 0, bestR = -1;
    for (let f = 0; f < c.times.length; f += 25) {
      const w = world(c, f);
      const a = w.pos[root], b = w.pos[end], k = w.pos[mid];
      const ab = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
      const ab2 = ab[0]**2+ab[1]**2+ab[2]**2 || 1;
      const t = ((k[0]-a[0])*ab[0]+(k[1]-a[1])*ab[1]+(k[2]-a[2])*ab[2]) / ab2;
      const px = [a[0]+ab[0]*t, a[1]+ab[1]*t, a[2]+ab[2]*t];
      const r = dist(k, px);
      if (r > bestR) { bestR = r; best = f; }
    }
    return best;
  };

  // hips height: hips drop, feet stay planted
  {
    const baked = applyModifiers(c, { ...defaultModifiers(), hipsHeightCm: -6 });
    const w0 = world(c, fKey), w1 = world(baked, fKey);
    const drop = w0.pos[hips][1] - w1.pos[hips][1];
    const ankleDrift = Math.max(dist(w0.pos[lank], w1.pos[lank]), dist(w0.pos[rank], w1.pos[rank]));
    check("modifier hips -6cm: hips drop 6cm", Math.abs(drop - 0.06) < 0.002, `dropped ${mm(drop)}mm`);
    check("modifier hips: feet stay planted", ankleDrift < 0.002, `ankle drift ${mm(ankleDrift)}mm`);
  }

  // knees out: knees swing outward, hips + ankles pinned
  {
    const fBent = bentFrame(boneI("LeftUpperLeg"), lknee, lank);
    const baked = applyModifiers(c, { ...defaultModifiers(), kneesOutDeg: 15 });
    const w0 = world(c, fBent), w1 = world(baked, fBent);
    // lateral direction = perpendicular offset of the knee from the hip→ankle line
    const lateralX = (w, knee, hip, ank) => {
      const a = w.pos[hip], b = w.pos[ank], k = w.pos[knee];
      const ab = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
      const t = ((k[0]-a[0])*ab[0]+(k[1]-a[1])*ab[1]+(k[2]-a[2])*ab[2]) / (ab[0]**2+ab[1]**2+ab[2]**2);
      return k[0] - (a[0] + ab[0]*t);
    };
    const lBefore = lateralX(w0, lknee, boneI("LeftUpperLeg"), lank);
    const lAfter = lateralX(w1, lknee, boneI("LeftUpperLeg"), lank);
    const rBefore = lateralX(w0, rknee, boneI("RightUpperLeg"), rank);
    const rAfter = lateralX(w1, rknee, boneI("RightUpperLeg"), rank);
    const ankleDrift = Math.max(dist(w0.pos[lank], w1.pos[lank]), dist(w0.pos[rank], w1.pos[rank]));
    check("modifier knees out: left knee swings +x, right -x",
      lAfter > lBefore + 0.005 && rAfter < rBefore - 0.005,
      `left ${mm(lBefore)}→${mm(lAfter)}mm right ${mm(rBefore)}→${mm(rAfter)}mm`);
    check("modifier knees: hips + ankles untouched",
      ankleDrift < 1e-6 && dist(w0.pos[hips], w1.pos[hips]) < 1e-9, `ankle drift ${mm(ankleDrift)}mm`);
  }

  // elbows out: wrist + shoulder pinned, elbow moves
  {
    const fBent = bentFrame(lshoulder, lelbow, lwrist);
    const baked = applyModifiers(c, { ...defaultModifiers(), elbowsOutDeg: 15 });
    const w0 = world(c, fBent), w1 = world(baked, fBent);
    const wristDrift = dist(w0.pos[lwrist], w1.pos[lwrist]);
    const shoulderDrift = dist(w0.pos[lshoulder], w1.pos[lshoulder]);
    const elbowMove = dist(w0.pos[lelbow], w1.pos[lelbow]);
    check("modifier elbows out: elbow swings, wrist + shoulder pinned",
      elbowMove > 0.005 && wristDrift < 1e-6 && shoulderDrift < 1e-9,
      `elbow moved ${mm(elbowMove)}mm, wrist drift ${mm(wristDrift)}mm`);
  }

  // feet apart: each ankle shifts outward, height unchanged
  {
    const baked = applyModifiers(c, { ...defaultModifiers(), feetApartCm: 8 });
    const w0 = world(c, fKey), w1 = world(baked, fKey);
    const gap0 = Math.abs(w0.pos[lank][0] - w0.pos[rank][0]);
    const gap1 = Math.abs(w1.pos[lank][0] - w1.pos[rank][0]);
    check("modifier feet apart: stance widens ~16cm",
      Math.abs(gap1 - gap0 - 0.16) < 0.03, `gap ${mm(gap0)}→${mm(gap1)}mm`);
  }
}

if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
