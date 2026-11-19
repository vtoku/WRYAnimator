// Headless edit pipeline: the same stage order the editor runs (main.ts
// buildDisplay + doExport), with every input passed in as plain data instead
// of read from the DOM. Pure — no DOM, no node: imports, no three — so it runs
// under the CLI / MCP server (cli/) and typechecks with the browser build.
//
// KEEP IN SYNC with main.ts buildDisplay()/doExport(): if a stage is added or
// reordered there, mirror it here (scripts/cliCheck.mjs guards the basics).
import type { Vec3 } from "../wanim/parse.ts";
import {
  type ConvertedClip,
  retargetProportions,
  distributeBonelessSpine,
} from "../convert/clip.ts";
import {
  type CleanOpts,
  type CleanStats,
  type CleanOp,
  type RangeSmooth,
  cleanClip,
  smoothRange,
  applyCleanOps,
} from "../convert/clean.ts";
import type { PlantSpan } from "../convert/feet.ts";
import { type LoopOp, makeLoop } from "../convert/loop.ts";
import { type Modifiers, defaultModifiers, anyReach, anyModifiers, applyModifiers, applyReach } from "../rig/modifiers.ts";
import { type RigLayer, applyRigLayers } from "../rig/rig.ts";
import { type WarpKey, anyWarp, applyTimeWarp } from "../rig/timewarp.ts";

/** Every edit that changes the motion, as stored in a scene / .rig.json. */
export interface Edits {
  clean: CleanOpts;
  /** "recorded" keeps the recording's own skeleton; "body" fits the body mesh's. */
  proportions: "recorded" | "body";
  distSpine: boolean;
  /** Spine-spread amount, 0..1. */
  distSpineAmt: number;
  warp: WarpKey[];
  ranges: RangeSmooth[];
  cleanOps: CleanOp[];
  loop: LoopOp | null;
  mods: Modifiers;
  layers: RigLayer[];
}

export const defaultEdits = (): Edits => ({
  clean: {},
  proportions: "recorded",
  distSpine: false,
  distSpineAmt: 0.5,
  warp: [],
  ranges: [],
  cleanOps: [],
  loop: null,
  mods: defaultModifiers(),
  layers: [],
});

/** Resolves the body-mesh skeleton's joints for a clip (proportions: "body"). */
export type BodyJointsFn = (parents: number[], bindPos: Vec3[], names: string[]) => (Vec3 | null)[];

export interface PipelineOpts {
  /**
   * "display" = what the editor shows and FBX/VRMA export (proportions apply);
   * "wanim" = the .wanim re-export path (always the RECORDED proportions — a
   * body-mesh fit has no meaning in a .wanim).
   */
  target: "display" | "wanim";
  /** Required when edits.proportions === "body" and target === "display". */
  bodyJoints?: BodyJointsFn;
  /** Filled with what the global cleaning filters changed. */
  stats?: CleanStats;
}

const anyCleanFilter = (o: CleanOpts): boolean =>
  !!(o.despike || o.smooth || o.limitWrists || o.lockWrists || o.limitLowerArms || o.lockLowerArmTwist || o.fixFeet);

export const emptyCleanStats = (): CleanStats => ({
  despiked: 0,
  wristClamped: 0,
  forearmClamped: 0,
  smoothedMeanDeg: 0,
});

/**
 * Run the full edit stack over a converted clip. Never mutates its input, and
 * hands back the SAME arrays for anything no stage touched (so callers can
 * tell edited cells from untouched ones cheaply). Synchronous: the body
 * skeleton, when needed, must already be loaded.
 */
