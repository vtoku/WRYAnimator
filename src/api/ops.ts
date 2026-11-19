// The operation table: ONE list of every session operation with its name,
// description, JSON-schema arguments and implementation. The MCP server turns
// each entry into a tool, the CLI runs them from flags or an edit script, and
// the web app's `window.wry` can expose the same table — so the three front
// ends cannot drift apart. Pure TS.
import { type Session, ApiError } from "./session.ts";

type Schema = Record<string, unknown>;

export interface OpDef {
  /** Dotted name used in edit scripts and the CLI, e.g. "limit.apply". */
  name: string;
  title: string;
  description: string;
  /** True when it changes the session (undoable); false = read-only. */
  mutates: boolean;
  properties: Record<string, Schema>;
  required: string[];
  run(s: Session, args: Record<string, unknown>): unknown;
}

const BONES: Schema = {
  type: "array",
  items: { type: ["string", "integer"] },
  description:
    "Bones to act on: Unity HumanBodyBones names (\"RightHand\"), indexes (18), * globs (\"Right*Proximal\"), or the groups " +
    "RightFingers / LeftFingers (15 bones) and RightHandAll / LeftHandAll (hand + fingers).",
};
const BONE: Schema = { type: ["string", "integer"], description: "One bone: a Unity HumanBodyBones name (\"RightHand\") or index (18)." };
const LAYER: Schema = { type: ["string", "integer"], description: "Layer index (0 = bottom) or name." };
const TIME: Schema = { type: "number", description: "Time in seconds (session time: playback seconds + the session's timeOffset)." };
const FRAME: Schema = { type: "integer", description: "Frame index (0-based), instead of a time." };
const T0: Schema = { type: "number", description: "Range start, seconds (session time)." };
const T1: Schema = { type: "number", description: "Range end, seconds (session time)." };
const RANGE2 = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 };
const LIMITS: Schema = {
  type: "object",
  description:
    "Allowed range per component, degrees, each [min, max]. flex: + palm-ward / − back-of-hand-ward (hyperextension). " +
    "deviation: + thumb side / − little-finger side. twist: + supination / − pronation. For fingers, curl / splay are " +
    "accepted as aliases of flex / deviation. Omit a component to leave it free. Omit `limits` entirely for human-range " +
    "defaults by joint type (wrist: flex [-70, 80], deviation [-40, 30], twist [-90, 90]).",
  properties: { flex: RANGE2, deviation: RANGE2, twist: RANGE2, curl: RANGE2, splay: RANGE2 },
  additionalProperties: false,
};
const VALUE: Schema = {
  type: "object",
  description:
    "The pose to key, as ONE of: {quat: [x, y, z, w]} · {euler: [x, y, z] in degrees, order: \"ZYX\"} (intrinsic, " +
    "order \"ZYX\" = qz·qy·qx, matching the editor's curves) · anatomical degrees {flex, deviation, twist} for a wrist, " +
    "{curl, splay} for a finger — any component you omit keeps its current value. Values are the LOCAL rotation you want " +
    "(identity = T-pose); add delta: true with quat/euler to give a raw layer delta instead.",
  properties: {
    quat: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
    euler: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
    order: { type: "string" },
    delta: { type: "boolean" },
    flex: { type: "number" }, deviation: { type: "number" }, twist: { type: "number" },
    curl: { type: "number" }, splay: { type: "number" },
  },
  additionalProperties: false,
};

const A = <T>(x: unknown): T => x as T;

