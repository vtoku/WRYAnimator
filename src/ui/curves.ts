// Canvas graph editor for the control-rig layer keys: the selected effector's
// position deltas (cm) and rotation deltas (ZYX euler, degrees) as per-axis
// curves. Keys drag VERTICALLY to change value (retiming stays on the
// timeline strips); right-click sets easing or deletes. The view samples the
// same easing the engine uses, so what you see is what bakes.

export type CurveEase = "linear" | "smooth" | "step";

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

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "t-curves";
    this.el.hidden = true;
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = `${HEIGHT}px`;
    this.canvas.style.display = "block";
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);

    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.model || !this.cbs) return;
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
      if (this.drag) return;
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
    return Math.max(0, Math.min(this.model?.duration ?? 0, ((e.clientX - r.left) / r.width) * (this.model?.duration ?? 0)));
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
      for (const ch of this.model?.channels ?? []) {
        if (ch.group !== group) continue;
        for (const k of ch.keys) {
          lo = Math.min(lo, k.value);
          hi = Math.max(hi, k.value);
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
}
