// Canvas graph editor for the control-rig layer keys: the selected effector's
// position deltas (cm) and rotation deltas (ZYX euler, degrees) as per-axis
// curves. Keys drag VERTICALLY to change value (retiming stays on the
// timeline strips); right-click sets easing or deletes. The view samples the
// same easing the engine uses, so what you see is what bakes.

import type { TimeMap } from "./timemap.ts";
import { ChannelTree, type ChannelGroup } from "./channels.ts";
import { clampRetimeDelta } from "../rig/rig.ts";

export type CurveEase = "linear" | "smooth" | "step";

/** One dense baked-motion channel: a per-frame value track (already unwrapped). */
export interface DenseChannel {
  key: string;
  label: string;
  color: string;
  group: "pos" | "rot";
  axis: 0 | 1 | 2;
  /** Per-frame values aligned to the clip's `times` (degrees or cm). */
  values: Float32Array;
}

export interface DenseModel {
  times: number[];
  channels: DenseChannel[];
}

/** Right-click info for Channels mode (dense curves — a span, not keys). */
export interface ChannelsContextInfo {
  x: number;
  y: number;
  /** Time under the cursor. */
  time: number;
  /** Band-selected span (frame-snapped), or null when none. */
  span: { t0: number; t1: number } | null;
}

/** Host hooks for Channels mode (dense motion curves). */
export interface ChannelsConfig {
  groups: ChannelGroup[];
  /** Dense curves for a bone set (post clean+mods+layers — what exports). */
  provider(bones: string[]): DenseModel;
  /** Uncleaned source curves for the same bones (compare ghost); null if n/a. */
  compareProvider(bones: string[]): DenseModel | null;
  /** Selection changed in the tree (filters + key-reduce consume it too). */
  onSelect(bones: Set<string>): void;
  /** Click-empty seek (Channels mode has no keys to edit). */
  onSeek(t: number): void;
  /** Right-click: host shows the scoped-filter menu for the span/cursor. */
  onContext(info: ChannelsContextInfo): void;
  /** Brush stroke finished: ONE moving-average op over the stroked span. */
  onBrushSpan?(span: { t0: number; t1: number }): void;
}

export interface CurveKey {
  time: number;
  value: number;
  ease: CurveEase;
}

export interface CurveChannel {
  group: "pos" | "rot";
  axis: 0 | 1 | 2;
  label: string;
  color: string;
  keys: CurveKey[];
}

export interface CurveModel {
  duration: number;
  title: string;
  channels: CurveChannel[];
}

/** A selected key, identified by channel + time (survives model rebuilds). */
export interface CurveKeyRef {
  group: "pos" | "rot";
  axis: 0 | 1 | 2;
  time: number;
}

/** Everything the host needs to build the right-click menu. */
export interface CurveContextInfo {
  /** Screen position for the menu. */
  x: number;
  y: number;
  /** Time under the cursor. */
  time: number;
  /** Selected keys (the key under the cursor when nothing was selected). */
  keys: CurveKeyRef[];
  /** Time span of `keys`; null when nothing is selected. */
  span: { t0: number; t1: number } | null;
}

export interface CurveCallbacks {
  /** Vertical drag started on a key (push undo history once). */
  onValueStart(): void;
  /** Live value change (write key + fast rebake; do NOT rebuild the view). */
  onValue(group: "pos" | "rot", axis: number, time: number, value: number): void;
  /** Drag finished (refresh surrounding UI). */
  onValueEnd(): void;
  onSeek(t: number): void;
  /** Right-click: host shows its menu for the selection/cursor. */
  onContext(info: CurveContextInfo): void;
  /** Brush tick: small-amount smooth over the keys in [t0,t1] (throttled). */
  onBrush?(span: { t0: number; t1: number }, amount: number): void;
  /** Retime commit (one per drag): selected keys moved per unique time. */
  onRetime?(moves: Array<{ from: number; to: number }>): void;
}

const HEIGHT = 150;
const PAD_TOP = 10;
const PAD_BOTTOM = 16;
/** Smooth-brush radius in canvas pixels. */
const BRUSH_R = 20;

export class CurveView {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private model: CurveModel | null = null;
  private cbs: CurveCallbacks | null = null;
  private playhead = 0;
  /** Independent value scale per group — cm and degrees don't share an axis. */
  private scales: Record<"pos" | "rot", { min: number; max: number }> = {
    pos: { min: -1, max: 1 },
    rot: { min: -1, max: 1 },
  };
  private drag: {
    targets: Array<{ ch: CurveChannel; key: CurveKey; startValue: number }>;
    primary: { ch: CurveChannel; key: CurveKey };
    startY: number;
  } | null = null;
  private hover: { ch: CurveChannel; key: CurveKey } | null = null;
  /** Drag tool: Select (marquee/value drags), Brush (paint smooth), Retime. */
  private tool: "select" | "brush" | "retime" = "select";
  /** Held R = temporary Retime (spring-loaded, like the gizmo hotkeys). */
  private rHeld = false;
  private toolRow: HTMLDivElement;
  /** Brush cursor position in canvas coords (drawn as a circle). */
  private brushPt: { x: number; y: number } | null = null;
  /** Channels-mode brush stroke: the accumulated time span so far. */
  private brushStroke: { t0: number; t1: number } | null = null;
  /** Retime drag state (blocks setModel like value drags do). */
  private timeDrag: {
    targets: Array<{ ch: CurveChannel; key: CurveKey; startTime: number }>;
    dt: number;
  } | null = null;
  /** Box-scale drag state (blocks setModel like value drags do). */
  private boxScale = false;
  private onKeyDown: (e: KeyboardEvent) => void;
  private onKeyUp: (e: KeyboardEvent) => void;
  /** Selected keys as stable refs (model rebuilds swap the key objects). */
  private selected = new Set<string>();
  /** Marquee rectangle while band-selecting, in canvas coordinates. */
  private band: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Channels-mode band selection: a time span for scoped filters. */
  private chanSpan: { t0: number; t1: number } | null = null;
  private ro: ResizeObserver;
  /** Shared zoom/pan mapping; when set, time->x goes through the view range. */
  private tm: TimeMap | null = null;

