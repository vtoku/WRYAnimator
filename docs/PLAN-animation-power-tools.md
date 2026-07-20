# PLAN: animation power tools

A feature roadmap that grows WRYAnimator from "convert + clean" toward a
lightweight browser animation editor for its actual audience — VTubers and
mocap users polishing Warudo recordings — while staying true to the core:
one recording at a time, everything client-side, export is the product.
Written 2026-07-20 against v0.36.0.

**No layout rebuild required.** The menu-bar shell (v0.34), the dock panels,
and the curve-editor selection model (v0.36) are the right skeleton; what's
missing is a viewport-aids layer, a time-tools layer, and power operations on
the curve selection. All additive, phased below.

## Already covered today (polish only)

| Capability | Where it lives |
|---|---|
| Pin-based proportional retiming | `rig/timewarp.ts` warp keys — polish: draggable pins on the strip |
| Redundant-key cleanup | Key reduce filter + writer-side key elimination (v0.36) |
| Fixed-rate resample without shape change | `resample()` on export |
| Adaptive seconds/frames ruler | `chooseTickStep` ticks |
| Scrub + editing hotkeys | transport, `ui/shortcuts.ts` |
| Stepped interpolation | `step` key ease |
| Rotation continuity | internal quats; eulers unwrapped only at FBX write |

## New features — high value for this audience

1. **Motion paths** — draw the world-space trajectory of the selected effector
   across a frame window, updating live as filters/keys change. Arcs are *the*
   readability tool for mocap fixes. Cheap here: per-frame world FK exists
   (`worldFromLocal`); render a polyline + frame dots in the preview.
2. **Onion skin** — ghost stick-figure poses at ±N frames (configurable step),
   dimmed by distance. The preview is already a LineSegments skeleton, so
   ghosts are re-renders of the same geometry at other frames.
3. **Make loop** — pick the trim range, crossfade end→start over N seconds
   (quat slerp + hips blend), optionally auto-find the best loop point
   (pose-distance minimum). VTuber idle/gesture loops from mocap are a core
   use of this app.
4. **Export retiming** — target-fps control (30/60/120/custom) + playback-speed
   bake (0.5×–2× via the existing timewarp). Resample exists; this is UI plus
   one parameter.
5. **Propagate / match keys** — curve-editor selection ops: set selected keys
   to the value of the first/previous/next key, or blend toward it. Extends
   the v0.36 context menu; selection infra already there.
6. **Insert hold** — freeze the pose over a span: an override rig-layer section
   holding frame N across [t0,t1]. Kills tracker wander during intentional
   stillness.
7. **Smooth brush** — in the curve editor, hold a modifier and scrub over a
   curve to locally average it (channels mode → writes a scoped smooth filter;
   corrections mode → blends key values). The v0.36 pointer plumbing carries
   this.
8. **Selection sets** — user-named bone sets in the channel tree (persisted in
   the session), one click to re-scope filters/curves.
9. **Preview video export** — capture the preview canvas over the trim range
   via MediaRecorder → .webm download. Zero server, high share value for
   review.

## Smaller / later

10. **Selection transform box** — after marquee-selecting keys, a box whose
    edges scale values and whose body offsets them. Follow-on to multi-drag.
11. **Retime drag** — horizontal drag of selected key columns in the curve
    editor (`retimeKeys` exists; needs drag-axis UI + snapping).
12. **Spacing push/pull** — add/remove in-between spacing from the playhead:
    thin UI over timewarp pins.
13. **Clean playback** — hide handles/gizmos while playing; restore on stop.
14. **Silhouette / isolate** — two-tone stick-figure mode + selected-effector
    emphasis for pose readability.

## Out of scope

Pose libraries, multi-action management, and noise generators — authoring-DCC
concepts. WRYAnimator edits one recording at a time and removes noise rather
than adding it.

## Interface plan

Features land in the surfaces that already exist, plus one slim toggle strip:

1. **Menu bar**: add a **Time** menu (Make loop…, Retime/export fps…, Insert
   hold…, Time warp) and extend **View** with viewport-aid toggles (Onion
   skin, Motion paths, Silhouette, Clean playback).
2. **Viewport aid strip**: a slim icon toggle row docked top-right on the
   preview mirroring those View toggles, each with a small popover for its
   2–3 params (frame window, step).
3. **Curve editor toolbar**: a compact mode row on the `cv-side` gutter —
   Select (default) / Retime / Brush — plus the context menu growing
   Propagate, Match prev/next, and the transform box on selections.
4. **Channel tree**: a "Sets" chip row above the search box (save current
   selection, click to recall, right-click to delete). Sets serialize into
   the session like filters do.
5. **Export dialog**: gains target fps + speed, and an "Export preview video"
   secondary action.

## Phasing

- **Phase A — see the motion** (pure preview, no data-model changes): motion
  paths, onion skin, clean playback, viewport aid strip.
- **Phase B — time tools**: Make loop, export retiming, insert hold, Time
  menu. Touches export path + rig layers; each gets a check script.
- **Phase C — curve power ops**: propagate/match, smooth brush, transform box,
  retime drag. Builds strictly on the v0.36 selection model.
- **Phase D — workflow**: selection sets, preview video export, silhouette.

Each phase is shippable alone; A gives the most feedback per line of code, C
deepens what v0.36 opened up.
