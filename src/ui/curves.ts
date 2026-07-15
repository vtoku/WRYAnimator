// Canvas graph editor for the control-rig layer keys: the selected effector's
// position deltas (cm) and rotation deltas (ZYX euler, degrees) as per-axis
// curves. Keys drag VERTICALLY to change value (retiming stays on the
// timeline strips); right-click sets easing or deletes. The view samples the
// same easing the engine uses, so what you see is what bakes.

import type { TimeMap } from "./timemap.ts";
import { ChannelTree, type ChannelGroup } from "./channels.ts";

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

export interface CurveCallbacks {
  /** Vertical drag started on a key (push undo history once). */
  onValueStart(): void;
  /** Live value change (write key + fast rebake; do NOT rebuild the view). */
  onValue(group: "pos" | "rot", axis: number, time: number, value: number): void;
  /** Drag finished (refresh surrounding UI). */
  onValueEnd(): void;
  onEase(group: "pos" | "rot", time: number, ease: CurveEase): void;
  onDelete(group: "pos" | "rot", time: number): void;
  onSeek(t: number): void;
  /** Right-click on a key: host shows its menu with these extra items. */
  onContext(group: "pos" | "rot", time: number, x: number, y: number): void;
}

const HEIGHT = 150;
const PAD_TOP = 10;
const PAD_BOTTOM = 16;

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
  private drag: { ch: CurveChannel; key: CurveKey; startY: number; startValue: number } | null = null;
  private hover: { ch: CurveChannel; key: CurveKey } | null = null;
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
    this.side.append(this.modeRow, this.axisRow, this.tree.el);
    this.el.appendChild(this.side);

    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = `${HEIGHT}px`;
    this.canvas.style.display = "block";
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);

    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // Channels mode is view-only: click-empty seeks, no key editing.
      if (this.mode === "channels") {
        this.channels?.onSeek(this.timeAt(e));
        return;
      }
      if (!this.model || !this.cbs) return;
      const hit = this.pickKey(e);
      if (hit) {
        e.preventDefault();
        this.drag = { ch: hit.ch, key: hit.key, startY: e.clientY, startValue: hit.key.value };
        this.cbs.onValueStart();
        const move = (ev: PointerEvent) => {
          if (!this.drag) return;
          const dv = (this.drag.startY - ev.clientY) * this.valuePerPx(this.drag.ch.group);
          this.drag.key.value = this.drag.startValue + dv;
          this.cbs!.onValue(this.drag.ch.group, this.drag.ch.axis, this.drag.key.time, this.drag.key.value);
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
      } else {
        // Empty click = seek.
        this.cbs.onSeek(this.timeAt(e));
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.drag || this.mode === "channels") return;
      const hit = this.pickKey(e);
      if (hit?.key !== this.hover?.key) {
        this.hover = hit;
        this.canvas.style.cursor = hit ? "ns-resize" : "default";
        this.draw();
      }
    });
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const hit = this.pickKey(e);
      if (hit && this.cbs) this.cbs.onContext(hit.ch.group, hit.key.time, e.clientX, e.clientY);
    });
  }

  setModel(model: CurveModel | null, cbs: CurveCallbacks | null) {
    if (this.drag) return; // never rebuild under an active drag
    this.model = model;
    this.cbs = cbs;
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

  setMode(m: "corrections" | "channels") {
    if (m === "channels" && !this.channels) return;
    this.mode = m;
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
    this.el.remove();
  }

  // ---- geometry ------------------------------------------------------------
  private width(): number {
    return this.el.clientWidth || 1;
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
    const frac = (e.clientX - r.left) / r.width;
    if (this.tm) return Math.max(0, Math.min(this.tm.duration, this.tm.timeAtFrac(frac)));
    return Math.max(0, Math.min(this.model?.duration ?? 0, frac * (this.model?.duration ?? 0)));
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
    if (this.mode === "channels") { this.drawDense(g, w); return; }
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
        const hot = this.hover?.key === key || this.drag?.key === key;
        g.fillStyle = hot ? "#fff" : ch.color;
        g.save();
        g.translate(kx, ky);
        g.rotate(Math.PI / 4);
        const r = hot ? 4.5 : 3.5;
        g.fillRect(-r, -r, r * 2, r * 2);
        g.restore();
      }
    }

    // Playhead.
    g.strokeStyle = "#ff5a5a";
    g.beginPath();
    g.moveTo(this.x(this.playhead), 0);
    g.lineTo(this.x(this.playhead), HEIGHT);
    g.stroke();

    // Title + hover readout.
    g.fillStyle = "rgba(255,255,255,0.6)";
    const hov = this.drag ?? this.hover;
    const readout = hov ? `  ·  ${hov.ch.label} @ ${hov.key.time.toFixed(2)}s = ${hov.key.value.toFixed(1)}` : "";
    g.fillText(this.model.title + readout, 34, PAD_TOP);
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
