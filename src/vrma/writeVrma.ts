import type { ResampledClip } from "../convert/clip.ts";

// VRM Animation (.vrma) writer — a GLB with the VRMC_vrm_animation 1.0
// extension: a humanoid NODE hierarchy (no mesh/skin), glTF animation
// channels for bone rotations + hips translation, and one node per
// expression whose translation.x carries the weight.
//
// Conventions line up with our converted clip directly: glTF is right-handed
// Y-up with the model facing +Z (left hand at +X) — exactly what
// convertCharacter produces — units are meters, and our identity local
// rotation IS the T-pose rest, so node.rotation channels take localQuat
// verbatim and only Hips gets a translation channel.

interface FaceTracks {
  names: string[];
  tracks: Float32Array[];
}

// Unity HumanBodyBones name → VRM 1.0 humanoid bone name.
function unityToVrmBone(u: string): string {
  const thumb = u.match(/^(Left|Right)Thumb(Proximal|Intermediate|Distal)$/);
  if (thumb) {
    const seg = { Proximal: "Metacarpal", Intermediate: "Proximal", Distal: "Distal" }[thumb[2]]!;
    return `${thumb[1].toLowerCase()}Thumb${seg}`;
  }
  return u.charAt(0).toLowerCase() + u.slice(1);
}

// Synthesized track names (from augmentFaceForVrm) → VRM expression presets.
const VRM_PRESET: Record<string, string> = {
  A: "aa", I: "ih", U: "ou", E: "ee", O: "oh",
  Blink: "blink", Blink_L: "blinkLeft", Blink_R: "blinkRight",
  Look_Up: "lookUp", Look_Down: "lookDown", Look_Left: "lookLeft", Look_Right: "lookRight",
};
// Names that are tracking metadata, not blendshapes.
const SKIP_TRACKS = new Set(["trackingstatus"]);

export function writeVrma(clip: ResampledClip, face?: FaceTracks): Uint8Array {
  const { frameCount, fps, parents } = clip;
  const names = clip.names;
  const boneCount = names.length;

  // ---- binary buffer ------------------------------------------------------
  const chunks: Float32Array[] = [];
  let byteOffset = 0;
  const bufferViews: { buffer: 0; byteOffset: number; byteLength: number }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessors: any[] = [];
  const pushData = (data: Float32Array, type: string, count: number, minMax?: boolean): number => {
    chunks.push(data);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength });
    byteOffset += data.byteLength;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc: any = {
      bufferView: bufferViews.length - 1,
      componentType: 5126, // FLOAT
      count,
      type,
    };
    if (minMax) {
      acc.min = [data[0]];
      acc.max = [data[data.length - 1]];
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  // Shared key times.
  const times = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) times[f] = f / fps;
  const timeAcc = pushData(times, "SCALAR", frameCount, true);

  // ---- nodes --------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const samplers: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channels: any[] = [];
  const addChannel = (node: number, path: string, output: number) => {
    samplers.push({ input: timeAcc, output, interpolation: "LINEAR" });
    channels.push({ sampler: samplers.length - 1, target: { node, path } });
  };

  // Humanoid bones: rest translation = bind offsets (meters), identity rest
  // rotation (= T-pose).
  const humanBones: Record<string, { node: number }> = {};
  for (let b = 0; b < boneCount; b++) {
    nodes.push({ name: names[b], translation: [...clip.bindPos[b]], children: [] as number[] });
    humanBones[unityToVrmBone(names[b])] = { node: b };
  }
  for (let b = 0; b < boneCount; b++) {
    if (parents[b] >= 0) nodes[parents[b]].children.push(b);
  }
  const sceneRoots: number[] = [];
  for (let b = 0; b < boneCount; b++) if (parents[b] < 0) sceneRoots.push(b);

  // Rotation channels for every bone; translation for Hips only.
  for (let b = 0; b < boneCount; b++) {
    const rot = new Float32Array(frameCount * 4);
    for (let f = 0; f < frameCount; f++) {
      const q = clip.localQuat[b][f];
      rot[f * 4] = q[0]; rot[f * 4 + 1] = q[1]; rot[f * 4 + 2] = q[2]; rot[f * 4 + 3] = q[3];
    }
    addChannel(b, "rotation", pushData(rot, "VEC4", frameCount));
  }
  {
    const pos = new Float32Array(frameCount * 3);
    for (let f = 0; f < frameCount; f++) {
      const p = clip.localPos[0][f];
      pos[f * 3] = p[0]; pos[f * 3 + 1] = p[1]; pos[f * 3 + 2] = p[2];
    }
    addChannel(0, "translation", pushData(pos, "VEC3", frameCount));
  }

  // ---- expressions --------------------------------------------------------
  const preset: Record<string, { node: number }> = {};
  const custom: Record<string, { node: number }> = {};
  if (face) {
    for (let n = 0; n < face.names.length; n++) {
      const name = face.names[n];
      if (SKIP_TRACKS.has(name.toLowerCase())) continue;
      if (/^Fcl_/.test(name)) continue; // VRoid aliases — redundant in VRMA
      const track = face.tracks[n];
      let moved = 0;
      for (let f = 0; f < track.length; f++) moved = Math.max(moved, Math.abs(track[f]));
      if (moved < 0.01) continue;
      const nodeIdx = nodes.length;
      nodes.push({ name: `expr_${name}`, translation: [0, 0, 0] });
      sceneRoots.push(nodeIdx);
      const presetName = VRM_PRESET[name];
      if (presetName) preset[presetName] = { node: nodeIdx };
      else custom[name] = { node: nodeIdx };
      const w = new Float32Array(frameCount * 3);
      for (let f = 0; f < frameCount; f++) w[f * 3] = Math.min(1, Math.max(0, track[f]));
      addChannel(nodeIdx, "translation", pushData(w, "VEC3", frameCount));
    }
  }

  // ---- assemble GLB -------------------------------------------------------
  const binLength = byteOffset;
  const json = {
    asset: { version: "2.0", generator: "WANIMxFBX" },
    extensionsUsed: ["VRMC_vrm_animation"],
    scene: 0,
    scenes: [{ nodes: sceneRoots }],
    nodes,
    animations: [{ name: "clip", samplers, channels }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: "1.0",
        humanoid: { humanBones },
        ...(Object.keys(preset).length || Object.keys(custom).length
          ? { expressions: { preset, custom } }
          : {}),
      },
    },
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (binLength % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + binLength + binPad;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, 0x46546c67, true); o += 4; // glTF
  dv.setUint32(o, 2, true); o += 4;
  dv.setUint32(o, total, true); o += 4;
  dv.setUint32(o, jsonBytes.length + jsonPad, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4; // JSON
  out.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < jsonPad; i++) out[o++] = 0x20; // pad with spaces
  dv.setUint32(o, binLength + binPad, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4; // BIN
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), o);
    o += c.byteLength;
  }
  return out;
}
