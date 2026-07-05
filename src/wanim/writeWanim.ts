import { MsgpackWriter } from "./msgpackWrite.ts";
import { lz4CompressBlockLiteral } from "./lz4.ts";
import type { WanimClip } from "./parse.ts";
import type { ResampledClip } from "../convert/clip.ts";

/**
 * Write a (cleaned, resampled) clip back out as a Warudo `.wanim` file, so the
 * cleaning / spine / trim changes can be taken back into Warudo.
 *
 * This inverts convert/clip.ts:convertCharacter:
 *  - the X-mirror and quaternion y/z-negation are their own inverses, so we
 *    re-apply them to return to Unity's left-handed space;
 *  - convertCharacter baked the character root into the hips, so we write an
 *    identity root (zeros / identity quat) and let the hips carry everything,
 *    which Warudo reconstructs as root ∘ hipsLocal = the same world motion.
 *
 * The payload is wrapped in MessagePack-C#'s LZ4BlockArray container (same
 * as Warudo's own files) using literal-only LZ4 blocks — valid for any
 * standard decoder, and container-identical so strict readers can't tell the
 * difference.
 *
 * Fields 7-9 are unknown and empty in every recording observed, so they are
 * written as empties at the new frame count.
 */
export function writeWanim(c: ResampledClip, template?: WanimClip): Uint8Array {
  const w = new MsgpackWriter();
  const F = c.frameCount;
  const B = c.names.length;
  const setName = blendshapeSetName(template);

  w.arrayHeader(10);

  // 0: format version
  w.uint(template?.version ?? 2);

  // 1: timestamps (rebased to t=0 at the resampled rate)
  w.arrayHeader(F);
  for (let i = 0; i < F; i++) w.float32(i / c.fps);

  // 2: bone local positions [characters][frames][bones][3] (un-mirror X)
  w.arrayHeader(1);
  w.arrayHeader(F);
  for (let i = 0; i < F; i++) {
    w.arrayHeader(B);
    for (let b = 0; b < B; b++) {
      const p = c.localPos[b][i];
      w.arrayHeader(3);
      w.float32(-p[0]); w.float32(p[1]); w.float32(p[2]);
    }
  }

  // 3: bone local rotations [characters][frames][bones][4] (un-negate y, z)
  w.arrayHeader(1);
  w.arrayHeader(F);
  for (let i = 0; i < F; i++) {
    w.arrayHeader(B);
    for (let b = 0; b < B; b++) {
      const q = c.localQuat[b][i];
      w.arrayHeader(4);
      w.float32(q[0]); w.float32(-q[1]); w.float32(-q[2]); w.float32(q[3]);
    }
  }

  // 4: blendshapes [characters] -> { setName: [frames] -> { name: value } }
  w.arrayHeader(1);
  if (c.face && c.face.names.length) {
    w.mapHeader(1);
    w.str(setName);
    w.arrayHeader(F);
    for (let i = 0; i < F; i++) {
      w.mapHeader(c.face.names.length);
      for (let n = 0; n < c.face.names.length; n++) {
        w.str(c.face.names[n]);
        w.float32(c.face.tracks[n][i]);
      }
    }
  } else {
    w.mapHeader(0);
  }

  // 5: character root positions [characters][frames][3] = zeros (baked into hips)
  w.arrayHeader(1);
  w.arrayHeader(F);
  for (let i = 0; i < F; i++) { w.arrayHeader(3); w.float32(0); w.float32(0); w.float32(0); }

  // 6: character root rotations [characters][frames][4] = identity
  w.arrayHeader(1);
  w.arrayHeader(F);
  for (let i = 0; i < F; i++) { w.arrayHeader(4); w.float32(0); w.float32(0); w.float32(0); w.float32(1); }

  // 7: per-frame extras (empty in every observed recording)
  w.arrayHeader(1);
  w.arrayHeader(F);
  for (let i = 0; i < F; i++) w.arrayHeader(0);

  // 8, 9: unknown, empty in every observed recording
  w.arrayHeader(0);
  w.arrayHeader(0);

  return wrapLz4BlockArray(w.toBytes());
}

/**
 * Wrap a raw msgpack payload in MessagePack-C#'s LZ4BlockArray container —
 * the same shape Warudo writes: [ext98(sizes as msgpack ints), bin, bin...].
 * Blocks are literal-only LZ4 (valid for any standard decoder). Emitted so
 * our files are container-identical to Warudo's own recordings.
 */
function wrapLz4BlockArray(payload: Uint8Array): Uint8Array {
  const BLOCK = 1 << 20;
  const blocks: Uint8Array[] = [];
  const sizes = new MsgpackWriter();
  for (let off = 0; off < payload.length; off += BLOCK) {
    const chunk = payload.subarray(off, Math.min(off + BLOCK, payload.length));
    sizes.uint(chunk.length);
    blocks.push(lz4CompressBlockLiteral(chunk));
  }
  const w = new MsgpackWriter();
  w.arrayHeader(blocks.length + 1);
  w.ext(98, sizes.toBytes());
  for (const b of blocks) w.bin(b);
  return w.toBytes();
}

/** Reuse the recording's own blendshape set name (e.g. "__VRM__") if present. */
function blendshapeSetName(template?: WanimClip): string {
  const keys = template?.characters?.[0]?.blendshapes;
  if (keys) {
    const names = Object.keys(keys);
    if (names.length) return names[0];
  }
  return "__VRM__";
}
