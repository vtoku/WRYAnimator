// Headless editing session — the one core the CLI, the MCP server and (later)
// the web app's `window.wry` all call, so a numeric edit gives the same result
// everywhere. Pure TS: no DOM, no WebGL, no node: imports; strip-types safe.
//
//   const s = openSession(bytes, { name, timeOffset, denyBones });
//   s.scan(); s.limitApply({...}); s.diff(); s.exportWanim();
//
// TIME: every time in this API is `playback seconds + timeOffset`. Playback
// time starts at 0 on the first frame (what the editor's timeline shows).
// `timeOffset` (default 0) lets an EXCERPT be addressed in its source take's
// time: an excerpt cut at 186.011 s opened with timeOffset 186.011 answers to
// "190.5". Rig files always store playback time, so they open unchanged in
// the web app.
//
// SCOPE: operations only ever write the bones they are given, and refuse any
// bone outside allowBones / inside denyBones. Nothing here touches face
// blendshapes, and programmatic hand edits never spill onto the forearm (the
// UI's WRIST_TWIST_SHARE redistribution is not applied — share is 0).
import { parseWanim, type WanimClip, type Quat, type Vec3 } from "../wanim/parse.ts";
import { type ConvertedClip, convertCharacter } from "../convert/clip.ts";
import type { CleanOp, CleanFilter } from "../convert/clean.ts";
import { worldFromLocal } from "../convert/fk.ts";
import { quatMul, quatNormalize, quatSlerp, quatToEulerZYX } from "../convert/quat.ts";
import {
  type RigLayer, type RigTrack, type KeyEase,
  applyLayersToPose, applyRigLayers, poseAtFrame, nearestFrame, frameTime,
  getBoneTrack, setRotKey, setKeyEase, deleteKeysAt, smoothKeys, reduceKeys,
} from "../rig/rig.ts";
import { anyWarp } from "../rig/timewarp.ts";
import { defaultIkfkBlend } from "../rig/rig.ts";
import { type Edits, defaultEdits, runPipeline, adoptRigDoc, summarizeClip, type ClipSummary } from "./pipeline.ts";
import { type BoneAxes, type Anatomy, boneAxes, decompose, compose, softClamp, fingerBoneNames } from "./anatomy.ts";
import { exportWanimExact, type ExactExportReport, DIRTY_ROT_RAD } from "../wanim/exactWanim.ts";
import { scanClip, type ScanOpts, type ScanIssue } from "./scan.ts";

/** Thrown for anything the caller did wrong (bad bone, denied bone, bad range). */
export class ApiError extends Error {}

export type BoneRef = string | number;
export type LayerRef = string | number;

export interface SessionOpts {
  name?: string;
  character?: number;
  /** Added to playback time everywhere in the API (see TIME above). */
  timeOffset?: number;
  /** If set, ONLY these bones may be written. Names, indexes, groups, `*` globs. */
  allowBones?: BoneRef[];
  /** These bones may never be written. Names, indexes, groups, `*` globs. */
  denyBones?: BoneRef[];
  /**
   * Refuse to re-solve forearm twist (twist limits / twist keys on a
   * LowerArm). Defaults to true when the name contains "TWISTFIX" — an
   * external tool already redistributed that twist.
   */
  protectForearmTwist?: boolean;
}

export type RotValue =
  | { quat: Quat; delta?: boolean }
  | { euler: Vec3; order?: string; delta?: boolean }
  | { flex?: number; deviation?: number; twist?: number; curl?: number; splay?: number };

export interface Limits {
  flex?: [number, number];
  deviation?: [number, number];
  twist?: [number, number];
  /** Aliases for finger bones. */
  curl?: [number, number];
  splay?: [number, number];
}

/** Human-range defaults used when limit.apply is called without `limits`. */
export const HUMAN_LIMITS: Record<string, Limits> = {
  wrist: { flex: [-70, 80], deviation: [-40, 30], twist: [-90, 90] },
  forearm: { twist: [-90, 90] },
  finger: { flex: [-20, 100], deviation: [-25, 25] },
  thumb: { flex: [-40, 70], deviation: [-45, 45] },
};

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const r = (v: number, d = 3): number => { const k = 10 ** d; return Math.round(v * k) / k; };
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const angleDeg = (a: Quat, b: Quat): number =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * DEG;
const isDead = (q: Quat): boolean => q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] < 0.25;
const smooth01 = (x: number): number => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** Intrinsic Euler (degrees) → quaternion: order "ZYX" = qz ⊗ qy ⊗ qx (three.js convention). */
function eulerToQuat(e: Vec3, order: string): Quat {
  const o = order.toUpperCase();
  if (!/^[XYZ]{3}$/.test(o) || new Set(o).size !== 3) throw new ApiError(`euler order must be a permutation of XYZ, got "${order}"`);
  let q: Quat = [0, 0, 0, 1];
  for (const ch of o) {
    const i = ch === "X" ? 0 : ch === "Y" ? 1 : 2;
    const h = (e[i] * RAD) / 2;
    const a: Quat = [0, 0, 0, Math.cos(h)];
    a[i] = Math.sin(h);
    q = quatMul(q, a);
  }
  return quatNormalize(q);
}

interface Snapshot { edits: string; counter: number; }

export class Session {
  name: string;
  source: Uint8Array;
  raw: WanimClip;
  character: number;
  /** The recording exactly as converted — never edited. */
  base: ConvertedClip;
  edits: Edits;
  timeOffset: number;
  allow: Set<number> | null;
  deny: Set<number>;
  protectForearmTwist: boolean;
  /** Every mutating operation, in order (audit trail). */
  log: Array<{ n: number; op: string; args: unknown }> = [];

  private layerCounter = 0;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private preLayerCache: ConvertedClip | null = null;
  private editedCache: ConvertedClip | null = null;
  private axesCache = new Map<number, BoneAxes>();

  constructor(source: Uint8Array, opts: SessionOpts = {}) {
    this.source = source;
    this.name = opts.name ?? "recording";
    this.raw = parseWanim(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer);
    this.character = opts.character ?? 0;
    this.base = convertCharacter(this.raw, this.character);
    this.edits = defaultEdits();
    this.timeOffset = opts.timeOffset ?? 0;
    this.allow = opts.allowBones && opts.allowBones.length ? new Set(this.bones(opts.allowBones)) : null;
    this.deny = new Set(opts.denyBones ? this.bones(opts.denyBones) : []);
    this.protectForearmTwist = opts.protectForearmTwist ?? /twistfix/i.test(this.name);
  }

  // ---- bones / time ------------------------------------------------------------

