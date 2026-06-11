// VRM humanoid-extension parsing (ported from VRMxShogun): reads the GLB JSON
// chunk and returns gltf-node-index → Unity HumanBodyBones name. This is the
// authoritative bone mapping for VRM files (node names are arbitrary, often
// VRoid J_Bip_* or Japanese).

const GLB_MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'

/** Replace bare NaN/Infinity tokens (same length) so JSON.parse/GLTFLoader work. */
export function sanitizeGlb(arrayBuffer: ArrayBuffer): ArrayBuffer {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 12 || dv.getUint32(0, true) !== GLB_MAGIC) return arrayBuffer;
  const totalLength = dv.getUint32(8, true);
  let offset = 12;
  while (offset + 8 <= totalLength) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (chunkType === JSON_CHUNK) {
      const bytes = new Uint8Array(arrayBuffer, dataStart, chunkLength);
      const text = new TextDecoder().decode(bytes);
      if (text.includes("NaN") || text.includes("Infinity")) {
        const fixed = text.replace(/Infinity/g, "99999999").replace(/NaN/g, "0e0");
        const fixedBytes = new TextEncoder().encode(fixed);
        if (fixedBytes.length === bytes.length) {
          const copy = arrayBuffer.slice(0);
          new Uint8Array(copy).set(fixedBytes, dataStart);
          return copy;
        }
      }
      return arrayBuffer;
    }
    offset = dataStart + chunkLength;
  }
  return arrayBuffer;
}

function glbJson(arrayBuffer: ArrayBuffer): unknown | null {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 12 || dv.getUint32(0, true) !== GLB_MAGIC) return null;
  const totalLength = dv.getUint32(8, true);
  let offset = 12;
  while (offset + 8 <= totalLength) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (chunkType === JSON_CHUNK) {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, dataStart, chunkLength)));
    }
    offset = dataStart + chunkLength;
  }
  return null;
}

/** VRM humanoid bone name (camelCase) → Unity HumanBodyBones name. */
function vrmBoneToUnity(vrmName: string, version: "0.x" | "1.0"): string | null {
  // VRM 1.0 thumb segments differ from Unity's naming.
  if (version === "1.0") {
    const thumb = vrmName.match(/^(left|right)Thumb(Metacarpal|Proximal|Distal)$/);
    if (thumb) {
      const seg = { Metacarpal: "Proximal", Proximal: "Intermediate", Distal: "Distal" }[thumb[2]]!;
      return `${thumb[1][0].toUpperCase()}${thumb[1].slice(1)}Thumb${seg}`;
    }
  }
  return vrmName.charAt(0).toUpperCase() + vrmName.slice(1);
}

/**
 * Parse the VRM humanoid mapping from a GLB/VRM ArrayBuffer.
 * Returns node index → Unity bone name, or null if not a VRM.
 */
export function parseVrmHumanoid(arrayBuffer: ArrayBuffer): Map<number, string> | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = glbJson(arrayBuffer) as any;
  const ext = json?.extensions;
  if (!ext) return null;

  const map = new Map<number, string>();
  if (ext.VRMC_vrm) {
    const humanBones = ext.VRMC_vrm?.humanoid?.humanBones ?? {};
    for (const boneName of Object.keys(humanBones)) {
      const node = humanBones[boneName]?.node;
      const unity = vrmBoneToUnity(boneName, "1.0");
      if (typeof node === "number" && unity) map.set(node, unity);
    }
    return map.size ? map : null;
  }
  if (ext.VRM) {
    const humanBones: { bone?: string; node?: number }[] = ext.VRM?.humanoid?.humanBones ?? [];
    for (const entry of humanBones) {
      if (entry && typeof entry.bone === "string" && typeof entry.node === "number") {
        const unity = vrmBoneToUnity(entry.bone, "0.x");
        if (unity) map.set(entry.node, unity);
      }
    }
    return map.size ? map : null;
  }
  return null;
}
