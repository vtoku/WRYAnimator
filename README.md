# WANIM → FBX

A browser tool that converts a Warudo `.wanim` animation recording into an FBX animation.

https://vtoku.github.io/WANIMxFBX/

## What it does

Reads a `.wanim` file recorded in [Warudo](https://warudo.app/) and exports an `.fbx` containing the recorded skeleton animation. Conversion runs locally in the browser — the file is not uploaded.

## How to use

1. Drag a `.wanim` file onto the page (or click to select one).
2. Watch the animated skeleton in the 3D preview; scrub or pause with the transport bar.
3. Pick an export frame rate and click **Download FBX**.
4. Import the FBX into Blender, Maya, MotionBuilder, etc.

The FBX contains a 55-bone Unity humanoid skeleton (original bone names preserved) with per-bone rotation curves and root (hips) translation, in a single take. It is Y-up, in centimetres.

## Not included

Mesh, textures, blendshapes/morphs, spring bones, and props are not exported — `.wanim` records joint motion, not geometry.

## Trademarks

Independent, unofficial tool. "Warudo" is a trademark of HakuyaLabs. Not affiliated with or endorsed by them.

## License

MIT.
