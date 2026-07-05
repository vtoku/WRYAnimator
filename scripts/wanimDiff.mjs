// Byte/type-level comparison of an ORIGINAL .wanim payload vs OUR re-export,
// focused on field 4 (blendshapes) — Warudo's motion player may care about
// msgpack FORMAT bytes (float32 vs float64, fixmap vs map16, fixstr vs str8)
// even where the decoded values are identical.
// Usage: node scripts/wanimDiff.mjs [file.wanim]
import { readFileSync } from "node:fs";
const { parseWanim } = await import("../src/wanim/parse.ts");
const { convertCharacter, resample } = await import("../src/convert/clip.ts");
const { writeWanim } = await import("../src/wanim/writeWanim.ts");

const path = process.argv[2] ?? "C:\\Users\\VTOKU\\Downloads\\All-The-Things-2-2026-05-24-18-55-10.wanim";
const buf = readFileSync(path);
const origFile = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

// ---- minimal msgpack walker that reports FORMAT bytes -------------------------
function walker(bytes) {
  let o = 0;
  const u8 = bytes;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  function fmtName(b) {
    if (b <= 0x7f) return "fixint";
    if (b >= 0x80 && b <= 0x8f) return "fixmap";
    if (b >= 0x90 && b <= 0x9f) return "fixarray";
    if (b >= 0xa0 && b <= 0xbf) return "fixstr";
    if (b >= 0xe0) return "negfixint";
    return {
      0xc0: "nil", 0xc2: "false", 0xc3: "true",
      0xc4: "bin8", 0xc5: "bin16", 0xc6: "bin32",
      0xc7: "ext8", 0xc8: "ext16", 0xc9: "ext32",
      0xca: "float32", 0xcb: "float64",
      0xcc: "uint8", 0xcd: "uint16", 0xce: "uint32", 0xcf: "uint64",
      0xd0: "int8", 0xd1: "int16", 0xd2: "int32", 0xd3: "int64",
      0xd4: "fixext1", 0xd5: "fixext2", 0xd6: "fixext4", 0xd7: "fixext8", 0xd8: "fixext16",
      0xd9: "str8", 0xda: "str16", 0xdb: "str32",
      0xdc: "array16", 0xdd: "array32",
      0xde: "map16", 0xdf: "map32",
    }[b] ?? `0x${b.toString(16)}`;
  }
  function head() {
    return { byte: u8[o], name: fmtName(u8[o]) };
  }
  function skip() {
    const b = u8[o];
    if (b <= 0x7f || b >= 0xe0) { o += 1; return; }
    if (b >= 0x80 && b <= 0x8f) { o += 1; const n = b & 0xf; for (let i = 0; i < n * 2; i++) skip(); return; }
    if (b >= 0x90 && b <= 0x9f) { o += 1; const n = b & 0xf; for (let i = 0; i < n; i++) skip(); return; }
    if (b >= 0xa0 && b <= 0xbf) { o += 1 + (b & 0x1f); return; }
    switch (b) {
      case 0xc0: case 0xc2: case 0xc3: o += 1; return;
      case 0xc4: o += 2 + u8[o + 1]; return;
      case 0xc5: o += 3 + dv.getUint16(o + 1); return;
      case 0xc6: o += 5 + dv.getUint32(o + 1); return;
      case 0xc7: o += 3 + u8[o + 1]; return;
      case 0xc8: o += 4 + dv.getUint16(o + 1); return;
      case 0xc9: o += 6 + dv.getUint32(o + 1); return;
      case 0xca: o += 5; return;
      case 0xcb: o += 9; return;
      case 0xcc: o += 2; return; case 0xcd: o += 3; return; case 0xce: o += 5; return; case 0xcf: o += 9; return;
      case 0xd0: o += 2; return; case 0xd1: o += 3; return; case 0xd2: o += 5; return; case 0xd3: o += 9; return;
      case 0xd4: o += 3; return; case 0xd5: o += 4; return; case 0xd6: o += 6; return; case 0xd7: o += 10; return; case 0xd8: o += 18; return;
      case 0xd9: o += 2 + u8[o + 1]; return;
      case 0xda: o += 3 + dv.getUint16(o + 1); return;
      case 0xdb: o += 5 + dv.getUint32(o + 1); return;
      case 0xdc: { const n = dv.getUint16(o + 1); o += 3; for (let i = 0; i < n; i++) skip(); return; }
      case 0xdd: { const n = dv.getUint32(o + 1); o += 5; for (let i = 0; i < n; i++) skip(); return; }
      case 0xde: { const n = dv.getUint16(o + 1); o += 3; for (let i = 0; i < n * 2; i++) skip(); return; }
      case 0xdf: { const n = dv.getUint32(o + 1); o += 5; for (let i = 0; i < n * 2; i++) skip(); return; }
      default: throw new Error(`unknown msgpack byte 0x${b.toString(16)} at ${o}`);
    }
  }
  function arrayLen() {
    const b = u8[o];
    if (b >= 0x90 && b <= 0x9f) { o += 1; return b & 0xf; }
    if (b === 0xdc) { const n = dv.getUint16(o + 1); o += 3; return n; }
    if (b === 0xdd) { const n = dv.getUint32(o + 1); o += 5; return n; }
    throw new Error(`not an array at ${o}: 0x${b.toString(16)}`);
  }
  function mapLen() {
    const b = u8[o];
    if (b >= 0x80 && b <= 0x8f) { o += 1; return b & 0xf; }
    if (b === 0xde) { const n = dv.getUint16(o + 1); o += 3; return n; }
    if (b === 0xdf) { const n = dv.getUint32(o + 1); o += 5; return n; }
    throw new Error(`not a map at ${o}: 0x${b.toString(16)}`);
  }
  return { head, skip, arrayLen, mapLen, pos: () => o };
}

