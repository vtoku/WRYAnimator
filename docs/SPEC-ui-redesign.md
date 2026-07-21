# Spec: UI/UX redesign — one editor, not three generations

## Diagnosis

The UI grew in three generations that were never designed together:

1. the original converter (dock tabs full of settings, editbar, download),
2. the menu-bar shell + panels era (File/Edit/View, layouts, prefs),
3. the animation-editor era (zoomable timeline, curves, scoped filters,
   layers, time tools).

The result is the current incoherence:

- **The same concept lives in 2–4 places.** Filters: Clean-tab list AND the
  band menu AND a dialog AND timeline underlines. Layers: Rig-tab list AND
  the new rail. Key reduction: a Rig-tab analyzer AND Export-tab tolerances
  AND a filter type. Export: editbar controls AND an Export tab AND File-menu
  items.
- **The inspector holds workflow, not properties.** Dock tabs are verbs
  ("Clean", "Rig", "Export") — you bounce between tabs mid-task, and the
  things you act on (a filter, a layer, a key, an effector) have no single
  home that shows their state.
- **Time-scoped state is invisible or chip-listed far from the timeline.**
  Filter ops, range smooths, warp keys, the loop, foot plants — all live on
  the clip's TIMELINE conceptually, but are managed as chip rows in dock
  tabs, connected to the strip only by colored underlines.
- **Selection means something different on every surface** (viewport
  effector, tree bones, curve keys, dope picks, chips) and only some of
  them light up anything elsewhere.

## The model (one sentence)

**The viewport is the stage, the bottom workspace is the editor, the
inspector shows properties of whatever is selected, and menus hold the
commands.** Nouns get panels; verbs get menus and context menus.

Layout doctrine (the physics-assisted posing editors get this right):

- **The stage is maximized.** Chrome lives at the edges as slim overlays,
  never as full-height sidebars by default.
- **Tools are edge columns, not bars of text buttons.** Icon columns on the
  stage's left (manipulation) and right (view aids); labels are tooltips.
- **The timeline is fused to the stage** — it reads as part of the viewport,
  with its lanes (keys, filters, plants, warp, loop) directly attached, not
  a separate "panel" with its own chrome.
- **One right panel, shallow and collapsible.** Properties of the current
  selection only — never a tab-per-workflow stack.
- **Editing happens where the data is**: on the figure, on the curves, on
  the strip objects. The panel confirms and fine-tunes; it is never the
  only path.

One selection model everywhere: selecting ANYTHING — an effector, bones, a
layer, curve keys, a strip object (filter/loop/warp/marker/plant) — routes
to the same two places: the inspector (its properties, editable) and the
context menu (its verbs). Delete always deletes the selected thing.

## Target layout

```
┌ topbar ──────────────────────────────────────────────────────────────────┐
│ WRYAnimator   File Edit Select Time View Help                            │
├──────────────────────────────────────────────┬───────────────────────────┤
│ ┌ viewport toolbar (overlay, left) ┐         │  INSPECTOR (contextual)   │
│ │ move/rotate · local · hold · ghost         │                           │
│ │                                   aids ▸   │  · nothing selected:      │
│ │              3D STAGE                      │      Clip page (stats +   │
│ │                                            │      global cleaning)     │
│ │                                            │  · effector: keys, IK/FK, │
│ ├ bottom workspace ──────────────────────────┤      pins, hand pose      │
│ │ [▶,1×] [ ruler ······················ ] tc │  · layer: mode, extent,   │
│ │        [ track: trim/keys/lanes      ] trm │      fade, weight         │
│ │ ┌layers──┐ ┌ Keys | Curves ────────────┐   │  · strip object: its      │
│ │ │ stack  │ │ channel col | graph/rows  │   │      params (live slider) │
│ │ │ + M w  │ │                           │   │  · curve keys: values,    │
│ │ └────────┘ └───────────────────────────┘   │      ease, ops            │
└─┴────────────────────────────────────────────┴───────────────────────────┘
```

## Surface-by-surface plan

### 1. Timeline = home of all time-scoped state ("strip objects")

Filter ops, range smooths, the loop, warp keys, foot plants, and ruler
markers become first-class, CLICKABLE objects on labeled lanes under the
track (the underline lanes grow into a slim lane block). Click selects →
inspector shows its parameters (strength slider previews live, exactly like
the dialog today) → context menu / Delete removes. Dragging a strip object's
edges retimes its range.

