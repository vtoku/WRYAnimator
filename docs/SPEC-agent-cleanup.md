# Spec: agentic mocap cleanup — closing the gaps

What an agent still needs, beyond the headless API shipped in `src/api/`, to
clean a whole take on its own: look at the motion, fix feet and reach, detect
body contact, bridge glitches, trust the scan, and take direction from the
person watching. Seven parts, A–G, each shippable alone.

Written against the state after commit `c840a51` (operation table in
`src/api/ops.ts`, timing-exact export, local link). Read `CLAUDE.md`
"Headless API, CLI and MCP" first; every invariant there still holds:

- Sessions never change timing. No operation here resamples or warps.
- Scope guard: an operation that would write a bone outside `allowBones` /
  `denyBones` throws and leaves the session unchanged.
- Span operations are layers (undoable, in `.rig.json`, visible in the editor).
- Evaluation stays pure curve composition. Every solver below runs ONCE, when
  the operation is called, and writes local rotation keys. Nothing solves at
  bake time.
- No new runtime dependencies. `src/api/` stays DOM-free and strip-types safe.
- Add operations to the `OPS` table only; the CLI and MCP pick them up.

World space everywhere below = the converted clip's space, the same one
`evaluate world:true` already reports: meters, Y up, character facing +Z, the
character's left at +x.

Build order: **A → B → C → D → E**, with **F** started in parallel (it needs
labelled takes from the user) and **G** last.

| Part | Gap it closes | Size |
|---|---|---|
| A. Proxy body + `render` | The agent can't see | large |
| B. Span solver: `ik.*`, `feet.*` | No reach / foot-pin operations | medium |
| C. `bridge.insert`, `key.tween` | No tween / blend operations | small |
| D. Self-contact scan + `ik.depenetrate` | No body-contact detection | medium |
| E. Stale-layer tracking | World-space fixes silently break when a lower layer changes | small |
| F. Scan calibration | Thresholds checked on two excerpts only | small + user input |
| G. Two-way link | The user's edits and pointers don't reach the agent | medium |

---

## A. Proxy body and headless render  ← build first

### A1. Proxy body (`src/api/proxyBody.ts`, new)

One simple volume model of the character, used by BOTH the renderer (part A2)
and contact detection (part D), so what the agent sees is exactly what the
detector tests.

- `buildProxy(clip) → Proxy`: a list of primitives, each bound to a bone:
  `{ bone, kind: "capsule" | "sphere", a: Vec3, b: Vec3, radius, group }`
  with `a`/`b` in the bone's LOCAL space (so posing is one transform per bone).
- Limbs and fingers: one capsule from the joint to its child joint (bind
  offset from `clip.bindPos`). Leaf bones (finger distals, toes, head) extend
  along the parent direction by a fixed fraction of the parent segment.
- Torso: `Hips` = horizontal capsule between the two hip joints; `Chest` /
  `UpperChest` = horizontal capsule between the shoulder joints; `Spine` =
  vertical capsule. Head = sphere. Hands = a flat palm (two parallel capsules
  from wrist to index and little knuckles) so palm orientation reads.
- Radii come from a ratio table (radius ÷ segment length, per bone). The
  table is MEASURED, not tuned: `scripts/measureProxy.mjs` loads
  `public/body.glb` through the existing `loadBody` path in `cli/core.mjs`,
  and for each bone takes the median distance from its weighted vertices to
  the bone segment. Re-run when the bundled body changes (same rule as
  `measureBodyHead.mjs`).
- `proxyFromBody(clip, bodyMeshData)`: same measurement on a user-supplied
  VRM/GLB (`--body avatar.vrm`), for takes where contact accuracy matters.
- `posed(proxy, worldPose) → world-space primitives` using
  `worldFromLocal` from `src/convert/fk.ts` (zero quats already read as
  identity there).
- `groups`: `torso`, `head`, `leftArm`, `rightArm`, `leftHand`, `rightHand`,
  `leftLeg`, `rightLeg`. Used for colour in A2 and pair filtering in D.

