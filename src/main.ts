import "./style.css";
import { parseWanim, BONE_COUNT, type WanimClip } from "./wanim/parse.ts";
import { convertCharacter, resample, retargetProportions, distributeBonelessSpine, type ConvertedClip } from "./convert/clip.ts";
import { cleanClip, type CleanOpts, type CleanStats } from "./convert/clean.ts";
import {
  makeLayer, getTrack, setPosKey, setRotKey, deleteKeysAt, keyTimes,
  applyRigLayers, applyLayersToPose, poseAtFrame, nearestFrame,
  effectorBaseWorld, effectorDef, effectorColor, retimeKeys, keyFullPose,
  bakeRange, dirtyRange, unionRange, fkDragRef,
  type RigLayer, type EffectorId, type Transient, type TimeRange,
} from "./rig/rig.ts";
import { vsub, vadd, vlen, vnorm, qconj, quatFromTo } from "./convert/ik.ts";
import { applyModifiers, defaultModifiers } from "./rig/modifiers.ts";
import { quatMul, quatDot, quatNormalize } from "./convert/quat.ts";
import type { Vec3, Quat } from "./wanim/parse.ts";
import { writeAnimationFbx, type SkinnedMeshExport } from "./fbx/animationFbx.ts";
import { remapNames, type NameScheme } from "./convert/skeleton.ts";
import { buildFaceMesh } from "./convert/meshExport.ts";
import { buildBodyData, bodyToSkinnedMeshExports, getBodyJoints, setBodySource, hasUserBody } from "./convert/body.ts";
import { augmentFaceForVrm } from "./convert/vrmFaceMap.ts";
import { sanitizeFilename, downloadBytes } from "./fbx/export.ts";
import { PreviewScene } from "./preview/scene.ts";
import { loadFaceMeshData } from "./preview/face.ts";
import { createTransport, type Transport } from "./ui/transport.ts";

const emptyState = document.getElementById("empty-state") as HTMLElement;
const loadedState = document.getElementById("loaded-state") as HTMLElement;
const dropzone = document.getElementById("dropzone") as HTMLElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const errorEl = document.getElementById("empty-error") as HTMLElement;
const viewport = document.getElementById("viewport") as HTMLElement;
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
document.addEventListener("keydown", (e) => {
  if (!rigHotkeys) return;
  const tgt = e.target as HTMLElement | null;
  const inField = !!tgt && (tgt.tagName === "INPUT" || tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA");
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); rigHotkeys.undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); rigHotkeys.redo(); }
    else if (k === "c" && !inField) rigHotkeys.copy();
    else if (k === "v" && !inField) rigHotkeys.paste();
  } else if (!inField) {
    // Standard DCC manipulation keys: Q space, W move, E rotate.
    const k = e.key.toLowerCase();
    if (e.key === "Delete") rigHotkeys.del();
    else if (k === "w") rigHotkeys.mode("translate");
    else if (k === "e") rigHotkeys.mode("rotate");
    else if (k === "q") rigHotkeys.toggleSpace();
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
let loaded: {
  name: string;
  clip: WanimClip;
  converted: ConvertedClip;
  /** After cleaning + optional Ybot re-proportioning — what preview/export use. */
  display: ConvertedClip;
} | null = null;

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}


