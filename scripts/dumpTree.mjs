// Dump binary FBX (7500+/64-bit) node tree: names, prop types, scalar values.
import { readFileSync } from "node:fs";

const buf = readFileSync(process.argv[2]);
const maxDepth = Number(process.argv[3] ?? 3);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const dec = new TextDecoder();
const fileVersion = dv.getUint32(23, true);
const wide = fileVersion >= 7500; // 64-bit records from 7.5
const word = wide ? 8 : 4;
const headerLen = wide ? 25 : 13;
const u64 = (o) => (wide ? dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000 : dv.getUint32(o, true));

function readProps(o, count) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const t = String.fromCharCode(dv.getUint8(o)); o += 1;
    switch (t) {
      case "Y": out.push(dv.getInt16(o, true)); o += 2; break;
      case "C": out.push(!!dv.getUint8(o)); o += 1; break;
      case "I": out.push(dv.getInt32(o, true)); o += 4; break;
      case "F": out.push(dv.getFloat32(o, true)); o += 4; break;
      case "D": out.push(dv.getFloat64(o, true)); o += 8; break;
      case "L": out.push(u64(o)); o += 8; break;
      case "S": { const n = dv.getUint32(o, true); o += 4; out.push(JSON.stringify(dec.decode(buf.subarray(o, o + Math.min(n, 60))).replace(/\x00\x01/g, "::"))); o += n; break; }
      case "R": { const n = dv.getUint32(o, true); o += 4; out.push(`R[${n}:${[...buf.subarray(o, o + Math.min(n, 16))].map((x) => x.toString(16).padStart(2, "0")).join("")}]`); o += n; break; }
      case "f": case "d": case "l": case "i": case "b": {
        const len = dv.getUint32(o, true); const cmp = dv.getUint32(o + 8, true);
        out.push(`${t}[${len}]`); o += 12 + cmp; break;
      }
      default: throw new Error(`bad prop '${t}' @${o - 1}`);
    }
  }
  return [out, o];
}

function walk(o, depth, prefix) {
  const end = u64(o);
  if (end === 0) return [null, o + headerLen];
  const numProps = u64(o + word);
  const propLen = u64(o + 2 * word);
  const nameLen = dv.getUint8(o + 3 * word);
  const name = dec.decode(buf.subarray(o + 3 * word + 1, o + 3 * word + 1 + nameLen));
  let p = o + 3 * word + 1 + nameLen;
  const [props] = readProps(p, numProps);
  p += propLen;
  if (depth <= maxDepth) console.log(`${prefix}${name}: ${props.join(", ")}`);
  while (p < end) {
    const [done, np] = walk(p, depth + 1, prefix + "  ");
    p = np;
    if (done === null) break;
  }
  return [true, end];
}

let pos = 27;
while (pos < buf.length - 170) {
  const [n, np] = walk(pos, 0, "");
  pos = np;
  if (n === null) break;
}