The recording carries no mesh, so the proxy is an approximation of the real
avatar. Everything built on it reports distances with that caveat (D).

### A2. Software renderer (`src/api/render.ts`, new)

Decision: a small **software rasteriser in pure TS**, not a headless browser.
It is deterministic, has no dependencies, runs inside the MCP process, and
takes milliseconds per cell. The fidelity ceiling (no real avatar mesh) is
accepted; A4 is the escape hatch.

- Orthographic camera, z-buffer, RGBA `Uint8Array` framebuffer.
- Capsules and spheres are drawn analytically per pixel (ray vs capsule in
  camera space), shaded by normal·view plus a depth fade. No triangles.
- Colour carries meaning, not looks: right side cool, left side warm, torso
  neutral; **palm side and back of hand are different tones** (this is what
  makes a wrist flip visible in a 200 px cell); bones passed in `highlight`
  are saturated; `ghost` draws a second pose flat grey underneath.
- Floor: a line/grid at the per-foot resting height (the same 5th-percentile
  estimate scan uses — never y = 0).
- Trails: optional polyline of one joint's world path across the range
  (`trail: ["RightHand"]`), dots at each sampled frame. This is how pops and
  foot slide become visible in a still image.
- Labels: a built-in 5×7 bitmap font for the time, frame and view name in
  each cell.

Views (`view`):

| View | Camera |
|---|---|
| `front`, `back`, `left`, `right`, `top` | Axis-aligned, fitted to the whole body, centred on the hips |
| `three-quarter` | 35° yaw, 15° pitch |
| `hand:Right` / `hand:Left` | Two cells, fitted to forearm + hand + fingers. **Profile**: looking along the wrist's deviation axis, forearm horizontal, so flex is the visible angle. **Palm**: looking along the flex axis into the palm, so deviation and finger splay are visible. Axes from `Session.axes()` in `anatomy.ts`, taken on the FOREARM so the camera does not rotate with the thing being judged |
| `feet` | Low side view of both legs from the knees down, floor line drawn |

Layouts (`layout`):

- `frame` — one time, one cell per requested view.
- `strip` — one view, `count` evenly spaced times across `[t0, t1]`
  (snapped to real frames), left to right.
- `compare` — a strip with the recording (`base`) on the top row and the
  edited motion on the bottom row, same frames. Cells where the pose differs
  by more than 1° on any drawn bone get a marked border.
- `overlay` — a strip with base as ghost under edited.

### A3. Plots (`src/api/plot.ts`, new)

Same framebuffer and font. `plot` draws one anatomical component (or world
axis) of one or more bones against time: base in grey, edited in colour,
limit lines dashed, scan issue ranges shaded. An agent reads a curve image
faster than 300 numbers from `evaluate`, and it is the natural picture for
"did my blend pop at the edges".

### A4. Operations and transport

Session methods return raw pixels; encoding happens at the edge.

```ts
session.render(a: {
  view?: string | string[];          // default "front"
  layout?: "frame" | "strip" | "compare" | "overlay";
  time?: number; frame?: number;     // frame layout
  t0?: number; t1?: number; count?: number;   // strip layouts, count ≤ 16
  source?: "edited" | "base";
  highlight?: BoneRef[]; trail?: BoneRef[];
  cell?: number;                     // cell size px, default 256, max 512
}): { width: number; height: number; rgba: Uint8Array; cells: Array<{ row: string; view: string; frame: number; time: number }> }

session.plot(a: {
  bones: BoneRef[]; component: "flex" | "deviation" | "twist" | "swing" | "curl" | "splay" | "worldX" | "worldY" | "worldZ";
  t0: number; t1: number; limits?: [number, number];
}): { width: number; height: number; rgba: Uint8Array; range: { min: number; max: number } }
```

- `OpDef` gains `returns?: "image"`. Ops `render` and `plot` (both
  `mutates: false`).
