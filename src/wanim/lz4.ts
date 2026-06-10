/** Decompress a raw LZ4 block (the block format, not the LZ4 frame format). */
export function lz4DecompressBlock(src: Uint8Array, dstLen: number): Uint8Array {
  const dst = new Uint8Array(dstLen);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++];
    let litLen = token >> 4;
    if (litLen === 15) {
      let b: number;
      do {
        b = src[s++];
        litLen += b;
      } while (b === 255);
    }
    dst.set(src.subarray(s, s + litLen), d);
    s += litLen;
    d += litLen;
    if (s >= src.length) break;
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    let matchLen = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b: number;
      do {
        b = src[s++];
        matchLen += b;
      } while (b === 255);
    }
    // Matches may overlap the bytes being written; copy byte-by-byte.
    let m = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++];
  }
  return dst.subarray(0, d);
}
