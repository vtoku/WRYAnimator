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

/**
 * Unity HumanBodyBones name → MotionBuilder / HumanIK template name. These are
 * the names MotionBuilder's Characterization auto-detects (also the Mixamo
 * convention sans prefix), so an FBX exported with them characterizes without
 * manual slot mapping. Unity names are kept as the default for Unity/Warudo
 * re-import, where renaming would break name-keyed retargeting.
 */
export const MOTIONBUILDER_NAMES: Record<string, string> = {
  Hips: "Hips",
  Spine: "Spine",
  Chest: "Spine1",
  UpperChest: "Spine2",
  Neck: "Neck",
  Head: "Head",
  LeftEye: "LeftEye",
  RightEye: "RightEye",
  Jaw: "Jaw",
  LeftShoulder: "LeftShoulder",
  LeftUpperArm: "LeftArm",
  LeftLowerArm: "LeftForeArm",
  LeftHand: "LeftHand",
  RightShoulder: "RightShoulder",
  RightUpperArm: "RightArm",
  RightLowerArm: "RightForeArm",
  RightHand: "RightHand",
  LeftUpperLeg: "LeftUpLeg",
  LeftLowerLeg: "LeftLeg",
  LeftFoot: "LeftFoot",
  LeftToes: "LeftToeBase",
  RightUpperLeg: "RightUpLeg",
  RightLowerLeg: "RightLeg",
  RightFoot: "RightFoot",
  RightToes: "RightToeBase",
  LeftThumbProximal: "LeftHandThumb1",
  LeftThumbIntermediate: "LeftHandThumb2",
  LeftThumbDistal: "LeftHandThumb3",
  LeftIndexProximal: "LeftHandIndex1",
  LeftIndexIntermediate: "LeftHandIndex2",
  LeftIndexDistal: "LeftHandIndex3",
  LeftMiddleProximal: "LeftHandMiddle1",
  LeftMiddleIntermediate: "LeftHandMiddle2",
  LeftMiddleDistal: "LeftHandMiddle3",
  LeftRingProximal: "LeftHandRing1",
  LeftRingIntermediate: "LeftHandRing2",
  LeftRingDistal: "LeftHandRing3",
  LeftLittleProximal: "LeftHandPinky1",
  LeftLittleIntermediate: "LeftHandPinky2",
  LeftLittleDistal: "LeftHandPinky3",
  RightThumbProximal: "RightHandThumb1",
  RightThumbIntermediate: "RightHandThumb2",
  RightThumbDistal: "RightHandThumb3",
  RightIndexProximal: "RightHandIndex1",
  RightIndexIntermediate: "RightHandIndex2",
  RightIndexDistal: "RightHandIndex3",
  RightMiddleProximal: "RightHandMiddle1",
  RightMiddleIntermediate: "RightHandMiddle2",
  RightMiddleDistal: "RightHandMiddle3",
  RightRingProximal: "RightHandRing1",
  RightRingIntermediate: "RightHandRing2",
  RightRingDistal: "RightHandRing3",
  RightLittleProximal: "RightHandPinky1",
  RightLittleIntermediate: "RightHandPinky2",
  RightLittleDistal: "RightHandPinky3",
};

export type NameScheme = "unity" | "motionbuilder";

/** Remap a Unity HumanBodyBones name list to the chosen export scheme. */
export function remapNames(unityNames: string[], scheme: NameScheme): string[] {
  if (scheme === "unity") return unityNames.slice();
  return unityNames.map((n) => MOTIONBUILDER_NAMES[n] ?? n);
}

/** children[i] = indices of bones whose parent is i. */
export function childrenOf(parents: number[]): number[][] {
  const out: number[][] = parents.map(() => []);
  parents.forEach((p, i) => {
    if (p >= 0) out[p].push(i);
  });
  return out;
}
