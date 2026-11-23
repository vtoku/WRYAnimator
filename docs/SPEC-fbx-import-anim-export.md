# Spec: FBX import + Unity humanoid .anim export

Target workflow (round trip through an external DCC):

```
.wanim + your VRM  →  FBX export            (exists today, v0.14)
        ↓ animation cleanup in the external DCC
cleaned FBX  →  drop back into WRYAnimator  (NEW: FBX import)
        ↓
humanoid .anim with blendshapes             (NEW: Unity/Warudo export)
```

## Phase 1 — FBX import

Drop a `.fbx` on the page (alongside `.wanim`): parse with three's FBXLoader
(already a dependency, used by `npm run fbxcheck`), then convert into the
app's `ConvertedClip` so everything downstream (preview, trim, cleaning,
re-export) just works.

- **Skeleton mapping**: bone names → HumanBodyBones indices via the existing
  resolver families (our own exports use Unity or HumanIK names, so a re-imported
  file maps 1:1; Mixamo files also work). Reuse `resolveBone` logic from
  `convert/body.ts` (factor it out of the body module).
- **Tracks**: sample each bone's quaternion + Hips translation from the
  loaded `AnimationClip` at the clip's keyframe times (FBXLoader returns
  tracks in local space — same convention as `ConvertedClip.localQuat`).
  Bind offsets from the loaded skeleton's rest pose. Units: FBX cm → m.
- **Blendshapes**: FBXLoader produces `.morphTargetInfluences` tracks named
  by channel; map back to ARKit/recorded names (they're our own channel
  names on re-import) into `ConvertedClip.face`.
- **Take selection**: if the file has multiple takes (ours have the anim +
  TPose), pick the longest non-TPose take; expose a select if ambiguous.
- **Meshes**: ignore imported meshes for v1 (preview keeps its own body
  pipeline); revisit if users want to see the DCC-edited mesh.
- Verification: export → import → tracks must round-trip within ε
  (extend `faceFbxCheck` with a reimport assertion).

## Phase 2 — Unity humanoid .anim export (with blendshapes)

> **Status: built as a beta (`src/anim/`).** The plan below is kept for
> history; two things in it turned out differently. Unity IS available as a
> verification harness (batch mode, `scripts/animUnity.mjs`), and the muscle
> math was measured from Unity directly instead of mined from prior art. See
> `CLAUDE.md`, "Unity humanoid .anim (beta)", for what was found.

A `.anim` is a YAML `AnimationClip`. Two viable forms:

1. **Generic clip** (cheap): `m_EulerCurves`/`m_PositionCurves` keyed by
   transform path (`Hips/Spine/Chest/...`). Plays only on a skeleton with
   identical hierarchy/names — NOT retargetable. Limited Warudo value.
2. **Humanoid clip** (the real ask): muscle-space float curves
   (`m_FloatCurves` with attributes like `"Left Arm Down-Up"`,
   `"Spine Front-Back"`, plus `RootT.x/y/z`, `RootQ.x/y/z/w`) and
   `"blendShape.<name>"` curves (path `Face`). Retargets onto ANY humanoid
   avatar in Unity/Warudo.

**The hard part is muscle conversion**: Mecanim derives per-bone muscle axes
(pre/post rotation, sign, range) from the avatar's T-pose. Reimplementing
`HumanPoseHandler` math in JS is the core work:
- Our skeleton IS a clean T-pose with identity local rotations, which is the
  easiest possible case for deriving the muscle reference frames (axes come
  out of the canonical limb directions we already compute).
- Known prior art to mine: Unity's `HumanTrait` muscle list + open-source
  reimplementations (UniHumanoid / vmd→anim converters) document the
  pre/post-rotation conventions and twist distribution (upper/lower limb
  twist splits 50/50 by default).
- Root motion: `RootT/RootQ` = hips motion normalized by the avatar's hips
  height (we know it), expressed in the body-root frame.
- Blendshapes: trivial — recorded weights → `blendShape.<name>` float curves
  (0–100), path = `Face` (our mesh naming already matches the VRM
  convention).

**Plan**: ship Phase 1 + blendshape-and-root-only `.anim` first (muscles
stubbed as generic euler curves under a humanoid-named hierarchy — Warudo
accepts both forms for name-matched avatars), then iterate the muscle math
behind a "Humanoid (retargetable)" toggle once verified against a Unity
import of a known pose (probe: export one frame, import into Unity, compare
`HumanPose.muscles` — same bisection discipline as the FBX work).

**Verification harness**: a Unity Editor batch script (like `mobuCheck.py`)
isn't available — instead validate YAML structure against a reference
`.anim` recorded in Unity from a HumanPoseHandler sample, and round-trip
muscles → rotations → muscles in our own math.

## Spring bones (revised — NO baking)

Baking simulated spring curves was rejected (too much data). Lightweight
plan instead:

- **FBX**: export the VRM's spring chains as STATIC extra bones (rest pose
  only, no curves) with the hair/skirt verts' REAL weights. Tiny cost
  (bones + weights), and DCC users can drive them with its own
  spring/relation constraints or hand keys — physics belongs to the DCC.
- **.anim / Warudo**: nothing needed at all — Warudo/Unity re-simulate the
  avatar's own spring bones live at playback, so the clip should NOT carry
  hair curves.
- Colliders don't translate to FBX; they stay engine-side (the VRM keeps
  them for Warudo playback).

## UI

- Drop zone accepts `.wanim` / `.fbx` (and `.vrm`/`.glb` routes to the body
  slot).
- Download button becomes a format select: `FBX` / `Unity .anim`.
