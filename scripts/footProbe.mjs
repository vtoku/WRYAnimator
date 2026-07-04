// Measures feet-contact quality in a recording: estimated ground level,
// penetration below it, hover, and skating (horizontal drift while planted).
// Decides what a feet-contact cleaning filter would actually need to fix.
// Usage: node scripts/footProbe.mjs [file.wanim]
import { readFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter } = await import("../src/convert/clip.ts");
const { BONE_PARENTS } = await import("../src/convert/skeleton.ts");
const { quatMul, quatRotate } = await import("../src/convert/quat.ts");

const path = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim";
const buf = readFileSync(path);
const clip = parseWanim(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const c = convertCharacter(clip, 0);
const frames = c.times.length;
const fps = c.duration > 0 ? (frames - 1) / c.duration : 60;
console.log(`${path.split(/[\\/]/).pop()}: ${frames} frames, ${c.duration.toFixed(1)}s, ~${fps.toFixed(0)} fps`);

// FK world position of a bone at frame f (parents resolved recursively —
// the bone array is NOT topologically sorted).
function worldOf(bone, f, cache) {
  if (cache[bone]) return cache[bone];
  const p = BONE_PARENTS[bone];
  let pos, rot;
  if (p < 0) {
    pos = c.localPos[bone][f];
    rot = c.localQuat[bone][f];
  } else {
    const parent = worldOf(p, f, cache);
    pos = add(parent.pos, quatRotate(parent.rot, c.localPos[bone][f]));
    rot = quatMul(parent.rot, c.localQuat[bone][f]);
  }
  return (cache[bone] = { pos, rot });
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// Track foot + toe world positions per frame.
const track = {};
for (const side of ["Left", "Right"]) {
  track[side] = { foot: [], toe: [] };
}
for (let f = 0; f < frames; f++) {
  const cache = {};
  for (const side of ["Left", "Right"]) {
    track[side].foot.push(worldOf(c.names.indexOf(`${side}Foot`), f, cache).pos);
    track[side].toe.push(worldOf(c.names.indexOf(`${side}Toes`), f, cache).pos);
  }
}

// Lowest contact point per frame = min(foot, toe) Y per side.
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * p)];

for (const side of ["Left", "Right"]) {
  const { foot, toe } = track[side];
  const lowY = foot.map((p, f) => Math.min(p[1], toe[f][1]));
  const ground = pct(lowY, 0.05); // 5th percentile ≈ planted height
  const minY = Math.min(...lowY);
  const maxY = Math.max(...lowY);

  // Stance = lowest point within 3cm of ground estimate.
  const CONTACT = 0.03;
  let stanceFrames = 0, skateSum = 0, skateMax = 0, spans = 0;
  let spanStart = -1;
  const spanSkates = [];
  for (let f = 0; f <= frames; f++) {
    const inContact = f < frames && lowY[f] < ground + CONTACT;
    if (inContact) {
      stanceFrames++;
      if (spanStart < 0) spanStart = f;
    } else if (spanStart >= 0) {
      // measure horizontal drift over the span (use toe as anchor point)
      const span = f - spanStart;
      if (span >= Math.round(fps * 0.15)) { // ignore blips < 150ms
        const a = toe[spanStart], b = toe[f - 1];
        const drift = Math.hypot(b[0] - a[0], b[2] - a[2]);
        skateSum += drift;
        skateMax = Math.max(skateMax, drift);
        spanSkates.push({ at: c.times[spanStart].toFixed(1), dur: (span / fps).toFixed(2), drift: (drift * 100).toFixed(1) });
        spans++;
      }
      spanStart = -1;
    }
  }

  const cm = (v) => (v * 100).toFixed(1);
  console.log(`\n${side} foot:`);
  console.log(`  ground estimate (5th pct): ${cm(ground)} cm | lowest: ${cm(minY)} cm | highest: ${cm(maxY)} cm`);
  console.log(`  penetration below ground:  ${cm(ground - minY)} cm worst`);
  console.log(`  stance: ${stanceFrames} frames (${((stanceFrames / frames) * 100).toFixed(0)}%) in ${spans} spans >=150ms`);
  console.log(`  skating during stance:     avg ${cm(spans ? skateSum / spans : 0)} cm/span, worst ${cm(skateMax)} cm`);
  const worst = spanSkates.sort((a, b) => b.drift - a.drift).slice(0, 5);
  for (const s of worst) console.log(`    t=${s.at}s dur=${s.dur}s drift=${s.drift}cm`);
}

// Absolute floor: does the character hover overall? Compare both feet.
const allLow = [];
for (let f = 0; f < frames; f++) {
  allLow.push(Math.min(track.Left.foot[f][1], track.Left.toe[f][1], track.Right.foot[f][1], track.Right.toe[f][1]));
}
console.log(`\nscene floor: lowest contact anywhere = ${(Math.min(...allLow) * 100).toFixed(1)} cm, 5th pct = ${(pct(allLow, 0.05) * 100).toFixed(1)} cm (0 = Warudo floor)`);
