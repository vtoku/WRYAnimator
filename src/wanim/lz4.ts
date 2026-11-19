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

/**
 * Real LZ4 block compression (greedy, single hash probe — the reference
 * "fast" scheme). Output is a standard LZ4 block: offsets ≤ 65535, the last 5
 * bytes are literals and no match starts within the last 12 bytes. Used by the
 * timing-exact .wanim writer so its files stay near the size of Warudo's own.
 */
export function lz4CompressBlock(src: Uint8Array): Uint8Array {
  const n = src.length;
  if (n < 13) return lz4CompressBlockLiteral(src);
  const out = new Uint8Array(n + Math.ceil(n / 255) + 16);
  const table = new Int32Array(1 << 16).fill(-1);
  const mfLimit = n - 12;
  const matchLimit = n - 5;
  let o = 0;
  let anchor = 0;
  let i = 0;
  const writeLen = (len: number): void => {
    let rem = len;
    while (rem >= 255) { out[o++] = 255; rem -= 255; }
    out[o++] = rem;
  };
  while (i < mfLimit) {
    const seq = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
    const h = Math.imul(seq, 2654435761) >>> 16;
    const ref = table[h];
    table[h] = i;
    if (
      ref < 0 || i - ref > 65535 ||
      src[ref] !== src[i] || src[ref + 1] !== src[i + 1] || src[ref + 2] !== src[i + 2] || src[ref + 3] !== src[i + 3]
    ) {
      i++;
      continue;
    }
    let ml = 4;
    while (i + ml < matchLimit && src[ref + ml] === src[i + ml]) ml++;
    const lit = i - anchor;
    const token = o++;
    out[token] = (Math.min(lit, 15) << 4) | Math.min(ml - 4, 15);
    if (lit >= 15) writeLen(lit - 15);
    out.set(src.subarray(anchor, i), o);
    o += lit;
    const offset = i - ref;
    out[o++] = offset & 0xff;
    out[o++] = offset >> 8;
    if (ml - 4 >= 15) writeLen(ml - 4 - 15);
    i += ml;
    anchor = i;
  }
  const lit = n - anchor;
  out[o++] = Math.min(lit, 15) << 4;
  if (lit >= 15) writeLen(lit - 15);
  out.set(src.subarray(anchor, n), o);
  o += lit;
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