  /**
   * Resolve bone references to indexes. Accepts Unity HumanBodyBones names
   * ("RightHand"), indexes (18), `*` globs ("Left*Proximal"), and the groups
   * "LeftFingers" / "RightFingers" (15 bones each) and "LeftHandAll" /
   * "RightHandAll" (hand + fingers).
   */
  bones(refs: BoneRef[] | BoneRef): number[] {
    const out: number[] = [];
    const names = this.base.names;
    const add = (i: number): void => { if (!out.includes(i)) out.push(i); };
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
      if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
        const i = Number(ref);
        if (!Number.isInteger(i) || i < 0 || i >= names.length) throw new ApiError(`bone index ${ref} out of range (0-${names.length - 1})`);
        add(i);
        continue;
      }
      const g = /^(Left|Right)(Fingers|HandAll)$/.exec(ref);
      if (g) {
        const side = g[1] as "Left" | "Right";
        if (g[2] === "HandAll") add(names.indexOf(`${side}Hand`));
        for (const n of fingerBoneNames(side)) add(names.indexOf(n));
        continue;
      }
      if (ref.includes("*")) {
        const re = new RegExp(`^${ref.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
        const hits = names.map((n, i) => (re.test(n) ? i : -1)).filter((i) => i >= 0);
        if (!hits.length) throw new ApiError(`bone pattern "${ref}" matches nothing`);
        hits.forEach(add);
        continue;
      }
      const i = names.findIndex((n) => n.toLowerCase() === ref.toLowerCase());
      if (i < 0) throw new ApiError(`unknown bone "${ref}" (use a Unity HumanBodyBones name, e.g. RightHand, or an index)`);
      add(i);
    }
    return out;
  }

  /** Refuse to write a bone outside the session's scope. */
  private guard(bones: number[], op: string): void {
    for (const b of bones) {
      const name = this.base.names[b];
      if (this.deny.has(b)) throw new ApiError(`${op}: ${name} is on this session's deny list — refused, nothing was changed`);
      if (this.allow && !this.allow.has(b)) throw new ApiError(`${op}: ${name} is not on this session's allow list — refused, nothing was changed`);
    }
  }

  get frames(): number { return this.base.times.length; }
  /** API time of a frame. */
  timeOf(f: number): number { return frameTime(this.base, f) + this.timeOffset; }
  /** API time → playback time (what rig keys store). */
  private play(t: number): number { return t - this.timeOffset; }

  private frameAt(a: { time?: number; frame?: number }, what = "time"): number {
    if (a.frame !== undefined) {
      if (!Number.isInteger(a.frame) || a.frame < 0 || a.frame >= this.frames) throw new ApiError(`${what}: frame ${a.frame} out of range (0-${this.frames - 1})`);
      return a.frame;
    }
    if (a.time === undefined || !Number.isFinite(a.time)) throw new ApiError(`${what}: pass a time (seconds) or a frame`);
    this.checkTime(a.time, what);
    return nearestFrame(this.base, this.play(a.time));
  }

  private checkTime(t: number, what: string): void {
    const lo = this.timeOffset;
    const hi = this.timeOffset + this.base.duration;
    if (!Number.isFinite(t) || t < lo - 1e-6 || t > hi + 1e-6) {
      throw new ApiError(`${what} ${t} s is outside this clip (${r(lo)}–${r(hi)} s${this.timeOffset ? `, timeOffset ${r(this.timeOffset)}` : ""})`);
    }
  }

  private range(a: { t0?: number; t1?: number }, what: string): { t0: number; t1: number } {
    const t0 = a.t0 ?? this.timeOffset;
    const t1 = a.t1 ?? this.timeOffset + this.base.duration;
    this.checkTime(t0, `${what} t0`);
    this.checkTime(t1, `${what} t1`);
    if (t1 < t0) throw new ApiError(`${what}: t1 (${t1}) is before t0 (${t0})`);
    return { t0, t1 };
  }

  /** Frames whose API time lies in [t0, t1]. */
  private framesIn(t0: number, t1: number): { f0: number; f1: number } | null {
    const p0 = this.play(t0) - 1e-9;
    const p1 = this.play(t1) + 1e-9;
    let f0 = -1;
    let f1 = -1;
    for (let f = 0; f < this.frames; f++) {
      const t = frameTime(this.base, f);
      if (t < p0) continue;
      if (t > p1) break;
      if (f0 < 0) f0 = f;
      f1 = f;
    }
    return f0 < 0 ? null : { f0, f1 };
  }

  axes(bone: number): BoneAxes {
    let a = this.axesCache.get(bone);
    if (!a) this.axesCache.set(bone, (a = boneAxes(this.base, bone)));
    return a;
  }

  // ---- evaluation --------------------------------------------------------------

  private invalidate(layersOnly = false): void {
    this.editedCache = null;
    if (!layersOnly) this.preLayerCache = null;
  }

  /** The clip after filters, before rig layers. */
  private preLayer(): ConvertedClip {
    if (!this.preLayerCache) {
      this.preLayerCache = runPipeline(this.base, { ...this.edits, layers: [] }, { target: "wanim" });
    }
    return this.preLayerCache;
  }

  /** The fully edited clip (what an export writes). Same frames as the source unless a time warp is loaded. */
  edited(): ConvertedClip {
    if (!this.editedCache) this.editedCache = applyRigLayers(this.preLayer(), this.edits.layers);
    return this.editedCache;
  }

  private requireSourceTiming(op: string): void {
    if (anyWarp(this.edits.warp)) {
      throw new ApiError(`${op}: a time warp is loaded (it changes timing), which this session cannot edit around — remove it first`);
    }
  }

  /** Local rotation of a bone at a frame with only layers [0, upTo) applied. */
  private localBelow(bone: number, f: number, upTo: number): Quat {
    const pre = this.preLayer();
    if (upTo <= 0) return pre.localQuat[bone][f];
    const pose = poseAtFrame(pre, f);
    pose.quat = pose.quat.slice();
    pose.pos = pose.pos.slice();
    applyLayersToPose(pose, pre.names, pre.parents, this.edits.layers.slice(0, upTo), frameTime(pre, f));
    return pose.quat[bone];
  }

  private describe(bone: number, q: Quat): Record<string, unknown> {
    const ax = this.axes(bone);
    const a = decompose(ax, q);
    const e = quatToEulerZYX(isDead(q) ? [0, 0, 0, 1] : q);
    const out: Record<string, unknown> = {
      quat: q.map((v) => r(v, 6)),
      eulerZYX: [r(e[0] * DEG), r(e[1] * DEG), r(e[2] * DEG)],
    };
    if (ax.kind === "finger") Object.assign(out, { curl: r(a.flex), splay: r(a.deviation), twist: r(a.twist) });
    else Object.assign(out, { flex: r(a.flex), deviation: r(a.deviation), twist: r(a.twist), swing: r(a.swing) });
    return out;
  }

