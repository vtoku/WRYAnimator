import "./style.css";
import { parseWanim, BONE_COUNT, type WanimClip } from "./wanim/parse.ts";
import { convertCharacter, resample, type ConvertedClip, type ResampledClip } from "./convert/clip.ts";
import { cleanClip, type CleanOpts } from "./convert/clean.ts";
import { writeAnimationFbx, type FaceExport } from "./fbx/animationFbx.ts";
import { remapNames, type NameScheme } from "./convert/skeleton.ts";
import { sanitizeFilename, downloadBytes } from "./fbx/export.ts";
import { PreviewScene } from "./preview/scene.ts";
import { loadFaceMeshData, toFacecapName } from "./preview/face.ts";
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
let loaded: { name: string; clip: WanimClip; converted: ConvertedClip; cleaned: ConvertedClip } | null = null;

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

/** Pair recorded ARKit weight tracks with the facecap morph deltas by name. */
function buildFaceExport(
  resampled: ResampledClip,
  mesh: Awaited<ReturnType<typeof loadFaceMeshData>>,
): FaceExport {
  const channels: FaceExport["channels"] = [];
  resampled.face!.names.forEach((name, n) => {
    const deltas = mesh.morphs[toFacecapName(name)];
    if (!deltas) return;
    const weights = resampled.face!.tracks[n];
    let moved = 0;
    for (let i = 0; i < weights.length; i++) moved = Math.max(moved, Math.abs(weights[i]));
    if (moved < 0.01) return;
    channels.push({ name, deltas, weights });
  });
  return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, center: mesh.center, height: mesh.height, channels };
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
      <span>Face blendshapes</span>
      <input id="face" type="checkbox" ${converted.face ? "checked" : "disabled"} />
    </label>
    <button id="download" class="button primary">Download FBX</button>
    <p class="note">Trim with the in/out handles on the timeline. Exports binary
      FBX 7.5 (MotionBuilder-compatible); the face head + its morph animation are
      embedded when <strong>Face blendshapes</strong> is on. Verify rotation order
      in your DCC.</p>
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
  const faceChk = document.getElementById("face") as HTMLInputElement;
  const downloadBtn = document.getElementById("download") as HTMLButtonElement;
  const resetBtn = document.getElementById("reset") as HTMLButtonElement;

  const cleanOpts = (): CleanOpts => ({
    despike: despikeChk.checked,
    despikeDeg: Number(despikeDeg.value),
    smooth: smoothChk.checked,
    cutoffHz: Number(cutoff.value),
  });

  function reclean() {
    if (!loaded || !preview) return;
    const opts = cleanOpts();
    loaded.cleaned = opts.despike || opts.smooth ? cleanClip(loaded.converted, opts) : loaded.converted;
    const trim = transport?.getTrim();
    preview.setClip(loaded.cleaned); // duration is unchanged; this resets the pose
    if (trim) preview.setTrim(trim.start, trim.end); // keep the user's trim
  }

  despikeVal.value = `${despikeDeg.value}°`;
  cutoffVal.value = `${cutoff.value} Hz`;
  despikeDeg.addEventListener("input", () => { despikeVal.value = `${despikeDeg.value}°`; });
  cutoff.addEventListener("input", () => { cutoffVal.value = `${cutoff.value} Hz`; });
  for (const c of [despikeChk, smoothChk]) c.addEventListener("change", reclean);
  for (const r of [despikeDeg, cutoff]) r.addEventListener("change", reclean);

  downloadBtn.addEventListener("click", async () => {
    if (!loaded) return;
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Generating…";
    await new Promise((r) => setTimeout(r, 16));
    try {
      const fps = Number(fpsSel.value);
      const trim = transport?.getTrim() ?? { start: 0, end: loaded.cleaned.duration };
      const resampled = resample(loaded.cleaned, fps, trim.start, trim.end);
      const names = remapNames(resampled.names, namesSel.value as NameScheme);
      let face: FaceExport | undefined;
      let headIndex: number | undefined;
      if (faceChk.checked && resampled.face) {
        const mesh = await loadFaceMeshData();
        face = buildFaceExport(resampled, mesh);
        headIndex = resampled.names.indexOf("Head");
      }
      const fbx = writeAnimationFbx(resampled, {
        takeName: sanitizeFilename(loaded.name),
        names,
        tposeRest: restSel.value === "tpose",
        face,
        headIndex,
      });
      downloadBytes(`${sanitizeFilename(loaded.name)}.fbx`, fbx);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Download FBX";
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
    loaded = { name: file.name, clip, converted, cleaned: converted };

    emptyState.hidden = true;
    loadedState.hidden = false;

    if (!preview) preview = new PreviewScene(viewport);
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
