// Unity humanoid .anim writer (BETA) — a text (YAML) AnimationClip holding
// muscle curves, RootT / RootQ and blendshape curves. It retargets onto any
// humanoid avatar in Unity (and so in Warudo's Unity-based pipeline).
//
// The muscle math lives in humanoid.ts and was measured against Unity; read
// the header there for what is exact and what is approximate. Like FBX and
// VRMA this is a RESAMPLED export: fixed-rate keys, not the recording's own
// timestamps.
import type { ResampledClip } from "../convert/clip.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";
import { MUSCLE_COUNT, buildHumanoidRig, muscleAttribute, poseToHuman, type HumanPoseFrame } from "./humanoid.ts";

export interface AnimOptions {
  /** Clip name (m_Name). */
  name?: string;
  /** Recorded blendshape tracks (0–1), written as `blendShape.<name>` curves (0–100). */
  face?: { names: string[]; tracks: Float32Array[] } | null;
  /** Hierarchy path of the SkinnedMeshRenderer that owns the blendshapes. VRM imports usually name it "Face". */
  facePath?: string;
  /** T-pose hips height above the ground, meters. Default: estimated from where the feet rest in the take. */
  hipsHeight?: number;
  /** Mark the clip as looping. */
  loop?: boolean;
  /**
   * Key reduction: largest allowed deviation in muscle units for a finger curve (0 = keep every
   * frame). Arms use half of it and the spine and legs a quarter, because an error there moves the
   * hands and feet much further. Default 0.002 (fingers about 0.2°, legs about 0.04°).
   */
  tolerance?: number;
}

export interface AnimReport {
  frames: number;
  fps: number;
  durationS: number;
  /** T-pose hips height used (meters) and where it came from. */
  hipsHeightM: number;
  hipsHeightFrom: "option" | "feet at rest" | "leg length" | "first frame";
  humanScale: number;
  muscleCurves: number;
  blendshapeCurves: number;
  keys: number;
  keysBeforeReduction: number;
  /** Largest |muscle| written; values past ±1 are outside Unity's default joint range. */
  maxMuscle: number;
}

const SKIP_FACE = new Set(["trackingstatus"]);

/** Key-reduction tolerance scale per muscle index (see AnimOptions.tolerance). */
function toleranceScale(m: number): number {
  if (m <= 8) return 0.25;              // spine, chest, upper chest
  if (m <= 14) return 0.5;              // neck, head
  if (m <= 20) return 1;                // eyes, jaw
  if (m === 28 || m === 36) return 1;   // toes
  if (m <= 36) return 0.25;             // legs, feet
  if (m <= 54) return 0.5;              // shoulders, arms, hands
  return 1;                             // fingers
}

const toUnityPos = (p: Vec3): Vec3 => [-p[0], p[1], p[2]];
const toUnityQuat = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];

/** Where the ankles sit when the feet are planted: the 5th-percentile height of the lower ankle. */
function restAnkleHeight(clip: ResampledClip): number | null {
  const n = clip.names;
  const chain = (side: string): number[] => [n.indexOf(`${side}UpperLeg`), n.indexOf(`${side}LowerLeg`), n.indexOf(`${side}Foot`)];
  const chains = [chain("Left"), chain("Right")].filter((c) => c.every((b) => b >= 0));
  if (!chains.length || clip.frameCount < 1) return null;
  const mulQ = (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const rotY = (q: Quat, v: Vec3): number => {
    const tx = 2 * (q[1] * v[2] - q[2] * v[1]), tz = 2 * (q[0] * v[1] - q[1] * v[0]), ty = 2 * (q[2] * v[0] - q[0] * v[2]);
    return v[1] + q[3] * ty + (q[2] * tx - q[0] * tz);
  };
  const live = (q: Quat): Quat => (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] < 0.25 ? [0, 0, 0, 1] : q);
  const ys: number[] = [];
  for (let f = 0; f < clip.frameCount; f++) {
    let low = Infinity;
    for (const [u, l, e] of chains) {
      const rH = live(clip.localQuat[0][f]);
      const rU = mulQ(rH, live(clip.localQuat[u][f]));
      const rL = mulQ(rU, live(clip.localQuat[l][f]));
      const y = clip.localPos[0][f][1] + rotY(rH, clip.bindPos[u]) + rotY(rU, clip.bindPos[l]) + rotY(rL, clip.bindPos[e]);
      if (y < low) low = y;
    }
    ys.push(low);
  }
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length * 0.05)];
}

