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
- FBX output is a **hand-rolled BINARY FBX writer** (`src/fbx/fbxBinary.ts` serializer + `src/fbx/animationFbx.ts` document builder) — MotionBuilder 2018+ does not import ASCII FBX.
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
npm run cleanCheck -- [file.wanim]           # verify the cleaning filters (despike/butterworth/wrist/forearm/feet) on real data
npm run vrmaCheck  -- [file.wanim] [out]     # VRMA exporter structural check (VRMC_vrm_animation layout)
npm run wanimCheck -- [file.wanim]           # WANIM re-export round-trip: set name + channels + values + bones preserved
npm run rigCheck   -- [file.wanim]           # control-rig layers + modifiers: additive/override/weight/stacking/IK invariants
```

No unit-test framework yet — the three `npm run` scripts above are the regression checks (they import the real `src/` modules). `node --experimental-strip-types` runs the TS directly: see the gotcha below.

## Build / runtime gotchas

- **TS imports MUST carry the `.ts` extension** (`import { x } from "./foo.ts"`). The smoke scripts run under Node's `--experimental-strip-types`, which does no path resolution; `tsconfig` has `allowImportingTsExtensions: true` and Vite handles it for the browser build.
- **No TS-only runtime syntax in strip-only mode**: no `constructor(private x)` parameter properties, no enums, no decorators. `src/wanim/msgpack.ts` uses an explicit field + assignment for exactly this reason.

## Pipeline (implemented)

```
.wanim (drag/drop, whole page)
  → src/wanim/parse.ts:  LZ4BlockArray decode (lz4.ts) → msgpack decode (msgpack.ts) → WanimClip
  → src/convert/clip.ts: convertCharacter() — Unity LH→RH by MIRRORING X (pos negate x; quat→(x,-y,-z,w)),
                          bake root into Hips, sign-continuous quats. The X-mirror (NOT the Z-mirror) leaves the
                          character facing +Z with left at +x — REQUIRED by MotionBuilder HIK characterization
                          (a −Z-facing T-pose makes auto-mapping mirror the legs/feet). retargetProportions()
                          optionally re-proportions onto the Ybot skeleton (keeps rotations, swaps bind offsets,
                          scales hips travel by the hips-height ratio) — the "Proportions" UI option.
                          resample() → ResampledClip (fixed fps, linear pos / slerp rot) for export.
  → src/fbx/animationFbx.ts: binary FBX — LimbNode skeleton + AnimationStack/Layer, per-bone Lcl Rotation
                          curves + Hips Lcl Translation curve, skinned meshes, BindPose, TPose take. meters→cm, Y-up.
  → src/convert/clean.ts: optional mocap cleaning — despike (pops/hand-flips via neighbour slerp), zero-phase Butterworth low-pass (filtfilt) on rotations + hips translation, twist/swing limits + locks for wrists AND forearms (twist about the bone axis toward the child joint), and feet-contact fixing (src/convert/feet.ts: floor estimated from data per foot — resting joint height varies per avatar, never assume y=0; contact = low AND slow with hysteresis; ankle pinned per plant via two-bone leg IK, recorded knee as pole, foot keeps recorded world rotation; runs LAST so smoothing can't reintroduce drift; writes leg-chain rotations only). Applied to the converted clip so it shows in preview AND export. The cleaning panel has a hold-to-compare button; preview.setClip(clip, keepView=true) keeps camera + playhead (also why filter toggles don't reset the view).
  → src/rig/rig.ts + modifiers.ts + timewarp.ts: MotionBuilder-style control rig, baked AFTER
                          cleaning/proportions/spine. Modifiers = whole-clip slider corrections (hips height with
                          feet re-solved onto their original targets, knees/elbows in-out via rigid rotation of the
                          two-bone limb about its end-to-end axis — swings ONLY the mid joint, closed form, no IK —
                          stance width, MIRROR (swap L/R tracks keeping each side's own binds + reflect quats
                          (x,−y,−z,w) + negate hips x; face untouched), and REACH (per-limb pull of hand/foot back
                          toward the UNCLEANED path via two-bone IK — ref clip = buildDisplay(false) cached per
                          reclean gen, run through the same modifiers so timelines/mirroring match)). TIME WARP
                          (timewarp.ts) = speed-ramp keys in SOURCE time, applied FIRST in the pipeline (resamples
                          onto a uniform grid; duration changes → reclean rebuilds the transport when it drifts).
                          RANGE SMOOTH (clean.ts smoothRange) = trim-range-only Butterworth with 0.25 s edge blends,
                          stacked after cleanClip. reduceKeys() = greedy key reducer (drops keys the sampled curve
                          wouldn't miss). All of warp/ranges/mods serialize into undo snapshots, the localStorage
                          cache, and .rig.json (v2).
                          LAYERS (v0.26 architecture — the way MoBu actually works): layers hold PER-BONE LOCAL
                          channel curves (RigTrack keyed by bone; rot keys everywhere, pos keys on Hips only), and
                          the rig is an INPUT DEVICE. Dragging solves IK/FK ONCE at capture time
                          (solveEffectorOnPose on the full-stack pose → captureBoneKeys writes the affected bones'
                          locals: additive = conj(below_local) ⊗ solved_local, override = solved local value).
                          EVALUATION IS PURE CURVE COMPOSITION — no FK, no IK, no world space:
                          additive local = base ⊗ slerp(I, delta, w·env), override = slerp(base, value, w·env).
                          That's what makes corrections stable: override keys PIN local pose exactly (pop fixes —
                          keyFullPose brackets + a fixed key, proven 0.00 mm on any base), additive keys are local
                          deltas ("elbow +20°") that travel exactly when retimed/copied/pasted — NO base-dependent
                          conversion anywhere. A hand IK drag writes keys on its 3 chain bones = the 3 effectors
                          owning those bones (effectorForBone is 1:1 with EFFECTORS[].bone). Each layer:
                          override/additive, weight, extent "fade" (default; FULL strength across the keyed range —
                          keyed override sections HOLD their pose, values interpolate on the layer's own curve —
                          easing to zero only OUTSIDE first/last key; a brief gap-dipping variant collapsed override
                          sections mid-span and was reverted) or "hold" (first/last key extends; bracket with
                          neutral keys). Drags snap to the exact frame. keyEffectorTarget() = one-call solve+capture
                          for tests/programmatic edits. AUDIT INVARIANTS (v0.26.2, all in rigCheck): keys +
                          envelopes live in PLAYBACK time — every evaluation site normalizes via
                          frameTime(clip,f)=times[f]−times[0] (recordings can start nonzero); capture solves on
                          stackPoseThrough(layerIndex) so layers ABOVE the edited one are never absorbed into its
                          keys (the drag display re-applies them on top); Neutral key covers the same bones a drag
                          writes (whole IK chain); convertLayerMode() translates every key when the mode dropdown
                          flips so the pose survives additive⇄override; paste refuses cross-mode targets.
                          PERF: bake = per-bone quat ops only (19-track full-pose layer over 12k frames ≈ 190 ms);
                          rig edits rebake IN PLACE over the edit's dirtyRange (bit-identical to full — proven),
                          repose with preview.seek, NEVER setClip; big rebakes run CHUNKED via bakeRangeAsync
                          (12 ms slices in a promise queue with a superseded-by-reclean guard) so editing never
                          blocks. Key tools: timeline diamond markers (click = jump+select, ctrl-click multi-pick,
                          drag = retime — dragging a picked key slides the whole selection, right-click menu,
                          shift-drag band select; Ctrl+C/V/Del), "Key pose" locks the pose (provably changes
                          nothing). Rig state auto-saves per recording (wanimrig:<name>:<frames>) and
                          exports/imports as .rig.json v3 (older effector-space keys are DROPPED on load with a
                          note — they can't be converted). Order: modifiers → layers; both apply to display AND
                          all three exports (wanim path re-applies them to its own clip).
                          Viewport: small faint effector handles (hover brightens, dim while dragging) +
                          TransformControls gizmo, LOCAL space default (world rings never align with a limb — that
                          read as "snapping"; Q toggles, W/E set move/rotate). Handles are DIRECTLY draggable in the
                          camera plane (Poser style, no gizmo grab needed); a handle click beats the gizmo unless
                          it's the selected effector's own. Drag routing is by WHAT CHANGED (pos vs rot), not gizmo
                          mode — needed because direct drags always send positions. Translate-dragging an FK bone =
                          swing about its joint toward the drag (fkDragRef tip chains; pulling the chest forward
                          LEANS it forward), stored as a world-space rotation key. Drags = live single-frame solve
                          via setPoseOverride; key lands at the playhead on release. Undo/redo =
                          JSON snapshots of layers+modifiers pushed BEFORE each mutation (buttons + Ctrl+Z/Y via a
                          module-level hotkey singleton so re-loading a file doesn't stack listeners).
  → src/preview/scene.ts: Three.js Object3D bone hierarchy driven per-frame; LineSegments + Points stick figure. Supports trim looping (setTrim).
  → src/ui/curves.ts: canvas curve editor on the LAYER KEYS (not the dense baked motion) — selected
                          effector's pos deltas (cm) + rot deltas (ZYX euler °, quatToEulerZYX/eulerZYXToQuat
                          round-trip) as per-axis curves. Keys drag VERTICALLY only (retime lives on the strips);
                          right-click = ease linear/smooth/step (per-key `ease` on the segment LEAVING the key,
                          honored in samplePos/sampleRot) + delete. Value drags rebake live via the dirty-range
                          path; the graph redraws itself — the host must NOT rebuild the view mid-drag
                          (setModel refuses while dragging). Toggled with the dope sheet via the Keys/Curves button.
  → src/ui/transport.ts: transport bar docked at the bottom of the editor suite — play/pause, click-to-seek timeline with draggable in/out trim handles, rig-key markers, and a mini DOPE SHEET (per-effector key rows for the active layer, shown only on the Rig tab; rows pixel-align to the strip by measuring against the rows element's own border box — its padding doesn't shift getBoundingClientRect). resample() takes trimStart/trimEnd to export only the trimmed range (rebased to t=0).
  → SCENE FILES (main.ts): "Save scene…" (Info tab + transport Save… button) bundles the ORIGINAL
                          .wanim bytes (base64) + rig state + cleaning/export settings + trim + playhead + the
                          CUSTOM VRM/GLB BODY (scene v2, userBodyBytes) into one `<name>.scene.json` (magic
                          "wanimscene") — the file IS the whole work project. Dropping it (or any .json) routes
                          through handleFile → loadWanim(bytes) with pendingScene applied in buildPanel
                          (adoptRigState + applyScene + async embedded-body restore) before the initial reclean.
                          The localStorage cache also carries `settings` (same applyScene path). Transport has
                          Open…/Save… (setSceneActions — REWIRE after the warp-duration transport rebuild);
                          the landing page has an Open button. Export filenames come from the #outName toolbar
                          field (outBase(), default `<name>-clean`). Long UI explanations live in collapsed
                          <details class="hint-box"> (i) toggles — keep new explanations under one.
                          WANIM WRITER CONTAINER: writeWanim wraps its payload in a REAL MessagePack-C#
                          LZ4BlockArray ([ext98(sizes), bin...]) using literal-only LZ4 blocks
                          (lz4CompressBlockLiteral — valid for any standard decoder). scripts/wanimDiff.mjs
                          compares payload FORMAT BYTES against an original recording (field 4 verified
                          byte-identical in structure: fixstr keys, float32 values, map16 frame maps).
  → UI SHELL (index.html + main.ts buildPanel): editor suite — top #editbar toolbar (undo/redo, gizmo mode+space, hold-to-compare, format+Download), right #dock with tabs Clean/Rig/Export/Info, bottom #timeline-dock. buildPanel writes editbar.innerHTML + dock.innerHTML per file load (fresh nodes = no stacked listeners). Rig handles + dope sheet are GATED to the Rig tab (syncRigVisibility). Element IDs are unchanged from the single-drawer era — keep it that way, tests and wiring key off them.
  → src/preview/face.ts:  ARKit face overlay — loads public/facecap-head.glb, seats it at the Head joint,
                          drives morph targets from the recorded blendshapes (also embedded in the FBX, skinned).
  → src/convert/body.ts + src/preview/body.ts: Ybot body retarget (weights remapped to our bones) for preview
                          SkinnedMeshes and FBX skinned-mesh export.
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
- **Read GLB attributes through accessors (`fromBufferAttribute`/`getComponent`), NEVER raw `.array`** — meshopt-decoded GLBs use INTERLEAVED attributes where `.array` is the mixed pos/normal/uv buffer; raw copies shred the mesh into slivers (this corrupted the exported face for several versions while counts/round-trips still passed). `scripts/fbxView.html` + `scripts/shotFbx.mjs` render the EXPORTED FBX in a browser — use them to visually verify any geometry change; counting bones/tracks is not enough.
- **The MoBu pose probe** (`scripts/mobuPose.py` + `scripts/expectedPose.mjs`) compares MoBu-evaluated world matrices against quaternion ground truth — confirmed exact (to 5 decimals) at chain ends, so the Euler/rotation-order path is settled; don't re-suspect it.
- **Mesh models need `DefaultAttributeIndex: 0`** in Properties70, or the SDK applies the template default (-1 = no active attribute) and MotionBuilder imports the model as a **Null instead of a Mesh** (silently — no log). Found via `meshProbe.ts` bisection. Meshes also need a normals LayerElement + Layer.
- **Embedded meshes are SKINNED, not parented** (`SkinnedMeshExport` in the writer): mesh Model at scene root, Skin deformer + per-bone Clusters (Transform = inverse bind, TransformLink = bind; identity-rotation T-pose matrices), plus a `Pose/BindPose` object. Parenting a mesh under a bone "weights oddly" in MoBu retarget pipelines.
- **Everything faces +Z, with no flips anywhere**: the X-mirror conversion makes the skeleton face +Z, which matches the facecap head and the Xbot body natively. The preview applies no display rotation either. If a mesh comes out back-to-front ("legs backwards, arms upside-down"), some stage reintroduced a facing mismatch — check with `scripts/checkOurFacing.mjs` (toes/eyes must have dz>0) and `scripts/checkFacing.mjs` (Xbot reference).
- **A `TPose` take** (one-key stance at t=0) is exported alongside the animation take so MoBu can characterize from a guaranteed T-pose (fixes feet/limb auto-mapping). MoBu builds its take list from the legacy `Takes` node — an AnimationStack without a matching `Take` entry there does NOT appear.
- **Body mesh** (`src/convert/body.ts` + `public/body.glb` = "Suit" from Quaternius' Ultimate Modular Women pack, CC0, textures stripped — fem preferred per user): a **closed-form world-space transfer** that works for ANY humanoid GLB. (1) Capture the rest state convention-free: per-vertex world positions via the asset's OWN skinning (`applyBoneTransform` at rest — NEVER trust inverse-bind matrices: 2017-era Quaternius ships degenerate near-identity binds, Blender exports keep the bind in node rests, Mixamo bakes armature scale), plus rest joint positions/segment dirs (childless feet use foot-vertex centroids). (2) Global yaw to face +Z (toe heading or foot centroids). (3) T-pose the JOINT TABLE by pure vector math (chain-accumulated rotations to canonical axes: arms ±X, spine +Y, legs −Y, feet keep pitch) — this layout is exported as the body-skeleton proportions. (4) Per-bone delta `D_j = T(ourJoint)·Stretch(ourAxis, lenRatio)·R(restDir→ourAxis)·G·T(−restJoint)`; vertices = weight-blended `D_j · restVert`. **NO scene-graph mutation** (hierarchy edits with non-uniform scales shear across rig conventions; this was learned the hard way) and **NO aesthetic knobs** (girth/slim constants were all deleted — the look is the asset's own). Name mapping: Unity + MoBu names, `RIGIFY_MAP` (DEF-*), and `modularToUnity` (UpperArmL/WristR/Abdomen/Torso-style); unmapped helpers walk up to the nearest mapped ancestor. Modular `*_Head_*`/`*_Ears*` sub-meshes are skipped entirely; single-mesh assets get the positional head cut. Face seat constants from `measureBodyHead.mjs` (re-run when swapping the asset!). "Proportions: Body-mesh skeleton" (DEFAULT) puts the clip on the body's T-posed joints for a 1:1 mesh; "Recorded avatar" is a measured approximate fit.
- **Blendshape export** (face mesh, on by default): the facecap head is a SKINNED mesh (cluster → Head bone, world-space bake via `convert/meshExport.ts`: recenter, ~25cm, +5cm lift, NO rotation) with `BlendShape`/`BlendShapeChannel` deformers + `Shape` delta geometries and `DeformPercent` curves from the recorded ARKit weights. Connection chain FBXLoader/MoBu need: curveNode→channel (`OP DeformPercent`), curve→curveNode (`OP d|DeformPercent`), channel→blendShape→geometry→model (`OO`). Verify with `npm run faceFbxCheck` + the MoBu batch check (48 animated props confirmed).
- **Rotation order is THE thing to verify in a real DCC.** We extract quaternion→Euler in three.js 'ZYX' order (`quatToEulerZYX`) and write it with the default `RotationOrder`, because three's FBXLoader maps FBX's default onto ZYX — and the round-trip check (`npm run fbxcheck`) confirms it reconstructs 55 bones + a clip with the hips traveling. **The preview (quaternion-driven) is always correct; the FBX Euler order is the risk.** If limbs twist/spin in Blender/Maya but the preview looked fine, the fallback is to try XYZ extraction + matching `RotationOrder`. Euler tracks are unwrapped (`unwrapDegrees`) and quats made sign-continuous to prevent 360° pops.
- **Hips vs. root**: `convertCharacter` bakes the character root (fields 5/6) into the Hips, so Hips (the FBX root LimbNode, parented to scene) carries full world translation+rotation; all other bones stay local-to-parent. Limb bones export rotation curves only; their translation is constant at the frame-0 bind offset.
- **Degenerate zero-norm quats must read as IDENTITY in any hand-rolled FK** (`safeQuat` in `src/convert/fk.ts`). Recordings fill missing bones (UpperChest, Jaw) with all-zero quaternions; three.js's matrix compose silently treats those as identity, but a naive quatMul propagates the zeros and freezes every descendant at bind pose. This bug made rig deltas get captured against a phantom T-pose arm before the fix — if preview and an FK-based computation ever disagree, check for a zero quat on the chain first.
- **Identity local rotations === T-pose.** Warudo records VRM-normalized bind offsets, and the VRM rest pose is a T-pose; verified via `scripts/checkIdentityPose.mjs` (arms horizontal, legs vertical, head at correct height). So the `tposeRest` export option just zeroes each bone's default Lcl Rotation — the curves still play the motion. NOTE: the bone array is NOT topologically sorted (`UpperChest` is index 54 but parents `Neck`/shoulders at indices 9/11), so any manual world-space reconstruction must resolve parents recursively, not in a single forward pass. Three.js parenting and FBX `OO` connections handle order correctly on their own.
- **Export name schemes** (`convert/skeleton.ts`): default `unity` keeps HumanBodyBones names (needed for Unity/Warudo name-keyed retarget); `motionbuilder` remaps to HumanIK/Mixamo names (`LeftArm`, `LeftForeArm`, `LeftUpLeg`, `Spine1/2`, `LeftHandThumb1`…) so MotionBuilder auto-characterizes. Renaming is export-only; the parent table and preview are index-based and unaffected.
- **Variable frame timing**: timestamps are render frames, not a fixed clock (~57–60 fps, irregular). `resample()` is mandatory before export; the preview instead plays the raw timestamps in real time so it needs no resampling.
- **Bone positions are local-to-parent** (e.g. LeftLowerLeg ≈ `(0,−0.40,0.01)` = thigh length), EXCEPT Hips which is character-root-relative. Don't treat them as world positions.
- **Blendshape channels** (field 4) are parsed into `ConvertedClip.face`, played on the preview face overlay, AND exported to FBX as morph animation on the embedded facecap head (see "Blendshape export" above).
- **Face overlay model**: `public/facecap-head.glb` is the three.js "facecap" head (by Face Cap / Bannaflak) with its KTX2 textures **stripped** (`scripts/stripGlbTextures.mjs`) so it loads without a Basis transcoder; geometry is meshopt-compressed, decoded in-browser via `MeshoptDecoder` (pure JS, bundled — no public wasm). To regenerate: download `examples/models/gltf/facecap.glb` from three.js, run the strip script. Its morphs use `_L`/`_R` suffixes vs. the recordings' Apple `Left`/`Right` — `toFacecapName()` in `face.ts` maps them. **Credit Face Cap/Bannaflak** (footer + README) — don't drop it.