  /**
   * Read joint values. `{time}` or `{frame}` for one frame, `{t0, t1}` for a
   * range (every `step`-th frame). Each bone reports `base` (the recording)
   * and `edited`: local quat, Euler ZYX°, anatomical components, and — with
   * `world: true` — world position in meters.
   */
  evaluate(a: { bones: BoneRef[] | BoneRef; time?: number; frame?: number; t0?: number; t1?: number; step?: number; world?: boolean }): Record<string, unknown> {
    const bones = this.bones(a.bones);
    let f0: number;
    let f1: number;
    if (a.t0 !== undefined || a.t1 !== undefined) {
      const { t0, t1 } = this.range(a, "evaluate");
      const fr = this.framesIn(t0, t1);
      if (!fr) throw new ApiError(`evaluate: no frames between ${t0} and ${t1} s`);
      ({ f0, f1 } = fr);
    } else {
      f0 = f1 = this.frameAt(a, "evaluate");
    }
    const step = Math.max(1, Math.floor(a.step ?? 1));
    const count = Math.floor((f1 - f0) / step) + 1;
    if (count * bones.length > 4000) {
      throw new ApiError(`evaluate: ${count} frames × ${bones.length} bones is too much to return — narrow the range or raise step (≤ 4000 samples)`);
    }
    const ed = this.edited();
    const sameFrames = ed.times.length === this.frames;
    const out = [];
    for (let f = f0; f <= f1; f += step) {
      const row: Record<string, unknown> = {};
      const wb = a.world ? worldFromLocal(this.base.parents, poseAtFrame(this.base, f)) : null;
      const we = a.world && sameFrames ? worldFromLocal(ed.parents, poseAtFrame(ed, f)) : null;
      for (const b of bones) {
        const qb = this.base.localQuat[b][f];
        const qe = sameFrames ? ed.localQuat[b][f] : qb;
        const base = this.describe(b, qb);
        const edited = this.describe(b, qe);
        if (wb) base.worldM = wb.pos[b].map((v) => r(v, 4));
        if (we) edited.worldM = we.pos[b].map((v) => r(v, 4));
        row[this.base.names[b]] = { base, edited, changedDeg: r(angleDeg(qb, qe)) };
      }
      out.push({ frame: f, time: r(this.timeOf(f), 4), bones: row });
    }
    return { frames: out };
  }

  /**
   * What the edits changed versus the recording: per bone, the frames
   * touched, the largest change, and the largest per-frame step of the
   * correction at its edges (a pop check — a blended edit ramps in over many
   * frames, so its edge step is small).
   */
  diff(a: { bones?: BoneRef[] | BoneRef; t0?: number; t1?: number } = {}): Record<string, unknown> {
    this.requireSourceTiming("diff");
    const ed = this.edited();
    const bones = a.bones !== undefined ? this.bones(a.bones) : this.base.names.map((_, i) => i);
    const { t0, t1 } = this.range(a, "diff");
    const fr = this.framesIn(t0, t1);
    const changed = [];
    const EDGE = 8; // frames at each end of a changed run that count as "edge"
    if (fr) {
      for (const b of bones) {
        const bq = this.base.localQuat[b];
        const eq = ed.localQuat[b];
        if (bq === eq) continue;
        let n = 0, first = -1, last = -1, maxDeg = 0, peak = -1, maxStep = 0, edgeStep = 0, runStart = -1;
        let prevCorr: Quat = [0, 0, 0, 1];
        const closeRun = (endF: number): void => {
          // Step back to identity after the run, and re-scan the run's tail.
          if (runStart < 0) return;
          for (let f = Math.max(runStart, endF - EDGE + 1); f <= endF + 1 && f < this.frames; f++) {
            const c0 = f - 1 >= runStart && f - 1 <= endF ? quatMul(conj(bq[f - 1]), eq[f - 1]) : [0, 0, 0, 1] as Quat;
            const c1 = f <= endF ? quatMul(conj(bq[f]), eq[f]) : [0, 0, 0, 1] as Quat;
            edgeStep = Math.max(edgeStep, angleDeg(c0, c1));
          }
          runStart = -1;
        };
        for (let f = fr.f0; f <= fr.f1; f++) {
          const d = bq[f] === eq[f] || isDead(bq[f]) ? 0 : angleDeg(bq[f], eq[f]);
          if (d * RAD <= DIRTY_ROT_RAD) {
            if (runStart >= 0) closeRun(f - 1);
            prevCorr = [0, 0, 0, 1];
            continue;
          }
          const corr = quatMul(conj(bq[f]), eq[f]);
          const step = angleDeg(prevCorr, corr);
          if (runStart < 0) runStart = f;
          if (f - runStart < EDGE) edgeStep = Math.max(edgeStep, step);
          maxStep = Math.max(maxStep, step);
          prevCorr = corr;
          n++;
          if (first < 0) first = f;
          last = f;
          if (d > maxDeg) { maxDeg = d; peak = f; }
        }
        closeRun(fr.f1);
        if (n) {
          changed.push({
            bone: b, name: this.base.names[b], framesChanged: n,
            frameStart: first, frameEnd: last, tStart: r(this.timeOf(first), 4), tEnd: r(this.timeOf(last), 4),
            maxChangeDeg: r(maxDeg), peakTime: r(this.timeOf(peak), 4),
            edgeStepDeg: r(Math.max(edgeStep, 0)), maxCorrectionStepDeg: r(maxStep),
          });
        }
      }
    }
    const hipsMoved = ed.localPos[0] !== this.base.localPos[0] &&
      ed.localPos[0].some((p, f) => Math.hypot(p[0] - this.base.localPos[0][f][0], p[1] - this.base.localPos[0][f][1], p[2] - this.base.localPos[0][f][2]) > 1e-7);
    return {
      t0: r(t0, 4), t1: r(t1, 4),
      bonesChanged: changed.map((c) => c.name),
      bonesChecked: bones.length,
      hipsPositionChanged: hipsMoved,
      maxEdgeStepDeg: r(Math.max(0, ...changed.map((c) => c.edgeStepDeg))),
      changed,
    };
  }