export function runPipeline(
  converted: ConvertedClip,
  edits: Edits,
  opts: PipelineOpts,
): ConvertedClip {
  const useBody = opts.target === "display" && edits.proportions === "body";
  if (useBody && !opts.bodyJoints) throw new Error("proportions 'body' needs a body skeleton source");

  /** Proportions + spine spread — shared by the cleaned clip and the reach reference. */
  const shape = (c: ConvertedClip): ConvertedClip => {
    let out = c;
    if (useBody) out = retargetProportions(out, opts.bodyJoints!(out.parents, out.bindPos, out.names));
    if (edits.distSpine) out = distributeBonelessSpine(out, edits.distSpineAmt);
    return out;
  };

  // Time warp first: everything downstream lives on the warped timeline.
  const source = anyWarp(edits.warp) ? applyTimeWarp(converted, edits.warp) : converted;
  let clip = anyCleanFilter(edits.clean) ? cleanClip(source, edits.clean, opts.stats) : source;
  for (const r of edits.ranges) clip = smoothRange(clip, r);
  clip = applyCleanOps(clip, edits.cleanOps);
  if (edits.loop) clip = makeLoop(clip, edits.loop);
  clip = shape(clip);
  if (anyModifiers(edits.mods)) clip = applyModifiers(clip, edits.mods);
  if (anyReach(edits.mods)) {
    // Reach pulls limb endpoints back toward the UNCLEANED path.
    clip = applyReach(clip, applyModifiers(shape(source), edits.mods), edits.mods);
  }
  return applyRigLayers(clip, edits.layers);
}

// ---- scene / rig files -------------------------------------------------------

/** A `<name>.scene.json` saved by the editor (see SceneFile in main.ts). */
export interface SceneDoc {
  magic: "wanimscene";
  v: number;
  name: string;
  source?: "wanim" | "fbx" | "body";
  settings?: Record<string, unknown>;
  rig?: Record<string, unknown>;
  wanim?: string;
  fbx?: string;
  body?: { name: string; data: string };
}

export const isSceneDoc = (v: unknown): v is SceneDoc =>
  !!v && typeof v === "object" && (v as { magic?: unknown }).magic === "wanimscene";

/** Export-side settings a scene carries (not part of the motion itself). */
export interface ExportSettings {
  fps: number;
  speed: number;
  names: "unity" | "motionbuilder";
  rest: "tpose" | "first";
  face: boolean;
  trim: { start: number; end: number } | null;
}

export const defaultExportSettings = (): ExportSettings => ({
  fps: 60,
  speed: 1,
  names: "unity",
  rest: "tpose",
  face: true,
  trim: null,
});

/**
 * Merge a rig-state object (scene.rig or a standalone .rig.json) into edits.
 * Mirrors adoptRigState in main.ts, including dropping pre-v0.26 effector-space
 * layers that can't be converted. Returns notes about anything dropped.
 */
export function adoptRigDoc(edits: Edits, d: Record<string, unknown>): string[] {
  const notes: string[] = [];
  if (Array.isArray(d.layers)) {
    const all = d.layers as RigLayer[];
    const layers = all.filter((l) =>
      (l.tracks ?? []).every((tr) => typeof (tr as { bone?: unknown }).bone === "string"));
    if (layers.length < all.length) {
      notes.push(`${all.length - layers.length} rig layer(s) from before v0.26 dropped (key format changed)`);
    }
    for (const layer of layers) {
      layer.extent ??= "hold";
      layer.fadeS ??= 0.5;
    }
    edits.layers = layers;
  }
  if (d.mods && typeof d.mods === "object") edits.mods = { ...defaultModifiers(), ...(d.mods as Partial<Modifiers>) };
  if (Array.isArray(d.warp)) edits.warp = d.warp as WarpKey[];
  if (Array.isArray(d.ranges)) edits.ranges = d.ranges as RangeSmooth[];
  if (Array.isArray(d.cleanOps)) edits.cleanOps = (d.cleanOps as CleanOp[]).filter((o) => o.id !== "__preview");
  if ("loop" in d) edits.loop = (d.loop as LoopOp | null) ?? null;
  if (Array.isArray(d.feetPlants) && d.feetPlants.length) {
    edits.clean = { ...edits.clean, feetEdits: { removed: d.feetPlants as PlantSpan[] } };
  }
  return notes;
}

