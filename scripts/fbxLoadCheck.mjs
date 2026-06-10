// Round-trip check: load a generated FBX with three's FBXLoader and report the
// reconstructed skeleton + animation. Validates that the ASCII we emit actually
// parses as a skeletal animation in an FBX-SDK-equivalent importer.
import { readFileSync } from "node:fs";

// Minimal DOM shims FBXLoader touches at import/parse time in node.
globalThis.self = globalThis;
const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
const THREE = await import("three");

const file = process.argv[2] ?? "scripts/sample-out.fbx";
const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new FBXLoader();
const group = loader.parse(ab, "");

let bones = 0;
group.traverse((o) => {
  if (o.isBone || o.type === "Bone") bones++;
});

const clips = group.animations ?? [];
console.log(`file        ${file}`);
console.log(`bones       ${bones}`);
console.log(`clips       ${clips.length}`);
for (const c of clips) {
  console.log(`  "${c.name}" duration ${c.duration.toFixed(2)}s, tracks ${c.tracks.length}`);
}

// Spot-check: hips should travel (its position track must vary).
const hipsTrack = clips[0]?.tracks.find((t) => /Hips\.position/.test(t.name));
if (hipsTrack) {
  const v = hipsTrack.values;
  let min = Infinity, max = -Infinity;
  for (let i = 1; i < v.length; i += 3) { // Y component
    min = Math.min(min, v[i]);
    max = Math.max(max, v[i]);
  }
  console.log(`  hips Y range ${min.toFixed(1)}..${max.toFixed(1)} cm`);
}

if (bones < 50) throw new Error(`expected ~55 bones, got ${bones}`);
if (clips.length === 0) throw new Error("no animation clips parsed");
console.log("OK");
