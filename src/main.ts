import "./style.css";
import { parseWanim, BONE_COUNT, type WanimClip } from "./wanim/parse.ts";
import { convertCharacter, resample, retargetProportions, distributeBonelessSpine, type ConvertedClip } from "./convert/clip.ts";
import { cleanClip, type CleanOpts } from "./convert/clean.ts";
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
const panel = document.getElementById("panel") as HTMLElement;

let preview: PreviewScene | null = null;
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

  panel.innerHTML = `
    <h2>${name}</h2>
    <dl class="stats">
      ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
    </dl>

    <h3 class="section">Cleaning</h3>
    <label class="field">
      <span>Limit wrists (human range)</span>
      <input id="limitWrists" type="checkbox" checked />
    </label>
    <label class="field">
      <span>Lock wrist (bad tracking)</span>
      <select id="lockWrists">
        <option value="" selected>Off</option>
        <option value="left">Left</option>
        <option value="right">Right</option>
        <option value="both">Both</option>
      </select>
    </label>
    <label class="field">
      <span>Remove pops / flips</span>
      <input id="despike" type="checkbox" />
    </label>
    <label class="field sub">
      <span>Pop threshold <output id="despikeVal">35°</output></span>
      <input id="despikeDeg" type="range" min="10" max="90" step="5" value="35" />
    </label>
    <label class="field">
      <span>Smooth (Butterworth)</span>
      <input id="smooth" type="checkbox" />
    </label>
    <label class="field sub">
      <span>Cutoff <output id="cutoffVal">7 Hz</output></span>
      <input id="cutoff" type="range" min="1" max="15" step="0.5" value="7" />
    </label>
    <p id="cleanStats" class="clean-stats"></p>

    <h3 class="section">Export</h3>
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
      <input id="distSpine" type="checkbox" title="For avatars without an upper-chest bone: spreads a concentrated upper-spine fold into a smooth curve. No effect when the recording's spine is already complete." />
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
    <button id="download" class="button primary">Download FBX</button>
    <button id="downloadVrma" class="button">Download VRMA</button>
    <p class="note">Trim with the in/out handles on the timeline. FBX is binary
      7.5 (MotionBuilder-compatible) with the face/body meshes embedded when
      enabled. VRMA is the VRM Animation format (humanoid + expressions) for
      Warudo/VSeeFace/Unity — plays on any VRM, no mesh needed.</p>
    <button id="reset" class="button ghost">Load another file</button>
  `;

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
  const bodySel = document.getElementById("body") as HTMLSelectElement;
  const downloadBtn = document.getElementById("download") as HTMLButtonElement;
  const resetBtn = document.getElementById("reset") as HTMLButtonElement;

  const limitWristsChk = document.getElementById("limitWrists") as HTMLInputElement;
  const lockWristsSel = document.getElementById("lockWrists") as HTMLSelectElement;
  const cleanOpts = (): CleanOpts => ({
    despike: despikeChk.checked,
    despikeDeg: Number(despikeDeg.value),
    smooth: smoothChk.checked,
    cutoffHz: Number(cutoff.value),
    limitWrists: limitWristsChk.checked,
    lockWrists: (lockWristsSel.value || undefined) as CleanOpts["lockWrists"],
  });

  const cleanStatsEl = document.getElementById("cleanStats") as HTMLParagraphElement;

  async function reclean() {
    if (!loaded || !preview) return;
    const opts = cleanOpts();
    const stats = { despiked: 0, wristClamped: 0, smoothedMeanDeg: 0 };
    const anyFilter = opts.despike || opts.smooth || opts.limitWrists || opts.lockWrists;
    let display = anyFilter ? cleanClip(loaded.converted, opts, stats) : loaded.converted;
    // Report what the filters actually changed — proof they're applied.
    if (!anyFilter) {
      cleanStatsEl.textContent = "";
    } else {
      const parts: string[] = [];
      if (opts.lockWrists) parts.push(`wrist locked: ${opts.lockWrists}`);
      if (opts.limitWrists) parts.push(`wrists clamped: ${stats.wristClamped} frames`);
      if (opts.despike) parts.push(`pops fixed: ${stats.despiked}`);
      if (opts.smooth) parts.push(`smoothing: ±${stats.smoothedMeanDeg.toFixed(2)}° avg`);
      cleanStatsEl.textContent = `Applied — ${parts.join(" · ")}`;
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
    if (distSpineChk.checked) display = distributeBonelessSpine(display);
    loaded.display = display;
    const trim = transport?.getTrim();
    preview.setClip(display); // duration is unchanged; this resets the pose
    if (trim) preview.setTrim(trim.start, trim.end); // keep the user's trim
  }

  despikeVal.value = `${despikeDeg.value}°`;
  cutoffVal.value = `${cutoff.value} Hz`;
  despikeDeg.addEventListener("input", () => { despikeVal.value = `${despikeDeg.value}°`; });
  cutoff.addEventListener("input", () => { cutoffVal.value = `${cutoff.value} Hz`; });
  for (const c of [despikeChk, smoothChk, limitWristsChk, distSpineChk]) c.addEventListener("change", () => void reclean());
  for (const r of [despikeDeg, cutoff]) r.addEventListener("change", () => void reclean());
  propSel.addEventListener("change", () => void reclean());
  lockWristsSel.addEventListener("change", () => void reclean());

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
        showError(`${file.name}: no VRM humanoid mapping found — using bone-name matching.`);
      }
    } catch (err) {
      bodySel.value = lastBodyChoice;
      await setBodySource(null);
      preview?.setFaceVisible(true);
      showError(err instanceof Error ? err.message : String(err));
    }
  });

  // Apply the default proportions selection (body-mesh skeleton) on load.
  void reclean();

  downloadBtn.addEventListener("click", async () => {
    if (!loaded) return;
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Generating…";
    await new Promise((r) => setTimeout(r, 16));
    try {
      const fps = Number(fpsSel.value);
      const trim = transport?.getTrim() ?? { start: 0, end: loaded.display.duration };
      const resampled = resample(loaded.display, fps, trim.start, trim.end);
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
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Download FBX";
    }
  });

  const downloadVrmaBtn = document.getElementById("downloadVrma") as HTMLButtonElement;
  downloadVrmaBtn.addEventListener("click", async () => {
    if (!loaded) return;
    downloadVrmaBtn.disabled = true;
    downloadVrmaBtn.textContent = "Generating…";
    await new Promise((r) => setTimeout(r, 16));
    try {
      const fps = Number(fpsSel.value);
      const trim = transport?.getTrim() ?? { start: 0, end: loaded.display.duration };
      const resampled = resample(loaded.display, fps, trim.start, trim.end);
      // Original ARKit tracks become custom expressions; the synthesized
      // preset tracks (A/Blink/Look_*) fill the VRM presets.
      const augFace =
        faceChk.checked && resampled.face ? augmentFaceForVrm(resampled.face) : undefined;
      const { writeVrma } = await import("./vrma/writeVrma.ts");
      const vrma = writeVrma(resampled, augFace);
      downloadBytes(`${sanitizeFilename(loaded.name)}.vrma`, vrma);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      downloadVrmaBtn.disabled = false;
      downloadVrmaBtn.textContent = "Download VRMA";
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
    viewport.appendChild(transport.element);

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