// Decompress the ORIGINAL to its raw payload bytes (reuse the app's LZ4 path
// indirectly: parse.ts doesn't export the raw payload, so re-derive with the
// standalone approach used by inspectWanim: if the top level is NOT ext-headed
// (uncompressed), take as-is; else decode blocks with the app's lz4).
async function rawPayload(fileBytes) {
  // Mirror parse.ts decompressPayload exactly.
  const { lz4DecompressBlock } = await import("../src/wanim/lz4.ts");
  const { MsgpackReader, isExt, isBin } = await import("../src/wanim/msgpack.ts");
  const head = fileBytes[0];
  const isArrayHead = head === 0xdc || head === 0xdd || (head >= 0x90 && head <= 0x9f);
  if (!isArrayHead) return fileBytes;
  const top = new MsgpackReader(fileBytes).decode();
  if (Array.isArray(top) && top.length >= 2 && isExt(top[0]) && top[0].extType === 98) {
    const sizeReader = new MsgpackReader(top[0].data);
    const sizes = [];
    while (sizeReader.remaining > 0) sizes.push(Number(sizeReader.decode()));
    const blocks = top.slice(1);
    const total = sizes.reduce((a, b) => a + b, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      if (!isBin(blk)) throw new Error("block not bin");
      out.set(lz4DecompressBlock(blk.bin, sizes[i]), offset);
      offset += sizes[i];
    }
    return out;
  }
  return fileBytes;
}

function describeField4(bytes, label) {
  const w = walker(bytes);
  const top = w.arrayLen();
  if (top !== 10) console.log(`${label}: top-level array has ${top} fields (expected 10)`);
  // skip fields 0..3
  for (let i = 0; i < 4; i++) w.skip();
  const out = { label };
  out.charsHeader = w.head().name;
  const chars = w.arrayLen();
  out.chars = chars;
  out.setsHeader = w.head().name;
  const sets = w.mapLen();
  out.sets = sets;
  if (sets > 0) {
    out.setNameFmt = w.head().name;
    w.skip(); // set name
    out.framesHeader = w.head().name;
    const frames = w.arrayLen();
    out.frames = frames;
    out.frameMapFmt = w.head().name;
    const entries = w.mapLen();
    out.frameEntries = entries;
    if (entries > 0) {
      out.keyFmt = w.head().name;
      w.skip();
      out.valueFmt = w.head().name;
    }
  }
  return out;
}

const orig = await rawPayload(origFile);
const clipParsed = parseWanim(origFile.buffer.slice(origFile.byteOffset, origFile.byteOffset + origFile.byteLength));
const conv = convertCharacter(clipParsed, 0);
const rs = resample(conv, 60, 0, conv.duration);
const ours = await rawPayload(writeWanim(rs, clipParsed));

const a = describeField4(orig, "original");
const b = describeField4(ours, "ours");
console.log(JSON.stringify(a, null, 1));
console.log(JSON.stringify(b, null, 1));
console.log("\nDIFFS:");
for (const k of Object.keys(a)) {
  if (k !== "label" && String(a[k]) !== String(b[k]) && !["frames"].includes(k)) {
    console.log(`  ${k}: original=${a[k]}  ours=${b[k]}`);
  }
}

// Also compare the OTHER headers quickly (fields 0-3, 5-9 format bytes).
function fieldHeads(bytes, label) {
  const w = walker(bytes);
  w.arrayLen();
  const heads = [];
  for (let i = 0; i < 10; i++) {
    heads.push(w.head().name);
    w.skip();
  }
  console.log(label, "field header formats:", heads.join(", "));
}
fieldHeads(orig, "original");
fieldHeads(ours, "ours    ");