  // ---- Channels mode (dense baked motion) ---------------------------------
  private mode: "corrections" | "channels" = "corrections";
  private channels: ChannelsConfig | null = null;
  private tree: ChannelTree;
  private side: HTMLDivElement;
  private modeRow: HTMLDivElement;
  private axisRow: HTMLDivElement;
  private axisVis: [boolean, boolean, boolean] = [true, true, true];
  private dense: DenseModel | null = null;
  private denseCompare: DenseModel | null = null;
  private compareHeld = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "t-curves";
    this.el.hidden = true;

    // Left gutter panel: mode toggle, axis toggles, and the channel tree. It
    // sits in the padding gutter (left of the strip-aligned canvas), so the
    // graph still lines up with the timeline strip.
    this.side = document.createElement("div");
    this.side.className = "cv-side";
    this.modeRow = document.createElement("div");
    this.modeRow.className = "cv-mode";
    this.modeRow.hidden = true; // shown once channels are configured
    for (const m of ["corrections", "channels"] as const) {
      const b = document.createElement("button");
      b.dataset.mode = m;
      b.textContent = m === "corrections" ? "Corrections" : "Channels";
      b.addEventListener("click", () => this.setMode(m));
      this.modeRow.appendChild(b);
    }
    this.toolRow = document.createElement("div");
    this.toolRow.className = "cv-tools";
    for (const t of ["select", "brush", "retime"] as const) {
      const b = document.createElement("button");
      b.dataset.tool = t;
      b.textContent = t[0].toUpperCase() + t.slice(1);
      b.title =
        t === "select" ? "Drag = marquee select; drag keys vertically"
        : t === "brush" ? "Paint over keys to smooth them (Esc to exit)"
        : "Drag selected keys horizontally to retime (hold R for a quick switch)";
      b.addEventListener("click", () => this.setTool(t));
      this.toolRow.appendChild(b);
    }
    this.axisRow = document.createElement("div");
    this.axisRow.className = "cv-axes";
    this.axisRow.hidden = true;
    (["X", "Y", "Z"] as const).forEach((ax, i) => {
      const b = document.createElement("button");
      b.textContent = ax;
      b.className = "cv-axis on";
      b.addEventListener("click", () => {
        this.axisVis[i] = !this.axisVis[i];
        b.classList.toggle("on", this.axisVis[i]);
        this.fitScale();
        this.draw();
      });
      this.axisRow.appendChild(b);
    });
    this.tree = new ChannelTree();
    this.tree.el.hidden = true;
    this.side.append(this.modeRow, this.toolRow, this.axisRow, this.tree.el);
    this.el.appendChild(this.side);