/** Indexes of the keys to keep so linear interpolation stays within `tol` of every sample. */
function reduce(v: ArrayLike<number>, tol: number): number[] {
  const n = v.length;
  if (n <= 2) return n === 2 ? [0, 1] : [0];
  if (tol <= 0) return Array.from({ length: n }, (_, i) => i);
  const keep = [0];
  let a = 0;
  while (a < n - 1) {
    // Grow the segment while every sample inside it stays on the chord. The chord a→c
    // passes within tol of sample i iff its slope lies in [(v_i−tol−v_a)/(i−a),
    // (v_i+tol−v_a)/(i−a)]; intersecting those windows as c advances makes this linear.
    let b = a + 1;
    let lo = -Infinity, hi = Infinity;
    for (let c = a + 1; c < n; c++) {
      const d = c - a;
      const slope = (v[c] - v[a]) / d;
      if (slope < lo || slope > hi) break;
      b = c;
      lo = Math.max(lo, (v[c] - tol - v[a]) / d);
      hi = Math.min(hi, (v[c] + tol - v[a]) / d);
    }
    keep.push(b);
    a = b;
  }
  return keep;
}

/** A YAML plain scalar when that is safe, else single-quoted ('' escapes a quote). */
const yamlScalar = (x: string): string =>
  x === "" || /^[\p{L}\p{N}_/.\-+() ]+$/u.test(x) && !/^[\s\-]|\s$/.test(x) ? x : `'${x.replace(/'/g, "''")}'`;

const num = (x: number, digits = 5): string => {
  if (!Number.isFinite(x)) return "0";
  const k = 10 ** digits;
  const r = Math.round(x * k) / k;
  return r === 0 ? "0" : String(r); // at least 1e-5 in magnitude, so never exponent form
};

