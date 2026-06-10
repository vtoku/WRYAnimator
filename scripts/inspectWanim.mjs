// Reverse-engineer .wanim: msgpack + LZ4Block (MessagePack-CSharp ext 98/99)
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const buf = readFileSync(file);

// --- LZ4 block decompress ---
function lz4Decompress(src, dstLen) {
  const dst = Buffer.alloc(dstLen);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let litLen = token >> 4;
    if (litLen === 15) { let b; do { b = src[s++]; litLen += b; } while (b === 255); }
    src.copy(dst, d, s, s + litLen); s += litLen; d += litLen;
    if (s >= src.length) break;
    const offset = src[s] | (src[s + 1] << 8); s += 2;
    let matchLen = (token & 15) + 4;
    if ((token & 15) === 15) { let b; do { b = src[s++]; matchLen += b; } while (b === 255); }
    let m = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++];
  }
  return dst.subarray(0, d);
}

// --- minimal msgpack decoder ---
function decode(buf, pos) {
  const b = buf[pos];
  if (b < 0x80) return [b, pos + 1];
  if (b >= 0xe0) return [b - 256, pos + 1];
  if (b >= 0x80 && b <= 0x8f) return decodeMap(buf, pos + 1, b & 15);
  if (b >= 0x90 && b <= 0x9f) return decodeArr(buf, pos + 1, b & 15);
  if (b >= 0xa0 && b <= 0xbf) return [buf.toString('utf8', pos + 1, pos + 1 + (b & 31)), pos + 1 + (b & 31)];
  switch (b) {
    case 0xc0: return [null, pos + 1];
    case 0xc2: return [false, pos + 1];
    case 0xc3: return [true, pos + 1];
    case 0xc4: { const n = buf[pos + 1]; return [{ bin: buf.subarray(pos + 2, pos + 2 + n) }, pos + 2 + n]; }
    case 0xc5: { const n = buf.readUInt16BE(pos + 1); return [{ bin: buf.subarray(pos + 3, pos + 3 + n) }, pos + 3 + n]; }
    case 0xc6: { const n = buf.readUInt32BE(pos + 1); return [{ bin: buf.subarray(pos + 5, pos + 5 + n) }, pos + 5 + n]; }
    case 0xc7: { const n = buf[pos + 1]; return decodeExt(buf, pos + 2, n); }
    case 0xc8: { const n = buf.readUInt16BE(pos + 1); return decodeExt(buf, pos + 3, n); }
    case 0xc9: { const n = buf.readUInt32BE(pos + 1); return decodeExt(buf, pos + 5, n); }
    case 0xca: return [buf.readFloatBE(pos + 1), pos + 5];
    case 0xcb: return [buf.readDoubleBE(pos + 1), pos + 9];
    case 0xcc: return [buf[pos + 1], pos + 2];
    case 0xcd: return [buf.readUInt16BE(pos + 1), pos + 3];
    case 0xce: return [buf.readUInt32BE(pos + 1), pos + 5];
    case 0xcf: return [Number(buf.readBigUInt64BE(pos + 1)), pos + 9];
    case 0xd0: return [buf.readInt8(pos + 1), pos + 2];
    case 0xd1: return [buf.readInt16BE(pos + 1), pos + 3];
    case 0xd2: return [buf.readInt32BE(pos + 1), pos + 5];
    case 0xd3: return [Number(buf.readBigInt64BE(pos + 1)), pos + 9];
    case 0xd9: { const n = buf[pos + 1]; return [buf.toString('utf8', pos + 2, pos + 2 + n), pos + 2 + n]; }
    case 0xda: { const n = buf.readUInt16BE(pos + 1); return [buf.toString('utf8', pos + 3, pos + 3 + n), pos + 3 + n]; }
    case 0xdb: { const n = buf.readUInt32BE(pos + 1); return [buf.toString('utf8', pos + 5, pos + 5 + n), pos + 5 + n]; }
    case 0xdc: { const n = buf.readUInt16BE(pos + 1); return decodeArr(buf, pos + 3, n); }
    case 0xdd: { const n = buf.readUInt32BE(pos + 1); return decodeArr(buf, pos + 5, n); }
    case 0xde: { const n = buf.readUInt16BE(pos + 1); return decodeMap(buf, pos + 3, n); }
    case 0xdf: { const n = buf.readUInt32BE(pos + 1); return decodeMap(buf, pos + 5, n); }
    default: throw new Error(`unhandled byte 0x${b.toString(16)} at ${pos}`);
  }
}
function decodeArr(buf, pos, n) {
  const out = [];
  for (let i = 0; i < n; i++) { const [v, p] = decode(buf, pos); out.push(v); pos = p; }
  return [out, pos];
}
function decodeMap(buf, pos, n) {
  const out = {};
  for (let i = 0; i < n; i++) {
    const [k, p1] = decode(buf, pos);
    const [v, p2] = decode(buf, p1);
    out[k] = v; pos = p2;
  }
  return [out, pos];
}
function decodeExt(buf, pos, n) {
  const type = buf.readInt8(pos);
  const data = buf.subarray(pos + 1, pos + 1 + n);
  if (type === 98) { // LZ4Block: msgpack int (orig len) + lz4 data
    const [origLen, p] = decode(data, 0);
    const raw = lz4Decompress(data.subarray(p), origLen);
    const [v] = decode(raw, 0);
    return [v, pos + 1 + n];
  }
  return [{ ext: type, len: n }, pos + 1 + n];
}

