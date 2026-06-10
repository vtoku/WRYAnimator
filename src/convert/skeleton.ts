import { HUMAN_BODY_BONES, BONE_COUNT } from "../wanim/parse.ts";

/**
 * Parent index for each Unity HumanBodyBones slot (the .wanim bone order).
 * -1 = root (Hips). Neck and both shoulders attach to UpperChest (index 54);
 * for avatars without an UpperChest, Warudo still fills that slot with a
 * near-zero offset from Chest, so the chain degrades gracefully.
 */
const PARENT_BY_NAME: Record<string, string | null> = {
  Hips: null,
  Spine: "Hips",
  Chest: "Spine",
  UpperChest: "Chest",
  Neck: "UpperChest",
  Head: "Neck",
  LeftEye: "Head",
  RightEye: "Head",
  Jaw: "Head",
  LeftShoulder: "UpperChest",
  LeftUpperArm: "LeftShoulder",
  LeftLowerArm: "LeftUpperArm",
  LeftHand: "LeftLowerArm",
  RightShoulder: "UpperChest",
  RightUpperArm: "RightShoulder",
  RightLowerArm: "RightUpperArm",
  RightHand: "RightLowerArm",
  LeftUpperLeg: "Hips",
  LeftLowerLeg: "LeftUpperLeg",
  LeftFoot: "LeftLowerLeg",
  LeftToes: "LeftFoot",
  RightUpperLeg: "Hips",
  RightLowerLeg: "RightUpperLeg",
  RightFoot: "RightLowerLeg",
  RightToes: "RightFoot",
  LeftThumbProximal: "LeftHand",
  LeftThumbIntermediate: "LeftThumbProximal",
  LeftThumbDistal: "LeftThumbIntermediate",
  LeftIndexProximal: "LeftHand",
  LeftIndexIntermediate: "LeftIndexProximal",
  LeftIndexDistal: "LeftIndexIntermediate",
  LeftMiddleProximal: "LeftHand",
  LeftMiddleIntermediate: "LeftMiddleProximal",
  LeftMiddleDistal: "LeftMiddleIntermediate",
  LeftRingProximal: "LeftHand",
  LeftRingIntermediate: "LeftRingProximal",
  LeftRingDistal: "LeftRingIntermediate",
  LeftLittleProximal: "LeftHand",
  LeftLittleIntermediate: "LeftLittleProximal",
  LeftLittleDistal: "LeftLittleIntermediate",
  RightThumbProximal: "RightHand",
  RightThumbIntermediate: "RightThumbProximal",
  RightThumbDistal: "RightThumbIntermediate",
  RightIndexProximal: "RightHand",
  RightIndexIntermediate: "RightIndexProximal",
  RightIndexDistal: "RightIndexIntermediate",
  RightMiddleProximal: "RightHand",
  RightMiddleIntermediate: "RightMiddleProximal",
  RightMiddleDistal: "RightMiddleIntermediate",
  RightRingProximal: "RightHand",
  RightRingIntermediate: "RightRingProximal",
  RightRingDistal: "RightRingIntermediate",
  RightLittleProximal: "RightHand",
  RightLittleIntermediate: "RightLittleProximal",
  RightLittleDistal: "RightLittleIntermediate",
};

/** parent[i] = index of bone i's parent, or -1 for the root. */
export const BONE_PARENTS: number[] = HUMAN_BODY_BONES.map((name) => {
  const parent = PARENT_BY_NAME[name];
  return parent == null ? -1 : HUMAN_BODY_BONES.indexOf(parent as (typeof HUMAN_BODY_BONES)[number]);
});

if (BONE_PARENTS.length !== BONE_COUNT) {
  throw new Error("skeleton: parent table does not cover all bones");
}

/** children[i] = indices of bones whose parent is i. */
export function childrenOf(parents: number[]): number[][] {
  const out: number[][] = parents.map(() => []);
  parents.forEach((p, i) => {
    if (p >= 0) out[p].push(i);
  });
  return out;
}
