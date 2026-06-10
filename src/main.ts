import "./style.css";
import { parseWanim, BONE_COUNT, type WanimClip } from "./wanim/parse.ts";
import { convertCharacter, resample, type ConvertedClip } from "./convert/clip.ts";
import { writeAnimationFbx } from "./fbx/animationFbx.ts";
import { sanitizeFilename, downloadText } from "./fbx/export.ts";
import { PreviewScene } from "./preview/scene.ts";

const emptyState = document.getElementById("empty-state") as HTMLElement;
const loadedState = document.getElementById("loaded-state") as HTMLElement;
const dropzone = document.getElementById("dropzone") as HTMLElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const errorEl = document.getElementById("empty-error") as HTMLElement;
const viewport = document.getElementById("viewport") as HTMLElement;
const panel = document.getElementById("panel") as HTMLElement;

let preview: PreviewScene | null = null;
let loaded: { name: string; clip: WanimClip; converted: ConvertedClip } | null = null;

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
    ["Characters", String(clip.characters.length)],
    ["Frames", String(frames)],
    ["Duration", fmtTime(converted.duration)],
    ["Average rate", `${fps.toFixed(1)} fps`],
    ["Bones", `${BONE_COUNT} (Unity humanoid)`],
    ["Blendshapes", blendshapeNames.size ? String(blendshapeNames.size) : "none"],
  ];

  panel.innerHTML = `
    <h2>${name}</h2>
    <div class="transport">
      <button id="play" class="button" aria-label="Play/pause">⏸ Pause</button>
      <input id="scrub" class="scrub" type="range" min="0" max="1000" value="0" />
      <span id="timecode" class="timecode">0:00.00</span>
    </div>
    <dl class="stats">
      ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
    </dl>
    <label class="field">
      <span>Export frame rate</span>
      <select id="fps">
        <option value="30">30 fps</option>
        <option value="60" selected>60 fps</option>
        <option value="120">120 fps</option>
      </select>
    </label>
    <button id="download" class="button primary">Download FBX</button>
    <p class="note">Skeletal animation only — blendshapes, mesh, and props are
      not exported. Verify rotation order in your DCC; if limbs twist, see the
      FBX notes.</p>
    <button id="reset" class="button ghost">Load another file</button>
  `;

  const playBtn = document.getElementById("play") as HTMLButtonElement;
  const scrub = document.getElementById("scrub") as HTMLInputElement;
  const timecode = document.getElementById("timecode") as HTMLElement;
  const fpsSel = document.getElementById("fps") as HTMLSelectElement;
  const downloadBtn = document.getElementById("download") as HTMLButtonElement;
  const resetBtn = document.getElementById("reset") as HTMLButtonElement;

  let scrubbing = false;

  preview?.setOnState((s) => {
    playBtn.textContent = s.playing ? "⏸ Pause" : "▶ Play";
    timecode.textContent = `${fmtTime(s.time)} / ${fmtTime(s.duration)}`;
    if (!scrubbing && s.duration > 0) {
      scrub.value = String(Math.round((s.time / s.duration) * 1000));
    }
  });

  playBtn.addEventListener("click", () => preview?.togglePlay());
  scrub.addEventListener("input", () => {
    scrubbing = true;
    preview?.pause();
    const frac = Number(scrub.value) / 1000;
    preview?.seek(frac * converted.duration);
  });
  scrub.addEventListener("change", () => {
    scrubbing = false;
  });

  downloadBtn.addEventListener("click", () => {
    if (!loaded) return;
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Generating…";
    // Defer so the button repaints before the synchronous export runs.
    setTimeout(() => {
      try {
        const fps = Number(fpsSel.value);
        const resampled = resample(loaded!.converted, fps);
        const fbx = writeAnimationFbx(resampled, { takeName: sanitizeFilename(loaded!.name) });
        downloadText(`${sanitizeFilename(loaded!.name)}.fbx`, fbx);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = "Download FBX";
      }
    }, 16);
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
    loaded = { name: file.name, clip, converted };

    emptyState.hidden = true;
    loadedState.hidden = false;

    if (!preview) preview = new PreviewScene(viewport);
    preview.setClip(converted);
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
