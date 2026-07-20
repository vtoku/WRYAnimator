import "./style.css";
import { parseWanim, BONE_COUNT, type WanimClip } from "./wanim/parse.ts";
import { convertCharacter, resample, retargetProportions, distributeBonelessSpine, type ConvertedClip } from "./convert/clip.ts";
import { importFbxAnimation, type FbxImportResult } from "./convert/importFbx.ts";
import { defaultRestClip } from "./convert/restSkeleton.ts";
import { parseVrmMeta } from "./vrm/vrmHumanoid.ts";
import { cleanClip, smoothRange, applyCleanOps, type CleanOpts, type CleanStats, type RangeSmooth, type CleanOp, type CleanFilter } from "./convert/clean.ts";
import type { PlantSpan } from "./convert/feet.ts";
import {
  makeLayer, getTrack, setPosKey, setRotKey, deleteKeysAt, keyTimes,
  applyRigLayers, nearestFrame,
  effectorDef, effectorForBone, effectorColor, retimeKeys, keyFullPose,
  bakeRange, bakeRangeAsync, dirtyRange, unionRange, fkDragRef, setKeyEase, reduceKeys, smoothKeys,
  sampleTrackPos, sampleTrackRot,
  stackPoseThrough, belowStackPose, clonePose, solveEffectorOnPose, captureBoneKeys, applyLayersToPose, convertLayerMode,
  capturePinTargets, distributeWristTwist,
  defaultIkfkBlend, limbForEffector, blendChainToFK, solvePoleOnPose, bodyPartBones,
  type RigLayer, type EffectorId, type TimeRange, type EffectorTarget, type PinTarget, type IkfkBlend,
} from "./rig/rig.ts";
import { keyHandPose, applyHandPose, hasHandFingers, type HandSide, type HandPoseAmounts } from "./rig/hands.ts";
import { worldFromLocal, type FramePose } from "./convert/fk.ts";
import { vsub, vadd, vlen, vnorm, quatFromTo } from "./convert/ik.ts";
import { applyModifiers, defaultModifiers, applyReach, anyReach } from "./rig/modifiers.ts";
import { applyTimeWarp, warpMaps, type WarpKey } from "./rig/timewarp.ts";
import { quatMul, quatDot, quatNormalize, quatToEulerZYX, eulerZYXToQuat, RAD2DEG } from "./convert/quat.ts";
import type { CurveEase, DenseModel, DenseChannel, ChannelsConfig } from "./ui/curves.ts";
import { buildChannelGroups, groupBones, boneLabel } from "./ui/channels.ts";
import { RigPicker } from "./ui/picker.ts";
import type { Vec3, Quat } from "./wanim/parse.ts";
import { writeAnimationFbx, type SkinnedMeshExport } from "./fbx/animationFbx.ts";
import { remapNames, type NameScheme } from "./convert/skeleton.ts";
import { buildFaceMesh } from "./convert/meshExport.ts";
import { buildBodyData, bodyToSkinnedMeshExports, getBodyJoints, setBodySource, hasUserBody } from "./convert/body.ts";
import { augmentFaceForVrm } from "./convert/vrmFaceMap.ts";
import { sanitizeFilename, downloadBytes } from "./fbx/export.ts";
import { exportShogunFbx, isVrmBody } from "./shogun/exportShogun.ts";
import { PreviewScene } from "./preview/scene.ts";
import { loadFaceMeshData } from "./preview/face.ts";
import { createTransport, type Transport, type TransportKeyMarker } from "./ui/transport.ts";
import type { Marker } from "./ui/timemap.ts";
import { saveLastSession, loadLastSession, clearLastSession } from "./session.ts";
import { ICONS } from "./ui/icons.ts";
import { buildMenuBar, type MenuDef, type MenuItem } from "./ui/menu.ts";
import { keyFor, SHORTCUTS } from "./ui/shortcuts.ts";
import { openShortcuts, openAbout, openPreferences as openPreferencesDialog } from "./ui/dialogs.ts";
import { getPref, applyAppearance } from "./ui/prefs.ts";
import { initLayout, setDockCollapsed, setLayoutSizes } from "./ui/layout.ts";
import * as recent from "./ui/recent.ts";

const emptyState = document.getElementById("empty-state") as HTMLElement; // dim prompt over the viewport grid
const menubarEl = document.getElementById("menubar") as HTMLElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const errorEl = document.getElementById("empty-error") as HTMLElement;
const viewport = document.getElementById("viewport") as HTMLElement;
const editMain = document.querySelector(".edit-main") as HTMLElement;
const editbar = document.getElementById("editbar") as HTMLElement;
const dock = document.getElementById("dock") as HTMLElement;
const timelineDock = document.getElementById("timeline-dock") as HTMLElement;

let preview: PreviewScene | null = null;
/** Current panel's rig actions, driven by the module-level hotkey listener. */
let rigHotkeys: {
  undo(): void;
  redo(): void;
  copy(): void;
  paste(): void;
  del(): void;
  mode(m: "translate" | "rotate"): void;
  toggleSpace(): void;
} | null = null;
/** Transport keys (Space, ←/→, Home/End), set alongside rigHotkeys per panel. */
let transportHotkeys: {
  toggle(): void;
  step(frames: number): void;
  home(): void;
  end(): void;
} | null = null;
document.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement | null;
  const inField = !!tgt && (tgt.tagName === "INPUT" || tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA");
  if (e.ctrlKey || e.metaKey) {
    // Ctrl+O / Ctrl+S are app-global (no text-editing meaning) — intercept
    // them even in a field and with no clip loaded.
    const kk = e.key.toLowerCase();
    if (kk === "o" && !e.shiftKey) { e.preventDefault(); openRecordingPicker(); return; }
    if (kk === "s" && !e.shiftKey) { e.preventDefault(); dispatchSaveScene(); return; }
    // In a text field the browser's own editing shortcuts (incl. text undo)
    // must win — hijacking Ctrl+Z there silently destroyed rig edits.
    if (inField || !rigHotkeys) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); rigHotkeys.undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); rigHotkeys.redo(); }
    else if (k === "c") rigHotkeys.copy();
    else if (k === "v") rigHotkeys.paste();
  } else if (!inField) {
    // Standard DCC manipulation keys: Q space, W move, E rotate; standard
    // transport keys: Space play/pause, ←/→ frame step (shift = ×10).
    const k = e.key.toLowerCase();
    if (e.key === "Delete") rigHotkeys?.del();
    else if (k === "w") rigHotkeys?.mode("translate");
    else if (k === "e") rigHotkeys?.mode("rotate");
    else if (k === "q") rigHotkeys?.toggleSpace();
    else if (e.key === " ") { e.preventDefault(); transportHotkeys?.toggle(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); transportHotkeys?.step(e.shiftKey ? -10 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); transportHotkeys?.step(e.shiftKey ? 10 : 1); }
    else if (e.key === "Home") { e.preventDefault(); transportHotkeys?.home(); }
    else if (e.key === "End") { e.preventDefault(); transportHotkeys?.end(); }
    else if (k === "f") {
      // Fit the timeline view to the trim range (if set) else the whole clip.
      const tm = transport?.getTimeMap();
      const tr = transport?.getTrim();
      if (tm && tr) {
        if (tr.end - tr.start < tm.duration - 0.02) tm.fit(tr.start, tr.end);
        else tm.fit();
      }
    }
  }
});

/** Shared right-click menu (one per page). */
const ctxMenu = document.createElement("div");
ctxMenu.className = "ctx-menu";
ctxMenu.hidden = true;
document.body.appendChild(ctxMenu);
const hideCtxMenu = () => { ctxMenu.hidden = true; };
window.addEventListener("pointerdown", (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target as Node)) hideCtxMenu();
});
function showCtxMenu(x: number, y: number, items: Array<{ label: string; action?: () => void; disabled?: boolean }>) {
  ctxMenu.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.textContent = it.label;
    b.disabled = !!it.disabled;
    b.addEventListener("click", () => { hideCtxMenu(); it.action?.(); });
    ctxMenu.appendChild(b);
  }
  ctxMenu.hidden = false;
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - items.length * 36 - 10)}px`;
}
let transport: Transport | null = null;
let transportDuration = 0; // scale the transport was built with (warp changes it)

// ---- menu bar ---------------------------------------------------------------
// The File/Edit/View/Help actions live inside the per-recording buildPanel
// closure, so buildPanel registers them here and showEmptyEditor clears them.
// Clip-dependent menu items dim while `menuActions` is null (no recording).
interface MenuActions {
  saveScene(): void;
  saveSceneAs(): void;
  export(fmt: "fbx" | "vrma" | "wanim" | "shogun"): void;
  openBody(): void;
  /** Swap the body of a live session in place (drop VRM / File > Open body). */
  loadBodyBytes(name: string, data: ArrayBuffer): Promise<void>;
  /** Whether a Shogun target-rig export is available (a VRM body is loaded). */
  shogunReady(): boolean;
  undo(): void;
  redo(): void;
  copy(): void;
  paste(): void;
  del(): void;
  keyPose(): void;
  resetModifiers(): void;
  setDockTab(t: "clean" | "rig" | "export" | "info"): void;
  cyclePanels(): void;
  toggleGhost(): void;
  ghostOn(): boolean;
  toggleCompareLock(): void;
  compareLocked(): boolean;
}
let menuActions: MenuActions | null = null;

const APP_VERSION = document.querySelector(".version")?.textContent?.trim() ?? "";

async function openRecordingPicker() {
  if (recent.supported()) {
    const picked = await recent.pickOpen("recording");
    if (picked) { recent.setSaveHandle(null); await handleFile(picked.file); }
    return;
  }
  fileInput.accept = ".wanim"; fileInput.click();
}
async function openScenePicker() {
  if (recent.supported()) {
    const picked = await recent.pickOpen("scene");
    if (picked) { recent.setSaveHandle(picked.handle); await handleFile(picked.file); }
    return;
  }
  fileInput.accept = ".json,application/json"; fileInput.click();
}
// Body picker is always available (File > Open body): a dedicated hidden input
// so the accepted types don't clobber the recording input's.
const bodyInput = document.createElement("input");
bodyInput.type = "file";
bodyInput.accept = ".vrm,.glb";
bodyInput.hidden = true;
document.body.appendChild(bodyInput);
bodyInput.addEventListener("change", () => {
  const file = bodyInput.files?.[0];
  bodyInput.value = "";
  if (file) void handleFile(file);
});
function openBodyPicker() { bodyInput.click(); }

const openPreferences = openPreferencesDialog;
// View menu layout presets: set both splitter sizes + the dock/panel state.
function applyLayoutPreset(preset: "default" | "cleanup" | "rig") {
  if (preset === "default") {
    setDockCollapsed(dock, false);
    setLayoutSizes(dock, 352, 0);
    transport?.setPanelView("keys");
  } else if (preset === "cleanup") {
    setDockCollapsed(dock, true);        // dock as a thin tab strip
    setLayoutSizes(dock, 352, 280);      // taller timeline dock, curves open
    transport?.setPanelView("curves");
  } else {
    setDockCollapsed(dock, false);       // rig: dock open on Rig, dope open
    setLayoutSizes(dock, 380, 160);
    menuActions?.setDockTab("rig");
    transport?.setPanelView("keys");
  }
}
// File > Recent: real reopenable handles via the File System Access API;
// hidden entirely when unavailable (a dropped/<input> file cannot be reopened).
const recentSupported = () => recent.supported();
const recentSubmenu = (): MenuItem[] => {
  const entries = recent.getRecent();
  if (!entries.length) return [{ label: "No recent files", enabled: () => false }];
  return entries.map((e) => ({
    label: `${e.name}`,
    action: () => void (async () => {
      const file = await recent.openRecent(e);
      if (!file) { showError(`Couldn't reopen ${e.name} (permission denied or file moved).`); return; }
      recent.setSaveHandle(e.kind === "scene" ? e.handle : null);
      await handleFile(file);
    })(),
  }));
};

const hasClip = () => !!menuActions;
/** A session of any kind (recording, fbx, or body-only) is open. */
const hasSession = () => !!menuActions || !!bodyPanel;
/** A Shogun target-rig export is available (a VRM body is loaded). */
const shogunAvailable = () => (menuActions?.shogunReady() ?? false) || (bodyPanel?.isVrm() ?? false);

function dispatchSaveScene() { (menuActions ?? bodyPanel)?.saveScene(); }
function dispatchSaveSceneAs() { (menuActions ?? bodyPanel)?.saveSceneAs(); }
function dispatchExportShogun() {
  if (menuActions) menuActions.export("shogun");
  else bodyPanel?.exportShogun();
}

const menuDefs: MenuDef[] = [
  {
    label: "File",
    items: () => [
      { label: "Open recording...", hotkey: keyFor("open"), action: openRecordingPicker },
      { label: "Open scene...", action: openScenePicker },
      { label: "Open body (VRM/GLB)...", action: openBodyPicker },
      { label: "Recent", submenu: recentSubmenu, hidden: () => !recentSupported() },
      { separator: true },
      { label: "Save scene", hotkey: keyFor("save"), enabled: hasSession, action: dispatchSaveScene },
      { label: "Save scene as...", enabled: hasSession, action: dispatchSaveSceneAs },
      { separator: true },
      { label: "Export FBX", enabled: hasClip, action: () => menuActions?.export("fbx") },
      { label: "Export VRMA", enabled: hasClip, action: () => menuActions?.export("vrma") },
      { label: "Export WANIM", enabled: hasClip, action: () => menuActions?.export("wanim") },
      { label: "Export Shogun target rig", enabled: shogunAvailable, action: dispatchExportShogun },
    ],
  },
  {
    label: "Edit",
    items: () => [
      { label: "Undo", hotkey: keyFor("undo"), enabled: hasClip, action: () => menuActions?.undo() },
      { label: "Redo", hotkey: keyFor("redo"), enabled: hasClip, action: () => menuActions?.redo() },
      { separator: true },
      { label: "Copy keys", hotkey: keyFor("copy"), enabled: hasClip, action: () => menuActions?.copy() },
      { label: "Paste keys", hotkey: keyFor("paste"), enabled: hasClip, action: () => menuActions?.paste() },
      { label: "Delete keys", hotkey: keyFor("delete"), enabled: hasClip, action: () => menuActions?.del() },
      { separator: true },
      { label: "Key pose", enabled: hasClip, action: () => menuActions?.keyPose() },
      { label: "Reset modifiers", enabled: hasClip, action: () => menuActions?.resetModifiers() },
      { separator: true },
      { label: "Preferences...", action: () => openPreferences() },
    ],
  },
  {
    label: "View",
    items: () => [
      { label: "Clean panel", enabled: hasClip, action: () => menuActions?.setDockTab("clean") },
      { label: "Rig panel", enabled: hasClip, action: () => menuActions?.setDockTab("rig") },
      { label: "Export panel", enabled: hasClip, action: () => menuActions?.setDockTab("export") },
      { label: "Info panel", enabled: hasClip, action: () => menuActions?.setDockTab("info") },
      { separator: true },
      { label: "Cycle keys / curves / hidden", enabled: hasClip, action: () => menuActions?.cyclePanels() },
      { label: "Ghost overlay", checked: () => !!menuActions?.ghostOn(), enabled: hasClip, action: () => menuActions?.toggleGhost() },
      { label: "Lock hold-to-compare", checked: () => !!menuActions?.compareLocked(), enabled: hasClip, action: () => menuActions?.toggleCompareLock() },
      { separator: true },
      { label: "Reset camera", action: () => preview?.resetCamera() },
      { label: "Frame character", enabled: hasClip, action: () => preview?.frameCharacter() },
      { label: "Toggle grid", checked: () => !!preview?.isGridVisible(), action: () => preview?.toggleGrid() },
      { separator: true },
      { label: "Collapse dock", checked: () => getPref("dockCollapsed"), action: () => setDockCollapsed(dock, !getPref("dockCollapsed")) },
      { label: "Layout: Default", action: () => applyLayoutPreset("default") },
      { label: "Layout: Cleanup", action: () => applyLayoutPreset("cleanup") },
      { label: "Layout: Rig", action: () => applyLayoutPreset("rig") },
    ],
  },
  {
    label: "Help",
    items: () => [
      { label: "Keyboard shortcuts", action: openShortcuts },
      { label: "About", action: () => openAbout(APP_VERSION) },
    ],
  },
];
applyAppearance(); // UI scale + hint visibility from saved prefs
initLayout(dock, editMain, timelineDock); // splitters + persisted sizes + collapse
void recent.initRecent(); // load the File > Recent list (if the API is available)
buildMenuBar(menubarEl, menuDefs);
// Test hook: bootcheck asserts every table entry shows in the Help overlay.
(window as unknown as { __shortcuts?: typeof SHORTCUTS }).__shortcuts = SHORTCUTS;

// ---- scene files ------------------------------------------------------------
// A scene bundles the RECORDING plus every edit and setting into one JSON, so
// a session can be reopened later by dropping that single file.
interface SceneFile {
  magic: "wanimscene";
  v: number;
  name: string;
  /** Which loader rebuilds the clip. Absent = "wanim" (pre-v4 scenes). */
  source?: "wanim" | "fbx" | "body";
  settings?: Record<string, unknown>;
  rig?: Record<string, unknown>;
  /** base64 of the original .wanim bytes (wanim sessions). */
  wanim?: string;
  /** base64 of the original .fbx bytes (fbx sessions). */
  fbx?: string;
  /** Custom VRM/GLB body, embedded so the project is fully self-contained. */
  body?: { name: string; data: string };
}
let pendingScene: SceneFile | null = null;
/** Bytes of the currently loaded custom body (kept for scene embedding). */
let userBodyBytes: { name: string; data: ArrayBuffer } | null = null;
/** Body carried across a body-only -> recording/fbx upgrade (kept in place). */
let pendingBody: { name: string; data: ArrayBuffer } | null = null;
/** FBX take picker for the editbar (set before buildPanel for fbx sessions). */
let pendingFbxTakes: { names: string[]; active: number; onPick: (i: number) => void } | null = null;
/** Body-only session controls exposed to the persistent menu bar. */
interface BodyPanel {
  saveScene(): void;
  saveSceneAs(): void;
  exportShogun(): void;
  isVrm(): boolean;
}
let bodyPanel: BodyPanel | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
let loaded: {
  name: string;
  clip: WanimClip;
  converted: ConvertedClip;
  /** Which loader produced this clip (drives scene embedding + re-open). */
  source: "wanim" | "fbx";
  /** Original file bytes — embedded into saved scenes. */
  raw: ArrayBuffer;
  /** After cleaning + optional Ybot re-proportioning — what preview/export use. */
  display: ConvertedClip;
} | null = null;

/** Error toast (the editor is always on screen now, so errors float). */
let errorTimer = 0;
function showError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => { errorEl.hidden = true; }, 10000);
}
errorEl.addEventListener("click", () => { errorEl.hidden = true; });


function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/**
 * ZYX euler triples for a rot-key list, unwrapped for DISPLAY: each key picks
 * the representation (canonical, or the (x+π, π−y, z+π) alternate, plus ±2π
 * per-axis shifts) closest to the previous key, so equivalent rotations don't
 * draw as ±180° curve jumps. eulerZYXToQuat is 2π-periodic and representation-
 * blind, so editing an unwrapped value round-trips to the same rotation.
 */
function unwrapEulerKeys(keys: Array<{ q: Quat }>): Vec3[] {
  const out: Vec3[] = [];
  let prev: Vec3 | null = null;
  for (const k of keys) {
    let e = quatToEulerZYX(k.q);
    if (prev) {
      const p = prev;
      const near = (v: number, ref: number) => v + 2 * Math.PI * Math.round((ref - v) / (2 * Math.PI));
      const cand = (v: Vec3): Vec3 => [near(v[0], p[0]), near(v[1], p[1]), near(v[2], p[2])];
      const alt: Vec3 = [e[0] + Math.PI, Math.PI - e[1], e[2] + Math.PI];
      const c1 = cand(e);
      const c2 = cand(alt);
      const dist = (v: Vec3) => Math.abs(v[0] - p[0]) + Math.abs(v[1] - p[1]) + Math.abs(v[2] - p[2]);
      e = dist(c2) < dist(c1) ? c2 : c1;
    }
    out.push(e);
    prev = e;
  }
  return out;
}

/** Axis colors shared by the corrections + channels curve views. */
const AXIS_COLOR = ["#ff6b6b", "#7dda6b", "#6bb1ff"];

/**
 * Unwrap a whole rotation track to continuous ZYX-euler degrees (per axis), so
 * equivalent representations don't draw as ±180° jumps. Zero-norm quats read as
 * identity (safeQuat rule) instead of poisoning the extraction.
 */
function unwrapEulerTrack(track: Quat[]): [Float32Array, Float32Array, Float32Array] {
  const n = track.length;
  const out: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let prev: Vec3 | null = null;
  const near = (v: number, ref: number) => v + 2 * Math.PI * Math.round((ref - v) / (2 * Math.PI));
  for (let f = 0; f < n; f++) {
    let q = track[f];
    if (Math.hypot(q[0], q[1], q[2], q[3]) < 0.5) q = [0, 0, 0, 1];
    let e = quatToEulerZYX(q);
    if (prev) {
      const p = prev;
      const cand = (v: Vec3): Vec3 => [near(v[0], p[0]), near(v[1], p[1]), near(v[2], p[2])];
      const alt: Vec3 = [e[0] + Math.PI, Math.PI - e[1], e[2] + Math.PI];
      const c1 = cand(e);
      const c2 = cand(alt);
      const dist = (v: Vec3) => Math.abs(v[0] - p[0]) + Math.abs(v[1] - p[1]) + Math.abs(v[2] - p[2]);
      e = dist(c2) < dist(c1) ? c2 : c1;
    }
    out[0][f] = e[0] * RAD2DEG;
    out[1][f] = e[1] * RAD2DEG;
    out[2][f] = e[2] * RAD2DEG;
    prev = e;
  }
  return out;
}

/**
 * Dense baked-motion channels for a set of bones: per-bone local rotation as
 * unwrapped ZYX-euler degrees, plus Hips position in cm. Sampled from the
 * given display clip (post clean + modifiers + layers — i.e. what exports).
 */
