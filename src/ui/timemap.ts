// Shared time->pixel mapping for the timeline strip, dope sheet, and curve
// editor. ONE instance is owned by the transport and handed to every view, so
// zoom/pan stay in lockstep. View range (what's on screen) is DISTINCT from the
// trim range (playback loop + export) — never conflate them.
//
// Positions are expressed as a fraction of the visible span so both %-based DOM
// elements (frac*100) and canvases (frac*width) can consume the same numbers.

export interface Marker {
  /** Playback-time seconds. */
  time: number;
  label: string;
}

const MIN_SPAN = 0.05; // deepest zoom: 50 ms across the strip

export class TimeMap {
  duration: number;
  viewStart: number;
  viewEnd: number;
  /** Average recording fps, for the frame readout + frame<->time conversion. */
  fps: number;
  frames: number;
  private listeners = new Set<() => void>();

  constructor(duration: number, frames: number) {
    this.duration = Math.max(1e-6, duration);
    this.frames = Math.max(1, frames);
    this.fps = frames > 1 ? (frames - 1) / this.duration : 60;
    this.viewStart = 0;
    this.viewEnd = this.duration;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  get span(): number {
    return Math.max(MIN_SPAN, this.viewEnd - this.viewStart);
  }
  /** 0 at viewStart, 1 at viewEnd (can fall outside [0,1] when off-screen). */
  fracOf(t: number): number {
    return (t - this.viewStart) / this.span;
  }
  pct(t: number): number {
    return this.fracOf(t) * 100;
  }
  timeAtFrac(frac: number): number {
    return this.viewStart + frac * this.span;
  }

  setView(start: number, end: number) {
    let s = start;
    let e = end;
    if (e - s < MIN_SPAN) e = s + MIN_SPAN;
    // Keep the window inside [0, duration] without changing its width when it
    // fits; when zoomed out past the clip, pin to the full clip.
    const width = Math.min(this.duration, e - s);
    if (s < 0) { s = 0; e = s + width; }
    if (e > this.duration) { e = this.duration; s = e - width; }
    if (s < 0) s = 0;
    if (Math.abs(s - this.viewStart) < 1e-9 && Math.abs(e - this.viewEnd) < 1e-9) return;
    this.viewStart = s;
    this.viewEnd = e;
    this.emit();
  }

  /** Zoom keeping the time under `pivotFrac` (0..1 across the strip) fixed. */
  zoomAt(pivotFrac: number, factor: number) {
    const pivot = this.timeAtFrac(pivotFrac);
    const span = this.span * factor;
    const newSpan = Math.max(MIN_SPAN, Math.min(this.duration, span));
    this.setView(pivot - pivotFrac * newSpan, pivot - pivotFrac * newSpan + newSpan);
  }

  /** Pan by a fraction of the current view width (positive = later in time). */
  panByFrac(frac: number) {
    const dt = frac * this.span;
    this.setView(this.viewStart + dt, this.viewEnd + dt);
  }

  /** Fit a range (defaults to the whole clip) with a little padding. */
  fit(start = 0, end = this.duration) {
    if (end - start < MIN_SPAN) { start = 0; end = this.duration; }
    const pad = (end - start) * 0.02;
    this.setView(start - pad, end + pad);
  }

  frameOf(t: number): number {
    return Math.round((t / this.duration) * (this.frames - 1));
  }
  timeOfFrame(f: number): number {
    return (Math.max(0, Math.min(this.frames - 1, f)) / (this.frames - 1)) * this.duration;
  }
}

/**
 * Choose a "nice" tick step (seconds) so labels are ~80 px apart, snapping to
 * 1/2/5 * 10^n, and dropping to whole-frame steps once frames are wider than
 * ~10 px. Returns the step plus whether it's a frame step (label as frames).
 */
export function chooseTickStep(secondsPerPx: number, fps: number): { step: number; asFrames: boolean } {
  const targetPx = 80;
  const rawSec = secondsPerPx * targetPx;
  const framePx = 1 / (secondsPerPx * fps); // px per frame
  if (framePx > 10) {
    // Zoomed in past ~10 px/frame: step in whole frames (1/2/5/10...).
    const rawFrames = rawSec * fps;
    const step = niceStep(rawFrames);
    return { step: Math.max(1, step) / fps, asFrames: true };
  }
  return { step: niceStep(rawSec), asFrames: false };
}

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, raw))));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}
