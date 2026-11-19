// Timing-exact .wanim export ("preserveTiming").
//
// writeWanim.ts rebuilds the file from a RESAMPLED clip: new frame count, new
// float32 timestamps, every value re-derived. That breaks takes that are
// already synced to music / lip-sync. This writer does the opposite: it takes
// the ORIGINAL decompressed payload and overwrites only the (bone, frame)
// cells an edit actually changed, in place. Everything else — timestamps
// (float64, original start), untouched bones, root tracks, blendshapes,
// fields 7-9, every msgpack header — is the source's own bytes.
//
// Pure TS (no DOM / node:), strip-types safe.
import { MsgpackReader, isExt, isBin } from "./msgpack.ts";
import { MsgpackWriter } from "./msgpackWrite.ts";
import { lz4CompressBlock, lz4CompressBlockLiteral, lz4DecompressBlock } from "./lz4.ts";
import { decompressPayload, type WanimClip, type Quat, type Vec3 } from "./parse.ts";
import type { ConvertedClip } from "../convert/clip.ts";
import { quatMul, quatRotate, quatNormalize } from "../convert/quat.ts";

/** Below this an edited cell counts as untouched and keeps its original bits. */
export const DIRTY_ROT_RAD = 1e-6;
export const DIRTY_POS_M = 1e-7;

// ---- locating cells in the payload --------------------------------------------

/** Minimal msgpack cursor that can skip values and report byte offsets. */
class Cursor {
  buf: Uint8Array;
  view: DataView;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  arrayLen(what: string): number {
    const b = this.buf[this.pos++];
    if (b >= 0x90 && b <= 0x9f) return b & 15;
    if (b === 0xdc) { const n = this.view.getUint16(this.pos); this.pos += 2; return n; }
    if (b === 0xdd) { const n = this.view.getUint32(this.pos); this.pos += 4; return n; }
    throw new Error(`wanim: expected an array for ${what} at byte ${this.pos - 1} (found 0x${b.toString(16)})`);
  }

  skip(): void {
    const b = this.buf[this.pos++];
    if (b < 0x80 || b >= 0xe0) return;
    if (b <= 0x8f) { this.skipN((b & 15) * 2); return; }
    if (b <= 0x9f) { this.skipN(b & 15); return; }
    if (b <= 0xbf) { this.pos += b & 31; return; }
    switch (b) {
      case 0xc0: case 0xc2: case 0xc3: return;
      case 0xc4: this.pos += 1 + this.buf[this.pos]; return;
      case 0xc5: this.pos += 2 + this.view.getUint16(this.pos); return;
      case 0xc6: this.pos += 4 + this.view.getUint32(this.pos); return;
      case 0xc7: this.pos += 2 + this.buf[this.pos]; return;
      case 0xc8: this.pos += 3 + this.view.getUint16(this.pos); return;
      case 0xc9: this.pos += 5 + this.view.getUint32(this.pos); return;
      case 0xca: this.pos += 4; return;
      case 0xcb: this.pos += 8; return;
      case 0xcc: case 0xd0: this.pos += 1; return;
      case 0xcd: case 0xd1: this.pos += 2; return;
      case 0xce: case 0xd2: this.pos += 4; return;
      case 0xcf: case 0xd3: this.pos += 8; return;
      case 0xd9: this.pos += 1 + this.buf[this.pos]; return;
      case 0xda: this.pos += 2 + this.view.getUint16(this.pos); return;
      case 0xdb: this.pos += 4 + this.view.getUint32(this.pos); return;
      case 0xdc: { const n = this.view.getUint16(this.pos); this.pos += 2; this.skipN(n); return; }
      case 0xdd: { const n = this.view.getUint32(this.pos); this.pos += 4; this.skipN(n); return; }
      case 0xde: { const n = this.view.getUint16(this.pos); this.pos += 2; this.skipN(n * 2); return; }
      case 0xdf: { const n = this.view.getUint32(this.pos); this.pos += 4; this.skipN(n * 2); return; }
      default: throw new Error(`wanim: unhandled msgpack byte 0x${b.toString(16)} at ${this.pos - 1}`);
    }
  }

  private skipN(n: number): void {
    for (let i = 0; i < n; i++) this.skip();
  }
}

interface CellMap {
  frames: number;
  bones: number;
  /** Byte offset of each cell's first component: [frame * bones + bone]. */
  posOff: Float64Array;
  quatOff: Float64Array;
}

