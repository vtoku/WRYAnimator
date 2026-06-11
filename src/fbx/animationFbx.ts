import type { ResampledClip } from "../convert/clip.ts";
import type { Vec3 } from "../wanim/parse.ts";
import { quatToEulerZYX, RAD2DEG } from "../convert/quat.ts";
import {
  serializeFbxBinary, node, objName, type FbxNode, type FbxProp,
  I, L, D, C, S, aI, aL, aF,
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

export interface WriteAnimOpts {
  takeName?: string;
  names?: string[];
  tposeRest?: boolean;
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

  // IDs.
  let nextId = 1000000;
  const id = () => ++nextId;
  const boneModelId = names.map(() => id());
  const boneAttrId = names.map(() => id());
  const stackId = id();
  const layerId = id();
  const rotNode = names.map(() => ({ nodeId: id(), curveIds: [id(), id(), id()] as const }));
  const hipsTrans = { nodeId: id(), curveIds: [id(), id(), id()] as const };

  // ---- Objects -----------------------------------------------------------
  const objects: FbxNode[] = [];

  names.forEach((name, i) => {
    objects.push(node("NodeAttribute", [L(boneAttrId[i]), S(objName("", "NodeAttribute")), S("LimbNode")], [
      node("Properties70", [], [P("Size", S("double"), S("Number"), S(""), D(1))]),
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
      P("LocalStop", S("KTime"), S("Time"), S(""), L(stopTime)),
      P("ReferenceStop", S("KTime"), S("Time"), S(""), L(stopTime)),
    ]),
  ]));
  objects.push(node("AnimationLayer", [L(layerId), S(objName("BaseLayer", "AnimLayer")), S("")]));

  const curveNode = (nodeId: number, label: string, defs: [number, number, number]): FbxNode =>
    node("AnimationCurveNode", [L(nodeId), S(objName(label, "AnimCurveNode")), S("")], [
      node("Properties70", [], [
        P("d|X", S("Number"), S(""), S("A"), D(defs[0])),
        P("d|Y", S("Number"), S(""), S("A"), D(defs[1])),
        P("d|Z", S("Number"), S(""), S("A"), D(defs[2])),
      ]),
    ]);

  const flags = new Int32Array([24840]);
  const refCount = new Int32Array([frameCount]);
  const attrData = new Float32Array([0, 0, 0, 0]);
  const curve = (curveId: number, values: number[]): FbxNode =>
    node("AnimationCurve", [L(curveId), S(objName("", "AnimCurve")), S("")], [
      node("Default", [D(values[0] ?? 0)]),
      node("KeyVer", [I(4009)]),
      node("KeyTime", [aL(keyTimes)]),
      node("KeyValueFloat", [aF(Float32Array.from(values))]),
      node("KeyAttrFlags", [aI(flags)]),
      node("KeyAttrDataFloat", [aF(attrData)]),
      node("KeyAttrRefCount", [aI(refCount)]),
    ]);

  names.forEach((_, i) => {
    const ch = rotNode[i];
    objects.push(curveNode(ch.nodeId, "R", [eulerX[i][0], eulerY[i][0], eulerZ[i][0]]));
    objects.push(curve(ch.curveIds[0], eulerX[i]));
    objects.push(curve(ch.curveIds[1], eulerY[i]));
    objects.push(curve(ch.curveIds[2], eulerZ[i]));
  });
  objects.push(curveNode(hipsTrans.nodeId, "T", [transX[0], transY[0], transZ[0]]));
  objects.push(curve(hipsTrans.curveIds[0], transX));
  objects.push(curve(hipsTrans.curveIds[1], transY));
  objects.push(curve(hipsTrans.curveIds[2], transZ));

  // ---- Connections -------------------------------------------------------
  const conns: FbxNode[] = [];
  const OO = (src: number, dst: number) => conns.push(node("C", [S("OO"), L(src), L(dst)]));
  const OP = (src: number, dst: number, prop: string) =>
    conns.push(node("C", [S("OP"), L(src), L(dst), S(prop)]));

  names.forEach((_, i) => {
    OO(boneModelId[i], parents[i] >= 0 ? boneModelId[parents[i]] : 0);
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

  // ---- Definitions counts ------------------------------------------------
  const curveNodeCount = boneCount + 1;
  const curveCount = curveNodeCount * 3;
  const totalDefs = 1 + boneCount + boneCount + 1 + 1 + curveNodeCount + curveCount;

  const definitions = node("Definitions", [], [
    node("Version", [I(100)]),
    node("Count", [I(totalDefs)]),
    node("ObjectType", [S("GlobalSettings")], [node("Count", [I(1)])]),
    node("ObjectType", [S("Model")], [node("Count", [I(boneCount)])]),
    node("ObjectType", [S("NodeAttribute")], [node("Count", [I(boneCount)])]),
    node("ObjectType", [S("AnimationStack")], [node("Count", [I(1)])]),
    node("ObjectType", [S("AnimationLayer")], [node("Count", [I(1)])]),
    node("ObjectType", [S("AnimationCurveNode")], [node("Count", [I(curveNodeCount)])]),
    node("ObjectType", [S("AnimationCurve")], [node("Count", [I(curveCount)])]),
  ]);

  // ---- top-level ---------------------------------------------------------
  const header = node("FBXHeaderExtension", [], [
    node("FBXHeaderVersion", [I(1003)]),
    node("FBXVersion", [I(7500)]),
    node("CreationTimeStamp", [], [
      node("Version", [I(1000)]),
      node("Year", [I(2026)]), node("Month", [I(1)]), node("Day", [I(1)]),
      node("Hour", [I(0)]), node("Minute", [I(0)]), node("Second", [I(0)]), node("Millisecond", [I(0)]),
    ]),
    node("Creator", [S("WANIMxFBX")]),
  ]);

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
      P("TimeMode", S("enum"), S(""), S(""), I(11)),
      P("CustomFrameRate", S("double"), S("Number"), S(""), D(fps)),
      P("TimeSpanStart", S("KTime"), S("Time"), S(""), L(0)),
      P("TimeSpanStop", S("KTime"), S("Time"), S(""), L(stopTime)),
    ]),
  ]);

  const documents = node("Documents", [], [
    node("Count", [I(1)]),
    node("Document", [L(id()), S(""), S("Scene")], [node("RootNode", [I(0)])]),
  ]);

  const takes = node("Takes", [], [
    node("Current", [S(takeName)]),
    node("Take", [S(takeName)], [
      node("FileName", [S(`${takeName.replace(/\s+/g, "_")}.tak`)]),
      node("LocalTime", [L(0), L(stopTime)]),
      node("ReferenceTime", [L(0), L(stopTime)]),
    ]),
  ]);

  const top: FbxNode[] = [
    header,
    globalSettings,
    documents,
    node("References", []),
    definitions,
    node("Objects", [], objects),
    node("Connections", [], conns),
    takes,
  ];

  return serializeFbxBinary(top, 7500);
}
