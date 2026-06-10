# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **client-side web app** that converts a **Warudo `.wanim` animation recording** into an **`.fbx` animation file**. Drop a `.wanim` on the page → preview the motion in 3D → download the FBX.

This is a **sibling of [VRMxShogun](https://github.com/vtoku/VRMxShogun)** (local checkout: `C:\Users\VTOKU\Documents\Claude\VRM2VICON`). That repo is the architectural template: same stack, same Pages deployment, same hand-rolled ASCII FBX writer approach. Read its `CLAUDE.md` and `SPEC.md` before working here — especially the FBX writer (`src/fbx/asciiFbx.ts`) and the drag-drop/preview UI (`src/main.ts`, `src/preview/scene.ts`), which can be adapted heavily.

Intended hosting: **GitHub Pages** (repo `vtoku/WANIMxFBX` → `https://vtoku.github.io/WANIMxFBX/`). Pages is **static hosting — there is no backend**. WANIM parse, decompression, FBX generation, and download all run **in the browser**. Never add a server-side step.

**Key difference from VRMxShogun:** that tool exports a static skeleton+mesh (no animation); this tool exports **animation** (FBX `AnimationStack`/`AnimationLayer`/`AnimationCurveNode`/`AnimationCurve` sections, which the template's writer does not have — they are the main new work).

## The .wanim format (reverse-engineered — no public spec)

`.wanim` is produced by Warudo's animation recorder (Warudo is a Unity/C# app). Verified against two real recordings in `C:\Users\VTOKU\Downloads\*.wanim`:

- **Container: MessagePack (MessagePack-CSharp) with LZ4BlockArray compression** — top-level msgpack array `[ext(type 98, msgpack ints = per-block decompressed sizes), bin, bin, ...]` where each `bin` is an LZ4 *block* (not frame format). Concatenated decompressed blocks form the real payload.
- **Payload: a 10-element msgpack array** (positional, no field names):

| idx | content |
|-----|---------|
| 0 | format version (`2` in both samples) |
| 1 | `float[frames]` timestamps, seconds, **variable rate** (~60 fps but irregular — resample for fixed-rate FBX export) |
| 2 | `[characters][frames][55][3]` bone **local positions** (relative to parent; index 0 = hips relative to character root). Bones 1–54 are near-constant bind offsets; hips carries the travel |
| 3 | `[characters][frames][55][4]` bone **local rotation quaternions** (x, y, z, w) |
| 4 | `[characters]` → map of blendshape sets, e.g. `{ "__VRM__": [frames] → { blendshapeName: value } }` |
| 5 | `[characters][frames][3]` character root position |
| 6 | `[characters][frames][4]` character root rotation quaternion |
| 7 | `[characters][frames]` → empty arrays in both samples (purpose unknown) |
| 8, 9 | empty arrays in both samples (purpose unknown — possibly props/cameras) |

- The 55 bones are **Unity `HumanBodyBones` enum order** (Hips=0 … UpperChest=54; consistent with observed data: index 3 = LeftLowerLeg has knee-like offset `(0, −0.40, 0.01)`). Verify visually in the preview before trusting fully. There are **no bone names, no mesh, no skeleton hierarchy in the file** — the skeleton must be reconstructed from the bind-pose local offsets in field 2 and named from the enum.
- Coordinates are **Unity convention: left-handed, Y-up, meters**. FBX is right-handed — a handedness flip is required on positions/quaternions, and FBX animation curves want **Euler `Lcl Rotation`** (quaternion→Euler conversion with consistent rotation order).

`node scripts/inspectWanim.mjs <file.wanim> [maxDepth]` — standalone decoder (msgpack + LZ4 block, no deps) that prints the structure summary. Use it whenever probing format questions.

## Stack (mirror VRMxShogun)

- **Vite + TypeScript**, static build to `dist/`. **Three.js** for the 3D motion preview (animate a stick-figure/bone visualization reconstructed from the file — see template `src/convert/boneViz.ts`).
- Decode msgpack + LZ4 in the browser with the same dependency-free approach as `scripts/inspectWanim.mjs` (the format subset used is small); avoid pulling heavy libraries.
- FBX output: **ASCII FBX 7.x, hand-rolled writer** (never binary — debuggable, widely accepted). Start from the template's `src/fbx/asciiFbx.ts` and add animation sections.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc --noEmit && vite build
npm run preview    # serve built dist/ — ALWAYS test the Pages base path here, not just dev
npm run smoke -- <file.wanim>   # parse a real recording with src/wanim/parse.ts, print summary
```

No tests/linter configured yet. When adding them, document the single-test invocation here.

## Pipeline

```
.wanim (drag/drop, whole page)
  → LZ4BlockArray decode → msgpack decode → typed WanimClip
      { version, times[], characters: [{ bonePositions, boneRotations, blendshapes, rootPos, rootRot }] }
  → skeleton reconstruction: bind-pose local offsets (frame 0 of field 2) + HumanBodyBones names
  → resample variable timestamps → fixed rate (e.g. 60 fps), Unity→FBX axis/handedness conversion, quat→Euler
  → ASCII FBX writer: LimbNode skeleton + AnimationStack/Layer/CurveNodes/Curves
  → download .fbx
```

Keep the parser output-agnostic from the FBX writer, as in the template.

## GitHub Pages deployment (same traps as VRMxShogun)

- `base: '/WANIMxFBX/'` in `vite.config.ts` — with default `base: '/'` assets 404 in production but work in dev. Validate with `npm run preview`.
- Ship `public/.nojekyll`.
- Deploy via GitHub Actions workflow (`actions/deploy-pages`), Pages source = "GitHub Actions". Copy the template's `.github/workflows/`. Don't hand-manage a `gh-pages` branch.

## Domain knowledge that is easy to get wrong

- **FBX animation curves**: each animated property needs an `AnimationCurveNode` connected to both the layer and the model property (`Lcl Translation` / `Lcl Rotation`), and per-component `AnimationCurve`s connected with `OP` connections (`d|X`, `d|Y`, `d|Z`). Times are in FBX ticks (`KTime` = 1/46186158000 s).
- **Hips vs. root**: field 5/6 (character root) and field 2/3 bone 0 (hips, root-relative) must compose. Bake root motion into the hips (or emit a root node) — pick one and document it.
- **Variable frame timing**: timestamps come from render frames, not a fixed clock. Resampling (linear pos / slerp rot) is required for clean fixed-rate output; don't write the raw irregular keys without deliberate choice.
- **Blendshape channels** (field 4) are out of scope until skeleton animation is verified; they only matter if a mesh with matching morph targets is exported, which this file format cannot supply by itself.
