// Replicate three's FBXLoader animation pipeline over our binary FBX to find
// exactly where tracks get dropped.
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2] ?? "scripts/sample-bin.fbx");
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const version = dv.getUint32(23, true);
const u64 = (o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;
const dec = new TextDecoder();

function readProps(o, count) {
  const props = [];
  for (let k = 0; k < count; k++) {
    const type = String.fromCharCode(dv.getUint8(o)); o += 1;
    switch (type) {
      case "Y": props.push(dv.getInt16(o, true)); o += 2; break;
      case "C": props.push(!!dv.getUint8(o)); o += 1; break;
      case "I": props.push(dv.getInt32(o, true)); o += 4; break;
      case "F": props.push(dv.getFloat32(o, true)); o += 4; break;
      case "D": props.push(dv.getFloat64(o, true)); o += 8; break;
      case "L": props.push(u64(o)); o += 8; break;
      case "S": case "R": { const len = dv.getUint32(o, true); o += 4; props.push(type === "S" ? dec.decode(buf.subarray(o, o + len)) : new Uint8Array(0)); o += len; break; }
      case "f": case "d": case "l": case "i": case "b": {
        const arrLen = dv.getUint32(o, true); const cmp = dv.getUint32(o + 8, true);
        // store a marker array of correct length (values not needed for join test)
        props.push({ __array: true, length: arrLen }); o += 12 + cmp; break;
      }
      default: throw new Error(`bad prop '${type}'`);
    }
  }
  return [props, o];
}
function readNode(o) {
  const end = u64(o);
  if (end === 0) return [null, o + 25];
  const numProps = u64(o + 8), propLen = u64(o + 16), nameLen = dv.getUint8(o + 24);
  const name = dec.decode(buf.subarray(o + 25, o + 25 + nameLen));
  let p = o + 25 + nameLen;
  const [props] = readProps(p, numProps);
  p += propLen;
  const singleProperty = numProps === 1 && p === end;
  const children = [];
  while (p < end) { const [c, np] = readNode(p); p = np; if (c === null) break; children.push(c); }
  return [{ name, props, children, id: typeof props[0] === "number" ? props[0] : undefined, attrName: props[1], singleProperty }, end];
}

// top-level loop replicating endOfContent
const size = buf.length;
const endOfContent = (off) => (size % 16 === 0 ? ((off + 176) & ~0xf) >= size : off + 176 >= size);
let pos = 27; const top = [];
while (!endOfContent(pos)) { const [n, np] = readNode(pos); pos = np; if (n === null) break; top.push(n); }
console.log("top-level nodes read:", top.map((n) => n.name).join(", "));

const byName = {};
for (const n of top) byName[n.name] = n;
console.log("has Connections?", !!byName.Connections, " has Objects?", !!byName.Objects);

// connectionMap
const conns = new Map();
for (const c of (byName.Connections?.children ?? [])) {
  const arr = c.props.slice(1);
  const from = arr[0], to = arr[1], rel = arr[2];
  if (!conns.has(from)) conns.set(from, { parents: [], children: [] });
  conns.get(from).parents.push({ ID: to, relationship: rel });
  if (!conns.has(to)) conns.set(to, { parents: [], children: [] });
  conns.get(to).children.push({ ID: from, relationship: rel });
}
console.log("connections:", byName.Connections?.children.length);

// objects keyed by id
const objById = (typeName) => {
  const m = {};
  for (const c of byName.Objects.children) if (c.name === typeName && c.id !== undefined) m[c.id] = c;
  return m;
};
const curveNodes = objById("AnimationCurveNode");
const curves = objById("AnimationCurve");
const models = objById("Model");
const layers = objById("AnimationLayer");
console.log("curveNodes:", Object.keys(curveNodes).length, "curves:", Object.keys(curves).length, "models:", Object.keys(models).length);

// parseAnimationCurveNodes
const curveNodesMap = new Map();
for (const id in curveNodes) {
  const cn = curveNodes[id];
  if (String(cn.attrName).match(/S|R|T|DeformPercent/)) curveNodesMap.set(cn.id, { id: cn.id, attr: cn.attrName, curves: {} });
}
console.log("curveNodesMap:", curveNodesMap.size);

// parseAnimationCurves
let attached = 0, noRel = 0;
for (const id in curves) {
  const cid = curves[id].id;
  const rel = conns.get(cid);
  if (!rel) { noRel++; continue; }
  const cnID = rel.parents[0].ID;
  const r = rel.parents[0].relationship;
  const target = curveNodesMap.get(cnID);
  if (!target) continue;
  if (/X/.test(r)) target.curves.x = 1;
  else if (/Y/.test(r)) target.curves.y = 1;
  else if (/Z/.test(r)) target.curves.z = 1;
  attached++;
}
console.log("curves attached:", attached, "no-relationship:", noRel);

// parseAnimationLayers
let trackCount = 0;
for (const id in layers) {
  const conn = conns.get(Number(id));
  if (!conn) { console.log("layer no conn"); continue; }
  for (const child of conn.children) {
    const cn = curveNodesMap.get(child.ID);
    if (!cn) continue;
    if (cn.curves.x || cn.curves.y || cn.curves.z) {
      const modelRel = conns.get(child.ID).parents.filter((p) => p.relationship !== undefined)[0];
      if (modelRel && models[modelRel.ID]) trackCount++;
      else console.log("curveNode", child.ID, "no model; modelRel=", JSON.stringify(modelRel));
    }
  }
}
console.log("=> tracks that would be built:", trackCount);
