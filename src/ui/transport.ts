import type { PreviewScene, PlaybackState } from "../preview/scene.ts";
import { CurveView, type CurveModel, type CurveCallbacks } from "./curves.ts";

export interface TransportKeyMarker {
  time: number;
  color: string;
  selected: boolean;
  /** In the multi-selection (drag-select / ctrl-click). */
  picked: boolean;
  /** Opaque tag handed back in callbacks (the effector id). */
  tag: string;
}

export interface TransportKeyCallbacks {
  /** Marker clicked (no drag): jump happened; select the effector etc. */
  onClick(marker: TransportKeyMarker, ctrl: boolean): void;
  /** Marker dragged to a new time and released. */
  onRetime(marker: TransportKeyMarker, newTime: number): void;
  /** Right-click on a marker. */
  onContext(marker: TransportKeyMarker, x: number, y: number): void;
  /** Right-click on empty timeline. */
  onContextBlank(x: number, y: number): void;
  /** Shift-drag band select finished over [t0, t1]. */
  onBand(t0: number, t1: number): void;
}

/** One dope-sheet row: an effector's keys on the active layer. */
export interface DopeRow {
  tag: string;
  label: string;
  color: string;
  keys: TransportKeyMarker[];
}

export interface Transport {
  element: HTMLElement;
  getTrim(): { start: number; end: number };
  /** Restore a trim range (scene load). */
  setTrim(start: number, end: number): void;
  /** Wire the Save…/Open… buttons (scene handling lives in the app). */
  setSceneActions(cbs: { save(): void; open(): void }): void;
  /** Show rig-layer key markers on the timeline (replaces the previous set). */
  setKeys(markers: TransportKeyMarker[], cbs?: TransportKeyCallbacks): void;
  /** Mini dope sheet under the strip: per-effector key rows (empty = hidden). */
  setDope(rows: DopeRow[], cbs?: TransportKeyCallbacks): void;
  /** Curve editor under the strip (null = unavailable). */
  setCurves(model: CurveModel | null, cbs: CurveCallbacks | null): void;
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
    <div class="t-main">
      <button class="t-btn t-play" aria-label="Play/pause">⏸</button>
      <div class="t-timeline" role="slider" tabindex="0" aria-label="Timeline and trim">
        <div class="t-region"></div>
        <div class="t-keys"></div>
        <div class="t-handle t-in" aria-label="Trim start"></div>
        <div class="t-handle t-out" aria-label="Trim end"></div>
        <div class="t-playhead"></div>
      </div>
      <span class="t-time">0:00.00 / 0:00.00</span>
      <button class="t-btn t-setin" title="Set trim start to playhead">In</button>
      <button class="t-btn t-setout" title="Set trim end to playhead">Out</button>
      <button class="t-btn t-reset" title="Clear trim">Reset</button>
      <button class="t-btn t-dope-toggle" hidden title="Show/hide per-part key rows">Keys ▾</button>
      <button class="t-btn t-scene-open" title="Open a .wanim recording or a saved .scene.json">Open…</button>
      <button class="t-btn t-scene-save" title="Save the whole session (recording + edits + settings) as a scene file">Save…</button>
    </div>
    <div class="t-dope" hidden>
      <div class="t-dope-rows"></div>
    </div>
  `;

  // Curve editor panel (shares the dock with the dope sheet; created early so
  // the playback-state callback can reference it from the first emit).
  const curveView = new CurveView();
  el.appendChild(curveView.el);

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
    curveView.setPlayhead(s.time);
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
    if (e.shiftKey) {
      // Shift-drag = band-select keys instead of scrubbing.
      e.preventDefault();
      const tA = timeAt(e.clientX);
      const band = document.createElement("div");
      band.className = "t-band";
      timeline.appendChild(band);
      let tB = tA;
      const drawBand = () => {
        const lo = Math.min(tA, tB), hi = Math.max(tA, tB);
        band.style.left = `${pct(lo)}%`;
        band.style.width = `${pct(hi - lo)}%`;
      };
      drawBand();
      const move = (ev: PointerEvent) => { tB = timeAt(ev.clientX); drawBand(); };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        band.remove();
        keyCbs?.onBand(Math.min(tA, tB), Math.max(tA, tB));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
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

  // ---- rig key markers ----------------------------------------------------
  const keysEl = el.querySelector(".t-keys") as HTMLElement;
  let keyCbs: TransportKeyCallbacks | undefined;

  /** One key diamond with the full click/drag/context behavior. */
  function makeKeyDot(m: TransportKeyMarker, cbs?: TransportKeyCallbacks): HTMLSpanElement {
    const dot = document.createElement("span");
    dot.className = "t-key" + (m.selected ? " sel" : "") + (m.picked ? " picked" : "");
    dot.style.left = `${pct(m.time)}%`;
    dot.style.background = m.color;
    dot.title = `${m.tag} key @ ${fmt(m.time)} — click to jump, drag to retime, right-click for options`;
    dot.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cbs?.onContext(m, e.clientX, e.clientY);
    });
    // Click = jump + select; drag past a few px = retime on release.
    dot.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const ctrl = e.ctrlKey || e.metaKey;
      let moved = false;
      let newTime = m.time;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - startX) < 4) return;
        moved = true;
        newTime = timeAt(ev.clientX);
        dot.style.left = `${pct(newTime)}%`;
        preview.pause();
        preview.seek(newTime);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (moved) cbs?.onRetime(m, newTime);
        else {
          if (!ctrl) {
            preview.pause();
            preview.seek(m.time);
          }
          cbs?.onClick(m, ctrl);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    return dot;
  }

  function setKeys(markers: TransportKeyMarker[], cbs?: TransportKeyCallbacks) {
    keyCbs = cbs;
    keysEl.innerHTML = "";
    for (const m of markers) keysEl.appendChild(makeKeyDot(m, cbs));
  }

  // ---- mini dope sheet ------------------------------------------------------
  const dopeEl = el.querySelector(".t-dope") as HTMLElement;
  const dopeRowsEl = el.querySelector(".t-dope-rows") as HTMLElement;
  const dopeToggle = el.querySelector(".t-dope-toggle") as HTMLButtonElement;
  let dopeCount = 0;

  // Rows + curves must line up with the strip: pad to the timeline's range.
  const alignDope = () => {
    const tl = timeline.getBoundingClientRect();
    // Measure against the target element itself — its border-box left doesn't
    // move with its own padding, so this self-corrects in one pass.
    const pad = (target: HTMLElement) => {
      const r = target.getBoundingClientRect();
      const left = Math.max(0, tl.left - r.left);
      const right = Math.max(0, r.right - tl.right);
      target.style.paddingLeft = `${left}px`;
      target.style.paddingRight = `${right}px`;
      target.style.setProperty("--dope-gutter", `${left}px`);
    };
    pad(dopeRowsEl);
    pad(curveView.el);
  };
  const dopeRo = new ResizeObserver(alignDope);
  dopeRo.observe(el);
  dopeRo.observe(timeline);

  // The curve editor and the dope sheet share the dock; one shows at a time.
  let curveAvailable = false;
  let view: "keys" | "curves" | "none" = "keys";

  const syncDopeVisibility = () => {
    dopeEl.hidden = view !== "keys" || dopeCount === 0;
    curveView.el.hidden = view !== "curves" || !curveAvailable;
    dopeToggle.hidden = dopeCount === 0 && !curveAvailable;
    dopeToggle.textContent = view === "keys" ? "Keys ▾" : view === "curves" ? "Curves ▾" : "Panels ▸";
  };
  dopeToggle.addEventListener("click", () => {
    // Cycle: keys → curves → hidden → keys (skipping unavailable views).
    const order: Array<typeof view> = ["keys", "curves", "none"];
    for (let i = 1; i <= order.length; i++) {
      const next = order[(order.indexOf(view) + i) % order.length];
      if (next === "curves" && !curveAvailable) continue;
      if (next === "keys" && dopeCount === 0) continue;
      view = next;
      break;
    }
    syncDopeVisibility();
    alignDope();
  });

  function setDope(rows: DopeRow[], cbs?: TransportKeyCallbacks) {
    dopeCount = rows.length;
    dopeRowsEl.innerHTML = "";
    for (const row of rows) {
      const r = document.createElement("div");
      r.className = "d-row";
      const label = document.createElement("span");
      label.className = "d-label";
      label.textContent = row.label;
      label.style.color = row.color;
      const strip = document.createElement("div");
      strip.className = "d-strip";
      for (const m of row.keys) strip.appendChild(makeKeyDot(m, cbs));
      r.append(label, strip);
      dopeRowsEl.appendChild(r);
    }
    // Visibility first: showing the Keys toggle changes the timeline width,
    // and the alignment has to measure the final layout.
    syncDopeVisibility();
    alignDope();
  }

  function setCurves(model: CurveModel | null, cbs: CurveCallbacks | null) {
    curveAvailable = !!model && model.channels.some((c) => c.keys.length > 0);
    curveView.setModel(model, cbs);
    syncDopeVisibility();
    alignDope();
  }

  // Right-click on empty timeline → paste target etc.
  timeline.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    keyCbs?.onContextBlank(e.clientX, e.clientY);
  });

  return {
    element: el,
    getTrim: () => ({ start: trimStart, end: trimEnd }),
    setTrim: (start: number, end: number) => {
      trimStart = Math.max(0, Math.min(duration, start));
      trimEnd = Math.max(trimStart + 0.01, Math.min(duration, end));
      applyTrim();
    },
    setSceneActions: (cbs) => {
      (el.querySelector(".t-scene-save") as HTMLButtonElement).onclick = () => cbs.save();
      (el.querySelector(".t-scene-open") as HTMLButtonElement).onclick = () => cbs.open();
    },
    setKeys,
    setDope,
    setCurves,
    dispose: () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dopeRo.disconnect();
      curveView.dispose();
      el.remove();
    },
  };
}
