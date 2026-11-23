// Node-side core shared by the CLI (cli/wry.mjs) and the MCP server
// (cli/mcp.mjs). Two halves:
//
//   SESSIONS  open a .wanim by local path as an editing session (src/api),
//             run operations / edit scripts, export timing-exact .wanim.
//   CONVERT   one-shot format conversion to FBX / VRMA (or a resampled
//             .wanim) with optional whole-clip cleaning.
//
// Everything here returns plain JSON-able data and NEVER writes to stdout
// (the MCP server owns stdout for its protocol stream).
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// three's loaders reference `self` / `createImageBitmap` at import or parse
// time; neither exists in plain Node. Stub the minimum (same as the checks).
globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter, resample } = await import("../src/convert/clip.ts");
const { remapNames } = await import("../src/convert/skeleton.ts");
const {
  runPipeline, defaultEdits, defaultExportSettings, sceneToEdits, adoptRigDoc, isSceneDoc,
  base64ToBytes, summarizeClip, emptyCleanStats,
} = await import("../src/api/pipeline.ts");
const { openSession, ApiError } = await import("../src/api/session.ts");
const { OPS, getOp, runOp, opSchema } = await import("../src/api/ops.ts");

export { OPS, getOp, runOp, opSchema, ApiError };

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
export const FORMATS = ["fbx", "vrma", "wanim", "anim"];

/** An error whose message is meant for the caller (bad input, not a bug). */
export class UsageError extends Error {}
/** True for errors that are the caller's to fix (reported without a stack). */
export const isCallerError = (err) => err instanceof UsageError || err instanceof ApiError;

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

function readBytes(path, what = "file") {
  if (!existsSync(path)) throw new UsageError(`${what} not found: ${path}`);
  if (statSync(path).isDirectory()) throw new UsageError(`${what} is a directory: ${path}`);
  return readFileSync(path);
}

function readJson(path, what) {
  const text = readBytes(path, what).toString("utf8").replace(/^﻿/, "");
  try { return JSON.parse(text); } catch (err) {
    throw new UsageError(`${path}: not valid JSON (${err.message})`);
  }
}

