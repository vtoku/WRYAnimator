import type { ResampledClip } from "../convert/clip.ts";
import type { Vec3 } from "../wanim/parse.ts";
import { quatToEulerZYX, RAD2DEG } from "../convert/quat.ts";
import {
  serializeFbxBinary, node, objName, FILE_ID, CREATION_TIME, FBX_TIMESTAMP,
  type FbxNode, type FbxProp,
  I, L, D, C, S, R, aI, aL, aF, aD,
} from "./fbxBinary.ts";

// Builds a binary FBX 7500 skeletal animation: a LimbNode skeleton driven by an
// AnimationStack/Layer with per-bone Lcl Rotation curves and a Hips Lcl
// Translation curve. Binary (not ASCII) because MotionBuilder 2018+ only
// imports binary FBX. Y-up; lengths converted meters→cm.

const FBX_TIME_SECOND = 46186158000;
const METERS_TO_CM = 100;

function unwrapDegrees(values: number[]): void {
  for (let i = 1; i < values.length; i++) {
    let d = values[i] - values[i - 1];
    while (d > 180) { values[i] -= 360; d -= 360; }
    while (d < -180) { values[i] += 360; d += 360; }
  }
}

const P = (name: string, ...rest: FbxProp[]): FbxNode => node("P", [S(name), ...rest]);

/**
 * A skinned mesh to embed. Geometry is in WORLD-space bind coordinates (cm),
 * pre-baked by the caller against the skeleton's T-pose; skinning is expressed
 * as clusters over the export skeleton's bone indices.
 */
export interface SkinnedMeshExport {
  name: string;
  /** Flat control-point positions (xyz, world bind space, cm). */
  positions: Float64Array;
  /** Flat per-control-point normals (xyz, world bind space). */
  normals: Float64Array;
  /** Triangle control-point indices (flat, 3 per face). */
  indices: Uint32Array;
  /** Skin clusters: bone index (into clip bones) + the points it influences. */
  clusters: { boneIndex: number; pointIndices: Int32Array; weights: Float64Array }[];
  /** Optional blendshape channels (deltas in world-scale cm). */
  channels?: { name: string; deltas: Float64Array; weights: Float32Array }[];
}

export interface WriteAnimOpts {
  takeName?: string;
  names?: string[];
  tposeRest?: boolean;
  /** Skinned meshes to embed (face head, body, ...). */
  meshes?: SkinnedMeshExport[];
}

