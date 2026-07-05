/** Decompress a raw LZ4 block (the block format, not the LZ4 frame format). */
/**
 * Encode bytes as a VALID LZ4 block using literals only (one sequence, no
 * matches). Slightly larger than the input, but every standard LZ4 decoder —
 * including MessagePack-C#'s — accepts it, which lets the .wanim writer emit
 * a true LZ4BlockArray container matching Warudo's own files.
 */
export function lz4CompressBlockLiteral(src: Uint8Array): Uint8Array {
  const L = src.length;
  const out = new Uint8Array(L + Math.ceil(L / 255) + 16);
  let o = 0;
  out[o++] = Math.min(L, 15) << 4;
  if (L >= 15) {
    let rem = L - 15;
    while (rem >= 255) { out[o++] = 255; rem -= 255; }
    out[o++] = rem;
  }
  out.set(src, o);
  o += L;
  return out.subarray(0, o);
}

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