// summarize structure without dumping megabytes
function summarize(v, depth = 0, maxDepth = 4) {
  if (v === null) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v);
  if (Array.isArray(v)) {
    if (depth >= maxDepth) return `array(${v.length})`;
    if (v.length > 6) return `array(${v.length})[ ${v.slice(0, 4).map(x => summarize(x, depth + 1, maxDepth)).join(', ')}, … ]`;
    return `array(${v.length})[ ${v.map(x => summarize(x, depth + 1, maxDepth)).join(', ')} ]`;
  }
  if (v.bin) return `bin(${v.bin.length})`;
  if (v.ext !== undefined) return `ext(${v.ext}, ${v.len})`;
  const keys = Object.keys(v);
  if (depth >= maxDepth) return `map{${keys.length}}`;
  return `map{ ${keys.slice(0, 12).map(k => `${k}: ${summarize(v[k], depth + 1, maxDepth)}`).join(', ')}${keys.length > 12 ? ', …' : ''} }`;
}

// LZ4BlockArray: top-level array [ext(sizes), bin, bin, ...]
function decodeRaw(buf, pos) { // like decode but leave ext raw
  const b = buf[pos];
  if (b === 0xc8) { const n = buf.readUInt16BE(pos + 1); return [{ ext: buf.readInt8(pos + 3), data: buf.subarray(pos + 4, pos + 4 + n) }, pos + 4 + n]; }
  if (b === 0xc7) { const n = buf[pos + 1]; return [{ ext: buf.readInt8(pos + 2), data: buf.subarray(pos + 3, pos + 3 + n) }, pos + 3 + n]; }
  return decode(buf, pos);
}

let top;
if (buf[0] === 0xdc || (buf[0] >= 0x90 && buf[0] <= 0x9f)) {
  // try LZ4BlockArray
  let n, pos;
  if (buf[0] === 0xdc) { n = buf.readUInt16BE(1); pos = 3; } else { n = buf[0] & 15; pos = 1; }
  const [first, p1] = decodeRaw(buf, pos);
  if (first && first.ext !== undefined) {
    console.log('LZ4BlockArray: ext type', first.ext, 'blocks:', n - 1);
    // ext data = msgpack ints: decompressed size per block
    const sizes = [];
    let sp = 0;
    while (sp < first.data.length) { const [v, p] = decode(first.data, sp); sizes.push(v); sp = p; }
    console.log('block sizes (decompressed):', sizes.length, 'total', sizes.reduce((a, b) => a + b, 0));
    pos = p1;
    const parts = [];
    for (let i = 0; i < n - 1; i++) {
      const [blk, p] = decode(buf, pos); pos = p;
      parts.push(lz4Decompress(blk.bin, sizes[i]));
    }
    const raw = Buffer.concat(parts);
    console.log('decompressed payload:', raw.length, 'bytes');
    [top] = decode(raw, 0);
  } else {
    [top] = decode(buf, 0);
  }
} else {
  [top] = decode(buf, 0);
}
if (Array.isArray(top)) {
  top.forEach((el, i) => console.log(`[${i}]`, summarize(el, 0, Number(process.argv[3] ?? 4))));
} else {
  console.log(summarize(top, 0, Number(process.argv[3] ?? 4)));
}