export function writeAnimationFbx(clip: ResampledClip, opts: WriteAnimOpts = {}): Uint8Array {
  const takeName = opts.takeName ?? "Take 001";
  const { frameCount, fps, parents } = clip;
  const names = opts.names ?? clip.names;
  const tposeRest = opts.tposeRest ?? false;
  const boneCount = names.length;

  // Shared key times (FBX ticks).
  const keyTimes: number[] = new Array(frameCount);
  const tickPerFrame = FBX_TIME_SECOND / fps;
  for (let i = 0; i < frameCount; i++) keyTimes[i] = Math.round(i * tickPerFrame);
  const stopTime = keyTimes[frameCount - 1] ?? 0;

  // Euler tracks (deg, unwrapped) per bone.
  const eulerX: number[][] = [];
  const eulerY: number[][] = [];
  const eulerZ: number[][] = [];
  for (let b = 0; b < boneCount; b++) {
    const xs = new Array<number>(frameCount);
    const ys = new Array<number>(frameCount);
    const zs = new Array<number>(frameCount);
    for (let f = 0; f < frameCount; f++) {
      const e = quatToEulerZYX(clip.localQuat[b][f]);
      xs[f] = e[0] * RAD2DEG; ys[f] = e[1] * RAD2DEG; zs[f] = e[2] * RAD2DEG;
    }
    unwrapDegrees(xs); unwrapDegrees(ys); unwrapDegrees(zs);
    eulerX.push(xs); eulerY.push(ys); eulerZ.push(zs);
  }

  const transX = clip.localPos[0].map((p) => p[0] * METERS_TO_CM);
  const transY = clip.localPos[0].map((p) => p[1] * METERS_TO_CM);
  const transZ = clip.localPos[0].map((p) => p[2] * METERS_TO_CM);

  // T-pose world joint positions (cm): cumulative bind offsets with identity
  // rotations. Resolved recursively — the bone array is NOT topologically
  // sorted (UpperChest parents earlier-indexed bones).
  const bindWorld: Vec3[] = new Array(boneCount);
  const resolveWorld = (i: number): Vec3 => {
    if (bindWorld[i]) return bindWorld[i];
    const p = parents[i];
    const base: Vec3 = p >= 0 ? resolveWorld(p) : [0, 0, 0];
    const lp = clip.bindPos[i];
    return (bindWorld[i] = [
      base[0] + lp[0] * METERS_TO_CM,
      base[1] + lp[1] * METERS_TO_CM,
      base[2] + lp[2] * METERS_TO_CM,
    ]);
  };
  for (let i = 0; i < boneCount; i++) resolveWorld(i);

  // Column-major identity-rotation matrices for skinning/bind pose.
  const translationMatrix = (t: Vec3): number[] =>
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
  const inverseTranslationMatrix = (t: Vec3): number[] =>
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -t[0], -t[1], -t[2], 1];

  // IDs.
  let nextId = 1000000;
  const id = () => ++nextId;
  const referenceId = id();
  const referenceAttrId = id();
  const boneModelId = names.map(() => id());
  const boneAttrId = names.map(() => id());
  const stackId = id();
  const layerId = id();
  const rotNode = names.map(() => ({ nodeId: id(), curveIds: [id(), id(), id()] as const }));
  const hipsTrans = { nodeId: id(), curveIds: [id(), id(), id()] as const };

  // ---- Objects -----------------------------------------------------------
  const objects: FbxNode[] = [];

  // Reference root (a Null transform at the origin) so the Hips is NOT the
  // skeleton root — gives DCC retargeting a stable reference node above the rig.
  objects.push(node("NodeAttribute", [L(referenceAttrId), S(objName("", "NodeAttribute")), S("Null")], [
    node("TypeFlags", [S("Null")]),
  ]));
  objects.push(node("Model", [L(referenceId), S(objName("Reference", "Model")), S("Null")], [
    node("Version", [I(232)]),
    node("Properties70", [], [
      P("InheritType", S("enum"), S(""), S(""), I(1)),
      P("Lcl Translation", S("Lcl Translation"), S(""), S("A"), D(0), D(0), D(0)),
      P("Lcl Rotation", S("Lcl Rotation"), S(""), S("A"), D(0), D(0), D(0)),
      P("Lcl Scaling", S("Lcl Scaling"), S(""), S("A"), D(1), D(1), D(1)),
    ]),
    node("Shading", [C(true)]),
    node("Culling", [S("CullingOff")]),
  ]));

  names.forEach((name, i) => {
    objects.push(node("NodeAttribute", [L(boneAttrId[i]), S(objName("", "NodeAttribute")), S("LimbNode")], [
      node("Properties70", [], [
        P("Color", S("ColorRGB"), S("Color"), S(""), D(0.8), D(0.8), D(0.8)),
        // Display size of the joint in MoBu/Maya — too small makes the rig
        // hard to see and select ("really thin"); SDK default is 100.
        P("Size", S("double"), S("Number"), S(""), D(100)),
      ]),
      node("TypeFlags", [S("Skeleton")]),
    ]));

    const bind: Vec3 = clip.bindPos[i];
    const tx = bind[0] * METERS_TO_CM, ty = bind[1] * METERS_TO_CM, tz = bind[2] * METERS_TO_CM;
    const rx = tposeRest ? 0 : eulerX[i][0];
    const ry = tposeRest ? 0 : eulerY[i][0];
    const rz = tposeRest ? 0 : eulerZ[i][0];

    objects.push(node("Model", [L(boneModelId[i]), S(objName(name, "Model")), S("LimbNode")], [
      node("Version", [I(232)]),
      node("Properties70", [], [
        P("InheritType", S("enum"), S(""), S(""), I(1)),
        P("DefaultAttributeIndex", S("int"), S("Integer"), S(""), I(0)),
        P("Lcl Translation", S("Lcl Translation"), S(""), S("A"), D(tx), D(ty), D(tz)),
        P("Lcl Rotation", S("Lcl Rotation"), S(""), S("A"), D(rx), D(ry), D(rz)),
        P("Lcl Scaling", S("Lcl Scaling"), S(""), S("A"), D(1), D(1), D(1)),
      ]),
      node("Shading", [C(true)]),
      node("Culling", [S("CullingOff")]),
    ]));
  });

  objects.push(node("AnimationStack", [L(stackId), S(objName(takeName, "AnimStack")), S("")], [
    node("Properties70", [], [
      P("Description", S("KString"), S(""), S(""), S("")),
      P("LocalStart", S("KTime"), S("Time"), S(""), L(0)),
      P("LocalStop", S("KTime"), S("Time"), S(""), L(stopTime)),
      P("ReferenceStart", S("KTime"), S("Time"), S(""), L(0)),
      P("ReferenceStop", S("KTime"), S("Time"), S(""), L(stopTime)),
    ]),
  ]));
  objects.push(node("AnimationLayer", [L(layerId), S(objName("BaseLayer", "AnimLayer")), S("")], [
    node("Properties70", [], [
      P("Weight", S("Number"), S(""), S("A"), D(100)),
      P("BlendMode", S("enum"), S(""), S(""), I(0)),
      P("RotationAccumulationMode", S("enum"), S(""), S(""), I(0)),
      P("ScaleAccumulationMode", S("enum"), S(""), S(""), I(0)),
    ]),
  ]));

  const curveNode = (nodeId: number, label: string, defs: [number, number, number]): FbxNode =>
    node("AnimationCurveNode", [L(nodeId), S(objName(label, "AnimCurveNode")), S("")], [
      node("Properties70", [], [
        P("d|X", S("Number"), S(""), S("A"), D(defs[0])),
        P("d|Y", S("Number"), S(""), S("A"), D(defs[1])),
        P("d|Z", S("Number"), S(""), S("A"), D(defs[2])),
      ]),
    ]);

  const flags = new Int32Array([24840]);
  const attrData = new Float32Array([0, 0, 0, 0]);
  const curve = (curveId: number, values: number[], times: number[] = keyTimes): FbxNode =>
    node("AnimationCurve", [L(curveId), S(objName("", "AnimCurve")), S("")], [
      node("Default", [D(values[0] ?? 0)]),
      node("KeyVer", [I(4009)]),
      node("KeyTime", [aL(times)]),
      node("KeyValueFloat", [aF(Float32Array.from(values))]),
      node("KeyAttrFlags", [aI(flags)]),
      node("KeyAttrDataFloat", [aF(attrData)]),
      node("KeyAttrRefCount", [aI(new Int32Array([times.length]))]),
    ]);

  // Curve-node defaults: under tposeRest the no-key fallback must be the
  // T-pose, or an empty take leaves the character in the first frame's pose.
  names.forEach((_, i) => {
    const ch = rotNode[i];
    const defs: [number, number, number] = tposeRest
      ? [0, 0, 0]
      : [eulerX[i][0], eulerY[i][0], eulerZ[i][0]];
    objects.push(curveNode(ch.nodeId, "R", defs));
    objects.push(curve(ch.curveIds[0], eulerX[i]));
    objects.push(curve(ch.curveIds[1], eulerY[i]));
    objects.push(curve(ch.curveIds[2], eulerZ[i]));
  });
  const hipDefs: [number, number, number] = tposeRest
    ? [bindWorld[0][0], bindWorld[0][1], bindWorld[0][2]]
    : [transX[0], transY[0], transZ[0]];
  objects.push(curveNode(hipsTrans.nodeId, "T", hipDefs));
  objects.push(curve(hipsTrans.curveIds[0], transX));
  objects.push(curve(hipsTrans.curveIds[1], transY));
  objects.push(curve(hipsTrans.curveIds[2], transZ));

  // ---- "TPose" take: a one-key stance take so DCC tools can characterize
  // from a guaranteed T-pose (also fixes feet/limb auto-mapping in MoBu).
  const tposeStackId = id();
  const tposeLayerId = id();
  const tposeTimes = [0];
  const tposeConns: { a: number; b: number; p?: string }[] = [];
  objects.push(node("AnimationStack", [L(tposeStackId), S(objName("TPose", "AnimStack")), S("")], [
    node("Properties70", [], [
      P("Description", S("KString"), S(""), S(""), S("T-pose stance for characterization")),
      P("LocalStart", S("KTime"), S("Time"), S(""), L(0)),
      P("LocalStop", S("KTime"), S("Time"), S(""), L(FBX_TIME_SECOND)),
      P("ReferenceStart", S("KTime"), S("Time"), S(""), L(0)),
      P("ReferenceStop", S("KTime"), S("Time"), S(""), L(FBX_TIME_SECOND)),
    ]),
  ]));
  objects.push(node("AnimationLayer", [L(tposeLayerId), S(objName("BaseLayer", "AnimLayer")), S("")], [
    node("Properties70", [], [P("Weight", S("Number"), S(""), S("A"), D(100))]),
  ]));
  tposeConns.push({ a: tposeLayerId, b: tposeStackId });
  names.forEach((_, i) => {
    const cnId = id();
    const ids = [id(), id(), id()];
    objects.push(curveNode(cnId, "R", [0, 0, 0]));
    for (let c = 0; c < 3; c++) objects.push(curve(ids[c], [0], tposeTimes));
    tposeConns.push({ a: cnId, b: tposeLayerId });
    tposeConns.push({ a: cnId, b: boneModelId[i], p: "Lcl Rotation" });
    const comps = ["d|X", "d|Y", "d|Z"];
    for (let c = 0; c < 3; c++) tposeConns.push({ a: ids[c], b: cnId, p: comps[c] });
  });
  {
    const cnId = id();
    const ids = [id(), id(), id()];
    objects.push(curveNode(cnId, "T", [bindWorld[0][0], bindWorld[0][1], bindWorld[0][2]]));
    for (let c = 0; c < 3; c++) objects.push(curve(ids[c], [bindWorld[0][c]], tposeTimes));
    tposeConns.push({ a: cnId, b: tposeLayerId });
    tposeConns.push({ a: cnId, b: boneModelId[0], p: "Lcl Translation" });
    const comps = ["d|X", "d|Y", "d|Z"];
    for (let c = 0; c < 3; c++) tposeConns.push({ a: ids[c], b: cnId, p: comps[c] });
  }

  // ---- skinned meshes (face head, body) ----------------------------------
  const meshConns: { kind: "OO" | "OP"; a: number; b: number; p?: string }[] = [];
  const meshModelIds: number[] = [];
  for (const mesh of opts.meshes ?? []) {
    const geoId = id();
    const meshModelId = id();
    meshModelIds.push(meshModelId);

    // Polygon vertex index: triangles, last index of each face negated.
    const poly = new Int32Array(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      poly[i] = mesh.indices[i];
      poly[i + 1] = mesh.indices[i + 1];
      poly[i + 2] = -mesh.indices[i + 2] - 1;
    }

    // The FBX SDK needs a normals layer to accept the node as a real Mesh —
    // without one, MotionBuilder imports the model as a Null (verified).
    objects.push(node("Geometry", [L(geoId), S(objName(mesh.name, "Geometry")), S("Mesh")], [
      node("GeometryVersion", [I(124)]),
      node("Vertices", [aD(mesh.positions)]),
      node("PolygonVertexIndex", [aI(poly)]),
      node("LayerElementNormal", [I(0)], [
        node("Version", [I(102)]),
        node("Name", [S("")]),
        node("MappingInformationType", [S("ByVertice")]),
        node("ReferenceInformationType", [S("Direct")]),
        node("Normals", [aD(mesh.normals)]),
      ]),
      node("Layer", [I(0)], [
        node("Version", [I(100)]),
        node("LayerElement", [], [
          node("Type", [S("LayerElementNormal")]),
          node("TypedIndex", [I(0)]),
        ]),
      ]),
    ]));
    // Skinned mesh at the scene root with identity transform; the clusters
    // carry the bind. DefaultAttributeIndex=0 is REQUIRED: the SDK template
    // default (-1 = no active attribute) makes MoBu import a Null (verified).
    objects.push(node("Model", [L(meshModelId), S(objName(mesh.name, "Model")), S("Mesh")], [
      node("Version", [I(232)]),
      node("Properties70", [], [
        P("DefaultAttributeIndex", S("int"), S("Integer"), S(""), I(0)),
        P("InheritType", S("enum"), S(""), S(""), I(1)),
        P("Lcl Translation", S("Lcl Translation"), S(""), S("A"), D(0), D(0), D(0)),
        P("Lcl Rotation", S("Lcl Rotation"), S(""), S("A"), D(0), D(0), D(0)),
        P("Lcl Scaling", S("Lcl Scaling"), S(""), S("A"), D(1), D(1), D(1)),
      ]),
      node("MultiLayer", [I(0)]),
      node("MultiTake", [I(0)]),
      node("Shading", [C(true)]),
      node("Culling", [S("CullingOff")]),
    ]));
    meshConns.push({ kind: "OO", a: geoId, b: meshModelId });
    meshConns.push({ kind: "OO", a: meshModelId, b: 0 });

    // Skin deformer + one cluster per influencing bone. Bind matrices are
    // identity-rotation T-pose transforms (the same the BindPose carries).
    const skinId = id();
    objects.push(node("Deformer", [L(skinId), S(objName(`Skin ${mesh.name}`, "Deformer")), S("Skin")], [
      node("Version", [I(101)]),
      node("Link_DeformAcuracy", [D(50)]),
    ]));
    meshConns.push({ kind: "OO", a: skinId, b: geoId });
    for (const cl of mesh.clusters) {
      const clusterId = id();
      objects.push(node("Deformer", [L(clusterId), S(objName(`Cluster ${names[cl.boneIndex]}`, "SubDeformer")), S("Cluster")], [
        node("Version", [I(100)]),
        node("UserData", [S(""), S("")]),
        node("Indexes", [aI(cl.pointIndices)]),
        node("Weights", [aD(cl.weights)]),
        node("Transform", [aD(Float64Array.from(inverseTranslationMatrix(bindWorld[cl.boneIndex])))]),
        node("TransformLink", [aD(Float64Array.from(translationMatrix(bindWorld[cl.boneIndex])))]),
      ]));
      meshConns.push({ kind: "OO", a: clusterId, b: skinId });
      meshConns.push({ kind: "OO", a: boneModelId[cl.boneIndex], b: clusterId });
    }

    // Blendshape channels (face): deltas + DeformPercent curves on the main take.
    if (mesh.channels && mesh.channels.length > 0) {
      const blendShapeId = id();
      objects.push(node("Deformer", [L(blendShapeId), S(objName("", "BlendShape")), S("BlendShape")], [
        node("Version", [I(100)]),
      ]));
      meshConns.push({ kind: "OO", a: blendShapeId, b: geoId });
      const idxAll = new Int32Array(mesh.positions.length / 3);
      for (let i = 0; i < idxAll.length; i++) idxAll[i] = i;
      for (const ch of mesh.channels) {
        const channelId = id();
        const shapeId = id();
        const cnId = id();
        const curveId = id();
        objects.push(node("Deformer", [L(channelId), S(objName(ch.name, "SubDeformer")), S("BlendShapeChannel")], [
          node("Version", [I(100)]),
          node("DeformPercent", [D(0)]),
          node("FullWeights", [aD(new Float64Array([100]))]),
        ]));
        objects.push(node("Geometry", [L(shapeId), S(objName(ch.name, "Geometry")), S("Shape")], [
          node("Version", [I(100)]),
          node("Indexes", [aI(idxAll)]),
          node("Vertices", [aD(ch.deltas)]),
        ]));
        const percent = Float32Array.from(ch.weights, (w) => w * 100);
        objects.push(node("AnimationCurveNode", [L(cnId), S(objName("DeformPercent", "AnimCurveNode")), S("")], [
          node("Properties70", [], [P("d|DeformPercent", S("Number"), S(""), S("A"), D(0))]),
        ]));
        objects.push(curve(curveId, Array.from(percent)));
        meshConns.push({ kind: "OO", a: channelId, b: blendShapeId });
        meshConns.push({ kind: "OO", a: shapeId, b: channelId });
        meshConns.push({ kind: "OO", a: cnId, b: layerId });
        meshConns.push({ kind: "OP", a: cnId, b: channelId, p: "DeformPercent" });
        meshConns.push({ kind: "OP", a: curveId, b: cnId, p: "d|DeformPercent" });
      }
    }
  }

  // ---- BindPose: T-pose world matrices for every bone + each mesh. DCC
  // tools use this as the rest/stance pose and for skinning consistency.
  {
    const poseId = id();
    const poseNodes: FbxNode[] = [];
    names.forEach((_, i) => {
      poseNodes.push(node("PoseNode", [], [
        node("Node", [L(boneModelId[i])]),
        node("Matrix", [aD(Float64Array.from(translationMatrix(bindWorld[i])))]),
      ]));
    });
    for (const mid of meshModelIds) {
      poseNodes.push(node("PoseNode", [], [
        node("Node", [L(mid)]),
        node("Matrix", [aD(Float64Array.from(translationMatrix([0, 0, 0])))]),
      ]));
    }
    objects.push(node("Pose", [L(poseId), S(objName("BIND_POSES", "Pose")), S("BindPose")], [
      node("Type", [S("BindPose")]),
      node("Version", [I(100)]),
      node("NbPoseNodes", [I(poseNodes.length)]),
      ...poseNodes,
    ]));
  }

  // ---- Connections -------------------------------------------------------
  const conns: FbxNode[] = [];
  const OO = (src: number, dst: number) => conns.push(node("C", [S("OO"), L(src), L(dst)]));
  const OP = (src: number, dst: number, prop: string) =>
    conns.push(node("C", [S("OP"), L(src), L(dst), S(prop)]));

  OO(referenceId, 0);
  OO(referenceAttrId, referenceId);
  names.forEach((_, i) => {
    OO(boneModelId[i], parents[i] >= 0 ? boneModelId[parents[i]] : referenceId);
    OO(boneAttrId[i], boneModelId[i]);
  });
  OO(layerId, stackId);
  const comp = ["d|X", "d|Y", "d|Z"];
  names.forEach((_, i) => {
    const ch = rotNode[i];
    OO(ch.nodeId, layerId);
    OP(ch.nodeId, boneModelId[i], "Lcl Rotation");
    for (let c = 0; c < 3; c++) OP(ch.curveIds[c], ch.nodeId, comp[c]);
  });
  OO(hipsTrans.nodeId, layerId);
  OP(hipsTrans.nodeId, boneModelId[0], "Lcl Translation");
  for (let c = 0; c < 3; c++) OP(hipsTrans.curveIds[c], hipsTrans.nodeId, comp[c]);

  for (const mc of meshConns) {
    if (mc.kind === "OO") OO(mc.a, mc.b);
    else OP(mc.a, mc.b, mc.p!);
  }
  for (const tc of tposeConns) {
    if (tc.p) OP(tc.a, tc.b, tc.p);
    else OO(tc.a, tc.b);
  }

  // ---- Definitions with PropertyTemplates (as Blender/assimp/the SDK write).
  // The FBX SDK resolves class-default properties from these templates; files
  // without them are off-spec even if lenient readers cope.
  const fbxNodeTemplate = node("PropertyTemplate", [S("FbxNode")], [
    node("Properties70", [], [
      P("QuaternionInterpolate", S("enum"), S(""), S(""), I(0)),
      P("RotationOffset", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("RotationPivot", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("ScalingOffset", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("ScalingPivot", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("TranslationActive", S("bool"), S(""), S(""), I(0)),
      P("TranslationMin", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("TranslationMax", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("TranslationMinX", S("bool"), S(""), S(""), I(0)),
      P("TranslationMinY", S("bool"), S(""), S(""), I(0)),
      P("TranslationMinZ", S("bool"), S(""), S(""), I(0)),
      P("TranslationMaxX", S("bool"), S(""), S(""), I(0)),
      P("TranslationMaxY", S("bool"), S(""), S(""), I(0)),
      P("TranslationMaxZ", S("bool"), S(""), S(""), I(0)),
      P("RotationOrder", S("enum"), S(""), S(""), I(0)),
      P("RotationSpaceForLimitOnly", S("bool"), S(""), S(""), I(0)),
      P("RotationStiffnessX", S("double"), S("Number"), S(""), D(0)),
      P("RotationStiffnessY", S("double"), S("Number"), S(""), D(0)),
      P("RotationStiffnessZ", S("double"), S("Number"), S(""), D(0)),
      P("AxisLen", S("double"), S("Number"), S(""), D(10)),
      P("PreRotation", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("PostRotation", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("RotationActive", S("bool"), S(""), S(""), I(0)),
      P("RotationMin", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("RotationMax", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("RotationMinX", S("bool"), S(""), S(""), I(0)),
      P("RotationMinY", S("bool"), S(""), S(""), I(0)),
      P("RotationMinZ", S("bool"), S(""), S(""), I(0)),
      P("RotationMaxX", S("bool"), S(""), S(""), I(0)),
      P("RotationMaxY", S("bool"), S(""), S(""), I(0)),
      P("RotationMaxZ", S("bool"), S(""), S(""), I(0)),
      P("InheritType", S("enum"), S(""), S(""), I(0)),
      P("ScalingActive", S("bool"), S(""), S(""), I(0)),
      P("ScalingMin", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("ScalingMax", S("Vector3D"), S("Vector"), S(""), D(1), D(1), D(1)),
      P("ScalingMinX", S("bool"), S(""), S(""), I(0)),
      P("ScalingMinY", S("bool"), S(""), S(""), I(0)),
      P("ScalingMinZ", S("bool"), S(""), S(""), I(0)),
      P("ScalingMaxX", S("bool"), S(""), S(""), I(0)),
      P("ScalingMaxY", S("bool"), S(""), S(""), I(0)),
      P("ScalingMaxZ", S("bool"), S(""), S(""), I(0)),
      P("GeometricTranslation", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("GeometricRotation", S("Vector3D"), S("Vector"), S(""), D(0), D(0), D(0)),
      P("GeometricScaling", S("Vector3D"), S("Vector"), S(""), D(1), D(1), D(1)),
      P("MinDampRangeX", S("double"), S("Number"), S(""), D(0)),
      P("MinDampRangeY", S("double"), S("Number"), S(""), D(0)),
      P("MinDampRangeZ", S("double"), S("Number"), S(""), D(0)),
      P("MaxDampRangeX", S("double"), S("Number"), S(""), D(0)),
      P("MaxDampRangeY", S("double"), S("Number"), S(""), D(0)),
      P("MaxDampRangeZ", S("double"), S("Number"), S(""), D(0)),
      P("MinDampStrengthX", S("double"), S("Number"), S(""), D(0)),
      P("MinDampStrengthY", S("double"), S("Number"), S(""), D(0)),
      P("MinDampStrengthZ", S("double"), S("Number"), S(""), D(0)),
      P("MaxDampStrengthX", S("double"), S("Number"), S(""), D(0)),
      P("MaxDampStrengthY", S("double"), S("Number"), S(""), D(0)),
      P("MaxDampStrengthZ", S("double"), S("Number"), S(""), D(0)),
      P("PreferedAngleX", S("double"), S("Number"), S(""), D(0)),
      P("PreferedAngleY", S("double"), S("Number"), S(""), D(0)),
      P("PreferedAngleZ", S("double"), S("Number"), S(""), D(0)),
      P("LookAtProperty", S("object"), S(""), S("")),
      P("UpVectorProperty", S("object"), S(""), S("")),
      P("Show", S("bool"), S(""), S(""), I(1)),
      P("NegativePercentShapeSupport", S("bool"), S(""), S(""), I(1)),
      P("DefaultAttributeIndex", S("int"), S("Integer"), S(""), I(-1)),
      P("Freeze", S("bool"), S(""), S(""), I(0)),
      P("LODBox", S("bool"), S(""), S(""), I(0)),
      P("Lcl Translation", S("Lcl Translation"), S(""), S("A"), D(0), D(0), D(0)),
      P("Lcl Rotation", S("Lcl Rotation"), S(""), S("A"), D(0), D(0), D(0)),
      P("Lcl Scaling", S("Lcl Scaling"), S(""), S("A"), D(1), D(1), D(1)),
      P("Visibility", S("Visibility"), S(""), S("A"), D(1)),
      P("Visibility Inheritance", S("Visibility Inheritance"), S(""), S(""), I(1)),
    ]),
  ]);
  const skeletonTemplate = node("PropertyTemplate", [S("FbxSkeleton")], [
    node("Properties70", [], [
      P("Color", S("ColorRGB"), S("Color"), S(""), D(0.8), D(0.8), D(0.8)),
      P("Size", S("double"), S("Number"), S(""), D(100 / 3)),
      P("LimbLength", S("double"), S("Number"), S("H"), D(1)),
    ]),
  ]);
  const animStackTemplate = node("PropertyTemplate", [S("FbxAnimStack")], [
    node("Properties70", [], [
      P("Description", S("KString"), S(""), S(""), S("")),
      P("LocalStart", S("KTime"), S("Time"), S(""), L(0)),
      P("LocalStop", S("KTime"), S("Time"), S(""), L(0)),
      P("ReferenceStart", S("KTime"), S("Time"), S(""), L(0)),
      P("ReferenceStop", S("KTime"), S("Time"), S(""), L(0)),
    ]),
  ]);
  const animLayerTemplate = node("PropertyTemplate", [S("FbxAnimLayer")], [
    node("Properties70", [], [
      P("Weight", S("Number"), S(""), S("A"), D(100)),
      P("Mute", S("bool"), S(""), S(""), I(0)),
      P("Solo", S("bool"), S(""), S(""), I(0)),
      P("Lock", S("bool"), S(""), S(""), I(0)),
      P("Color", S("ColorRGB"), S("Color"), S(""), D(0.8), D(0.8), D(0.8)),
      P("BlendMode", S("enum"), S(""), S(""), I(0)),
      P("RotationAccumulationMode", S("enum"), S(""), S(""), I(0)),
      P("ScaleAccumulationMode", S("enum"), S(""), S(""), I(0)),
      P("BlendModeBypass", S("ULongLong"), S(""), S(""), L(0)),
    ]),
  ]);
  const animCurveNodeTemplate = node("PropertyTemplate", [S("FbxAnimCurveNode")], [
    node("Properties70", [], [P("d", S("Compound"), S(""), S(""))]),
  ]);

  const templateFor: Record<string, FbxNode | null> = {
    Model: fbxNodeTemplate,
    NodeAttribute: skeletonTemplate,
    AnimationStack: animStackTemplate,
    AnimationLayer: animLayerTemplate,
    AnimationCurveNode: animCurveNodeTemplate,
  };

  const typeCounts: Record<string, number> = {};
  for (const o of objects) typeCounts[o.name] = (typeCounts[o.name] ?? 0) + 1;
  const objectTypes = Object.entries(typeCounts).map(([name, count]) => {
    const tpl = templateFor[name];
    return node("ObjectType", [S(name)], [
      node("Count", [I(count)]),
      ...(tpl ? [tpl] : []),
    ]);
  });
  const totalDefs = 1 + objects.length;
  const definitions = node("Definitions", [], [
    node("Version", [I(100)]),
    node("Count", [I(totalDefs)]),
    node("ObjectType", [S("GlobalSettings")], [node("Count", [I(1)])]),
    ...objectTypes,
  ]);

  // ---- top-level ---------------------------------------------------------
  const header = node("FBXHeaderExtension", [], [
    // 1004 = what MotionBuilder 2026 itself writes. MoBu's "legacy file"
    // warning keys off FBXHeaderVersion (1003 warns — even Blender's output
    // does); verified by diffing a MoBu-saved file against ours.
    node("FBXHeaderVersion", [I(1004)]),
    node("FBXVersion", [I(7700)]),
    node("EncryptionType", [I(0)]),
    node("CreationTimeStamp", [], [
      node("Version", [I(1000)]),
      node("Year", [I(FBX_TIMESTAMP.year)]), node("Month", [I(FBX_TIMESTAMP.month)]), node("Day", [I(FBX_TIMESTAMP.day)]),
      node("Hour", [I(FBX_TIMESTAMP.hour)]), node("Minute", [I(FBX_TIMESTAMP.minute)]), node("Second", [I(FBX_TIMESTAMP.second)]), node("Millisecond", [I(FBX_TIMESTAMP.millisecond)]),
    ]),
    // The FBX SDK parses this exact "FBX SDK/FBX Plugins version X" form to
    // date the file; unrecognized creators (incl. Blender's) trip MotionBuilder's
    // "legacy file" warning.
    node("Creator", [S("FBX SDK/FBX Plugins version 2020.3.7")]),
    node("OtherFlags", [], [node("TCDefinition", [I(127)])]),
    node("SceneInfo", [S(objName("GlobalInfo", "SceneInfo")), S("UserData")], [
      node("Type", [S("UserData")]),
      node("Version", [I(100)]),
      node("MetaData", [], [
        node("Version", [I(100)]),
        node("Title", [S("")]),
        node("Subject", [S("")]),
        node("Author", [S("WANIMxFBX")]),
        node("Keywords", [S("")]),
        node("Revision", [S("")]),
        node("Comment", [S("")]),
      ]),
      node("Properties70", [], [
        P("DocumentUrl", S("KString"), S("Url"), S(""), S("/animation.fbx")),
        P("SrcDocumentUrl", S("KString"), S("Url"), S(""), S("/animation.fbx")),
        P("Original", S("Compound"), S(""), S("")),
        P("Original|ApplicationVendor", S("KString"), S(""), S(""), S("WANIMxFBX")),
        P("Original|ApplicationName", S("KString"), S(""), S(""), S("WANIMxFBX")),
        P("Original|ApplicationVersion", S("KString"), S(""), S(""), S("1.0")),
        P("Original|DateTime_GMT", S("DateTime"), S(""), S(""), S("01/01/1970 10:00:00.000")),
        P("Original|FileName", S("KString"), S(""), S(""), S("/animation.fbx")),
        P("LastSaved", S("Compound"), S(""), S("")),
        P("LastSaved|ApplicationVendor", S("KString"), S(""), S(""), S("WANIMxFBX")),
        P("LastSaved|ApplicationName", S("KString"), S(""), S(""), S("WANIMxFBX")),
        P("LastSaved|ApplicationVersion", S("KString"), S(""), S(""), S("1.0")),
        P("LastSaved|DateTime_GMT", S("DateTime"), S(""), S(""), S("01/01/1970 10:00:00.000")),
      ]),
    ]),
  ]);
  const fileId = node("FileId", [R(FILE_ID)]);
  const creationTime = node("CreationTime", [S(CREATION_TIME)]);
  const creator = node("Creator", [S("FBX SDK/FBX Plugins version 2020.3.7 build=0")]);

  const globalSettings = node("GlobalSettings", [], [
    node("Version", [I(1000)]),
    node("Properties70", [], [
      P("UpAxis", S("int"), S("Integer"), S(""), I(1)),
      P("UpAxisSign", S("int"), S("Integer"), S(""), I(1)),
      P("FrontAxis", S("int"), S("Integer"), S(""), I(2)),
      P("FrontAxisSign", S("int"), S("Integer"), S(""), I(1)),
      P("CoordAxis", S("int"), S("Integer"), S(""), I(0)),
      P("CoordAxisSign", S("int"), S("Integer"), S(""), I(1)),
      P("OriginalUpAxis", S("int"), S("Integer"), S(""), I(1)),
      P("OriginalUpAxisSign", S("int"), S("Integer"), S(""), I(1)),
      P("UnitScaleFactor", S("double"), S("Number"), S(""), D(1)),
      P("OriginalUnitScaleFactor", S("double"), S("Number"), S(""), D(1)),
      P("AmbientColor", S("ColorRGB"), S("Color"), S(""), D(0), D(0), D(0)),
      P("DefaultCamera", S("KString"), S(""), S(""), S("Producer Perspective")),
      P("TimeMode", S("enum"), S(""), S(""), I(11)),
      P("TimeProtocol", S("enum"), S(""), S(""), I(2)),
      P("SnapOnFrameMode", S("enum"), S(""), S(""), I(0)),
      P("TimeSpanStart", S("KTime"), S("Time"), S(""), L(0)),
      P("TimeSpanStop", S("KTime"), S("Time"), S(""), L(stopTime)),
      P("CustomFrameRate", S("double"), S("Number"), S(""), D(fps)),
      P("CurrentTimeMarker", S("int"), S("Integer"), S(""), I(-1)),
    ]),
  ]);

  const docId = id();
  const documents = node("Documents", [], [
    node("Count", [I(1)]),
    node("Document", [L(docId), S("Scene"), S("Scene")], [
      node("Properties70", [], [
        P("SourceObject", S("object"), S(""), S("")),
        P("ActiveAnimStackName", S("KString"), S(""), S(""), S(takeName)),
      ]),
      node("RootNode", [L(0)]),
    ]),
  ]);

  // Takes: MoBu builds its take list from THIS node, not from AnimationStacks
  // alone (verified: a stack without a Take entry here doesn't show up).
  const takes = node("Takes", [], [
    node("Current", [S("")]),
    node("Take", [S(takeName)], [
      node("FileName", [S(`${takeName.replace(/\s+/g, "_")}.tak`)]),
      node("LocalTime", [L(0), L(stopTime)]),
      node("ReferenceTime", [L(0), L(stopTime)]),
    ]),
    node("Take", [S("TPose")], [
      node("FileName", [S("TPose.tak")]),
      node("LocalTime", [L(0), L(FBX_TIME_SECOND)]),
      node("ReferenceTime", [L(0), L(FBX_TIME_SECOND)]),
    ]),
  ]);

  const top: FbxNode[] = [
    header,
    fileId,
    creationTime,
    creator,
    globalSettings,
    documents,
    node("References", []),
    definitions,
    node("Objects", [], objects),
    node("Connections", [], conns),
    takes,
  ];

  // 7700 = FBX SDK 2020+ format (same 64-bit binary layout as 7500).
  // MotionBuilder 2026 shows "legacy file" for anything older — verified: it
  // warns even on Blender's 7400 output, and stops warning at 7700.
  return serializeFbxBinary(top, 7700);
}
