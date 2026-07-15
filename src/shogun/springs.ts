// Ported verbatim from VRMxShogun (src/vrm/springs.ts).
// Collects the glTF node indices that are VRM spring bones (hair, skirt, tail,
// accessories). Shogun can't use these; an optional export step reweights them
// onto their nearest non-spring parent and drops them.

export function extractSpringNodeIndices(json: any): Set<number> {
  const out = new Set<number>();
  const ext = json?.extensions;
  if (!ext) return out;

  // VRM 1.0 — each spring lists its joint nodes explicitly.
  const sb = ext.VRMC_springBone;
  if (sb?.springs) {
    for (const spring of sb.springs) {
      for (const joint of spring.joints ?? []) {
        if (typeof joint?.node === "number") out.add(joint.node);
      }
    }
  }

  // VRM 0.x — boneGroups list chain ROOTS; every descendant is also a spring bone.
  const groups = ext.VRM?.secondaryAnimation?.boneGroups;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      for (const root of group?.bones ?? []) {
        if (typeof root === "number") addSubtree(json, root, out);
      }
    }
  }

  return out;
}

function addSubtree(json: any, nodeIndex: number, out: Set<number>) {
  out.add(nodeIndex);
  const children: number[] = json?.nodes?.[nodeIndex]?.children ?? [];
  for (const c of children) addSubtree(json, c, out);
}
