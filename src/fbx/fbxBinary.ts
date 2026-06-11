// Binary FBX 7.5 (7500) serializer. MotionBuilder 2018+ dropped ASCII FBX
// import, so binary is required; 7500 also clears the "legacy file" warning.
// Format: 64-bit node records (uint64 EndOffset/NumProps/PropertyListLen),
// 25-byte null terminators, and the fixed assimp-style footer (whose footer
// code is a constant, not a hash — assimp's output imports into MotionBuilder).

export type FbxProp =
  | { t: "Y"; v: number } // int16
  | { t: "C"; v: boolean } // bool
  | { t: "I"; v: number } // int32
  | { t: "F"; v: number } // float32
  | { t: "D"; v: number } // float64
  | { t: "L"; v: number } // int64
  | { t: "S"; v: string } // string
  | { t: "R"; v: Uint8Array } // raw bytes
  | { t: "i"; v: Int32Array } // int32 array
  | { t: "l"; v: Float64Array | number[] } // int64 array (values fit in double)
  | { t: "f"; v: Float32Array } // float32 array
  | { t: "d"; v: Float64Array }; // float64 array

export interface FbxNode {
  name: string;
  props: FbxProp[];
  children: FbxNode[];
}

export const node = (name: string, props: FbxProp[] = [], children: FbxNode[] = []): FbxNode => ({
  name,
  props,
  children,
});

// Property constructors.
export const I = (v: number): FbxProp => ({ t: "I", v });
export const L = (v: number): FbxProp => ({ t: "L", v });
export const D = (v: number): FbxProp => ({ t: "D", v });
export const F = (v: number): FbxProp => ({ t: "F", v });
export const Y = (v: number): FbxProp => ({ t: "Y", v });
export const C = (v: boolean): FbxProp => ({ t: "C", v });
export const S = (v: string): FbxProp => ({ t: "S", v });
export const aI = (v: Int32Array): FbxProp => ({ t: "i", v });
export const aL = (v: number[] | Float64Array): FbxProp => ({ t: "l", v });
export const aF = (v: Float32Array): FbxProp => ({ t: "f", v });
export const aD = (v: Float64Array): FbxProp => ({ t: "d", v });

// Object name property for BINARY FBX: `name<0x00><0x01>class` (NOT the ASCII
// `class::name`). FBXLoader / the FBX SDK split on the 0x00,0x01 separator and
// truncate the readable name at the first null byte; encoding this wrong
// silently loses the name/class (e.g. AnimationCurveNode channel tags R/T,
// which then yields zero animation tracks).
const SEP = String.fromCharCode(0, 1);
export const objName = (name: string, cls: string): string => name + SEP + cls;

class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  len = 0;

  constructor(initial = 1 << 20) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number) { this.ensure(1); this.view.setUint8(this.len, v); this.len += 1; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.len, v, true); this.len += 2; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.len, v, true); this.len += 2; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.len, v, true); this.len += 4; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.len, v, true); this.len += 4; }
  f32(v: number) { this.ensure(4); this.view.setFloat32(this.len, v, true); this.len += 4; }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.len, v, true); this.len += 8; }
  /** 64-bit unsigned, values < 2^53 (safe for offsets/counts/ktimes). */
  u64(v: number) {
    this.ensure(8);
    this.view.setUint32(this.len, v >>> 0, true);
    this.view.setUint32(this.len + 4, Math.floor(v / 0x100000000), true);
    this.len += 8;
  }
  i64(v: number) { this.u64(v); }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  ascii(s: string) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  zeros(n: number) { this.ensure(n); this.len += n; }
  patchU64(pos: number, v: number) {
    this.view.setUint32(pos, v >>> 0, true);
    this.view.setUint32(pos + 4, Math.floor(v / 0x100000000), true);
  }
  patchU32(pos: number, v: number) { this.view.setUint32(pos, v >>> 0, true); }
  result(): Uint8Array { return this.buf.subarray(0, this.len); }
}

const utf8 = new TextEncoder();

function writeProp(w: ByteWriter, p: FbxProp) {
  switch (p.t) {
    case "Y": w.ascii("Y"); w.i16(p.v); break;
    case "C": w.ascii("C"); w.u8(p.v ? 1 : 0); break;
    case "I": w.ascii("I"); w.i32(p.v); break;
    case "F": w.ascii("F"); w.f32(p.v); break;
    case "D": w.ascii("D"); w.f64(p.v); break;
    case "L": w.ascii("L"); w.i64(p.v); break;
    case "S": { w.ascii("S"); const b = utf8.encode(p.v); w.u32(b.length); w.bytes(b); break; }
    case "R": { w.ascii("R"); w.u32(p.v.length); w.bytes(p.v); break; }
    case "i": writeArray(w, "i", p.v.length, (aw) => { for (const x of p.v) aw.i32(x); }); break;
    case "f": writeArray(w, "f", p.v.length, (aw) => { for (const x of p.v) aw.f32(x); }); break;
    case "d": writeArray(w, "d", p.v.length, (aw) => { for (const x of p.v) aw.f64(x); }); break;
    case "l": writeArray(w, "l", p.v.length, (aw) => { for (const x of p.v) aw.i64(x); }); break;
  }
}

// Array property: type char, ArrayLength u32, Encoding u32 (0=raw), CompressedLength u32, data.
function writeArray(w: ByteWriter, type: string, count: number, emit: (w: ByteWriter) => void) {
  w.ascii(type);
  w.u32(count);
  w.u32(0); // encoding: uncompressed
  const lenPos = w.len;
  w.u32(0); // CompressedLength placeholder
  const start = w.len;
  emit(w);
  w.patchU32(lenPos, w.len - start);
}

const NULL_RECORD_LEN = 25; // 7500: u64 + u64 + u64 + u8

function writeNode(w: ByteWriter, n: FbxNode) {
  const endOffsetPos = w.len;
  w.u64(0); // EndOffset placeholder
  w.u64(n.props.length);
  const propLenPos = w.len;
  w.u64(0); // PropertyListLen placeholder
  const nameBytes = utf8.encode(n.name);
  w.u8(nameBytes.length);
  w.bytes(nameBytes);

  const propStart = w.len;
  for (const p of n.props) writeProp(w, p);
  w.patchU64(propLenPos, w.len - propStart);

  if (n.children.length > 0) {
    for (const c of n.children) writeNode(w, c);
    w.zeros(NULL_RECORD_LEN);
  }
  w.patchU64(endOffsetPos, w.len);
}

const FOOT_ID = new Uint8Array([
  0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e,
]);
const FOOT_MAGIC = new Uint8Array([
  0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b,
]);

export function serializeFbxBinary(top: FbxNode[], version = 7500): Uint8Array {
  const w = new ByteWriter();
  // Header: "Kaydara FBX Binary  \x00\x1a\x00" (23 bytes) + version u32.
  w.ascii("Kaydara FBX Binary  ");
  w.u8(0x00); w.u8(0x1a); w.u8(0x00);
  w.u32(version);

  for (const n of top) writeNode(w, n);
  w.zeros(NULL_RECORD_LEN); // top-level list terminator

  // Footer (assimp layout).
  w.bytes(FOOT_ID);
  const pad = 16 - (w.len % 16); // 1..16
  w.zeros(pad);
  w.zeros(4);
  w.u32(version);
  w.zeros(120);
  w.bytes(FOOT_MAGIC);

  return w.result().slice();
}
