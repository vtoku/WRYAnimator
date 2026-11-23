# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **client-side web app** that converts a **Warudo `.wanim` animation recording** into an **`.fbx` animation file**. Drop a `.wanim` on the page → preview the motion in 3D → download the FBX.

This is a **sibling of [VRMxShogun](https://github.com/vtoku/VRMxShogun)** (local checkout: `C:\Users\VTOKU\Documents\Claude\VRM2VICON`). That repo is the architectural template: same stack, same Pages deployment, same hand-rolled ASCII FBX writer approach. Read its `CLAUDE.md` and `SPEC.md` before working here — especially the FBX writer (`src/fbx/asciiFbx.ts`) and the drag-drop/preview UI (`src/main.ts`, `src/preview/scene.ts`), which can be adapted heavily.

Hosted on **GitHub Pages** at the custom domain `https://wryanimator.com/` (repo `vtoku/WRYAnimator`, renamed from `WANIMxFBX` — the local folder keeps the old name; deploys from the `main` branch via Actions). Pages is **static hosting — there is no backend**. WANIM parse, decompression, FBX generation, and download all run **in the browser**. Never add a server-side step.

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
- FBX output is a **hand-rolled BINARY FBX writer** (`src/fbx/fbxBinary.ts` serializer + `src/fbx/animationFbx.ts` document builder) — the target animation DCCs (2018+) do not import ASCII FBX.
- `playwright` is a devDependency used only by `npm run drive` for headless browser verification; it is not shipped.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc --noEmit && vite build
npm run preview    # serve built dist/ — ALWAYS test the Pages base path here, not just dev
npm run smoke    -- <file.wanim> [out.fbx]   # parse → convert → resample → write FBX, brace/section sanity check
npm run fbxcheck -- <file.fbx>               # load an emitted FBX back with three's FBXLoader, report bones+clip
npm run faceFbxCheck -- [file.wanim]         # blendshape/morph FBX structural check (BlendShape/DeformPercent chain)
npm run drive    -- [file.wanim]             # Playwright: drive the running dev server, screenshot, test download
npm run bootcheck -- [file.wanim]            # Playwright: DCC boot + IndexedDB session-restore + reset lifecycle
npm run cleanCheck -- [file.wanim]           # verify the cleaning filters (despike/butterworth/wrist/forearm/feet) on real data
npm run vrmaCheck  -- [file.wanim] [out]     # VRMA exporter structural check (VRMC_vrm_animation layout)
npm run wanimCheck -- [file.wanim]           # WANIM re-export round-trip: set name + channels + values + bones preserved
npm run rigCheck   -- [file.wanim]           # control-rig layers + modifiers: additive/override/weight/stacking/IK invariants
npm run animCheck  -- [file.wanim] [--unity <dir>]  # Unity humanoid .anim (beta): structure + round trip; with --unity, Unity's playback vs the source
```

No unit-test framework yet — the three `npm run` scripts above are the regression checks (they import the real `src/` modules). `node --experimental-strip-types` runs the TS directly: see the gotcha below.

## Headless API, CLI and MCP (`src/api/`, `cli/`)

The editor's core also runs without a browser, for AI agents and scripts. **One core, several front ends** — keep it that way:

- `src/api/session.ts` — `openSession(bytes, opts)` → a `Session`: the numeric editing API (layers, `key.set`, `hold.insert`, `limit.apply`, scoped filters, `evaluate`, `diff`, `scan`, undo/redo, `.rig.json` save/load, `exportWanim`). Pure TS, no DOM, strip-types safe.
- `src/api/ops.ts` — **the operation table**: every operation's name, description, JSON-schema arguments and implementation. The MCP server turns each entry into a tool (`limit.apply` → `wry_limit_apply`), the CLI runs them from flags or edit scripts. Add an operation HERE and it appears in both. A future `window.wry` should expose the same table.
- `src/api/anatomy.ts` — wrist `flex / deviation / twist` and finger `curl / splay` ⇄ quaternion. The sign convention is documented at the top of that file (flex + = palm-ward, deviation + = thumb side, twist + = supination, same meaning on both sides). `compose(decompose(q)) === q`.
- `src/api/scan.ts` — problem detection (`wrist_hyperbend`, `wrist_axis_flip`, `twist_excess`, finger kinds, `pop`, `jitter`, `foot_slide`, `floor_penetration`, `root_pop`); thresholds are parameters (`DEFAULT_THRESHOLDS`).
- `src/api/pipeline.ts` — `runPipeline()`: the edit stack in the same order as `main.ts` `buildDisplay()` / `doExport()`, with inputs passed as data. **`main.ts` does not call it yet** — if a stage is added or reordered in `main.ts`, mirror it here.
- `src/wanim/exactWanim.ts` — **timing-exact `.wanim` export**. It patches the ORIGINAL decompressed payload in place, overwriting only cells where the edited clip differs from the base by more than 1e-6 rad; timestamps (float64), untouched bones, root tracks, blendshapes and fields 7–9 are the source's own bytes. A no-edit export returns the source file byte for byte. Edited quats are un-mirrored and written in the original hemisphere (never q → −q). `writeWanim.ts` remains the RESAMPLING writer (used by the web app's WANIM download and `wry convert --resample`).
- `cli/wry.mjs` (CLI), `cli/mcp.mjs` (hand-rolled stdio MCP server, no dependencies), `cli/core.mjs` (file I/O shared by both), `cli/options.mjs` (flags of the one-shot `info` / `convert` / `unpack` commands).

```bash
npm run wry -- scan take.wanim            # or: node cli/wry.mjs …   (JSON on stdout; exit 0 ok / 1 failed / 2 usage)
npm run mcp                                # MCP server on stdio
npm run apiCheck -- [--ptid ptid_excerpt.wanim] [--ab ab_excerpt.wanim]   # API + exact export + CLI + MCP acceptance
```

Invariants (all covered by `apiCheck`):

- **Sessions never change timing.** No resample, no time warp; an edit changes only the bones and frames it names (plus its blend). Operations refuse while a rig with a time warp is loaded.
- **Scope guard.** `allowBones` / `denyBones` per session; any operation that would write a bone outside scope throws `ApiError` and leaves the session unchanged. Files named `*TWISTFIX*` get `protectForearmTwist` (no twist limits / twist keys on a LowerArm). Nothing in the API writes face blendshapes. Programmatic hand edits never redistribute twist onto the forearm (the UI's `WRIST_TWIST_SHARE` is not applied).
- **Times** in the API are playback seconds + the session's `timeOffset` (default 0; an excerpt's sidecar `<file>.json` `sourceTimeStart` is picked up by the CLI/MCP so excerpts answer to source-take times). Rig files always store playback time.
- **Span operations are layers.** `hold.insert` and `limit.apply` each add their own override layer (dense per-frame keys with a near-zero fade, or two sparse keys for a symmetric hold), so they are undoable, serialised in `.rig.json`, and visible in the web editor.
- **MCP stdout is protocol only.** `cli/core.mjs` never prints; `serve()` reroutes `console.log` to stderr.

**Local link (site ⇄ local agent).** `cli/link.mjs` is a tiny HTTP server on `127.0.0.1` that the MCP server starts on `wry_view`; `src/agentLink.ts` is the page side. The page opened as `https://wryanimator.com/#agent=<port>-<token>` (or File → Connect to local agent…) subscribes to `/<token>/events` (SSE), fetches the recording and the current `.rig.json`, and replays them through the normal paths (`loadWanim`, then `agentPanel.applyRig` = `adoptRigState` + `reclean`), re-fetching the rig after every mutating tool call. Rules: the site stays static (the PAGE connects out to loopback, never the reverse); the link is **read-only** (GET only), token-gated, origin-checked (site origin + localhost; `WRY_SITE` / `WRY_LINK_ORIGINS` override for dev), and the token rides in the URL fragment so it never reaches the web host. The session loads under the name `[agent] <name>` so it cannot overwrite the browser's own cached edits for that recording. `npm run build && npm run linkCheck` drives it in Chromium against `vite preview`.

**Layers rail** (`renderLayerRail` in `main.ts`): header always shows `+ Additive` / `+ Override` (first button keeps class `rail-btn` — `railProbe.mjs` clicks it); rows carry a mode chip, key count, weight, mute; the active layer expands with segmented Mode / Extent toggles (`railSeg`, no `<select>`s), fade, and ↑ ↓ Rename Duplicate Delete. Inline rename stops key events from reaching the editor hotkeys. `npm run build && npm run layersCheck` covers it.

**Face blendshape keys** (`RigLayer.face`, optional `FaceKeyTrack[]` = `{name, keys:[{time, v, ease?}]}`): scalar corrections on recorded blendshapes with the same layer semantics as bones (additive = base + offset, override = lerp to value, × weight × envelope, clamped 0..1 on touched channels only). `applyRigLayers` bakes them into `clip.face`, so every RESAMPLED export (FBX, VRMA, WANIM, .anim, and the CLI's `convert --rig`) carries them. The editor's display keeps a PRIVATE copy of the face tracks (`ownFace` in `buildDisplay`) that `rebakeRig` rebakes whole with `bakeFace`, then `preview.refreshFace()` rebuilds the VRM-derived tracks. UI = the Face section of the Rig tab (`#facePanel`: channel select, Value slider that keys on drag and pauses playback, Key / Delete key / prev / next). Keys ride in undo snapshots, the rig cache and `.rig.json` as part of the layer, and are remapped by `remapForWarpChange` and `convertLayerMode`. NOT done: face keys do not show on the timeline strip, dope sheet or curve editor; no API operation creates them (the agent rule "never touch face blendshapes" stands) and the timing-exact WANIM export (`exactWanim.ts`) ignores them — face stays the source's bytes there. `npm run faceKeyCheck -- <file.wanim>` + `npm run build && node scripts/faceWebProbe.mjs <file.wanim>` cover it.

Not built yet (from the agent handoff): headless `render` (before/after images), and the rest of the web-app side — a full `window.wry` API, typed numeric fields in the inspector, a Scan panel. The local link is one-way (agent → page); edits made in the page do not flow back to the agent's session. `matchKeys` / `blendKeysToward` are not exposed as operations.

## Unity humanoid .anim (beta) — `src/anim/`

A fourth export format: a text (YAML) `AnimationClip` with Unity's ~95 humanoid **muscle** curves, `RootT` / `RootQ`, and `blendShape.<name>` curves. Format value `anim`; labelled **beta** everywhere it surfaces (site format menu, File menu, CLI/MCP notes). Like FBX and VRMA it is a RESAMPLED export, and like WANIM it always uses the RECORDED proportions (a humanoid clip is measured against the avatar's own skeleton).

- `src/anim/humanoid.ts` — the muscle math. `buildHumanoidRig()` (per-skeleton axes), `poseToHuman()` (pose → muscles + body transform), `musclesToLocal()` (the forward model). All in UNITY space (left-handed): convert with pos `(−x, y, z)`, quat `(x, −y, −z, w)`.
- `src/anim/unityAvatarData.ts` — GENERATED constants (per-bone `preQ` / `postQ` / sign, muscle ranges) from a Unity probe of a reference avatar. Regenerate with `scripts/animGenData.mjs`; never edit by hand.
- `src/anim/writeAnim.ts` — `writeUnityAnim(resampledClip, opts)` → `{bytes, report}`. Key reduction is per muscle (legs and spine tightest, fingers loosest).

Unity does not publish this math. Everything below was MEASURED against Unity 2022.3 in batch mode (`scripts/unity/AnimProbe.cs`), and is the knowledge that is easy to lose:

- **Bone local = `preQ ⊗ ZYRoll(dof · sign) ⊗ conj(postQ)`**, with `ZYRoll(x, y, z) = swing(0, ty, tz, 1) ⊗ roll(tx, 0, 0, 1)`, `t = tan(angle / 2)`. Muscle = angle ÷ max (positive side) or ÷ −min (negative side), degrees. Muscles are NOT clamped to ±1 on playback (verified with values past 3).
- **Limb twist is distributed** (Unity's default 0.5): half of the upper bone's roll is applied at the lower bone about the upper bone's axis, and half of the lower bone's roll at the hand/foot about the lower bone's axis. The forward model matches Unity to < 0.05° on random muscles. The lower arm/leg has no side-swing muscle, so its direction decides the upper bone's roll.
- **The inverse is ours, not Unity's.** Bones are fitted in hierarchy order against WORLD targets through the forward model, so hands and feet land exactly and a missing degree of freedom is picked up by the next bone. Unity's own inverse makes different (equally lossy) choices.
- **Limb twist must be tracked through time.** Two elbow/knee solutions exist (flexed, or hyperextended with the limb turned over) and recordings do hyperextend; choosing per frame flips the twist by 180° between frames. `poseToHuman` carries the twist in `limbState` — pass each frame's result back in as `out`. A roll well past half a turn is let go (`ROLL_LIMIT`) so one tracking glitch does not leave a limb wrung.
- **Body position = Σ weight · joint position ÷ humanScale**, with fixed per-joint weights (table `MASS`, total 82.5 — recovered to 7 decimals; the left/right ARM asymmetry is Unity's own, not a typo). A joint the avatar lacks hands its weight to its children equally (measured for UpperChest; assumed for other optional bones). `humanScale` = the body centre's height in the T-pose.
- **Body rotation** = the frame built from the upper-leg and upper-arm joints (up = arms − legs, right = leg vector + arm vector), relative to the same frame in the T-pose. Within 0.04° on real poses; up to a few degrees off on extreme random poses (not chased).
- **Finger curves are named `LeftHand.Index.1 Stretched`** in a clip, NOT `HumanTrait.MuscleName` ("Left Index 1 Stretched") — Unity silently ignores the latter (they import as generic curves, 40 fewer muscle bindings).
- **`postQ` follows the bone's direction** (toward its child; the hand continues the forearm; a Chest without an UpperChest aims at the Neck; finger tips reuse the middle segment's axes). Re-aiming the reference by the shortest rotation reproduces Unity to ~0.1° except thumbs (a few degrees of roll).
- **`preQ` is NOT fully understood** for limbs and fingers: it depends on the T-pose bend plane and does not follow any single rule tried (constant; `post ⊗ K`; relative to the parent's frame). The code uses `post ⊗ K` with `K` from the reference avatar. This is the source of the remaining error on other avatars. The four probe skeletons used (reference, axis-snapped, perturbed, a second real avatar) are the way to test a better rule.
- **The file**: flow-style keys without weight fields, `m_EditorCurves: []` and an empty `m_ClipBindingConstant` all import fine (Unity rebuilds them). Blendshape curves use `classID: 137` and a mesh path (default `Face`). Clip settings bake the motion into the pose (root transform untouched).
- **T-pose hips height is not in a `.wanim`**; it sets `humanScale`. The writer estimates it from where the ankles rest in the take (5th percentile) plus the leg length; `tposeHipsHeight` overrides. A wrong value scales the hips' travel, so feet float or sink by that percentage.

Measured accuracy (Unity playback of the exported clip vs the source, world space): reference avatar — hands/feet/head/hips within 0.5°, wrists/ankles within 1.5 mm; a second real avatar — within 2.4° and 11 mm (on a 2 m character). Fingers and especially thumbs lose roll in muscle space whichever tool writes the clip (Unity's own conversion: thumb tips ~15 mm mean).

```bash
npm run animCheck -- [file.wanim]                                   # writer structure + own round trip (no Unity needed)
npm run animCheck -- <file.wanim> --unity <scratchUnityProjectDir>  # + Unity imports the clip and its playback is compared with the source
npm run build && node scripts/animWebProbe.mjs                      # the site's format menu + download
```

`scripts/animUnity.mjs` runs the probe (`run` = Unity's own muscles and avatar axes for a skeleton + poses; `forward` = muscles → bones; `verify` = import our clip and sample it). It needs a local Unity editor (`UNITY_EXE`, or the newest 2022.3 under Unity Hub) and creates the scratch project on first use. Do NOT wait on Unity with PowerShell `Start-Process -Wait` (it hangs on Unity's helper processes); the script uses `spawnSync`.

## Build / runtime gotchas

- **TS imports MUST carry the `.ts` extension** (`import { x } from "./foo.ts"`). The smoke scripts run under Node's `--experimental-strip-types`, which does no path resolution; `tsconfig` has `allowImportingTsExtensions: true` and Vite handles it for the browser build.
- **No TS-only runtime syntax in strip-only mode**: no `constructor(private x)` parameter properties, no enums, no decorators. `src/wanim/msgpack.ts` uses an explicit field + assignment for exactly this reason.

## Pipeline (implemented)

```
.wanim (drag/drop, whole page)
  → src/wanim/parse.ts:  LZ4BlockArray decode (lz4.ts) → msgpack decode (msgpack.ts) → WanimClip
  → src/convert/clip.ts: convertCharacter() — Unity LH→RH by MIRRORING X (pos negate x; quat→(x,-y,-z,w)),
                          bake root into Hips, sign-continuous quats. The X-mirror (NOT the Z-mirror) leaves the
                          character facing +Z with left at +x — REQUIRED by HumanIK characterization
                          (a −Z-facing T-pose makes auto-mapping mirror the legs/feet). retargetProportions()
                          optionally re-proportions onto the Ybot skeleton (keeps rotations, swaps bind offsets,
                          scales hips travel by the hips-height ratio) — the "Proportions" UI option.
                          resample() → ResampledClip (fixed fps, linear pos / slerp rot) for export.
  → src/fbx/animationFbx.ts: binary FBX — LimbNode skeleton + AnimationStack/Layer, per-bone Lcl Rotation
                          curves + Hips Lcl Translation curve, skinned meshes, BindPose, TPose take. meters→cm, Y-up.
  → src/convert/clean.ts: optional mocap cleaning — despike (pops/hand-flips via neighbour slerp on quats AND the same lone-outlier test on hips translation, POS_SPIKE_M), zero-phase Butterworth low-pass (filtfilt) on rotations + hips translation, twist/swing limits + locks for wrists AND forearms (twist about the bone axis toward the child joint), and feet-contact fixing (src/convert/feet.ts: floor estimated from data per foot — resting joint height varies per avatar, never assume y=0; contact = low AND slow with hysteresis; ankle pinned per plant via two-bone leg IK, recorded knee as pole, foot keeps recorded world rotation; runs LAST so smoothing can't reintroduce drift; writes leg-chain rotations only). Applied to the converted clip so it shows in preview AND export. CleanStats.fixedFrames + FeetStats.fixedFrames report WHICH frames each filter touched; main.ts compresses consecutive runs to run-start marks and draws them as colored ticks on the transport strip (amber despike / violet limits / cyan feet) so corrections are findable. smoothRange takes PLAYBACK (0-based) trim times and normalizes against times[0] internally — recordings can start nonzero (regression-checked in cleanCheck). Cleaning/pipeline control changes (clean panel + proportions + spine spread) ride in the SAME undo snapshots as rig edits (pipelineSettings in rigSnapshot; prevPipelineJson tracks the pre-change state because `change` fires after the DOM flips). The cleaning panel has a hold-to-compare button AND a Ghost toggle (grey uncleaned skeleton overlay via preview.setGhost — survives setClip; recleans re-point it from the compareBase prebuild); preview.setClip(clip, keepView=true) keeps camera + playhead (also why filter toggles don't reset the view).
  → src/rig/rig.ts + modifiers.ts + timewarp.ts: DCC-style control rig, baked AFTER
                          cleaning/proportions/spine. Modifiers = whole-clip slider corrections (hips height with
                          feet re-solved onto their original targets, knees/elbows in-out via rigid rotation of the
                          two-bone limb about its end-to-end axis — swings ONLY the mid joint, closed form, no IK —
                          stance width, MIRROR (swap L/R tracks keeping each side's own binds + reflect quats
                          (x,−y,−z,w) + negate hips x; face untouched), and REACH (per-limb pull of hand/foot back
                          toward the UNCLEANED path via two-bone IK — ref clip = buildDisplay(false) cached per
                          reclean gen, run through the same modifiers so timelines/mirroring match)). TIME WARP
                          (timewarp.ts) = speed-ramp keys in SOURCE time (0-based playback — buildCum normalizes
                          midpoints by times[0]), applied FIRST in the pipeline (resamples onto a uniform grid;
                          duration changes → reclean rebuilds the transport when it drifts). warpMaps(times, keys)
                          is THE bidirectional source⇄warped time map (same cum[] as applyTimeWarp, checked equal):
                          warpAdd inverts the playhead through it (a linear fraction is WRONG once any non-1× key
                          exists), and every warp edit calls remapForWarpChange (old→src→new) so layer keys, range
                          smooths, picked keys, trim, and the playhead stay glued to the same motion. Trim/playhead
                          restores that must survive a transport rebuild (scene load, warp remap) go through
                          pendingViewRestore, consumed at the END of reclean — applying them before reclean gets
                          them clamped against the wrong duration and thrown away.
                          RANGE SMOOTH (clean.ts smoothRange) = trim-range-only Butterworth with 0.25 s edge blends,
                          stacked after cleanClip. reduceKeys() = greedy key reducer (drops keys the sampled curve
                          wouldn't miss). All of warp/ranges/mods serialize into undo snapshots, the localStorage
                          cache, and .rig.json (v2).
                          LAYERS (v0.26 architecture — standard DCC layer semantics): layers hold PER-BONE LOCAL
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
                          owning those bones (effectorForBone = FIRST match per bone; the ROOT effector aliases
                          Hips and is listed after "hips", so Hips keys display as hips keys). POSER BEHAVIORS
                          (all capture-time, evaluation untouched, all in rigCheck): PINS — hands/feet can be
                          pinned (Pin button, chain effectors only; PinTarget world pos+rot captured at
                          pointer-down via capturePinTargets); after ANY primary solve, solveEffectorOnPose's
                          pins pass re-solves each pinned limb back onto its captured target (endR = pinned rot,
                          so a planted foot doesn't twist) — dropping the hips with pinned feet bends the knees.
                          ROOT — a flat gold ring ON THE FLOOR under the hips (scene special-cases its handle
                          world at y=0): rigid whole-character transform about that ground pivot; writes ONLY the
                          Hips track (pos AND rot keys — rotation about the pivot moves the hips position, so
                          withHipsPos is always true for root). FK LIMB MODE (Mode: IK/FK button): a positional
                          drag on a hand/foot in FK mode swings the WHOLE chain rigidly from its root joint
                          (main.ts reroutes the solve to the chain-root effector; keys land on that one bone) —
                          rotate drags stay wrist/ankle-local. WRIST TWIST DISTRIBUTION (distributeWristTwist):
                          a hand rotate-drag moves WRIST_TWIST_SHARE (0.6) of the local twist onto the forearm
                          while preserving the hand's world rotation bit-exact. Pins + FK modes persist in the
                          rig cache/.rig.json/scene as `pins`/`fk` arrays but are NOT in undo snapshots (tool
                          state, like the gizmo mode). Each layer:
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
  → src/preview/scene.ts: Three.js Object3D bone hierarchy driven per-frame; LineSegments + Points stick figure. Supports trim looping (setTrim), a review playback rate (setRate/getRate — multiplies dt, never touches the clip), and a GHOST overlay (setGhost(clip|null): DIO-green (GHOST_GREEN) stick lines + faint body fill + a FRESNEL RIM outline shader on duplicate skinned shells — rim = pow(1-|dot(viewN,normal)|,2.5), depthTest off so it overlays everything; an inverted hull CANNOT give an overlay outline (BackSide without depth shows the whole far surface). Sampled at the same playhead in applyPose — deliberately NOT cleared by setClip/clearClip so recleans keep it; disposed only by setGhost(null)/dispose).
  → src/ui/curves.ts: canvas curve editor on the LAYER KEYS (not the dense baked motion) — selected
                          effector's pos deltas (cm) + rot deltas (ZYX euler °, quatToEulerZYX/eulerZYXToQuat
                          round-trip) as per-axis curves. pos and rot have INDEPENDENT value scales (cm and degrees
                          on one axis flatlined whichever was smaller; each group gets its own zero line — pos
                          dashed, rot solid). Rot values are UNWRAPPED for display (main.ts unwrapEulerKeys: picks
                          canonical vs the (x+π, π−y, z+π) alternate + ±2π shifts nearest the previous key, so
                          equivalent rotations don't draw ±180° jumps); onValue edits reconstruct the DISPLAYED
                          triple before writing an axis back — mixing a dragged axis into the canonical extraction
                          silently switches representation and warps the rotation. Keys drag VERTICALLY only (retime lives on the strips);
                          right-click = ease linear/smooth/step (per-key `ease` on the segment LEAVING the key,
                          honored in samplePos/sampleRot) + delete. Value drags rebake live via the dirty-range
                          path; the graph redraws itself — the host must NOT rebuild the view mid-drag
                          (setModel refuses while dragging). Toggled with the dope sheet via the Keys/Curves button.
  → src/ui/icons.ts: inline SVG icons — Iconsax (Vuesax) LINEAR variant extracted from the MIT
                          iconsax-react npm package (scratch extractor; stroke = currentColor). Self-contained:
                          no icon font, no network. UI accent --accent aliases --logo-accent (the logo gold);
                          never hardcode the old blue. RESIZE INVARIANT: .edit-main (a grid item) needs
                          min-width:0 — grid items default to min-width:auto, so the canvas's last pixel width
                          holds the layout open when the window shrinks/moves monitors and the right-side tools
                          clip instead of reflowing (editbar + t-main are flex-wrap for the same reason; the
                          renderer re-reads devicePixelRatio in resize() for cross-monitor moves).
  → src/ui/transport.ts: transport bar docked at the bottom of the editor suite — Load .wanim / Load scene / Save scene buttons
                          (left .t-file group, icons; classes t-load-wanim/t-load-scene/t-scene-save — the loads filter the shared #file-input's accept attr, reset in its change handler), play/pause, a review-rate select (¼–2×, preview.setRate — playback only, never the clip), click-to-seek timeline with draggable in/out trim handles, frame counter in the readout (createTransport takes a frames count), a .t-marks canvas for the cleaning tick marks (setMarks; canvas because there can be thousands), rig-key markers (co-timed keys ≥3 collapse into ONE white pose marker — click picks all keys at that time, drag retimes them together; "Key pose" writes 19 stacked diamonds otherwise), and a mini DOPE SHEET (per-effector key rows for the active layer, shown only on the Rig tab; rows pixel-align to the strip by measuring against the rows element's own border box — its padding doesn't shift getBoundingClientRect). Transport hotkeys live in main.ts's module-level keydown (Space play/pause, ←/→ frame step, shift ×10, Home/End = trim ends; Ctrl+Z/Y/C/V NEVER fire inside text fields — the browser's own editing wins). "Delete key" only deletes within 1.5 frames of the playhead (the old 0.5 s grab silently ate keys off-screen). resample() takes trimStart/trimEnd to export only the trimmed range (rebased to t=0).
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
  → UI SHELL (index.html + main.ts buildPanel): editor suite — top #editbar toolbar (undo/redo, gizmo Move/Rotate icon toggles + Local/World, hold-to-compare, Ghost, format+Download), right #dock with tabs Clean/Rig/Export/Info, bottom #timeline-dock. buildPanel writes editbar.innerHTML + dock.innerHTML per file load (fresh nodes = no stacked listeners). Rig handles + dope sheet are GATED to the Rig tab (syncRigVisibility). Element IDs are unchanged from the single-drawer era — keep it that way, tests and wiring key off them.
  → DCC BOOT + SESSION RESTORE (main.ts bottom + src/session.ts): the app boots STRAIGHT INTO the
                          editor — #loaded-state is never hidden; the old landing is #empty-state, now a
                          .viewport-empty overlay floating over the 3D grid (drive scripts' waitForSelector
                          on "#loaded-state:not([hidden])" passes immediately; they gate on "#dock .stats").
                          showEmptyEditor() = the no-recording state (placeholder editbar/dock with Open…,
                          preview.clear(), transport disposed) — boot AND "Load another file" land there.
                          The last recording's raw bytes persist in IndexedDB (session.ts — localStorage is
                          too small; the EDITS already live in localStorage keyed by recording, so restoring
                          the bytes rehydrates everything through the normal cache path). Boot auto-reopens
                          it unless the user opens a file first (userOpenedFile guard); loadWanim(…, fromRestore)
                          skips re-saving; "Load another file" clears the stored session on purpose. Errors
                          show in the #empty-error .app-error toast (click or 10 s to dismiss) — the landing
                          that used to display them is gone. Lifecycle covered by scripts/bootCheck.mjs.
  → src/preview/face.ts:  ARKit face overlay — loads public/facecap-head.glb, seats it at the Head joint,
                          drives morph targets from the recorded blendshapes (also embedded in the FBX, skinned).
  → src/convert/body.ts + src/preview/body.ts: Ybot body retarget (weights remapped to our bones) for preview
                          SkinnedMeshes and FBX skinned-mesh export.
```

`src/convert/skeleton.ts` holds the Unity HumanBodyBones parent table; `src/convert/quat.ts` holds quat math + the quat→Euler-ZYX extraction. The parser is output-agnostic from the writer.

Shared/support modules not in the pipeline diagram above: `src/convert/ik.ts` (vector helpers + the two-bone solver proven by the feet filter — shared by `feet.ts` and the control rig; keeps the mid joint's plane as pole and preserves the end bone's world rotation); `src/vrm/vrmHumanoid.ts` (ported from VRMxShogun — reads a GLB/VRM's JSON chunk, `sanitizeGlb` fixes bare NaN/Infinity tokens, and returns node-index→HumanBodyBones for the authoritative VRM bone mapping when a user supplies their own body); `src/convert/vrmFaceMap.ts` (synthesizes VRM 0.x preset / VRoid `Fcl_*` blendshape tracks from the recorded ARKit weights, for the VRMA/VRM face path); `src/fbx/export.ts` (`sanitizeFilename` + `downloadBytes` browser-download helper, format-agnostic).

## GitHub Pages deployment (same traps as VRMxShogun)

- `base: '/'` in `vite.config.ts` — the site serves at the ROOT of the custom domain `wryanimator.com` (`public/CNAME`). If the custom domain ever goes away, the site falls back to `vtoku.github.io/WRYAnimator/` and base must become `'/WRYAnimator/'` or every asset 404s. Validate with `npm run preview`.
- Ship `public/.nojekyll`.
- Deploy via GitHub Actions workflow (`actions/deploy-pages`), Pages source = "GitHub Actions". Copy the template's `.github/workflows/`. Don't hand-manage a `gh-pages` branch.

## Domain knowledge that is easy to get wrong

- **FBX animation curves**: each animated property needs an `AnimationCurveNode` connected to both the layer (`OO`) and the model property (`OP` with `"Lcl Translation"`/`"Lcl Rotation"`), and per-component `AnimationCurve`s connected with `OP` + `d|X`/`d|Y`/`d|Z`. Times are FBX ticks (`FBX_TIME_SECOND = 46186158000`). A `Takes:` block is emitted for older importers.
- **The target animation DCC (2026) is installed locally — USE IT to verify FBX output.** `& "C:\Program Files\Autodesk\MotionBuilder 2026\bin\x64\motionbuilder.exe" -batch scripts\mobuCheck.py` imports the file headlessly and writes `scripts/mobu-result.txt` (takes, skeleton, key counts, blendshape props). Pass the target file via the `WANIM_FBX` env var — an extra CLI arg makes the DCC auto-open it and SKIP the script. Grep stdout for "legacy" to detect the legacy-file warning. (`mobupy.exe` standalone does NOT work: `pyfbsdk.initialize()` returns False.) `scripts/mobuSave.py` (env `WANIM_FBX`/`WANIM_OUT`) round-trips a file through the DCC to get SDK-canonical reference output; `scripts/dumpTree.mjs` dumps any binary FBX node tree (7400 32-bit and 7500+ 64-bit); `scripts/meshProbe.ts` generates minimal mesh probes for bisection. the reference importer 4.4 is also installed for control exports.
- **FBX MUST be binary, not ASCII.** the target animation DCCs (2018+) dropped ASCII FBX import (loads as a dot-cloud). The writer emits **binary FBX 7700** via `src/fbx/fbxBinary.ts` (64-bit node records, 25-byte null terminators). THE killer detail: in binary, object names use the separator `name\x00\x01class` (e.g. `R\x00\x01AnimCurveNode`), NOT ASCII `class::name` — the FBX SDK / FBXLoader truncate the readable name at the first NUL, so getting this wrong silently drops AnimationCurveNode channel tags (R/T/DeformPercent) → ZERO tracks. Always build names with `objName(name, cls)`. Validate with `npm run fbxcheck`.
- **The DCC's "legacy file" warning is triggered by the header metadata, not the data.** Verified by bisection against its own saved output: the fix was the Creator strings `"FBX SDK/FBX Plugins version 2020.3.7"` (header + top-level; the SDK parses this exact form to date the file — even the reference exporter's output warns) together with `OtherFlags/TCDefinition`, `FBXHeaderVersion 1004`, and version 7700. The footer code must also be the encryption of the `CreationTime` STRING (the reference exporter's "timedate hack": pin `1970-01-01 10:00:00:000` + the constant code — `generateFooterCode()` provably reproduces it) with `FileId` = the `28 b3 2a eb…` constant; a mismatched footer ALSO degrades the file.
- **Read GLB attributes through accessors (`fromBufferAttribute`/`getComponent`), NEVER raw `.array`** — meshopt-decoded GLBs use INTERLEAVED attributes where `.array` is the mixed pos/normal/uv buffer; raw copies shred the mesh into slivers (this corrupted the exported face for several versions while counts/round-trips still passed). `scripts/fbxView.html` + `scripts/shotFbx.mjs` render the EXPORTED FBX in a browser — use them to visually verify any geometry change; counting bones/tracks is not enough.
- **The DCC pose probe** (`scripts/mobuPose.py` + `scripts/expectedPose.mjs`) compares DCC-evaluated world matrices against quaternion ground truth — confirmed exact (to 5 decimals) at chain ends, so the Euler/rotation-order path is settled; don't re-suspect it.
- **Mesh models need `DefaultAttributeIndex: 0`** in Properties70, or the SDK applies the template default (-1 = no active attribute) and the DCC imports the model as a **Null instead of a Mesh** (silently — no log). Found via `meshProbe.ts` bisection. Meshes also need a normals LayerElement + Layer.
- **Embedded meshes are SKINNED, not parented** (`SkinnedMeshExport` in the writer): mesh Model at scene root, Skin deformer + per-bone Clusters (Transform = inverse bind, TransformLink = bind; identity-rotation T-pose matrices), plus a `Pose/BindPose` object. Parenting a mesh under a bone "weights oddly" in the DCC retarget pipelines.
- **Everything faces +Z, with no flips anywhere**: the X-mirror conversion makes the skeleton face +Z, which matches the facecap head and the Xbot body natively. The preview applies no display rotation either. If a mesh comes out back-to-front ("legs backwards, arms upside-down"), some stage reintroduced a facing mismatch — check with `scripts/checkOurFacing.mjs` (toes/eyes must have dz>0) and `scripts/checkFacing.mjs` (Xbot reference).
- **A `TPose` take** (one-key stance at t=0) is exported alongside the animation take so the DCC can characterize from a guaranteed T-pose (fixes feet/limb auto-mapping). It builds its take list from the legacy `Takes` node — an AnimationStack without a matching `Take` entry there does NOT appear.
- **Body mesh** (`src/convert/body.ts` + `public/body.glb` = "Suit" from Quaternius' Ultimate Modular Women pack, CC0, textures stripped — fem preferred per user): a **closed-form world-space transfer** that works for ANY humanoid GLB. (1) Capture the rest state convention-free: per-vertex world positions via the asset's OWN skinning (`applyBoneTransform` at rest — NEVER trust inverse-bind matrices: 2017-era Quaternius ships degenerate near-identity binds, the reference importer exports keep the bind in node rests, Mixamo bakes armature scale), plus rest joint positions/segment dirs (childless feet use foot-vertex centroids). (2) Global yaw to face +Z (toe heading or foot centroids). (3) T-pose the JOINT TABLE by pure vector math (chain-accumulated rotations to canonical axes: arms ±X, spine +Y, legs −Y, feet keep pitch) — this layout is exported as the body-skeleton proportions. (4) Per-bone delta `D_j = T(ourJoint)·Stretch(ourAxis, lenRatio)·R(restDir→ourAxis)·G·T(−restJoint)`; vertices = weight-blended `D_j · restVert`. **NO scene-graph mutation** (hierarchy edits with non-uniform scales shear across rig conventions; this was learned the hard way) and **NO aesthetic knobs** (girth/slim constants were all deleted — the look is the asset's own). Name mapping: Unity + the DCC names, `RIGIFY_MAP` (DEF-*), and `modularToUnity` (UpperArmL/WristR/Abdomen/Torso-style); unmapped helpers walk up to the nearest mapped ancestor. Modular `*_Head_*`/`*_Ears*` sub-meshes are skipped entirely; single-mesh assets get the positional head cut. Face seat constants from `measureBodyHead.mjs` (re-run when swapping the asset!). AVATAR FINISH
  (src/preview/materials.ts): a MATCAP (MeshMatcapMaterial — ZBrush-style baked sphere shading, ignores
  scene lights) imitating SprintRay MoonRay orange resin, generated procedurally on a canvas. If
  `public/matcap.png` exists it replaces the procedural texture at load (`issued` array retrofits
  already-created materials). The real "Moonray Resin" matcap (Kurt Papstein, $5) is licensed
  personal + 1 commercial project — do NOT commit the exported texture to this public repo without
  the user's explicit call (it becomes world-downloadable). "Proportions: Body-mesh skeleton" (DEFAULT) puts the clip on the body's T-posed joints for a 1:1 mesh; "Recorded avatar" is a measured approximate fit.
- **Blendshape export** (face mesh, on by default): the facecap head is a SKINNED mesh (cluster → Head bone, world-space bake via `convert/meshExport.ts`: recenter, ~25cm, +5cm lift, NO rotation) with `BlendShape`/`BlendShapeChannel` deformers + `Shape` delta geometries and `DeformPercent` curves from the recorded ARKit weights. Connection chain FBXLoader/the DCC need: curveNode→channel (`OP DeformPercent`), curve→curveNode (`OP d|DeformPercent`), channel→blendShape→geometry→model (`OO`). Verify with `npm run faceFbxCheck` + the the DCC batch check (48 animated props confirmed).
- **Rotation order is THE thing to verify in a real DCC.** We extract quaternion→Euler in three.js 'ZYX' order (`quatToEulerZYX`) and write it with the default `RotationOrder`, because three's FBXLoader maps FBX's default onto ZYX — and the round-trip check (`npm run fbxcheck`) confirms it reconstructs 55 bones + a clip with the hips traveling. **The preview (quaternion-driven) is always correct; the FBX Euler order is the risk.** If limbs twist/spin in an external DCC but the preview looked fine, the fallback is to try XYZ extraction + matching `RotationOrder`. Euler tracks are unwrapped (`unwrapDegrees`) and quats made sign-continuous to prevent 360° pops.
- **Hips vs. root**: `convertCharacter` bakes the character root (fields 5/6) into the Hips, so Hips (the FBX root LimbNode, parented to scene) carries full world translation+rotation; all other bones stay local-to-parent. Limb bones export rotation curves only; their translation is constant at the frame-0 bind offset.
- **Degenerate zero-norm quats must read as IDENTITY in any hand-rolled FK** (`safeQuat` in `src/convert/fk.ts`). Recordings fill missing bones (UpperChest, Jaw) with all-zero quaternions; three.js's matrix compose silently treats those as identity, but a naive quatMul propagates the zeros and freezes every descendant at bind pose. This bug made rig deltas get captured against a phantom T-pose arm before the fix — if preview and an FK-based computation ever disagree, check for a zero quat on the chain first.
- **Identity local rotations === T-pose.** Warudo records VRM-normalized bind offsets, and the VRM rest pose is a T-pose; verified via `scripts/checkIdentityPose.mjs` (arms horizontal, legs vertical, head at correct height). So the `tposeRest` export option just zeroes each bone's default Lcl Rotation — the curves still play the motion. NOTE: the bone array is NOT topologically sorted (`UpperChest` is index 54 but parents `Neck`/shoulders at indices 9/11), so any manual world-space reconstruction must resolve parents recursively, not in a single forward pass. Three.js parenting and FBX `OO` connections handle order correctly on their own.
- **Export name schemes** (`convert/skeleton.ts`): default `unity` keeps HumanBodyBones names (needed for Unity/Warudo name-keyed retarget); `motionbuilder` remaps to HumanIK/Mixamo names (`LeftArm`, `LeftForeArm`, `LeftUpLeg`, `Spine1/2`, `LeftHandThumb1`…) so the target DCC auto-characterizes. Renaming is export-only; the parent table and preview are index-based and unaffected.
- **Variable frame timing**: timestamps are render frames, not a fixed clock (~57–60 fps, irregular). `resample()` is mandatory before export; the preview instead plays the raw timestamps in real time so it needs no resampling.
- **Bone positions are local-to-parent** (e.g. LeftLowerLeg ≈ `(0,−0.40,0.01)` = thigh length), EXCEPT Hips which is character-root-relative. Don't treat them as world positions.
- **Blendshape channels** (field 4) are parsed into `ConvertedClip.face`, played on the preview face overlay, AND exported to FBX as morph animation on the embedded facecap head (see "Blendshape export" above).
- **Face overlay model**: `public/facecap-head.glb` is the three.js "facecap" head (by Face Cap / Bannaflak) with its KTX2 textures **stripped** (`scripts/stripGlbTextures.mjs`) so it loads without a Basis transcoder; geometry is meshopt-compressed, decoded in-browser via `MeshoptDecoder` (pure JS, bundled — no public wasm). To regenerate: download `examples/models/gltf/facecap.glb` from three.js, run the strip script. Its morphs use `_L`/`_R` suffixes vs. the recordings' Apple `Left`/`Right` — `toFacecapName()` in `face.ts` maps them. **Credit Face Cap/Bannaflak** (footer + README) — don't drop it.
