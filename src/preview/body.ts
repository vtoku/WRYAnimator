import * as THREE from "three";
import type { BodyMeshData } from "../convert/body.ts";
import type { Vec3 } from "../wanim/parse.ts";

/**
 * Build preview SkinnedMeshes from retargeted body data, bound to the
 * preview's bone hierarchy. Vertices are already in OUR T-pose world space
 * (meters); the skeleton bind inverses are simple negative translations.
 */
export function buildBodyMeshes(
  data: BodyMeshData[],
  bones: THREE.Bone[],
  bindWorld: Vec3[],
): THREE.Group {
  const boneInverses = bindWorld.map(
    (t) => new THREE.Matrix4().makeTranslation(-t[0], -t[1], -t[2]),
  );
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0x8d97a5,
    roughness: 0.8,
    metalness: 0.05,
  });

  for (const m of data) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(m.skinIndex, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(m.skinWeight, 4));
    geo.setIndex(new THREE.Uint32BufferAttribute(m.indices, 1));

    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.frustumCulled = false;
    const skeleton = new THREE.Skeleton(bones, boneInverses);
    mesh.bind(skeleton, new THREE.Matrix4());
    group.add(mesh);
  }
  return group;
}
