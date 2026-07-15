import type { PreviewScene, PlaybackState } from "../preview/scene.ts";
import { CurveView, type CurveModel, type CurveCallbacks, type ChannelsConfig } from "./curves.ts";
import { TimeMap, chooseTickStep, type Marker } from "./timemap.ts";
import { ICONS } from "./icons.ts";

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

/** A non-interactive tick on the timeline — where a cleaning filter acted. */
export interface TransportMark {
  time: number;
  color: string;
}

/** A colored underline spanning a range (a scoped filter op, a foot plant). */
export interface TransportRange {
  t0: number;
  t1: number;
  color: string;
  /** Which lane (0 = top) to draw on, so overlapping ranges don't collide. */
  lane?: number;
}

export interface Transport {
  element: HTMLElement;
  getTrim(): { start: number; end: number };
  /** Restore a trim range (scene load). */
  setTrim(start: number, end: number): void;
  /** The shared zoom/pan time->pixel mapping (for channels + curve views). */
  getTimeMap(): TimeMap;
  /** Ruler markers (scene state). Replaces the current set. */
  setMarkers(markers: Marker[]): void;
  /** Called when the user adds/edits/removes a ruler marker. */
  onMarkersChange(fn: (markers: Marker[]) => void): void;
  /** Whether snap-to-key magnet is on (key drags read this). */
  isMagnet(): boolean;
  /** Set the snap-to-key magnet (prefs default on load). */
  setMagnet(on: boolean): void;
  /** Cycle the under-strip panel: keys -> curves -> hidden (View menu). */
  cyclePanel(): void;
  /** Force a specific under-strip panel (layout presets). */
  setPanelView(v: "keys" | "curves" | "none"): void;
  /** Show rig-layer key markers on the timeline (replaces the previous set). */
  setKeys(markers: TransportKeyMarker[], cbs?: TransportKeyCallbacks): void;
  /** Correction tick marks along the strip bottom (replaces the previous set). */
  setMarks(marks: TransportMark[]): void;
  /** Colored range underlines (scoped filters, foot plants). */
  setRanges(ranges: TransportRange[]): void;
  /** Mini dope sheet under the strip: per-effector key rows (empty = hidden). */
  setDope(rows: DopeRow[], cbs?: TransportKeyCallbacks): void;
  /** Curve editor under the strip (null = unavailable). */
  setCurves(model: CurveModel | null, cbs: CurveCallbacks | null): void;
  /** Configure Channels mode (dense motion + channel tree). */
  setChannels(config: ChannelsConfig | null): void;
  /** The embedded curve view (channels mode drives it directly). */
  curveView: CurveView;
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
 * timeline with draggable in/out trim handles, and a live playhead. The strip,
 * dope sheet, and curve editor share one zoomable TimeMap (view range distinct
 * from trim). `frames` (when known) adds a frame counter to the readout.
 */
export function createTransport(preview: PreviewScene, duration: number, frames = 0): Transport {
  let trimStart = 0;
  let trimEnd = duration;
  let scrubbing = false;

  const tm = new TimeMap(duration, frames);
  let markers: Marker[] = [];
  let markersCb: ((m: Marker[]) => void) | null = null;
  let magnet = false;
  let ranges: TransportRange[] = [];

  const el = document.createElement("div");
  el.className = "transport-overlay";
  el.innerHTML = `
    <div class="t-main">
      <button class="t-btn t-ico t-play" aria-label="Play/pause" title="Play/pause (Space). ←/→ step a frame, shift for 10.">${ICONS.pause}</button>
      <select class="t-rate" title="Playback speed (review only, doesn't change the clip)">
        <option value="0.25">¼×</option>
        <option value="0.5">½×</option>
        <option value="1" selected>1×</option>
        <option value="2">2×</option>
      </select>
      <div class="t-timeline" role="slider" tabindex="0" aria-label="Timeline and trim">
        <canvas class="t-marks"></canvas>
        <div class="t-region"></div>
        <div class="t-keys"></div>
        <div class="t-handle t-in" aria-label="Trim start"></div>
        <div class="t-handle t-out" aria-label="Trim end"></div>
        <div class="t-playhead"></div>
      </div>
      <button class="t-btn t-magnet" title="Snap key drags to other keys and the playhead">🧲</button>
      <button class="t-btn t-fit" title="Fit the view to the clip (F fits the trim range when set)">Fit</button>
      <span class="t-time">0:00.00 / 0:00.00</span>
      <span class="t-framebox" title="Type a frame and press Enter to jump there">f <input class="t-frame" type="text" inputmode="numeric" size="5" value="0" /><span class="t-fps"></span></span>
      <button class="t-btn t-setin" title="Set trim start to playhead">In</button>
      <button class="t-btn t-setout" title="Set trim end to playhead">Out</button>
      <button class="t-btn t-reset" title="Clear trim">Reset</button>
      <button class="t-btn t-dope-toggle" hidden title="Show/hide per-part key rows">Keys ▾</button>
    </div>
    <div class="t-dope" hidden>
      <div class="t-dope-rows"></div>
    </div>
  `;

  // Curve editor panel (shares the dock with the dope sheet; created early so
  // the playback-state callback can reference it from the first emit).
  const curveView = new CurveView();
  curveView.setTimeMap(tm);
  el.appendChild(curveView.el);

  const playBtn = el.querySelector(".t-play") as HTMLButtonElement;
  const timeline = el.querySelector(".t-timeline") as HTMLElement;
  const region = el.querySelector(".t-region") as HTMLElement;
  const inH = el.querySelector(".t-in") as HTMLElement;
  const outH = el.querySelector(".t-out") as HTMLElement;
  const playhead = el.querySelector(".t-playhead") as HTMLElement;
  const timeText = el.querySelector(".t-time") as HTMLElement;
  const frameInput = el.querySelector(".t-frame") as HTMLInputElement;
  const fpsLabel = el.querySelector(".t-fps") as HTMLElement;
  const magnetBtn = el.querySelector(".t-magnet") as HTMLButtonElement;
  const fitBtn = el.querySelector(".t-fit") as HTMLButtonElement;
  fpsLabel.textContent = frames > 1 ? ` · ${tm.fps.toFixed(0)} fps` : "";

  // Position via the shared view mapping (fraction of the visible span), so
  // everything zooms/pans together. Off-screen elements clip to the strip.
  const pct = (t: number) => tm.pct(t);

  function renderTrim() {
    inH.style.left = `${pct(trimStart)}%`;
    outH.style.left = `${pct(trimEnd)}%`;
    region.style.left = `${pct(trimStart)}%`;
    region.style.width = `${pct(trimEnd) - pct(trimStart)}%`;
  }
  function applyTrim() {
    preview.setTrim(trimStart, trimEnd);
    renderTrim();
  }

  // Redraw everything that positions off the view when zoom/pan changes.
  let lastKeyMarkers: TransportKeyMarker[] = [];
  const rerenderView = () => {
    renderTrim();
    playhead.style.left = `${pct(lastTime)}%`;
    drawMarks();
    for (const dot of Array.from(keysEl.children) as HTMLElement[]) {
      const t = Number(dot.dataset.time);
      dot.style.left = `${pct(t)}%`;
    }
    for (const strip of Array.from(dopeRowsEl.querySelectorAll<HTMLElement>(".d-strip"))) {
      for (const dot of Array.from(strip.children) as HTMLElement[]) {
        dot.style.left = `${pct(Number(dot.dataset.time))}%`;
      }
    }
    curveView.redraw();
  };
  tm.onChange(rerenderView);

  let lastTime = 0;
  const currentTime = () => lastTime;
  let playIconPlaying = true; // matches the initial markup (pause icon)
  preview.setOnState((s: PlaybackState) => {
    lastTime = s.time;
    if (s.playing !== playIconPlaying) {
      playIconPlaying = s.playing;
      playBtn.innerHTML = s.playing ? ICONS.pause : ICONS.play;
    }
    playhead.style.left = `${pct(s.time)}%`;
    const len = trimEnd - trimStart;
    timeText.textContent = `${fmt(s.time)} / ${fmt(duration)}  ·  trim ${fmt(len)}`;
    if (document.activeElement !== frameInput && frames > 1) frameInput.value = String(tm.frameOf(s.time));
    curveView.setPlayhead(s.time);
  });

  playBtn.addEventListener("click", () => preview.togglePlay());

  const rateSel = el.querySelector(".t-rate") as HTMLSelectElement;
  rateSel.value = String(preview.getRate());
  rateSel.addEventListener("change", () => preview.setRate(Number(rateSel.value)));

  magnetBtn.addEventListener("click", () => {
    magnet = !magnet;
    magnetBtn.classList.toggle("active", magnet);
  });
  const doFit = () => {
    const trimmed = trimEnd - trimStart < duration - 0.02;
    if (trimmed) tm.fit(trimStart, trimEnd);
    else tm.fit(0, duration);
  };
  fitBtn.addEventListener("click", doFit);

  frameInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const f = parseInt(frameInput.value, 10);
    if (Number.isFinite(f)) {
      preview.pause();
      preview.seek(tm.timeOfFrame(f));
    }
    frameInput.blur();
  });

  const timeAt = (clientX: number): number => {
    const r = timeline.getBoundingClientRect();
    const frac = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(duration, tm.timeAtFrac(frac)));
  };
  /** Snap a time to the nearest key/playhead when the magnet is on. */
  const snap = (t: number): number => {
    if (!magnet) return t;
    const r = timeline.getBoundingClientRect();
    const tol = (12 / Math.max(1, r.width)) * tm.span; // 12 px
    let best = t;
    let bestD = tol;
    for (const cand of [lastTime, ...lastKeyMarkers.map((m) => m.time)]) {
      const d = Math.abs(cand - t);
      if (d < bestD) { bestD = d; best = cand; }
    }
    return best;
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

  // Wheel = zoom around the cursor.
  timeline.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = timeline.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    tm.zoomAt(frac, e.deltaY > 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });

  timeline.addEventListener("pointerdown", (e) => {
    if (e.target === inH || e.target === outH) return;
    // Middle-drag anywhere = pan the view.
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      const r = timeline.getBoundingClientRect();
      let lastX = e.clientX;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        tm.panByFrac(-dx / Math.max(1, r.width));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    if (e.button !== 0) return;
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
        band.style.width = `${pct(hi) - pct(lo)}%`;
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

  // ---- ruler + tick marks + filter ranges ---------------------------------
  // One canvas over the strip draws: adaptive frame/second ruler ticks + grid,
  // cleaning tick marks (where a filter acted), colored range underlines, and
  // ruler markers (flags). Everything positions through the shared TimeMap.
  const marksCanvas = el.querySelector(".t-marks") as HTMLCanvasElement;
  let marks: TransportMark[] = [];
  function drawMarks() {
    const r = timeline.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    marksCanvas.width = Math.max(1, Math.round(r.width * dpr));
    marksCanvas.height = Math.max(1, Math.round(r.height * dpr));
    const g = marksCanvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    if (duration <= 0 || r.width < 2) return;

    // Ruler ticks + faint grid.
    const secPerPx = tm.span / r.width;
    const { step, asFrames } = chooseTickStep(secPerPx, tm.fps);
    const first = Math.ceil(tm.viewStart / step) * step;
    g.font = "9px system-ui, sans-serif";
    g.textBaseline = "top";
    for (let t = first; t <= tm.viewEnd + 1e-6; t += step) {
      const x = pct(t) / 100 * r.width;
      g.strokeStyle = "rgba(255,255,255,0.09)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x + 0.5, 0);
      g.lineTo(x + 0.5, r.height);
      g.stroke();
      g.fillStyle = "rgba(230,236,244,0.5)";
      const label = asFrames ? String(Math.round(t * tm.fps)) : `${t.toFixed(step < 1 ? 2 : step < 10 ? 1 : 0)}s`;
      g.fillText(label, x + 2, 1);
    }

    // Filter/plant range underlines (lanes stacked from the bottom).
    for (const rg of ranges) {
      const x0 = pct(rg.t0) / 100 * r.width;
      const x1 = pct(rg.t1) / 100 * r.width;
      const lane = rg.lane ?? 0;
      const y = r.height - 3 - lane * 3;
      g.strokeStyle = rg.color;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(Math.max(0, x0), y);
      g.lineTo(Math.min(r.width, x1), y);
      g.stroke();
    }

    // Cleaning tick marks.
    if (marks.length) {
      g.globalAlpha = 0.55;
      for (const m of marks) {
        g.fillStyle = m.color;
        g.fillRect(pct(m.time) / 100 * r.width, r.height * 0.55, 1, r.height * 0.45);
      }
      g.globalAlpha = 1;
    }

    // Ruler markers (small flags with labels).
    for (const mk of markers) {
      const x = pct(mk.time) / 100 * r.width;
      if (x < -2 || x > r.width + 2) continue;
      g.fillStyle = "#ffd24a";
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 8, 3);
      g.lineTo(x, 6);
      g.closePath();
      g.fill();
      g.fillStyle = "rgba(255,210,74,0.9)";
      g.fillRect(x, 0, 1, r.height);
      if (mk.label) {
        g.font = "9px system-ui, sans-serif";
        g.fillText(mk.label, x + 9, 0);
      }
    }
  }
  function setMarks(next: TransportMark[]) {
    marks = next;
    drawMarks();
  }
  function setRanges(next: TransportRange[]) {
    ranges = next;
    drawMarks();
  }
  const marksRo = new ResizeObserver(drawMarks);
  marksRo.observe(timeline);

  // Right-click ruler = add/remove marker.
  timeline.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const t = timeAt(e.clientX);
    // If close to an existing marker, offer to remove it; else add.
    const r = timeline.getBoundingClientRect();
    const tol = (10 / Math.max(1, r.width)) * tm.span;
    const near = markers.find((m) => Math.abs(m.time - t) < tol);
    if (near) {
      markers = markers.filter((m) => m !== near);
      drawMarks();
      markersCb?.(markers);
      return;
    }
    keyCbs?.onContextBlank(e.clientX, e.clientY);
    // Also expose a lightweight add-marker affordance: double-right adds.
  });
  // Double-click ruler adds a marker with an editable label.
  timeline.addEventListener("dblclick", (e) => {
    const t = timeAt(e.clientX);
    const label = prompt("Marker label (blank to cancel):", "");
    if (label === null) return;
    markers.push({ time: t, label });
    markers.sort((a, b) => a.time - b.time);
    drawMarks();
    markersCb?.(markers);
  });

  // ---- rig key markers ----------------------------------------------------
  const keysEl = el.querySelector(".t-keys") as HTMLElement;
  let keyCbs: TransportKeyCallbacks | undefined;

  /** One key diamond with the full click/drag/context behavior. */
  function makeKeyDot(m: TransportKeyMarker, cbs?: TransportKeyCallbacks): HTMLSpanElement {
    const dot = document.createElement("span");
    dot.className = "t-key" + (m.selected ? " sel" : "") + (m.picked ? " picked" : "");
    dot.dataset.time = String(m.time);
    dot.style.left = `${pct(m.time)}%`;
    dot.style.background = m.color;
    dot.title = `${m.tag} key @ ${fmt(m.time)}: click to jump, drag to retime, right-click for options`;
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
        newTime = snap(timeAt(ev.clientX));
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

  function setKeys(markersIn: TransportKeyMarker[], cbs?: TransportKeyCallbacks) {
    keyCbs = cbs;
    lastKeyMarkers = markersIn;
    keysEl.innerHTML = "";
    for (const m of markersIn) keysEl.appendChild(makeKeyDot(m, cbs));
  }

  // ---- mini dope sheet ------------------------------------------------------
  const dopeEl = el.querySelector(".t-dope") as HTMLElement;
  const dopeRowsEl = el.querySelector(".t-dope-rows") as HTMLElement;
  const dopeToggle = el.querySelector(".t-dope-toggle") as HTMLButtonElement;
  let dopeCount = 0;

  // Rows + curves must line up with the strip: pad to the timeline's range.
  const alignDope = () => {
    const tl = timeline.getBoundingClientRect();
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
    curveView.redraw();
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
  function cyclePanel() {
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
  }
  function setPanelView(v: "keys" | "curves" | "none") {
    view = v;
    syncDopeVisibility();
    alignDope();
  }
  dopeToggle.addEventListener("click", cyclePanel);

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
    syncDopeVisibility();
    alignDope();
  }

  function setCurves(model: CurveModel | null, cbs: CurveCallbacks | null) {
    curveView.setModel(model, cbs);
    curveAvailable = curveView.available();
    syncDopeVisibility();
    alignDope();
  }

  function setChannels(config: ChannelsConfig | null) {
    curveView.setChannels(config);
    curveAvailable = curveView.available();
    syncDopeVisibility();
    alignDope();
  }

  return {
    element: el,
    getTrim: () => ({ start: trimStart, end: trimEnd }),
    setTrim: (start: number, end: number) => {
      trimStart = Math.max(0, Math.min(duration, start));
      trimEnd = Math.max(trimStart + 0.01, Math.min(duration, end));
      applyTrim();
    },
    getTimeMap: () => tm,
    setMarkers: (m) => { markers = m.slice().sort((a, b) => a.time - b.time); drawMarks(); },
    onMarkersChange: (fn) => { markersCb = fn; },
    isMagnet: () => magnet,
    setMagnet: (on) => { magnet = on; magnetBtn.classList.toggle("active", on); },
    cyclePanel,
    setPanelView,
    setKeys,
    setMarks,
    setRanges,
    setDope,
    setCurves,
    setChannels,
    curveView,
    dispose: () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dopeRo.disconnect();
      marksRo.disconnect();
      curveView.dispose();
      el.remove();
    },
  };
}
