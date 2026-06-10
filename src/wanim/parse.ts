import { lz4DecompressBlock } from "./lz4.ts";
import { MsgpackReader, isBin, isExt, type MsgpackValue } from "./msgpack.ts";

/** Unity HumanBodyBones order — .wanim stores 55 bones positionally with no names. */
export const HUMAN_BODY_BONES = [
  "Hips", "LeftUpperLeg", "RightUpperLeg", "LeftLowerLeg", "RightLowerLeg",
  "LeftFoot", "RightFoot", "Spine", "Chest", "Neck", "Head",
  "LeftShoulder", "RightShoulder", "LeftUpperArm", "RightUpperArm",
  "LeftLowerArm", "RightLowerArm", "LeftHand", "RightHand",
  "LeftToes", "RightToes", "LeftEye", "RightEye", "Jaw",
  "LeftThumbProximal", "LeftThumbIntermediate", "LeftThumbDistal",
  "LeftIndexProximal", "LeftIndexIntermediate", "LeftIndexDistal",
  "LeftMiddleProximal", "LeftMiddleIntermediate", "LeftMiddleDistal",
  "LeftRingProximal", "LeftRingIntermediate", "LeftRingDistal",
  "LeftLittleProximal", "LeftLittleIntermediate", "LeftLittleDistal",
  "RightThumbProximal", "RightThumbIntermediate", "RightThumbDistal",
  "RightIndexProximal", "RightIndexIntermediate", "RightIndexDistal",
  "RightMiddleProximal", "RightMiddleIntermediate", "RightMiddleDistal",
  "RightRingProximal", "RightRingIntermediate", "RightRingDistal",
  "RightLittleProximal", "RightLittleIntermediate", "RightLittleDistal",
  "UpperChest",
] as const;

export const BONE_COUNT = HUMAN_BODY_BONES.length; // 55

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export interface WanimCharacter {
  /** [frame][bone] local position (bone 0 = hips, relative to character root). */
  bonePositions: Vec3[][];
  /** [frame][bone] local rotation quaternion. */
  boneRotations: Quat[][];
  /** Blendshape set name (e.g. "__VRM__") → per-frame { blendshapeName: value }. */
  blendshapes: Record<string, Record<string, number>[]>;
  /** [frame] character root position. */
  rootPositions: Vec3[];
  /** [frame] character root rotation quaternion. */
  rootRotations: Quat[];
}

export interface WanimClip {
  version: number;
  /** Per-frame timestamps in seconds. Variable rate — resample before fixed-rate export. */
  times: number[];
  characters: WanimCharacter[];
}

const LZ4_BLOCK_ARRAY_EXT = 98;
const LZ4_BLOCK_EXT = 99;

/**
 * Unwrap MessagePack-CSharp LZ4 compression (LZ4BlockArray ext 98 / LZ4Block
 * ext 99) and return the decompressed msgpack payload.
 */
function decompressPayload(file: Uint8Array): Uint8Array {
  const reader = new MsgpackReader(file);
  const head = file[0];

  // LZ4BlockArray: array [ext98(sizes), bin, bin, ...]
  const isArrayHead = head === 0xdc || head === 0xdd || (head >= 0x90 && head <= 0x9f);
  if (isArrayHead) {
    const top = reader.decode();
    if (Array.isArray(top) && top.length >= 2 && isExt(top[0]) && top[0].extType === LZ4_BLOCK_ARRAY_EXT) {
      const sizeReader = new MsgpackReader(top[0].data);
      const sizes: number[] = [];
      while (sizeReader.remaining > 0) sizes.push(Number(sizeReader.decode()));
      const blocks = top.slice(1);
      if (sizes.length !== blocks.length) {
        throw new Error(`wanim: LZ4BlockArray size table (${sizes.length}) does not match block count (${blocks.length})`);
      }
      const total = sizes.reduce((a, b) => a + b, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (let i = 0; i < blocks.length; i++) {
        const blk = blocks[i];
        if (!isBin(blk)) throw new Error(`wanim: LZ4BlockArray block ${i} is not bin`);
        out.set(lz4DecompressBlock(blk.bin, sizes[i]), offset);
        offset += sizes[i];
      }
      return out;
    }
    // Plain uncompressed payload that happens to be an array: re-read from the start.
    return file;
  }

  // LZ4Block: single ext whose data is [msgpack int origLen][lz4 block]
  const top = reader.decode();
  if (isExt(top) && top.extType === LZ4_BLOCK_EXT) {
    const inner = new MsgpackReader(top.data);
    const origLen = Number(inner.decode());
    return lz4DecompressBlock(top.data.subarray(inner.pos), origLen);
  }
  return file;
}

function asNumberArray(v: MsgpackValue, what: string): number[] {
  if (!Array.isArray(v)) throw new Error(`wanim: expected array for ${what}`);
  return v as number[];
}

export function parseWanim(buffer: ArrayBuffer): WanimClip {
  const payload = decompressPayload(new Uint8Array(buffer));
  const root = new MsgpackReader(payload).decode();
  if (!Array.isArray(root) || root.length < 7) {
    throw new Error("wanim: payload is not the expected 10-field array — not a .wanim recording?");
  }

  const version = Number(root[0]);
  const times = asNumberArray(root[1], "timestamps");
  const positions = root[2] as MsgpackValue[];
  const rotations = root[3] as MsgpackValue[];
  const blendshapeSets = root[4] as MsgpackValue[];
  const rootPositions = root[5] as MsgpackValue[];
  const rootRotations = root[6] as MsgpackValue[];

  if (!Array.isArray(positions) || !Array.isArray(rotations)) {
    throw new Error("wanim: missing bone position/rotation tracks");
  }

  const characters: WanimCharacter[] = positions.map((_, c) => ({
    bonePositions: positions[c] as Vec3[][],
    boneRotations: rotations[c] as Quat[][],
    blendshapes: (Array.isArray(blendshapeSets) && blendshapeSets[c]
      ? blendshapeSets[c]
      : {}) as Record<string, Record<string, number>[]>,
    rootPositions: (Array.isArray(rootPositions) ? rootPositions[c] : []) as Vec3[],
    rootRotations: (Array.isArray(rootRotations) ? rootRotations[c] : []) as Quat[],
  }));

  for (const ch of characters) {
    if (ch.bonePositions.length !== times.length || ch.boneRotations.length !== times.length) {
      throw new Error("wanim: bone track frame count does not match timestamp count");
    }
  }

  return { version, times, characters };
}
