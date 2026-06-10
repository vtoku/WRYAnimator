/**
 * Minimal MessagePack decoder covering the subset Warudo's serializer emits,
 * plus raw ext passthrough so the caller can handle LZ4 compression exts.
 */

export interface MsgpackExt {
  extType: number;
  data: Uint8Array;
}

export interface MsgpackBin {
  bin: Uint8Array;
}

export type MsgpackValue =
  | null
  | boolean
  | number
  | string
  | MsgpackValue[]
  | { [key: string]: MsgpackValue }
  | MsgpackExt
  | MsgpackBin;

export function isExt(v: MsgpackValue): v is MsgpackExt {
  return typeof v === "object" && v !== null && "extType" in v;
}

export function isBin(v: MsgpackValue): v is MsgpackBin {
  return typeof v === "object" && v !== null && "bin" in v;
}

const textDecoder = new TextDecoder();

export class MsgpackReader {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  decode(): MsgpackValue {
    const b = this.buf[this.pos++];
    if (b < 0x80) return b;
    if (b >= 0xe0) return b - 256;
    if (b <= 0x8f) return this.map(b & 15);
    if (b <= 0x9f) return this.array(b & 15);
    if (b <= 0xbf) return this.str(b & 31);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.binValue(this.u8());
      case 0xc5: return this.binValue(this.u16());
      case 0xc6: return this.binValue(this.u32());
      case 0xc7: return this.ext(this.u8());
      case 0xc8: return this.ext(this.u16());
      case 0xc9: return this.ext(this.u32());
      case 0xca: { const v = this.view.getFloat32(this.pos); this.pos += 4; return v; }
      case 0xcb: { const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }
      case 0xcc: return this.u8();
      case 0xcd: return this.u16();
      case 0xce: return this.u32();
      case 0xcf: { const v = this.view.getBigUint64(this.pos); this.pos += 8; return Number(v); }
      case 0xd0: { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
      case 0xd1: { const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
      case 0xd2: { const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
      case 0xd3: { const v = this.view.getBigInt64(this.pos); this.pos += 8; return Number(v); }
      case 0xd9: return this.str(this.u8());
      case 0xda: return this.str(this.u16());
      case 0xdb: return this.str(this.u32());
      case 0xdc: return this.array(this.u16());
      case 0xdd: return this.array(this.u32());
      case 0xde: return this.map(this.u16());
      case 0xdf: return this.map(this.u32());
      default:
        throw new Error(`msgpack: unhandled byte 0x${b.toString(16)} at ${this.pos - 1}`);
    }
  }

  private u8(): number {
    return this.buf[this.pos++];
  }

  private u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  private u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  private str(len: number): string {
    const v = textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return v;
  }

  private binValue(len: number): MsgpackBin {
    const v = { bin: this.buf.subarray(this.pos, this.pos + len) };
    this.pos += len;
    return v;
  }

  private ext(len: number): MsgpackExt {
    const extType = this.view.getInt8(this.pos);
    this.pos += 1;
    const data = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return { extType, data };
  }

  private array(n: number): MsgpackValue[] {
    const out: MsgpackValue[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.decode();
    return out;
  }

  private map(n: number): { [key: string]: MsgpackValue } {
    const out: { [key: string]: MsgpackValue } = {};
    for (let i = 0; i < n; i++) {
      const k = this.decode();
      out[String(k)] = this.decode();
    }
    return out;
  }
}