export const OPS: OpDef[] = [
  {
    name: "status",
    title: "Session status",
    description: "The clip (frames, duration, timing), the session's time range and bone scope (allow / deny lists), and the current layers and filters.",
    mutates: false, properties: {}, required: [],
    run: (s) => s.status(),
  },
  {
    name: "scan",
    title: "Find problems",
    description:
      "Find problems automatically and return them ranked worst-first. Kinds: wrist_hyperbend, wrist_axis_flip (tracking flip), " +
      "twist_excess (hand + forearm roll), finger_hyperextension, finger_claw, finger_splay, finger_freeze, pop (single-frame " +
      "spike), jitter, foot_slide, floor_penetration, root_pop. Each issue has its time range, frames, peak time and value, " +
      "where that value sits in the whole take (p1 / p50 / p99), the limit it broke, and a suggestedFix that is a ready-to-run " +
      "operation. Scans the EDITED motion by default, so re-scan after a fix to confirm it cleared.",
    mutates: false,
    properties: {
      t0: T0, t1: T1,
      bones: { ...BONES, description: `Only issues involving these bones. ${BONES.description as string}` },
      kinds: { type: "array", items: { type: "string" }, description: "Only these issue kinds." },
      thresholds: { type: "object", description: "Override detection thresholds, e.g. {wristSwingMax: 80, popDeg: 25, footSlideCm: 2}. See DEFAULT_THRESHOLDS in src/api/scan.ts." },
      source: { type: "string", enum: ["edited", "base"], description: "\"edited\" (default) = with the session's edits; \"base\" = the untouched recording." },
      max: { type: "integer", description: "Maximum issues to return (default 50)." },
    },
    required: [],
    run: (s, a) => s.scan(A(a)),
  },
  {
    name: "evaluate",
    title: "Read joint values",
    description:
      "Read exact joint values at a time, a frame, or over a range. Per bone it returns `base` (the recording) and `edited`: " +
      "local quaternion, Euler ZYX degrees, and anatomical degrees — wrist flex / deviation / twist / swing (total bend), finger " +
      "curl / splay — plus changedDeg, and world position in meters with world: true. Use it to look before editing and to verify after.",
    mutates: false,
    properties: {
      bones: BONES, time: TIME, frame: FRAME, t0: T0, t1: T1,
      step: { type: "integer", description: "For ranges: return every Nth frame (default 1). Max 4000 bone-samples per call." },
      world: { type: "boolean", description: "Also return world positions (meters)." },
    },
    required: ["bones"],
    run: (s, a) => s.evaluate(A(a)),
  },
  {
    name: "diff",
    title: "What changed",
    description:
      "Compare the edited motion with the recording: which bones changed, over which frames and times, the largest change, and " +
      "edgeStepDeg — the largest per-frame step of the correction where an edit starts and ends (a pop check; a well-blended " +
      "edit is a few degrees or less). Run it before exporting to prove nothing outside the requested bones and range moved.",
    mutates: false,
    properties: { bones: { ...BONES, description: `Limit the comparison to these bones (default: all). ${BONES.description as string}` }, t0: T0, t1: T1 },
    required: [],
    run: (s, a) => s.diff(A(a)),
  },
  {
    name: "limit.apply",
    title: "Apply joint limits over a range",
    description:
      "Clamp joint angles of the given bones inside [t0, t1] to anatomical ranges, easing the correction in and out over `blend` " +
      "seconds outside the range. Only frames that exceed a limit change. The usual fix for a wrist bent back too far or " +
      "hyperextended / clawed fingers. Written as its own override layer (undoable, visible in the editor).",
    mutates: true,
    properties: {
      bones: BONES, t0: T0, t1: T1, limits: LIMITS,
      softness: { type: "number", description: "Degrees over which the clamp eases into the limit instead of hitting it hard (default 5; 0 = hard clamp)." },
      blend: { type: "number", description: "Seconds of ease-in before t0 and ease-out after t1 (default 0.25)." },
      name: { type: "string", description: "Layer name (default: generated)." },
    },
    required: ["bones", "t0", "t1"],
    run: (s, a) => s.limitApply(A(a)),
  },
  {
    name: "hold.insert",
    title: "Hold a clean pose across a span",
    description:
      "Copy the pose the bones have at donorTime across [t0, t1], easing in over blendIn before t0 and out over blendOut after " +
      "t1. The fix for a tracking flip or a short burst of garbage: pick a clean frame just before it as the donor. Written as " +
      "its own override layer.",
    mutates: true,
    properties: {
      bones: BONES,
      donorTime: { type: "number", description: "Time of the clean pose to copy (session seconds)." },
      donorFrame: { type: "integer", description: "Frame of the clean pose, instead of donorTime." },
      t0: T0, t1: T1,
      blendIn: { type: "number", description: "Seconds of ease-in before t0 (default 0.25)." },
      blendOut: { type: "number", description: "Seconds of ease-out after t1 (default 0.25)." },
      name: { type: "string", description: "Layer name (default: generated)." },
    },
    required: ["bones", "t0", "t1"],
    run: (s, a) => s.holdInsert(A(a)),
  },
  {
    name: "filter.add",
    title: "Add a scoped filter",
    description:
      "Add a non-destructive filter over a bone set and time range (0.25 s blends at the edges): butterworth {cutoffHz} (zero-lag " +
      "low-pass; lower = smoother, default 5), movingAverage {widthFrames}, despike {thresholdDeg} (removes single-frame pops), " +
      "keyReduce {toleranceDeg}. Returns the filter id and what it changed.",
    mutates: true,
    properties: {
      kind: { type: "string", enum: ["butterworth", "movingAverage", "despike", "keyReduce"] },
      bones: BONES, t0: T0, t1: T1,
      params: { type: "object", description: "butterworth: {cutoffHz}; movingAverage: {widthFrames}; despike: {thresholdDeg}; keyReduce: {toleranceDeg}." },
    },
    required: ["kind", "bones", "t0", "t1"],
    run: (s, a) => s.filterAdd(A(a)),
  },
  {
    name: "filter.delete",
    title: "Delete a scoped filter",
    description: "Remove a filter by the id filter.add / filter.list returned.",
    mutates: true, properties: { id: { type: "string" } }, required: ["id"],
    run: (s, a) => s.filterDelete(A(a)),
  },
  {
    name: "filter.list",
    title: "List scoped filters",
    description: "The session's scoped filters with their ids, bones, ranges and parameters.",
    mutates: false, properties: {}, required: [],
    run: (s) => s.filterList(),
  },
  {
    name: "layer.create",
    title: "Create a rig layer",
    description:
      "Add an empty layer on top of the stack for key.set. additive (default) = keys are corrections on top of the motion, which " +
      "keeps playing underneath; override = keys replace the motion with a fixed pose. extent \"fade\" (default) = a key eases in " +
      "and out over `fade` seconds on each side; \"hold\" = the first/last key extends to the ends of the clip.",
    mutates: true,
    properties: {
      name: { type: "string" },
      mode: { type: "string", enum: ["additive", "override"] },
      weight: { type: "number", description: "0..1 (default 1)." },
      extent: { type: "string", enum: ["fade", "hold"] },
      fade: { type: "number", description: "Fade time in seconds for extent \"fade\" (default 0.5)." },
    },
    required: [],
    run: (s, a) => s.layerCreate(A(a)),
  },
  {
    name: "layer.set",
    title: "Change a layer",
    description: "Change a layer's name, weight, extent, fade or enabled flag (mode only while it has no keys).",
    mutates: true,
    properties: {
      layer: LAYER, name: { type: "string" }, mode: { type: "string", enum: ["additive", "override"] },
      weight: { type: "number" }, extent: { type: "string", enum: ["fade", "hold"] }, fade: { type: "number" }, enabled: { type: "boolean" },
    },
    required: ["layer"],
    run: (s, a) => s.layerSet(A(a)),
  },
  {
    name: "layer.delete",
    title: "Delete a layer",
    description: "Remove a layer and all its keys.",
    mutates: true, properties: { layer: LAYER }, required: ["layer"],
    run: (s, a) => s.layerDelete(A(a)),
  },
  {
    name: "layer.list",
    title: "List layers",
    description: "The layer stack, bottom first: mode, weight, extent, fade, bones and key counts.",
    mutates: false, properties: {}, required: [],
    run: (s) => s.layerList(),
  },
  {
    name: "key.set",
    title: "Key a bone's rotation",
    description:
      "Set a typed rotation key on one bone at a time or frame, on a layer made with layer.create. Give the pose as a quaternion, " +
      "Euler degrees, or anatomical degrees (wrist flex / deviation / twist, finger curl / splay). Returns the bone's values before " +
      "and after at that frame. A hand key never touches the forearm.",
    mutates: true,
    properties: { layer: LAYER, bone: BONE, time: TIME, frame: FRAME, value: VALUE, ease: { type: "string", enum: ["linear", "smooth", "step"], description: "Interpolation leaving this key (default linear)." } },
    required: ["layer", "bone", "value"],
    run: (s, a) => s.keySet(A(a)),
  },
  {
    name: "key.delete",
    title: "Delete a key",
    description: "Delete the key on a bone at a time or frame.",
    mutates: true, properties: { layer: LAYER, bone: BONE, time: TIME, frame: FRAME }, required: ["layer", "bone"],
    run: (s, a) => s.keyDelete(A(a)),
  },
  {
    name: "key.list",
    title: "List keys",
    description: "Keys on a layer (or all layers), optionally for one bone, with their times and values.",
    mutates: false, properties: { layer: LAYER, bone: BONE, max: { type: "integer", description: "Maximum keys to return (default 400)." } }, required: [],
    run: (s, a) => s.keyList(A(a)),
  },
  {
    name: "keys.smooth",
    title: "Smooth keys",
    description: "Blend each key in [t0, t1] toward the midpoint of its neighbours (endpoints stay). amount 0..1, default 0.5.",
    mutates: true, properties: { layer: LAYER, bones: BONES, t0: T0, t1: T1, amount: { type: "number" } }, required: ["layer", "bones"],
    run: (s, a) => s.keysSmooth(A(a)),
  },
  {
    name: "keys.reduce",
    title: "Reduce keys",
    description: "Remove keys in [t0, t1] that the curve would not miss, within toleranceDeg (default 1).",
    mutates: true, properties: { layer: LAYER, bones: BONES, t0: T0, t1: T1, toleranceDeg: { type: "number" } }, required: ["layer", "bones"],
    run: (s, a) => s.keysReduce(A(a)),
  },
  {
    name: "undo",
    title: "Undo",
    description: "Undo the last mutating operation.",
    mutates: true, properties: {}, required: [],
    run: (s) => s.undo(),
  },
  {
    name: "redo",
    title: "Redo",
    description: "Redo the operation most recently undone.",
    mutates: true, properties: {}, required: [],
    run: (s) => s.redo(),
  },
];