/** Walk fields 2 and 3 of the payload, recording where one character's cells live. */
function locateCells(payload: Uint8Array, character: number): CellMap {
  const c = new Cursor(payload);
  const fields = c.arrayLen("payload");
  if (fields < 7) throw new Error("wanim: payload is not the expected 10-field array");
  c.skip(); // 0: version
  c.skip(); // 1: timestamps
  let frames = 0;
  let bones = 0;
  const walk = (comps: number, what: string): Float64Array => {
    let out: Float64Array | null = null;
    const chars = c.arrayLen(what);
    if (character >= chars) throw new Error(`wanim: character ${character} not present`);
    for (let ch = 0; ch < chars; ch++) {
      if (ch !== character) { c.skip(); continue; }
      const F = c.arrayLen(`${what} frames`);
      for (let f = 0; f < F; f++) {
        const B = c.arrayLen(`${what} bones`);
        if (!out) { frames = F; bones = B; out = new Float64Array(F * B); }
        if (B !== bones) throw new Error(`wanim: bone count changes at frame ${f}`);
        for (let b = 0; b < B; b++) {
          const n = c.arrayLen(`${what} cell`);
          if (n !== comps) throw new Error(`wanim: ${what} cell has ${n} components, expected ${comps}`);
          out[f * B + b] = c.pos;
          for (let k = 0; k < n; k++) c.skip();
        }
      }
    }
    return out ?? new Float64Array(0);
  };
  const posOff = walk(3, "positions");
  const quatOff = walk(4, "rotations");
  return { frames, bones, posOff, quatOff };
}

/** Overwrite a cell's components in place, in whatever float width the source used. */
function writeCell(payload: Uint8Array, view: DataView, offset: number, values: number[]): void {
  let p = offset;
  for (const v of values) {
    const tag = payload[p];
    if (tag === 0xca) { view.setFloat32(p + 1, v); p += 5; }
    else if (tag === 0xcb) { view.setFloat64(p + 1, v); p += 9; }
    else throw new Error(`wanim: cell at byte ${p} is not a float (0x${tag.toString(16)}) — cannot patch in place`);
  }
}

// ---- container ----------------------------------------------------------------

/**
 * Re-wrap a payload in the source's own LZ4BlockArray framing: same block
 * boundaries and the size table copied byte-for-byte (patching never changes
 * the payload length). Falls back to 1 MiB blocks for other containers.
 */
function rewrap(source: Uint8Array, payload: Uint8Array, compress: (b: Uint8Array) => Uint8Array): Uint8Array {
  let sizes: number[] | null = null;
  let sizeTable: Uint8Array | null = null;
  const head = source[0];
  if (head === 0xdc || head === 0xdd || (head >= 0x90 && head <= 0x9f)) {
    const top = new MsgpackReader(source).decode();
    if (Array.isArray(top) && top.length >= 2 && isExt(top[0]) && top[0].extType === 98 && top.slice(1).every((b) => isBin(b))) {
      const r = new MsgpackReader(top[0].data);
      const s: number[] = [];
      while (r.remaining > 0) s.push(Number(r.decode()));
      if (s.reduce((a, b) => a + b, 0) === payload.length) { sizes = s; sizeTable = top[0].data; }
    }
  }
  if (!sizes) {
    const BLOCK = 1 << 20;
    sizes = [];
    const t = new MsgpackWriter();
    for (let off = 0; off < payload.length; off += BLOCK) {
      const n = Math.min(BLOCK, payload.length - off);
      sizes.push(n);
      t.uint(n);
    }
    sizeTable = t.toBytes().slice();
  }
  const w = new MsgpackWriter();
  w.arrayHeader(sizes.length + 1);
  w.ext(98, sizeTable!);
  let off = 0;
  for (const n of sizes) {
    w.bin(compress(payload.subarray(off, off + n)));
    off += n;
  }
  return w.toBytes().slice();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- the export ---------------------------------------------------------------

export interface ExactBoneChange {
  bone: number;
  name: string;
  frames: number;
  frameStart: number;
  frameEnd: number;
  /** Largest rotation change written for this bone, degrees. */
  maxDeg: number;
  /** Hips only: largest position change written, cm. */
  maxPosCm?: number;
}

export interface ExactExportReport {
  frames: number;
  /** True when nothing was edited: the output IS the source file, byte for byte. */
  identicalToSource: boolean;
  cellsChanged: number;
  /** Union of every changed frame, or null when nothing changed. */
  frameStart: number | null;
  frameEnd: number | null;
  bones: ExactBoneChange[];
}

const angleRad = (a: Quat, b: Quat): number =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
/** convert/clip.ts's Unity-LH ⇄ RH mirror; each is its own inverse. */
const flipQuat = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];
const flipPos = (p: Vec3): Vec3 => [-p[0], p[1], p[2]];

/**
 * Write `edited` back over the original recording, changing only the cells
 * where it differs from `base` (the unedited convertCharacter() result).
 *
 * `base` and `edited` must share the source's frames exactly — no resample, no
 * time warp. Only rotations (any bone) and the hips position can be written.
 */