export function writeUnityAnim(clip: ResampledClip, opts: AnimOptions = {}): { bytes: Uint8Array; report: AnimReport } {
  const { frameCount: F, fps, names, parents } = clip;
  const B = names.length;

  // ---- skeleton + pose in Unity space ---------------------------------------------
  const bind = clip.bindPos.map(toUnityPos);
  const legDrop = (side: string): number => {
    const ids = [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`].map((x) => names.indexOf(x));
    return ids.every((b) => b >= 0) ? -ids.reduce((s, b) => s + clip.bindPos[b][1], 0) : NaN;
  };
  const drop = [legDrop("Left"), legDrop("Right")].filter((x) => Number.isFinite(x));
  const rest = restAnkleHeight(clip);
  let hipsHeight: number;
  let hipsHeightFrom: AnimReport["hipsHeightFrom"];
  if (opts.hipsHeight !== undefined && !(Number.isFinite(opts.hipsHeight) && opts.hipsHeight > 0)) {
    throw new Error(`T-pose hips height must be a positive number of meters (got ${opts.hipsHeight})`);
  }
  if (opts.tolerance !== undefined && !(Number.isFinite(opts.tolerance) && opts.tolerance >= 0)) {
    throw new Error(`key tolerance must be zero or a positive number (got ${opts.tolerance})`);
  }
  const legLength = drop.length ? drop.reduce((a, b) => a + b, 0) / drop.length : NaN;
  if (opts.hipsHeight !== undefined) { hipsHeight = opts.hipsHeight; hipsHeightFrom = "option"; }
  else if (rest !== null && Number.isFinite(legLength) && rest + legLength > 0.5 * legLength) {
    hipsHeight = rest + legLength; hipsHeightFrom = "feet at rest";
  } else if (Number.isFinite(legLength) && legLength > 0) {
    // The floor is not near y = 0 (character root moved): ankles about 8% of the leg up.
    hipsHeight = legLength * 1.08; hipsHeightFrom = "leg length";
  } else {
    const y = F ? clip.localPos[0][0][1] : 1;
    hipsHeight = y > 0.1 ? y : 1; hipsHeightFrom = "first frame";
  }
  // A bone the recording never drove is stored as an all-zero quaternion: the avatar lacks it.
  const present = names.map((_, b) => { const q = clip.localQuat[b][0]; return !q || q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] >= 0.25; });
  const rig = buildHumanoidRig(parents, bind, hipsHeight, present);

  const muscles = Array.from({ length: MUSCLE_COUNT }, () => new Float32Array(F));
  const rootT = [new Float32Array(F), new Float32Array(F), new Float32Array(F)];
  const rootQ = [new Float32Array(F), new Float32Array(F), new Float32Array(F), new Float32Array(F)];
  const local: Quat[] = new Array(B);
  let frame: HumanPoseFrame | undefined;
  let prevQ: Quat | null = null;
  let maxMuscle = 0;
  for (let f = 0; f < F; f++) {
    for (let b = 0; b < B; b++) {
      const q = clip.localQuat[b][f];
      // A non-finite sample keeps the previous frame's value (the solver tracks twist through time).
      if (Number.isFinite(q[0] + q[1] + q[2] + q[3]) || !local[b]) local[b] = toUnityQuat(Number.isFinite(q[0] + q[1] + q[2] + q[3]) ? q : [0, 0, 0, 1]);
    }
    frame = poseToHuman(rig, local, toUnityPos(clip.localPos[0][f]), frame);
    for (let m = 0; m < MUSCLE_COUNT; m++) { const v = frame.muscles[m]; muscles[m][f] = v; if (Math.abs(v) > maxMuscle) maxMuscle = Math.abs(v); }
    let q = frame.bodyRot;
    // Curves interpolate per component: keep the quaternion on one hemisphere.
    if (prevQ && q[0] * prevQ[0] + q[1] * prevQ[1] + q[2] * prevQ[2] + q[3] * prevQ[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    prevQ = q;
    for (let k = 0; k < 3; k++) rootT[k][f] = frame.bodyPos[k];
    for (let k = 0; k < 4; k++) rootQ[k][f] = q[k];
  }

  // ---- curves -----------------------------------------------------------------------
  const tol = opts.tolerance ?? 0.002;
  const out: string[] = [];
  let keys = 0, keysBefore = 0;
  const curve = (attribute: string, path: string, classID: number, v: ArrayLike<number>, tolerance: number): void => {
    const keep = reduce(v, tolerance);
    keys += keep.length; keysBefore += v.length;
    out.push("  - serializedVersion: 2\n    curve:\n      serializedVersion: 2\n      m_Curve:\n");
    for (let i = 0; i < keep.length; i++) {
      const k = keep[i];
      const slopeIn = i > 0 ? ((v[k] - v[keep[i - 1]]) / (k - keep[i - 1])) * fps : 0;
      const slopeOut = i < keep.length - 1 ? ((v[keep[i + 1]] - v[k]) / (keep[i + 1] - k)) * fps : 0;
      // Flow style, and no weight fields (they default to 0 and are unused without weighted
      // tangents): a long take is millions of keys, so every byte per key counts.
      out.push(`      - {serializedVersion: 3, time: ${num(k / fps, 4)}, value: ${num(v[k])}, inSlope: ${num(i > 0 ? slopeIn : slopeOut)}, outSlope: ${num(i < keep.length - 1 ? slopeOut : slopeIn)}, tangentMode: 0}\n`);
    }
    out.push(`      m_PreInfinity: 2\n      m_PostInfinity: 2\n      m_RotationOrder: 4\n    attribute: ${attribute}\n    path: ${path}\n    classID: ${classID}\n    script: {fileID: 0}\n    flags: 16\n`);
  };

  for (let m = 0; m < MUSCLE_COUNT; m++) curve(muscleAttribute(m), "", 95, muscles[m], tol * toleranceScale(m));
  // Root: about 0.1 mm of travel (RootT is in body heights) and about 0.01° of turn.
  ["RootT.x", "RootT.y", "RootT.z"].forEach((a, k) => curve(a, "", 95, rootT[k], tol * 0.05));
  ["RootQ.x", "RootQ.y", "RootQ.z", "RootQ.w"].forEach((a, k) => curve(a, "", 95, rootQ[k], tol * 0.05));
  let blendshapeCurves = 0;
  if (opts.face) {
    const facePath = yamlScalar((opts.facePath ?? "Face").replace(/[\r\n]/g, ""));
    opts.face.names.forEach((n, i) => {
      if (SKIP_FACE.has(n.toLowerCase()) || !/^[\p{L}\p{N}_ .\-+()]+$/u.test(n)) return;
      const t = opts.face!.tracks[i];
      const scaled = new Float32Array(F);
      for (let f = 0; f < F; f++) scaled[f] = (t[f] ?? 0) * 100;
      curve(`blendShape.${n}`, facePath, 137, scaled, tol * 100);
      blendshapeCurves++;
    });
  }

  const duration = F > 1 ? (F - 1) / fps : 0;
  const name = (opts.name ?? "WRYAnimator").replace(/[^\w .\-()]/g, "_") || "WRYAnimator";
  const loop = opts.loop ? 1 : 0;
  const head =
    "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!74 &7400000\nAnimationClip:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n" +
    `  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  m_Name: ${name}\n  serializedVersion: 7\n  m_Legacy: 0\n  m_Compressed: 0\n  m_UseHighQualityCurve: 1\n` +
    "  m_RotationCurves: []\n  m_CompressedRotationCurves: []\n  m_EulerCurves: []\n  m_PositionCurves: []\n  m_ScaleCurves: []\n  m_FloatCurves:\n";
  // The motion is baked into the pose (root transform untouched) and kept exactly as recorded.
  const tail =
    `  m_PPtrCurves: []\n  m_SampleRate: ${num(fps)}\n  m_WrapMode: 0\n  m_Bounds:\n    m_Center: {x: 0, y: 0, z: 0}\n    m_Extent: {x: 0, y: 0, z: 0}\n` +
    "  m_ClipBindingConstant:\n    genericBindings: []\n    pptrCurveMapping: []\n  m_AnimationClipSettings:\n    serializedVersion: 2\n" +
    `    m_AdditiveReferencePoseClip: {fileID: 0}\n    m_AdditiveReferencePoseTime: 0\n    m_StartTime: 0\n    m_StopTime: ${num(duration)}\n    m_OrientationOffsetY: 0\n    m_Level: 0\n` +
    `    m_CycleOffset: 0\n    m_HasAdditiveReferencePose: 0\n    m_LoopTime: ${loop}\n    m_LoopBlend: 0\n    m_LoopBlendOrientation: 1\n    m_LoopBlendPositionY: 1\n    m_LoopBlendPositionXZ: 1\n` +
    "    m_KeepOriginalOrientation: 1\n    m_KeepOriginalPositionY: 1\n    m_KeepOriginalPositionXZ: 1\n    m_HeightFromFeet: 0\n    m_Mirror: 0\n" +
    "  m_EditorCurves: []\n  m_EulerEditorCurves: []\n  m_HasGenericRootTransform: 0\n  m_HasMotionFloatCurves: 0\n  m_Events: []\n";

  // Encode in pieces: one giant string would exceed engine limits on long takes.
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(head)];
  let size = parts[0].length;
  const CHUNK = 4096;
  for (let i = 0; i < out.length; i += CHUNK) { const p = enc.encode(out.slice(i, i + CHUNK).join("")); parts.push(p); size += p.length; }
  const t = enc.encode(tail); parts.push(t); size += t.length;
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }

  return {
    bytes,
    report: {
      frames: F, fps, durationS: Math.round(duration * 1000) / 1000,
      hipsHeightM: Math.round(hipsHeight * 1e4) / 1e4, hipsHeightFrom,
      humanScale: Math.round(rig.humanScale * 1e4) / 1e4,
      muscleCurves: MUSCLE_COUNT, blendshapeCurves, keys, keysBeforeReduction: keysBefore,
      maxMuscle: Math.round(maxMuscle * 1000) / 1000,
    },
  };
}
