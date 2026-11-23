// Face blendshape keys on rig layers: evaluation invariants + export paths.
// Usage: node --experimental-strip-types scripts/faceKeyCheck.mjs <file.wanim>
import { readFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter, resample } = await import("../src/convert/clip.ts");
const { writeWanim } = await import("../src/wanim/writeWanim.ts");
const {
  makeLayer, applyRigLayers, keyFaceValue, faceValueThrough, getFaceTrack, deleteFaceKeysAt,
  convertLayerMode, nearestFrame, bakeFace, faceKeyCount,
} = await import("../src/rig/rig.ts");

const path = process.argv[2];
if (!path) { console.error("usage: faceKeyCheck <file.wanim>"); process.exit(2); }
const buf = readFileSync(path);
const src = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const clip = convertCharacter(src, 0);
if (!clip.face) { console.log("(recording has no blendshapes — nothing to check)"); process.exit(0); }

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`); if (!ok) failures++; };
const face = clip.face;
const name = face.names.includes("jawOpen") ? "jawOpen" : face.names[1];
const n = face.names.indexOf(name);
const other = face.names.findIndex((x, i) => i !== n && x !== "trackingStatus");
const fMid = Math.floor(clip.times.length / 2);
const tMid = clip.times[fMid] - clip.times[0];
const maxDiff = (a, b, f0 = 0, f1 = a.length) => { let w = 0; for (let f = f0; f < f1; f++) w = Math.max(w, Math.abs(a[f] - b[f])); return w; };

// 1. No face keys: the clip passes through untouched.
const layers = [makeLayer("L1")];
check("no keys → same clip object", applyRigLayers(clip, layers) === clip);

// 2. Additive key hits the target at its frame, fades out, leaves the rest alone.
const base = face.tracks[n][fMid];
const target = base > 0.5 ? 0.1 : 0.9;
keyFaceValue(face, clip.times, layers, 0, name, fMid, target);
let out = applyRigLayers(clip, layers);
check("bones untouched by a face-only layer", out.localQuat === clip.localQuat);
check("source face tracks not mutated", face.tracks[n][fMid] === base);
check("additive key lands on the target", Math.abs(out.face.tracks[n][fMid] - target) < 1e-6, `${base.toFixed(3)} → ${out.face.tracks[n][fMid].toFixed(3)}`);
const fFar = nearestFrame(clip, tMid + layers[0].fadeS + 0.2);
const fFar0 = nearestFrame(clip, Math.max(0, tMid - layers[0].fadeS - 0.2));
check("outside the fade the recording is unchanged",
  maxDiff(out.face.tracks[n], face.tracks[n], fFar) === 0 && maxDiff(out.face.tracks[n], face.tracks[n], 0, fFar0) === 0);
check("other channels unchanged", maxDiff(out.face.tracks[other], face.tracks[other]) === 0);
check("values stay in 0..1", out.face.tracks[n].every((v) => v >= 0 && v <= 1));

// 3. Mode conversion keeps the value at the key.
convertLayerMode(clip, layers, 0, "override");
out = applyRigLayers(clip, layers);
check("additive → override keeps the keyed value", Math.abs(out.face.tracks[n][fMid] - target) < 1e-6);
convertLayerMode(clip, layers, 0, "additive");
check("override → additive keeps the keyed value", Math.abs(applyRigLayers(clip, layers).face.tracks[n][fMid] - target) < 1e-6);

// 4. Override span: two keys hold a value between them.
const l2 = makeLayer("L2"); l2.mode = "override"; layers.push(l2);
const fA = nearestFrame(clip, tMid + 2), fB = nearestFrame(clip, tMid + 3);
keyFaceValue(face, clip.times, layers, 1, name, fA, 0.25);
keyFaceValue(face, clip.times, layers, 1, name, fB, 0.25);
out = applyRigLayers(clip, layers);
let held = true;
for (let f = fA; f <= fB; f++) if (Math.abs(out.face.tracks[n][f] - 0.25) > 1e-6) held = false;
check("override keys hold the value across the span", held);
check("faceValueThrough matches the bake", Math.abs(faceValueThrough(face, clip.times, layers, layers.length, name, fA) - out.face.tracks[n][fA]) < 1e-6);

// 5. Weight and mute.
l2.weight = 0.5;
const half = applyRigLayers(clip, layers).face.tracks[n][fA];
check("weight 0.5 is halfway to the override", Math.abs(half - (face.tracks[n][fA] + 0.25) / 2) < 1e-6);
l2.weight = 1; l2.enabled = false; layers[0].enabled = false;
check("muted layers → recording passes through", applyRigLayers(clip, layers) === clip);
l2.enabled = true; layers[0].enabled = true;

// 6. In-place rebake (the editor path) equals the fresh bake, and restores on delete.
const own = face.tracks.map((t) => new Float32Array(t));
bakeFace(face, clip.times, layers, own);
check("in-place bake equals applyRigLayers", face.tracks.every((_, i) => maxDiff(own[i], out.face.tracks[i]) === 0));
const snapshot = JSON.parse(JSON.stringify(layers));
check("keys survive a JSON round trip (undo / .rig.json)", faceKeyCount(snapshot[0]) === 1 && faceKeyCount(snapshot[1]) === 2
  && maxDiff(applyRigLayers(clip, snapshot).face.tracks[n], out.face.tracks[n]) === 0);
deleteFaceKeysAt(layers[0], name, tMid, 0.02);
deleteFaceKeysAt(layers[1], name, clip.times[fA] - clip.times[0], 0.02);
deleteFaceKeysAt(layers[1], name, clip.times[fB] - clip.times[0], 0.02);
check("deleting every key removes the tracks", !getFaceTrack(layers[0], name) && !getFaceTrack(layers[1], name));
bakeFace(face, clip.times, layers, own);
check("in-place bake restores the recording", face.tracks.every((t, i) => maxDiff(own[i], t) === 0));

// 7. The key reaches a WANIM export.
keyFaceValue(face, clip.times, layers, 0, name, fMid, target);
const rs = resample(applyRigLayers(clip, layers), 60, 0, clip.duration);
const bytes = writeWanim(rs, src);
const re = parseWanim(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const set = Object.values(re.characters[0].blendshapes)[0];
const got = set[Math.round(tMid * 60)][name];
check("WANIM export carries the corrected value", Math.abs(got - target) < 0.03, `${got.toFixed(3)} vs ${target}`);
check("WANIM export keeps every channel", Object.keys(set[0]).length === face.names.length, `${Object.keys(set[0]).length} channels`);

if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