Retires: the Clean-tab filter list, range-smooth chips, warp chips, the loop
chip row, the plant chip list (plants keep their lane; the cap/expander
moves to the lane's popover).

### 2. Layers rail = THE layers UI

The rail (already beside the panels) becomes permanent in the bottom
workspace and grows to full capability: stack order, active, mute, solo,
weight; selecting a layer opens its inspector page (name, mode
additive/override, extent hold/fade, fade seconds, delete/duplicate/merge).

Retires: the Rig-tab layer list.

### 3. Inspector = contextual properties (single panel, no task tabs)

Pages by selection:

- **Clip (nothing selected)** — file stats (from Info), duration/fps, and
  the global cleaning toggles (feet pinning, wrist/forearm limits, jitter
  despike/smooth) — these are clip-wide properties, so they live on the
  clip's page.
- **Effector** — the selected-effector editor: its keys, IK/FK blend for its
  limb, pin state, and (for hands) the hand-pose section; body-map picker
  stays here as the selector.
- **Layer / Strip object / Curve-key selection** — as above.

Retires: Clean, Rig, and Info as task tabs. The dock becomes ONE inspector
panel (collapsible as today).

### 4. Export = one dialog, launched from Download

Everything on the Export tab (format, bone names, rest pose, proportions,
spine, face/body mesh, fps + speed + live readout, reduction tolerances +
analyze) consolidates into an Export dialog opened from File → Export… (Ctrl+E).
The dialog owns the output name, format, all settings, and the Download
action — one place, remembered between opens.

Retires: the Export tab; the Rig-tab key-reduction analyzer (it moves into
the Export dialog next to the tolerances it informs).

### 5. Editbar becomes a real app TOOLBAR

One icon toolbar directly under the menu bar — consistent 26px stroke-icon
buttons in labeled groups with separators, every button also a menu item and
a shortcut (toolbar = fast path, never the only path):

```
[Move][Rotate][Local] | [Key pose][Auto-key] | [Hold][Ghost]
```

File, history, and EXPORT actions all stay in the menus + shortcuts — the
toolbar is for EDITING tools you reach for constantly, not menu duplicates.
Export lives entirely in File → Export… (the dialog owns name, format,
settings, and the Download action; Ctrl+E reopens it).

- **Manipulate group** — Move (W), Rotate (E), Local/World (Q); the active
  tool is accent-highlighted.
- **Keying group** — Key full pose at playhead, Auto-key toggle (moves out
  of the Rig tab where it's currently buried).
- **Compare group** — Hold-original, Ghost overlay.

The viewport keeps only the AID strip (view aids are stage furniture); all
ACTION tools live on the toolbar. Version text moves to Help → About.

### 6. Menus

- **File** — New scene, Open recording/scene/body, Recent, Save scene (As),
  Export… (dialog), Export preview video…
- **Edit** — Undo, Redo, Copy/Paste keys, Delete, Preferences.
- **Select** *(new)* — effectors (Hips, hands, feet…), selection sets,
  Select all keys in trim, Clear selection.
- **Time** — Make loop…, Auto-find loop point, Insert hold…, Retiming
  (opens Export dialog's timing section), Fit trim, Add marker.
- **View** — panel toggles (Keys/Curves/Hide, layers rail, inspector),
  viewport aids, Frame character, appearance/layout, zoom Fit.
- **Help** — Documentation, Keyboard shortcuts, About (version).

### 7. Visual system pass

One spacing scale (4/8/12/16), one control height per density tier (topbar
28px, workspace 21px), tabular numerals for all time/frame readouts, a
single accent-usage rule (accent = active/selected only, never decorative),
consistent stroke icons everywhere (no emoji), hover/active/disabled/focus
states from one shared recipe. The dark theme keeps 4.5:1 minimum contrast
for text and interactive glyphs.

## Phasing (each shippable)

| Phase | Scope | Retires |
|---|---|---|
| **U1** | Inspector shell: selection router + Clip page (stats + global cleaning). Dock tabs collapse to one panel. | Info tab, Clean tab's global sections |
| **U2** | Strip objects: selectable/editable lanes for filters, ranges, loop, warp, plants; inspector param pages with live preview. | all chip lists |
| **U3** | Effector + layer pages; permanent layers rail with full controls. | Rig tab |
| **U4** | Export dialog; app toolbar (replaces the editbar); Select menu. | Export tab, old editbar |
| **U5** | Visual-system pass, keyboard map, docs + screenshot refresh. | — |

Migration guardrails: every phase keeps the element ids the check scripts
drive (or updates the scripts in the same commit), runs the full Playwright
battery, and updates /docs screenshots when a surface it shows changes.
