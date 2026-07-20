// App-wide preferences: one localStorage key, typed get/set, change events.
// This is NOT per-recording state (that stays in the rig cache) and is NOT
// written into scene files. Defaults marked "(new sessions)" are read by
// buildPanel only when a recording loads fresh (no cached edits / scene).

export interface Prefs {
  // General
  autosave: boolean;          // keep saving edits per recording
  confirmReplace: boolean;    // warn before replacing an unsaved session
  showHints: boolean;         // master switch for the (i) tooltips
  // Defaults (new sessions)
  exportFps: number;
  exportSpeed: number;        // export speed multiplier (0.25 - 4)
  nameScheme: "unity" | "motionbuilder";
  restPose: "tpose" | "first";
  gizmoSpace: "local" | "world";
  snapMagnet: boolean;
  playbackRate: number;
  cleanDespike: boolean;
  cleanSmooth: boolean;
  cleanLimitWrists: boolean;
  cleanLimitForearm: boolean;
  cleanFixFeet: boolean;
  // Viewport aids (aid strip + View menu share these)
  aidPaths: boolean;
  aidPathWindow: number;      // frames each side of the playhead
  aidPathDots: boolean;
  aidOnion: boolean;
  aidOnionCount: number;      // ghosts each side
  aidOnionStep: number;       // frames between ghosts
  aidOnionOpacity: number;    // nearest ghost's opacity (0-1)
  aidCleanPlay: boolean;      // hide handles/gizmo/dots while playing
  // Appearance
  uiScale: number;            // 0.85 | 1 | 1.15
  // Layout (persisted splitters + dock state)
  dockWidth: number;          // px
  timelineHeight: number;     // px
  treeWidth: number;          // px
  dockCollapsed: boolean;
}

const DEFAULTS: Prefs = {
  autosave: true,
  confirmReplace: true,
  showHints: true,
  exportFps: 60,
  exportSpeed: 1,
  nameScheme: "unity",
  restPose: "tpose",
  gizmoSpace: "local",
  snapMagnet: false,
  playbackRate: 1,
  cleanDespike: false,
  cleanSmooth: false,
  cleanLimitWrists: false,
  cleanLimitForearm: false,
  cleanFixFeet: false,
  aidPaths: false,
  aidPathWindow: 60,
  aidPathDots: true,
  aidOnion: false,
  aidOnionCount: 3,
  aidOnionStep: 5,
  aidOnionOpacity: 0.45,
  aidCleanPlay: false,
  uiScale: 1,
  dockWidth: 352,      // 22rem at scale 1
  timelineHeight: 0,   // 0 = auto (content height)
  treeWidth: 150,
  dockCollapsed: false,
};

const KEY = "wanimprefs";
let cache: Prefs | null = null;
const listeners = new Set<(p: Prefs) => void>();

function load(): Prefs {
  if (cache) return cache;
  let stored: Partial<Prefs> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as Partial<Prefs>;
  } catch { /* corrupt / blocked — defaults */ }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

/** The whole prefs object (a live reference; do not mutate directly). */
export function getPrefs(): Prefs {
  return load();
}

/** One preference. */
export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return load()[key];
}

/** Set one preference, persist, and notify subscribers. */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  const p = load();
  if (p[key] === value) return;
  p[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* blocked */ }
  for (const fn of listeners) fn(p);
}

/** Subscribe to any preference change. Returns an unsubscribe function. */
export function onPrefsChange(fn: (p: Prefs) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reset every preference to its default. */
export function resetPrefs(): void {
  cache = { ...DEFAULTS };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* blocked */ }
  for (const fn of listeners) fn(cache);
}

/** Apply the appearance prefs (UI scale, hint visibility) to the document. */
export function applyAppearance(): void {
  const p = load();
  document.documentElement.style.fontSize = `${16 * p.uiScale}px`;
  document.documentElement.classList.toggle("hide-hints", !p.showHints);
}