- `src/api/png.ts`: PNG writer (CRC32, Adler-32, filter 0) that takes a
  `deflate(bytes) → bytes` function as a parameter. The CLI/MCP pass
  `zlib.deflateSync`; a browser caller can pass a `CompressionStream`
  wrapper. `src/api/` therefore still imports nothing from Node.
- MCP (`cli/mcp.mjs`): for image ops, return
  `content: [{ type: "image", data: <base64 png>, mimeType: "image/png" }, { type: "text", text: <cells JSON> }]`.
  Total image capped at 1568 px on the long edge (larger is downscaled by
  the model anyway); `count` and `cell` are clamped to fit, and the clamp is
  reported in the text part.
- CLI: `wry render take.wanim --view hand:Right --t0 190 --t1 192 --count 8 --layout compare --rig take.rig.json -o out.png`
  and `wry plot …`. JSON with the output path and `cells` on stdout.
- The local link `touch()` is NOT called (read-only op).

### A5. Later tier: real-avatar render (not in this phase)

`wry render --engine browser [--body avatar.vrm]` would drive the built web
app in Playwright (already a devDependency) and screenshot the real preview
with the real body mesh. Slower, needs Chromium, and not deterministic, so
it is an explicit opt-in for a final look, never the default. Spec it only
if the capsule view proves insufficient in practice.

### A6. Checks (`scripts/renderCheck.mjs`, `npm run renderCheck`)

- Same args twice → identical bytes.
- PNG round trip: inflate with `node:zlib`, verify chunk CRCs and size.
- Identity pose, `front` view: left-coloured pixels' centroid is on the
  image's right half, right-coloured on the left (the character faces the
  camera); head pixels above hip pixels.
- `hand:Right` profile: key the right wrist to flex +60 and to −60; the hand
  capsule's centroid moves to opposite sides of the forearm axis.
- `compare` on a session with one edit on RightHand over a known range:
  only cells inside that range carry the "changed" border.
- A read-only op: `session.log` length unchanged, undo stack unchanged.
- 16 cells × 256 px render in under 500 ms on the PTID excerpt.

---

## B. Span solver: reach and feet

### B1. Engine (`Session.spanSolve`, private)

One mechanism behind every world-space operation in this part and in D:

```ts
private spanSolve(o: {
  op: string; name: string;
  effector: EffectorId;               // chain effectors: leftHand, rightHand, leftFoot, rightFoot
  f0: number; f1: number;             // frames to key, inclusive (already includes blend margins)
  target(f: number, cur: { pos: Vec3; rot: Quat }): { pos?: Vec3; rot?: Quat } | null;   // null = leave this frame
  weight(f: number): number;          // 0..1 blend
}): { layer: number; bones: string[]; maxMoveCm: number; unreachableFrames: number; changed: [...] }
```

- Reads the current edited clip (`this.edited()`), frame by frame.
- Per frame: build the pose, call `solveEffectorOnPose` (`src/rig/rig.ts`)
  with `pos = lerp(cur.pos, target.pos, weight)`; the two-bone solver keeps
  the recorded mid-joint plane as pole and the end bone's world rotation.
- Writes the chain's three bones as DENSE override keys in a new top layer
  with `fadeS = 1e-4`, exactly like `limit.apply` does today (`denseTrack`).
  Frames whose solved locals equal the current ones within `DIRTY_ROT_RAD`
  are still keyed at the current value inside the span (an override layer is
  at full strength across its keyed range).
- Guard: all three chain bones go through `this.guard()` BEFORE anything is
  written. A right-hand reach therefore needs RightUpperArm, RightLowerArm
  and RightHand in scope.
- `unreachableFrames`: frames where the target was farther than the limb's
  length (the solver clamps). Reported, never silently accepted — the caller
  decides whether to move the hips instead.

Two API-only rules, both already stated in `CLAUDE.md` for hand edits:

1. **No wrist-twist redistribution.** `spanSolve` calls `solveEffectorOnPose`
   + `captureBoneKeys`-style writes directly and never
   `distributeWristTwist` (so it does not use `keyEffectorTarget`).