export function exportWanimExact(
  source: Uint8Array,
  raw: WanimClip,
  character: number,
  base: ConvertedClip,
  edited: ConvertedClip,
): { bytes: Uint8Array; report: ExactExportReport } {
  const ch = raw.characters[character];
  if (!ch) throw new Error(`wanim: character ${character} not present`);
  const F = raw.times.length;
  if (edited.times.length !== F || base.times.length !== F) {
    throw new Error(
      `timing-exact export needs the source's own frames (${F}), but the edited clip has ${edited.times.length} — ` +
      "a time warp or resample is active. Remove it, or export with resampling instead.",
    );
  }
  const B = base.names.length;
  const hasRoot = ch.rootPositions.length === F && ch.rootRotations.length === F;

  // Pass 1: find dirty cells (cheap; no payload needed if there are none).
  const dirtyQ: Array<[number, number]> = []; // [bone, frame]
  const dirtyP: number[] = []; // hips frames
  const perBone = new Map<number, ExactBoneChange>();
  const note = (b: number, f: number, deg: number, cm: number): void => {
    let e = perBone.get(b);
    if (!e) perBone.set(b, (e = { bone: b, name: base.names[b], frames: 0, frameStart: f, frameEnd: f, maxDeg: 0 }));
    if (e.frameEnd !== f || e.frames === 0) e.frames++;
    e.frameEnd = f;
    if (deg > e.maxDeg) e.maxDeg = deg;
    if (cm > 0) e.maxPosCm = Math.max(e.maxPosCm ?? 0, cm);
  };
  for (let b = 0; b < B; b++) {
    const bq = base.localQuat[b];
    const eq = edited.localQuat[b];
    const bp = base.localPos[b];
    const ep = edited.localPos[b];
    for (let f = 0; f < F; f++) {
      const q0 = bq[f];
      const q1 = eq[f];
      let touched = false;
      // A bone the avatar never recorded is an all-zero quat: never write it.
      if (q0 !== q1 && q0[0] * q0[0] + q0[1] * q0[1] + q0[2] * q0[2] + q0[3] * q0[3] > 0.25) {
        const a = angleRad(q0, q1);
        if (a > DIRTY_ROT_RAD) { dirtyQ.push([b, f]); note(b, f, (a * 180) / Math.PI, 0); touched = true; }
      }
      const p0 = bp[f];
      const p1 = ep[f];
      if (p0 !== p1) {
        const d = Math.hypot(p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]);
        if (d > DIRTY_POS_M) {
          if (b !== 0) {
            throw new Error(
              `timing-exact export cannot move ${base.names[b]} (only rotations and the hips position are stored per ` +
              "frame) — a proportions/retarget edit is active.",
            );
          }
          dirtyP.push(f);
          if (!touched) note(b, f, 0, d * 100); else perBone.get(b)!.maxPosCm = Math.max(perBone.get(b)!.maxPosCm ?? 0, d * 100);
        }
      }
    }
  }

  const bones = [...perBone.values()].sort((a, b) => a.bone - b.bone);
  for (const e of bones) {
    e.maxDeg = Math.round(e.maxDeg * 1000) / 1000;
    if (e.maxPosCm !== undefined) e.maxPosCm = Math.round(e.maxPosCm * 1000) / 1000;
  }
  const report: ExactExportReport = {
    frames: F,
    identicalToSource: dirtyQ.length === 0 && dirtyP.length === 0,
    cellsChanged: dirtyQ.length + dirtyP.length,
    frameStart: bones.length ? Math.min(...bones.map((e) => e.frameStart)) : null,
    frameEnd: bones.length ? Math.max(...bones.map((e) => e.frameEnd)) : null,
    bones,
  };
  if (report.identicalToSource) return { bytes: source.slice(), report };

  // Pass 2: patch the original payload in place.
  const payload = decompressPayload(source).slice();
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const cells = locateCells(payload, character);
  if (cells.frames !== F || cells.bones !== B) {
    throw new Error(`wanim: payload layout (${cells.frames} frames × ${cells.bones} bones) does not match the parsed clip`);
  }
  const rootRot = (f: number): Quat => quatNormalize(ch.rootRotations[f]);

  for (const [b, f] of dirtyQ) {
    // Back to Unity space; the hips also had the character root baked in.
    let q = flipQuat(edited.localQuat[b][f]);
    if (b === 0 && hasRoot) q = quatMul(conj(rootRot(f)), q);
    q = quatNormalize(q);
    // Same rotation, original hemisphere: never hand back q → −q.
    const o = ch.boneRotations[f][b];
    if (q[0] * o[0] + q[1] * o[1] + q[2] * o[2] + q[3] * o[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    writeCell(payload, view, cells.quatOff[f * B + b], q);
  }
  for (const f of dirtyP) {
    let p = flipPos(edited.localPos[0][f]);
    if (hasRoot) {
      const rp = ch.rootPositions[f];
      p = quatRotate(conj(rootRot(f)), [p[0] - rp[0], p[1] - rp[1], p[2] - rp[2]]);
    }
    writeCell(payload, view, cells.posOff[f * B], p);
  }

  // Compress, then prove the container decodes back to exactly this payload;
  // if the compressor ever disagrees with the decoder, ship literal blocks.
  let bytes = rewrap(source, payload, lz4CompressBlock);
  let ok = false;
  try { ok = sameBytes(decompressPayload(bytes), payload); } catch { ok = false; }
  if (!ok) bytes = rewrap(source, payload, lz4CompressBlockLiteral);
  return { bytes, report };
}

/** Decompress one LZ4 block — re-exported for the checks. */
export { lz4DecompressBlock };
