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