2. **Forearm twist protection.** On a session with `protectForearmTwist`,
   after each arm solve the forearm's local rotation is decomposed
   (`anatomy.decompose`), its twist component is put back to the pre-solve
   value, and the hand's local rotation is recomputed so its WORLD rotation
   is unchanged. Twist about the forearm's own axis does not move the wrist,
   so the reach still lands. `rigCheck`-style assertion: forearm twist
   before == after on every frame, to 1e-4°.

### B2. Operations

All `mutates: true`; all refuse while a time warp is loaded
(`requireSourceTiming`).

| Op | Purpose | Key arguments |
|---|---|---|
| `ik.set` | One key: put an effector at a world position at one time, on a layer the caller names (sparse, hand-editable; the layer's fade does the blending) | `layer`, `effector`, `time`/`frame`, and ONE of `position: [x,y,z]`, `offset: [dx,dy,dz]`, `relativeTo: {bone, offset}`; optional `rotation` (world quat), `pins: EffectorId[]` |
| `ik.offset` | Move an effector by an offset across a span, keeping all the recorded motion detail ("raise the right hand 4 cm from 12.0 to 13.5 s") | `effector`, `t0`, `t1`, `offset`, `space: "world" | "hips"`, `blend` (default 0.25 s) |
| `ik.pin` | Hold an effector at one world position across a span | `effector`, `t0`, `t1`, `position` or `anchor: "start" | "median" | {time}`, `lockRotation` (default false), `blend` |
| `feet.plants` | Read-only: the detected planted spans per foot, with drift in cm and the floor height used | `t0`, `t1`, `side` |
| `feet.pin` | `ik.pin` for a foot with floor handling | `side`, `t0`, `t1`, `anchor` (default `"median"`), `lockRotation` (default true), `floor` (default: estimated), `blend` (default 0.12 s) |
| `feet.fix` | Pin every detected plant in a range, and lift frames that dip below the floor | `t0`, `t1`, `side` (default both), `minDriftCm` (default: scan's `footSlideCm`) |

Details:

- `relativeTo`: the target is `bone`'s world position plus `offset` rotated
  by that bone's world rotation. This is how an agent says "5 cm in front of
  the chest" without knowing where the chest is in world space.
- `feet.pin` anchor `"median"`: the per-axis median of the ankle's world
  x/z over `[t0, t1]`; y is `max(recorded y, floor + ankleRest)`. Median, not
  the first frame as the whole-clip filter uses, because an agent-chosen
  span may start mid-slide.
- Floor lift (in `feet.pin` and `feet.fix`): any frame whose lowest foot
  point (ankle or toe) is under the floor gets its ankle target raised by
  the deficit. Applied with the same blend.
- `feet.fix` makes ONE layer per side (`feet fix Left 12.00-48.50`), not one
  per plant, so the rail stays readable.
- `ik.set` on `hips` / `root` is allowed and writes the Hips track with a
  position key (`withHipsPos`); `pins` keep the named limbs where they were
  (capture with `capturePinTargets` before the solve). Timing-exact export
  already patches hips position cells.

### B3. Refactor in `src/convert/feet.ts`

Export what `fixFeet` already does internally, without changing `fixFeet`:

- `detectPlants(clip, localPos, localQuat) → Array<PlantSpan & { f0, f1, floor, driftCm }>`
- `estimateFloor(lowY) → number`
- `legWorld`, `solveLeg` (already there, just exported)

`scan.ts` then calls `detectPlants` instead of running the whole
`cleanClip(clip, { fixFeet: true })` for detection, and its `foot_slide` /
`floor_penetration` `suggestedFix` becomes a ready-to-run
`{ op: "feet.pin", side, t0, t1 }` instead of the current "no scoped feet
operation yet" note. `cleanCheck` must pass unchanged.

### B4. `evaluate` additions

With `world: true`, also return `worldRot` (quat) and, for chain end bones,
`reach`: distance from the chain root to the end ÷ the limb's length (1.0 =
fully straight). An agent uses it to know a target is reachable before
trying.

### B5. Checks (extend `scripts/apiCheck.mjs`)

- `ik.set` then `evaluate world:true`: the effector is within 0.1 mm of the
  target when reachable; `unreachableFrames > 0` and the limb straight when
  not.
- `ik.offset` 4 cm up over a span: mid-span world y is +4.00 cm ± 0.05; the
  frame-to-frame motion (velocity) inside the span differs from the
  recording by less than 0.5 mm; outside `[t0 − blend, t1 + blend]` nothing
  changed; `diff` lists only the three chain bones.
- `feet.pin` on a known sliding plant from the AB excerpt: ankle world x/z
  spread inside the span under 0.5 mm; foot world rotation spread under
  0.1° with `lockRotation`; a re-`scan` no longer reports that plant.
- Deny `RightUpperArm`, call `ik.offset` on `rightHand`: throws `ApiError`,
  session unchanged (`status` identical before/after).
- TWISTFIX-named session: forearm twist identical before/after an arm
  `ik.offset`, hand world rotation identical.
- Each op is one undo step; `.rig.json` save → load → `edited()` is
  bit-identical; timing-exact export changes only the chain bones' cells.

---

## C. Bridge and tween

Small, and the classic fix for a tracking dropout.

| Op | Behaviour |
|---|---|
| `bridge.insert` | Replace `[t0, t1]` on the given bones with a smooth path between the pose at `t0` and the pose at `t1`. Implemented as a new override layer with TWO sparse keys per bone (the edited local rotation at `t0` and at `t1`, key ease `smooth`), `fadeS = 1e-4`. The layer's own interpolation is the bridge; because the key values equal the motion at both ends, there is no step at either edge. Optional `via: [{ time, value }]` adds middle keys using the same `value` forms as `key.set` |
| `key.tween` | On an existing layer, set a key at `time` for the given bones to `slerp(previous key, next key, amount)`. `amount` 0.5 = halfway; below 0 or above 1 overshoots (push/pull). Errors if a bone has no key on both sides |
| `keys.match` | Copy the previous or next key's value onto the keys in `[t0, t1]` (`dir: "prev" | "next"`) — quaternion form of the editor's `matchKeys` |

These work on whole rotations (quaternions), not per-Euler-channel like the
curve editor's `matchKeys` / `blendKeysToward`, so there is no
representation switching to guard against. `keys.smooth` already covers
"blend toward neighbours".

Checks: `bridge.insert` edge step in `diff` under 0.5°/frame on a span with
a recorded pop inside it; the pop's `scan` issue clears; `key.tween` at 0, 1
equals the neighbours exactly.

---

## D. Self-contact detection and repair

### D1. Detection (`scan.ts`, new kind `self_penetration`)

- For each frame (stride 2, refined to stride 1 around hits), pose the proxy
  (A1) and test MOVER primitives against TARGET primitives:
  movers = hands, fingers, forearms; targets = torso, head, thighs, and the
  opposite arm and hand. Segment-to-segment closest distance, closed form;
  depth = `rA + rB − distance`.
- Pairs that share a joint or are parent/child are never tested. Fingers of
  one hand are not tested against that hand.
- Issue when depth exceeds `penetrationCm` (default 2.0) for at least
  `penetrationMinS` (default 0.05). Reported per mover group and target
  group with peak depth, peak time, the range, and the contact normal at the
  peak.
- Every issue carries `approximate: true` and the proxy source
  (`"bundled body"` or the `--body` file). The description says "likely".
  With the bundled proxy the default threshold is deliberately loose; with a
  measured `--body` proxy `penetrationCm` can drop to 1.0.
- Cost: about 30 movers × 8 targets per frame, trivially fast; no broad
  phase needed.
- Hands that are SUPPOSED to touch (clap, hand on hip) will be reported as
  shallow penetrations. That is correct and is why F2's dismissal exists.

### D2. Repair (`ik.depenetrate`)

`{ effector, t0, t1, against?: group[], margin?: 0.5 cm, blend? }` — a
`spanSolve` whose per-frame target is the hand's current position pushed out
along the contact normal by `depth + margin` where it penetrates and left
alone where it does not. The per-frame push vector is low-passed
(zero-phase, ~6 Hz) before solving so the correction cannot add jitter.
`suggestedFix` of a `self_penetration` issue is this op, ready to run.

### D3. Checks

- Synthetic: key the right hand into the chest with `ik.set`; scan reports
  one `self_penetration` with depth within 2 mm of the constructed value;
  after `ik.depenetrate` the re-scan is clear and the hand moved along the
  normal only (lateral drift under 2 mm).
- Identity pose and the sample idle take: zero issues (no false positives
  from neighbouring segments).
- Rendered `compare` strip of the fix shows the hand outside the torso
  capsule (pixel test: no hand-coloured pixel inside the torso mask at the
  peak frame).

---

## E. Stale-layer tracking

World-space fixes (B, D) are computed once against the motion beneath them
and stored as local rotations. If something lower changes afterwards — a
filter on the hips, a new layer under the feet pin — the fix is silently
wrong: the foot slides again. Today nothing says so.

- `RigLayer` gains an optional `gen?: { op: string; args: object; inputs: string }`.
  `inputs` is a short hash of the solver's inputs: the pre-solve world
  positions of the chain root and end over the keyed frames, rounded to
  0.1 mm.
- Every span op (`hold.insert`, `limit.apply`, and all of B/C/D) fills it.
- `status` and every mutating op's result include
  `stale: [{ layer, name, op, reason }]` when a `gen` layer's recomputed
  hash no longer matches.
- `layer.refresh { layer }` re-runs the stored op with the stored args in
  place (same index, same name), as one undo step.
- Guidance in the op descriptions: run feet and contact fixes LAST.

`.rig.json` and the web app: the field must survive `adoptRigDoc`
(`src/api/pipeline.ts`) and `adoptRigState` / the rig cache in `main.ts`.
Verify both pass unknown layer fields through before relying on it; if
`main.ts` rebuilds layers field by field, add `gen` there. The web editor
does not need to act on it.

Checks: `feet.pin`, then `filter.add` butterworth on Hips over the same
span → `stale` lists the pin; `layer.refresh` → the plant is tight again
and `stale` is empty.

---

## F. Scan calibration

### F1. Fix the twist reading

`twist_excess` sums hand and forearm twist per frame from independent
decompositions, each wrapped to ±180°. On the PTID excerpt it reports −180°
where the handoff expects about 156°, which looks like a wrap, not a
measurement. Unwrap each bone's twist along time (nearest-to-previous, the
`unwrapDegrees` idea) before summing, anchored at the frame of smallest
|twist| in the take. Acceptance: PTID excerpt peak reads 150–165°.

