# Spec: asset-only sessions (VRM/GLB or FBX without a recording)

Goal: any supported file starts a working session. Today everything is
gated on a .wanim (File > Open body is dimmed with no clip; the Shogun
export only exists inside a recording session). The user must be able
to drop JUST a VRM and use the Shogun target-rig export, or JUST an
FBX animation and convert it, with no recording anywhere.

## 1. Open routing

handleFile becomes a router by content, not a gate:

- .wanim / .scene.json: exactly as today.
- .vrm / .glb (or drop while no clip is loaded): start a BODY-ONLY
  session (section 2). When a clip session is already open, keep
  today's behavior (swap the body).
- .fbx: FBX animation import per docs/SPEC-fbx-import-anim-export.md
  Phase 1 (section 3 below adds the session wiring it needs).
- File > Open body is always enabled; the empty-editor hint line
  becomes "Open a recording or a VRM/FBX (Ctrl+O), or drop a file
  anywhere".

## 2. Body-only session (VRM/GLB, no clip)

- Preview: load the body through the existing retarget pipeline posed
  in its T-pose (the body pipeline already produces a static skinned
  pose with no clip frames; render at bind). Camera frames it. No
  transport, no timeline, no Clean/Rig tabs content: those tabs show
  one line each ("Needs a recording").
- Export tab in a body-only session shows ONLY the asset exports:
  Shogun target rig (when the body is a VRM), with the same strip
  springs checkbox and filename field.
- Info tab: VRM meta if present (name/author from the VRM extension,
  vrmHumanoid.ts already parses the chunk), bone/mesh counts.
- Scene save in a body-only session: allowed, stores userBodyBytes
  with no recording (scene loader already tolerates the field; add
  the no-clip case).
- Dropping a .wanim into a body-only session upgrades it in place to
  a full session keeping the loaded body.

## 3. FBX animation import session wiring

Phase 1 of docs/SPEC-fbx-import-anim-export.md, plus:

- An imported FBX clip IS a full session (preview, trim, cleaning,
  rig, all exports) with the clip sourced from FBXLoader instead of
  the wanim parser. Everything downstream consumes ConvertedClip and
  must not care.
- Multi-take files: pick the longest non-TPose take automatically;
  when several remain, a small take select appears in the toolbar.
- Scene save for an FBX session embeds the original FBX bytes the
  same way wanim bytes are embedded today.
- WANIM export from an FBX session produces a valid recording
  (writeWanim already re-applies edits to its own clip; blendshape
  map may be empty).

## Verification

- bootCheck gains: open a VRM with no recording -> body renders, the
  Shogun row is present and downloads, Clean/Rig tabs show the
  needs-a-recording line; then drop the sample wanim on top ->
  upgrades to a full session with the same body.
- New fbxImportCheck: export the sample recording to FBX, reimport
  it, assert bone count, frame count, and per-frame quats round-trip
  within resample tolerance (the spec's epsilon test), and that VRMA
  and WANIM exports from the imported session succeed.
- rigCheck / cleanCheck / wanimCheck / shogunCheck untouched, green.