  /** Find problems automatically (see scan.ts). Scans the EDITED motion unless `source: "base"`. */
  scan(a: ScanOpts & { source?: "edited" | "base"; t0?: number; t1?: number; bones?: BoneRef[] | BoneRef } = {}): { issues: ScanIssue[]; scanned: Record<string, unknown> } {
    const clip = a.source === "base" ? this.base : this.edited();
    const { t0, t1 } = this.range(a, "scan");
    const bones = a.bones !== undefined ? this.bones(a.bones) : undefined;
    const issues = scanClip(clip, { ...a, bones, t0: this.play(t0), t1: this.play(t1) }, (b) => boneAxes(clip, b));
    for (const i of issues) {
      i.tStart = r(i.tStart + this.timeOffset, 4);
      i.tEnd = r(i.tEnd + this.timeOffset, 4);
      i.peakTime = r(i.peakTime + this.timeOffset, 4);
      const fix = i.suggestedFix as Record<string, unknown> | null;
      if (fix) for (const k of ["t0", "t1", "donorTime"]) if (typeof fix[k] === "number") fix[k] = r((fix[k] as number) + this.timeOffset, 4);
    }
    return {
      issues,
      scanned: { source: a.source ?? "edited", t0: r(t0, 4), t1: r(t1, 4), frames: clip.times.length, kinds: [...new Set(issues.map((i) => i.kind))] },
    };
  }

  // ---- undo --------------------------------------------------------------------

  private snapshot(): Snapshot {
    return { edits: JSON.stringify(this.edits), counter: this.layerCounter };
  }
  private restore(s: Snapshot): void {
    this.edits = JSON.parse(s.edits) as Edits;
    this.layerCounter = s.counter;
    this.invalidate();
  }

  /** Run one mutating operation: snapshot for undo, roll back if it throws. */
  private mutate<T>(op: string, args: unknown, fn: () => T): T {
    const before = this.snapshot();
    try {
      const out = fn();
      this.undoStack.push(before);
      this.redoStack.length = 0;
      this.log.push({ n: this.log.length + 1, op, args });
      return out;
    } catch (err) {
      this.restore(before);
      throw err;
    }
  }

  undo(): { undone: string | null; remaining: number } {
    const s = this.undoStack.pop();
    if (!s) return { undone: null, remaining: 0 };
    this.redoStack.push(this.snapshot());
    this.restore(s);
    const entry = this.log.pop();
    return { undone: entry?.op ?? null, remaining: this.undoStack.length };
  }

  redo(): { redone: boolean; remaining: number } {
    const s = this.redoStack.pop();
    if (!s) return { redone: false, remaining: 0 };
    this.undoStack.push(this.snapshot());
    this.restore(s);
    this.log.push({ n: this.log.length + 1, op: "redo", args: {} });
    return { redone: true, remaining: this.redoStack.length };
  }

  // ---- layers ------------------------------------------------------------------