function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

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
      <button id="rigUndo" class="eb-btn" disabled title="Undo the last rig or modifier edit (Ctrl+Z)">↶ Undo</button>
      <button id="rigRedo" class="eb-btn" disabled title="Redo (Ctrl+Y)">↷ Redo</button>
    </div>
    <div class="eb-group">
      <select id="rigGizmo" title="Gizmo mode (W = move, E = rotate). Pulling an FK diamond in move mode swings the bone toward the drag.">
        <option value="translate" selected>Move</option>
        <option value="rotate">Rotate</option>
      </select>
      <button id="rigSpace" class="eb-btn" title="Gizmo axes: Local follows the bone, World uses the scene axes (Q toggles).">Local</button>
    </div>
    <button id="compare" class="eb-btn compare" title="Press and hold to see the recording without any cleaning or rig edits, so you can judge what changed.">Hold: original</button>
    <span class="eb-spacer"></span>
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
      <input id="fixFeet" type="checkbox" checked title="Stops feet sliding while they're planted and keeps them from dipping under the floor. Legs are adjusted; nothing else moves." />
    </label>

    <h4 class="group">Arms &amp; hands</h4>
    <label class="field">
      <span>Limit wrists (human range)</span>
      <input id="limitWrists" type="checkbox" checked title="Caps wrist twist at ±90° and bend at 85°, the anatomical range. Only frames past those limits change." />
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
      <input id="limitLowerArms" type="checkbox" checked title="Caps forearm rotation at ±90°, the anatomical range. Elbow bend is untouched." />
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
    </div>

    <div class="tab" id="tab-rig">
    <p class="hint">FK/IK adjustment layers, MotionBuilder style. Add a layer, pause,
      then drag a handle on the figure; a key lands at the playhead. Spheres
      (hips, hands, feet) move with IK and rotate; the small diamonds on the
      body bones rotate FK-style. On the timeline: right-click a key for
      copy/paste/delete, shift-drag to select several, ctrl-click to add one,
      drag a key to retime it. Edits auto-save for this recording.</p>
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
      <div id="rigKeys" class="rig-keys"></div>
      <div class="rig-row">
        <button id="rigNeutral" class="button ghost" title="Keys the selected handle at its unadjusted position at the playhead. Put one before and after an adjustment to keep it local.">Neutral key</button>
        <button id="rigKeyAll" class="button ghost" title="Keys every handle at the playhead, locking the whole pose at this moment so edits elsewhere can't disturb it.">Key pose</button>
        <button id="rigDelKey" class="button ghost" title="Removes the selected handle's key nearest the playhead.">Delete key</button>
      </div>
    </div>

    <h3 class="section">Modifiers</h3>
    <p class="hint">Whole-clip corrections, no keys needed. Hips keeps the feet
      planted; knees and elbows swing without moving hips, feet, or hands.
      Layers apply on top of these.</p>
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
    <p class="note">Format and Download live in the toolbar. Drag the in/out
      handles on the timeline to trim. FBX comes out as binary 7.5, which
      MotionBuilder can read, with the face and body meshes baked in if you
      turned them on. VRMA carries the humanoid motion and expressions for
      Warudo, VSeeFace, and Unity; it plays on any VRM and doesn't need a
      mesh. WANIM writes the cleaned recording back out so you can take it
      into Warudo again.</p>
    </div>

    <div class="tab" id="tab-info">
    <h2>${name}</h2>
    <dl class="stats">
      ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
    </dl>
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
  });

  const cleanStatsEl = document.getElementById("cleanStats") as HTMLParagraphElement;

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
    let display = withCleaning && anyFilter ? cleanClip(loaded.converted, opts, stats) : loaded.converted;
    // Report what the filters actually changed — proof they're applied.
    if (withCleaning) {
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

  async function reclean() {
    if (!loaded || !preview) return;
    compareBase = null; // options changed
    const gen = ++compareGen;
    const display = await buildDisplay(true);
    loaded.display = display;
    const trim = transport?.getTrim();
    preview.setClip(display, true); // same recording: keep camera + playback position
    if (trim) preview.setTrim(trim.start, trim.end); // keep the user's trim
    saveRigCache();
    // Prebuild the uncleaned version so holding Compare swaps instantly.
    void buildDisplay(false).then((b) => { if (gen === compareGen) compareBase = b; }).catch(() => {});
  }

  // Hold-to-compare: show the recording without cleaning while pressed. The
  // camera, playhead, and trim all carry over, so differences pop visually.
  const compareBtn = document.getElementById("compare") as HTMLButtonElement;
  let comparing = false;
  const showClip = (clip: ConvertedClip) => {
    if (!preview) return;
    const trim = transport?.getTrim();
    preview.setClip(clip, true);
    if (trim) preview.setTrim(trim.start, trim.end);
  };
  compareBtn.addEventListener("pointerdown", () => {
    if (!loaded || !preview || comparing) return;
    void (async () => {
      compareBase ??= await buildDisplay(false);
      comparing = true;
      compareBtn.classList.add("active");
      showClip(compareBase);
    })();
  });
  const endCompare = () => {
    if (!comparing || !loaded?.display) return;
    comparing = false;
    compareBtn.classList.remove("active");
    showClip(loaded.display);
  };
  for (const ev of ["pointerup", "pointerleave", "pointercancel"] as const) {
    compareBtn.addEventListener(ev, endCompare);
  }

  // ---- control rig -------------------------------------------------------
  // (rigLayers/rigBaseClip are declared with the pipeline state above the
  // compare block; the closures in buildDisplay/export read them.)
  const rigLayersEl = document.getElementById("rigLayers") as HTMLDivElement;
  const rigAddBtn = document.getElementById("rigAdd") as HTMLButtonElement;
  const rigGizmoSel = document.getElementById("rigGizmo") as HTMLSelectElement;
  const rigEditorEl = document.getElementById("rigEditor") as HTMLDivElement;
  const rigSelEl = document.getElementById("rigSel") as HTMLParagraphElement;
  const rigKeysEl = document.getElementById("rigKeys") as HTMLDivElement;
  const rigNeutralBtn = document.getElementById("rigNeutral") as HTMLButtonElement;
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
    JSON.stringify({ layers: rigLayers, mods, counter: layerCounter, active: activeLayerIdx });
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
    };
    const modsChanged = JSON.stringify(mods) !== JSON.stringify(d.mods);
    rigLayers.splice(0, rigLayers.length, ...d.layers);
    Object.assign(mods, d.mods);
    layerCounter = d.counter;
    activeLayerIdx = Math.min(d.active, rigLayers.length - 1);
    syncModSliders();
    renderRigLayers();
    if (modsChanged) void reclean();
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
  let keyClipboard: Array<{ effector: EffectorId; dt: number; pos?: Vec3; rot?: Quat }> = [];
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
        pos: pk ? ([...pk.v] as Vec3) : undefined,
        rot: rk ? ([...rk.q] as Quat) : undefined,
      });
    }
  }

  function pastePicked() {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !keyClipboard.length || !preview) return;
    const t0 = preview.getTime();
    pushHistory();
    let dirty: TimeRange | null = null;
    pickedKeys = [];
    for (const it of keyClipboard) {
      const tr = getTrack(layer, it.effector, true)!;
      const t = t0 + it.dt;
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
    mode: (m) => {
      rigGizmoSel.value = m;
      preview?.setGizmoMode(m);
    },
    toggleSpace: () => setGizmoSpaceUi(preview?.getGizmoSpace() === "local" ? "world" : "local"),
  };

  /**
   * Rebake layers onto the (unchanged) base, IN PLACE in the display clip the
   * preview is already playing — no setClip, no body/face rebuild. `dirty`
   * limits the bake to the frames a key edit actually changed, which is what
   * keeps editing responsive on clips with many keyframes.
   */
  function rebakeRig(dirty?: TimeRange) {
    if (!loaded || !preview || !rigBaseClip) return;
    const d = loaded.display;
    bakeRange(rigBaseClip, rigLayers, d.localPos, d.localQuat, dirty);
    d.bindPos = d.localPos.map((t) => t[0]);
    preview.seek(preview.getTime()); // repose from the updated arrays
    saveRigCache();
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
    // Drop picks that no longer exist (deleted keys, switched layer).
    pickedKeys = layer
      ? pickedKeys.filter((p) => {
          const tr = getTrack(layer, p.effector);
          return !!tr && keyTimes(tr).some((t) => Math.abs(t - p.time) < 1e-3);
        })
      : [];
    // Timeline markers for the active layer (cleared when there is none).
    const markers = layer
      ? layer.tracks.flatMap((tr) =>
          keyTimes(tr).map((t) => ({
            time: t,
            color: effectorColor(tr.effector),
            selected: tr.effector === selectedEffector,
            picked: isPicked(tr.effector, t),
            tag: tr.effector,
          })),
        )
      : [];
    const keyCbs = {
      onClick: (m, ctrl) => {
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
        const tr = lay ? getTrack(lay, m.tag as EffectorId) : null;
        if (!tr || !lay) return;
        pushHistory();
        const before = dirtyRange(lay, tr, m.time);
        retimeKeys(tr, m.time, newTime);
        rebakeRig(unionRange(before, dirtyRange(lay, tr, newTime)));
        updateRigEditor();
      },
      onContext: (m, x, y) => {
        if (!isPicked(m.tag as EffectorId, m.time)) {
          pickedKeys = [{ effector: m.tag as EffectorId, time: m.time }];
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
                ? lay.tracks.flatMap((tr) => keyTimes(tr).map((t) => ({ effector: tr.effector, time: t })))
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
        pickedKeys = lay.tracks.flatMap((tr) =>
          keyTimes(tr).filter((t) => t >= t0 && t <= t1).map((t) => ({ effector: tr.effector, time: t })),
        );
        updateRigEditor();
      },
    } satisfies Parameters<NonNullable<typeof transport>["setKeys"]>[1];
    transport?.setKeys(markers, keyCbs);
    // Dope sheet: one row per keyed effector, only while the Rig tab is up.
    const dopeRows =
      activeTab === "rig" && layer
        ? layer.tracks
            .filter((tr) => tr.posKeys.length + tr.rotKeys.length > 0)
            .map((tr) => ({
              tag: tr.effector,
              label: effectorDef(tr.effector).label.replace("Left ", "L ").replace("Right ", "R "),
              color: effectorColor(tr.effector),
              keys: keyTimes(tr).map((t) => ({
                time: t,
                color: effectorColor(tr.effector),
                selected: tr.effector === selectedEffector,
                picked: isPicked(tr.effector, t),
                tag: tr.effector,
              })),
            }))
        : [];
    transport?.setDope(dopeRows, keyCbs);
    rigEditorEl.hidden = !layer;
    if (!layer) return;
    if (!selectedEffector) {
      rigSelEl.textContent = "Click a colored handle on the figure to pose it.";
      rigKeysEl.innerHTML = "";
      return;
    }
    const def = effectorDef(selectedEffector);
    const track = getTrack(layer, selectedEffector);
    const times = track ? keyTimes(track) : [];
    rigSelEl.textContent = `${def.label} on ${layer.name} · ${times.length} key${times.length === 1 ? "" : "s"}`;
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
      mode.addEventListener("change", () => { pushHistory(); layer.mode = mode.value as RigLayer["mode"]; rebakeRig(); });

      const extent = document.createElement("select");
      extent.title = "Fade: keys ease in/out around the keyed range — one key is a local correction. Hold: the first/last key extends across the whole clip, MoBu style.";
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

  rigGizmoSel.addEventListener("change", () => {
    preview?.setGizmoMode(rigGizmoSel.value as "translate" | "rotate");
  });

  const rigSpaceBtn = document.getElementById("rigSpace") as HTMLButtonElement;
  function setGizmoSpaceUi(s: "local" | "world") {
    preview?.setGizmoSpace(s);
    rigSpaceBtn.textContent = s === "local" ? "Local" : "World";
  }
  rigSpaceBtn.addEventListener("click", () => {
    setGizmoSpaceUi(preview?.getGizmoSpace() === "local" ? "world" : "local");
  });
  setGizmoSpaceUi("local"); // bone-aligned rings by default — world axes rarely match a limb

  rigNeutralBtn.addEventListener("click", () => {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !selectedEffector || !rigBaseClip || !preview) return;
    const def = effectorDef(selectedEffector);
    const t = preview.getTime();
    const f = nearestFrame(rigBaseClip, t);
    pushHistory();
    const track = getTrack(layer, selectedEffector, true)!;
    const dirty = dirtyRange(layer, track, t);
    if (layer.mode === "additive") {
      if (def.canMove) setPosKey(track, t, [0, 0, 0]);
      if (def.canRotate) setRotKey(track, t, [0, 0, 0, 1]);
    } else {
      const base = effectorBaseWorld(rigBaseClip, rigLayers, activeLayerIdx, selectedEffector, f);
      if (def.canMove) setPosKey(track, t, base.pos);
      if (def.canRotate) setRotKey(track, t, base.rot);
    }
    rebakeRig(dirty);
    updateRigEditor();
  });

  (document.getElementById("rigKeyAll") as HTMLButtonElement).addEventListener("click", () => {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !rigBaseClip || !preview) return;
    const t = preview.getTime();
    pushHistory();
    keyFullPose(rigBaseClip, rigLayers, activeLayerIdx, t, nearestFrame(rigBaseClip, t));
    rebakeRig();
    updateRigEditor();
  });

  rigDelKeyBtn.addEventListener("click", () => {
    const layer = rigLayers[activeLayerIdx];
    if (!layer || !selectedEffector || !preview) return;
    const track = getTrack(layer, selectedEffector);
    if (!track) return;
    const t = preview.getTime();
    const near = keyTimes(track).reduce<number | null>(
      (best, k) => (best === null || Math.abs(k - t) < Math.abs(best - t) ? k : best), null);
    if (near === null || Math.abs(near - t) > 0.5) return; // nothing near the playhead
    pushHistory();
    const dirty = dirtyRange(layer, track, near);
    deleteKeysAt(track, near, 1 / 120);
    rebakeRig(dirty);
    updateRigEditor();
  });

  // Viewport drag → live single-frame solve → key on release.
  let dragCtx: {
    f: number;
    t: number;
    base: { pos: Vec3; rot: Quat };
    start: { pos: Vec3; rot: Quat };
    fkRef: { joint: Vec3; tip: Vec3 } | null;
    transient: Transient;
  } | null = null;
  preview?.setRigCallbacks({
    onSelect: (e) => {
      selectedEffector = e;
      updateRigEditor();
    },
    onDragStart: (e) => {
      if (!loaded || !rigBaseClip || activeLayerIdx < 0) return false;
      const layer = rigLayers[activeLayerIdx];
      if (!layer.enabled) return false;
      getTrack(layer, e, true);
      const t = preview!.getTime();
      const f = nearestFrame(rigBaseClip, t);
      const base = effectorBaseWorld(rigBaseClip, rigLayers, activeLayerIdx, e, f);
      const start = preview!.getEffectorWorld(e) ?? base;
      // FK bones swing about their joint when PULLED (Poser style): pulling
      // the chest forward leans it forward.
      const fkRef = effectorDef(e).canMove ? null : fkDragRef(rigBaseClip, rigLayers, e, f);
      dragCtx = { f, t, base, start, fkRef, transient: { layerIndex: activeLayerIdx, effector: e } };
      return true;
    },
    onDragMove: (pos, rot) => {
      if (!dragCtx || !rigBaseClip) return;
      const layer = rigLayers[activeLayerIdx];
      if (!layer) return; // deleted mid-drag; onDragEnd cleans up
      const def = effectorDef(dragCtx.transient.effector);
      // Route by what the input actually changed — the gizmo moves either
      // position (translate / direct grab) or rotation (rotate rings).
      const posMoved = vlen(vsub(pos, dragCtx.start.pos)) > 1e-5;
      const rotMoved = 1 - Math.abs(quatDot(rot, dragCtx.start.rot)) > 1e-9;
      if (posMoved && def.canMove) {
        dragCtx.transient.pos = layer.mode === "additive" ? vsub(pos, dragCtx.base.pos) : pos;
      } else if (posMoved && dragCtx.fkRef) {
        // Swing the bone so its tip chases the drag.
        const drag = vsub(pos, dragCtx.start.pos);
        const dir0 = vnorm(vsub(dragCtx.fkRef.tip, dragCtx.fkRef.joint));
        const dir1 = vnorm(vsub(vadd(dragCtx.fkRef.tip, drag), dragCtx.fkRef.joint));
        const swing = quatFromTo(dir0, dir1);
        dragCtx.transient.rot = layer.mode === "additive" ? swing : quatNormalize(quatMul(swing, dragCtx.base.rot));
      } else if (rotMoved && def.canRotate) {
        dragCtx.transient.rot = layer.mode === "additive" ? quatMul(rot, qconj(dragCtx.base.rot)) : rot;
      }
      const pose = poseAtFrame(rigBaseClip, dragCtx.f);
      applyLayersToPose(pose, rigBaseClip.names, rigBaseClip.parents, rigLayers, dragCtx.t, dragCtx.transient);
      preview?.setPoseOverride(pose);
    },
    onDragEnd: () => {
      if (!dragCtx) return;
      const layer = rigLayers[activeLayerIdx];
      if (!layer) {
        // The layer was deleted mid-drag — drop the edit cleanly.
        dragCtx = null;
        preview?.setPoseOverride(null);
        return;
      }
      const track = getTrack(layer, dragCtx.transient.effector, true)!;
      const dirty = dirtyRange(layer, track, dragCtx.t);
      if (dragCtx.transient.pos || dragCtx.transient.rot) pushHistory();
      if (dragCtx.transient.pos) setPosKey(track, dragCtx.t, dragCtx.transient.pos);
      if (dragCtx.transient.rot) setRotKey(track, dragCtx.t, dragCtx.transient.rot);
      dragCtx = null;
      preview?.setPoseOverride(null);
      rebakeRig(dirty);
      updateRigEditor();
    },
  });

  renderRigLayers();

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
  (document.getElementById("modReset") as HTMLButtonElement).addEventListener("click", () => {
    if (!modInputs.some((m) => mods[m.key] !== 0)) return;
    pushHistory();
    for (const m of modInputs) {
      mods[m.key] = 0;
      m.el.value = "0";
      m.out.value = `0${m.unit}`;
    }
    void reclean();
  });

  despikeVal.value = `${despikeDeg.value}°`;
  cutoffVal.value = `${cutoff.value} Hz`;
  despikeDeg.addEventListener("input", () => { despikeVal.value = `${despikeDeg.value}°`; });
  cutoff.addEventListener("input", () => { cutoffVal.value = `${cutoff.value} Hz`; });
  for (const c of [despikeChk, smoothChk, limitWristsChk, limitLowerArmsChk, fixFeetChk, distSpineChk]) c.addEventListener("change", () => void reclean());
  for (const r of [despikeDeg, cutoff, distSpineAmt]) r.addEventListener("change", () => void reclean());
  distSpineAmtVal.value = `${distSpineAmt.value}%`;
  distSpineAmt.addEventListener("input", () => { distSpineAmtVal.value = `${distSpineAmt.value}%`; });
  distSpineChk.addEventListener("change", () => { distSpineAmt.disabled = !distSpineChk.checked; });
  propSel.addEventListener("change", () => void reclean());
  lockWristsSel.addEventListener("change", () => void reclean());
  lockLowerArmSel.addEventListener("change", () => void reclean());

  const bodyFile = document.getElementById("bodyfile") as HTMLInputElement;
  let lastBodyChoice = bodySel.value;
  bodySel.addEventListener("change", () => {
    if (bodySel.value === "vrm") {
      bodyFile.click(); // async; handled below
      return;
    }
    lastBodyChoice = bodySel.value;
    void setBodySource(null).then(() => {
      preview?.setBodyMode(bodySel.value === "none" ? "none" : "human");
      preview?.setFaceVisible(true);
      preview?.refreshBody();
      if (propSel.value === "body") void reclean();
    });
  });
  bodyFile.addEventListener("change", async () => {
    const file = bodyFile.files?.[0];
    bodyFile.value = "";
    if (!file) {
      bodySel.value = lastBodyChoice; // cancelled
      return;
    }
    try {
      const mapped = await setBodySource(await file.arrayBuffer());
      lastBodyChoice = "vrm";
      preview?.setBodyMode("human");
      preview?.setFaceVisible(false); // the VRM keeps its own head
      preview?.refreshBody();
      if (propSel.value === "body") await reclean();
      if (mapped === 0) {
        showError(`${file.name}: no VRM humanoid mapping found, falling back to bone-name matching.`);
      }
    } catch (err) {
      bodySel.value = lastBodyChoice;
      await setBodySource(null);
      preview?.setFaceVisible(true);
      showError(err instanceof Error ? err.message : String(err));
    }
  });

  // ---- rig persistence -----------------------------------------------------
  // Auto-saved to localStorage per recording; also exportable as a .rig.json.
  const rigCacheKey = `wanimrig:${loaded?.name}:${converted.times.length}`;
  const rigCacheNote = document.getElementById("rigCacheNote") as HTMLParagraphElement;

  function saveRigCache() {
    try {
      if (rigLayers.length || modInputs.some((m) => mods[m.key] !== 0)) {
        localStorage.setItem(rigCacheKey, JSON.stringify({ v: 1, layers: rigLayers, mods, counter: layerCounter }));
      } else {
        localStorage.removeItem(rigCacheKey);
      }
    } catch { /* quota/private mode — silently skip */ }
  }

  /** Replace the rig state wholesale (cache restore / file load). */
  function adoptRigState(d: { layers?: RigLayer[]; mods?: Partial<ReturnType<typeof defaultModifiers>>; counter?: number }) {
    rigLayers.splice(0, rigLayers.length, ...(Array.isArray(d.layers) ? d.layers : []));
    for (const layer of rigLayers) {
      // Older saves may predate newer layer fields.
      layer.extent ??= "hold";
      layer.fadeS ??= 0.5;
    }
    Object.assign(mods, defaultModifiers(), d.mods ?? {});
    layerCounter = d.counter ?? rigLayers.length;
    activeLayerIdx = rigLayers.length - 1;
    pickedKeys = [];
    syncModSliders();
    renderRigLayers();
  }

  try {
    const saved = localStorage.getItem(rigCacheKey);
    if (saved) {
      const d = JSON.parse(saved) as { layers?: RigLayer[]; mods?: ReturnType<typeof defaultModifiers>; counter?: number };
      if (d.layers?.length || (d.mods && Object.values(d.mods).some((v) => v))) {
        adoptRigState(d);
        rigCacheNote.textContent = "Restored saved edits for this recording.";
      }
    }
  } catch { /* corrupt cache — start clean */ }

  (document.getElementById("rigSave") as HTMLButtonElement).addEventListener("click", () => {
    if (!loaded) return;
    const json = JSON.stringify({ v: 1, layers: rigLayers, mods, counter: layerCounter }, null, 1);
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

  // Apply the default proportions selection (body-mesh skeleton) on load.
  void reclean();

  const formatSel = document.getElementById("format") as HTMLSelectElement;
  downloadBtn.addEventListener("click", async () => {
    if (!loaded) return;
    const format = formatSel.value;
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
        let clip = cleanClip(loaded.converted, cleanOpts());
        if (distSpineChk.checked) clip = distributeBonelessSpine(clip, Number(distSpineAmt.value) / 100);
        // Modifiers + rig layers bake here too. Additive deltas transfer
        // cleanly; override targets were authored on the display proportions,
        // so on the recorded skeleton they land approximately.
        clip = applyModifiers(clip, mods);
        clip = applyRigLayers(clip, rigLayers);
        const rs = resample(clip, fps, trim.start, trim.end);
        const { writeWanim } = await import("./wanim/writeWanim.ts");
        downloadBytes(`${sanitizeFilename(loaded.name)}.wanim`, writeWanim(rs, loaded.clip));
      } else {
      const resampled = resample(loaded.display, fps, trim.start, trim.end);
      if (format === "vrma") {
        // Original ARKit tracks become custom expressions; the synthesized
        // preset tracks (A/Blink/Look_*) fill the VRM presets.
        const augFace =
          faceChk.checked && resampled.face ? augmentFaceForVrm(resampled.face) : undefined;
        const { writeVrma } = await import("./vrma/writeVrma.ts");
        const vrma = writeVrma(resampled, augFace);
        downloadBytes(`${sanitizeFilename(loaded.name)}.vrma`, vrma);
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
          takeName: sanitizeFilename(loaded.name),
          names,
          tposeRest: restSel.value === "tpose",
          meshes,
        });
        downloadBytes(`${sanitizeFilename(loaded.name)}.fbx`, fbx);
      }
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Download";
    }
  });

  resetBtn.addEventListener("click", () => {
    loadedState.hidden = true;
    emptyState.hidden = false;
    errorEl.hidden = true;
    loaded = null;
  });
}

async function handleFile(file: File) {
  errorEl.hidden = true;
  if (!file.name.toLowerCase().endsWith(".wanim")) {
    showError(`"${file.name}" is not a .wanim file.`);
    return;
  }
  try {
    const clip = parseWanim(await file.arrayBuffer());
    if (clip.characters.length === 0) {
      showError("This recording contains no characters.");
      return;
    }
    const converted = convertCharacter(clip, 0);
    loaded = { name: file.name, clip, converted, display: converted };

    emptyState.hidden = true;
    loadedState.hidden = false;

    if (!preview) preview = new PreviewScene(viewport);
    (window as unknown as { __preview?: PreviewScene }).__preview = preview; // test hook
    preview.setClip(converted);

    transport?.dispose();
    transport = createTransport(preview, converted.duration);
    timelineDock.appendChild(transport.element);

    buildPanel(file.name, clip, converted);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
  fileInput.value = "";
});

for (const evt of ["dragover", "dragenter"] as const) {
  document.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragging");
  });
}
for (const evt of ["dragleave", "dragend"] as const) {
  document.addEventListener(evt, () => dropzone.classList.remove("dragging"));
}
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragging");
  const file = e.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});
