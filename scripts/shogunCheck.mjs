// Structural check for the Shogun target-rig ASCII FBX exporter.
// Runs the real src/shogun export path on a VRM (or any humanoid GLB) and
// asserts the invariants Shogun depends on:
//   (a) every joint (LimbNode) has identity rotation (Lcl Rotation + PreRotation 0)
//   (b) local translation == world-offset delta from the parent joint
//   (c) each skin cluster's TransformLink == that bone's bind world matrix
//   (d) bone names are byte-identical to the source VRM/GLB node names
//
// Usage: node scripts/shogunCheck.mjs [file.vrm|file.glb]
// If no arg is given it looks for a .vrm in C:\Users\VTOKU\Downloads; failing
// that it falls back to public/body.glb (a plain humanoid GLB, mapped via the
// vrmHumanoid name fallback) and says so.
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// three's GLTFLoader references `self` and `createImageBitmap`; neither exists
// in plain Node. Stub the minimum so the loader parses geometry/skins headless.
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

function pickInput() {
  const arg = process.argv[2];
  if (arg) return { path: arg, fallback: false };
  const dl = "C:\\Users\\VTOKU\\Downloads";
  if (existsSync(dl)) {
    const vrm = readdirSync(dl).filter((f) => /\.vrm$/i.test(f)).sort();
    if (vrm.length) return { path: join(dl, vrm[0]), fallback: false };
  }
  return { path: join(repo, "public", "body.glb"), fallback: true };
}

const { path, fallback } = pickInput();
if (fallback) {
  console.log("No .vrm found in Downloads — falling back to a plain humanoid GLB");
  console.log("(public/body.glb) via the vrmHumanoid name-mapping fallback.");
}
console.log(`input: ${path}`);

const { exportShogunFbx } = await import("../src/shogun/exportShogun.ts");
const { sanitizeGlb, parseGlbChunks } = await import("../src/vrm/vrmHumanoid.ts");

const buf = readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const res = await exportShogunFbx(ab, { stripSprings: true });
const fbx = res.fbx;
console.log(
  `exported: ${res.boneCount} bones, ${res.totalVertices} verts, ` +
    `${res.springBoneCount} spring bones${res.strippedSprings ? " (stripped)" : ""}, ` +
    `VRM ${res.version ?? "none"}`,
);

// Dump the FBX + a joint reference next to the repo for the Blender step.
const outFbx = join(repo, "scripts", "shogun-out.fbx");
writeFileSync(outFbx, fbx);

// ---- tiny ASCII-FBX reader ------------------------------------------------
const lines = fbx.split("\n");
const nums = (s) => s.split(",").map((x) => Number(x.trim()));

// block from a Model/Deformer/Pose line to its matching one-tab close "\t}"
function blockEnd(start) {
  for (let i = start + 1; i < lines.length; i++) if (lines[i] === "\t}") return i;
  return lines.length;
}

