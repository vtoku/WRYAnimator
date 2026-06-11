// Minimal binary FBX (7500, 64-bit) tree dumper for debugging our writer.
import { readFileSync } from "node:fs";

const buf = readFileSync(process.argv[2] ?? "scripts/sample-bin.fbx");
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const version = dv.getUint32(23, true);
console.log("version", version);
const u64 = (o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;

let pos = 27;
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
      case "S": case "R": {
        const len = dv.getUint32(o, true); o += 4;
        props.push(type === "S" ? dec.decode(buf.subarray(o, o + len)) : `<raw ${len}>`);
        o += len; break;
      }
      case "f": case "d": case "l": case "i": case "b": {
        const arrLen = dv.getUint32(o, true);
        const enc = dv.getUint32(o + 4, true);
        const cmp = dv.getUint32(o + 8, true);
        o += 12 + cmp;
        props.push(`[${type}×${arrLen}${enc ? " zip" : ""}]`);
        break;
      }
      default: throw new Error(`bad prop type '${type}' at ${o - 1}`);
    }
  }
  return [props, o];
}

function readNode(o) {
  const end = u64(o);
  if (end === 0) return [null, o + 25];
  const numProps = u64(o + 8);
  const propLen = u64(o + 16);
  const nameLen = dv.getUint8(o + 24);
  const name = dec.decode(buf.subarray(o + 25, o + 25 + nameLen));
  let p = o + 25 + nameLen;
  const [props] = readProps(p, numProps);
  p += propLen;
  const children = [];
  while (p < end) {
    const [child, np] = readNode(p);
    p = np;
    if (child === null) break;
    children.push(child);
  }
  return [{ name, props, children }, end];
}

const top = [];
while (pos < buf.length - 160) {
  const [n, np] = readNode(pos);
  pos = np;
  if (n === null) break;
  top.push(n);
}

for (const n of top) {
  console.log(`${n.name} (props ${n.props.length}, children ${n.children.length})`);
}
const objects = top.find((n) => n.name === "Objects");
const counts = {};
for (const c of objects.children) counts[c.name] = (counts[c.name] ?? 0) + 1;
console.log("Objects:", JSON.stringify(counts));

const conns = top.find((n) => n.name === "Connections");
console.log("Connections:", conns.children.length);
console.log("first 6 C props:");
for (const c of conns.children.slice(0, 6)) console.log("  ", JSON.stringify(c.props));
console.log("OP connections sample:");
for (const c of conns.children.filter((c) => c.props[0] === "OP").slice(0, 4)) {
  console.log("  ", JSON.stringify(c.props));
}
const acn = objects.children.find((c) => c.name === "AnimationCurveNode");
console.log("first AnimationCurveNode props:", JSON.stringify(acn?.props));
const ac = objects.children.find((c) => c.name === "AnimationCurve");
console.log("first AnimationCurve children:", ac?.children.map((x) => x.name + "=" + JSON.stringify(x.props).slice(0, 40)));
