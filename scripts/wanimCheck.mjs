// WANIM re-export round-trip: parse → convert → resample → writeWanim →
// reparse, then verify NOTHING was renamed or dropped — blendshape set name,
// every channel name, values (within resample interpolation), and bone
// rotations. Guards Warudo re-import compatibility.
// Usage: node scripts/wanimCheck.mjs [file.wanim]
import { readFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter, resample } = await import("../src/convert/clip.ts");
const { writeWanim } = await import("../src/wanim/writeWanim.ts");

const path = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim";
const buf = readFileSync(path);
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const conv = convertCharacter(clip, 0);
const rs = resample(conv, 60, 0, conv.duration);
const out = writeWanim(rs, clip);
const re = parseWanim(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  if (!ok) failures++;
};

const ch0 = clip.characters[0];
const ch1 = re.characters[0];
const sets0 = Object.keys(ch0.blendshapes ?? {});
const sets1 = Object.keys(ch1.blendshapes ?? {});

if (sets0.length === 0) {
  console.log("(recording has no blendshapes — face checks skipped)");
} else {
  check("blendshape set name preserved", sets0[0] === sets1[0], `${JSON.stringify(sets0[0])} -> ${JSON.stringify(sets1[0])}`);
  const s0 = ch0.blendshapes[sets0[0]];
  const s1 = ch1.blendshapes[sets1[0]] ?? [];
  const n0 = Object.keys(s0[0] ?? {});
  const n1 = new Set(Object.keys(s1[0] ?? {}));
  const missing = n0.filter((n) => !n1.has(n));
  check("all blendshape channels preserved", missing.length === 0, `${n0.length} channels, missing [${missing.slice(0, 5)}]`);

  // Values at matching times (worst over sampled channels/frames).
  let worst = 0;
  for (let i = 1; i < 8; i++) {
    const f0 = Math.floor((clip.times.length * i) / 8);
    const t = clip.times[f0] - clip.times[0];
    const f1 = Math.round(t * 60);
    for (const n of n0) {
      worst = Math.max(worst, Math.abs((s0[f0]?.[n] ?? 0) - (s1[f1]?.[n] ?? 0)));
    }
  }
  check("blendshape values survive (resample tolerance)", worst < 0.05, `worst diff ${worst.toFixed(4)}`);
}

// Bones: local rotations through the convert pipeline of both files.
// Compare at the EXACT source timestamp: slerp the re-imported 60fps clip to
// t rather than snapping to the nearest frame — the ≤8.3ms snap reads as up
// to ~2° of pure quantization during fast moves and hides real regressions.
const { quatSlerp } = await import("../src/convert/quat.ts");
const conv1 = convertCharacter(re, 0);
let worstQ = 0;
for (let i = 1; i < 8; i++) {
  const f0 = Math.floor((clip.times.length * i) / 8);
  const t = clip.times[f0] - clip.times[0];
  const fa = Math.min(conv1.times.length - 1, Math.floor(t * 60));
  const fb = Math.min(conv1.times.length - 1, fa + 1);
  const frac = Math.max(0, Math.min(1, t * 60 - fa));
  for (const b of [0, 1, 3, 14, 20, 40, 54]) {
    const q0 = conv.localQuat[b][f0];
    if (Math.hypot(...q0) < 0.5) continue; // dead bone
    const q1 = quatSlerp(conv1.localQuat[b][fa], conv1.localQuat[b][fb], frac);
    const dot = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]);
    worstQ = Math.max(worstQ, (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI);
  }
}
check("bone rotations survive (resample tolerance)", worstQ < 1.0, `worst ${worstQ.toFixed(3)}°`);

if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
