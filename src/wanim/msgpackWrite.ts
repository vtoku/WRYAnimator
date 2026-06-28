/**
 * Minimal MessagePack encoder, the write-side counterpart to msgpack.ts. Covers
 * exactly what the .wanim writer needs: arrays, maps, ints, float32, strings,
 * and nil. Numbers in the recording are 32-bit floats, so float values are
 * always emitted as float32 to match Warudo's serializer byte-for-byte.
 */
export class MsgpackWriter {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  private u8(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  arrayHeader(n: number): void {
    if (n < 16) this.u8(0x90 | n);
    else if (n < 0x10000) { this.u8(0xdc); this.ensure(2); this.view.setUint16(this.pos, n); this.pos += 2; }
    else { this.u8(0xdd); this.ensure(4); this.view.setUint32(this.pos, n); this.pos += 4; }
  }

  mapHeader(n: number): void {
    if (n < 16) this.u8(0x80 | n);
    else if (n < 0x10000) { this.u8(0xde); this.ensure(2); this.view.setUint16(this.pos, n); this.pos += 2; }
    else { this.u8(0xdf); this.ensure(4); this.view.setUint32(this.pos, n); this.pos += 4; }
  }

  /** Non-negative integer (the writer never needs negatives). */
  uint(n: number): void {
    if (n < 0x80) this.u8(n);
    else if (n < 0x100) { this.u8(0xcc); this.u8(n); }
    else if (n < 0x10000) { this.u8(0xcd); this.ensure(2); this.view.setUint16(this.pos, n); this.pos += 2; }
    else { this.u8(0xce); this.ensure(4); this.view.setUint32(this.pos, n >>> 0); this.pos += 4; }
  }

  float32(x: number): void {
    this.u8(0xca);
    this.ensure(4);
    this.view.setFloat32(this.pos, x);
    this.pos += 4;
  }

  str(s: string): void {
    const bytes = new TextEncoder().encode(s);
    const n = bytes.length;
    if (n < 32) this.u8(0xa0 | n);
    else if (n < 0x100) { this.u8(0xd9); this.u8(n); }
    else if (n < 0x10000) { this.u8(0xda); this.ensure(2); this.view.setUint16(this.pos, n); this.pos += 2; }
    else { this.u8(0xdb); this.ensure(4); this.view.setUint32(this.pos, n); this.pos += 4; }
    this.ensure(n);
    this.buf.set(bytes, this.pos);
    this.pos += n;
  }

  nil(): void {
    this.u8(0xc0);
  }

  toBytes(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}
