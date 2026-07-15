// The single source of truth for every keyboard shortcut. This ONE table
// drives both the Help > Keyboard shortcuts overlay and the hotkey hints
// shown in menu items, so the two can never drift apart. bootcheck asserts
// every entry here appears in the overlay.

export interface Shortcut {
  /** Stable id menu items reference to pull their hint. */
  id: string;
  /** Human hotkey text (also matched by bootcheck). */
  keys: string;
  /** What it does, for the cheat sheet. */
  label: string;
  /** Cheat-sheet section. */
  group: string;
}

export const SHORTCUTS: Shortcut[] = [
  { id: "open", keys: "Ctrl+O", label: "Open a recording", group: "File" },
  { id: "save", keys: "Ctrl+S", label: "Save scene", group: "File" },

  { id: "undo", keys: "Ctrl+Z", label: "Undo", group: "Edit" },
  { id: "redo", keys: "Ctrl+Y", label: "Redo", group: "Edit" },
  { id: "copy", keys: "Ctrl+C", label: "Copy keys", group: "Edit" },
  { id: "paste", keys: "Ctrl+V", label: "Paste keys", group: "Edit" },
  { id: "delete", keys: "Del", label: "Delete keys", group: "Edit" },

  { id: "play", keys: "Space", label: "Play / pause", group: "Playback" },
  { id: "stepBack", keys: "←", label: "Step back one frame", group: "Playback" },
  { id: "stepFwd", keys: "→", label: "Step forward one frame", group: "Playback" },
  { id: "stepBack10", keys: "Shift+←", label: "Step back ten frames", group: "Playback" },
  { id: "stepFwd10", keys: "Shift+→", label: "Step forward ten frames", group: "Playback" },
  { id: "home", keys: "Home", label: "Jump to trim start", group: "Playback" },
  { id: "end", keys: "End", label: "Jump to trim end", group: "Playback" },

  { id: "fit", keys: "F", label: "Fit the timeline to the clip", group: "View" },

  { id: "move", keys: "W", label: "Gizmo: move", group: "Rig" },
  { id: "rotate", keys: "E", label: "Gizmo: rotate", group: "Rig" },
  { id: "space", keys: "Q", label: "Toggle gizmo space (local / world)", group: "Rig" },
];

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** Hotkey text for a shortcut id (empty string if unknown). */
export function keyFor(id: string): string {
  return byId.get(id)?.keys ?? "";
}

/** Shortcuts grouped in table order, for the cheat sheet. */
export function shortcutGroups(): Array<{ group: string; items: Shortcut[] }> {
  const out: Array<{ group: string; items: Shortcut[] }> = [];
  for (const s of SHORTCUTS) {
    let g = out.find((o) => o.group === s.group);
    if (!g) { g = { group: s.group, items: [] }; out.push(g); }
    g.items.push(s);
  }
  return out;
}
