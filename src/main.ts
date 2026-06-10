import "./style.css";
import { parseWanim, BONE_COUNT, type WanimClip } from "./wanim/parse.ts";

const emptyState = document.getElementById("empty-state") as HTMLElement;
const loadedState = document.getElementById("loaded-state") as HTMLElement;
const dropzone = document.getElementById("dropzone") as HTMLElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const errorEl = document.getElementById("empty-error") as HTMLElement;
const panel = document.getElementById("panel") as HTMLElement;

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}m ${s.toFixed(1)}s` : `${s.toFixed(2)}s`;
}

function render(name: string, clip: WanimClip) {
  const frames = clip.times.length;
  const duration = frames > 1 ? clip.times[frames - 1] - clip.times[0] : 0;
  const fps = frames > 1 ? (frames - 1) / duration : 0;
  const blendshapeNames = new Set<string>();
  for (const ch of clip.characters) {
    for (const [, framesArr] of Object.entries(ch.blendshapes)) {
      for (const key of Object.keys(framesArr[0] ?? {})) blendshapeNames.add(key);
    }
  }

  const rows: [string, string][] = [
    ["File", name],
    ["Format version", String(clip.version)],
    ["Characters", String(clip.characters.length)],
    ["Frames", String(frames)],
    ["Duration", fmtDuration(duration)],
    ["Average rate", `${fps.toFixed(1)} fps (variable)`],
    ["Bones", `${BONE_COUNT} (Unity humanoid)`],
    ["Blendshapes", blendshapeNames.size ? [...blendshapeNames].join(", ") : "none"],
  ];

  panel.innerHTML = `
    <h2>Recording loaded</h2>
    <dl class="stats">
      ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
    </dl>
    <p class="note">FBX export and 3D preview are in progress — this build verifies the
    <code>.wanim</code> decode pipeline.</p>
    <button id="reset" class="button">Load another file</button>
  `;
  (document.getElementById("reset") as HTMLButtonElement).addEventListener("click", () => {
    loadedState.hidden = true;
    emptyState.hidden = false;
  });

  emptyState.hidden = true;
  loadedState.hidden = false;
}

async function handleFile(file: File) {
  errorEl.hidden = true;
  if (!file.name.toLowerCase().endsWith(".wanim")) {
    showError(`"${file.name}" is not a .wanim file.`);
    return;
  }
  try {
    const clip = parseWanim(await file.arrayBuffer());
    render(file.name, clip);
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

// Whole-page drag & drop, matching VRMxShogun behavior.
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