    // Esc leaves the current tool / clears the selection; holding R is a
    // spring-loaded Retime (Corrections mode). Text fields keep their keys.
    this.onKeyDown = (e: KeyboardEvent) => {
      if (this.el.hidden) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        if (this.tool !== "select") this.setTool("select");
        else if (this.selected.size) {
          this.selected.clear();
          this.draw();
        }
      } else if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        this.rHeld = true;
        this.syncToolUi();
      }
    };
    this.onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "r" || e.key === "R") {
        this.rHeld = false;
        this.syncToolUi();
      }
    };
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = `${HEIGHT}px`;
    this.canvas.style.display = "block";
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);

    this.canvas.addEventListener("pointerdown", (e) => {
      // Middle-drag (or Alt+left) pans the shared view in either mode.
      if (this.tm && (e.button === 1 || (e.button === 0 && e.altKey))) {
        e.preventDefault();
        const w = Math.max(1, this.canvas.getBoundingClientRect().width);
        let lastX = e.clientX;
        const move = (ev: PointerEvent) => {
          this.tm!.panByFrac(-(ev.clientX - lastX) / w);
          lastX = ev.clientX;
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
      // Brush paints in either mode and suppresses marquee/seek entirely.
      if (this.effTool() === "brush") {
        this.beginBrush(e);
        return;
      }
      // Channels mode: drag = band-select a time span (scoped-filter target);
      // a still click seeks and clears the span. No key editing here.
      if (this.mode === "channels") {
        e.preventDefault();
        const r = this.canvas.getBoundingClientRect();
        const x0 = e.clientX - r.left;
        const move = (ev: PointerEvent) => {
          this.band = { x0, y0: 0, x1: ev.clientX - r.left, y1: HEIGHT };
          this.draw();
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          const x1 = ev.clientX - r.left;
          if (Math.abs(x1 - x0) > 3) {
            const tA = this.snapToFrame(this.timeAtX(Math.min(x0, x1), r.width));
            const tB = this.snapToFrame(this.timeAtX(Math.max(x0, x1), r.width));
            if (tB - tA > 1e-6) this.chanSpan = { t0: tA, t1: tB };
          } else {
            this.chanSpan = null;
            this.channels?.onSeek(this.timeAtX(x1, r.width));
          }
          this.band = null;
          this.draw();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        return;
      }
      if (!this.model || !this.cbs) return;
      if (this.effTool() === "retime") {
        this.beginRetime(e);
        return;
      }
      // Selection-box edge handles beat key picking (they overlap keys).
      const edge = this.pickBoxEdge(e);
      if (edge) {
        this.beginBoxScale(e, edge);
        return;
      }
      const hit = this.pickKey(e);
      if (hit) {
        e.preventDefault();
        // Clicking an unselected key focuses it (shift adds to the selection);
        // clicking a selected key drags the whole selection together.
        const ref = this.refOf(hit.ch, hit.key);
        if (!this.selected.has(ref)) {
          if (!e.shiftKey) this.selected.clear();
          this.selected.add(ref);
        }
        this.beginValueDrag(e, hit);
      } else if (this.pointInBox(e)) {
        // Inside the selection box but not on a key: offset the whole selection.
        e.preventDefault();
        const sel = this.selectedKeys();
        if (sel.length) this.beginValueDrag(e, sel[0]);
      } else {
        // Empty drag = marquee select; a still click seeks instead.
        e.preventDefault();
        const r = this.canvas.getBoundingClientRect();
        const x0 = e.clientX - r.left;
        const y0 = e.clientY - r.top;
        const additive = e.shiftKey;
        const move = (ev: PointerEvent) => {
          this.band = { x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top };
          this.draw();
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          const moved = Math.hypot(ev.clientX - r.left - x0, ev.clientY - r.top - y0) > 3;
          if (moved && this.band) {
            if (!additive) this.selected.clear();
            for (const { ch, key } of this.keysInBand(this.band)) this.selected.add(this.refOf(ch, key));
          } else {
            if (!additive) this.selected.clear();
            this.cbs?.onSeek(this.timeAt(ev));
          }
          this.band = null;
          this.draw();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.effTool() === "brush") {
        // Track the pointer for the brush-circle cursor even between strokes.
        const r = this.canvas.getBoundingClientRect();
        this.brushPt = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.canvas.style.cursor = "none";
        if (!this.brushStroke) this.draw();
        return;
      }
      if (this.drag || this.timeDrag || this.boxScale || this.band || this.mode === "channels") return;
      if (this.effTool() === "retime") {
        this.canvas.style.cursor = this.pickKey(e) ? "ew-resize" : "default";
        return;
      }
      if (this.pickBoxEdge(e)) {
        this.canvas.style.cursor = "ns-resize";
        if (this.hover) {
          this.hover = null;
          this.draw();
        }
        return;
      }
      const hit = this.pickKey(e);
      if (hit?.key !== this.hover?.key) {
        this.hover = hit;
        this.canvas.style.cursor = hit ? "ns-resize" : this.pointInBox(e) ? "move" : "default";
        this.draw();
      } else if (!hit) {
        this.canvas.style.cursor = this.pointInBox(e) ? "move" : "default";
      }
    });
    this.canvas.addEventListener("pointerleave", () => {
      if (this.brushPt && !this.brushStroke) {
        this.brushPt = null;
        this.draw();
      }
    });
    // Wheel = zoom the shared view around the cursor, same as the strip.
    this.canvas.addEventListener("wheel", (e) => {
      if (!this.tm) return;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const frac = (e.clientX - r.left) / Math.max(1, r.width);
      this.tm.zoomAt(frac, e.deltaY > 0 ? 1.2 : 1 / 1.2);
      this.draw();
    }, { passive: false });
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.mode === "channels") {
        this.channels?.onContext({
          x: e.clientX,
          y: e.clientY,
          time: this.timeAt(e),
          span: this.chanSpan ? { ...this.chanSpan } : null,
        });
        return;
      }
      if (!this.model || !this.cbs) return;
      // Right-click on an unselected key focuses it first.
      const hit = this.pickKey(e);
      if (hit && !this.selected.has(this.refOf(hit.ch, hit.key))) {
        this.selected.clear();
        this.selected.add(this.refOf(hit.ch, hit.key));
        this.draw();
      }
      const keys: CurveKeyRef[] = this.selectedKeys().map(({ ch, key }) => ({ group: ch.group, axis: ch.axis, time: key.time }));
      const span = keys.length
        ? { t0: Math.min(...keys.map((k) => k.time)), t1: Math.max(...keys.map((k) => k.time)) }
        : null;
      this.cbs.onContext({ x: e.clientX, y: e.clientY, time: this.timeAt(e), keys, span });
    });
  }

  // ---- selection -----------------------------------------------------------
  private refOf(ch: CurveChannel, key: CurveKey): string {
    return `${ch.group}${ch.axis}@${key.time.toFixed(4)}`;
  }
  private selectedKeys(): Array<{ ch: CurveChannel; key: CurveKey }> {
    const out: Array<{ ch: CurveChannel; key: CurveKey }> = [];
    for (const ch of this.model?.channels ?? []) {
      for (const key of ch.keys) if (this.selected.has(this.refOf(ch, key))) out.push({ ch, key });
    }
    return out;
  }
  private keysInBand(band: { x0: number; y0: number; x1: number; y1: number }): Array<{ ch: CurveChannel; key: CurveKey }> {
    const lo = { x: Math.min(band.x0, band.x1), y: Math.min(band.y0, band.y1) };
    const hi = { x: Math.max(band.x0, band.x1), y: Math.max(band.y0, band.y1) };
    const out: Array<{ ch: CurveChannel; key: CurveKey }> = [];
    for (const ch of this.model?.channels ?? []) {
      for (const key of ch.keys) {
        const kx = this.x(key.time);
        const ky = this.y(key.value, ch.group);
        if (kx >= lo.x && kx <= hi.x && ky >= lo.y && ky <= hi.y) out.push({ ch, key });
      }
    }
    return out;
  }

  // ---- tools (value drag / brush / retime / transform box) -----------------
  /** Held R springs Select into Retime without touching the sticky tool. */
  private effTool(): "select" | "brush" | "retime" {
    if (this.rHeld && this.mode === "corrections" && this.tool === "select") return "retime";
    return this.tool;
  }

  private setTool(t: "select" | "brush" | "retime") {
    if (t === "retime" && this.mode === "channels") return;
    this.tool = t;
    this.brushPt = null;
    this.syncToolUi();
    this.draw();
  }

  private syncToolUi() {
    const eff = this.effTool();
    for (const b of Array.from(this.toolRow.children) as HTMLButtonElement[]) {
      b.classList.toggle("active", b.dataset.tool === eff);
      if (b.dataset.tool === "retime") b.disabled = this.mode === "channels";
    }
    this.canvas.style.cursor = eff === "brush" ? "none" : eff === "retime" ? "ew-resize" : "default";
    if (eff !== "brush" && this.brushPt) {
      this.brushPt = null;
      this.draw();
    }
  }

  /** Drag the selection vertically (shared by key drags and box-body drags). */
  private beginValueDrag(e: PointerEvent, primary: { ch: CurveChannel; key: CurveKey }) {
    if (!this.cbs) return;
    const targets = this.selectedKeys().map((t) => ({ ...t, startValue: t.key.value }));
    this.drag = { targets, primary, startY: e.clientY };
    this.cbs.onValueStart();
    const move = (ev: PointerEvent) => {
      if (!this.drag) return;
      for (const t of this.drag.targets) {
        t.key.value = t.startValue + (this.drag.startY - ev.clientY) * this.valuePerPx(t.ch.group);
        this.cbs!.onValue(t.ch.group, t.ch.axis, t.key.time, t.key.value);
      }
      this.draw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (this.drag) {
        this.drag = null;
        this.cbs?.onValueEnd();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Pixel bbox around the selection (≥2 keys, Corrections mode) — the C3 box. */
  private selBox(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.mode !== "corrections" || this.selected.size < 2) return null;
    const sel = this.selectedKeys();
    if (sel.length < 2) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { ch, key } of sel) {
      const kx = this.x(key.time);
      const ky = this.y(key.value, ch.group);
      if (kx < x0) x0 = kx;
      if (kx > x1) x1 = kx;
      if (ky < y0) y0 = ky;
      if (ky > y1) y1 = ky;
    }
    return { x0: x0 - 8, y0: y0 - 8, x1: x1 + 8, y1: y1 + 8 };
  }

  private pickBoxEdge(e: PointerEvent): "top" | "bottom" | null {
    if (this.effTool() !== "select") return null;
    const box = this.selBox();
    if (!box) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (px < box.x0 - 4 || px > box.x1 + 4) return null;
    if (Math.abs(py - box.y0) <= 5) return "top";
    if (Math.abs(py - box.y1) <= 5) return "bottom";
    return null;
  }

  private pointInBox(e: PointerEvent): boolean {
    if (this.effTool() !== "select") return false;
    const box = this.selBox();
    if (!box) return false;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    return px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1;
  }

  /** Inverse of y(): canvas y -> value in the group's own scale. */
  private valueAtY(py: number, group: "pos" | "rot"): number {
    const s = this.scales[group];
    const h = HEIGHT - PAD_TOP - PAD_BOTTOM;
    return s.min + (1 - (py - PAD_TOP) / Math.max(1, h)) * (s.max - s.min);
  }

  /**
   * Drag a box edge: scale the selected VALUES about the opposite edge. The
   * factor is uniform (pixels), but each key scales about its own group's
   * pivot VALUE — pos (cm) and rot (°) sit on independent y-scales, so a
   * shared pixel pivot would mean different, warped value pivots per group.
   */
  private beginBoxScale(e: PointerEvent, edge: "top" | "bottom") {
    if (!this.cbs) return;
    e.preventDefault();
    const box = this.selBox()!;
    const r = this.canvas.getBoundingClientRect();
    const pivotY = edge === "top" ? box.y1 : box.y0;
    const edgeY = edge === "top" ? box.y0 : box.y1;
    const pivotVal = {
      pos: this.valueAtY(pivotY, "pos"),
      rot: this.valueAtY(pivotY, "rot"),
    };
    const targets = this.selectedKeys().map((t) => ({ ...t, startValue: t.key.value }));
    this.boxScale = true;
    this.cbs.onValueStart();
    const move = (ev: PointerEvent) => {
      const py = ev.clientY - r.top;
      const s = (py - pivotY) / (edgeY - pivotY || 1);
      for (const t of targets) {
        const pivot = pivotVal[t.ch.group];
        t.key.value = pivot + (t.startValue - pivot) * s;
        this.cbs!.onValue(t.ch.group, t.ch.axis, t.key.time, t.key.value);
      }
      this.draw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.boxScale = false;
      this.cbs?.onValueEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /**
   * Retime drag: slide the selected keys horizontally, snapped to frames and
   * clamped so no selected key crosses a non-selected key on this track.
   * The move commits ONCE on release (retiming rebuilds key identity).
   */
  private beginRetime(e: PointerEvent) {
    if (!this.model || !this.cbs) return;
    const hit = this.pickKey(e);
    if (!hit) return;
    e.preventDefault();
    const ref = this.refOf(hit.ch, hit.key);
    if (!this.selected.has(ref)) {
      if (!e.shiftKey) this.selected.clear();
      this.selected.add(ref);
      this.draw();
    }
    const targets = this.selectedKeys().map((t) => ({ ch: t.ch, key: t.key, startTime: t.key.time }));
    if (!targets.length) return;
    const near = (t: number, list: number[]) => list.some((o) => Math.abs(o - t) < 1e-3);
    const selTimes = [...new Set(targets.map((t) => t.startTime.toFixed(4)))].map(Number);
    const allTimes = [...new Set((this.model.channels.flatMap((c) => c.keys.map((k) => k.time))).map((t) => t.toFixed(4)))].map(Number);
    const otherTimes = allTimes.filter((t) => !near(t, selTimes));
    const fps = this.tm?.fps ?? 60;
    const dur = this.tm?.duration ?? this.model.duration;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width);
    const secPerPx = this.tm
      ? (this.tm.timeAtFrac(1) - this.tm.timeAtFrac(0)) / w
      : this.model.duration / w;
    const startX = e.clientX;
    this.timeDrag = { targets, dt: 0 };
    const lo = Math.min(...selTimes);
    const hi = Math.max(...selTimes);
    const move = (ev: PointerEvent) => {
      if (!this.timeDrag) return;
      let dt = (ev.clientX - startX) * secPerPx;
      dt = Math.round((lo + dt) * fps) / fps - lo; // frame snap
      dt = Math.max(-lo, Math.min(dur - hi, dt));
      dt = clampRetimeDelta(selTimes, otherTimes, dt, 1 / fps);
      this.timeDrag.dt = dt;
      for (const t of targets) t.key.time = t.startTime + dt;
      // Keep the refs glued to the moving keys so highlight/box follow.
      this.selected = new Set(targets.map((t) => this.refOf(t.ch, t.key)));
      this.draw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const dt = this.timeDrag?.dt ?? 0;
      this.timeDrag = null;
      if (Math.abs(dt) > 1e-6) {
        this.cbs?.onRetime?.(selTimes.map((t) => ({ from: t, to: t + dt })));
      }
      this.draw();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /**
   * Brush stroke. Corrections: throttled small-amount smooths over the keys
   * under the ~20px brush — dwelling re-applies, so strength grows with time.
   * Channels: the stroke accumulates a span; ONE smooth op lands on release.
   */
  private beginBrush(e: PointerEvent) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const pt = (ev: PointerEvent) => ({ x: ev.clientX - r.left, y: ev.clientY - r.top });
    this.brushPt = pt(e);
    if (this.mode === "channels") {
      const t = this.snapToFrame(this.timeAtX(this.brushPt.x, r.width));
      this.brushStroke = { t0: t, t1: t };
      const move = (ev: PointerEvent) => {
        this.brushPt = pt(ev);
        const tt = this.snapToFrame(this.timeAtX(this.brushPt.x, r.width));
        if (this.brushStroke) {
          this.brushStroke.t0 = Math.min(this.brushStroke.t0, tt);
          this.brushStroke.t1 = Math.max(this.brushStroke.t1, tt);
        }
        this.draw();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const span = this.brushStroke;
        this.brushStroke = null;
        if (span && span.t1 - span.t0 > 1e-6) this.channels?.onBrushSpan?.({ ...span });
        this.draw();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    if (!this.model || !this.cbs?.onBrush) return;
    let started = false;
    const apply = () => {
      if (!this.brushPt || !this.model) return;
      let t0 = Infinity, t1 = -Infinity;
      for (const ch of this.model.channels) {
        for (const key of ch.keys) {
          const d = Math.hypot(this.x(key.time) - this.brushPt.x, this.y(key.value, ch.group) - this.brushPt.y);
          if (d <= BRUSH_R) {
            if (key.time < t0) t0 = key.time;
            if (key.time > t1) t1 = key.time;
          }
        }
      }
      if (t0 > t1) return;
      if (!started) {
        started = true;
        this.cbs!.onValueStart(); // one undo entry per stroke
      }
      this.cbs!.onBrush!({ t0: t0 - 1e-3, t1: t1 + 1e-3 }, 0.15);
    };
    this.brushStroke = { t0: 0, t1: 0 }; // marks "stroking" for the move handler
    apply();
    const timer = window.setInterval(apply, 120); // dwell = more smoothing
    const move = (ev: PointerEvent) => {
      this.brushPt = pt(ev);
      this.draw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.clearInterval(timer);
      this.brushStroke = null;
      if (started) this.cbs?.onValueEnd();
      this.draw();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  setModel(model: CurveModel | null, cbs: CurveCallbacks | null) {
    if (this.drag || this.timeDrag || this.boxScale) return; // never rebuild under an active drag
    this.model = model;
    this.cbs = cbs;
    // Drop selection refs that no longer resolve to a key (retimed/deleted).
    const valid = new Set<string>();
    for (const ch of model?.channels ?? []) for (const key of ch.keys) valid.add(this.refOf(ch, key));
    for (const ref of this.selected) if (!valid.has(ref)) this.selected.delete(ref);
    this.fitScale();
    this.draw();
  }

  /** Share the transport's zoom/pan mapping so the x-axis stays in lockstep. */
  setTimeMap(tm: TimeMap) {
    this.tm = tm;
  }

  /** Public redraw hook (transport calls it on zoom/pan/resize). */
  redraw() {
    this.draw();
  }

  // ---- Channels mode --------------------------------------------------------
  /** Wire up the dense-motion Channels mode (host provides the data). */
  setChannels(config: ChannelsConfig | null) {
    this.channels = config;
    this.modeRow.hidden = !config;
    if (config) {
      this.tree.setGroups(config.groups, {
        onChange: (bones) => {
          config.onSelect(bones);
          this.refreshDense();
        },
      });
    }
    if (!config && this.mode === "channels") this.setMode("corrections");
    this.syncSideUi();
    this.refreshDense();
  }

  /** Sync the tree selection from the host (viewport effector -> channels). */
  syncTreeSelection(bones: Iterable<string>) {
    this.tree.setSelected(bones);
    if (this.mode === "channels") this.refreshDense();
  }

  /** Drop the Channels-mode band selection (host menu "Clear selection"). */
  clearChannelSpan() {
    this.chanSpan = null;
    this.draw();
  }

  setMode(m: "corrections" | "channels") {
    if (m === "channels" && !this.channels) return;
    this.mode = m;
    this.chanSpan = null;
    if (m === "channels" && this.tool === "retime") this.tool = "select";
    this.syncSideUi();
    this.refreshDense();
    this.fitScale();
    this.draw();
  }

  getMode(): "corrections" | "channels" {
    return this.mode;
  }

  /** Re-pull dense data (host clip changed) while staying in the same mode. */
  refreshChannels() {
    if (this.mode === "channels") this.refreshDense();
  }

  /** Show the uncleaned source as a ghost while held (Channels mode). */
  setCompare(held: boolean) {
    this.compareHeld = held;
    if (this.mode === "channels") { this.refreshDense(); }
  }

  private syncSideUi() {
    for (const b of Array.from(this.modeRow.children) as HTMLButtonElement[]) {
      b.classList.toggle("active", b.dataset.mode === this.mode);
    }
    const chan = this.mode === "channels";
    this.axisRow.hidden = !chan;
    this.tree.el.hidden = !chan;
    this.side.classList.toggle("open", chan);
    this.syncToolUi();
  }

  private refreshDense() {
    if (!this.channels || this.mode !== "channels") {
      this.dense = null;
      this.denseCompare = null;
      this.fitScale();
      this.draw();
      return;
    }
    const bones = [...this.tree.getSelected()];
    this.dense = bones.length ? this.channels.provider(bones) : null;
    this.denseCompare = this.compareHeld && bones.length ? this.channels.compareProvider(bones) : null;
    this.fitScale();
    this.draw();
  }

  setPlayhead(t: number) {
    if (this.el.hidden) return;
    this.playhead = t;
    this.draw();
  }

  get hasContent(): boolean {
    return !!this.model && this.model.channels.some((c) => c.keys.length > 0);
  }

  dispose() {
    this.ro.disconnect();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.el.remove();
  }

  // ---- geometry ------------------------------------------------------------
  private width(): number {
    // The canvas's own content width, NOT el.clientWidth: the transport pads
    // this.el to align the canvas with the timeline strip, and clientWidth
    // includes that padding — drawing at the padded width squishes the frame
    // against the displayed canvas and the skew grows with zoom.
    return this.canvas.clientWidth || this.el.clientWidth || 1;
  }
  private x(t: number): number {
    if (this.tm) return (this.tm.pct(t) / 100) * this.width();
    return (t / Math.max(1e-9, this.model?.duration ?? 1)) * this.width();
  }
  private y(v: number, group: "pos" | "rot"): number {
    const s = this.scales[group];
    const h = HEIGHT - PAD_TOP - PAD_BOTTOM;
    return PAD_TOP + (1 - (v - s.min) / Math.max(1e-9, s.max - s.min)) * h;
  }
  private valuePerPx(group: "pos" | "rot"): number {
    const s = this.scales[group];
    return (s.max - s.min) / Math.max(1, HEIGHT - PAD_TOP - PAD_BOTTOM);
  }
  private timeAt(e: PointerEvent): number {
    const r = this.canvas.getBoundingClientRect();
    return this.timeAtX(e.clientX - r.left, r.width);
  }
  private timeAtX(px: number, width: number): number {
    const frac = px / Math.max(1, width);
    if (this.tm) return Math.max(0, Math.min(this.tm.duration, this.tm.timeAtFrac(frac)));
    return Math.max(0, Math.min(this.model?.duration ?? 0, frac * (this.model?.duration ?? 0)));
  }
  /** Snap a playback time to the nearest dense-model frame (if loaded). */
  private snapToFrame(t: number): number {
    const times = this.dense?.times;
    if (!times || !times.length) return t;
    const off = times[0];
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] - off < t) lo = mid + 1; else hi = mid;
    }
    const a = times[Math.max(0, lo - 1)] - off;
    const b = times[lo] - off;
    return t - a <= b - t ? a : b;
  }
  private pickKey(e: PointerEvent): { ch: CurveChannel; key: CurveKey } | null {
    if (!this.model) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best: { ch: CurveChannel; key: CurveKey; d: number } | null = null;
    for (const ch of this.model.channels) {
      for (const key of ch.keys) {
        const d = Math.hypot(this.x(key.time) - px, this.y(key.value, ch.group) - py);
        if (d < 9 && (!best || d < best.d)) best = { ch, key, d };
      }
    }
    return best ? { ch: best.ch, key: best.key } : null;
  }

  private fitScale() {
    for (const group of ["pos", "rot"] as const) {
      let lo = Infinity, hi = -Infinity;
      if (this.mode === "channels") {
        const all = [...(this.dense?.channels ?? []), ...(this.denseCompare?.channels ?? [])];
        for (const ch of all) {
          if (ch.group !== group || !this.axisVis[ch.axis]) continue;
          for (let i = 0; i < ch.values.length; i++) {
            const v = ch.values[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      } else {
        for (const ch of this.model?.channels ?? []) {
          if (ch.group !== group) continue;
          for (const k of ch.keys) {
            lo = Math.min(lo, k.value);
            hi = Math.max(hi, k.value);
          }
        }
      }
      if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
      const pad = Math.max(0.5, (hi - lo) * 0.2);
      this.scales[group] = { min: lo - pad, max: hi + pad };
    }
  }

  private ease(frac: number, e: CurveEase): number {
    return e === "step" ? 0 : e === "smooth" ? frac * frac * (3 - 2 * frac) : frac;
  }

  // ---- drawing ---------------------------------------------------------------
  private draw() {
    const w = this.width();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(HEIGHT * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, HEIGHT);
    if (this.mode === "channels") {
      this.drawDense(g, w);
      this.drawBandRect(g);
      this.drawBrushCursor(g);
      return;
    }
    if (!this.model) return;

    // Value grid: one zero line per group in play (pos = dashed, rot = solid);
    // the scales are independent, so the lines usually sit at different y.
    g.font = "10px system-ui, sans-serif";
    for (const group of ["pos", "rot"] as const) {
      if (!this.model.channels.some((c) => c.group === group && c.keys.length)) continue;
      const zy = this.y(0, group);
      g.strokeStyle = "rgba(255,255,255,0.16)";
      g.lineWidth = 1;
      g.setLineDash(group === "pos" ? [4, 4] : []);
      g.beginPath();
      g.moveTo(0, zy);
      g.lineTo(w, zy);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = "rgba(255,255,255,0.45)";
      g.fillText(group === "pos" ? "0 cm" : "0°", 4, zy - 3);
    }

    // Channels.
    for (const ch of this.model.channels) {
      if (!ch.keys.length) continue;
      g.strokeStyle = ch.color;
      g.lineWidth = 1.4;
      g.beginPath();
      // Hold-extend to the edges, then eased segments between keys.
      g.moveTo(0, this.y(ch.keys[0].value, ch.group));
      g.lineTo(this.x(ch.keys[0].time), this.y(ch.keys[0].value, ch.group));
      for (let i = 0; i < ch.keys.length - 1; i++) {
        const a = ch.keys[i], b = ch.keys[i + 1];
        const steps = a.ease === "linear" ? 1 : 16;
        for (let s = 1; s <= steps; s++) {
          const frac = s / steps;
          const v = a.value + (b.value - a.value) * this.ease(a.ease === "step" && s === steps ? 1 : frac, a.ease);
          g.lineTo(this.x(a.time + (b.time - a.time) * frac), this.y(v, ch.group));
        }
      }
      const last = ch.keys[ch.keys.length - 1];
      g.lineTo(w, this.y(last.value, ch.group));
      g.stroke();

      // Keys.
      for (const key of ch.keys) {
        const kx = this.x(key.time);
        const ky = this.y(key.value, ch.group);
        const hot = this.hover?.key === key || this.drag?.targets.some((t) => t.key === key);
        const sel = this.selected.has(this.refOf(ch, key));
        g.fillStyle = hot ? "#fff" : ch.color;
        g.save();
        g.translate(kx, ky);
        g.rotate(Math.PI / 4);
        const r = hot || sel ? 4.5 : 3.5;
        g.fillRect(-r, -r, r * 2, r * 2);
        if (sel) {
          g.strokeStyle = "#fff";
          g.lineWidth = 1.2;
          g.strokeRect(-r - 1.5, -r - 1.5, (r + 1.5) * 2, (r + 1.5) * 2);
        }
        g.restore();
      }
    }

    this.drawSelBox(g);
    this.drawBandRect(g);

    // Playhead.
    g.strokeStyle = "#ff5a5a";
    g.beginPath();
    g.moveTo(this.x(this.playhead), 0);
    g.lineTo(this.x(this.playhead), HEIGHT);
    g.stroke();

    // Title + hover readout + selection count.
    g.fillStyle = "rgba(255,255,255,0.6)";
    const hov = this.drag?.primary ?? this.hover;
    const readout = hov ? `  ·  ${hov.ch.label} @ ${hov.key.time.toFixed(2)}s = ${hov.key.value.toFixed(1)}` : "";
    const selCount = this.selected.size ? `  ·  ${this.selected.size} selected` : "";
    g.fillText(this.model.title + readout + selCount, 34, PAD_TOP);

    this.drawBrushCursor(g);
  }

  /** C3 transform box: bounding rect + top/bottom scale handles. */
  private drawSelBox(g: CanvasRenderingContext2D) {
    if (this.effTool() !== "select" || this.band) return;
    const box = this.selBox();
    if (!box) return;
    const bw = box.x1 - box.x0;
    g.strokeStyle = "rgba(255,255,255,0.55)";
    g.lineWidth = 1;
    g.setLineDash([5, 4]);
    g.strokeRect(box.x0 + 0.5, box.y0 + 0.5, bw, box.y1 - box.y0);
    g.setLineDash([]);
    // Edge handles (drag = scale values about the opposite edge).
    const cx = (box.x0 + box.x1) / 2;
    g.fillStyle = "rgba(255,255,255,0.9)";
    for (const y of [box.y0, box.y1]) g.fillRect(cx - 11, y - 2, 22, 4);
  }

  /** Brush-mode circle cursor + (Channels) the accumulating stroke span. */
  private drawBrushCursor(g: CanvasRenderingContext2D) {
    if (this.effTool() !== "brush") return;
    if (this.mode === "channels" && this.brushStroke) {
      const sx0 = this.x(this.brushStroke.t0);
      const sx1 = this.x(this.brushStroke.t1);
      g.fillStyle = "rgba(107,177,255,0.14)";
      g.fillRect(sx0, 0, sx1 - sx0, HEIGHT);
    }
    if (!this.brushPt) return;
    g.strokeStyle = "rgba(255,255,255,0.8)";
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(this.brushPt.x, this.brushPt.y, BRUSH_R, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "rgba(255,255,255,0.8)";
    g.fillRect(this.brushPt.x - 0.5, this.brushPt.y - 0.5, 1, 1);
  }

  /** Marquee band while drag-selecting (both modes). */
  private drawBandRect(g: CanvasRenderingContext2D) {
    if (!this.band) return;
    const bx = Math.min(this.band.x0, this.band.x1);
    const by = Math.min(this.band.y0, this.band.y1);
    const bw = Math.abs(this.band.x1 - this.band.x0);
    const bh = Math.abs(this.band.y1 - this.band.y0);
    g.fillStyle = "rgba(120,170,255,0.12)";
    g.fillRect(bx, by, bw, bh);
    g.strokeStyle = "rgba(255,255,255,0.6)";
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    g.setLineDash([]);
  }

  /** True when there's something to show: layer keys OR channels configured. */
  available(): boolean {
    return (this.model?.channels.some((c) => c.keys.length > 0) ?? false) || !!this.channels;
  }

  // ---- dense (Channels mode) drawing --------------------------------------
  // Dense per-frame motion curves, decimated to one min/max envelope span per
  // pixel column so a 12k-frame track draws in a couple of ms with no
  // per-frame vertices. Compare ghost (uncleaned source) draws behind.
  private drawDense(g: CanvasRenderingContext2D, w: number) {
    const model = this.dense;
    // Band-selected span (scoped-filter target) behind everything.
    if (this.chanSpan) {
      const sx0 = this.x(this.chanSpan.t0);
      const sx1 = this.x(this.chanSpan.t1);
      g.fillStyle = "rgba(120,170,255,0.10)";
      g.fillRect(sx0, 0, sx1 - sx0, HEIGHT);
      g.strokeStyle = "rgba(120,170,255,0.45)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(sx0 + 0.5, 0); g.lineTo(sx0 + 0.5, HEIGHT);
      g.moveTo(sx1 + 0.5, 0); g.lineTo(sx1 + 0.5, HEIGHT);
      g.stroke();
    }
    // Zero lines per group in play.
    g.font = "10px system-ui, sans-serif";
    for (const group of ["pos", "rot"] as const) {
      const hasG = (model?.channels ?? []).some((c) => c.group === group && this.axisVis[c.axis]);
      if (!hasG) continue;
      const zy = this.y(0, group);
      g.strokeStyle = "rgba(255,255,255,0.16)";
      g.lineWidth = 1;
      g.setLineDash(group === "pos" ? [4, 4] : []);
      g.beginPath();
      g.moveTo(0, zy);
      g.lineTo(w, zy);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = "rgba(255,255,255,0.45)";
      g.fillText(group === "pos" ? "0 cm" : "0°", 4, zy - 3);
    }

    if (!model) {
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.fillText("Select bones in the tree to graph their motion.", 40, PAD_TOP + 2);
      this.drawDensePlayhead(g);
      return;
    }
    // Ghost (uncleaned) first, dimmed.
    if (this.denseCompare) {
      for (const ch of this.denseCompare.channels) {
        if (!this.axisVis[ch.axis]) continue;
        this.drawEnvelope(g, w, this.denseCompare.times, ch, "rgba(180,190,205,0.35)");
      }
    }
    for (const ch of model.channels) {
      if (!this.axisVis[ch.axis]) continue;
      this.drawEnvelope(g, w, model.times, ch, ch.color);
    }

    this.drawDensePlayhead(g);

    // Title + value-at-playhead readout for the first channel.
    g.fillStyle = "rgba(255,255,255,0.6)";
    const f = this.playheadFrame(model.times);
    const first = model.channels.find((c) => this.axisVis[c.axis]);
    const readout = first ? `  ·  ${first.label} = ${first.values[f]?.toFixed(1) ?? "?"}` : "";
    const n = model.channels.filter((c) => this.axisVis[c.axis]).length;
    g.fillText(`Channels: ${n} track${n === 1 ? "" : "s"}${this.denseCompare ? " · comparing" : ""}${readout}`, 34, PAD_TOP);
  }

  private playheadFrame(times: number[]): number {
    // Nearest frame to the playhead (times are playback-relative-ish; the host
    // passes clip.times which may start nonzero, so normalize by times[0]).
    if (!times.length) return 0;
    const t = this.playhead + times[0];
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  private drawDensePlayhead(g: CanvasRenderingContext2D) {
    g.strokeStyle = "#ff5a5a";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(this.x(this.playhead), 0);
    g.lineTo(this.x(this.playhead), HEIGHT);
    g.stroke();
  }

  /** One channel as a per-pixel-column min/max envelope. */
  private drawEnvelope(g: CanvasRenderingContext2D, w: number, times: number[], ch: DenseChannel, color: string) {
    const cols = Math.max(1, Math.ceil(w));
    const t0 = times[0] ?? 0;
    // Frame times are absolute (can start nonzero); playback t = times[f]-t0.
    const mins = new Float32Array(cols).fill(Infinity);
    const maxs = new Float32Array(cols).fill(-Infinity);
    const vals = ch.values;
    const n = Math.min(vals.length, times.length);
    for (let f = 0; f < n; f++) {
      const xf = this.x(times[f] - t0);
      if (xf < -1 || xf > w + 1) continue;
      const c = Math.max(0, Math.min(cols - 1, Math.round(xf)));
      const v = vals[f];
      if (v < mins[c]) mins[c] = v;
      if (v > maxs[c]) maxs[c] = v;
    }
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    let started = false;
    let prevMidY = 0;
    for (let c = 0; c < cols; c++) {
      if (maxs[c] < mins[c]) continue; // empty column
      const yMin = this.y(maxs[c], ch.group); // higher value = smaller y
      const yMax = this.y(mins[c], ch.group);
      // Vertical span for this column (captures fast motion between frames).
      g.moveTo(c + 0.5, yMin);
      g.lineTo(c + 0.5, yMax);
      // Connect to the previous column so slow curves read as a line.
      const midY = (yMin + yMax) / 2;
      if (started) {
        g.moveTo(c - 1 + 0.5, prevMidY);
        g.lineTo(c + 0.5, midY);
      }
      prevMidY = midY;
      started = true;
    }
    g.stroke();
  }
}