  private layerIndex(ref: LayerRef): number {
    const layers = this.edits.layers;
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      const i = Number(ref);
      if (!Number.isInteger(i) || i < 0 || i >= layers.length) throw new ApiError(`layer ${ref} does not exist (${layers.length} layer(s))`);
      return i;
    }
    const i = layers.findIndex((l) => l.name === ref);
    if (i < 0) throw new ApiError(`no layer named "${ref}" (layers: ${layers.map((l) => l.name).join(", ") || "none"})`);
    return i;
  }

  private layerInfo(i: number): Record<string, unknown> {
    const l = this.edits.layers[i];
    return {
      layer: i, name: l.name, mode: l.mode, weight: l.weight, extent: l.extent, fade: l.fadeS, enabled: l.enabled,
      bones: l.tracks.map((t) => t.bone),
      keys: l.tracks.reduce((n, t) => n + t.rotKeys.length + t.posKeys.length, 0),
    };
  }

  private newLayer(name: string | undefined, mode: "additive" | "override", extent: "fade" | "hold", fadeS: number, weight = 1): RigLayer {
    this.layerCounter++;
    const layer: RigLayer = {
      name: name ?? `Layer ${this.layerCounter}`,
      mode, extent, fadeS, weight, enabled: true, tracks: [],
    };
    if (this.edits.layers.some((l) => l.name === layer.name)) layer.name = `${layer.name} (${this.layerCounter})`;
    this.edits.layers.push(layer);
    return layer;
  }

  /** layer.create — a new (top) layer. Additive layers store deltas; override layers store poses. */
  layerCreate(a: { name?: string; mode?: "additive" | "override"; weight?: number; extent?: "fade" | "hold"; fade?: number } = {}): Record<string, unknown> {
    const mode = a.mode ?? "additive";
    if (mode !== "additive" && mode !== "override") throw new ApiError(`layer mode must be additive | override, got "${String(a.mode)}"`);
    const extent = a.extent ?? "fade";
    if (extent !== "fade" && extent !== "hold") throw new ApiError(`layer extent must be fade | hold, got "${String(a.extent)}"`);
    const weight = a.weight ?? 1;
    if (!(weight >= 0 && weight <= 1)) throw new ApiError("layer weight must be in [0, 1]");
    const fade = a.fade ?? 0.5;
    if (!(fade >= 0)) throw new ApiError("layer fade must be ≥ 0 seconds");
    return this.mutate("layer.create", a, () => {
      this.newLayer(a.name, mode, extent, fade, weight);
      this.invalidate(true);
      return this.layerInfo(this.edits.layers.length - 1);
    });
  }

  /** layer.set — change name / weight / extent / fade / enabled (mode only while the layer is empty). */
  layerSet(a: { layer: LayerRef; name?: string; mode?: "additive" | "override"; weight?: number; extent?: "fade" | "hold"; fade?: number; enabled?: boolean }): Record<string, unknown> {
    const i = this.layerIndex(a.layer);
    return this.mutate("layer.set", a, () => {
      const l = this.edits.layers[i];
      this.guard(this.bones(l.tracks.map((t) => t.bone)), "layer.set");
      if (a.mode !== undefined && a.mode !== l.mode) {
        if (l.tracks.some((t) => t.rotKeys.length + t.posKeys.length)) {
          throw new ApiError("layer.set: cannot change the mode of a layer that has keys (additive keys are deltas, override keys are poses) — make a new layer");
        }
        l.mode = a.mode;
      }
      if (a.name !== undefined) l.name = a.name;
      if (a.weight !== undefined) { if (!(a.weight >= 0 && a.weight <= 1)) throw new ApiError("layer weight must be in [0, 1]"); l.weight = a.weight; }
      if (a.extent !== undefined) l.extent = a.extent;
      if (a.fade !== undefined) l.fadeS = a.fade;
      if (a.enabled !== undefined) l.enabled = a.enabled;
      this.invalidate(true);
      return this.layerInfo(i);
    });
  }

  layerDelete(a: { layer: LayerRef }): Record<string, unknown> {
    const i = this.layerIndex(a.layer);
    return this.mutate("layer.delete", a, () => {
      const [gone] = this.edits.layers.splice(i, 1);
      this.invalidate(true);
      return { deleted: gone.name, layers: this.edits.layers.length };
    });
  }

  layerList(): Record<string, unknown> {
    return { layers: this.edits.layers.map((_, i) => this.layerInfo(i)) };
  }

  // ---- keys --------------------------------------------------------------------

  /** Turn a value spec into the target LOCAL rotation for a bone, given what is below it. */
  private targetRot(bone: number, below: Quat, value: RotValue): { target: Quat; delta: Quat | null } {
    const v = value as Record<string, unknown>;
    const ax = this.axes(bone);
    if (Array.isArray(v.quat)) {
      const q = v.quat as number[];
      if (q.length !== 4 || q.some((x) => typeof x !== "number" || !Number.isFinite(x)) || Math.hypot(q[0], q[1], q[2], q[3]) < 1e-6) {
        throw new ApiError("value.quat must be [x, y, z, w] with nonzero length");
      }
      const n = quatNormalize(q as Quat);
      return v.delta ? { target: quatNormalize(quatMul(below, n)), delta: n } : { target: n, delta: null };
    }
    if (Array.isArray(v.euler)) {
      const e = v.euler as number[];
      if (e.length !== 3 || e.some((x) => typeof x !== "number" || !Number.isFinite(x))) throw new ApiError("value.euler must be [x, y, z] in degrees");
      const n = eulerToQuat(e as Vec3, typeof v.order === "string" ? v.order : "ZYX");
      return v.delta ? { target: quatNormalize(quatMul(below, n)), delta: n } : { target: n, delta: null };
    }
    const keys = ["flex", "deviation", "twist", "curl", "splay"].filter((k) => v[k] !== undefined);
    if (!keys.length) throw new ApiError("value needs one of: quat, euler (+order), or anatomical components (flex / deviation / twist, or curl / splay for fingers)");
    for (const k of keys) if (typeof v[k] !== "number" || !Number.isFinite(v[k] as number)) throw new ApiError(`value.${k} must be a number of degrees`);
    if (ax.kind === "forearm" && this.protectForearmTwist && v.twist !== undefined) {
      throw new ApiError(`${ax.name}: forearm twist is protected on this file (TWISTFIX — an external tool already redistributed it); refused`);
    }
    const cur: Anatomy = decompose(ax, isDead(below) ? [0, 0, 0, 1] : below);
    const target = compose(ax, {
      flex: (v.flex ?? v.curl ?? cur.flex) as number,
      deviation: (v.deviation ?? v.splay ?? cur.deviation) as number,
      twist: (v.twist ?? cur.twist) as number,
    });
    return { target, delta: null };
  }

  /**
   * key.set — key one bone's rotation at a time/frame on a layer.
   * The value is the pose you want (a quat, Euler degrees, or anatomical
   * components — omitted components keep the current value); on an additive
   * layer it is stored as the delta that produces it. Pass `delta: true` with
   * quat/euler to give the raw layer delta instead.
   */
  keySet(a: { layer: LayerRef; bone: BoneRef; time?: number; frame?: number; value: RotValue; ease?: KeyEase }): Record<string, unknown> {
    this.requireSourceTiming("key.set");
    const li = this.layerIndex(a.layer);
    const [bone] = this.bones(a.bone);
    const f = this.frameAt(a, "key.set");
    if (!a.value || typeof a.value !== "object") throw new ApiError("key.set: value is required");
    if (a.ease !== undefined && !["linear", "smooth", "step"].includes(a.ease)) throw new ApiError("ease must be linear | smooth | step");
    return this.mutate("key.set", a, () => {
      this.guard([bone], "key.set");
      const layer = this.edits.layers[li];
      const below = this.localBelow(bone, f, li);
      if (isDead(below)) throw new ApiError(`key.set: ${this.base.names[bone]} was not recorded on this avatar (all-zero rotation)`);
      const { target, delta } = this.targetRot(bone, below, a.value);
      const keyQ = layer.mode === "additive" ? (delta ?? quatNormalize(quatMul(conj(below), target))) : target;
      const t = frameTime(this.base, f);
      const track = getBoneTrack(layer, this.base.names[bone], true)!;
      setRotKey(track, t, keyQ);
      if (a.ease) setKeyEase(track, t, a.ease);
      this.invalidate(true);
      const now = this.edited().localQuat[bone][f];
      return {
        layer: li, bone: this.base.names[bone], frame: f, time: r(this.timeOf(f), 4),
        before: this.describe(bone, this.base.localQuat[bone][f]), after: this.describe(bone, now),
        note: layer.extent === "fade"
          ? `fade layer: this key eases in/out over ${layer.fadeS} s on each side`
          : "hold layer: the first/last key extends to the ends of the clip",
      };
    });
  }

  keyDelete(a: { layer: LayerRef; bone: BoneRef; time?: number; frame?: number }): Record<string, unknown> {
    const li = this.layerIndex(a.layer);
    const [bone] = this.bones(a.bone);
    const f = this.frameAt(a, "key.delete");
    return this.mutate("key.delete", a, () => {
      this.guard([bone], "key.delete");
      const track = getBoneTrack(this.edits.layers[li], this.base.names[bone]);
      const n = track ? deleteKeysAt(track, frameTime(this.base, f), 1 / 120) : 0;
      if (!n) throw new ApiError(`key.delete: no key on ${this.base.names[bone]} at ${r(this.timeOf(f), 3)} s in layer ${li}`);
      this.invalidate(true);
      return { deleted: n };
    });
  }

  /** key.list — keys on a layer (optionally one bone), with their anatomical reading. */
  keyList(a: { layer?: LayerRef; bone?: BoneRef; max?: number } = {}): Record<string, unknown> {
    const layers = a.layer !== undefined ? [this.layerIndex(a.layer)] : this.edits.layers.map((_, i) => i);
    const only = a.bone !== undefined ? this.base.names[this.bones(a.bone)[0]] : null;
    const max = a.max ?? 400;
    const out = [];
    let total = 0;
    for (const li of layers) {
      const l = this.edits.layers[li];
      for (const tr of l.tracks) {
        if (only && tr.bone !== only) continue;
        const b = this.base.names.indexOf(tr.bone);
        total += tr.rotKeys.length;
        for (const k of tr.rotKeys) {
          if (out.length >= max) break;
          const e = quatToEulerZYX(k.q);
          out.push({
            layer: li, bone: tr.bone, time: r(k.time + this.timeOffset, 4), ease: k.ease ?? "linear",
            [l.mode === "additive" ? "deltaEulerZYX" : "eulerZYX"]: [r(e[0] * DEG), r(e[1] * DEG), r(e[2] * DEG)],
            ...(l.mode === "override" && b >= 0 ? (({ quat: _q, eulerZYX: _e, ...rest }) => rest)(this.describe(b, k.q) as { quat: unknown; eulerZYX: unknown }) : {}),
          });
        }
      }
    }
    return { total, shown: out.length, keys: out };
  }

  /** keys.smooth / keys.reduce — the existing key tools, by time range. */
  keysSmooth(a: { layer: LayerRef; bones: BoneRef[] | BoneRef; t0?: number; t1?: number; amount?: number }): Record<string, unknown> {
    return this.keysTool("keys.smooth", a, (tr, p0, p1) => smoothKeys(tr, p0, p1, a.amount ?? 0.5));
  }
  keysReduce(a: { layer: LayerRef; bones: BoneRef[] | BoneRef; t0?: number; t1?: number; toleranceDeg?: number }): Record<string, unknown> {
    return this.keysTool("keys.reduce", a, (tr, p0, p1) => reduceKeys(tr, 0.005, (a.toleranceDeg ?? 1) * RAD, p0, p1));
  }
  private keysTool(op: string, a: { layer: LayerRef; bones: BoneRef[] | BoneRef; t0?: number; t1?: number }, fn: (tr: RigTrack, p0: number, p1: number) => number): Record<string, unknown> {
    const li = this.layerIndex(a.layer);
    const bones = this.bones(a.bones);
    const { t0, t1 } = this.range(a, op);
    return this.mutate(op, a, () => {
      this.guard(bones, op);
      let n = 0;
      for (const b of bones) {
        const tr = getBoneTrack(this.edits.layers[li], this.base.names[b]);
        if (tr) n += fn(tr, this.play(t0), this.play(t1));
      }
      this.invalidate(true);
      return { keysAffected: n };
    });
  }

  // ---- span operations (each makes its own override layer) -----------------------

  /** Write one bone's per-frame override values as dense keys over [f0, f1]. */
  private denseTrack(layer: RigLayer, bone: number, f0: number, f1: number, value: (f: number) => Quat): void {
    const track: RigTrack = { bone: this.base.names[bone], posKeys: [], rotKeys: [] };
    for (let f = f0; f <= f1; f++) track.rotKeys.push({ time: frameTime(this.base, f), q: value(f) });
    layer.tracks.push(track);
  }

  private spanReport(bones: number[], before: ConvertedClip): Array<Record<string, unknown>> {
    const after = this.edited();
    const out = [];
    for (const b of bones) {
      let n = 0, first = -1, last = -1, max = 0;
      for (let f = 0; f < this.frames; f++) {
        const q0 = before.localQuat[b][f];
        const q1 = after.localQuat[b][f];
        if (q0 === q1) continue;
        const d = angleDeg(q0, q1);
        if (d * RAD <= DIRTY_ROT_RAD) continue;
        n++;
        if (first < 0) first = f;
        last = f;
        if (d > max) max = d;
      }
      out.push({
        bone: this.base.names[b], framesChanged: n,
        ...(n ? { frameStart: first, frameEnd: last, tStart: r(this.timeOf(first), 4), tEnd: r(this.timeOf(last), 4), maxChangeDeg: r(max) } : {}),
      });
    }
    return out;
  }

  /**
   * hold.insert — copy a clean pose from `donorTime` across [t0, t1] for the
   * given bones, easing in over `blendIn` before t0 and out over `blendOut`
   * after t1. Makes a new override layer on top of the stack.
   */
  holdInsert(a: { bones: BoneRef[] | BoneRef; donorTime?: number; donorFrame?: number; t0: number; t1: number; blendIn?: number; blendOut?: number; name?: string }): Record<string, unknown> {
    this.requireSourceTiming("hold.insert");
    const bones = this.bones(a.bones);
    if (a.t0 === undefined || a.t1 === undefined) throw new ApiError("hold.insert: t0 and t1 are required");
    const { t0, t1 } = this.range(a, "hold.insert");
    const donor = this.frameAt({ time: a.donorTime, frame: a.donorFrame }, "hold.insert donor");
    const blendIn = a.blendIn ?? 0.25;
    const blendOut = a.blendOut ?? 0.25;
    if (!(blendIn >= 0) || !(blendOut >= 0)) throw new ApiError("hold.insert: blendIn / blendOut must be ≥ 0 seconds");
    return this.mutate("hold.insert", a, () => {
      this.guard(bones, "hold.insert");
      const cur = this.edited();
      const live = bones.filter((b) => !isDead(cur.localQuat[b][donor]));
      const name = a.name ?? `hold ${live.length === 1 ? this.base.names[live[0]] : `${live.length} bones`} ${r(t0, 2)}-${r(t1, 2)}`;
      const p0 = this.play(t0);
      const p1 = this.play(t1);
      if (Math.abs(blendIn - blendOut) < 1e-9) {
        // Symmetric blend = exactly what a 2-key fade layer does: sparse, editable keys.
        const layer = this.newLayer(name, "override", "fade", Math.max(blendIn, 1e-4));
        for (const b of live) {
          const q = cur.localQuat[b][donor].slice() as Quat;
          layer.tracks.push({ bone: this.base.names[b], posKeys: [], rotKeys: p1 - p0 > 1 / 120 ? [{ time: p0, q }, { time: p1, q: q.slice() as Quat }] : [{ time: p0, q }] });
        }
      } else {
        const fr = this.framesIn(t0 - blendIn, t1 + blendOut) ?? this.framesIn(Math.max(this.timeOffset, t0 - blendIn), Math.min(this.timeOffset + this.base.duration, t1 + blendOut));
        const w = (f: number): number => {
          const t = frameTime(this.base, f);
          if (t < p0) return blendIn > 0 ? smooth01(1 - (p0 - t) / blendIn) : 0;
          if (t > p1) return blendOut > 0 ? smooth01(1 - (t - p1) / blendOut) : 0;
          return 1;
        };
        const clampFr = this.framesIn(Math.max(this.timeOffset, t0 - blendIn), Math.min(this.timeOffset + this.base.duration, t1 + blendOut)) ?? fr;
        if (!clampFr) throw new ApiError("hold.insert: no frames in that range");
        const layer = this.newLayer(name, "override", "fade", 1e-4);
        for (const b of live) {
          const q = cur.localQuat[b][donor];
          this.denseTrack(layer, b, clampFr.f0, clampFr.f1, (f) => quatNormalize(quatSlerp(cur.localQuat[b][f], q, w(f))));
        }
      }
      this.invalidate(true);
      return {
        layer: this.edits.layers.length - 1, name: this.edits.layers[this.edits.layers.length - 1].name,
        donorFrame: donor, donorTime: r(this.timeOf(donor), 4),
        skippedUnrecorded: bones.filter((b) => !live.includes(b)).map((b) => this.base.names[b]),
        changed: this.spanReport(live, cur),
      };
    });
  }

  /**
   * limit.apply — scoped joint limits: clamp flex / deviation / twist (degrees)
   * of the given bones inside [t0, t1], easing the correction in and out over
   * `blend` seconds outside the range. `softness` rounds the clamp's corner
   * (degrees). Omit `limits` for human-range defaults by joint type. Written
   * as an override layer so it is visible, editable and undoable.
   */
  limitApply(a: { bones: BoneRef[] | BoneRef; t0: number; t1: number; limits?: Limits; softness?: number; blend?: number; name?: string }): Record<string, unknown> {
    this.requireSourceTiming("limit.apply");
    const bones = this.bones(a.bones);
    if (a.t0 === undefined || a.t1 === undefined) throw new ApiError("limit.apply: t0 and t1 are required");
    const { t0, t1 } = this.range(a, "limit.apply");
    const soft = a.softness ?? 5;
    const blend = a.blend ?? 0.25;
    if (!(soft >= 0)) throw new ApiError("limit.apply: softness must be ≥ 0 degrees");
    if (!(blend >= 0)) throw new ApiError("limit.apply: blend must be ≥ 0 seconds");
    const pair = (v: unknown, k: string): [number, number] | undefined => {
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.length !== 2 || v.some((x) => typeof x !== "number" || !Number.isFinite(x)) || v[0] > v[1]) {
        throw new ApiError(`limit.apply: limits.${k} must be [min, max] in degrees`);
      }
      return [v[0], v[1]];
    };
    return this.mutate("limit.apply", a, () => {
      this.guard(bones, "limit.apply");
      const cur = this.edited();
      const p0 = this.play(t0);
      const p1 = this.play(t1);
      const fr = this.framesIn(Math.max(this.timeOffset, t0 - blend), Math.min(this.timeOffset + this.base.duration, t1 + blend));
      if (!fr) throw new ApiError("limit.apply: no frames in that range");
      const weight = (f: number): number => {
        const t = frameTime(this.base, f);
        if (t < p0) return blend > 0 ? smooth01(1 - (p0 - t) / blend) : 0;
        if (t > p1) return blend > 0 ? smooth01(1 - (t - p1) / blend) : 0;
        return 1;
      };
      const tracks: Array<{ bone: number; f0: number; f1: number; vals: Map<number, Quat> }> = [];
      const applied: Record<string, Limits> = {};
      for (const b of bones) {
        const ax = this.axes(b);
        const def = a.limits ?? HUMAN_LIMITS[ax.kind === "finger" && /Thumb/.test(ax.name) ? "thumb" : ax.kind];
        if (!def) throw new ApiError(`limit.apply: no default limits for ${ax.name} — pass limits: {flex: [min, max], deviation: [...], twist: [...]}`);
        const lim = {
          flex: pair(def.flex ?? def.curl, "flex"),
          deviation: pair(def.deviation ?? def.splay, "deviation"),
          twist: pair(def.twist, "twist"),
        };
        if (!lim.flex && !lim.deviation && !lim.twist) throw new ApiError("limit.apply: limits has no flex / deviation / twist range");
        if (ax.kind === "forearm" && this.protectForearmTwist && lim.twist) {
          throw new ApiError(`${ax.name}: forearm twist is protected on this file (TWISTFIX — an external tool already redistributed it); refused`);
        }
        applied[ax.name] = Object.fromEntries(Object.entries(lim).filter(([, v]) => v)) as Limits;
        const vals = new Map<number, Quat>();
        let first = -1;
        let last = -1;
        for (let f = fr.f0; f <= fr.f1; f++) {
          const q = cur.localQuat[b][f];
          if (isDead(q)) continue;
          const w = weight(f);
          if (w <= 0) continue;
          const an = decompose(ax, q);
          const flex = lim.flex ? softClamp(an.flex, lim.flex[0], lim.flex[1], soft) : an.flex;
          const dev = lim.deviation ? softClamp(an.deviation, lim.deviation[0], lim.deviation[1], soft) : an.deviation;
          const tw = lim.twist ? softClamp(an.twist, lim.twist[0], lim.twist[1], soft) : an.twist;
          if (flex === an.flex && dev === an.deviation && tw === an.twist) continue;
          const out = quatNormalize(quatSlerp(q, compose(ax, { flex, deviation: dev, twist: tw }), w));
          if (angleDeg(q, out) * RAD <= DIRTY_ROT_RAD) continue;
          vals.set(f, out);
          if (first < 0) first = f;
          last = f;
        }
        if (first >= 0) tracks.push({ bone: b, f0: first, f1: last, vals });
      }
      if (!tracks.length) {
        return { changed: false, limits: applied, note: "every frame was already inside these limits — no layer was created" };
      }
      const names = tracks.map((t) => this.base.names[t.bone]);
      const layer = this.newLayer(a.name ?? `limit ${names.length === 1 ? names[0] : `${names.length} bones`} ${r(t0, 2)}-${r(t1, 2)}`, "override", "fade", 1e-4);
      // Dense keys from the first to the last clamped frame; in-between frames
      // that needed no clamp are keyed at their current value (an override
      // layer is at full strength across its whole keyed range).
      for (const t of tracks) this.denseTrack(layer, t.bone, t.f0, t.f1, (f) => t.vals.get(f) ?? (cur.localQuat[t.bone][f].slice() as Quat));
      this.invalidate(true);
      return {
        changed: true, layer: this.edits.layers.length - 1, name: layer.name, limits: applied, softnessDeg: soft, blendS: blend,
        result: this.spanReport(tracks.map((t) => t.bone), cur),
      };
    });
  }

  // ---- scoped filters ------------------------------------------------------------

  /**
   * filter.add — a scoped, non-destructive filter over a bone set and time
   * range (0.25 s blends at the edges): butterworth {cutoffHz}, movingAverage
   * {widthFrames}, despike {thresholdDeg}, keyReduce {toleranceDeg}. Filters
   * run BEFORE the rig layers.
   */
  filterAdd(a: { kind: string; bones: BoneRef[] | BoneRef; t0: number; t1: number; params?: Record<string, number> }): Record<string, unknown> {
    this.requireSourceTiming("filter.add");
    const map: Record<string, CleanFilter> = { butterworth: "butterworth", movingAverage: "smooth", despike: "despike", keyReduce: "reduce" };
    const filter = map[a.kind];
    if (!filter) throw new ApiError(`filter kind must be one of ${Object.keys(map).join(" | ")}, got "${a.kind}"`);
    const bones = this.bones(a.bones);
    if (a.t0 === undefined || a.t1 === undefined) throw new ApiError("filter.add: t0 and t1 are required");
    const { t0, t1 } = this.range(a, "filter.add");
    return this.mutate("filter.add", a, () => {
      this.guard(bones, "filter.add");
      const before = this.edited();
      const id = `f${Date.now().toString(36)}${this.edits.cleanOps.length}`;
      const op: CleanOp = {
        id, bones: bones.map((b) => this.base.names[b]), range: { t0: this.play(t0), t1: this.play(t1) },
        filter, params: { ...(a.params ?? {}) }, enabled: true,
      };
      this.edits.cleanOps.push(op);
      this.invalidate();
      return { id, kind: a.kind, bones: op.bones, changed: this.spanReport(bones, before) };
    });
  }

  filterDelete(a: { id: string }): Record<string, unknown> {
    return this.mutate("filter.delete", a, () => {
      const i = this.edits.cleanOps.findIndex((o) => o.id === a.id);
      if (i < 0) throw new ApiError(`no filter with id "${a.id}" (ids: ${this.edits.cleanOps.map((o) => o.id).join(", ") || "none"})`);
      this.guard(this.bones(this.edits.cleanOps[i].bones.filter((n) => this.base.names.includes(n))), "filter.delete");
      this.edits.cleanOps.splice(i, 1);
      this.invalidate();
      return { deleted: a.id, filters: this.edits.cleanOps.length };
    });
  }

  filterList(): Record<string, unknown> {
    const back: Record<string, string> = { butterworth: "butterworth", smooth: "movingAverage", despike: "despike", reduce: "keyReduce" };
    return {
      filters: this.edits.cleanOps.map((o) => ({
        id: o.id, kind: back[o.filter], bones: o.bones, t0: r(o.range.t0 + this.timeOffset, 4), t1: r(o.range.t1 + this.timeOffset, 4),
        params: o.params, enabled: o.enabled,
      })),
    };
  }

  // ---- persistence ---------------------------------------------------------------

  /** The rig state as `.rig.json` v3 — opens in the web app (File > Load rig) on the same recording. */
  saveRig(): string {
    return JSON.stringify({
      v: 3,
      layers: this.edits.layers,
      mods: this.edits.mods,
      counter: this.layerCounter,
      warp: this.edits.warp,
      ranges: this.edits.ranges,
      cleanOps: this.edits.cleanOps,
      selectionSets: [],
      loop: this.edits.loop,
      feetPlants: this.edits.clean.feetEdits?.removed ?? [],
      pins: [],
      fk: [],
      ikfk: defaultIkfkBlend(),
    }, null, 1);
  }

  /** Replace the session's edits with a `.rig.json` (undoable). Every bone it writes must be in scope. */
  loadRig(json: string): Record<string, unknown> {
    let doc: Record<string, unknown>;
    try { doc = JSON.parse(json) as Record<string, unknown>; } catch (err) {
      throw new ApiError(`rig file is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    if (doc.magic === "wanimscene") doc = (doc.rig ?? {}) as Record<string, unknown>;
    if (!Array.isArray(doc.layers)) throw new ApiError("not a rig file (missing layers)");
    return this.mutate("rig.load", {}, () => {
      const edits = defaultEdits();
      const notes = adoptRigDoc(edits, doc);
      const names = new Set<string>();
      for (const l of edits.layers) for (const t of l.tracks) names.add(t.bone);
      for (const o of edits.cleanOps) for (const n of o.bones) names.add(n);
      this.guard(this.bones([...names].filter((n) => this.base.names.includes(n))), "rig.load");
      this.edits = edits;
      this.layerCounter = typeof doc.counter === "number" ? doc.counter : edits.layers.length;
      this.invalidate();
      if (anyWarp(edits.warp)) notes.push("this rig has a time warp: timing-exact export is unavailable while it is active");
      return { layers: edits.layers.length, filters: edits.cleanOps.length, notes };
    });
  }

  /**
   * Timing-exact .wanim: the original file with only the edited (bone, frame)
   * cells overwritten. Same frame count, same float64 timestamps, every
   * untouched value and every blendshape byte-identical to the source.
   */
  exportWanim(): { bytes: Uint8Array; report: ExactExportReport & { tStart: number | null; tEnd: number | null; timestamps: string; faceBlendshapes: string } } {
    this.requireSourceTiming("export");
    const { bytes, report } = exportWanimExact(this.source, this.raw, this.character, this.base, this.edited());
    return {
      bytes,
      report: {
        ...report,
        tStart: report.frameStart === null ? null : r(this.timeOf(report.frameStart), 4),
        tEnd: report.frameEnd === null ? null : r(this.timeOf(report.frameEnd), 4),
        timestamps: "original float64 values, unchanged",
        faceBlendshapes: "original bytes, unchanged",
      },
    };
  }

  /** Summary of the session: the clip, the scope, and the current edits. */
  status(): Record<string, unknown> {
    const s: ClipSummary = summarizeClip(this.base);
    return {
      name: this.name,
      clip: s,
      timeRange: { t0: r(this.timeOffset, 4), t1: r(this.timeOffset + this.base.duration, 4), timeOffset: r(this.timeOffset, 6) },
      scope: {
        allowBones: this.allow ? [...this.allow].map((b) => this.base.names[b]) : "all",
        denyBones: [...this.deny].map((b) => this.base.names[b]),
        protectForearmTwist: this.protectForearmTwist,
        faceBlendshapes: "never written",
      },
      edits: {
        layers: this.edits.layers.map((_, i) => this.layerInfo(i)),
        filters: this.edits.cleanOps.length,
        undoSteps: this.undoStack.length,
        redoSteps: this.redoStack.length,
      },
    };
  }
}

export function openSession(bytes: Uint8Array, opts: SessionOpts = {}): Session {
  return new Session(bytes, opts);
}
