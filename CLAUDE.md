# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **client-side web app** that converts a **Warudo `.wanim` animation recording** into an **`.fbx` animation file**. Drop a `.wanim` on the page → preview the motion in 3D → download the FBX.

This is a **sibling of [VRMxShogun](https://github.com/vtoku/VRMxShogun)** (local checkout: `C:\Users\VTOKU\Documents\Claude\VRM2VICON`). That repo is the architectural template: same stack, same Pages deployment, same hand-rolled ASCII FBX writer approach. Read its `CLAUDE.md` and `SPEC.md` before working here — especially the FBX writer (`src/fbx/asciiFbx.ts`) and the drag-drop/preview UI (`src/main.ts`, `src/preview/scene.ts`), which can be adapted heavily.

Hosted on **GitHub Pages** at `https://vtoku.github.io/WANIMxFBX/` (repo `vtoku/WANIMxFBX`, an org repo; deploys from the `main` branch via Actions). Pages is **static hosting — there is no backend**. WANIM parse, decompression, FBX generation, and download all run **in the browser**. Never add a server-side step.

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

- **Vite + TypeScript**, static build to `dist/`. **Three.js** drives the 3D motion preview (`src/preview/scene.ts` — an Object3D bone hierarchy rendered as a LineSegments + Points stick figure).
- msgpack + LZ4 are decoded in-browser by hand-written, dependency-free modules (`src/wanim/msgpack.ts`, `lz4.ts`); the format subset is small, so avoid pulling heavy libraries.
- FBX output is a **hand-rolled ASCII FBX 7.4 writer** (`src/fbx/animationFbx.ts`) — never binary (ASCII is debuggable and widely accepted).
- `playwright` is a devDependency used only by `npm run drive` for headless browser verification; it is not shipped.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc --noEmit && vite build
npm run preview    # serve built dist/ — ALWAYS test the Pages base path here, not just dev
npm run smoke    -- <file.wanim> [out.fbx]   # parse → convert → resample → write FBX, brace/section sanity check
npm run fbxcheck -- <file.fbx>               # load an emitted FBX back with three's FBXLoader, report bones+clip
npm run drive    -- [file.wanim]             # Playwright: drive the running dev server, screenshot, test download
```

No unit-test framework yet — the three `npm run` scripts above are the regression checks (they import the real `src/` modules). `node --experimental-strip-types` runs the TS directly: see the gotcha below.

## Build / runtime gotchas

- **TS imports MUST carry the `.ts` extension** (`import { x } from "./foo.ts"`). The smoke scripts run under Node's `--experimental-strip-types`, which does no path resolution; `tsconfig` has `allowImportingTsExtensions: true` and Vite handles it for the browser build.
- **No TS-only runtime syntax in strip-only mode**: no `constructor(private x)` parameter properties, no enums, no decorators. `src/wanim/msgpack.ts` uses an explicit field + assignment for exactly this reason.

## Pipeline (implemented)

```
.wanim (drag/drop, whole page)
  → src/wanim/parse.ts:  LZ4BlockArray decode (lz4.ts) → msgpack decode (msgpack.ts) → WanimClip
  → src/convert/clip.ts: convertCharacter() — Unity LH→RH (negate Z; quat→(-x,-y,z,w)), bake root into Hips,
                          sign-continuous quats. Output = ConvertedClip (variable-rate, used directly by preview).
                          resample() → ResampledClip (fixed fps, linear pos / slerp rot) for export.
  → src/fbx/animationFbx.ts: ASCII FBX 7.4 — LimbNode skeleton + AnimationStack/Layer, per-bone Lcl Rotation
                          curves + Hips Lcl Translation curve. meters→cm, Y-up.
  → src/convert/clean.ts: optional mocap cleaning — despike (pops/hand-flips via neighbour slerp) + zero-phase Butterworth low-pass (filtfilt) on rotations + hips translation. Applied to the converted clip so it shows in preview AND export.
  → src/preview/scene.ts: Three.js Object3D bone hierarchy driven per-frame; LineSegments + Points stick figure. Supports trim looping (setTrim).
  → src/ui/transport.ts: transport bar overlaid on the viewport — play/pause, click-to-seek timeline with draggable in/out trim handles. resample() takes trimStart/trimEnd to export only the trimmed range (rebased to t=0).
  → src/preview/face.ts:  ARKit face overlay — loads public/facecap-head.glb, seats it at the Head joint,
                          drives morph targets from the recorded blendshapes. PREVIEW ONLY (not in the FBX).
```

`src/convert/skeleton.ts` holds the Unity HumanBodyBones parent table; `src/convert/quat.ts` holds quat math + the quat→Euler-ZYX extraction. The parser is output-agnostic from the writer.

## GitHub Pages deployment (same traps as VRMxShogun)

- `base: '/WANIMxFBX/'` in `vite.config.ts` — with default `base: '/'` assets 404 in production but work in dev. Validate with `npm run preview`.
- Ship `public/.nojekyll`.
- Deploy via GitHub Actions workflow (`actions/deploy-pages`), Pages source = "GitHub Actions". Copy the template's `.github/workflows/`. Don't hand-manage a `gh-pages` branch.

## Domain knowledge that is easy to get wrong

- **FBX animation curves**: each animated property needs an `AnimationCurveNode` connected to both the layer (`OO`) and the model property (`OP` with `"Lcl Translation"`/`"Lcl Rotation"`), and per-component `AnimationCurve`s connected with `OP` + `d|X`/`d|Y`/`d|Z`. Times are FBX ticks (`FBX_TIME_SECOND = 46186158000`). A `Takes:` block is emitted for older importers.
- **MotionBuilder 2026 is installed locally — USE IT to verify FBX output.** `& "C:\Program Files\Autodesk\MotionBuilder 2026\bin\x64\motionbuilder.exe" -batch scripts\mobuCheck.py` imports the file headlessly and writes `scripts/mobu-result.txt` (takes, skeleton, key counts, blendshape props). Pass the target file via the `WANIM_FBX` env var — an extra CLI arg makes MoBu auto-open it and SKIP the script. Grep stdout for "legacy" to detect the legacy-file warning. (`mobupy.exe` standalone does NOT work: `pyfbsdk.initialize()` returns False.) `scripts/mobuSave.py` (env `WANIM_FBX`/`WANIM_OUT`) round-trips a file through MoBu to get SDK-canonical reference output; `scripts/dumpTree.mjs` dumps any binary FBX node tree (7400 32-bit and 7500+ 64-bit); `scripts/meshProbe.ts` generates minimal mesh probes for bisection. Blender 4.4 is also installed for control exports.
- **FBX MUST be binary, not ASCII.** MotionBuilder 2018+ dropped ASCII FBX import (loads as a dot-cloud). The writer emits **binary FBX 7700** via `src/fbx/fbxBinary.ts` (64-bit node records, 25-byte null terminators). THE killer detail: in binary, object names use the separator `name\x00\x01class` (e.g. `R\x00\x01AnimCurveNode`), NOT ASCII `class::name` — the FBX SDK / FBXLoader truncate the readable name at the first NUL, so getting this wrong silently drops AnimationCurveNode channel tags (R/T/DeformPercent) → ZERO tracks. Always build names with `objName(name, cls)`. Validate with `npm run fbxcheck`.
- **MoBu's "legacy file" warning is triggered by the header metadata, not the data.** Verified by bisection against MoBu's own saved output: the fix was the Creator strings `"FBX SDK/FBX Plugins version 2020.3.7"` (header + top-level; the SDK parses this exact form to date the file — even Blender's output warns) together with `OtherFlags/TCDefinition`, `FBXHeaderVersion 1004`, and version 7700. The footer code must also be the encryption of the `CreationTime` STRING (Blender's "timedate hack": pin `1970-01-01 10:00:00:000` + the constant code — `generateFooterCode()` provably reproduces it) with `FileId` = the `28 b3 2a eb…` constant; a mismatched footer ALSO degrades the file.
- **Mesh models need `DefaultAttributeIndex: 0`** in Properties70, or the SDK applies the template default (-1 = no active attribute) and MotionBuilder imports the model as a **Null instead of a Mesh** (silently — no log). Found via `meshProbe.ts` bisection. Meshes also need a normals LayerElement + Layer.
- **Embedded meshes are SKINNED, not parented** (`SkinnedMeshExport` in the writer): mesh Model at scene root, Skin deformer + per-bone Clusters (Transform = inverse bind, TransformLink = bind; identity-rotation T-pose matrices), plus a `Pose/BindPose` object. Parenting a mesh under a bone "weights oddly" in MoBu retarget pipelines.
- **The face must NOT be rotated in the FBX** — the exported body faces +Z and so does the facecap head; the preview's two 180° Y flips (rig display + face seat) cancel out and are display-only.
- **A `TPose` take** (one-key stance at t=0) is exported alongside the animation take so MoBu can characterize from a guaranteed T-pose (fixes feet/limb auto-mapping). MoBu builds its take list from the legacy `Takes` node — an AnimationStack without a matching `Take` entry there does NOT appear.
- **Ybot body** (`src/convert/body.ts` + `public/body.glb`, the three.js Xbot, textures stripped): retargeted onto the recording's skeleton by per-bone translation deltas (ourJoint − s·xbotJoint, s = hips-height ratio) — do NOT use translate∘inverseBind (Xbot's armature scale mixes cm/m and explodes the mesh). mixamorig weights map to our bones via MOTIONBUILDER_NAMES; unmapped helper bones (Toe_End, Thumb4…) walk up to the nearest mapped ancestor; head/eye triangles are dropped (facecap head replaces them). Stand-in proportions distort where the rigs differ — acceptable for a reference body.
- **Blendshape export** (`opts.face`, on by default): embeds the facecap head as a Mesh `Geometry` + `BlendShape`/`BlendShapeChannel` deformers + `Shape` geometries (per-control-point deltas) parented to the Head bone, with `DeformPercent` curves from the recorded ARKit weights. Connection chain FBXLoader/MoBu need: curveNode→channel (`OP DeformPercent`), curve→curveNode (`OP d|DeformPercent`), channel→blendShape→geometry→model (`OO`). Mesh is baked into the Head bone's local space (recenter, scale to ~22cm, 180° Y, lift 9cm); deltas get rotate+scale only. Verify with `npm run faceFbxCheck`. The exact MoBu head seating is unverified (no MoBu here) and may need tuning.
- **Rotation order is THE thing to verify in a real DCC.** We extract quaternion→Euler in three.js 'ZYX' order (`quatToEulerZYX`) and write it with the default `RotationOrder`, because three's FBXLoader maps FBX's default onto ZYX — and the round-trip check (`npm run fbxcheck`) confirms it reconstructs 55 bones + a clip with the hips traveling. **The preview (quaternion-driven) is always correct; the FBX Euler order is the risk.** If limbs twist/spin in Blender/Maya but the preview looked fine, the fallback is to try XYZ extraction + matching `RotationOrder`. Euler tracks are unwrapped (`unwrapDegrees`) and quats made sign-continuous to prevent 360° pops.
- **Hips vs. root**: `convertCharacter` bakes the character root (fields 5/6) into the Hips, so Hips (the FBX root LimbNode, parented to scene) carries full world translation+rotation; all other bones stay local-to-parent. Limb bones export rotation curves only; their translation is constant at the frame-0 bind offset.
- **Identity local rotations === T-pose.** Warudo records VRM-normalized bind offsets, and the VRM rest pose is a T-pose; verified via `scripts/checkIdentityPose.mjs` (arms horizontal, legs vertical, head at correct height). So the `tposeRest` export option just zeroes each bone's default Lcl Rotation — the curves still play the motion. NOTE: the bone array is NOT topologically sorted (`UpperChest` is index 54 but parents `Neck`/shoulders at indices 9/11), so any manual world-space reconstruction must resolve parents recursively, not in a single forward pass. Three.js parenting and FBX `OO` connections handle order correctly on their own.
- **Export name schemes** (`convert/skeleton.ts`): default `unity` keeps HumanBodyBones names (needed for Unity/Warudo name-keyed retarget); `motionbuilder` remaps to HumanIK/Mixamo names (`LeftArm`, `LeftForeArm`, `LeftUpLeg`, `Spine1/2`, `LeftHandThumb1`…) so MotionBuilder auto-characterizes. Renaming is export-only; the parent table and preview are index-based and unaffected.
- **Variable frame timing**: timestamps are render frames, not a fixed clock (~57–60 fps, irregular). `resample()` is mandatory before export; the preview instead plays the raw timestamps in real time so it needs no resampling.
- **Bone positions are local-to-parent** (e.g. LeftLowerLeg ≈ `(0,−0.40,0.01)` = thigh length), EXCEPT Hips which is character-root-relative. Don't treat them as world positions.
- **Blendshape channels** (field 4) are parsed into `ConvertedClip.face` and played on the preview face overlay, but NOT exported to FBX — that would need a mesh with matching morph targets, which `.wanim` cannot supply.
- **Face overlay model**: `public/facecap-head.glb` is the three.js "facecap" head (by Face Cap / Bannaflak) with its KTX2 textures **stripped** (`scripts/stripGlbTextures.mjs`) so it loads without a Basis transcoder; geometry is meshopt-compressed, decoded in-browser via `MeshoptDecoder` (pure JS, bundled — no public wasm). To regenerate: download `examples/models/gltf/facecap.glb` from three.js, run the strip script. Its morphs use `_L`/`_R` suffixes vs. the recordings' Apple `Left`/`Right` — `toFacecapName()` in `face.ts` maps them. **Credit Face Cap/Bannaflak** (footer + README) — don't drop it.
- **Preview faces the camera via a 180° Y rotation on the bone root** (`scene.ts`); the Unity→RH Z-flip otherwise leaves the performer facing away. This is preview-only and does not touch the exported transforms.
