import { readFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter, resample } = await import("../src/convert/clip.ts");
const { writeWanim } = await import("../src/wanim/writeWanim.ts");

const file = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\takyon take 2.wanim";
const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const clip = parseWanim(ab);
const converted = convertCharacter(clip);
const resampled = resample(converted, 60, 0); // full clip, 60fps

// Write, then read it back through the full pipeline.
const bytes = writeWanim(resampled, clip);
console.log("wrote", (bytes.length / 1e6).toFixed(2), "MB,", resampled.frameCount, "frames");

const rt = parseWanim(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const rtConv = convertCharacter(rt);

// Compare the round-tripped clip to the resampled input.
if (rt.times.length !== resampled.frameCount) throw new Error(`frame count ${rt.times.length} != ${resampled.frameCount}`);
let maxPos = 0, maxQuat = 0, maxFace = 0, worstBone = -1;
const norm = (q) => Math.hypot(q[0], q[1], q[2], q[3]);
const B = resampled.names.length;
const degenerate = new Set();
for (let i = 0; i < resampled.frameCount; i++) {
  for (let b = 0; b < B; b++) {
    const pa = resampled.localPos[b][i], pb = rtConv.localPos[b][i];
    maxPos = Math.max(maxPos, Math.hypot(pa[0]-pb[0], pa[1]-pb[1], pa[2]-pb[2]));
    const qa = resampled.localQuat[b][i], qb = rtConv.localQuat[b][i];
    if (norm(qa) < 0.5) { degenerate.add(resampled.names[b]); continue; } // dead bone, can't round-trip
    const dot = Math.abs(qa[0]*qb[0]+qa[1]*qb[1]+qa[2]*qb[2]+qa[3]*qb[3]);
    const ang = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
    if (ang > maxQuat) { maxQuat = ang; worstBone = b; }
  }
}
console.log("degenerate (dead) bones skipped:", [...degenerate].join(", ") || "none");
console.log("worst non-degenerate bone:", worstBone >= 0 ? resampled.names[worstBone] : "n/a");
if (resampled.face && rtConv.face) {
  const an = resampled.face.names, bn = rtConv.face.names;
  for (let n = 0; n < an.length; n++) {
    const j = bn.indexOf(an[n]);
    if (j < 0) { console.log("MISSING face channel", an[n]); continue; }
    for (let i = 0; i < resampled.frameCount; i++) maxFace = Math.max(maxFace, Math.abs(resampled.face.tracks[n][i] - rtConv.face.tracks[j][i]));
  }
}
console.log("max position drift:", maxPos.toExponential(2), "m");
console.log("max rotation drift:", maxQuat.toExponential(2), "deg");
console.log("max blendshape drift:", maxFace.toExponential(2));
console.log("times[0..3]:", rt.times.slice(0, 4).map((t) => t.toFixed(4)).join(", "));
console.log(maxPos < 1e-3 && maxQuat < 0.1 && maxFace < 1e-3 ? "ROUNDTRIP OK" : "ROUNDTRIP DRIFT TOO HIGH");