const BY_NAME = new Map(OPS.map((o) => [o.name, o]));

export const getOp = (name: string): OpDef | undefined => BY_NAME.get(name);

/** JSON Schema (draft 2020-12 subset) for an operation's arguments. */
export function opSchema(op: OpDef, extra: Record<string, Schema> = {}, extraRequired: string[] = []): Schema {
  return {
    type: "object",
    properties: { ...extra, ...op.properties },
    required: [...extraRequired, ...op.required],
    additionalProperties: false,
  };
}

/** Run one `{op: "name", ...args}` step against a session, validating argument names. */
export function runOp(s: Session, step: Record<string, unknown>): unknown {
  const { op: name, ...args } = step;
  if (typeof name !== "string") throw new ApiError(`each step needs an "op" name (one of: ${OPS.map((o) => o.name).join(", ")})`);
  const op = BY_NAME.get(name);
  if (!op) throw new ApiError(`unknown op "${name}" (one of: ${OPS.map((o) => o.name).join(", ")})`);
  for (const k of Object.keys(args)) {
    if (!(k in op.properties)) throw new ApiError(`${name}: unknown argument "${k}" (accepts: ${Object.keys(op.properties).join(", ") || "none"})`);
  }
  for (const k of op.required) {
    if (args[k] === undefined) throw new ApiError(`${name}: missing required argument "${k}"`);
  }
  return op.run(s, args);
}