function denseChannelsFor(clip: ConvertedClip, bones: string[]): DenseModel {
  const channels: DenseChannel[] = [];
  for (const bone of bones) {
    const bi = clip.names.indexOf(bone);
    if (bi < 0) continue;
    const eul = unwrapEulerTrack(clip.localQuat[bi]);
    for (const axis of [0, 1, 2] as const) {
      channels.push({
        key: `${bone}.r${axis}`,
        label: `${boneLabel(bone)} rot ${"XYZ"[axis]}`,
        color: AXIS_COLOR[axis],
        group: "rot",
        axis,
        values: eul[axis],
      });
    }
    if (bone === "Hips") {
      const pos = clip.localPos[0];
      for (const axis of [0, 1, 2] as const) {
        const v = new Float32Array(pos.length);
        for (let f = 0; f < pos.length; f++) v[f] = pos[f][axis] * 100;
        channels.push({
          key: `${bone}.p${axis}`,
          label: `Hips pos ${"XYZ"[axis]} (cm)`,
          color: AXIS_COLOR[axis],
          group: "pos",
          axis,
          values: v,
        });
      }
    }
  }
  return { times: clip.times, channels };
}

/** Finger bones tolerate a looser key-reduction threshold than the body. */
function isFingerBone(name: string): boolean {
  return /(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/.test(name);
}

/**
 * Estimate how many keys a curve keeps after tolerance-based reduction: a key
 * is needed wherever the value breaks a linear prediction from the two prior
 * frames by more than `tol`. O(n) — an analysis readout, not the exact writer
 * reduction (the exported clip stays dense).
 */
function estimateKeys(vals: Float32Array, tol: number): number {
  const n = vals.length;
  if (n <= 2) return n;
  let keys = 2; // endpoints always kept
  for (let i = 2; i < n; i++) {
    const predicted = 2 * vals[i - 1] - vals[i - 2];
    if (Math.abs(vals[i] - predicted) > tol) keys++;
  }
  return keys;
}

interface GroupReduction { label: string; before: number; after: number; }

/** Per body-part before/after key counts for the reduction stats table. */
function analyzeReduction(clip: ConvertedClip, groups: ChannelGroupLite[], tolBody: number, tolFinger: number): GroupReduction[] {
  const frames = clip.times.length;
  const out: GroupReduction[] = [];
  for (const g of groups) {
    let before = 0, after = 0;
    for (const bone of g.bones) {
      const bi = clip.names.indexOf(bone);
      if (bi < 0) continue;
      const tol = isFingerBone(bone) ? tolFinger : tolBody;
      const eul = unwrapEulerTrack(clip.localQuat[bi]);
      for (const axis of [0, 1, 2] as const) {
        before += frames;
        after += estimateKeys(eul[axis], tol);
      }
      if (bone === "Hips") {
        const pos = clip.localPos[0];
        for (const axis of [0, 1, 2] as const) {
          const v = new Float32Array(pos.length);
          for (let f = 0; f < pos.length; f++) v[f] = pos[f][axis] * 100;
          before += frames;
          after += estimateKeys(v, tolBody * 0.5); // cm units, tighter
        }
      }
    }
    if (before > 0) out.push({ label: g.label, before, after });
  }
  return out;
}

interface ChannelGroupLite { label: string; bones: string[]; }

function buildPanel(name: string, clip: WanimClip, converted: ConvertedClip) {
  const frames = clip.times.length;
  const fps = converted.duration > 0 ? (frames - 1) / converted.duration : 0;
  const blendshapeNames = new Set<string>();
  for (const ch of clip.characters) {
    for (const framesArr of Object.values(ch.blendshapes)) {
      for (const key of Object.keys(framesArr[0] ?? {})) blendshapeNames.add(key);
    }
  }

  const rows: [string, string][] = [
    ["File", name],
    ["Frames", String(frames)],
    ["Duration", fmtTime(converted.duration)],
    ["Rate", `${fps.toFixed(1)} fps`],
    ["Bones", `${BONE_COUNT} (Unity humanoid)`],
    ["Blendshapes", blendshapeNames.size ? String(blendshapeNames.size) : "none"],
  ];

  // ---- editor-suite toolbar: global actions, always visible ---------------
  editbar.innerHTML = `
    <div class="eb-group">
      <button id="rigUndo" class="eb-btn eb-ico" disabled title="Undo the last rig or modifier edit (Ctrl+Z)">${ICONS.undo}<span class="eb-lbl">Undo</span></button>
      <button id="rigRedo" class="eb-btn eb-ico" disabled title="Redo (Ctrl+Y)">${ICONS.redo}<span class="eb-lbl">Redo</span></button>
    </div>
    <div class="eb-group">
      <button id="gizmoMove" class="eb-btn eb-ico active" title="Move (W). Pulling an FK diamond swings the bone toward the drag.">${ICONS.move}</button>
      <button id="gizmoRotate" class="eb-btn eb-ico" title="Rotate (E)">${ICONS.rotate}</button>
      <button id="rigSpace" class="eb-btn eb-ico" title="Gizmo axes: Local follows the bone, World uses the scene axes (Q toggles).">${ICONS.local}<span class="eb-lbl">Local</span></button>
    </div>
    <button id="compare" class="eb-btn eb-ico compare" title="Press and hold to see the recording without any cleaning or rig edits, so you can judge what changed.">${ICONS.eye}<span class="eb-lbl">Hold: original</span></button>
    <button id="ghostBtn" class="eb-btn eb-ico" title="Overlay the original (uncleaned) recording as a translucent ghost, so you can see what the cleanup changed while you edit.">${ICONS.ghost}<span class="eb-lbl">Ghost</span></button>
    <span class="eb-spacer"></span>
    <input id="outName" class="eb-name" type="text" spellcheck="false" title="Base name for exported files (e.g. myclip-clean → myclip-clean.fbx)" />
    <select id="format" aria-label="Export format" title="FBX for MotionBuilder/Maya/Blender; VRMA for Warudo/VSeeFace/Unity; WANIM back into Warudo.">
      <option value="fbx" selected>FBX</option>
      <option value="vrma">VRMA</option>
      <option value="wanim">WANIM</option>
    </select>
    <button id="download" class="button primary">Download</button>
  `;

  // ---- dock: task panels in tabs ------------------------------------------
  dock.innerHTML = `
    <nav class="dock-tabs" role="tablist">
      <button class="dock-tab active" data-tab="clean">Clean</button>
      <button class="dock-tab" data-tab="rig">Rig</button>
      <button class="dock-tab" data-tab="export">Export</button>
      <button class="dock-tab" data-tab="info">Info</button>
    </nav>
    <div class="dock-body">

    <div class="tab active" id="tab-clean">
    <h4 class="group">Feet</h4>
    <label class="field">
      <span>Pin planted feet</span>
      <input id="fixFeet" type="checkbox" title="Stops feet sliding while they're planted and keeps them from dipping under the floor. Legs are adjusted; nothing else moves." />
    </label>
    <p id="plantHint" class="clean-stats" hidden>Detected plants (× removes one; the leg stops being pinned there):</p>
    <div id="plantList" class="rig-keys"></div>

    <h4 class="group">Arms &amp; hands</h4>
    <label class="field">
      <span>Limit wrists (human range)</span>
      <input id="limitWrists" type="checkbox" title="Caps wrist twist at ±90° and bend at 85°, the anatomical range. Only frames past those limits change." />
    </label>
    <label class="field">
      <span>Lock wrist (bad tracking)</span>
      <select id="lockWrists" title="Freezes the hand so it just follows the forearm. Use when a hand flails from lost tracking; fingers still animate.">
        <option value="" selected>Off</option>
        <option value="left">Left</option>
        <option value="right">Right</option>
        <option value="both">Both</option>
      </select>
    </label>
    <label class="field">
      <span>Limit forearm twist (human range)</span>
      <input id="limitLowerArms" type="checkbox" title="Caps forearm rotation at ±90°, the anatomical range. Elbow bend is untouched." />
    </label>
    <label class="field">
      <span>Lock forearm twist</span>
      <select id="lockLowerArmTwist" title="Removes ALL forearm rotation on the chosen side, keeping elbow bend. Use when a forearm spins from lost tracking.">
        <option value="" selected>Off</option>
        <option value="left">Left</option>
        <option value="right">Right</option>
        <option value="both">Both</option>
      </select>
    </label>

    <h4 class="group">Jitter</h4>
    <label class="field">
      <span>Remove pops / flips</span>
      <input id="despike" type="checkbox" title="Deletes single-frame glitches: a joint that snaps away for one frame and snaps back." />
    </label>
    <label class="field sub">
      <span>Pop threshold <output id="despikeVal">35°</output></span>
      <input id="despikeDeg" type="range" min="10" max="90" step="5" value="35" title="How big a one-frame jump counts as a glitch. Lower catches more, but may eat fast real moves." />
    </label>
    <label class="field">
      <span>Smooth jitter</span>
      <input id="smooth" type="checkbox" title="Evens out shaky tracking without delaying the motion (zero-lag Butterworth filter)." />
    </label>
    <label class="field sub">
      <span>Cutoff <output id="cutoffVal">7 Hz</output></span>
      <input id="cutoff" type="range" min="1" max="15" step="0.5" value="7" title="Lower = smoother but mushier. Anything faster than this many shakes per second is treated as noise." />
    </label>
    <p id="cleanStats" class="clean-stats"></p>

    <h4 class="group">Range smoothing <span class="hint-i" title="Smooth just one rough section: set the timeline trim handles around it, pick a cutoff above, then apply. Blends at the edges.">ⓘ</span></h4>
    <div class="rig-row">
      <button id="rangeAdd" class="button ghost">Smooth trim range</button>
    </div>
    <div id="rangeChips" class="rig-keys"></div>

    <h4 class="group">Filters (scoped) <span class="hint-i" title="Fix just the channels you pick over just the section you pick. On the Rig timeline open the Channels view, select the bones (down to a single finger), set the trim handles around the bad section, choose a filter, then Add. Each filter is non-destructive and stacks; the colored underline on the timeline shows where it acts. Blends 0.25s at the edges.">ⓘ</span></h4>
    <div class="rig-row">
      <select id="filterType" title="Butterworth: zero-lag low-pass (smoothest). Moving-average: quick box smooth. Despike: removes one-frame pops. Key reduce: keeps only the frames the motion needs (within the tolerance) and interpolates between them — flattens micro-jitter and shrinks what an export has to keep.">
        <option value="butterworth" selected>Butterworth</option>
        <option value="smooth">Moving-average</option>
        <option value="despike">Despike</option>
        <option value="reduce">Key reduce</option>
      </select>
      <input id="filterParam" type="number" step="0.5" min="0.5" value="5" title="Filter strength" style="width:4.2rem" />
      <span id="filterUnit" class="clean-stats" style="margin:0">Hz</span>
    </div>
    <div class="rig-row">
      <button id="filterAdd" class="button ghost" title="Apply the chosen filter to the selected bones over the trim range.">Add for selection + trim</button>
    </div>
    <p id="filterHint" class="clean-stats"></p>
    <div id="filterList" class="rig-keys"></div>
    </div>

    <div class="tab" id="tab-rig">
    <div id="pickerMount"></div>
    <h4 class="group">Layers <span class="hint-i" title="FK/IK adjustment layers, MotionBuilder style. Add a layer, pause, then drag a handle on the figure; a key lands at the playhead. Spheres (hips, hands, feet) move with IK and rotate; the small diamonds on the body bones rotate FK-style. On the timeline: right-click a key for copy/paste/delete, shift-drag to select several, ctrl-click to add one, drag a key to retime it. Edits auto-save for this recording.">ⓘ</span></h4>
    <div id="rigLayers" class="rig-layers"></div>
    <div class="rig-row">
      <button id="rigAdd" class="button ghost">Add layer</button>
      <button id="rigSave" class="button ghost" title="Download the layers + modifiers as a .rig.json file you can reload later or on another machine.">Save…</button>
      <button id="rigLoadBtn" class="button ghost" title="Load a saved .rig.json onto this recording.">Load…</button>
    </div>
    <input id="rigFile" type="file" accept=".json,application/json" hidden />
    <p id="rigCacheNote" class="clean-stats"></p>
    <div id="rigEditor" hidden>
      <p id="rigSel" class="clean-stats"></p>
      <div class="rig-row" id="rigLimbRow" hidden>
        <button id="rigPin" class="button ghost" title="Pin this hand/foot to its spot in the world. While pinned, dragging the hips, root, or body moves everything EXCEPT it — the limb re-solves to stay planted (Poser style).">📌 Pin</button>
        <button id="rigFkMode" class="button ghost" title="IK: dragging this hand/foot bends the limb to reach it. FK: dragging swings the whole limb rigidly from the shoulder/hip.">Mode: IK</button>
      </div>
      <div id="rigKeys" class="rig-keys"></div>
      <div class="rig-row">
        <select id="keyMode" title="What 'Key pose' writes: just the selected handle, its whole limb, or the entire body.">
          <option value="selected">Selected</option>
          <option value="bodypart">Body part</option>
          <option value="full" selected>Full body</option>
        </select>
        <label class="field" style="margin:0;gap:4px" title="When on, every handle drag also keys the whole body at that frame (MoBu auto-key). Off by default so cleanup keys stay local.">
          <span>Auto-key</span>
          <input id="autoKey" type="checkbox" />
        </label>
      </div>
      <div class="rig-row">
        <button id="rigNeutral" class="button ghost" title="Keys the selected handle at its unadjusted position at the playhead. Put one before and after an adjustment to keep it local.">Neutral key</button>
        <button id="rigKeyAll" class="button ghost" title="Keys the selected handle, its limb, or the whole body (per the mode) at the playhead, locking that pose so edits elsewhere can't disturb it.">Key pose</button>
        <button id="rigDelKey" class="button ghost" title="Removes the selected handle's key nearest the playhead.">Delete key</button>
        <button id="rigReduce" class="button ghost" title="Drops keys on the selected handle that the curve wouldn't miss (within 0.5 cm / 1°).">Reduce keys</button>
      </div>
    </div>

    <div id="ikfkBlend" hidden>
      <h4 class="group">IK / FK blend <span class="hint-i" title="Per limb: 100% = dragging the hand/foot bends the limb to reach (IK). 0% = the end handle hides and only the segment handles pose the limb (FK). In between, a drag blends the solved reach toward the current pose. The yellow pole handles by each knee/elbow swing the bend plane.">ⓘ</span></h4>
      <div id="ikfkSliders"></div>
    </div>

    <div id="handPose" hidden>
      <h4 class="group">Hand pose <span class="hint-i" title="Stamp a finger pose onto the active layer at the playhead. Curl closes the fingers, Spread fans them, Thumb curls the thumb. Each slider nudges from the current pose and snaps back to 0. The keys land on the finger bones like any drag, so they retime, copy, and mirror.">ⓘ</span></h4>
      <div id="handPoseSides"></div>
    </div>

    <h3 class="section">Modifiers <span class="hint-i" title="Whole-clip corrections, no keys needed. Hips keeps the feet planted; knees and elbows swing without moving hips, feet, or hands. Layers apply on top of these.">ⓘ</span></h3>
    <label class="field sub">
      <span>Hips height <output id="modHipsVal">0 cm</output></span>
      <input id="modHips" type="range" min="-30" max="30" step="1" value="0" title="Raise or lower the hips; the legs re-solve so the feet stay where they are." />
    </label>
    <label class="field sub">
      <span>Knees in/out <output id="modKneesVal">0°</output></span>
      <input id="modKnees" type="range" min="-30" max="30" step="1" value="0" title="Swing the knees apart (+) or together (−). Hips and feet don't move." />
    </label>
    <label class="field sub">
      <span>Elbows in/out <output id="modElbowsVal">0°</output></span>
      <input id="modElbows" type="range" min="-30" max="30" step="1" value="0" title="Swing the elbows away from (+) or toward (−) the body. Shoulders and hands don't move." />
    </label>
    <label class="field sub">
      <span>Stance width <output id="modFeetVal">0 cm</output></span>
      <input id="modFeet" type="range" min="-20" max="20" step="1" value="0" title="Plant the feet wider (+) or narrower (−)." />
    </label>
    <label class="field">
      <span>Mirror left/right</span>
      <input id="modMirror" type="checkbox" title="Swaps left and right across the whole clip (pose and travel). Face stays as recorded." />
    </label>

    <h4 class="group">Reach (pull to raw path) <span class="hint-i" title="Blends each hand/foot back toward where the ORIGINAL recording had it, when cleaning moved it. 0% = cleaned, 100% = raw endpoint path.">ⓘ</span></h4>
    <label class="field sub">
      <span>L hand <output id="reachLHVal">0%</output></span>
      <input id="reachLH" type="range" min="0" max="100" step="5" value="0" />
    </label>
    <label class="field sub">
      <span>R hand <output id="reachRHVal">0%</output></span>
      <input id="reachRH" type="range" min="0" max="100" step="5" value="0" />
    </label>
    <label class="field sub">
      <span>L foot <output id="reachLFVal">0%</output></span>
      <input id="reachLF" type="range" min="0" max="100" step="5" value="0" />
    </label>
    <label class="field sub">
      <span>R foot <output id="reachRFVal">0%</output></span>
      <input id="reachRF" type="range" min="0" max="100" step="5" value="0" />
    </label>

    <h4 class="group">Time warp <span class="hint-i" title="Speed keys ramp playback speed across the clip: slow-mo one section, rush another. The clip's length changes, so trim resets when it does.">ⓘ</span></h4>
    <div class="rig-row">
      <select id="warpSpeed" title="Speed at the new key">
        <option value="0.25">0.25×</option>
        <option value="0.5">0.5×</option>
        <option value="0.75">0.75×</option>
        <option value="1" selected>1×</option>
        <option value="1.5">1.5×</option>
        <option value="2">2×</option>
      </select>
      <button id="warpAdd" class="button ghost" title="Pins this speed at the playhead; speed ramps linearly between keys.">Speed key @ playhead</button>
    </div>
    <div id="warpChips" class="rig-keys"></div>

    <div class="rig-row">
      <button id="modReset" class="button ghost">Reset modifiers</button>
    </div>
    </div>

    <div class="tab" id="tab-export">
    <label class="field">
      <span>Frame rate</span>
      <select id="fps">
        <option value="30">30 fps</option>
        <option value="60" selected>60 fps</option>
        <option value="120">120 fps</option>
      </select>
    </label>
    <label class="field">
      <span>Bone names</span>
      <select id="names">
        <option value="unity" selected>Unity (HumanBodyBones)</option>
        <option value="motionbuilder">MotionBuilder / HumanIK</option>
      </select>
    </label>
    <label class="field">
      <span>Rest pose</span>
      <select id="rest">
        <option value="tpose" selected>T-pose</option>
        <option value="first">First frame</option>
      </select>
    </label>
    <label class="field">
      <span>Proportions</span>
      <select id="proportions">
        <option value="body" selected>Body-mesh skeleton (clean mesh)</option>
        <option value="recorded">Recorded avatar (approx. mesh fit)</option>
      </select>
    </label>
    <label class="field">
      <span>Distribute spine bend</span>
      <input id="distSpine" type="checkbox" title="Some avatars have no upper-chest bone, so the spine folds sharply at one joint. This spreads that fold into a smoother curve. It does nothing if the recording already has a full spine." />
    </label>
    <label class="field sub">
      <span>Spread <output id="distSpineAmtVal">50%</output></span>
      <input id="distSpineAmt" type="range" min="0" max="100" step="5" value="50" disabled />
    </label>
    <label class="field">
      <span>Face blendshapes</span>
      <input id="face" type="checkbox" ${converted.face ? "checked" : "disabled"} />
    </label>
    <label class="field">
      <span>Body mesh</span>
      <select id="body">
        <option value="human" selected>Ybot (bundled)</option>
        <option value="vrm">Your VRM / GLB…</option>
        <option value="none">None</option>
      </select>
    </label>
    <input id="bodyfile" type="file" accept=".vrm,.glb" hidden />

    <h4 class="group">Key reduction <span class="hint-i" title="Estimates how many keyframes each body part could drop at the chosen tolerance (fingers usually tolerate looser). A confidence readout — the exported clip stays dense per frame; this shows the potential.">ⓘ</span></h4>
    <label class="field sub">
      <span>Body tolerance <output id="redBodyVal">1°</output></span>
      <input id="redBody" type="range" min="0.5" max="5" step="0.5" value="1" />
    </label>
    <label class="field sub">
      <span>Finger tolerance <output id="redFingerVal">3°</output></span>
      <input id="redFinger" type="range" min="0.5" max="10" step="0.5" value="3" />
    </label>
    <div class="rig-row">
      <button id="reduceAnalyze" class="button ghost" title="Estimate key counts before/after reduction per body part.">Analyze keys</button>
    </div>
    <div id="reduceStats" class="clean-stats"></div>
    <h4 class="group">Formats <span class="hint-i" title="Format and Download live in the toolbar. Drag the in/out handles on the timeline to trim. FBX comes out as binary 7.5, which MotionBuilder can read, with the face and body meshes baked in if you turned them on. VRMA carries the humanoid motion and expressions for Warudo, VSeeFace, and Unity; it plays on any VRM and doesn't need a mesh. WANIM writes the cleaned recording back out so you can take it into Warudo again.">ⓘ</span></h4>

    <h4 class="group">Shogun target rig <span class="hint-i" title="A static, world-aligned skeleton plus skinned mesh built straight from your loaded VRM body, for use as a Vicon Shogun retarget target. No animation is baked in. Bone names and hierarchy are kept exactly so name-keyed streaming back into Unity or Warudo still lines up.">ⓘ</span></h4>
    <label class="field">
      <span>Strip spring bones</span>
      <input id="shogunStrip" type="checkbox" checked title="Drops VRM spring bones (hair, skirt, tail, accessories) and re-weights them onto their nearest kept parent. Shogun can't use them." />
    </label>
    <div class="rig-row">
      <button id="shogunDl" class="button ghost">Shogun target rig (.fbx)</button>
    </div>
    <p id="shogunNote" class="clean-stats"></p>
    </div>

    <div class="tab" id="tab-info">
    <h2>${name}</h2>
    <dl class="stats">
      ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
    </dl>
    <button id="sceneSave" class="button ghost" title="Bundles the recording plus every edit and setting into one .scene.json. Drop it on the app later to pick up exactly where you left off.">Save scene…</button>
    <span class="hint-i" title="A scene file contains the recording, your layers, modifiers, cleaning and export settings, and the trim. One file reopens the whole session. A custom VRM body is embedded too, so the file is the whole project.">ⓘ</span>
    <button id="reset" class="button ghost">Load another file</button>
    </div>

    </div>
  `;

  // Tab switching; rig handles + dope sheet only show on the Rig tab.
  let activeTab = "clean";
  const tabBtns = Array.from(dock.querySelectorAll<HTMLButtonElement>(".dock-tab"));
  function syncRigVisibility() {
    preview?.setRigEnabled(activeTab === "rig" && rigLayers.length > 0);
  }
  function setTab(t: string) {
    activeTab = t;
    for (const b of tabBtns) b.classList.toggle("active", b.dataset.tab === t);
    for (const el of dock.querySelectorAll(".tab")) el.classList.toggle("active", el.id === `tab-${t}`);
    syncRigVisibility();
    updateRigEditor();
  }
  for (const b of tabBtns) b.addEventListener("click", () => setTab(b.dataset.tab!));

  const despikeChk = document.getElementById("despike") as HTMLInputElement;
  const despikeDeg = document.getElementById("despikeDeg") as HTMLInputElement;
  const despikeVal = document.getElementById("despikeVal") as HTMLOutputElement;
  const smoothChk = document.getElementById("smooth") as HTMLInputElement;
  const cutoff = document.getElementById("cutoff") as HTMLInputElement;
  const cutoffVal = document.getElementById("cutoffVal") as HTMLOutputElement;
  const fpsSel = document.getElementById("fps") as HTMLSelectElement;
  const namesSel = document.getElementById("names") as HTMLSelectElement;
  const restSel = document.getElementById("rest") as HTMLSelectElement;
  const propSel = document.getElementById("proportions") as HTMLSelectElement;
  const faceChk = document.getElementById("face") as HTMLInputElement;
  const distSpineChk = document.getElementById("distSpine") as HTMLInputElement;
  const distSpineAmt = document.getElementById("distSpineAmt") as HTMLInputElement;
  const distSpineAmtVal = document.getElementById("distSpineAmtVal") as HTMLOutputElement;
  const bodySel = document.getElementById("body") as HTMLSelectElement;
  const downloadBtn = document.getElementById("download") as HTMLButtonElement;
  const resetBtn = document.getElementById("reset") as HTMLButtonElement;

  const limitWristsChk = document.getElementById("limitWrists") as HTMLInputElement;
  const lockWristsSel = document.getElementById("lockWrists") as HTMLSelectElement;
  const limitLowerArmsChk = document.getElementById("limitLowerArms") as HTMLInputElement;
  const lockLowerArmSel = document.getElementById("lockLowerArmTwist") as HTMLSelectElement;
  const fixFeetChk = document.getElementById("fixFeet") as HTMLInputElement;

  // Preference defaults for a NEW session: these seed the baseline before the
  // per-recording cache / scene restore (which runs later and overrides them),
  // so an already-edited recording never gets retroactively reset.
  fpsSel.value = String(getPref("exportFps"));
  namesSel.value = getPref("nameScheme");
  restSel.value = getPref("restPose");
  despikeChk.checked = getPref("cleanDespike");
  smoothChk.checked = getPref("cleanSmooth");
  limitWristsChk.checked = getPref("cleanLimitWrists");
  limitLowerArmsChk.checked = getPref("cleanLimitForearm");
  fixFeetChk.checked = getPref("cleanFixFeet");
  transport?.setMagnet(getPref("snapMagnet"));

  // Declared here (not with the rest of the edit state) so cleanOpts, which is
  // called synchronously while seeding prevPipelineJson, can reference it.
  const feetPlantRemoved: PlantSpan[] = []; // user-removed foot plants (scene state)
  const cleanOpts = (): CleanOpts => ({
    despike: despikeChk.checked,
    despikeDeg: Number(despikeDeg.value),
    smooth: smoothChk.checked,
    cutoffHz: Number(cutoff.value),
    limitWrists: limitWristsChk.checked,
    lockWrists: (lockWristsSel.value || undefined) as CleanOpts["lockWrists"],
    limitLowerArms: limitLowerArmsChk.checked,
    lockLowerArmTwist: (lockLowerArmSel.value || undefined) as CleanOpts["lockLowerArmTwist"],
    fixFeet: fixFeetChk.checked,
    feetEdits: { removed: feetPlantRemoved },
  });

  const cleanStatsEl = document.getElementById("cleanStats") as HTMLParagraphElement;

  // ---- pipeline settings in undo ------------------------------------------
  // Cleaning toggles/sliders (+ proportions + spine spread) change the motion
  // just like rig edits do, so they ride in the same undo snapshots.
  const pipelineSettings = () => ({
    clean: cleanOpts(),
    proportions: propSel.value,
    distSpine: distSpineChk.checked,
    distSpineAmt: distSpineAmt.value,
  });
  type PipelineSettings = ReturnType<typeof pipelineSettings>;
  let prevPipelineJson = JSON.stringify(pipelineSettings());

  function applyCleanUi(c: CleanOpts) {
    fixFeetChk.checked = c.fixFeet ?? false; // fallback = the default (off)
    limitWristsChk.checked = c.limitWrists ?? false; // fallback = default (off)
    lockWristsSel.value = c.lockWrists ?? "";
    limitLowerArmsChk.checked = c.limitLowerArms ?? false;
    lockLowerArmSel.value = c.lockLowerArmTwist ?? "";
    despikeChk.checked = !!c.despike;
    if (c.despikeDeg) { despikeDeg.value = String(c.despikeDeg); despikeVal.value = `${despikeDeg.value}°`; }
    smoothChk.checked = !!c.smooth;
    if (c.cutoffHz) { cutoff.value = String(c.cutoffHz); cutoffVal.value = `${cutoff.value} Hz`; }
  }

  function applyPipelineUi(p: PipelineSettings) {
    applyCleanUi(p.clean);
    propSel.value = p.proportions;
    distSpineChk.checked = p.distSpine;
    distSpineAmt.disabled = !p.distSpine;
    distSpineAmt.value = p.distSpineAmt;
    distSpineAmtVal.value = `${p.distSpineAmt}%`;
    prevPipelineJson = JSON.stringify(pipelineSettings());
  }

  /**
   * Undo entry for a pipeline-control change. The DOM has already flipped by
   * the time `change` fires, so the snapshot swaps in the PRE-change settings
   * tracked in prevPipelineJson.
   */
  function pushPipelineHistory() {
    const snap = JSON.parse(rigSnapshot()) as Record<string, unknown>;
    snap.pipeline = JSON.parse(prevPipelineJson);
    pushHistorySnap(JSON.stringify(snap));
    prevPipelineJson = JSON.stringify(pipelineSettings());
  }

  /**
   * Build the display clip: cleaning (unless skipped — the compare button
   * shows the uncleaned motion), then proportions + spine distribution so
   * before/after differ ONLY by the cleaning filters.
   */
  async function buildDisplay(withCleaning: boolean): Promise<ConvertedClip> {
    if (!loaded) throw new Error("no clip loaded");
    const opts = cleanOpts();
    const stats: CleanStats = { despiked: 0, wristClamped: 0, forearmClamped: 0, smoothedMeanDeg: 0 };
    const anyFilter = opts.despike || opts.smooth || opts.limitWrists || opts.lockWrists || opts.limitLowerArms || opts.lockLowerArmTwist || opts.fixFeet;
    // Time warp first: everything downstream (cleaning, keys, trim) lives on
    // the warped timeline. The compare view warps too, so timelines match.
    const source = applyTimeWarp(loaded.converted, warpKeys);
    let display = withCleaning && anyFilter ? cleanClip(source, opts, stats) : source;
    if (withCleaning) for (const r of rangeSmooths) display = smoothRange(display, r);
    // Scoped filter stack (bone set x range) — after global cleaning + range
    // smoothing, before proportions/modifiers/layers.
    if (withCleaning) display = applyCleanOps(display, cleanOps);
    // Report what the filters actually changed — proof they're applied — and
    // collect the touched frames as timeline tick marks so they're findable.
    // Consecutive corrected frames compress to ONE mark at the run start (a
    // foot plant pins hundreds of frames — that's one event, not a smear).
    if (withCleaning) {
      const t0 = source.times[0];
      const marks: Array<{ time: number; color: string }> = [];
      const runStarts = (frames: Iterable<number>): number[] => {
        const s = new Set(frames);
        return [...s].filter((f) => !s.has(f - 1)).sort((a, b) => a - b);
      };
      const ff = stats.fixedFrames;
      if (ff) {
        for (const f of runStarts(ff.limit)) marks.push({ time: source.times[f] - t0, color: "#b48cff" });
        for (const f of runStarts(ff.despike)) marks.push({ time: source.times[f] - t0, color: "#ffb020" });
      }
      if (stats.feet?.fixedFrames) {
        for (const f of runStarts(stats.feet.fixedFrames)) marks.push({ time: source.times[f] - t0, color: "#3fc1ff" });
      }
      cleanMarks = marks;
      currentPlants = opts.fixFeet ? (stats.feet?.plants ?? []) : [];
      if (!anyFilter) {
        cleanStatsEl.textContent = "";
      } else {
        const parts: string[] = [];
        if (opts.fixFeet && stats.feet) parts.push(`feet pinned: ${stats.feet.spans} plants, ${stats.feet.frames} frames (max ${stats.feet.maxFixCm.toFixed(1)} cm)`);
        if (opts.lockWrists) parts.push(`wrist locked: ${opts.lockWrists}`);
        if (opts.limitWrists) parts.push(`wrists clamped: ${stats.wristClamped} frames`);
        if (opts.lockLowerArmTwist) parts.push(`forearm twist locked: ${opts.lockLowerArmTwist}`);
        if (opts.limitLowerArms) parts.push(`forearm twist clamped: ${stats.forearmClamped} frames`);
        if (opts.despike) parts.push(`pops fixed: ${stats.despiked}`);
        if (opts.smooth) parts.push(`smoothing: ±${stats.smoothedMeanDeg.toFixed(2)}° avg`);
        cleanStatsEl.textContent = `Applied: ${parts.join(" · ")}`;
      }
    }
    if (propSel.value === "body") {
      try {
        display = retargetProportions(
          display,
          await getBodyJoints(display.parents, display.bindPos, display.names),
        );
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }
    // After proportions (which would reset a dead bone's bind): spread a spine
    // bend concentrated on one joint by a missing upper-chest bone.
    if (distSpineChk.checked) display = distributeBonelessSpine(display, Number(distSpineAmt.value) / 100);
    if (withCleaning) {
      // Modifiers, then control-rig layers on top; the compare view stays raw.
      display = applyModifiers(display, mods);
      if (anyReach(mods)) {
        // Reach pulls limb endpoints back toward the UNCLEANED path — build
        // (and cache per reclean) the raw reference through the same pipeline.
        if (!rawRefCache || rawRefCache.gen !== compareGen) {
          rawRefCache = { gen: compareGen, clip: await buildDisplay(false) };
        }
        display = applyReach(display, applyModifiers(rawRefCache.clip, mods), mods);
      }
      rigBaseClip = display;
      const baked = applyRigLayers(display, rigLayers);
      // The display MUST be a private copy: rig edits rebake into its arrays
      // in place (fast path — no scene rebuild), which would corrupt the
      // base if they shared storage. applyRigLayers copies only when layers
      // have content, so copy explicitly when it passed the base through.
      if (baked !== display) return baked;
      return {
        ...display,
        localPos: display.localPos.map((t) => t.map((p) => [...p] as Vec3)),
        localQuat: display.localQuat.map((t) => t.map((q) => [...q] as Quat)),
        bindPos: display.bindPos.map((p) => [...p] as Vec3),
      };
    }
    return display;
  }

  let compareBase: ConvertedClip | null = null; // uncleaned display for compare
  let compareGen = 0; // invalidates in-flight prebuilds when options change
  const rigLayers: RigLayer[] = []; // control-rig adjustment layers
  let rigBaseClip: ConvertedClip | null = null; // display BEFORE rig layers
  const mods = defaultModifiers(); // whole-clip parametric corrections
  const warpKeys: WarpKey[] = []; // time-warp speed ramp (source-time keys)
  const rangeSmooths: RangeSmooth[] = []; // user-applied range smoothing passes
  const cleanOps: CleanOp[] = []; // scoped non-destructive filter stack
  let currentPlants: PlantSpan[] = []; // last detected plants (drawing + chips)
  let rawRefCache: { gen: number; clip: ConvertedClip } | null = null; // reach reference
  // Tool state (not undo history — like the gizmo mode): world-pinned limbs
  // and limbs whose positional drags swing FK instead of solving IK.
  const pinnedEffectors = new Set<EffectorId>();
  const fkLimbs = new Set<EffectorId>();
  const ikfk = defaultIkfkBlend(); // per-limb IK/FK blend (1 = IK, 0 = FK)
  let ghostOn = false; // grey uncleaned-skeleton overlay
  let cleanMarks: Array<{ time: number; color: string }> = []; // filter tick marks
  let sceneMarkers: Marker[] = []; // user timeline markers (scene state)
  // Shared channel-tree selection (Channels mode) — scope for filters + reduce.
  let channelSelection = new Set<string>();
  // Assigned by the filter-stack UI (Stage 3); reads the selection then.
  let renderFilters: () => void = () => { void channelSelection; };
  /**
   * Trim/playhead to apply AFTER the next reclean. The transport is rebuilt
   * (trim reset) whenever a warp changes the duration, so restores from scene
   * files and warp-edit remaps must land after that rebuild, not before.
   */
  let pendingViewRestore: { trim?: { start: number; end: number }; time?: number; pause?: boolean } | null = null;

  async function reclean() {
    if (!loaded || !preview) return;
    compareBase = null; // options changed
    const gen = ++compareGen;
    const display = await buildDisplay(true);
    loaded.display = display;
    // A time-warp change alters the clip duration — the transport's scale is
    // fixed at creation, so rebuild it (trim resets; keys re-attach below).
    if (transport && Math.abs(display.duration - transportDuration) > 0.01) {
      transport.dispose();
      transport = createTransport(preview, display.duration, display.times.length);
      timelineDock.appendChild(transport.element);
      transportDuration = display.duration;
      wireTransportScene(); // fresh bar needs its Save…/Open… buttons wired
      preview.setClip(display, true);
      updateRigEditor(); // re-point key markers + dope + curves at the new bar
    } else {
      const trim = transport?.getTrim();
      preview.setClip(display, true); // same recording: keep camera + playback position
      if (trim) preview.setTrim(trim.start, trim.end); // keep the user's trim
    }
    transport?.setMarks(cleanMarks);
    refreshTimelineRanges(); // scoped-filter + plant underlines
    renderPlants(); // per-plant chips
    transport?.curveView.refreshChannels(); // dense view follows the new clip
    // Deferred trim/playhead (scene load, warp remap) — after any rebuild.
    if (pendingViewRestore) {
      const pv = pendingViewRestore;
      pendingViewRestore = null;
      if (pv.trim) transport?.setTrim(pv.trim.start, pv.trim.end);
      if (pv.time !== undefined) {
        if (pv.pause) preview.pause();
        preview.seek(pv.time);
      }
    }
    saveRigCache();
    // Prebuild the uncleaned version so holding Compare swaps instantly (it
    // also feeds the ghost overlay, which points at the stale clip until then).
    void buildDisplay(false).then((b) => {
      if (gen !== compareGen) return;
      compareBase = b;
      if (ghostOn) preview?.setGhost(b);
    }).catch(() => {});
  }

  // Hold-to-compare: show the recording without cleaning while pressed. The
  // camera, playhead, and trim all carry over, so differences pop visually.
  const compareBtn = document.getElementById("compare") as HTMLButtonElement;
  let comparing = false;
  let compareLocked = false; // View menu: keep the uncleaned view up without holding
  const showClip = (clip: ConvertedClip) => {
    if (!preview) return;
    const trim = transport?.getTrim();
    preview.setClip(clip, true);
    if (trim) preview.setTrim(trim.start, trim.end);
  };
  compareBtn.addEventListener("pointerdown", () => {
    if (!loaded || !preview || comparing || compareLocked) return;
    void (async () => {
      compareBase ??= await buildDisplay(false);
      comparing = true;
      compareBtn.classList.add("active");
      showClip(compareBase);
      transport?.curveView.setCompare(true); // ghost the uncleaned dense curves
    })();
  });
  const endCompare = () => {
    if (compareLocked) return; // held release must not cancel the menu lock
    if (!comparing || !loaded?.display) return;
    comparing = false;
    compareBtn.classList.remove("active");
    showClip(loaded.display);
    transport?.curveView.setCompare(false);
  };
  for (const ev of ["pointerup", "pointerleave", "pointercancel"] as const) {
    compareBtn.addEventListener(ev, endCompare);
  }

  // Menu "Lock hold-to-compare": keep the uncleaned view up without holding.
  function toggleCompareLock() {
    if (!loaded || !preview) return;
    compareLocked = !compareLocked;
    compareBtn.classList.toggle("locked", compareLocked);
    if (compareLocked) {
      void (async () => {
        compareBase ??= await buildDisplay(false);
        if (!compareLocked) return;
        comparing = true;
        showClip(compareBase);
        transport?.curveView.setCompare(true);
      })();
    } else {
      comparing = false;
      compareBtn.classList.remove("active");
      if (loaded?.display) showClip(loaded.display);
      transport?.curveView.setCompare(false);
    }
  }

  // Ghost toggle: the uncleaned recording as a grey overlay skeleton, playing
  // in lockstep — the "before" stays visible WHILE posing/cleaning.
  const ghostBtn = document.getElementById("ghostBtn") as HTMLButtonElement;
  ghostBtn.addEventListener("click", () => {
    ghostOn = !ghostOn;
    ghostBtn.classList.toggle("active", ghostOn);
    if (!ghostOn) {
      preview?.setGhost(null);
      return;
    }
    void (async () => {
      compareBase ??= await buildDisplay(false);
      if (ghostOn) preview?.setGhost(compareBase);
    })();
  });

  // ---- control rig -------------------------------------------------------
  // (rigLayers/rigBaseClip are declared with the pipeline state above the
  // compare block; the closures in buildDisplay/export read them.)
  const rigLayersEl = document.getElementById("rigLayers") as HTMLDivElement;
  const rigAddBtn = document.getElementById("rigAdd") as HTMLButtonElement;
  const gizmoMoveBtn = document.getElementById("gizmoMove") as HTMLButtonElement;
  const gizmoRotateBtn = document.getElementById("gizmoRotate") as HTMLButtonElement;
  function setGizmoModeUi(m: "translate" | "rotate") {
    gizmoMoveBtn.classList.toggle("active", m === "translate");
    gizmoRotateBtn.classList.toggle("active", m === "rotate");
    preview?.setGizmoMode(m);
  }
  const rigEditorEl = document.getElementById("rigEditor") as HTMLDivElement;
  const rigSelEl = document.getElementById("rigSel") as HTMLParagraphElement;
  const rigKeysEl = document.getElementById("rigKeys") as HTMLDivElement;
  const rigLimbRowEl = document.getElementById("rigLimbRow") as HTMLDivElement;
  const rigPinBtn = document.getElementById("rigPin") as HTMLButtonElement;
  const rigFkModeBtn = document.getElementById("rigFkMode") as HTMLButtonElement;
  const rigNeutralBtn = document.getElementById("rigNeutral") as HTMLButtonElement;

  rigPinBtn.addEventListener("click", () => {
    if (!selectedEffector || !effectorDef(selectedEffector).chain) return;
    if (pinnedEffectors.has(selectedEffector)) pinnedEffectors.delete(selectedEffector);
    else pinnedEffectors.add(selectedEffector);
    preview?.setPinned(pinnedEffectors);
    saveRigCache();
    updateRigEditor();
  });
  rigFkModeBtn.addEventListener("click", () => {
    if (!selectedEffector || !effectorDef(selectedEffector).chain) return;
    if (fkLimbs.has(selectedEffector)) fkLimbs.delete(selectedEffector);
    else fkLimbs.add(selectedEffector);
    saveRigCache();
    updateRigEditor();
  });
  const rigDelKeyBtn = document.getElementById("rigDelKey") as HTMLButtonElement;
  const rigUndoBtn = document.getElementById("rigUndo") as HTMLButtonElement;
  const rigRedoBtn = document.getElementById("rigRedo") as HTMLButtonElement;

  let activeLayerIdx = -1;
  let selectedEffector: EffectorId | null = null;
  let layerCounter = 0;

  // ---- undo / redo (snapshot the whole rig + modifier state) -------------
  const undoStack: string[] = [];
  const redoStack: string[] = [];
  const rigSnapshot = () =>
    JSON.stringify({
      layers: rigLayers, mods, counter: layerCounter, active: activeLayerIdx,
      warp: warpKeys, ranges: rangeSmooths, cleanOps, feetPlants: feetPlantRemoved, pipeline: pipelineSettings(),
    });
  function updateUndoUi() {
    rigUndoBtn.disabled = !undoStack.length;
    rigRedoBtn.disabled = !redoStack.length;
  }
  function pushHistorySnap(snap: string) {
    undoStack.push(snap);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    updateUndoUi();
  }
  /** Call BEFORE mutating layers or modifiers. */
  const pushHistory = () => pushHistorySnap(rigSnapshot());
  function restoreSnapshot(snap: string) {
    const d = JSON.parse(snap) as {
      layers: RigLayer[];
      mods: ReturnType<typeof defaultModifiers>;
      counter: number;
      active: number;
      warp?: WarpKey[];
      ranges?: RangeSmooth[];
      cleanOps?: CleanOp[];
      feetPlants?: PlantSpan[];
      pipeline?: PipelineSettings;
    };
    const pipelineChanged =
      JSON.stringify(mods) !== JSON.stringify(d.mods) ||
      JSON.stringify(warpKeys) !== JSON.stringify(d.warp ?? []) ||
      JSON.stringify(rangeSmooths) !== JSON.stringify(d.ranges ?? []) ||
      JSON.stringify(cleanOps) !== JSON.stringify(d.cleanOps ?? []) ||
      JSON.stringify(feetPlantRemoved) !== JSON.stringify(d.feetPlants ?? []) ||
      (!!d.pipeline && JSON.stringify(d.pipeline) !== JSON.stringify(pipelineSettings()));
    rigLayers.splice(0, rigLayers.length, ...d.layers);
    Object.assign(mods, defaultModifiers(), d.mods);
    warpKeys.splice(0, warpKeys.length, ...(d.warp ?? []));
    rangeSmooths.splice(0, rangeSmooths.length, ...(d.ranges ?? []));
    cleanOps.splice(0, cleanOps.length, ...(d.cleanOps ?? []));
    feetPlantRemoved.splice(0, feetPlantRemoved.length, ...(d.feetPlants ?? []));
    renderFilters();
    if (d.pipeline) applyPipelineUi(d.pipeline);
    layerCounter = d.counter;
    activeLayerIdx = Math.min(d.active, rigLayers.length - 1);
    syncAdjustUi();
    renderRigLayers();
    if (pipelineChanged) void reclean();
    else rebakeRig();
  }
  function rigUndo() {
    if (!undoStack.length) return;
    redoStack.push(rigSnapshot());
    restoreSnapshot(undoStack.pop()!);
    updateUndoUi();
  }
  function rigRedo() {
    if (!redoStack.length) return;
    undoStack.push(rigSnapshot());
    restoreSnapshot(redoStack.pop()!);
    updateUndoUi();
  }
  rigUndoBtn.addEventListener("click", rigUndo);
  rigRedoBtn.addEventListener("click", rigRedo);

  // ---- key multi-selection + clipboard ------------------------------------
  interface PickedKey { effector: EffectorId; time: number; }
  let pickedKeys: PickedKey[] = [];
  let keyClipboard: Array<{ effector: EffectorId; dt: number; mode: RigLayer["mode"]; pos?: Vec3; rot?: Quat }> = [];
  const isPicked = (eff: EffectorId, t: number) => pickedKeys.some((p) => p.effector === eff && Math.abs(p.time - t) < 1e-3);

  function copyPicked() {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !pickedKeys.length) return;
    const t0 = Math.min(...pickedKeys.map((p) => p.time));
    keyClipboard = [];
    for (const p of pickedKeys) {
      const tr = getTrack(layer, p.effector);
      if (!tr) continue;
      const pk = tr.posKeys.find((k) => Math.abs(k.time - p.time) < 1e-3);
      const rk = tr.rotKeys.find((k) => Math.abs(k.time - p.time) < 1e-3);
      if (!pk && !rk) continue;
      keyClipboard.push({
        effector: p.effector,
        dt: p.time - t0,
        mode: layer.mode,
        pos: pk ? ([...pk.v] as Vec3) : undefined,
        rot: rk ? ([...rk.q] as Quat) : undefined,
      });
    }
  }

  function pastePicked() {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !keyClipboard.length || !preview) return;
    // Additive deltas and override values are different quantities — pasting
    // across modes would scramble the pose.
    if (keyClipboard[0].mode && keyClipboard[0].mode !== layer.mode) {
      showError(`These keys were copied from an ${keyClipboard[0].mode} layer. Paste them onto an ${keyClipboard[0].mode} layer (this one is ${layer.mode}).`);
      return;
    }
    const t0 = preview.getTime();
    pushHistory();
    let dirty: TimeRange | null = null;
    pickedKeys = [];
    for (const it of keyClipboard) {
      const tr = getTrack(layer, it.effector, true)!;
      const t = t0 + it.dt;
      // Keys are LOCAL values/deltas — they reproduce the same adjustment at
      // the destination without any base-dependent conversion.
      if (it.pos) setPosKey(tr, t, [...it.pos] as Vec3);
      if (it.rot) setRotKey(tr, t, [...it.rot] as Quat);
      const dr = dirtyRange(layer, tr, t);
      dirty = dirty ? unionRange(dirty, dr) : dr;
      pickedKeys.push({ effector: it.effector, time: t });
    }
    rebakeRig(dirty ?? undefined);
    updateRigEditor();
  }

  function deletePicked() {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !pickedKeys.length) return;
    pushHistory();
    let dirty: TimeRange | null = null;
    for (const p of pickedKeys) {
      const tr = getTrack(layer, p.effector);
      if (!tr) continue;
      const dr = dirtyRange(layer, tr, p.time);
      dirty = dirty ? unionRange(dirty, dr) : dr;
      deleteKeysAt(tr, p.time, 1 / 120);
    }
    pickedKeys = [];
    rebakeRig(dirty ?? undefined);
    updateRigEditor();
  }

  rigHotkeys = {
    undo: rigUndo,
    redo: rigRedo,
    copy: copyPicked,
    paste: pastePicked,
    del: deletePicked,
    mode: (m) => setGizmoModeUi(m),
    toggleSpace: () => setGizmoSpaceUi(preview?.getGizmoSpace() === "local" ? "world" : "local"),
  };

  transportHotkeys = {
    toggle: () => preview?.togglePlay(),
    step: (n) => {
      if (!preview || !loaded) return;
      const clip = loaded.display;
      const dt = clip.duration / Math.max(1, clip.times.length - 1);
      preview.pause();
      preview.seek(preview.getTime() + n * dt);
    },
    home: () => { preview?.pause(); preview?.seek(transport?.getTrim().start ?? 0); },
    end: () => { preview?.pause(); preview?.seek(transport?.getTrim().end ?? 0); },
  };

  /**
   * Rebake layers onto the (unchanged) base, IN PLACE in the display clip the
   * preview is already playing — no setClip, no body/face rebuild. `dirty`
   * limits the bake to the frames a key edit actually changed. Small ranges
   * bake synchronously (~20 ms); big ones run CHUNKED in the background so
   * editing is never interrupted. Bakes queue, so results stay ordered.
   */
  let bakeQueue: Promise<void> = Promise.resolve();
  function rebakeRig(dirty?: TimeRange) {
    if (!loaded || !preview || !rigBaseClip) return;
    bakeQueue = bakeQueue.then(async () => {
      if (!loaded || !preview || !rigBaseClip) return;
      const d = loaded.display; // re-read: a reclean may have swapped it
      const t0 = dirty?.t0 ?? -Infinity;
      const t1 = dirty?.t1 ?? Infinity;
      let count = 0;
      for (const t of rigBaseClip.times) if (t >= t0 && t <= t1) count++;
      if (count <= 2500) {
        bakeRange(rigBaseClip, rigLayers, d.localPos, d.localQuat, dirty);
      } else {
        const done = await bakeRangeAsync(
          rigBaseClip, rigLayers, d.localPos, d.localQuat, dirty,
          () => loaded?.display !== d, // superseded by a reclean
        );
        if (!done) return;
      }
      if (loaded?.display !== d) return; // reclean replaced the clip mid-bake
      d.bindPos = d.localPos.map((t) => t[0]);
      preview.seek(preview.getTime()); // repose from the updated arrays
      saveRigCache();
    });
  }

  // ---- IK/FK blend ---------------------------------------------------------
  /** End effectors whose limb is pure FK (blend 0) — their handle hides. */
  function fkOnlyEffectors(): EffectorId[] {
    const out: EffectorId[] = [];
    if (ikfk.leftArm <= 0) out.push("leftHand");
    if (ikfk.rightArm <= 0) out.push("rightHand");
    if (ikfk.leftLeg <= 0) out.push("leftFoot");
    if (ikfk.rightLeg <= 0) out.push("rightFoot");
    return out;
  }
  const ikfkSliders: Array<{ el: HTMLInputElement; out: HTMLOutputElement; key: keyof IkfkBlend }> = [];
  function syncIkfkUi() {
    for (const s of ikfkSliders) { s.el.value = String(Math.round(ikfk[s.key] * 100)); s.out.value = `${s.el.value}%`; }
    preview?.setFkOnlyLimbs(fkOnlyEffectors());
  }
  function buildIkfk() {
    const wrap = document.getElementById("ikfkBlend") as HTMLDivElement;
    const list = document.getElementById("ikfkSliders") as HTMLDivElement;
    list.innerHTML = "";
    ikfkSliders.length = 0;
    const names = (rigBaseClip ?? converted).names;
    const limbs = ([
      { key: "leftArm", label: "L arm", root: "LeftUpperArm" },
      { key: "rightArm", label: "R arm", root: "RightUpperArm" },
      { key: "leftLeg", label: "L leg", root: "LeftUpperLeg" },
      { key: "rightLeg", label: "R leg", root: "RightUpperLeg" },
    ] as Array<{ key: keyof IkfkBlend; label: string; root: string }>).filter((l) => names.includes(l.root));
    wrap.hidden = limbs.length === 0;
    for (const limb of limbs) {
      const label = document.createElement("label");
      label.className = "field sub";
      const span = document.createElement("span");
      const out = document.createElement("output");
      out.value = `${Math.round(ikfk[limb.key] * 100)}%`;
      span.append(`${limb.label} `, out);
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0"; input.max = "100"; input.step = "5";
      input.value = String(Math.round(ikfk[limb.key] * 100));
      input.title = "100% IK (reach) … 0% FK (segment handles only)";
      input.addEventListener("input", () => {
        ikfk[limb.key] = Number(input.value) / 100;
        out.value = `${input.value}%`;
        preview?.setFkOnlyLimbs(fkOnlyEffectors());
      });
      input.addEventListener("change", () => saveRigCache());
      label.append(span, input);
      list.appendChild(label);
      ikfkSliders.push({ el: input, out, key: limb.key });
    }
  }

  // ---- picker (schematic body map) -----------------------------------------
  const picker = new RigPicker({
    onSelect: (id) => { preview?.selectEffector(id); },
    onHand: (side) => { picker.openFingers(side); handPoseWrap.hidden = false; },
    onFinger: (bone) => {
      const eff = effectorForBone(bone);
      if (eff) { preview?.selectEffector(eff.id); transport?.curveView.syncTreeSelection([bone]); }
    },
    onPin: (id) => {
      if (!effectorDef(id).chain) return;
      if (pinnedEffectors.has(id)) pinnedEffectors.delete(id); else pinnedEffectors.add(id);
      preview?.setPinned(pinnedEffectors);
      saveRigCache();
      updateRigEditor();
    },
  });
  (document.getElementById("pickerMount") as HTMLDivElement).appendChild(picker.el);
  function updatePicker() {
    const layer = rigLayers[activeLayerIdx];
    const keyed = new Set<string>();
    if (layer) for (const tr of layer.tracks) if (tr.rotKeys.length + tr.posKeys.length) keyed.add(tr.bone);
    picker.update({
      keyedBones: keyed,
      pinned: pinnedEffectors,
      ikfk,
      selected: selectedEffector,
      present: new Set((rigBaseClip ?? converted).names),
    });
  }

  // ---- hand pose stamps ----------------------------------------------------
  const handPoseWrap = document.getElementById("handPose") as HTMLDivElement;
  const handPoseSides = document.getElementById("handPoseSides") as HTMLDivElement;

  /** Preview the live hand-pose delta (playhead frame) without keying. */
  function previewHandPose(side: HandSide, amounts: HandPoseAmounts) {
    if (!rigBaseClip || !preview || activeLayerIdx < 0) return;
    const f = nearestFrame(rigBaseClip, preview.getTime());
    const pose = stackPoseThrough(rigBaseClip, rigLayers, activeLayerIdx, f);
    applyHandPose(rigBaseClip, pose, side, amounts);
    applyLayersToPose(pose, rigBaseClip.names, rigBaseClip.parents, rigLayers.slice(activeLayerIdx + 1), rigBaseClip.times[f] - rigBaseClip.times[0]);
    preview.setPoseOverride(pose);
  }

  /** Build the per-hand slider sets for the hands present in the clip. */
  function buildHandPose() {
    handPoseSides.innerHTML = "";
    const names = (rigBaseClip ?? converted).names;
    const sides: HandSide[] = [];
    for (const s of ["Left", "Right"] as HandSide[]) if (hasHandFingers(names, s)) sides.push(s);
    handPoseWrap.hidden = sides.length === 0;
    for (const side of sides) {
      const amounts: HandPoseAmounts = { curl: 0, spread: 0, thumbCurl: 0 };
      const block = document.createElement("div");
      block.className = "hand-pose-side";
      const title = document.createElement("div");
      title.className = "clean-stats";
      title.style.margin = "2px 0";
      title.textContent = `${side} hand`;
      block.appendChild(title);
      const mk = (label: string, key: keyof HandPoseAmounts, min: number) => {
        const wrap = document.createElement("label");
        wrap.className = "field sub";
        const span = document.createElement("span");
        span.textContent = label;
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(min);
        input.max = "100";
        input.step = "5";
        input.value = "0";
        const scale = 1 / 100;
        input.addEventListener("input", () => {
          amounts[key] = Number(input.value) * scale;
          previewHandPose(side, amounts);
        });
        const stamp = () => {
          if (!rigBaseClip || !preview || activeLayerIdx < 0) { input.value = "0"; return; }
          const f = nearestFrame(rigBaseClip, preview.getTime());
          const t = rigBaseClip.times[f] - rigBaseClip.times[0];
          if (amounts.curl || amounts.spread || amounts.thumbCurl) {
            pushHistory();
            const dirty = keyHandPose(rigBaseClip, rigLayers, activeLayerIdx, side, amounts, f, t);
            preview.setPoseOverride(null);
            rebakeRig(dirty ?? undefined);
            updateRigEditor();
          } else {
            preview.setPoseOverride(null);
          }
          amounts.curl = amounts.spread = amounts.thumbCurl = 0;
          for (const r of block.querySelectorAll("input")) (r as HTMLInputElement).value = "0";
        };
        input.addEventListener("change", stamp);
        wrap.append(span, input);
        block.appendChild(wrap);
      };
      mk("Curl", "curl", 0);
      mk("Spread", "spread", -100);
      mk("Thumb curl", "thumbCurl", 0);
      handPoseSides.appendChild(block);
    }
  }

  function keyContextItems(): Array<{ label: string; action?: () => void; disabled?: boolean }> {
    const n = pickedKeys.length;
    return [
      { label: `Copy ${n} key${n === 1 ? "" : "s"} (Ctrl+C)`, action: copyPicked, disabled: !n },
      { label: "Paste at playhead (Ctrl+V)", action: pastePicked, disabled: !keyClipboard.length },
      { label: `Delete ${n} key${n === 1 ? "" : "s"} (Del)`, action: deletePicked, disabled: !n },
    ];
  }

  function updateRigEditor() {
    const layer = rigLayers[activeLayerIdx];
    updatePicker();
    // Drop picks that no longer exist (deleted keys, switched layer).
    pickedKeys = layer
      ? pickedKeys.filter((p) => {
          const tr = getTrack(layer, p.effector);
          return !!tr && keyTimes(tr).some((t) => Math.abs(t - p.time) < 1e-3);
        })
      : [];
    // Timeline markers for the active layer (cleared when there is none).
    // Tracks are keyed by bone; each maps 1:1 to the effector that edits it.
    const trackEff = (tr: { bone: string }) => effectorForBone(tr.bone)?.id;
    const rawMarkers = layer
      ? layer.tracks.flatMap((tr) => {
          const eff = trackEff(tr);
          if (!eff) return [];
          return keyTimes(tr).map((t) => ({
            time: t,
            color: effectorColor(eff),
            selected: eff === selectedEffector,
            picked: isPicked(eff, t),
            tag: eff,
          }));
        })
      : [];
    // Collapse co-timed keys ("Key pose" writes the whole rig at one frame)
    // into a single white pose marker; click/drag acts on all of them.
    const POSE = "__pose__";
    const byTime = new Map<number, TransportKeyMarker[]>();
    for (const m of rawMarkers) {
      const q = Math.round(m.time * 240);
      const arr = byTime.get(q);
      if (arr) arr.push(m);
      else byTime.set(q, [m]);
    }
    const markers: TransportKeyMarker[] = [];
    for (const group of byTime.values()) {
      if (group.length < 3) markers.push(...group);
      else
        markers.push({
          time: group[0].time,
          color: "#e8ecf4",
          selected: group.some((m) => m.selected),
          picked: group.some((m) => m.picked),
          tag: POSE,
        });
    }
    /** Every effector with a key at this exact time (pose-marker targets). */
    const keysAtTime = (t: number): PickedKey[] =>
      layer
        ? layer.tracks.flatMap((tr) => {
            const eff = trackEff(tr);
            return eff && keyTimes(tr).some((kt) => Math.abs(kt - t) < 1e-3)
              ? [{ effector: eff, time: t }]
              : [];
          })
        : [];
    const keyCbs = {
      onClick: (m, ctrl) => {
        if (m.tag === POSE) {
          // Pose marker: (ctrl-)select every key at this time as one unit.
          const at = keysAtTime(m.time);
          const others = pickedKeys.filter((p) => Math.abs(p.time - m.time) > 1e-3);
          const allPicked = at.every((p) => isPicked(p.effector, p.time));
          pickedKeys = ctrl ? (allPicked ? others : [...others, ...at]) : at;
          updateRigEditor();
          return;
        }
        const eff = m.tag as EffectorId;
        if (ctrl) {
          // Ctrl-click toggles the key in/out of the selection.
          if (isPicked(eff, m.time)) pickedKeys = pickedKeys.filter((p) => !(p.effector === eff && Math.abs(p.time - m.time) < 1e-3));
          else pickedKeys.push({ effector: eff, time: m.time });
          updateRigEditor();
        } else {
          pickedKeys = [{ effector: eff, time: m.time }];
          preview?.selectEffector(eff);
          updateRigEditor();
        }
      },
      onRetime: (m, newTime) => {
        const lay = rigLayers[activeLayerIdx];
        if (!lay || !rigBaseClip) return;
        pushHistory();
        // Dragging a key that's part of the selection slides the WHOLE
        // selection by the same amount; a pose marker slides every key at its
        // time. Local key values travel correctly as-is.
        const eff = m.tag as EffectorId;
        const inGroup = m.tag !== POSE && isPicked(eff, m.time) && pickedKeys.length > 1;
        const moves =
          m.tag === POSE ? keysAtTime(m.time)
          : inGroup ? pickedKeys.map((p) => ({ ...p }))
          : [{ effector: eff, time: m.time }];
        const dt = newTime - m.time;
        // Move in an order that can't collide with not-yet-moved members.
        // Local-space key values travel correctly as-is.
        moves.sort((a, b) => (dt > 0 ? b.time - a.time : a.time - b.time));
        let dirty: TimeRange | null = null;
        const newPicked: typeof pickedKeys = [];
        for (const mv of moves) {
          const tr = getTrack(lay, mv.effector);
          if (!tr) continue;
          const to = Math.max(0, Math.min(rigBaseClip.duration, mv.time + dt));
          const before = dirtyRange(lay, tr, mv.time);
          retimeKeys(tr, mv.time, to);
          const after = dirtyRange(lay, tr, to);
          dirty = dirty ? unionRange(unionRange(dirty, before), after) : unionRange(before, after);
          newPicked.push({ effector: mv.effector, time: to });
        }
        pickedKeys = newPicked;
        rebakeRig(dirty ?? undefined);
        updateRigEditor();
      },
      onContext: (m, x, y) => {
        const at = m.tag === POSE ? keysAtTime(m.time) : [{ effector: m.tag as EffectorId, time: m.time }];
        if (!at.every((p) => isPicked(p.effector, p.time))) {
          pickedKeys = at;
          updateRigEditor();
        }
        showCtxMenu(x, y, keyContextItems());
      },
      onContextBlank: (x, y) => {
        const lay = rigLayers[activeLayerIdx];
        showCtxMenu(x, y, [
          { label: "Paste at playhead (Ctrl+V)", action: pastePicked, disabled: !keyClipboard.length },
          {
            label: "Select all keys",
            disabled: !lay,
            action: () => {
              pickedKeys = lay
                ? lay.tracks.flatMap((tr) => {
                    const eff = trackEff(tr);
                    return eff ? keyTimes(tr).map((t) => ({ effector: eff, time: t })) : [];
                  })
                : [];
              updateRigEditor();
            },
          },
          { label: "Clear selection", action: () => { pickedKeys = []; updateRigEditor(); }, disabled: !pickedKeys.length },
        ]);
      },
      onBand: (t0, t1) => {
        const lay = rigLayers[activeLayerIdx];
        if (!lay) return;
        pickedKeys = lay.tracks.flatMap((tr) => {
          const eff = trackEff(tr);
          return eff
            ? keyTimes(tr).filter((t) => t >= t0 && t <= t1).map((t) => ({ effector: eff, time: t }))
            : [];
        });
        updateRigEditor();
      },
    } satisfies Parameters<NonNullable<typeof transport>["setKeys"]>[1];
    transport?.setKeys(markers, keyCbs);
    // Dope sheet: one row per keyed effector, only while the Rig tab is up.
    const dopeRows =
      activeTab === "rig" && layer
        ? layer.tracks
            .filter((tr) => (tr.posKeys.length + tr.rotKeys.length > 0) && trackEff(tr))
            .map((tr) => {
              const eff = trackEff(tr)!;
              return {
                tag: eff,
                label: effectorDef(eff).label.replace("Left ", "L ").replace("Right ", "R "),
                color: effectorColor(eff),
                keys: keyTimes(tr).map((t) => ({
                  time: t,
                  color: effectorColor(eff),
                  selected: eff === selectedEffector,
                  picked: isPicked(eff, t),
                  tag: eff,
                })),
              };
            })
        : [];
    transport?.setDope(dopeRows, keyCbs);

    // Curve editor: the selected effector's key values as per-axis curves
    // (position deltas in cm, rotation deltas as ZYX euler degrees).
    const curveTrack = activeTab === "rig" && layer && selectedEffector ? getTrack(layer, selectedEffector) : null;
    if (curveTrack && (curveTrack.posKeys.length || curveTrack.rotKeys.length)) {
      const def = effectorDef(selectedEffector!);
      const axisColor = ["#ff6b6b", "#7dda6b", "#6bb1ff"];
      // Unwrapped display eulers: equivalent representations don't draw as
      // ±180° jumps between keys (the underlying quats are untouched).
      const rotEulers = unwrapEulerKeys(curveTrack.rotKeys);
      const channels = [
        ...(def.bone === "Hips" // position keys live on the hips track only
          ? [0, 1, 2].map((axis) => ({
              group: "pos" as const,
              axis: axis as 0 | 1 | 2,
              label: `pos ${"XYZ"[axis]} (cm)`,
              color: axisColor[axis],
              keys: curveTrack.posKeys.map((k) => ({ time: k.time, value: k.v[axis] * 100, ease: (k.ease ?? "linear") as CurveEase })),
            }))
          : []),
        ...[0, 1, 2].map((axis) => ({
          group: "rot" as const,
          axis: axis as 0 | 1 | 2,
          label: `rot ${"XYZ"[axis]} (°)`,
          color: axisColor[axis],
          keys: curveTrack.rotKeys.map((k, ki) => ({ time: k.time, value: rotEulers[ki][axis] * RAD2DEG, ease: (k.ease ?? "linear") as CurveEase })),
        })),
      ];
      transport?.setCurves(
        { duration: rigBaseClip?.duration ?? 0, title: `${def.label} · ${layer.name}`, channels },
        {
          onValueStart: () => pushHistory(),
          onValue: (group, axis, time, value) => {
            const lay = rigLayers[activeLayerIdx];
            const tr = lay && selectedEffector ? getTrack(lay, selectedEffector) : null;
            if (!tr || !lay) return;
            if (group === "pos") {
              const k = tr.posKeys.find((kk) => Math.abs(kk.time - time) < 1e-3);
              if (k) k.v[axis] = value / 100;
            } else {
              const ki = tr.rotKeys.findIndex((kk) => Math.abs(kk.time - time) < 1e-3);
              if (ki >= 0) {
                // Edit against the DISPLAYED (unwrapped) triple — mixing the
                // dragged axis into the canonical extraction would silently
                // switch euler representations and warp the rotation.
                const e = unwrapEulerKeys(tr.rotKeys)[ki];
                e[axis] = value / RAD2DEG;
                tr.rotKeys[ki].q = eulerZYXToQuat(e);
              }
            }
            rebakeRig(dirtyRange(lay, tr, time)); // live — the graph redraws itself
          },
          onValueEnd: () => updateRigEditor(),
          onSeek: (t) => {
            preview?.pause();
            preview?.seek(t);
          },
          onContext: (info) => {
            // Curves are per-axis but the underlying keys are whole pos/rot
            // vectors — operations act on the unique key TIMES in play.
            const times = [...new Set(info.keys.map((k) => k.time.toFixed(4)))].map(Number).sort((a, b) => a - b);
            const n = times.length;
            const items: Array<{ label: string; action?: () => void; disabled?: boolean }> = [
              { label: `Insert key @ ${fmtTime(info.time)}`, action: () => curveInsert(info.time) },
            ];
            if (n) {
              const span = { t0: info.span!.t0 - 1e-3, t1: info.span!.t1 + 1e-3 };
              items.push(
                { label: `Delete ${n} key${n === 1 ? "" : "s"}`, action: () => curveDeleteMany(times) },
                { label: "Smooth keys", action: () => curveSmoothSel(span), disabled: n < 2 },
                { label: "Reduce keys", action: () => curveReduceSel(span), disabled: n < 3 },
                ...(["linear", "smooth", "step"] as const).map((ease) => ({
                  label: `Ease: ${ease}`,
                  action: () => curveEaseMany(times, ease),
                })),
              );
            }
            showCtxMenu(info.x, info.y, items);
          },
        },
      );
    } else {
      transport?.setCurves(null, null);
    }

    // Context-menu helpers for the curve editor (defined after use above via
    // hoisting; they operate on the active layer's selected-effector track).
    function curveTrackNow() {
      const lay = rigLayers[activeLayerIdx];
      const tr = lay && selectedEffector ? getTrack(lay, selectedEffector) : null;
      return tr && lay ? { lay, tr } : null;
    }
    function curveInsert(time: number) {
      const c = curveTrackNow();
      if (!c) return;
      pushHistory();
      // Sample the current curve so inserting doesn't change the motion.
      const p = sampleTrackPos(c.tr.posKeys, time);
      if (p) setPosKey(c.tr, time, [...p] as Vec3);
      const q = sampleTrackRot(c.tr.rotKeys, time);
      if (q) setRotKey(c.tr, time, [...q] as Quat);
      rebakeRig(dirtyRange(c.lay, c.tr, time));
      updateRigEditor();
    }
    function curveDeleteMany(times: number[]) {
      const c = curveTrackNow();
      if (!c || !times.length) return;
      pushHistory();
      let dirty = dirtyRange(c.lay, c.tr, times[0]);
      for (const t of times) dirty = unionRange(dirty, dirtyRange(c.lay, c.tr, t));
      for (const t of times) deleteKeysAt(c.tr, t, 1 / 120);
      rebakeRig(dirty);
      updateRigEditor();
    }
    function curveEaseMany(times: number[], ease: CurveEase) {
      const c = curveTrackNow();
      if (!c || !times.length) return;
      pushHistory();
      let dirty = dirtyRange(c.lay, c.tr, times[0]);
      for (const t of times) {
        setKeyEase(c.tr, t, ease);
        dirty = unionRange(dirty, dirtyRange(c.lay, c.tr, t));
      }
      rebakeRig(dirty);
      updateRigEditor();
    }
    function curveReduceSel(span: { t0: number; t1: number }) {
      const c = curveTrackNow();
      if (!c) return;
      pushHistory();
      const n = reduceKeys(c.tr, undefined, undefined, span.t0, span.t1);
      rigSelEl.textContent = `Reduced: ${n} key${n === 1 ? "" : "s"} removed.`;
      rebakeRig();
      updateRigEditor();
    }
    function curveSmoothSel(span: { t0: number; t1: number }) {
      const c = curveTrackNow();
      if (!c) return;
      pushHistory();
      smoothKeys(c.tr, span.t0, span.t1);
      rebakeRig();
      updateRigEditor();
    }

    rigEditorEl.hidden = !layer;
    if (!layer) return;
    if (!selectedEffector) {
      rigSelEl.textContent = "Click a colored handle on the figure to pose it.";
      rigKeysEl.innerHTML = "";
      rigLimbRowEl.hidden = true;
      return;
    }
    const def = effectorDef(selectedEffector);
    // Pin + IK/FK controls only exist for two-bone limbs (hands/feet).
    rigLimbRowEl.hidden = !def.chain;
    if (def.chain) {
      rigPinBtn.textContent = pinnedEffectors.has(selectedEffector) ? "📌 Unpin" : "📌 Pin";
      rigPinBtn.classList.toggle("active", pinnedEffectors.has(selectedEffector));
      rigFkModeBtn.textContent = fkLimbs.has(selectedEffector) ? "Mode: FK" : "Mode: IK";
    }
    const track = getTrack(layer, selectedEffector);
    const times = track ? keyTimes(track) : [];
    rigSelEl.textContent = `${def.label} on ${layer.name} · ${times.length} key${times.length === 1 ? "" : "s"}${pinnedEffectors.has(selectedEffector) ? " · pinned" : ""}`;
    rigKeysEl.innerHTML = "";
    for (const t of times) {
      const chip = document.createElement("span");
      chip.className = "rig-key";
      const label = document.createElement("button");
      label.textContent = fmtTime(t);
      label.title = "Jump to this key";
      label.addEventListener("click", () => { preview?.pause(); preview?.seek(t); });
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Delete this key";
      del.addEventListener("click", () => {
        if (!track) return;
        pushHistory();
        const layerNow = rigLayers[activeLayerIdx];
        const dirty = layerNow ? dirtyRange(layerNow, track, t) : undefined;
        deleteKeysAt(track, t, 1 / 120);
        rebakeRig(dirty);
        updateRigEditor();
      });
      chip.append(label, del);
      rigKeysEl.appendChild(chip);
    }
  }

  function renderRigLayers() {
    rigLayersEl.innerHTML = "";
    rigLayers.forEach((layer, i) => {
      const row = document.createElement("div");
      row.className = "rig-layer" + (i === activeLayerIdx ? " active" : "");
      row.addEventListener("click", () => {
        if (activeLayerIdx !== i) { activeLayerIdx = i; renderRigLayers(); }
      });

      const en = document.createElement("input");
      en.type = "checkbox";
      en.checked = layer.enabled;
      en.title = "Mute/unmute this layer";
      en.addEventListener("click", (e) => e.stopPropagation());
      en.addEventListener("change", () => { pushHistory(); layer.enabled = en.checked; rebakeRig(); });

      const name = document.createElement("span");
      name.className = "rig-name";
      name.textContent = layer.name;

      const mode = document.createElement("select");
      mode.title = "Additive nudges the motion by a delta; override replaces it with the keyed pose (scaled by weight).";
      for (const m of ["additive", "override"] as const) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        if (layer.mode === m) o.selected = true;
        mode.appendChild(o);
      }
      mode.addEventListener("click", (e) => e.stopPropagation());
      mode.addEventListener("change", () => {
        pushHistory();
        // Convert existing keys so the pose survives the mode switch.
        if (rigBaseClip) convertLayerMode(rigBaseClip, rigLayers, i, mode.value as RigLayer["mode"]);
        else layer.mode = mode.value as RigLayer["mode"];
        rebakeRig();
      });

      const extent = document.createElement("select");
      extent.title = "Fade: keys ease in/out around the keyed range, so one key is a local correction. Hold: the first/last key extends across the whole clip, MoBu style.";
      for (const x of ["fade", "hold"] as const) {
        const o = document.createElement("option");
        o.value = x;
        o.textContent = x;
        if (layer.extent === x) o.selected = true;
        extent.appendChild(o);
      }
      extent.addEventListener("click", (e) => e.stopPropagation());
      extent.addEventListener("change", () => {
        pushHistory();
        layer.extent = extent.value as RigLayer["extent"];
        renderRigLayers(); // fade slider visibility
        rebakeRig();
      });

      const weight = document.createElement("input");
      weight.type = "range";
      weight.min = "0"; weight.max = "100"; weight.step = "5";
      weight.value = String(Math.round(layer.weight * 100));
      weight.title = "Layer weight";
      weight.addEventListener("click", (e) => e.stopPropagation());
      let weightSnap: string | null = null; // pre-drag state, captured on first input
      weight.addEventListener("input", () => {
        weightSnap ??= rigSnapshot();
        layer.weight = Number(weight.value) / 100;
      });
      weight.addEventListener("change", () => {
        if (weightSnap) { pushHistorySnap(weightSnap); weightSnap = null; }
        rebakeRig();
      });

      // Second line: weight + (for fade layers) the fade-time slider.
      const sub = document.createElement("div");
      sub.className = "rig-sub";
      const wLabel = document.createElement("span");
      wLabel.textContent = "weight";
      sub.append(wLabel, weight);
      if (layer.extent === "fade") {
        const fLabel = document.createElement("span");
        fLabel.textContent = `fade ${layer.fadeS.toFixed(1)}s`;
        const fade = document.createElement("input");
        fade.type = "range";
        fade.min = "0.1"; fade.max = "2"; fade.step = "0.1";
        fade.value = String(layer.fadeS);
        fade.title = "How long a correction eases in/out around its keys";
        fade.addEventListener("click", (e) => e.stopPropagation());
        let fadeSnap: string | null = null;
        fade.addEventListener("input", () => {
          fadeSnap ??= rigSnapshot();
          layer.fadeS = Number(fade.value);
          fLabel.textContent = `fade ${layer.fadeS.toFixed(1)}s`;
        });
        fade.addEventListener("change", () => {
          if (fadeSnap) { pushHistorySnap(fadeSnap); fadeSnap = null; }
          rebakeRig();
        });
        sub.append(fLabel, fade);
      }

      const del = document.createElement("button");
      del.className = "rig-del";
      del.textContent = "×";
      del.title = "Delete this layer and its keys";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        pushHistory();
        rigLayers.splice(i, 1);
        if (activeLayerIdx >= rigLayers.length) activeLayerIdx = rigLayers.length - 1;
        renderRigLayers();
        rebakeRig();
      });

      row.append(en, name, mode, extent, del, sub);
      rigLayersEl.appendChild(row);
    });
    syncRigVisibility();
    updateRigEditor();
  }

  rigAddBtn.addEventListener("click", () => {
    pushHistory();
    rigLayers.push(makeLayer(`Layer ${++layerCounter}`));
    activeLayerIdx = rigLayers.length - 1;
    renderRigLayers();
    saveRigCache();
  });

  // Auto-build: every import gets a working rig with zero clicks — an empty
  // Layer 1 ready to receive keys. Effectors for absent bones are dropped by
  // the handle/picker/slider code, so recordings without UpperChest or fingers
  // just show fewer controls. Skips if saved state already restored layers.
  function ensureLayer() {
    if (rigLayers.length === 0) {
      rigLayers.push(makeLayer(`Layer ${++layerCounter}`));
      activeLayerIdx = 0;
      renderRigLayers();
    }
    syncRigVisibility();
    updateRigEditor();
  }

  gizmoMoveBtn.addEventListener("click", () => setGizmoModeUi("translate"));
  gizmoRotateBtn.addEventListener("click", () => setGizmoModeUi("rotate"));

  const rigSpaceBtn = document.getElementById("rigSpace") as HTMLButtonElement;
  function setGizmoSpaceUi(s: "local" | "world") {
    preview?.setGizmoSpace(s);
    rigSpaceBtn.innerHTML =
      (s === "local" ? ICONS.local : ICONS.world) + `<span class="eb-lbl">${s === "local" ? "Local" : "World"}</span>`;
  }
  rigSpaceBtn.addEventListener("click", () => {
    setGizmoSpaceUi(preview?.getGizmoSpace() === "local" ? "world" : "local");
  });
  setGizmoSpaceUi(getPref("gizmoSpace")); // default from prefs (bone-aligned unless overridden)

  rigNeutralBtn.addEventListener("click", () => {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !selectedEffector || !rigBaseClip || !preview) return;
    const def = effectorDef(selectedEffector);
    const f = nearestFrame(rigBaseClip, preview.getTime());
    const t = rigBaseClip.times[f] - rigBaseClip.times[0];
    pushHistory();
    // Neutral = key the below-stack pose: identity delta on additive layers,
    // the unadjusted local value on override layers. Covers the same bones a
    // drag on this effector would write (the whole IK chain).
    const below = belowStackPose(rigBaseClip, rigLayers, activeLayerIdx, f);
    const bones = def.chain ? [def.chain.root, def.chain.mid, def.bone] : [def.bone];
    const dirty = captureBoneKeys(
      rigBaseClip, rigLayers, activeLayerIdx, bones, below, f, t, selectedEffector === "hips",
    );
    rebakeRig(dirty ?? undefined);
    updateRigEditor();
  });

  const keyModeSel = document.getElementById("keyMode") as HTMLSelectElement;
  const autoKeyChk = document.getElementById("autoKey") as HTMLInputElement;

  /** Key the current pose at frame f per the active keying mode. */
  function keyPoseByMode(f: number, t: number) {
    if (!rigBaseClip) return;
    const mode = keyModeSel.value;
    if (mode === "full" || !selectedEffector) {
      keyFullPose(rigBaseClip, rigLayers, activeLayerIdx, t, f);
      return;
    }
    const def = effectorDef(selectedEffector);
    const bones = mode === "bodypart"
      ? bodyPartBones(rigBaseClip.names, selectedEffector)
      : def.chain ? [def.chain.root, def.chain.mid, def.bone] : [def.bone];
    const pose = stackPoseThrough(rigBaseClip, rigLayers, activeLayerIdx, f);
    captureBoneKeys(rigBaseClip, rigLayers, activeLayerIdx, bones, pose, f, t, bones.includes("Hips"));
  }

  function doKeyPose() {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !rigBaseClip || !preview) return;
    const t = preview.getTime();
    pushHistory();
    keyPoseByMode(nearestFrame(rigBaseClip, t), t);
    rebakeRig();
    updateRigEditor();
  }
  (document.getElementById("rigKeyAll") as HTMLButtonElement).addEventListener("click", doKeyPose);

  rigDelKeyBtn.addEventListener("click", () => {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !selectedEffector || !preview) return;
    const track = getTrack(layer, selectedEffector);
    if (!track) return;
    const t = preview.getTime();
    const near = keyTimes(track).reduce<number | null>(
      (best, k) => (best === null || Math.abs(k - t) < Math.abs(best - t) ? k : best), null);
    // Frame-accurate like a DCC: only delete a key AT the playhead — the old
    // half-second grab silently ate keys the user wasn't looking at.
    const frameDt = rigBaseClip ? rigBaseClip.duration / Math.max(1, rigBaseClip.times.length - 1) : 1 / 60;
    if (near === null || Math.abs(near - t) > Math.max(frameDt * 1.5, 1 / 60)) {
      rigSelEl.textContent = "No key at the playhead. Step to it with ←/→ or click its diamond first.";
      return;
    }
    pushHistory();
    const dirty = dirtyRange(layer, track, near);
    deleteKeysAt(track, near, 1 / 120);
    rebakeRig(dirty);
    updateRigEditor();
  });

  // Viewport drag: the rig is an INPUT DEVICE — solve IK/FK once per pointer
  // move on the full-stack pose (live preview), then on release capture the
  // affected bones' LOCALS as layer keys. Evaluation never solves anything.
  let dragCtx: {
    effector: EffectorId;
    f: number;
    t: number;
    startPose: FramePose; // full stack at f, drag baseline
    startWorld: { pos: Vec3; rot: Quat };
    fkRef: { joint: Vec3; tip: Vec3 } | null;
    /** FK-mode limb drag: swing this chain-root effector instead of IK. */
    fkLimbAs: EffectorId | null;
    fkLimbRootRot: Quat | null;
    /** Pinned limbs' world targets, captured at pointer-down. */
    pins: PinTarget[];
    solved: FramePose | null;
    bones: string[];
    movedPos: boolean;
  } | null = null;
  let poleCtx: {
    effector: EffectorId; f: number; t: number;
    startPose: FramePose; solved: FramePose | null; bones: string[];
  } | null = null;
  preview?.setRigCallbacks({
    onSelect: (e) => {
      selectedEffector = e;
      // Scope the channel tree to this limb (viewport -> channels sync).
      if (e) {
        const def = effectorDef(e);
        const bones = def.chain ? [def.chain.root, def.chain.mid, def.bone] : [def.bone];
        transport?.curveView.syncTreeSelection(bones);
      }
      updateRigEditor();
    },
    onDragStart: (e) => {
      if (!loaded || !rigBaseClip || activeLayerIdx < 0) return false;
      const layer = rigLayers[activeLayerIdx];
      if (!layer.enabled) return false;
      // Snap to the exact frame: keys bake per frame; sub-frame keys pop.
      const f = nearestFrame(rigBaseClip, preview!.getTime());
      const t = rigBaseClip.times[f] - rigBaseClip.times[0];
      preview!.seek(t);
      // Solve against the stack THROUGH the active layer only — layers above
      // must not be absorbed into the captured keys (they apply on top).
      const startPose = stackPoseThrough(rigBaseClip, rigLayers, activeLayerIdx, f);
      const world = worldFromLocal(rigBaseClip.parents, startPose);
      const def = effectorDef(e);
      const b = rigBaseClip.names.indexOf(def.bone);
      let fkRef = def.canMove ? null : fkDragRef(rigBaseClip, rigLayers, activeLayerIdx, e, f);
      // FK-mode limb: a positional drag swings the WHOLE chain rigidly from
      // its root joint (shoulder/hip) instead of solving IK.
      let fkLimbAs: EffectorId | null = null;
      let fkLimbRootRot: Quat | null = null;
      if (def.chain && fkLimbs.has(e)) {
        const chainRoot = effectorForBone(def.chain.root);
        const rootIdx = rigBaseClip.names.indexOf(def.chain.root);
        if (chainRoot && rootIdx >= 0) {
          fkLimbAs = chainRoot.id;
          fkLimbRootRot = world.rot[rootIdx];
          fkRef = { joint: world.pos[rootIdx], tip: world.pos[b] };
        }
      }
      // Pins hold their pre-drag world spot for the whole drag (skip the
      // grabbed limb's own pin — you're allowed to move what you grabbed).
      const pins = capturePinTargets(
        startPose, rigBaseClip.names, rigBaseClip.parents,
        [...pinnedEffectors].filter((p) => p !== e),
      );
      dragCtx = {
        effector: e, f, t, startPose,
        startWorld: { pos: world.pos[b], rot: world.rot[b] },
        fkRef, fkLimbAs, fkLimbRootRot, pins, solved: null, bones: [], movedPos: false,
      };
      return true;
    },
    onDragMove: (pos, rot) => {
      if (!dragCtx || !rigBaseClip) return;
      if (!rigLayers[activeLayerIdx]) return; // deleted mid-drag
      const def = effectorDef(dragCtx.effector);
      const posMoved = vlen(vsub(pos, dragCtx.startWorld.pos)) > 1e-5;
      const rotMoved = 1 - Math.abs(quatDot(rot, dragCtx.startWorld.rot)) > 1e-9;
      let solveAs = dragCtx.effector;
      const target: EffectorTarget = {};
      if (posMoved && dragCtx.fkLimbAs && dragCtx.fkRef && dragCtx.fkLimbRootRot) {
        // FK limb mode: swing the chain root so the grabbed end chases the drag.
        solveAs = dragCtx.fkLimbAs;
        const drag = vsub(pos, dragCtx.startWorld.pos);
        const dir0 = vnorm(vsub(dragCtx.fkRef.tip, dragCtx.fkRef.joint));
        const dir1 = vnorm(vsub(vadd(dragCtx.fkRef.tip, drag), dragCtx.fkRef.joint));
        target.rot = quatNormalize(quatMul(quatFromTo(dir0, dir1), dragCtx.fkLimbRootRot));
      } else if (posMoved && def.canMove) {
        target.pos = pos;
        dragCtx.movedPos = true;
      } else if (posMoved && dragCtx.fkRef) {
        // Poser pull: swing the bone so its tip chases the drag.
        const drag = vsub(pos, dragCtx.startWorld.pos);
        const dir0 = vnorm(vsub(dragCtx.fkRef.tip, dragCtx.fkRef.joint));
        const dir1 = vnorm(vsub(vadd(dragCtx.fkRef.tip, drag), dragCtx.fkRef.joint));
        target.rot = quatNormalize(quatMul(quatFromTo(dir0, dir1), dragCtx.startWorld.rot));
      } else if (rotMoved && def.canRotate) {
        target.rot = rot;
      } else {
        return;
      }
      const solved = clonePose(dragCtx.startPose);
      const bones = solveEffectorOnPose(
        solved, rigBaseClip.names, rigBaseClip.parents, solveAs, target, dragCtx.pins,
      );
      if (!bones.length) return;
      // Rotating a wrist sends its anatomical twist share to the forearm.
      if (target.rot && solveAs === dragCtx.effector && (solveAs === "leftHand" || solveAs === "rightHand")) {
        const extra = distributeWristTwist(rigBaseClip, solved, solveAs);
        if (extra && !bones.includes(extra)) bones.push(extra);
      }
      // Per-limb IK/FK blend: pull the solved chain back toward the pre-drag
      // FK pose (only in true IK mode, not the rigid FK-limb swing).
      let outBones = bones;
      const limb = solveAs === dragCtx.effector ? limbForEffector(dragCtx.effector) : null;
      if (limb && ikfk[limb] < 1) {
        outBones = blendChainToFK(rigBaseClip, solved, dragCtx.startPose.quat, dragCtx.effector, bones, ikfk[limb], !!target.rot);
      }
      dragCtx.solved = solved;
      dragCtx.bones = outBones;
      if (!outBones.length) { preview?.setPoseOverride(null); return; }
      // Display = solved + the layers ABOVE the active one, so the live view
      // matches what the bake will produce with the full stack.
      const display = clonePose(solved);
      applyLayersToPose(display, rigBaseClip.names, rigBaseClip.parents, rigLayers.slice(activeLayerIdx + 1), dragCtx.t);
      preview?.setPoseOverride(display);
    },
    onDragEnd: () => {
      if (!dragCtx) return;
      const layer = rigLayers[activeLayerIdx];
      const ctx = dragCtx;
      dragCtx = null;
      preview?.setPoseOverride(null);
      if (!layer || !ctx.solved || !ctx.bones.length || !rigBaseClip) return;
      pushHistory();
      const dirty = captureBoneKeys(
        rigBaseClip, rigLayers, activeLayerIdx, ctx.bones, ctx.solved, ctx.f, ctx.t,
        // Root rotates about the ground pivot — that moves the hips position.
        ctx.effector === "root" || (ctx.effector === "hips" && ctx.movedPos),
      );
      if (autoKeyChk.checked) { keyFullPose(rigBaseClip, rigLayers, activeLayerIdx, ctx.t, ctx.f); rebakeRig(); }
      else rebakeRig(dirty ?? undefined);
      updateRigEditor();
    },
    onPoleStart: (e) => {
      if (!loaded || !rigBaseClip || activeLayerIdx < 0) return false;
      const layer = rigLayers[activeLayerIdx];
      if (!layer.enabled) return false;
      const f = nearestFrame(rigBaseClip, preview!.getTime());
      const t = rigBaseClip.times[f] - rigBaseClip.times[0];
      preview!.seek(t);
      poleCtx = { effector: e, f, t, startPose: stackPoseThrough(rigBaseClip, rigLayers, activeLayerIdx, f), solved: null, bones: [] };
      return true;
    },
    onPoleMove: (e, pos) => {
      if (!poleCtx || !rigBaseClip || !rigLayers[activeLayerIdx]) return;
      const solved = clonePose(poleCtx.startPose);
      const bones = solvePoleOnPose(solved, rigBaseClip.names, rigBaseClip.parents, e, pos);
      if (!bones.length) return;
      poleCtx.solved = solved;
      poleCtx.bones = bones;
      const display = clonePose(solved);
      applyLayersToPose(display, rigBaseClip.names, rigBaseClip.parents, rigLayers.slice(activeLayerIdx + 1), poleCtx.t);
      preview?.setPoseOverride(display);
    },
    onPoleEnd: () => {
      if (!poleCtx) return;
      const ctx = poleCtx;
      poleCtx = null;
      preview?.setPoseOverride(null);
      const layer = rigLayers[activeLayerIdx];
      if (!layer || !ctx.solved || !ctx.bones.length || !rigBaseClip) return;
      pushHistory();
      const dirty = captureBoneKeys(rigBaseClip, rigLayers, activeLayerIdx, ctx.bones, ctx.solved, ctx.f, ctx.t);
      if (autoKeyChk.checked) { keyFullPose(rigBaseClip, rigLayers, activeLayerIdx, ctx.t, ctx.f); rebakeRig(); }
      else rebakeRig(dirty ?? undefined);
      updateRigEditor();
    },
    onContext: (e, x, y) => {
      selectedEffector = e;
      const def = effectorDef(e);
      const items: Array<{ label: string; action?: () => void; disabled?: boolean }> = [];
      if (def.chain) {
        const pinned = pinnedEffectors.has(e);
        items.push({
          label: pinned ? "Unpin from world" : "Pin to world",
          action: () => {
            if (pinned) pinnedEffectors.delete(e); else pinnedEffectors.add(e);
            preview?.setPinned(pinnedEffectors); saveRigCache(); updateRigEditor();
          },
        });
        const limb = limbForEffector(e);
        if (limb) {
          const isFk = ikfk[limb] <= 0;
          items.push({
            label: isFk ? "Set limb to IK (100%)" : "Set limb to FK (0%)",
            action: () => { ikfk[limb] = isFk ? 1 : 0; syncIkfkUi(); saveRigCache(); },
          });
        }
      }
      if (items.length) showCtxMenu(x, y, items);
      updateRigEditor();
    },
  });

  renderRigLayers();
  buildHandPose();
  buildIkfk();
  preview?.setPinned(pinnedEffectors);
  preview?.setFkOnlyLimbs(fkOnlyEffectors());

  // ---- modifiers -----------------------------------------------------------
  const modInputs = [
    { el: document.getElementById("modHips") as HTMLInputElement, out: document.getElementById("modHipsVal") as HTMLOutputElement, key: "hipsHeightCm" as const, unit: " cm" },
    { el: document.getElementById("modKnees") as HTMLInputElement, out: document.getElementById("modKneesVal") as HTMLOutputElement, key: "kneesOutDeg" as const, unit: "°" },
    { el: document.getElementById("modElbows") as HTMLInputElement, out: document.getElementById("modElbowsVal") as HTMLOutputElement, key: "elbowsOutDeg" as const, unit: "°" },
    { el: document.getElementById("modFeet") as HTMLInputElement, out: document.getElementById("modFeetVal") as HTMLOutputElement, key: "feetApartCm" as const, unit: " cm" },
  ];
  function syncModSliders() {
    for (const m of modInputs) {
      m.el.value = String(mods[m.key]);
      m.out.value = `${m.el.value}${m.unit}`;
    }
  }
  for (const m of modInputs) {
    m.el.addEventListener("input", () => { m.out.value = `${m.el.value}${m.unit}`; });
    m.el.addEventListener("change", () => {
      pushHistory(); // mods still holds the pre-change value here
      mods[m.key] = Number(m.el.value);
      void reclean();
    });
  }
  // Mirror + reach + time warp + range smoothing.
  const modMirror = document.getElementById("modMirror") as HTMLInputElement;
  modMirror.addEventListener("change", () => {
    pushHistory();
    mods.mirror = modMirror.checked;
    void reclean();
  });

  const reachInputs = [
    { el: document.getElementById("reachLH") as HTMLInputElement, out: document.getElementById("reachLHVal") as HTMLOutputElement, key: "leftHand" as const },
    { el: document.getElementById("reachRH") as HTMLInputElement, out: document.getElementById("reachRHVal") as HTMLOutputElement, key: "rightHand" as const },
    { el: document.getElementById("reachLF") as HTMLInputElement, out: document.getElementById("reachLFVal") as HTMLOutputElement, key: "leftFoot" as const },
    { el: document.getElementById("reachRF") as HTMLInputElement, out: document.getElementById("reachRFVal") as HTMLOutputElement, key: "rightFoot" as const },
  ];
  for (const r of reachInputs) {
    r.el.addEventListener("input", () => { r.out.value = `${r.el.value}%`; });
    r.el.addEventListener("change", () => {
      pushHistory(); // mods still holds the old value
      mods.reach[r.key] = Number(r.el.value) / 100;
      void reclean();
    });
  }

  const warpChipsEl = document.getElementById("warpChips") as HTMLDivElement;
  const warpSpeedSel = document.getElementById("warpSpeed") as HTMLSelectElement;

  /**
   * Layer keys, range smooths, trim, and the playhead all live on the WARPED
   * timeline. When the warp itself changes, translate every stored time
   * old-warp → source → new-warp so corrections stay glued to the same
   * motion instead of silently landing on different frames. Trim + playhead
   * ride along via pendingViewRestore (applied after the transport rebuild).
   */
  function remapForWarpChange(oldWarp: WarpKey[], newWarp: WarpKey[]) {
    if (!loaded) return;
    const times = loaded.converted.times;
    const oldM = warpMaps(times, oldWarp);
    const newM = warpMaps(times, newWarp);
    const re = (t: number) => newM.outOf(oldM.srcOf(t));
    for (const layer of rigLayers) {
      for (const tr of layer.tracks) {
        for (const k of tr.posKeys) k.time = re(k.time);
        for (const k of tr.rotKeys) k.time = re(k.time);
        tr.posKeys.sort((a, b) => a.time - b.time);
        tr.rotKeys.sort((a, b) => a.time - b.time);
      }
    }
    for (const r of rangeSmooths) {
      r.t0 = re(r.t0);
      r.t1 = re(r.t1);
    }
    pickedKeys = pickedKeys.map((p) => ({ ...p, time: re(p.time) }));
    const trim = transport?.getTrim();
    pendingViewRestore = {
      trim: trim ? { start: re(trim.start), end: re(trim.end) } : undefined,
      time: re(preview?.getTime() ?? 0),
    };
  }

  function renderWarpChips() {
    warpChipsEl.innerHTML = "";
    for (const k of [...warpKeys].sort((a, b) => a.time - b.time)) {
      const chip = document.createElement("span");
      chip.className = "rig-key";
      const label = document.createElement("button");
      label.textContent = `${fmtTime(k.time)} ×${k.speed}`;
      label.title = "Source-time speed key";
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Remove this speed key";
      del.addEventListener("click", () => {
        pushHistory();
        const oldWarp = warpKeys.map((kk) => ({ ...kk }));
        warpKeys.splice(warpKeys.indexOf(k), 1);
        remapForWarpChange(oldWarp, warpKeys);
        renderWarpChips();
        void reclean();
      });
      chip.append(label, del);
      warpChipsEl.appendChild(chip);
    }
  }
  (document.getElementById("warpAdd") as HTMLButtonElement).addEventListener("click", () => {
    if (!preview || !loaded) return;
    pushHistory();
    // Warp keys are in SOURCE time: invert the exact warp map at the playhead
    // (a linear fraction is wrong once any non-1× key exists — the map is
    // nonlinear, and the key would land on the wrong motion).
    const srcT = warpMaps(loaded.converted.times, warpKeys).srcOf(preview.getTime());
    const speed = Number(warpSpeedSel.value);
    const oldWarp = warpKeys.map((k) => ({ ...k }));
    const near = warpKeys.find((k) => Math.abs(k.time - srcT) < 0.25);
    if (near) near.speed = speed;
    else warpKeys.push({ time: srcT, speed });
    remapForWarpChange(oldWarp, warpKeys);
    renderWarpChips();
    void reclean();
  });

  const rangeChipsEl = document.getElementById("rangeChips") as HTMLDivElement;
  function renderRangeChips() {
    rangeChipsEl.innerHTML = "";
    for (const r of rangeSmooths) {
      const chip = document.createElement("span");
      chip.className = "rig-key";
      const label = document.createElement("button");
      label.textContent = `${fmtTime(r.t0)}–${fmtTime(r.t1)} @ ${r.cutoffHz} Hz`;
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Remove this smoothing pass";
      del.addEventListener("click", () => {
        pushHistory();
        rangeSmooths.splice(rangeSmooths.indexOf(r), 1);
        renderRangeChips();
        void reclean();
      });
      chip.append(label, del);
      rangeChipsEl.appendChild(chip);
    }
  }
  (document.getElementById("rangeAdd") as HTMLButtonElement).addEventListener("click", () => {
    const trim = transport?.getTrim();
    if (!trim || !loaded) return;
    if (trim.end - trim.start > loaded.display.duration - 0.05) {
      showError("Set the timeline trim handles around the section first. This smooths only that range.");
      return;
    }
    pushHistory();
    rangeSmooths.push({ t0: trim.start, t1: trim.end, cutoffHz: Number(cutoff.value) });
    renderRangeChips();
    void reclean();
  });

  // ---- scoped filter stack (Stage 3) --------------------------------------
  const filterTypeSel = document.getElementById("filterType") as HTMLSelectElement;
  const filterParamEl = document.getElementById("filterParam") as HTMLInputElement;
  const filterUnitEl = document.getElementById("filterUnit") as HTMLSpanElement;
  const filterAddBtn = document.getElementById("filterAdd") as HTMLButtonElement;
  const filterHintEl = document.getElementById("filterHint") as HTMLParagraphElement;
  const filterListEl = document.getElementById("filterList") as HTMLDivElement;
  const FILTER_COLOR: Record<CleanFilter, string> = { butterworth: "#b48cff", smooth: "#6bb1ff", despike: "#ffb020", reduce: "#59d0a0" };
  const FILTER_DEFAULT: Record<CleanFilter, { value: number; unit: string; step: number; min: number }> = {
    butterworth: { value: 5, unit: "Hz", step: 0.5, min: 0.5 },
    smooth: { value: 5, unit: "frames", step: 1, min: 1 },
    despike: { value: 35, unit: "°", step: 5, min: 5 },
    reduce: { value: 1, unit: "°", step: 0.25, min: 0.1 },
  };
  function syncFilterParamUi() {
    const d = FILTER_DEFAULT[filterTypeSel.value as CleanFilter];
    filterParamEl.value = String(d.value);
    filterParamEl.step = String(d.step);
    filterParamEl.min = String(d.min);
    filterUnitEl.textContent = d.unit;
  }
  syncFilterParamUi();
  filterTypeSel.addEventListener("change", syncFilterParamUi);

  function opParams(filter: CleanFilter, value: number): CleanOp["params"] {
    if (filter === "butterworth") return { cutoffHz: value };
    if (filter === "smooth") return { widthFrames: value };
    if (filter === "reduce") return { toleranceDeg: value };
    return { thresholdDeg: value };
  }
  function opLabel(op: CleanOp): string {
    const v = op.params.cutoffHz ?? op.params.widthFrames ?? op.params.thresholdDeg ?? op.params.toleranceDeg ?? 0;
    const unit = FILTER_DEFAULT[op.filter].unit;
    return `${op.filter} ${v}${unit === "°" ? "°" : ` ${unit}`}`;
  }

  const PLANT_COLOR = { Left: "#3fc1ff", Right: "#ffa24a" } as const;

  /** Colored underlines: scoped filters (top lanes) + foot plants (bottom). */
  function refreshTimelineRanges() {
    const rs = cleanOps
      .filter((o) => o.enabled)
      .map((o, i) => ({ t0: o.range.t0, t1: o.range.t1, color: FILTER_COLOR[o.filter], lane: i % 3 }));
    // Foot plants on a dedicated lane so they never collide with filters.
    for (const p of currentPlants) rs.push({ t0: p.t0, t1: p.t1, color: PLANT_COLOR[p.side], lane: 4 });
    transport?.setRanges(rs);
  }

  const plantHintEl = document.getElementById("plantHint") as HTMLParagraphElement;
  const plantListEl = document.getElementById("plantList") as HTMLDivElement;
  /** Chips for the detected foot plants; × removes one (per-plant control). */
  function renderPlants() {
    plantListEl.innerHTML = "";
    const show = fixFeetChk.checked && currentPlants.length > 0;
    plantHintEl.hidden = !show;
    if (!show) return;
    for (const p of [...currentPlants].sort((a, b) => a.t0 - b.t0)) {
      const chip = document.createElement("span");
      chip.className = "rig-key";
      const label = document.createElement("button");
      label.textContent = `${p.side[0]} ${fmtTime(p.t0)}–${fmtTime(p.t1)}`;
      label.style.color = PLANT_COLOR[p.side];
      label.title = "Zoom the timeline to this plant";
      label.addEventListener("click", () => transport?.getTimeMap().fit(p.t0, p.t1));
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Stop pinning this plant";
      del.addEventListener("click", () => {
        pushHistory();
        // Record the removal so re-detection keeps it (overlap match).
        feetPlantRemoved.push({ side: p.side, t0: p.t0 - 0.02, t1: p.t1 + 0.02 });
        void reclean();
      });
      chip.append(label, del);
      plantListEl.appendChild(chip);
    }
  }

  // Reassign the forward-declared stub with the real renderer.
  renderFilters = () => {
    filterListEl.innerHTML = "";
    for (const op of cleanOps) {
      const row = document.createElement("span");
      row.className = "rig-key";
      const en = document.createElement("input");
      en.type = "checkbox";
      en.checked = op.enabled;
      en.title = "Enable/disable this filter";
      en.addEventListener("change", () => { pushHistory(); op.enabled = en.checked; void reclean(); renderFilters(); });
      const label = document.createElement("button");
      label.textContent = `${opLabel(op)} · ${op.bones.length} bone${op.bones.length === 1 ? "" : "s"} · ${fmtTime(op.range.t0)}–${fmtTime(op.range.t1)}`;
      label.title = "Click to zoom the timeline to this filter's range";
      label.style.color = FILTER_COLOR[op.filter];
      label.addEventListener("click", () => { transport?.getTimeMap().fit(op.range.t0, op.range.t1); });
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Delete this filter";
      del.addEventListener("click", () => {
        pushHistory();
        cleanOps.splice(cleanOps.indexOf(op), 1);
        renderFilters();
        void reclean();
      });
      row.append(en, label, del);
      filterListEl.appendChild(row);
    }
    refreshTimelineRanges();
  };

  // ---- key reduction analysis (Stage 4) -----------------------------------
  const redBody = document.getElementById("redBody") as HTMLInputElement;
  const redBodyVal = document.getElementById("redBodyVal") as HTMLOutputElement;
  const redFinger = document.getElementById("redFinger") as HTMLInputElement;
  const redFingerVal = document.getElementById("redFingerVal") as HTMLOutputElement;
  const reduceStatsEl = document.getElementById("reduceStats") as HTMLDivElement;
  redBody.addEventListener("input", () => { redBodyVal.value = `${redBody.value}°`; });
  redFinger.addEventListener("input", () => { redFingerVal.value = `${redFinger.value}°`; });
  (document.getElementById("reduceAnalyze") as HTMLButtonElement).addEventListener("click", () => {
    if (!loaded) return;
    const flat = buildChannelGroups(new Set(loaded.display.names)).map((g) => ({ label: g.label, bones: groupBones(g) }));
    const rows = analyzeReduction(loaded.display, flat, Number(redBody.value), Number(redFinger.value));
    let before = 0, after = 0;
    for (const r of rows) { before += r.before; after += r.after; }
    const pctDrop = before ? Math.round((1 - after / before) * 100) : 0;
    const table = rows
      .map((r) => `<div><dt>${r.label}</dt><dd>${r.after.toLocaleString()} / ${r.before.toLocaleString()} (−${before ? Math.round((1 - r.after / r.before) * 100) : 0}%)</dd></div>`)
      .join("");
    reduceStatsEl.innerHTML =
      `<dl class="stats reduce-table">${table}` +
      `<div><dt><b>Total</b></dt><dd><b>${after.toLocaleString()} / ${before.toLocaleString()} keys (−${pctDrop}%)</b></dd></div></dl>` +
      `<p class="hint">Estimate at ${redBody.value}° body / ${redFinger.value}° finger. To apply, add a "Key reduce" filter (Filters section) scoped to the bones + range you want.</p>`;
  });

  filterAddBtn.addEventListener("click", () => {
    const trim = transport?.getTrim();
    if (!trim || !loaded) return;
    if (!channelSelection.size) {
      showError("Select the bones first: open the Rig timeline's Channels view and pick channels (a group or single fingers).");
      return;
    }
    if (trim.end - trim.start > loaded.display.duration - 0.05) {
      filterHintEl.textContent = "Tip: set the trim handles around a section to scope the filter tighter.";
    } else {
      filterHintEl.textContent = "";
    }
    const filter = filterTypeSel.value as CleanFilter;
    const value = Number(filterParamEl.value);
    pushHistory();
    cleanOps.push({
      id: `op${Date.now().toString(36)}`,
      bones: [...channelSelection],
      range: { t0: trim.start, t1: trim.end },
      filter,
      params: opParams(filter, value),
      enabled: true,
    });
    renderFilters();
    void reclean();
  });

  (document.getElementById("rigReduce") as HTMLButtonElement).addEventListener("click", () => {
    const layer = rigLayers[activeLayerIdx];
    const tr = layer && selectedEffector ? getTrack(layer, selectedEffector) : null;
    if (!tr || !layer) return;
    pushHistory();
    const n = reduceKeys(tr);
    rigSelEl.textContent = `Reduced: ${n} key${n === 1 ? "" : "s"} removed.`;
    rebakeRig();
    if (n) setTimeout(() => updateRigEditor(), 600);
    else updateRigEditor();
  });

  /** Sync every adjustment control from state (cache restore / undo). */
  function syncAdjustUi() {
    syncModSliders();
    modMirror.checked = mods.mirror;
    for (const r of reachInputs) {
      r.el.value = String(Math.round(mods.reach[r.key] * 100));
      r.out.value = `${r.el.value}%`;
    }
    renderWarpChips();
    renderRangeChips();
  }

  function doResetModifiers() {
    const dirty = modInputs.some((m) => mods[m.key] !== 0) || mods.mirror || anyReach(mods) || warpKeys.length || rangeSmooths.length;
    if (!dirty) return;
    pushHistory();
    const oldWarp = warpKeys.map((k) => ({ ...k }));
    Object.assign(mods, defaultModifiers());
    warpKeys.length = 0;
    rangeSmooths.length = 0;
    remapForWarpChange(oldWarp, warpKeys); // layer keys back onto the unwarped timeline
    syncAdjustUi();
    void reclean();
  }
  (document.getElementById("modReset") as HTMLButtonElement).addEventListener("click", doResetModifiers);

  despikeVal.value = `${despikeDeg.value}°`;
  cutoffVal.value = `${cutoff.value} Hz`;
  despikeDeg.addEventListener("input", () => { despikeVal.value = `${despikeDeg.value}°`; });
  cutoff.addEventListener("input", () => { cutoffVal.value = `${cutoff.value} Hz`; });
  // Pipeline controls change the motion, so they push undo like rig edits do.
  const recleanWithHistory = () => { pushPipelineHistory(); void reclean(); };
  for (const c of [despikeChk, smoothChk, limitWristsChk, limitLowerArmsChk, fixFeetChk, distSpineChk]) c.addEventListener("change", recleanWithHistory);
  for (const r of [despikeDeg, cutoff, distSpineAmt]) r.addEventListener("change", recleanWithHistory);
  distSpineAmtVal.value = `${distSpineAmt.value}%`;
  distSpineAmt.addEventListener("input", () => { distSpineAmtVal.value = `${distSpineAmt.value}%`; });
  distSpineChk.addEventListener("change", () => { distSpineAmt.disabled = !distSpineChk.checked; });
  propSel.addEventListener("change", recleanWithHistory);
  lockWristsSel.addEventListener("change", recleanWithHistory);
  lockLowerArmSel.addEventListener("change", recleanWithHistory);

  const bodyFile = document.getElementById("bodyfile") as HTMLInputElement;
  let lastBodyChoice = bodySel.value;
  bodySel.addEventListener("change", () => {
    if (bodySel.value === "vrm") {
      bodyFile.click(); // async; handled below
      return;
    }
    lastBodyChoice = bodySel.value;
    userBodyBytes = null;
    syncShogunRow();
    void setBodySource(null).then(() => {
      preview?.setBodyMode(bodySel.value === "none" ? "none" : "human");
      preview?.setFaceVisible(true);
      preview?.refreshBody();
      if (propSel.value === "body") void reclean();
    });
  });
  /** Load a VRM/GLB as the live session's body (file picker or dropped file). */
  async function applyBodyBytes(fileName: string, bytes: ArrayBuffer) {
    try {
      const mapped = await setBodySource(bytes);
      userBodyBytes = { name: fileName, data: bytes };
      bodySel.value = "vrm";
      lastBodyChoice = "vrm";
      syncShogunRow();
      preview?.setBodyMode("human");
      preview?.setFaceVisible(false); // the VRM keeps its own head
      preview?.refreshBody();
      if (propSel.value === "body") await reclean();
      if (mapped === 0) {
        showError(`${fileName}: no VRM humanoid mapping found, falling back to bone-name matching.`);
      }
    } catch (err) {
      bodySel.value = lastBodyChoice;
      await setBodySource(null);
      preview?.setFaceVisible(true);
      showError(err instanceof Error ? err.message : String(err));
    }
  }
  bodyFile.addEventListener("change", async () => {
    const file = bodyFile.files?.[0];
    bodyFile.value = "";
    if (!file) {
      bodySel.value = lastBodyChoice; // cancelled
      return;
    }
    await applyBodyBytes(file.name, await file.arrayBuffer());
  });

  // ---- Shogun target-rig export -------------------------------------------
  // Static skeleton + skinned mesh from the loaded VRM body, for a Vicon Shogun
  // retarget target. Consumes the raw VRM bytes; unrelated to the clip.
  const shogunStripChk = document.getElementById("shogunStrip") as HTMLInputElement;
  const shogunDlBtn = document.getElementById("shogunDl") as HTMLButtonElement;
  const shogunNote = document.getElementById("shogunNote") as HTMLParagraphElement;
  function syncShogunRow() {
    const ok = !!userBodyBytes && isVrmBody(userBodyBytes.data);
    shogunDlBtn.disabled = !ok;
    if (ok) {
      shogunNote.textContent = `Ready from ${userBodyBytes!.name}.`;
    } else if (userBodyBytes) {
      shogunNote.textContent = "The loaded body has no VRM data. Load a .vrm body to export a Shogun rig.";
    } else {
      shogunNote.textContent = "Load your VRM body (Body mesh: Your VRM / GLB) to enable this.";
    }
  }
  shogunDlBtn.addEventListener("click", async () => {
    if (!userBodyBytes || !isVrmBody(userBodyBytes.data)) {
      syncShogunRow();
      return;
    }
    shogunDlBtn.disabled = true;
    shogunDlBtn.textContent = "Generating…";
    await new Promise((r) => setTimeout(r, 16));
    try {
      const res = await exportShogunFbx(userBodyBytes.data, { stripSprings: shogunStripChk.checked });
      downloadBytes(`${outBase()}-shogun.fbx`, new TextEncoder().encode(res.fbx));
      const stripped = res.strippedSprings ? `, ${res.springBoneCount} spring bones stripped` : "";
      shogunNote.textContent = `Exported ${res.boneCount} bones${stripped}.`;
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      shogunDlBtn.textContent = "Shogun target rig (.fbx)";
      syncShogunRow();
    }
  });
  syncShogunRow();

  // ---- rig persistence -----------------------------------------------------
  // Auto-saved to localStorage per recording; also exportable as a .rig.json.
  const rigCacheKey = `wanimrig:${loaded?.name}:${converted.times.length}`;
  const rigCacheNote = document.getElementById("rigCacheNote") as HTMLParagraphElement;

  function saveRigCache() {
    if (!getPref("autosave")) return; // preference: don't persist edits
    try {
      const dirty =
        rigLayers.length ||
        warpKeys.length ||
        rangeSmooths.length ||
        cleanOps.length ||
        feetPlantRemoved.length ||
        JSON.stringify(mods) !== JSON.stringify(defaultModifiers());
      if (dirty) {
        localStorage.setItem(
          rigCacheKey,
          JSON.stringify({
            v: 3, layers: rigLayers, mods, counter: layerCounter, warp: warpKeys, ranges: rangeSmooths,
            cleanOps, feetPlants: feetPlantRemoved, pins: [...pinnedEffectors], fk: [...fkLimbs], ikfk: { ...ikfk },
            settings: sceneSettings(),
          }),
        );
      } else {
        localStorage.removeItem(rigCacheKey);
      }
    } catch { /* quota/private mode — silently skip */ }
  }

  /** Replace the rig state wholesale (cache restore / file load). */
  function adoptRigState(d: {
    layers?: RigLayer[];
    mods?: Partial<ReturnType<typeof defaultModifiers>>;
    counter?: number;
    warp?: WarpKey[];
    ranges?: RangeSmooth[];
    cleanOps?: CleanOp[];
    feetPlants?: PlantSpan[];
    pins?: EffectorId[];
    fk?: EffectorId[];
    ikfk?: Partial<IkfkBlend>;
  }) {
    pinnedEffectors.clear();
    for (const p of d.pins ?? []) pinnedEffectors.add(p);
    fkLimbs.clear();
    for (const p of d.fk ?? []) fkLimbs.add(p);
    Object.assign(ikfk, defaultIkfkBlend(), d.ikfk ?? {}); // older files default to IK
    preview?.setPinned(pinnedEffectors);
    preview?.setFkOnlyLimbs(fkOnlyEffectors());
    // v3 moved keys from effector-space to bone-local tracks; older layer
    // keys can't be converted meaningfully — drop them (mods/warp/ranges keep).
    const layers = Array.isArray(d.layers)
      ? d.layers.filter((l) => (l.tracks ?? []).every((tr) => typeof (tr as { bone?: unknown }).bone === "string"))
      : [];
    if (Array.isArray(d.layers) && layers.length < d.layers.length) {
      rigCacheNote.textContent = "Rig keys from an older version couldn't be kept (key format changed in v0.26).";
    }
    rigLayers.splice(0, rigLayers.length, ...layers);
    for (const layer of rigLayers) {
      // Older saves may predate newer layer fields.
      layer.extent ??= "hold";
      layer.fadeS ??= 0.5;
    }
    Object.assign(mods, defaultModifiers(), d.mods ?? {});
    warpKeys.splice(0, warpKeys.length, ...(d.warp ?? []));
    rangeSmooths.splice(0, rangeSmooths.length, ...(d.ranges ?? []));
    cleanOps.splice(0, cleanOps.length, ...(d.cleanOps ?? []));
    feetPlantRemoved.splice(0, feetPlantRemoved.length, ...(d.feetPlants ?? []));
    layerCounter = d.counter ?? rigLayers.length;
    activeLayerIdx = rigLayers.length - 1;
    pickedKeys = [];
    syncAdjustUi();
    syncIkfkUi();
    renderFilters();
    renderRigLayers();
  }

  try {
    const saved = localStorage.getItem(rigCacheKey);
    if (saved) {
      const d = JSON.parse(saved) as {
        layers?: RigLayer[];
        mods?: ReturnType<typeof defaultModifiers>;
        counter?: number;
        warp?: WarpKey[];
        ranges?: RangeSmooth[];
        settings?: Record<string, unknown>;
      };
      if (
        d.layers?.length ||
        d.warp?.length ||
        d.ranges?.length ||
        (d.mods && JSON.stringify({ ...defaultModifiers(), ...d.mods }) !== JSON.stringify(defaultModifiers()))
      ) {
        adoptRigState(d);
        applyScene(d.settings);
        rigCacheNote.textContent = "Restored saved edits for this recording.";
      }
    }
  } catch { /* corrupt cache — start clean */ }

  // Session auto-restore note (once): the boot reopened the last recording.
  if (restoredSessionName) {
    restoredSessionName = null;
    rigCacheNote.textContent =
      `Reopened your last session${rigCacheNote.textContent ? ", edits restored" : ""}. ` +
      `"Load another file" (Info tab) closes it.`;
  }

  (document.getElementById("rigSave") as HTMLButtonElement).addEventListener("click", () => {
    if (!loaded) return;
    const json = JSON.stringify(
      { v: 3, layers: rigLayers, mods, counter: layerCounter, warp: warpKeys, ranges: rangeSmooths, cleanOps, feetPlants: feetPlantRemoved, pins: [...pinnedEffectors], fk: [...fkLimbs], ikfk: { ...ikfk } },
      null,
      1,
    );
    downloadBytes(`${sanitizeFilename(loaded.name)}.rig.json`, new TextEncoder().encode(json));
  });
  const rigFile = document.getElementById("rigFile") as HTMLInputElement;
  (document.getElementById("rigLoadBtn") as HTMLButtonElement).addEventListener("click", () => rigFile.click());
  rigFile.addEventListener("change", async () => {
    const file = rigFile.files?.[0];
    rigFile.value = "";
    if (!file) return;
    try {
      const d = JSON.parse(await file.text()) as { layers?: RigLayer[]; mods?: ReturnType<typeof defaultModifiers>; counter?: number };
      if (!Array.isArray(d.layers)) throw new Error("not a rig file (missing layers)");
      pushHistory();
      adoptRigState(d);
      rigCacheNote.textContent = `Loaded ${file.name}.`;
      await reclean(); // modifiers may have changed too
    } catch (err) {
      showError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- scene save / restore -------------------------------------------------
  /** Everything outside the rig state worth restoring in a session. */
  function sceneSettings(): Record<string, unknown> {
    return {
      clean: cleanOpts(),
      fps: fpsSel.value,
      names: namesSel.value,
      rest: restSel.value,
      proportions: propSel.value,
      distSpine: distSpineChk.checked,
      distSpineAmt: distSpineAmt.value,
      face: faceChk.checked,
      body: bodySel.value, // 'vrm' restores from the scene's embedded body
      trim: transport?.getTrim(),
      time: preview?.getTime() ?? 0,
      markers: sceneMarkers,
    };
  }

  function applyScene(s?: Record<string, unknown>) {
    if (!s) return;
    applyCleanUi((s.clean ?? {}) as CleanOpts);
    if (s.fps) fpsSel.value = String(s.fps);
    if (typeof s.names === "string") namesSel.value = s.names;
    if (typeof s.rest === "string") restSel.value = s.rest;
    if (typeof s.proportions === "string") propSel.value = s.proportions;
    distSpineChk.checked = !!s.distSpine;
    distSpineAmt.disabled = !distSpineChk.checked;
    if (s.distSpineAmt) { distSpineAmt.value = String(s.distSpineAmt); distSpineAmtVal.value = `${distSpineAmt.value}%`; }
    if (typeof s.face === "boolean" && !faceChk.disabled) faceChk.checked = s.face;
    if (typeof s.body === "string" && s.body !== "vrm") {
      // 'vrm' is handled by the embedded-body restore path.
      bodySel.value = s.body;
      preview?.setBodyMode(s.body === "none" ? "none" : "human");
    }
    if (Array.isArray(s.markers)) {
      sceneMarkers = (s.markers as Marker[]).filter((m) => typeof m?.time === "number");
      transport?.setMarkers(sceneMarkers);
    }
    prevPipelineJson = JSON.stringify(pipelineSettings());
    // Trim + playhead apply AFTER the coming reclean: a scene with a time
    // warp rebuilds the transport (which resets trim), so restoring here
    // would be clamped against the wrong duration and then thrown away.
    const trim = s.trim as { start: number; end: number } | undefined;
    const time = typeof s.time === "number" ? s.time : undefined;
    if (trim || time !== undefined) pendingViewRestore = { trim, time, pause: true };
  }

  /** One button, whole work project: recording + edits + settings + assets. */
  function saveScene(baseName?: string, forcePicker = false) {
    if (!loaded) return;
    const rawB64 = bytesToBase64(new Uint8Array(loaded.raw));
    const scene: SceneFile = {
      magic: "wanimscene",
      v: 4,
      name: loaded.name,
      source: loaded.source,
      settings: sceneSettings(),
      rig: { v: 3, layers: rigLayers, mods, counter: layerCounter, warp: warpKeys, ranges: rangeSmooths, cleanOps, feetPlants: feetPlantRemoved, pins: [...pinnedEffectors], fk: [...fkLimbs], ikfk: { ...ikfk } },
      // The original source bytes, so the project reopens byte-for-byte.
      wanim: loaded.source === "wanim" ? rawB64 : undefined,
      fbx: loaded.source === "fbx" ? rawB64 : undefined,
      // Embed the custom body so the project is fully self-contained.
      body: userBodyBytes
        ? { name: userBodyBytes.name, data: bytesToBase64(new Uint8Array(userBodyBytes.data)) }
        : undefined,
    };
    const base = sanitizeFilename(baseName || loaded.name) || "scene";
    const bytes = new TextEncoder().encode(JSON.stringify(scene));
    // Handle-aware save: re-saves to the held handle (Ctrl+S), prompts when
    // there's none, or downloads when the FS Access API is unavailable.
    void recent.saveScene(`${base}.scene.json`, bytes, forcePicker);
  }
  function saveSceneAs() {
    if (!loaded) return;
    // Force a fresh save-file picker (or, unsupported, a plain download with a
    // prompted name).
    if (recent.supported()) { saveScene(undefined, true); return; }
    const name = prompt("Save scene as (file name):", sanitizeFilename(loaded.name));
    if (name === null) return;
    saveScene(name);
  }
  (document.getElementById("sceneSave") as HTMLButtonElement).addEventListener("click", () => saveScene());

  function wireTransportScene() {
    // Load/Save now live in the File menu; the transport just keeps markers +
    // channels wired (this runs again after a warp-duration transport rebuild).
    transport?.setMarkers(sceneMarkers);
    transport?.onMarkersChange((m) => { sceneMarkers = m; saveRigCache(); });
    wireChannels();
  }

  // ---- Channels mode (dense f-curve view) ---------------------------------
  const channelsConfig: ChannelsConfig = {
    groups: buildChannelGroups(new Set(converted.names)),
    provider: (bones) => denseChannelsFor(loaded?.display ?? converted, bones),
    compareProvider: (bones) => (compareBase ? denseChannelsFor(compareBase, bones) : null),
    onSelect: (bones) => {
      channelSelection = bones;
      // Single mapped bone -> select its viewport effector (two-way sync). This
      // is how per-finger FK works: a finger row selects its (hidden) effector,
      // which pops the gizmo on that finger chain.
      if (activeTab === "rig") {
        if (bones.size === 1) {
          const eff = effectorForBone([...bones][0]);
          if (eff) preview?.selectEffector(eff.id);
        } else if (selectedEffector && effectorDef(selectedEffector).hidden) {
          // Leaving a single finger row: drop the transient finger gizmo.
          preview?.selectEffector(null);
        }
      }
      renderFilters();
    },
    onSeek: (t) => { preview?.pause(); preview?.seek(t); },
  };
  function wireChannels() {
    transport?.setChannels(channelsConfig);
  }
  wireTransportScene();

  // A dropped scene file restores rig + settings over the freshly loaded clip.
  if (pendingScene) {
    const sc = pendingScene;
    pendingScene = null;
    adoptRigState((sc.rig ?? {}) as Parameters<typeof adoptRigState>[0]);
    applyScene(sc.settings);
    rigCacheNote.textContent = "Scene restored.";
    if (sc.body?.data) {
      // Restore the embedded custom body asynchronously, then refresh.
      const bodyInfo = sc.body;
      void (async () => {
        try {
          const bytes = base64ToBytes(bodyInfo.data);
          await setBodySource(bytes.buffer as ArrayBuffer);
          userBodyBytes = { name: bodyInfo.name, data: bytes.buffer as ArrayBuffer };
          lastBodyChoice = "vrm";
          bodySel.value = "vrm";
          syncShogunRow();
          preview?.setBodyMode("human");
          preview?.setFaceVisible(false);
          preview?.refreshBody();
          if (propSel.value === "body") await reclean();
        } catch (err) {
          showError(`Embedded body ${bodyInfo.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
  } else if (pendingBody) {
    // Upgraded from a body-only session: keep the loaded body in place.
    const carried = pendingBody;
    pendingBody = null;
    userBodyBytes = carried;
    lastBodyChoice = "vrm";
    bodySel.value = "vrm";
    syncShogunRow();
    preview?.setBodyMode("human");
    preview?.setFaceVisible(false);
    preview?.refreshBody();
    if (propSel.value === "body") void reclean();
  } else {
    userBodyBytes = null; // fresh recording — no custom body yet
  }

  // FBX take picker: a small select in the editbar when the file has more than
  // one motion take (ours always ships anim + TPose, but TPose is filtered).
  if (pendingFbxTakes && pendingFbxTakes.names.length > 1) {
    const takes = pendingFbxTakes;
    pendingFbxTakes = null;
    const sel = document.createElement("select");
    sel.id = "fbxTake";
    sel.title = "Which FBX take to edit";
    sel.className = "eb-name";
    takes.names.forEach((n, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = n;
      if (i === takes.active) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => takes.onPick(Number(sel.value)));
    editbar.querySelector(".eb-spacer")?.before(sel);
  } else {
    pendingFbxTakes = null;
  }

  // Auto-build the rig: an empty Layer 1 so the control rig works with zero
  // clicks (unless saved state already brought its own layers).
  ensureLayer();

  // Apply the default proportions selection (body-mesh skeleton) on load.
  void reclean();

  const formatSel = document.getElementById("format") as HTMLSelectElement;
  const outNameEl = document.getElementById("outName") as HTMLInputElement;
  outNameEl.value = `${sanitizeFilename(name)}_cleaned`;
  /** Export base name — the user names the output so "which one is cleaned" stays obvious. */
  const outBase = () => sanitizeFilename(outNameEl.value.trim()) || `${sanitizeFilename(loaded?.name ?? "export")}_cleaned`;
  async function doExport(format: string) {
    if (!loaded) return;
    if (format === "shogun") { shogunDlBtn.click(); return; }
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Generating…";
    await new Promise((r) => setTimeout(r, 16));
    try {
      const fps = Number(fpsSel.value);
      const trim = transport?.getTrim() ?? { start: 0, end: loaded.display.duration };
      if (format === "wanim") {
        // Re-export the cleaned recording as .wanim for re-import into Warudo.
        // Uses the RECORDED proportions (the body-mesh retarget is a mesh-fit
        // concern with no meaning in a .wanim) plus the cleaning + spine
        // changes; hips keep full motion and the character root stays identity.
        const warpedSrc = applyTimeWarp(loaded.converted, warpKeys);
        let clip = cleanClip(warpedSrc, cleanOpts());
        for (const r of rangeSmooths) clip = smoothRange(clip, r);
        clip = applyCleanOps(clip, cleanOps);
        if (distSpineChk.checked) clip = distributeBonelessSpine(clip, Number(distSpineAmt.value) / 100);
        // Modifiers + rig layers bake here too. Additive deltas transfer
        // cleanly; override targets were authored on the display proportions,
        // so on the recorded skeleton they land approximately.
        clip = applyModifiers(clip, mods);
        if (anyReach(mods)) {
          let raw = warpedSrc;
          if (distSpineChk.checked) raw = distributeBonelessSpine(raw, Number(distSpineAmt.value) / 100);
          clip = applyReach(clip, applyModifiers(raw, mods), mods);
        }
        clip = applyRigLayers(clip, rigLayers);
        const rs = resample(clip, fps, trim.start, trim.end);
        const { writeWanim } = await import("./wanim/writeWanim.ts");
        downloadBytes(`${outBase()}.wanim`, writeWanim(rs, loaded.clip));
      } else {
      const resampled = resample(loaded.display, fps, trim.start, trim.end);
      if (format === "vrma") {
        // Original ARKit tracks become custom expressions; the synthesized
        // preset tracks (A/Blink/Look_*) fill the VRM presets.
        const augFace =
          faceChk.checked && resampled.face ? augmentFaceForVrm(resampled.face) : undefined;
        const { writeVrma } = await import("./vrma/writeVrma.ts");
        const vrma = writeVrma(resampled, augFace);
        downloadBytes(`${outBase()}.vrma`, vrma);
      } else {
        const names = remapNames(resampled.names, namesSel.value as NameScheme);
        const meshes: SkinnedMeshExport[] = [];
        // A user VRM keeps its own head, so the facecap Face mesh is omitted.
        if (faceChk.checked && resampled.face && !hasUserBody()) {
          const mesh = await loadFaceMeshData();
          meshes.push(buildFaceMesh(resampled, mesh));
        }
        if (bodySel.value !== "none") {
          // Recorded ARKit tracks + synthesized VRM-preset tracks, so both
          // perfect-sync and standard VRMs get facial animation.
          const augFace =
            faceChk.checked && resampled.face ? augmentFaceForVrm(resampled.face) : undefined;
          const body = await buildBodyData(
            resampled.parents,
            resampled.bindPos,
            resampled.names,
            augFace?.names,
          );
          meshes.push(...bodyToSkinnedMeshExports(body.meshes, augFace));
        }
        const fbx = writeAnimationFbx(resampled, {
          takeName: outBase(),
          names,
          tposeRest: restSel.value === "tpose",
          meshes,
        });
        downloadBytes(`${outBase()}.fbx`, fbx);
      }
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Download";
    }
  }
  downloadBtn.addEventListener("click", () => { void doExport(formatSel.value); });

  // Expose this panel's actions to the (persistent) menu bar.
  menuActions = {
    saveScene: () => saveScene(),
    saveSceneAs,
    export: (fmt) => { void doExport(fmt); },
    openBody: () => bodyFile.click(),
    loadBodyBytes: (fileName, data) => applyBodyBytes(fileName, data),
    shogunReady: () => !!userBodyBytes && isVrmBody(userBodyBytes.data),
    undo: rigUndo,
    redo: rigRedo,
    copy: copyPicked,
    paste: pastePicked,
    del: deletePicked,
    keyPose: doKeyPose,
    resetModifiers: doResetModifiers,
    setDockTab: (t) => setTab(t),
    cyclePanels: () => transport?.cyclePanel(),
    toggleGhost: () => ghostBtn.click(),
    ghostOn: () => ghostOn,
    toggleCompareLock,
    compareLocked: () => compareLocked,
  };

  resetBtn.addEventListener("click", () => {
    errorEl.hidden = true;
    showEmptyEditor();
    // Explicitly closing the session — a reload shouldn't resurrect it.
    void clearLastSession();
  });
}

/**
 * The editor with no recording (boot state and where "Load another file"
 * returns): the viewport grid is orbitable behind a single dim prompt line,
 * the dock shows its four tabs each with an empty note, and the transport is a
 * disabled placeholder. Everything is opened from the File menu / Ctrl+O / a
 * drop, so there's no button here.
 */
function showEmptyEditor() {
  loaded = null;
  rigHotkeys = null;
  transportHotkeys = null;
  menuActions = null;
  transport?.dispose();
  transport = null;
  preview?.clear();
  emptyState.hidden = false;
  editbar.innerHTML = `<span class="eb-hint">Nothing loaded. Open a recording or a VRM/FBX from File, or press Ctrl+O</span>`;
  const emptyTabs: [string, string, string][] = [
    ["clean", "Clean", "Open a recording to clean up its motion."],
    ["rig", "Rig", "Open a recording to pose and layer edits."],
    ["export", "Export", "Open a recording, or a VRM/GLB body for a Shogun target rig."],
    ["info", "Info", "Open a <code>.wanim</code>/<code>.fbx</code>, a VRM/GLB body, or a saved <code>.scene.json</code>."],
  ];
  dock.innerHTML = `
    <nav class="dock-tabs" role="tablist">
      ${emptyTabs.map(([id, label], i) => `<button class="dock-tab${i === 0 ? " active" : ""}" data-tab="${id}">${label}</button>`).join("")}
    </nav>
    <div class="dock-body">
      ${emptyTabs.map(([id, , note], i) => `<div class="tab${i === 0 ? " active" : ""}" id="tab-${id}"><p class="note">${note}</p></div>`).join("")}
    </div>
  `;
  const emptyTabBtns = Array.from(dock.querySelectorAll<HTMLButtonElement>(".dock-tab"));
  for (const b of emptyTabBtns) {
    b.addEventListener("click", () => {
      for (const x of emptyTabBtns) x.classList.toggle("active", x === b);
      for (const el of dock.querySelectorAll(".tab")) el.classList.toggle("active", el.id === `tab-${b.dataset.tab}`);
    });
  }
  // Disabled placeholder transport so the timeline dock reads as "present but
  // inert" until a clip loads (createTransport replaces it on load).
  timelineDock.innerHTML = `
    <div class="transport-overlay disabled" aria-disabled="true">
      <div class="t-main">
        <button class="t-btn t-play" disabled aria-label="Play/pause">${ICONS.play}</button>
        <div class="t-timeline" aria-disabled="true"></div>
        <span class="t-time">0:00.00 / 0:00.00</span>
      </div>
    </div>
  `;
}

/** Set the moment the user opens anything — cancels the boot auto-restore. */
let userOpenedFile = false;
/** Name of the auto-reopened recording (buildPanel shows a note once). */
let restoredSessionName: string | null = null;

async function handleFile(file: File) {
  // Preference: confirm before dropping the current session for a new file
  // (edits stay cached per recording, so nothing is truly lost). A VRM/GLB
  // dropped onto a live session just swaps the body, so it never prompts.
  const lower = file.name.toLowerCase();
  const isBodyAsset = lower.endsWith(".vrm") || lower.endsWith(".glb");
  if (loaded && !isBodyAsset && getPref("confirmReplace") &&
      !window.confirm("Open a different file? Your edits stay saved for the current recording.")) {
    return;
  }
  userOpenedFile = true;
  errorEl.hidden = true;
  if (lower.endsWith(".json")) {
    await loadScene(file);
    return;
  }
  if (lower.endsWith(".wanim")) {
    // Dropping a recording onto a body-only session upgrades in place, keeping
    // the loaded body (setBodySource holds it; buildPanel re-adopts it).
    if (bodyPanel && userBodyBytes) pendingBody = userBodyBytes;
    await loadWanim(file.name, await file.arrayBuffer());
    return;
  }
  if (lower.endsWith(".fbx")) {
    if (bodyPanel && userBodyBytes) pendingBody = userBodyBytes;
    await loadFbx(file.name, await file.arrayBuffer());
    return;
  }
  if (isBodyAsset) {
    const bytes = await file.arrayBuffer();
    // Live session (recording or fbx): swap the body in place. No session yet:
    // start a body-only session.
    if (menuActions) await menuActions.loadBodyBytes(file.name, bytes);
    else await startBodyOnly(file.name, bytes);
    return;
  }
  showError(`"${file.name}" is not a .wanim, .fbx, .vrm/.glb, or saved .scene.json.`);
}

/** Load a saved scene (recording, fbx, or body-only), routed by its source. */
async function loadScene(file: File) {
  try {
    const scene = JSON.parse(await file.text()) as SceneFile;
    if (scene.magic !== "wanimscene") {
      throw new Error("not a scene file (drop a .wanim/.fbx or a saved .scene.json)");
    }
    const source = scene.source ?? "wanim";
    pendingScene = scene;
    if (source === "fbx") {
      if (typeof scene.fbx !== "string") throw new Error("scene is missing its FBX data");
      await loadFbx(scene.name || file.name.replace(/\.scene\.json$/i, ".fbx"), base64ToBytes(scene.fbx).buffer as ArrayBuffer);
    } else if (source === "body") {
      if (!scene.body?.data) throw new Error("scene is missing its body data");
      await startBodyOnly(scene.body.name || scene.name, base64ToBytes(scene.body.data).buffer as ArrayBuffer, scene);
    } else {
      if (typeof scene.wanim !== "string") throw new Error("scene is missing its recording data");
      await loadWanim(scene.name || file.name.replace(/\.scene\.json$/i, ".wanim"), base64ToBytes(scene.wanim).buffer as ArrayBuffer);
    }
  } catch (err) {
    pendingScene = null;
    showError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadWanim(name: string, raw: ArrayBuffer, fromRestore = false) {
  try {
    const clip = parseWanim(raw);
    if (clip.characters.length === 0) {
      showError("This recording contains no characters.");
      return;
    }
    const converted = convertCharacter(clip, 0);
    loaded = { name, clip, converted, source: "wanim", raw, display: converted };
    bodyPanel = null; // a recording session replaces any body-only session

    emptyState.hidden = true;

    if (!preview) preview = new PreviewScene(viewport);
    (window as unknown as { __preview?: PreviewScene }).__preview = preview; // test hook
    preview.setRate(getPref("playbackRate")); // review speed default from prefs
    preview.setClip(converted);

    transport?.dispose();
    timelineDock.innerHTML = ""; // drop the disabled empty-state placeholder
    transport = createTransport(preview, converted.duration, converted.times.length);
    transportDuration = converted.duration;
    timelineDock.appendChild(transport.element);

    buildPanel(name, clip, converted);
    // Remember the recording so the next visit reopens it, DCC style (the
    // edits already auto-save to localStorage keyed by this recording).
    if (!fromRestore) void saveLastSession(name, raw);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * A minimal WanimClip standing in for an FBX-sourced clip, so buildPanel and
 * the WANIM writer (which read blendshape names + version off the template)
 * work unchanged. Downstream ConvertedClip consumers never see this.
 */
function syntheticWanim(c: ConvertedClip): WanimClip {
  const blendshapes: Record<string, Record<string, number>[]> = {};
  if (c.face && c.face.names.length) {
    blendshapes.__ARKit__ = [Object.fromEntries(c.face.names.map((n) => [n, 0]))];
  }
  return {
    version: 2,
    times: c.times.slice(),
    characters: [{ bonePositions: [], boneRotations: [], blendshapes, rootPositions: [], rootRotations: [] }],
  };
}

/** Parsed FBX takes cached by raw bytes so the take picker doesn't re-parse. */
let fbxCache: { raw: ArrayBuffer; result: FbxImportResult } | null = null;

/** Import an FBX animation take as a full editing session. */
async function loadFbx(name: string, raw: ArrayBuffer, takeIndex = 0) {
  try {
    const result = fbxCache?.raw === raw ? fbxCache.result : importFbxAnimation(raw);
    fbxCache = { raw, result };
    const idx = Math.max(0, Math.min(takeIndex, result.takes.length - 1));
    const converted = result.takes[idx].clip;
    const synthetic = syntheticWanim(converted);
    loaded = { name, clip: synthetic, converted, source: "fbx", raw, display: converted };
    bodyPanel = null;

    emptyState.hidden = true;
    if (!preview) preview = new PreviewScene(viewport);
    (window as unknown as { __preview?: PreviewScene }).__preview = preview;
    preview.setRate(getPref("playbackRate"));
    preview.setClip(converted);

    transport?.dispose();
    timelineDock.innerHTML = "";
    transport = createTransport(preview, converted.duration, converted.times.length);
    transportDuration = converted.duration;
    timelineDock.appendChild(transport.element);

    // Ambiguous multi-take files get a toolbar select; a single take gets none.
    pendingFbxTakes =
      result.takes.length > 1
        ? { names: result.takes.map((t) => t.name), active: idx, onPick: (i) => { void loadFbx(name, raw, i); } }
        : null;

    buildPanel(name, synthetic, converted);
  } catch (err) {
    showError(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Start a body-only session: a VRM/GLB with no recording. The body renders in
 * its own T-pose (through the same retarget pipeline), and a reduced panel
 * offers only the Shogun target-rig export. Dropping a recording upgrades it.
 */
async function startBodyOnly(name: string, bytes: ArrayBuffer, scene?: SceneFile) {
  try {
    const mapped = await setBodySource(bytes); // throws on an unreadable file
    userBodyBytes = { name, data: bytes };
    // Seed a canonical skeleton, resolve the body's OWN T-posed joints, and put
    // the rest pose on them for a 1:1 mesh (same fixed point as proportions:body).
    const seed = defaultRestClip();
    const joints = await getBodyJoints(seed.parents, seed.bindPos, seed.names);
    const rest = retargetProportions(seed, joints);

    loaded = null;
    rigHotkeys = null;
    transportHotkeys = null;
    menuActions = null;
    emptyState.hidden = true;
    if (!preview) preview = new PreviewScene(viewport);
    (window as unknown as { __preview?: PreviewScene }).__preview = preview;
    preview.setRigEnabled(false);
    preview.setClip(rest);
    preview.setBodyMode("human");
    preview.setFaceVisible(false); // the body keeps its own head
    preview.refreshBody();
    preview.pause();

    transport?.dispose();
    transport = null;
    timelineDock.innerHTML = disabledTransportHtml();

    buildBodyPanel(name, bytes, mapped, scene);
    if (mapped === 0) {
      showError(`${name}: no VRM humanoid mapping found, using bone-name matching.`);
    }
  } catch (err) {
    showError(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The inert timeline placeholder shown when no clip is playable. */
function disabledTransportHtml(): string {
  return `
    <div class="transport-overlay disabled" aria-disabled="true">
      <div class="t-main">
        <button class="t-btn t-play" disabled aria-label="Play/pause">${ICONS.play}</button>
        <div class="t-timeline" aria-disabled="true"></div>
        <span class="t-time">0:00.00 / 0:00.00</span>
      </div>
    </div>
  `;
}

/** The reduced dock/editbar for a body-only (no recording) session. */
function buildBodyPanel(name: string, bytes: ArrayBuffer, mappedBones: number, scene?: SceneFile) {
  const vrm = isVrmBody(bytes);
  const meta = parseVrmMeta(bytes);
  const settings = (scene?.settings ?? {}) as Record<string, unknown>;
  const stripDefault = settings.shogunStrip === undefined ? true : !!settings.shogunStrip;
  const outDefault = typeof settings.outName === "string" && settings.outName
    ? settings.outName
    : `${sanitizeFilename(name.replace(/\.(vrm|glb)$/i, ""))}-shogun`;

  editbar.innerHTML = `<span class="eb-hint">Body loaded: ${name}. Drop a recording or FBX to animate it, or export a Shogun target rig.</span>`;

  const metaRows = meta
    ? [
        ["VRM", meta.version === "1.0" ? "1.0" : "0.x"],
        ...(meta.title ? [["Title", meta.title]] : []),
        ...(meta.author ? [["Author", meta.author]] : []),
      ]
    : [["Type", "GLB (no VRM metadata)"]];
  const rows: [string, string][] = [
    ["File", name],
    ...(metaRows as [string, string][]),
    ["Humanoid bones", mappedBones ? String(mappedBones) : "name-matched"],
    ["Meshes", "…"],
    ["Vertices", "…"],
  ];

  dock.innerHTML = `
    <nav class="dock-tabs" role="tablist">
      <button class="dock-tab active" data-tab="clean">Clean</button>
      <button class="dock-tab" data-tab="rig">Rig</button>
      <button class="dock-tab" data-tab="export">Export</button>
      <button class="dock-tab" data-tab="info">Info</button>
    </nav>
    <div class="dock-body">
      <div class="tab active" id="tab-clean"><p class="note">Needs a recording. Drop a <code>.wanim</code> or <code>.fbx</code> to animate this body.</p></div>
      <div class="tab" id="tab-rig"><p class="note">Needs a recording. Drop a <code>.wanim</code> or <code>.fbx</code> to pose this body.</p></div>
      <div class="tab" id="tab-export">
        <h4 class="group">Shogun target rig <span class="hint-i" title="A static, world-aligned skeleton plus skinned mesh built straight from your loaded VRM body, for use as a Vicon Shogun retarget target. No animation is baked in.">ⓘ</span></h4>
        <label class="field">
          <span>Export name</span>
          <input id="bodyOutName" class="eb-name" type="text" spellcheck="false" />
        </label>
        <label class="field">
          <span>Strip spring bones</span>
          <input id="shogunStrip" type="checkbox" ${stripDefault ? "checked" : ""} title="Drops VRM spring bones (hair, skirt, tail, accessories) and re-weights them onto their nearest kept parent. Shogun can't use them." />
        </label>
        <div class="rig-row">
          <button id="shogunDl" class="button ghost">Shogun target rig (.fbx)</button>
        </div>
        <p id="shogunNote" class="clean-stats"></p>
      </div>
      <div class="tab" id="tab-info">
        <h2>${name}</h2>
        <dl class="stats">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd id="bodyStat-${k.replace(/\s+/g, "")}">${v}</dd></div>`).join("")}</dl>
        <button id="sceneSave" class="button ghost" title="Bundles this body and its export settings into one .scene.json.">Save scene…</button>
        <button id="reset" class="button ghost">Load another file</button>
      </div>
    </div>
  `;

  // Tab switching.
  const tabBtns = Array.from(dock.querySelectorAll<HTMLButtonElement>(".dock-tab"));
  for (const b of tabBtns) {
    b.addEventListener("click", () => {
      for (const x of tabBtns) x.classList.toggle("active", x === b);
      for (const el of dock.querySelectorAll(".tab")) el.classList.toggle("active", el.id === `tab-${b.dataset.tab}`);
    });
  }

  const outNameEl = document.getElementById("bodyOutName") as HTMLInputElement;
  outNameEl.value = outDefault;
  const outBase = () => sanitizeFilename(outNameEl.value.trim()) || outDefault;
  const shogunStripChk = document.getElementById("shogunStrip") as HTMLInputElement;
  const shogunDlBtn = document.getElementById("shogunDl") as HTMLButtonElement;
  const shogunNote = document.getElementById("shogunNote") as HTMLParagraphElement;
  shogunDlBtn.disabled = !vrm;
  shogunNote.textContent = vrm ? `Ready from ${name}.` : "The loaded body has no VRM data. Load a .vrm to export a Shogun rig.";

  async function doShogun() {
    if (!vrm) return;
    shogunDlBtn.disabled = true;
    shogunDlBtn.textContent = "Generating…";
    await new Promise((r) => setTimeout(r, 16));
    try {
      const res = await exportShogunFbx(bytes, { stripSprings: shogunStripChk.checked });
      downloadBytes(`${outBase()}.fbx`, new TextEncoder().encode(res.fbx));
      const stripped = res.strippedSprings ? `, ${res.springBoneCount} spring bones stripped` : "";
      shogunNote.textContent = `Exported ${res.boneCount} bones${stripped}.`;
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      shogunDlBtn.textContent = "Shogun target rig (.fbx)";
      shogunDlBtn.disabled = !vrm;
    }
  }
  shogunDlBtn.addEventListener("click", () => void doShogun());

  // Scene save: body + export settings, no recording.
  function sceneSettings(): Record<string, unknown> {
    return { shogunStrip: shogunStripChk.checked, outName: outNameEl.value };
  }
  function saveScene(baseName?: string, forcePicker = false) {
    const sc: SceneFile = {
      magic: "wanimscene",
      v: 4,
      name,
      source: "body",
      settings: sceneSettings(),
      body: { name, data: bytesToBase64(new Uint8Array(bytes)) },
    };
    const base = sanitizeFilename(baseName || name.replace(/\.(vrm|glb)$/i, "")) || "body";
    void recent.saveScene(`${base}.scene.json`, new TextEncoder().encode(JSON.stringify(sc)), forcePicker);
  }
  function saveSceneAs() {
    if (recent.supported()) { saveScene(undefined, true); return; }
    const n = prompt("Save scene as (file name):", sanitizeFilename(name.replace(/\.(vrm|glb)$/i, "")));
    if (n === null) return;
    saveScene(n);
  }
  (document.getElementById("sceneSave") as HTMLButtonElement).addEventListener("click", () => saveScene());
  (document.getElementById("reset") as HTMLButtonElement).addEventListener("click", () => {
    errorEl.hidden = true;
    bodyPanel = null;
    userBodyBytes = null;
    void setBodySource(null);
    showEmptyEditor();
    void clearLastSession();
  });

  bodyPanel = { saveScene: () => saveScene(), saveSceneAs, exportShogun: () => void doShogun(), isVrm: () => vrm };

  // Fill mesh/vertex counts asynchronously (best-effort).
  void fillBodyCounts();

  async function fillBodyCounts() {
    try {
      const seed = defaultRestClip();
      const joints = await getBodyJoints(seed.parents, seed.bindPos, seed.names);
      const rest = retargetProportions(seed, joints);
      const data = await buildBodyData(rest.parents, rest.bindPos, rest.names);
      let verts = 0;
      for (const m of data.meshes) verts += m.positions.length / 3;
      const meshEl = document.getElementById("bodyStat-Meshes");
      const vertEl = document.getElementById("bodyStat-Vertices");
      if (meshEl) meshEl.textContent = String(data.meshes.length);
      if (vertEl) vertEl.textContent = verts.toLocaleString();
    } catch { /* counts are best-effort */ }
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) { recent.setSaveHandle(null); void handleFile(file); } // no reopenable handle
  fileInput.value = "";
  fileInput.accept = ".wanim,.json"; // undo any per-button filter
});
fileInput.addEventListener("cancel", () => {
  fileInput.accept = ".wanim,.json";
});

// Whole-page drag-drop (the dim empty line brightens while a file hovers).
for (const evt of ["dragover", "dragenter"] as const) {
  document.addEventListener(evt, (e) => {
    e.preventDefault();
    emptyState.classList.add("dragging");
  });
}
for (const evt of ["dragleave", "dragend"] as const) {
  document.addEventListener(evt, () => emptyState.classList.remove("dragging"));
}
document.addEventListener("drop", (e) => {
  e.preventDefault();
  emptyState.classList.remove("dragging");
  const file = e.dataTransfer?.files?.[0];
  if (file) { recent.setSaveHandle(null); void handleFile(file); } // dropped = no reopenable handle
});

// ---- boot: straight into the editor, DCC style -----------------------------
// The viewport (grid) and chrome are on screen immediately; if a previous
// session exists it reopens automatically — unless the user opens a file
// first, which always wins.
preview = new PreviewScene(viewport);
(window as unknown as { __preview?: PreviewScene }).__preview = preview;
showEmptyEditor();
void (async () => {
  const last = await loadLastSession();
  if (!last || userOpenedFile || loaded) return;
  restoredSessionName = last.name;
  await loadWanim(last.name, last.bytes, true);
})();
