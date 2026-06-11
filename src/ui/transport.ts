import type { PreviewScene, PlaybackState } from "../preview/scene.ts";

export interface Transport {
  element: HTMLElement;
  getTrim(): { start: number; end: number };
  dispose(): void;
}

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds)) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/**
 * Transport bar overlaid on the 3D viewport: play/pause, a click-to-seek
 * timeline with draggable in/out trim handles, and a live playhead.
 */
export function createTransport(preview: PreviewScene, duration: number): Transport {
  let trimStart = 0;
  let trimEnd = duration;
  let scrubbing = false;

  const el = document.createElement("div");
  el.className = "transport-overlay";
  el.innerHTML = `
    <button class="t-btn t-play" aria-label="Play/pause">⏸</button>
    <div class="t-timeline" role="slider" tabindex="0" aria-label="Timeline and trim">
      <div class="t-region"></div>
      <div class="t-handle t-in" aria-label="Trim start"></div>
      <div class="t-handle t-out" aria-label="Trim end"></div>
      <div class="t-playhead"></div>
    </div>
    <span class="t-time">0:00.00 / 0:00.00</span>
    <button class="t-btn t-setin" title="Set trim start to playhead">In</button>
    <button class="t-btn t-setout" title="Set trim end to playhead">Out</button>
    <button class="t-btn t-reset" title="Clear trim">Reset</button>
  `;

  const playBtn = el.querySelector(".t-play") as HTMLButtonElement;
  const timeline = el.querySelector(".t-timeline") as HTMLElement;
  const region = el.querySelector(".t-region") as HTMLElement;
  const inH = el.querySelector(".t-in") as HTMLElement;
  const outH = el.querySelector(".t-out") as HTMLElement;
  const playhead = el.querySelector(".t-playhead") as HTMLElement;
  const timeText = el.querySelector(".t-time") as HTMLElement;

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  function renderTrim() {
    inH.style.left = `${pct(trimStart)}%`;
    outH.style.left = `${pct(trimEnd)}%`;
    region.style.left = `${pct(trimStart)}%`;
    region.style.width = `${pct(trimEnd - trimStart)}%`;
  }
  function applyTrim() {
    preview.setTrim(trimStart, trimEnd);
    renderTrim();
  }

  let lastTime = 0;
  const currentTime = () => lastTime;
  preview.setOnState((s: PlaybackState) => {
    lastTime = s.time;
    playBtn.textContent = s.playing ? "⏸" : "▶";
    playhead.style.left = `${pct(s.time)}%`;
    const len = trimEnd - trimStart;
    timeText.textContent = `${fmt(s.time)} / ${fmt(duration)}  ·  trim ${fmt(len)}`;
  });

  playBtn.addEventListener("click", () => preview.togglePlay());

  const timeAt = (clientX: number): number => {
    const r = timeline.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return frac * duration;
  };

  let dragging: "in" | "out" | "seek" | null = null;
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const t = timeAt(e.clientX);
    if (dragging === "in") trimStart = Math.min(t, trimEnd - 0.01);
    else if (dragging === "out") trimEnd = Math.max(t, trimStart + 0.01);
    else { preview.pause(); preview.seek(t); }
    if (dragging !== "seek") applyTrim();
  };
  const onUp = () => {
    dragging = null;
    scrubbing = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  const startDrag = (kind: "in" | "out" | "seek", e: PointerEvent) => {
    e.preventDefault();
    dragging = kind;
    scrubbing = kind === "seek";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    onMove(e);
  };

  inH.addEventListener("pointerdown", (e) => startDrag("in", e));
  outH.addEventListener("pointerdown", (e) => startDrag("out", e));
  timeline.addEventListener("pointerdown", (e) => {
    if (e.target === inH || e.target === outH) return;
    startDrag("seek", e);
  });

  (el.querySelector(".t-setin") as HTMLButtonElement).addEventListener("click", () => {
    trimStart = Math.min(currentTime(), trimEnd - 0.01);
    applyTrim();
  });
  (el.querySelector(".t-setout") as HTMLButtonElement).addEventListener("click", () => {
    trimEnd = Math.max(currentTime(), trimStart + 0.01);
    applyTrim();
  });
  (el.querySelector(".t-reset") as HTMLButtonElement).addEventListener("click", () => {
    trimStart = 0;
    trimEnd = duration;
    applyTrim();
  });

  void scrubbing;
  renderTrim();
  applyTrim();

  return {
    element: el,
    getTrim: () => ({ start: trimStart, end: trimEnd }),
    dispose: () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      el.remove();
    },
  };
}
