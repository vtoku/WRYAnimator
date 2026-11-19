# WRYAnimator

A browser-based motion-capture editor for Warudo `.wanim` recordings: clean, edit, retarget, re-time, and export to FBX, VRMA, or wanim.

https://wryanimator.com/

## What it does

Reads a `.wanim` file recorded in [Warudo](https://warudo.app/) and lets you work on the motion in the browser — preview it in 3D, clean it up (de-spike, smooth, fix feet/wrists), edit it with a MotionBuilder-style control rig and keyframe layers, retarget it onto a body, trim and time-warp it — then export to FBX, VRMA, or a re-saved wanim. Everything runs locally in your browser, so the file is never uploaded.

## How to use

1. Drag a `.wanim` file onto the page (or click to select one).
2. Watch the animated skeleton in the 3D preview, including a stand-in head that plays back the recorded ARKit face blendshapes, and scrub or pause with the transport bar.
3. Pick a frame rate and a format (FBX, VRMA, or WANIM), then hit **Download**.
4. Import the FBX into Blender, Maya, MotionBuilder, etc., load the VRMA in Warudo/VSeeFace/Unity, or take the cleaned WANIM back into Warudo.

The preview face is for reference only; face data is not written to the FBX (see below).

The FBX is **binary FBX 7.5** (imports into MotionBuilder, Blender, Maya, Unity): a 55-bone Unity humanoid skeleton with per-bone rotation curves and root (hips) translation, in a single take, Y-up, centimetres. Options:

- **Bone names**: Unity HumanBodyBones (default), or MotionBuilder/HumanIK names that auto-characterize in MotionBuilder.
- **Rest pose**: T-pose (default) or the first recorded frame.
- **Face blendshapes**: embeds a stand-in head mesh carrying the recorded ARKit blendshape animation (52 ARKit channels) as morph targets.

## Command line and MCP (for scripts and AI agents)

The same editing core also runs without a browser, from this repo, on Node 22.18+ (`npm install` first). It opens recordings by local path, so there is no upload or size limit.

```bash
node cli/wry.mjs scan take.wanim --bones RightHandAll        # find problems, ranked, each with a suggested fix
node cli/wry.mjs evaluate take.wanim --bones RightHand --t0 190 --t1 193 --step 6
node cli/wry.mjs edit take.wanim fix.json -o take_fixed.wanim --save-rig take.rig.json
node cli/wry.mjs diff take.wanim --rig take.rig.json         # prove only the intended bones and frames changed
node cli/wry.mjs convert take.wanim -o take.fbx --names motionbuilder
```

Output is one JSON document on stdout; errors are `{"error": …}` with a nonzero exit. `wry ops` lists every editing operation.

**Timing-exact WANIM.** `wry edit` / `wry export` write the original file with only the edited (bone, frame) values overwritten: same frame count, the original float64 timestamps, and every untouched bone, the root track and all face blendshapes byte-identical to the source. That keeps a take in sync with music and lip-sync. (`wry convert` is the resampling path, for FBX and VRMA.)

**Edit scripts** are a list of numeric, scoped operations:

```json
{
  "denyBones": ["LeftHandAll"],
  "ops": [
    { "op": "limit.apply", "bones": ["RightHand"], "t0": 190, "t1": 193,
      "limits": { "flex": [-70, 70], "deviation": [-40, 30] }, "softness": 8, "blend": 0.25 },
    { "op": "hold.insert", "bones": ["RightHand"], "donorTime": 190.2, "t0": 190.95, "t1": 191.36 }
  ]
}
```

Angles are degrees: wrist `flex` (+ palm-ward, − bent back), `deviation` (+ thumb side), `twist` (+ supination); finger `curl` (+ closing, − hyperextended) and `splay`. Bones on `denyBones` are never written — an operation that would touch one is refused and nothing is saved. A `.rig.json` saved here opens in the web editor on the same recording.

**MCP server** (stdio), one tool per operation plus open / export:

```bash
claude mcp add wry -- node /path/to/WRYAnimator/cli/wry.mjs mcp
```

**Local link — watch the agent in the web editor.** The `wry_view` tool opens https://wryanimator.com with a link ending in `#agent=<code>`. The page then loads the recording from the agent's process on `127.0.0.1` and follows its edits live (layers appear in the Layers rail, the playhead moves to where the agent is working). Nothing is uploaded; the link is read-only, needs the per-run code, and only answers the WRYAnimator site and localhost. You can also connect with **File → Connect to local agent…**. Works in Chrome, Edge and Firefox (Safari blocks secure pages from reaching local programs).

`npm run apiCheck` verifies the API, the timing-exact export, the CLI and the MCP server; `npm run build && npm run linkCheck` verifies the local link in a real browser.

## Not included

Textures, spring/jiggle bones, and props are not exported. The recorded mesh isn't in the `.wanim` file, so the embedded face head is a generic stand-in driven by the captured blendshape weights.

## Credits

Independent, unofficial tool. "Warudo" is a trademark of [HakuyaLabs](https://warudo.app/). Not affiliated with or endorsed by them.

- **Preview face** — the "facecap" head by [Face Cap](https://www.bannaflak.com/face-cap) (Bannaflak), distributed with three.js; textures are stripped and it is used for on-screen reference only.
- **Bundled body** — Xbot (Mixamo) via three.js examples, and the "Suit" from Quaternius' Ultimate Modular Women pack (CC0, textures stripped). You can also drop in your own VRM/GLB.
- **Logo font** — [Krona One](https://fonts.google.com/specimen/Krona+One) by Yvonne Schüttler, [SIL Open Font License 1.1](https://openfontlicense.org/); self-hosted (latin subset).
- **3D + import/export** — [three.js](https://threejs.org/).

**Intended use:** this is for editing **your own** motion recordings. Please don't use it to rip animations that ship with Warudo or other paid assets. Make sure you actually own the rights to whatever you convert (for example, from Booth or the Unity Asset Store).

## License

MIT.