const models = []; // {id,name,type,lclT,lclR,preR}
const clusters = []; // {id,name,transform,transformLink}
const poseMat = new Map(); // nodeId -> number[16]
const conns = []; // [child,parent]
let up = null, unit = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  let m = line.match(/^\tModel: (\d+), "Model::(.*)", "(LimbNode|Mesh)" \{$/);
  if (m) {
    const end = blockEnd(i);
    const body = lines.slice(i, end);
    const grab = (re) => { for (const b of body) { const g = b.match(re); if (g) return nums(g[1]); } return null; };
    models.push({
      id: Number(m[1]),
      name: m[2],
      type: m[3],
      lclT: grab(/P: "Lcl Translation", "Lcl Translation", "", "A",(.+)$/),
      lclR: grab(/P: "Lcl Rotation", "Lcl Rotation", "", "A",(.+)$/),
      preR: grab(/P: "PreRotation", "Vector3D", "Vector", "",(.+)$/),
    });
    continue;
  }

  m = line.match(/^\tDeformer: (\d+), "SubDeformer::Cluster (.*)", "Cluster" \{$/);
  if (m) {
    const end = blockEnd(i);
    const body = lines.slice(i, end);
    const grabMat = (label) => {
      const k = body.findIndex((b) => b.trim().startsWith(label));
      if (k < 0) return null;
      const a = body[k + 1].match(/a: (.+)$/);
      return a ? nums(a[1]) : null;
    };
    clusters.push({
      id: Number(m[1]),
      name: m[2],
      transform: grabMat("Transform: *16"),
      transformLink: grabMat("TransformLink: *16"),
    });
    continue;
  }

  if (line.match(/^\tPose: \d+, "Pose::BIND_POSES", "BindPose" \{$/)) {
    for (let j = i + 1; j < lines.length && lines[j] !== "\t}"; j++) {
      if (lines[j].trim() === "PoseNode:  {") {
        const nodeLine = lines[j + 1].match(/Node: (\d+)/);
        const aLine = lines[j + 3].match(/a: (.+)$/);
        if (nodeLine && aLine) poseMat.set(Number(nodeLine[1]), nums(aLine[1]));
      }
    }
  }

  m = line.match(/^\tC: "OO",(\d+),(\d+)$/);
  if (m) conns.push([Number(m[1]), Number(m[2])]);

  let g = line.match(/P: "UpAxis", "int", "Integer", "",(\d+)/);
  if (g) up = Number(g[1]);
  g = line.match(/P: "UnitScaleFactor", "double", "Number", "",(\d+)/);
  if (g) unit = Number(g[1]);
}

const limbs = models.filter((x) => x.type === "LimbNode");
const boneIds = new Set(limbs.map((x) => x.id));
const clusterIds = new Set(clusters.map((x) => x.id));

// hierarchy: child bone -> parent bone id (parent bone or 0), excluding
// the bone->cluster attach connections (parent is a clusterId there).
const parentOf = new Map();
for (const [c, p] of conns) {
  if (boneIds.has(c) && (p === 0 || boneIds.has(p))) parentOf.set(c, p);
}
// cluster -> bone: connection where parent is the cluster, child is a bone.
const clusterBone = new Map();
for (const [c, p] of conns) {
  if (clusterIds.has(p) && boneIds.has(c)) clusterBone.set(p, c);
}

// source node names (byte-identical target for the bone names)
const chunks = parseGlbChunks(sanitizeGlb(ab));
const nodeNames = new Set(
  (chunks?.json?.nodes ?? []).map((n) => (typeof n?.name === "string" ? n.name : undefined)).filter(Boolean),
);

// ---- assertions -----------------------------------------------------------
let failures = 0;
const EPS = 1e-3;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const worldOf = (id) => { const mm = poseMat.get(id); return mm ? [mm[12], mm[13], mm[14]] : null; };
const close = (a, b) => a != null && b != null && a.length === b.length && a.every((x, k) => Math.abs(x - b[k]) <= EPS);

check("global UpAxis = Y", up === 1, `UpAxis=${up}`);
check("global UnitScaleFactor = 1", unit === 1, `unit=${unit}`);
check("at least one joint exported", limbs.length > 0, `${limbs.length} joints`);
check("bind pose covers every joint", limbs.every((b) => poseMat.has(b.id)), `${poseMat.size} pose nodes`);

// (a) identity rotation on every joint
{
  let bad = [];
  for (const b of limbs) {
    const rOk = b.lclR && b.lclR.every((v) => v === 0);
    const pOk = b.preR && b.preR.every((v) => v === 0);
    if (!rOk || !pOk) bad.push(b.name);
  }
  check("(a) every joint has identity rotation", bad.length === 0, bad.length ? `bad: ${bad.slice(0, 4).join(", ")}` : `${limbs.length} joints`);
}

// (b) local translation == world-offset delta from parent
{
  let bad = [];
  for (const b of limbs) {
    const w = worldOf(b.id);
    const p = parentOf.get(b.id);
    const pw = p && p !== 0 ? worldOf(p) : [0, 0, 0];
    if (!w || !pw) { bad.push(b.name); continue; }
    const delta = [w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]];
    if (!close(b.lclT, delta)) bad.push(b.name);
  }
  check("(b) local translation == world-offset delta", bad.length === 0, bad.length ? `bad: ${bad.slice(0, 4).join(", ")}` : `${limbs.length} joints`);
}

// (c) cluster TransformLink == bind world matrix (+ Transform is its inverse)
{
  let bad = [];
  for (const cl of clusters) {
    const boneId = clusterBone.get(cl.id);
    const pm = boneId != null ? poseMat.get(boneId) : null;
    const linkOk = pm && close(cl.transformLink, pm);
    // inverse: identity rotation, translation negated
    const invOk =
      cl.transform && cl.transformLink &&
      close(cl.transform.slice(0, 12), cl.transformLink.slice(0, 12)) &&
      close([cl.transform[12], cl.transform[13], cl.transform[14]], [-cl.transformLink[12], -cl.transformLink[13], -cl.transformLink[14]]);
    if (!linkOk || !invOk) bad.push(cl.name);
  }
  check("(c) cluster TransformLink == bind world matrix", bad.length === 0, `${clusters.length} clusters${bad.length ? ", bad: " + bad.slice(0, 4).join(", ") : ""}`);
}

// (d) bone names byte-identical to source node names
{
  let bad = [];
  for (const b of limbs) if (!nodeNames.has(b.name)) bad.push(b.name);
  check("(d) bone names byte-identical to VRM node names", bad.length === 0, bad.length ? `not in nodes: ${bad.slice(0, 4).join(", ")}` : `${limbs.length} names`);
}

// A joint reference for the Blender diff (world positions in cm, from BindPose).
const jointRef = limbs.map((b) => ({ name: b.name, world: worldOf(b.id) }));
writeFileSync(join(repo, "scripts", "shogun-joints.json"), JSON.stringify(jointRef));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}  (fbx: ${outFbx})`);
process.exit(failures === 0 ? 0 : 1);
