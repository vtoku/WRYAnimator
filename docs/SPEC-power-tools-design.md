# Spec: animation power tools — design

Design detail for docs/PLAN-animation-power-tools.md. Phases A–D, each
shippable alone. Written against v0.36.0 (curve-editor selection model,
key-reduce filter, sparse FBX keys). No new dependencies; everything stays
client-side.

Terminology reminder (SPEC-timeline-fcurves.md): the curve editor has two
modes. **Corrections** = the active rig layer's keys for the selected effector
(sparse, editable). **Channels** = the dense baked motion for the tree-selected
bones (per-frame, filter-scoped). One TimeMap drives strip + dope + curves.

---

## C0. Band-select → scoped filter in Channels mode  ← build first

Today a scoped filter (Butterworth / Moving-average / Despike / Key reduce)
takes its scope from the channel tree + the TRIM handles. That works but is
two panels away from the curves. Close the loop where the user is looking:

- **Marquee in Channels mode.** Reuse the v0.36 band-select plumbing
  (corrections-mode marquee) in Channels mode. A drag selects a TIME SPAN
  (values are dense; per-key selection doesn't apply) — draw the band
  full-height, snap edges to frames. Store as `chanSpan: {t0,t1} | null`,
  drawn as a translucent column until cleared (click-empty).
- **Right-click menu (Channels mode).** With a span active:
  `Butterworth here…`, `Smooth here…`, `Despike here…`, `Key reduce here…`,
  plus `Set trim to span` and `Clear selection`. Each filter item creates a
  CleanOp scoped to (current tree bone selection) × (the span) with the
  default param, pushes it to `cleanOps`, recleans, and flashes the new chip
  in the filter list. The "…" variants open the existing param input
  pre-focused; Enter applies. No span → the menu offers `Filter trim range…`
  (today's behavior) so nothing regresses.
- **Host wiring.** `ChannelsConfig` gains
  `onFilterSpan(filter: CleanFilter, span: {t0,t1}): void`; main.ts implements
  it by reusing the `filterAdd` code path (same pushHistory/reclean/render).
  curves.ts stays dumb about CleanOps.
- **Check.** Playwright: open Channels, select Spine, band-drag a span,
  right-click → Butterworth; assert a chip appears with that span (±1 frame)
  and `cleanOps` range ≠ trim range.

This directly answers "drag-select a range on the curve and butterworth it".

---

## Phase A — see the motion (preview aids; no data-model changes)

### A1. Motion paths

- **What.** World-space trajectory of the selected effector's bone over a
  window around the playhead (default ±60 frames, configurable 10–300),
  drawn in the preview as a polyline with per-frame dots; dots at
  keyframe-times of the active layer get emphasis (bigger, layer color).
- **Data.** Per frame f in window: FK via existing `worldFromLocal` on the
  DISPLAY clip (post filters/layers — what exports). Cache Float32Array of
  positions; invalidate on (a) display clip rebuild, (b) effector change,
  (c) window change. Rebuild is O(window × bones) — fine at 60–300 frames;
  reuse the rebake dirty-range to only recompute touched frames.
- **Render.** `THREE.Line` (path) + `THREE.Points` (frames) in scene.ts,
  colored by effector color, depth-tested off so it reads through the body.
  Update positions in place; no per-frame allocation.
- **UI.** View menu toggle + aid-strip button (see A4); popover: window
  size, show dots, show only-on-selection.

### A2. Onion skin

- **What.** Ghost stick figures at ±N steps (default 3 ghosts each side,
  step 5 frames), opacity falling with distance, before-ghosts cool tint /
  after-ghosts warm tint.
- **Render.** The preview skeleton is LineSegments; ghosts = N extra
  LineSegments sharing geometry layout, positions written from `poseAtFrame`
  + FK for their frame. Update only when playhead crosses a frame boundary
  or the clip rebuilds. 6 ghosts × 55 bones is trivial.
- **UI.** View menu + aid strip; popover: ghost count, step, opacity.

### A3. Clean playback

- **What.** During play (not scrub): hide effector handles, motion-path
  dots, and the hover gizmo; restore on pause. One boolean in scene.ts
  consulted by the overlay draw; toggle lives in View menu.

### A4. Viewport aid strip

- **What.** Slim icon toggle column, top-right of the preview canvas:
  Motion paths / Onion skin / Silhouette (D3) / Clean playback. Each button:
  click toggles, small chevron opens its param popover (reuse menu popover
  styles from `ui/menu.ts`). State persists in prefs (`ui/prefs.ts`).
- **Files.** New `src/ui/aidstrip.ts`; scene.ts exposes
  `setAid(name, on, params)`.

**Phase A check.** Playwright: toggle each aid, screenshot-diff a region to
assert pixels changed; assert 60fps playback isn't degraded (frame-time probe
already exists in drive script).

---

## Phase B — time tools

### B1. Make loop

- **What.** Turn the trim range into a clean cycle: blend the last `blendS`
  seconds (default 0.5) so frame(end) == frame(start), then set trim to the
  loop. Algorithm per bone: for t in blend window,
  `q(t) = slerp(q(t), q(t - loopLen), w(t))` with smoothstep w rising to 1
  at the end; hips position blends the same but preserves accumulated travel
  option ("in-place loop" checkbox subtracts root drift across the loop).
- **Auto-find loop point.** Optional: scan the trim range for the frame pair
  (i, j) minimizing pose distance (sum of quat angles, hips height delta),
  j − i ≥ minLen; propose it by moving the trim handles. O(n²) on downsampled
  frames (every 4th) — a few hundred ms worst case, run async like reclean.
- **Where it lives.** A CleanOp-like entry? No — it changes trim semantics.
  Implement as a one-shot destructive-with-undo op on the display pipeline
  (pushHistory, then bake a `loopBlend` field consumed at display-clip
  rebuild, listed as a chip next to range smooths so it can be removed).
- **UI.** Time menu → "Make loop…" dialog: blend seconds, in-place checkbox,
  Auto-find button, Apply.
- **Check.** node script: synthetic walk clip → make loop → assert
  first/last frame pose distance < ε and C1 continuity across the seam
  (velocity delta below threshold).

### B2. Export retiming

- **What.** Export dialog gains: target fps select (30/50/60/120/custom;
  default 60 = today) and speed multiplier (0.25×–4×, default 1×) applied
  via the existing timewarp before resample. Duration/frame-count readout
  updates live.
- **Files.** main.ts export section; `resample(clip, fps)` already takes fps.
- **Check.** smoke script with `--fps 30 --speed 0.5`: assert frameCount and
  FBX LocalStop match expectation; fbxcheck round-trip duration.

### B3. Insert hold

- **What.** Freeze the current pose across a span: creates an override
  rig-layer section — keys the full pose (existing `keyFullPose`) at t0 and
  t1 with `step` ease on t0's keys, on a dedicated "Holds" override layer
  (auto-created, weight 1). Chip-listed like filters; deleting the keys
  removes the hold.
- **UI.** Time menu → "Insert hold over trim" (and, once C0 lands, over the
  channels span). Uses the selected effector set or whole body (dialog).
- **Check.** rigCheck-style: apply hold, assert pose constant over span and
  untouched outside ± blend.

### B4. Time menu

Menu-bar addition collecting: Make loop…, Export retiming (opens export
dialog focused), Insert hold…, Time warp (focus the warp panel), Fit trim.

---

## Phase C — curve power ops (beyond C0)

### C1. Propagate / match keys (Corrections mode)

- Context-menu additions on a key selection: `Match previous` / `Match next`
  (copy neighbor value per channel), `Flatten to first` (all selected keys
  take the first selected key's value), `Blend toward neighbors… (25/50/75%)`.
  All per-channel on the underlying pos/rot keys via the euler-safe path used
  by drag (unwrapEulerKeys → edit axis → eulerZYXToQuat).

### C2. Smooth brush

- New curve-editor drag mode (toolbar row on the cv-side gutter: Select /
  Brush). Brush drag in Corrections mode = repeated `smoothKeys` on keys
  under the brush radius (strength by dwell). In Channels mode = builds ONE
  moving-average CleanOp whose range grows with the stroke (merged on
  pointer-up), so a stroke ≙ a scoped smooth chip — undoable, inspectable.

### C3. Selection transform box

- After marquee select (≥2 keys): draw a bounding box with 4 edge handles.
  Vertical edges scale values about the box center (pivot = center value);
  body drag = value offset (existing multi-drag). Horizontal edges/retime
  deferred to C4. Esc or click-empty dismisses.

### C4. Retime drag

- With selection: hold `R` (or toolbar Retime mode) → horizontal drag moves
  selected keys in time via `retimeKeys` per unique time, snapping to frames
  and to other keys (magnet setting reused). Collision rule: refuse to cross
  a non-selected key (clamp), matching strip-drag behavior.

---

## Phase D — workflow

### D1. Selection sets

- Chip row above the channel-tree search: `[+ Save]` stores the current bone
  set under a prompt-name; click = recall (replaces selection; shift-click
  adds); right-click chip = rename/delete. Persist in the session doc next
  to `cleanOps` (`selectionSets: {name, bones[]}[]`). Also listed in a
  Sets submenu under View for keyboard access.

### D2. Preview video export

- File menu → "Export preview video…": plays the trim range once while
  `MediaRecorder` captures `preview canvas.captureStream(60)` → .webm
  download (VP9, fallback VP8). Dialog: resolution (canvas / 1080p letterbox),
  include aid overlays yes/no (uses A3 clean-playback path when no).
  Disabled while already recording; esc cancels.

### D3. Silhouette

- Two-tone mode: background flat, character bones/joints single light color,
  selected effector chain accent color. One material swap in scene.ts;
  aid-strip + View toggle.

---

## Sequencing & estimates

| Order | Item | Size |
|---|---|---|
| 1 | C0 band-select → scoped filter | S — reuses v0.36 plumbing |
| 2 | A1 motion paths + A4 strip | M |
| 3 | A2 onion skin + A3 clean playback | S |
| 4 | B1 make loop (+ auto-find) | M |
| 5 | B2 export retiming + B4 Time menu | S |
| 6 | C1 propagate/match + C3 box | M |
| 7 | B3 insert hold | S |
| 8 | C2 smooth brush | M |
| 9 | D1 sets, D2 video, D3 silhouette, C4 retime drag | S each |

Rule of thumb: S ≤ half a day, M ≈ a day including its check script.