/** Read a scene's settings + rig state into edits and export settings. */
export function sceneToEdits(scene: SceneDoc): { edits: Edits; exp: ExportSettings; notes: string[] } {
  const edits = defaultEdits();
  const exp = defaultExportSettings();
  const s = scene.settings ?? {};
  if (s.clean && typeof s.clean === "object") edits.clean = { ...(s.clean as CleanOpts) };
  // The editor's default is the body-mesh skeleton; a scene records its choice.
  edits.proportions = s.proportions === "body" ? "body" : "recorded";
  edits.distSpine = !!s.distSpine;
  const amt = Number(s.distSpineAmt);
  if (Number.isFinite(amt) && amt > 0) edits.distSpineAmt = amt / 100; // stored as a percent
  const fps = Number(s.fps);
  if (Number.isFinite(fps) && fps >= 1) exp.fps = Math.min(240, fps);
  if (typeof s.speed === "number" && s.speed > 0) exp.speed = Math.min(4, Math.max(0.25, s.speed));
  if (s.names === "unity" || s.names === "motionbuilder") exp.names = s.names;
  if (s.rest === "tpose" || s.rest === "first") exp.rest = s.rest;
  if (typeof s.face === "boolean") exp.face = s.face;
  const trim = s.trim as { start?: unknown; end?: unknown } | undefined;
  if (trim && typeof trim.start === "number" && typeof trim.end === "number") {
    exp.trim = { start: trim.start, end: trim.end };
  }
  const notes = scene.rig ? adoptRigDoc(edits, scene.rig) : [];
  return { edits, exp, notes };
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- description -------------------------------------------------------------

export interface ClipSummary {
  frames: number;
  durationS: number;
  /** Recorded timestamps are variable-rate; these describe the spread. */
  avgFps: number;
  minDtMs: number;
  maxDtMs: number;
  /** times[0] — recordings can start nonzero; all edit times are relative to it. */
  startTimeS: number;
  bones: number;
  /** Bones recorded as all-zero quaternions (absent on the avatar). */
  deadBones: string[];
  faceChannels: string[];
  hips: { startM: Vec3; minM: Vec3; maxM: Vec3; travelM: number };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export function summarizeClip(c: ConvertedClip): ClipSummary {
  const frames = c.times.length;
  let minDt = Infinity;
  let maxDt = 0;
  for (let f = 1; f < frames; f++) {
    const dt = c.times[f] - c.times[f - 1];
    if (dt < minDt) minDt = dt;
    if (dt > maxDt) maxDt = dt;
  }
  const deadBones = c.names.filter((_, b) => {
    const q = c.localQuat[b][0];
    return !q || Math.hypot(q[0], q[1], q[2], q[3]) < 0.5;
  });
  const hips = c.localPos[0];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let travel = 0;
  for (let f = 0; f < frames; f++) {
    const p = hips[f];
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
    if (f > 0) travel += Math.hypot(p[0] - hips[f - 1][0], p[2] - hips[f - 1][2]);
  }
  const start = hips[0] ?? [0, 0, 0];
  return {
    frames,
    durationS: r3(c.duration),
    avgFps: c.duration > 0 ? r3((frames - 1) / c.duration) : 0,
    minDtMs: frames > 1 ? r3(minDt * 1000) : 0,
    maxDtMs: r3(maxDt * 1000),
    startTimeS: r3(c.times[0] ?? 0),
    bones: c.names.length,
    deadBones,
    faceChannels: c.face?.names ?? [],
    hips: {
      startM: [r3(start[0]), r3(start[1]), r3(start[2])],
      minM: frames ? [r3(min[0]), r3(min[1]), r3(min[2])] : [0, 0, 0],
      maxM: frames ? [r3(max[0]), r3(max[1]), r3(max[2])] : [0, 0, 0],
      travelM: r3(travel),
    },
  };
}

/** Collapse frame indices into run-start playback times (one mark per event). */
export function runStartTimes(c: ConvertedClip, frames: Iterable<number>): number[] {
  const s = new Set(frames);
  const off = c.times[0] ?? 0;
  return [...s]
    .filter((f) => !s.has(f - 1))
    .sort((a, b) => a - b)
    .map((f) => r3((c.times[f] ?? off) - off));
}
