// Lightweight layout: CSS-variable driven splitters (no dock-undocking
// framework). The dock aside and the timeline dock are persistent elements
// (buildPanel only rewrites their innerHTML), so the resize handles live as
// edge-zone pointer listeners on those elements — they survive every panel
// rebuild. Sizes + the dock-collapsed flag persist in prefs.

import { getPref, setPref } from "./prefs.ts";

const DOCK_MIN = 220, DOCK_MAX = 640;
const TL_MIN = 0, TL_MAX = 520;

/** Push the saved layout sizes + collapse flag onto the document. */
export function applyLayoutVars(dock: HTMLElement): void {
  const root = document.documentElement.style;
  root.setProperty("--dock-width", `${getPref("dockWidth")}px`);
  const th = getPref("timelineHeight");
  root.setProperty("--timeline-height", th > 0 ? `${th}px` : "0px");
  dock.classList.toggle("collapsed", getPref("dockCollapsed"));
}

/** Collapse / expand the dock to a vertical tab strip (persisted). */
export function setDockCollapsed(dock: HTMLElement, on: boolean): void {
  setPref("dockCollapsed", on);
  dock.classList.toggle("collapsed", on);
}

/** Wire the two edge-drag splitters + click-to-expand on the collapsed dock. */
export function initLayout(dock: HTMLElement, editMain: HTMLElement, timelineDock: HTMLElement): void {
  applyLayoutVars(dock);

  // Dock width: drag the dock's left-edge grip (the ::before pseudo-element,
  // which reports the dock itself as the event target — content children do
  // not, so control clicks are never stolen).
  dock.addEventListener("pointerdown", (e) => {
    if (dock.classList.contains("collapsed") || e.target !== dock) return;
    e.preventDefault();
    const mainRight = editMain.getBoundingClientRect().right;
    const move = (ev: PointerEvent) => {
      const w = Math.max(DOCK_MIN, Math.min(DOCK_MAX, mainRight - ev.clientX));
      document.documentElement.style.setProperty("--dock-width", `${w}px`);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPref("dockWidth", Math.max(DOCK_MIN, Math.min(DOCK_MAX, mainRight - ev.clientX)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // Timeline dock height: drag its top-edge grip (::before → target is the
  // timeline dock itself; the transport content never triggers a resize).
  timelineDock.addEventListener("pointerdown", (e) => {
    if (e.target !== timelineDock) return;
    e.preventDefault();
    const bottom = timelineDock.getBoundingClientRect().bottom;
    const move = (ev: PointerEvent) => {
      const h = Math.max(TL_MIN, Math.min(TL_MAX, bottom - ev.clientY));
      document.documentElement.style.setProperty("--timeline-height", `${h}px`);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPref("timelineHeight", Math.max(TL_MIN, Math.min(TL_MAX, bottom - ev.clientY)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // Clicking a tab on a collapsed dock reopens it (the tab's own handler then
  // selects that tab). Capturing so it runs before the rebuilt handlers.
  dock.addEventListener("click", (e) => {
    if (!dock.classList.contains("collapsed")) return;
    if ((e.target as HTMLElement).closest(".dock-tab")) setDockCollapsed(dock, false);
  }, true);
}

/** Preset primitive: set both sizes at once and persist them. */
export function setLayoutSizes(dock: HTMLElement, dockWidth: number, timelineHeight: number): void {
  setPref("dockWidth", dockWidth);
  setPref("timelineHeight", timelineHeight);
  applyLayoutVars(dock);
}