function writeOut(path, bytes, overwrite) {
  const abs = resolve(path);
  if (existsSync(abs) && !overwrite) throw new UsageError(`output exists: ${abs} (pass overwrite to replace it)`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return abs;
}

function sniffKind(path, buf) {
  const ext = extname(path).toLowerCase();
  if (ext === ".wanim") return "wanim";
  if (ext === ".fbx") return "fbx";
  if (ext === ".json") return "scene";
  if (buf[0] === 0x7b) return "scene"; // "{"
  if (buf.subarray(0, 7).toString("latin1") === "Kaydara") return "fbx";
  return "wanim";
}

// ==== SESSIONS ====================================================================

/**
 * Open a recording as an editing session, by local path (no size limit).
 * Accepts a .wanim, or a .scene.json that embeds one (its rig state is loaded).
 *
 * If a sidecar `<file>.json` with `sourceTimeStart` sits next to an excerpt,
 * that becomes the session's timeOffset (so times match the full take) unless
 * `timeOffset` is given explicitly.
 */
export function openFileSession(path, o = {}) {
  const abs = resolve(path);
  const buf = readBytes(abs, "input");
  const kind = sniffKind(abs, buf);
  const notes = [];
  let bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let name = basename(abs).replace(/\.(scene\.json|wanim|json)$/i, "");
  let sceneRig = null;
  if (kind === "fbx") throw new UsageError(`${abs}: sessions edit .wanim recordings; use \`wry convert\` for FBX input`);
  if (kind === "scene") {
    const doc = readJson(abs, "scene");
    if (!isSceneDoc(doc)) throw new UsageError(`${abs}: not a WRYAnimator scene (missing magic "wanimscene")`);
    if (!doc.wanim) throw new UsageError(`${abs}: this scene does not embed a .wanim recording`);
    bytes = base64ToBytes(doc.wanim);
    name = doc.name || name;
    sceneRig = doc.rig ?? null;
    notes.push("opened the recording embedded in the scene; its rig state was loaded (scene cleaning toggles are not applied in sessions)");
  }

  let timeOffset = o.timeOffset;
  if (timeOffset === undefined && existsSync(`${abs}.json`)) {
    try {
      const side = readJson(`${abs}.json`, "sidecar");
      if (typeof side.sourceTimeStart === "number") {
        timeOffset = side.sourceTimeStart;
        if (typeof side.source === "string" && !o.name) name = `${name} (excerpt of ${side.source})`;
        notes.push(`timeOffset ${round(timeOffset, 4)} s taken from ${basename(abs)}.json — times are in the source take's seconds`);
      }
    } catch { /* an unreadable sidecar is not an error */ }
  }

  let session;
  try {
    session = openSession(bytes, {
      name: o.name ?? name,
      character: o.character,
      timeOffset: timeOffset ?? 0,
      allowBones: o.allowBones,
      denyBones: o.denyBones,
      protectForearmTwist: o.protectForearmTwist,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new UsageError(`${abs}: could not open as .wanim (${err.message})`);
  }
  if (session.protectForearmTwist) notes.push("forearm twist is protected (TWISTFIX file): twist limits / twist keys on a LowerArm are refused");
  if (sceneRig && Array.isArray(sceneRig.layers)) notes.push(...(session.loadRig(JSON.stringify(sceneRig)).notes ?? []));
  if (o.rig) notes.push(...loadRigFile(session, o.rig).notes);
  return { session, file: abs, notes };
}

export function loadRigFile(session, path) {
  const abs = resolve(path);
  const res = session.loadRig(readBytes(abs, "rig file").toString("utf8").replace(/^﻿/, ""));
  return { rig: abs, ...res, notes: res.notes ?? [] };
}

export function saveRigFile(session, path, o = {}) {
  const out = writeOut(path, session.saveRig(), o.overwrite);
  return { rig: out, layers: session.edits.layers.length, filters: session.edits.cleanOps.length };
}

/** Write the session as a timing-exact .wanim. Never overwrites the source. */
export function exportSessionWanim(session, sourceFile, outPath, o = {}) {
  const out = resolve(outPath ?? join(dirname(sourceFile), `${basename(sourceFile).replace(/\.(scene\.json|wanim|json)$/i, "")}_fixed.wanim`));
  if (out === resolve(sourceFile)) throw new UsageError("output path is the source file — refusing to overwrite the original recording");
  if (extname(out).toLowerCase() !== ".wanim") throw new UsageError(`timing-exact export writes .wanim; for ${extname(out) || "that format"} use \`wry convert\``);
  if (existsSync(out) && !o.overwrite) throw new UsageError(`output exists: ${out} (pass overwrite to replace it)`);
  const { bytes, report } = session.exportWanim();
  writeOut(out, bytes, true);
  return { output: out, bytes: bytes.length, preserveTiming: true, ...report };
}

/**
 * Run an edit script: `{timeOffset?, allowBones?, denyBones?, protectForearmTwist?, ops: [{op, ...args}]}`
 * (or just the ops array). All-or-nothing: if any step fails nothing is written.
 */
export function runEditScript(file, script, o = {}) {
  const doc = Array.isArray(script) ? { ops: script } : script;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.ops)) {
    throw new UsageError("edit script must be {ops: [{op: \"limit.apply\", ...}, ...]} or a bare array of ops");
  }
  const { session, file: abs, notes } = openFileSession(file, {
    timeOffset: o.timeOffset ?? doc.timeOffset,
    allowBones: o.allowBones ?? doc.allowBones,
    denyBones: o.denyBones ?? doc.denyBones,
    protectForearmTwist: o.protectForearmTwist ?? doc.protectForearmTwist,
    rig: o.rig,
  });
  const steps = [];
  doc.ops.forEach((step, i) => {
    try {
      steps.push({ step: i + 1, op: step?.op, result: runOp(session, step ?? {}) });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const e = new ApiError(`step ${i + 1} (${step?.op ?? "?"}): ${err.message} — nothing was written`);
      e.steps = steps;
      throw e;
    }
  });
  const out = { file: abs, timeRange: session.status().timeRange, scope: session.status().scope, steps, diff: session.diff(), notes };
  if (o.dryRun) return { ...out, dryRun: true };
  if (o.saveRig) out.rig = saveRigFile(session, o.saveRig, o).rig;
  if (o.out || !o.saveRig) out.export = exportSessionWanim(session, abs, o.out, o);
  return out;
}

// ==== CONVERT =====================================================================

/**
 * Load a .wanim, an editor .scene.json, or an animation .fbx for conversion.
 * Returns the converted clip plus the edits/export settings the file carries
 * (defaults for bare recordings; the saved session for scenes).
 */
export async function loadInput(path, opts = {}) {
  const abs = resolve(path);
  const buf = readBytes(abs, "input");
  const kind = sniffKind(abs, buf);
  let name = basename(abs).replace(/\.(scene\.json|wanim|fbx|json)$/i, "");
  let edits = defaultEdits();
  let exp = defaultExportSettings();
  const notes = [];
  let scene = null;
  let bodyBytes = null;
  let bodyName = null;
  let motionBytes = toArrayBuffer(buf);
  let sourceKind = kind;

  if (kind === "scene") {
    const doc = readJson(abs, "scene");
    if (!isSceneDoc(doc)) throw new UsageError(`${abs}: not a WRYAnimator scene (missing magic "wanimscene")`);
    scene = doc;
    name = doc.name || name;
    const fromScene = sceneToEdits(doc);
    ({ edits, exp } = fromScene);
    notes.push(...fromScene.notes);
    const src = doc.source ?? "wanim";
    if (src === "body") throw new UsageError(`${abs}: body-only scene — it has no motion to export`);
    const b64 = src === "fbx" ? doc.fbx : doc.wanim;
    if (!b64) throw new UsageError(`${abs}: scene has no embedded ${src} data`);
    motionBytes = toArrayBuffer(Buffer.from(base64ToBytes(b64)));
    sourceKind = src;
    if (doc.body?.data) {
      bodyBytes = toArrayBuffer(Buffer.from(base64ToBytes(doc.body.data)));
      bodyName = doc.body.name ?? "scene body";
    }
  }

  let converted;
  let wanimClip = null;
  let characters = 1;
  let takes = null;
  if (sourceKind === "fbx") {
    const { importFbxAnimation } = await import("../src/convert/importFbx.ts");
    const res = importFbxAnimation(motionBytes);
    if (!res.takes.length) throw new UsageError(`${abs}: no animated humanoid take found in the FBX`);
    takes = res.takes.map((t) => ({ name: t.name, frames: t.frames, durationS: round(t.duration) }));
    let pick = res.takes[0];
    if (opts.take !== undefined && opts.take !== null) {
      const byName = res.takes.find((t) => t.name === String(opts.take));
      const byIndex = /^\d+$/.test(String(opts.take)) ? res.takes[Number(opts.take)] : undefined;
      pick = byName ?? byIndex;
      if (!pick) throw new UsageError(`take ${JSON.stringify(opts.take)} not found; takes: ${takes.map((t) => t.name).join(", ")}`);
    }
    converted = pick.clip;
  } else {
    try {
      wanimClip = parseWanim(motionBytes);
    } catch (err) {
      throw new UsageError(`${abs}: could not parse as .wanim (${err.message})`);
    }
    characters = wanimClip.characters.length;
    const ci = opts.character ?? 0;
    if (!Number.isInteger(ci) || ci < 0 || ci >= characters) {
      throw new UsageError(`character ${ci} not present (recording has ${characters})`);
    }
    converted = convertCharacter(wanimClip, ci);
  }

  return { path: abs, name, kind, sourceKind, converted, wanimClip, characters, takes, scene, bodyBytes, bodyName, edits, exp, notes };
}

// ---- body / face assets ------------------------------------------------------

const glbCache = new Map();

async function loadGlbScene(bytes) {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader.parseAsync(bytes, "");
}

/** An explicit VRM/GLB path, else the scene's embedded custom body, else the bundled public/body.glb. */
async function loadBody(input, bodyPath) {
  const key = bodyPath ? `file:${resolve(bodyPath)}` : input.bodyBytes ? `scene:${input.path}` : "bundled";
  if (glbCache.has(key)) return glbCache.get(key);
  const p = (async () => {
    if (!bodyPath && !input.bodyBytes) {
      const gltf = await loadGlbScene(toArrayBuffer(readBytes(join(REPO_ROOT, "public", "body.glb"), "bundled body")));
      return { label: "bundled", user: false, scene: gltf.scene, boneUnity: undefined, textures: undefined };
    }
    const raw = bodyPath ? toArrayBuffer(readBytes(resolve(bodyPath), "body")) : input.bodyBytes;
    const { sanitizeGlb, parseVrmHumanoid, parseGlbChunks } = await import("../src/vrm/vrmHumanoid.ts");
    const { boneUnityFromAssociations, extractGlbTextures } = await import("../src/convert/body.ts");
    const clean = sanitizeGlb(raw);
    const nodeMap = parseVrmHumanoid(clean);
    const gltf = await loadGlbScene(clean);
    const chunks = parseGlbChunks(clean);
    return {
      label: bodyPath ? basename(bodyPath) : input.bodyName,
      user: true,
      scene: gltf.scene,
      boneUnity: nodeMap ? boneUnityFromAssociations(gltf, nodeMap) : undefined,
      textures: chunks ? extractGlbTextures(gltf, chunks) : undefined,
    };
  })();
  glbCache.set(key, p);
  return p;
}

async function loadFaceData() {
  if (!glbCache.has("face")) {
    glbCache.set("face", (async () => {
      const { faceMeshDataFromScene } = await import("../src/convert/faceMeshData.ts");
      const gltf = await loadGlbScene(toArrayBuffer(readBytes(join(REPO_ROOT, "public", "facecap-head.glb"), "bundled face")));
      return faceMeshDataFromScene(gltf.scene);
    })());
  }
  return glbCache.get("face");
}

// ---- option merging ----------------------------------------------------------

const SIDES = ["left", "right", "both"];
const num = (v, label, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new UsageError(`${label} must be a number in [${lo}, ${hi}], got ${JSON.stringify(v)}`);
  return n;
};
const oneOf = (v, label, allowed) => {
  if (!allowed.includes(v)) throw new UsageError(`${label} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v)}`);
  return v;
};

/**
 * Apply caller overrides on top of the input's own edits + export settings.
 * `o` is the flat option bag shared by the CLI flags and the MCP tool args
 * (see cli/options.mjs). Unset keys leave the input's value.
 */
export function mergeOptions(input, o = {}) {
  const edits = structuredClone(input.edits);
  const exp = structuredClone(input.exp);
  const notes = [];

  if (o.rig) {
    const doc = readJson(resolve(o.rig), "rig file");
    // Accept a bare .rig.json or a scene (take its rig block).
    const rigDoc = isSceneDoc(doc) ? (doc.rig ?? {}) : doc;
    if (!isSceneDoc(doc) && !Array.isArray(rigDoc.layers)) throw new UsageError(`${o.rig}: not a rig file (missing layers)`);
    notes.push(...adoptRigDoc(edits, rigDoc));
  }

  if (o.noClean) edits.clean = {};
  const c = edits.clean;
  if (o.despike !== undefined) {
    c.despike = o.despike !== false;
    if (typeof o.despike === "number") c.despikeDeg = num(o.despike, "despike", 1, 180);
  }
  if (c.despike && !c.despikeDeg) c.despikeDeg = 35;
  if (o.smooth !== undefined) {
    c.smooth = o.smooth !== false;
    if (typeof o.smooth === "number") c.cutoffHz = num(o.smooth, "smooth", 0.5, 30);
  }
  if (c.smooth && !c.cutoffHz) c.cutoffHz = 7;
  if (o.fixFeet !== undefined) c.fixFeet = !!o.fixFeet;
  if (o.limitWrists !== undefined) c.limitWrists = !!o.limitWrists;
  if (o.limitForearms !== undefined) c.limitLowerArms = !!o.limitForearms;
  if (o.lockWrists !== undefined) c.lockWrists = o.lockWrists ? oneOf(o.lockWrists, "lockWrists", SIDES) : undefined;
  if (o.lockForearmTwist !== undefined) c.lockLowerArmTwist = o.lockForearmTwist ? oneOf(o.lockForearmTwist, "lockForearmTwist", SIDES) : undefined;

  if (o.proportions !== undefined) edits.proportions = oneOf(o.proportions, "proportions", ["recorded", "body"]);
  if (o.spreadSpine !== undefined) {
    edits.distSpine = o.spreadSpine !== false;
    if (typeof o.spreadSpine === "number") edits.distSpineAmt = num(o.spreadSpine, "spreadSpine", 0, 1);
  }
  if (o.mirror !== undefined) edits.mods.mirror = !!o.mirror;
  if (o.hipsHeightCm !== undefined) edits.mods.hipsHeightCm = num(o.hipsHeightCm, "hipsHeightCm", -50, 50);

  if (o.fps !== undefined) exp.fps = num(o.fps, "fps", 1, 240);
  if (o.speed !== undefined) exp.speed = num(o.speed, "speed", 0.25, 4);
  if (o.names !== undefined) exp.names = oneOf(o.names, "names", ["unity", "motionbuilder"]);
  if (o.rest !== undefined) exp.rest = oneOf(o.rest, "rest", ["tpose", "first"]);
  if (o.face !== undefined) exp.face = !!o.face;
  if (o.trimStart !== undefined || o.trimEnd !== undefined) {
    const start = o.trimStart !== undefined ? num(o.trimStart, "trimStart", 0, 1e6) : (exp.trim?.start ?? 0);
    const end = o.trimEnd !== undefined ? num(o.trimEnd, "trimEnd", 0, 1e6) : (exp.trim?.end ?? Infinity);
    if (end <= start) throw new UsageError(`trim end (${end}) must be after trim start (${start})`);
    exp.trim = { start, end };
  }
  return { edits, exp, notes };
}

const activeFilters = (c) => [
  c.despike && `despike ${c.despikeDeg}°`,
  c.smooth && `smooth ${c.cutoffHz} Hz`,
  c.fixFeet && "fix feet",
  c.limitWrists && "limit wrists",
  c.lockWrists && `lock wrists (${c.lockWrists})`,
  c.limitLowerArms && "limit forearm twist",
  c.lockLowerArmTwist && `lock forearm twist (${c.lockLowerArmTwist})`,
].filter(Boolean);

function editsSummary(edits) {
  const keys = edits.layers.reduce((n, l) => n + l.tracks.reduce((m, t) => m + t.posKeys.length + t.rotKeys.length, 0), 0);
  return {
    filters: activeFilters(edits.clean),
    proportions: edits.proportions,
    spreadSpine: edits.distSpine ? edits.distSpineAmt : false,
    timeWarpKeys: edits.warp.length,
    rangeSmooths: edits.ranges.length,
    scopedFilters: edits.cleanOps.filter((op) => op.enabled !== false).length,
    loop: edits.loop,
    modifiers: edits.mods,
    rigLayers: edits.layers.map((l) => ({ name: l.name, mode: l.mode, weight: l.weight, enabled: l.enabled, tracks: l.tracks.length })),
    rigKeys: keys,
  };
}

function statsSummary(edits, stats) {
  const c = edits.clean;
  const out = {};
  if (c.despike) out.popsFixed = stats.despiked;
  if (c.limitWrists) out.wristFramesClamped = stats.wristClamped;
  if (c.limitLowerArms || c.lockLowerArmTwist) out.forearmFramesChanged = stats.forearmClamped;
  if (c.smooth) out.smoothingMeanDeg = round(stats.smoothedMeanDeg);
  if (c.fixFeet && stats.feet) {
    out.feet = { plants: stats.feet.spans, framesAdjusted: stats.feet.frames, maxFixCm: round(stats.feet.maxFixCm, 1) };
  }
  return out;
}

// ---- commands ----------------------------------------------------------------

/** What is in this file? No pipeline run — fast. */
export async function info(path, o = {}) {
  const input = await loadInput(path, o);
  const out = {
    file: input.path,
    name: input.name,
    kind: input.kind,
    source: input.sourceKind,
    ...(input.sourceKind === "wanim" ? { formatVersion: input.wanimClip.version, characters: input.characters } : {}),
    ...(input.takes ? { takes: input.takes } : {}),
    clip: summarizeClip(input.converted),
    boneNames: input.converted.names,
  };
  if (input.scene) {
    out.scene = { version: input.scene.v, customBody: input.bodyName, export: input.exp, edits: editsSummary(input.edits) };
  }
  if (input.notes.length) out.notes = input.notes;
  return out;
}

function resolveOutput(input, o) {
  let format = o.format;
  let out = o.out ? resolve(o.out) : null;
  if (out && existsSync(out) && statSync(out).isDirectory()) {
    if (!format) throw new UsageError("output is a directory — pass a format (fbx | vrma | anim | wanim)");
    out = join(out, `${input.name}_converted.${format}`);
  }
  if (!format && out) format = extname(out).slice(1).toLowerCase();
  if (!format) throw new UsageError("no output format — pass an output path ending in .fbx / .vrma / .anim / .wanim, or a format");
  oneOf(format, "format", FORMATS);
  if (!out) out = join(dirname(input.path), `${input.name}_converted.${format}`);
  if (resolve(out) === input.path) throw new UsageError("output path is the input file — refusing to overwrite the source");
  return { format, out };
}

/**
 * One-shot conversion: run the pipeline, RESAMPLE to a fixed frame rate and
 * write FBX / VRMA / Unity .anim (beta) / WANIM. Whole-clip cleaning only when asked for.
 *
 * A .wanim written here has new timestamps and a new frame count — it will
 * not stay in sync with audio. For that, edit in a session and export
 * (timing-exact); this path therefore needs `resample: true` for .wanim.
 */
export async function convert(path, o = {}) {
  const input = await loadInput(path, o);
  const { edits, exp, notes } = mergeOptions(input, o);
  const { format, out } = resolveOutput(input, o);
  if (format === "wanim" && !o.resample) {
    throw new UsageError(
      "convert would RESAMPLE this .wanim (new frame count and timestamps — breaks music / lip-sync). " +
      "For a timing-exact .wanim use `wry export` / `wry edit` (MCP: wry_export_wanim). Pass resample to do it anyway.",
    );
  }
  if (existsSync(out) && !o.overwrite) throw new UsageError(`output exists: ${out} (pass overwrite to replace it)`);

  const mesh = o.mesh !== undefined ? oneOf(o.mesh, "mesh", ["none", "face", "body", "all"]) : "face";
  const wantBodyMesh = format === "fbx" && (mesh === "body" || mesh === "all");
  const wantFaceMesh = format === "fbx" && (mesh === "face" || mesh === "all");
  // .wanim and .anim always describe the RECORDED skeleton: a humanoid .anim is measured against
  // the avatar's own proportions, and Unity retargets it from there.
  const recordedOnly = format === "wanim" || format === "anim";
  const needBody = (!recordedOnly && edits.proportions === "body") || wantBodyMesh;
  const body = needBody ? await loadBody(input, o.body) : null;
  let extractBodyMeshes, bodyToSkinnedMeshExports;
  if (body) ({ extractBodyMeshes, bodyToSkinnedMeshExports } = await import("../src/convert/body.ts"));

  const stats = emptyCleanStats();
  const clip = runPipeline(input.converted, edits, {
    target: recordedOnly ? "wanim" : "display",
    stats,
    bodyJoints: body
      ? (parents, bindPos, names) => extractBodyMeshes(body.scene, parents, bindPos, names, body.boneUnity).joints
      : undefined,
  });
  if (format === "wanim") {
    notes.push("RESAMPLED .wanim: frame count and timestamps differ from the source");
    if (edits.proportions === "body") notes.push("wanim output always uses the recorded proportions (a body-mesh fit has no meaning in a .wanim)");
  }
  if (format === "anim") {
    notes.push("Unity humanoid .anim is BETA: verified against Unity on the avatars it was measured on; expect a few degrees of error in arm twist, fingers and thumbs on others");
    if (edits.proportions === "body") notes.push("anim output always uses the recorded proportions (Unity retargets from the avatar's own skeleton)");
  }

  const trimStart = Math.min(exp.trim?.start ?? 0, clip.duration);
  const trimEnd = Math.min(exp.trim?.end ?? clip.duration, clip.duration);
  const rs = resample(clip, exp.fps, trimStart, trimEnd, exp.speed);
  const takeName = o.takeName ?? basename(out).replace(/\.[^.]+$/, "");

  let bytes;
  const embedded = [];
  let faceChannels = 0;
  let animReport;
  if (format === "anim") {
    const { writeUnityAnim } = await import("../src/anim/writeAnim.ts");
    const res = writeUnityAnim(rs, {
      name: takeName,
      face: exp.face ? rs.face : null,
      facePath: o.facePath,
      hipsHeight: o.tposeHipsHeight,
      tolerance: o.keyTolerance,
    });
    bytes = res.bytes;
    animReport = res.report;
    faceChannels = res.report.blendshapeCurves;
  } else if (format === "wanim") {
    const { writeWanim } = await import("../src/wanim/writeWanim.ts");
    bytes = writeWanim(exp.face ? rs : { ...rs, face: null }, input.wanimClip ?? undefined); // face off = body-only take
    faceChannels = rs.face?.names.length ?? 0;
  } else {
    const { augmentFaceForVrm } = await import("../src/convert/vrmFaceMap.ts");
    const augFace = exp.face && rs.face ? augmentFaceForVrm(rs.face) : undefined;
    if (format === "vrma") {
      const { writeVrma } = await import("../src/vrma/writeVrma.ts");
      bytes = writeVrma(rs, augFace);
      faceChannels = augFace?.names.length ?? 0;
    } else {
      const { writeAnimationFbx } = await import("../src/fbx/animationFbx.ts");
      const meshes = [];
      // A user VRM keeps its own head, so the facecap Face mesh is omitted.
      if (wantFaceMesh && exp.face && rs.face && !(wantBodyMesh && body.user)) {
        const { buildFaceMesh } = await import("../src/convert/meshExport.ts");
        const m = buildFaceMesh(rs, await loadFaceData());
        meshes.push(m);
        faceChannels = m.channels?.length ?? 0;
        embedded.push(`face head (${faceChannels} blendshape channels)`);
      }
      if (wantBodyMesh) {
        const data = extractBodyMeshes(body.scene, rs.parents, rs.bindPos, rs.names, body.boneUnity, {
          keepHead: body.user,
          morphNames: body.user ? augFace?.names : undefined,
          textures: body.textures,
        }).meshes;
        const ex = bodyToSkinnedMeshExports(data, augFace);
        meshes.push(...ex);
        if (body.user) faceChannels = ex.reduce((n, m) => n + (m.channels?.length ?? 0), 0);
        embedded.push(`body: ${body.label} (${ex.length} mesh${ex.length === 1 ? "" : "es"})`);
      }
      if (rs.face && exp.face && meshes.length === 0) {
        notes.push("face blendshapes were recorded but not exported: FBX carries them only on an embedded mesh (mesh: face | body | all)");
      }
      bytes = writeAnimationFbx(rs, {
        takeName,
        names: remapNames(rs.names, exp.names),
        tposeRest: exp.rest === "tpose",
        meshes,
      });
    }
  }

  writeOut(out, bytes, true);

  return {
    input: input.path,
    output: out,
    format,
    bytes: bytes.length,
    resampled: true,
    frames: rs.frameCount,
    fps: rs.fps,
    durationS: round((rs.frameCount - 1) / rs.fps),
    speed: exp.speed,
    trimS: { start: round(trimStart), end: round(trimEnd) },
    ...(format === "fbx" ? { boneNames: exp.names, restPose: exp.rest, takeName, embeddedMeshes: embedded } : {}),
    ...(animReport ? { beta: true, anim: animReport } : {}),
    proportions: recordedOnly ? "recorded" : edits.proportions + (edits.proportions === "body" ? ` (${body.label})` : ""),
    faceChannels,
    filters: activeFilters(edits.clean),
    changed: statsSummary(edits, stats),
    edits: (({ filters, proportions, ...rest }) => rest)(editsSummary(edits)),
    notes: [...input.notes, ...notes],
  };
}

/** Pull the embedded recording (and custom body, and rig state) back out of a scene file. */
export async function unpackScene(path, o = {}) {
  const abs = resolve(path);
  const doc = readJson(abs, "scene");
  if (!isSceneDoc(doc)) throw new UsageError(`${abs}: not a WRYAnimator scene`);
  const dir = resolve(o.outDir ?? dirname(abs));
  const base = (doc.name || basename(abs)).replace(/\.(scene\.json|wanim|fbx|json)$/i, "");
  const files = [];
  const put = (file, bytes) => {
    const p = join(dir, file);
    if (existsSync(p) && !o.overwrite) throw new UsageError(`output exists: ${p} (pass overwrite to replace it)`);
    files.push([p, bytes]);
  };
  if (doc.wanim) put(`${base}.wanim`, base64ToBytes(doc.wanim));
  if (doc.fbx) put(`${base}.fbx`, base64ToBytes(doc.fbx));
  if (doc.body?.data) put(basename(doc.body.name || `${base}-body.glb`), base64ToBytes(doc.body.data));
  if (doc.rig) put(`${base}.rig.json`, Buffer.from(JSON.stringify(doc.rig, null, 1)));
  mkdirSync(dir, { recursive: true });
  for (const [p, bytes] of files) writeFileSync(p, bytes);
  return { scene: abs, written: files.map(([p, bytes]) => ({ path: p, bytes: bytes.length })) };
}