Unknown until tried: whether the handoff's 156° was measured about the same
axis. If the unwrapped value still disagrees, compare definitions before
tuning anything.

### F2. Dismissals and stable issue ids

- Each issue gets a stable `id`: `kind:bones:peakFrame`.
- `scan.dismiss { id, reason }` / `scan.undismiss { id }` (mutating, stored
  in the rig document as `scanNotes`). Dismissed issues are omitted from
  later scans unless `includeDismissed: true`, and match by kind + bones +
  overlapping frame range, so a re-scan after a nearby edit does not
  resurrect them.
- This is the agent's memory that "the hands are meant to touch at 42 s".

### F3. Take-relative thresholds and a truth set

- `scan` gains `summary: true`: counts per kind, issues per minute, and for
  each metric the take's p50 / p99 / p99.9, so a threshold can be judged
  against the take instead of in the abstract.
- `scripts/scan-truth/<take>.json`: hand-labelled issues
  (`{ kind, t0, t1, bones }`) and known non-issues. Seed it from the
  handoff's PTID and AB ranges.
- `npm run scanCheck -- <take.wanim> <truth.json>`: recall on labelled
  issues (must be 100% for the handoff's), and the count of unlabelled
  reports per minute, printed per kind. Thresholds change only when this
  script shows why.

**Needs the user:** one or two FULL takes with the real problems marked.
G1's markers are the easy way to produce them.

---

## G. Two-way link

Today the page watches the agent and nothing flows back. `CLAUDE.md` states
the link is read-only (GET only); this part relaxes that deliberately, in
two steps, and the rule's text must be updated with it.

### G1. Pointers and notes (page → agent), first

The cheap, safe half: the user points, the agent reads. No session state is
changed by the page.

- Page: when connected, the pill gains **Flag for agent**. It sends
  `{ time (playback s), bones (current selection), text }`. Also sent on
  demand: the page's playhead time and selection.
- Link server (`cli/link.mjs`): `POST /<token>/notes/<id>` (JSON, 4 KB cap),
  same token + origin checks as GET; the preflight answers
  `Access-Control-Allow-Methods: GET, POST`. Notes are appended to an
  in-memory list on the session entry.
- MCP: tool `wry_user_notes { session, clear? }` returns them (times
  converted to session time with `timeOffset`). Because MCP cannot push to
  the model, every tool result for that session also carries
  `userNotes: <count unread>` so the agent notices on its next call.
- Notes are data, never instructions to run: the tool description says so,
  and nothing in the server acts on note text.

### G2. Edits (page → agent), second

- Started only with `wry_view { allowEdits: true }`. The pill then reads
  "Agent: live (two-way)". Default stays one-way.
- Explicit, not automatic: a **Send to agent** button posts the page's
  current `.rig.json` with the `rev` it was based on.
  `PUT /<token>/rig/<id>`, 8 MB cap.
- Server → `Session.adoptUserRig(json, baseRev)`:
  - `baseRev` behind the session's revision → `409`; the page re-pulls and
    says the agent has moved on (agent wins; no merging).
  - Scope check: compare incoming against current, per layer track and
    filter. Any added or changed track on a bone outside
    `allowBones` / `denyBones`, any face data, any time warp → `422` with
    the bone names; nothing is applied.
  - Otherwise: push an undo snapshot, apply, log `user.edit`, bump `rev`.
- The agent sees `userEdits: { rev, layersAdded, layersChanged, bones }` on
  its next tool result and can `diff` as usual.

### G3. Prerequisite: one pipeline, or a parity check

The page bakes with `main.ts`'s own pipeline copy; the session bakes with
`src/api/pipeline.ts`. One-way, a mismatch is a wrong picture. Two-way, it
is wrong data. Before G2:

- Preferred: make `main.ts` `buildDisplay()` / `doExport()` call
  `runPipeline()`.
- Minimum: `linkCheck` gains a parity assertion — the page exposes its
  baked clip to the test, and every bone's local rotation matches
  `session.edited()` within 1e-4 rad on the sample take with a mixed rig
  (filter + additive + override + span layer).

### G4. Checks (`scripts/linkCheck.mjs`)

- A note posted from the page appears in `wry_user_notes` with the right
  session time; a note from a disallowed origin or wrong token is refused.
- Without `allowEdits`, `PUT` returns 404.
- With it: a page edit on RightHand arrives and `diff` shows it; an edit on
  a denied bone returns 422 and the session is unchanged; a stale `baseRev`
  returns 409.

---

## What this does not solve

- **The real avatar.** Proxy render and proxy contact approximate a body
  the recording does not contain. The last check stays the take playing on
  the avatar in Warudo with the music. A5 narrows the gap; nothing here
  closes it.
- **Props.** The microphone and anything else held are not in the file.
  Left-hand-on-mic stays a deny-list rule, not something detected.
- **Taste.** Scan finds limit violations and discontinuities. "This looks
  stiff" is still a person's call, delivered through G1.

## Open decisions (user)

1. **Relaxing read-only on the link (G2).** Recommended: yes, behind
   `allowEdits`, explicit Send button. G1 alone is worth shipping first.
2. **Render fidelity.** Recommended: ship the capsule renderer; decide on
   A5 after using it on a real take.
3. **Truth takes for F3.** One or two full takes with marked problems.
