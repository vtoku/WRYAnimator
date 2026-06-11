import type { ResampledClip } from "../convert/clip.ts";
import type { Vec3 } from "../wanim/parse.ts";
import { quatToEulerZYX, RAD2DEG } from "../convert/quat.ts";
import {
  serializeFbxBinary, node, objName, type FbxNode, type FbxProp,
  I, L, D, C, S, R, aI, aL, aF, aD,
} from "./fbxBinary.ts";

// assimp's generic FileId — the FBX SDK pairs this header id with the footer
// code; using the same well-known constants makes the file read as a valid
// modern binary FBX (not "legacy").
const GENERIC_FILEID = new Uint8Array([
  0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1,
]);

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

export interface FaceExport {
  /** Flat control-point positions (xyz) in the head model's own units. */
  positions: Float32Array;
  /** Triangle control-point indices (flat). */
  indices: Uint32Array;
  center: [number, number, number];
  height: number;
  /** One per animated blendshape: ARKit name, per-control-point deltas, weight track. */
  channels: { name: string; deltas: Float32Array; weights: Float32Array }[];
}

export interface WriteAnimOpts {
  takeName?: string;
  names?: string[];
  tposeRest?: boolean;
  /** Embed an animated blendshape head mesh, seated on the given Head bone. */
  face?: FaceExport;
  headIndex?: number;
}

const TARGET_HEAD_CM = 22; // exported head height
const HEAD_LIFT_CM = 9; // raise the head above the neck-top joint

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
        P("Size", S("double"), S("Number"), S(""), D(10)),
        P("LimbLength", S("double"), S("Number"), S("H"), D(5)),
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

  // ---- optional blendshape face -----------------------------------------
  const faceConns: { kind: "OO" | "OP"; a: number; b: number; p?: string }[] = [];
  if (opts.face && opts.headIndex !== undefined && opts.headIndex >= 0) {
    const face = opts.face;
    const headModelId = boneModelId[opts.headIndex];
    const scale = TARGET_HEAD_CM / (face.height || 1);
    const [cx, cy, cz] = face.center;

    // Seat into the Head bone's local space (cm): recenter, scale, rotate 180°
    // about Y so the head faces the same way as the body, lift above the joint.
    const baked = new Float64Array(face.positions.length);
    for (let i = 0; i < face.positions.length; i += 3) {
      const x = (face.positions[i] - cx) * scale;
      const y = (face.positions[i + 1] - cy) * scale;
      const z = (face.positions[i + 2] - cz) * scale;
      baked[i] = -x;            // Ry180
      baked[i + 1] = y + HEAD_LIFT_CM;
      baked[i + 2] = -z;
    }
    // Polygon vertex index: triangles with the last index of each face negated.
    const poly = new Int32Array(face.indices.length);
    for (let i = 0; i < face.indices.length; i += 3) {
      poly[i] = face.indices[i];
      poly[i + 1] = face.indices[i + 1];
      poly[i + 2] = -face.indices[i + 2] - 1;
    }

    const geoId = id();
    const meshModelId = id();
    const blendShapeId = id();

    objects.push(node("Geometry", [L(geoId), S(objName("Face", "Geometry")), S("Mesh")], [
      node("GeometryVersion", [I(124)]),
      node("Vertices", [aD(baked)]),
      node("PolygonVertexIndex", [aI(poly)]),
    ]));
    objects.push(node("Model", [L(meshModelId), S(objName("FaceMesh", "Model")), S("Mesh")], [
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
    objects.push(node("Deformer", [L(blendShapeId), S(objName("", "BlendShape")), S("BlendShape")], [
      node("Version", [I(100)]),
    ]));

    faceConns.push({ kind: "OO", a: geoId, b: meshModelId });
    faceConns.push({ kind: "OO", a: meshModelId, b: headModelId });
    faceConns.push({ kind: "OO", a: blendShapeId, b: geoId });

    for (const ch of face.channels) {
      const channelId = id();
      const shapeId = id();
      const cnId = id();
      const curveId = id();
      const deltas = new Float64Array(ch.deltas.length);
      for (let i = 0; i < ch.deltas.length; i += 3) {
        deltas[i] = -ch.deltas[i] * scale; // Ry180 + scale (vector: no translation/lift)
        deltas[i + 1] = ch.deltas[i + 1] * scale;
        deltas[i + 2] = -ch.deltas[i + 2] * scale;
      }
      const idxAll = new Int32Array(face.positions.length / 3);
      for (let i = 0; i < idxAll.length; i++) idxAll[i] = i;

      objects.push(node("Deformer", [L(channelId), S(objName(ch.name, "SubDeformer")), S("BlendShapeChannel")], [
        node("Version", [I(100)]),
        node("DeformPercent", [D(0)]),
        node("FullWeights", [aD(new Float64Array([100]))]),
      ]));
      objects.push(node("Geometry", [L(shapeId), S(objName(ch.name, "Geometry")), S("Shape")], [
        node("Version", [I(100)]),
        node("Indexes", [aI(idxAll)]),
        node("Vertices", [aD(deltas)]),
      ]));
      // DeformPercent animation (weights 0..1 → percent 0..100).
      const percent = Float32Array.from(ch.weights, (w) => w * 100);
      objects.push(node("AnimationCurveNode", [L(cnId), S(objName("DeformPercent", "AnimCurveNode")), S("")], [
        node("Properties70", [], [P("d|DeformPercent", S("Number"), S(""), S("A"), D(percent[0] ?? 0))]),
      ]));
      objects.push(curve(curveId, Array.from(percent)));

      faceConns.push({ kind: "OO", a: channelId, b: blendShapeId });
      faceConns.push({ kind: "OO", a: shapeId, b: channelId });
      faceConns.push({ kind: "OO", a: cnId, b: layerId });
      faceConns.push({ kind: "OP", a: cnId, b: channelId, p: "DeformPercent" });
      faceConns.push({ kind: "OP", a: curveId, b: cnId, p: "d|DeformPercent" });
    }
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

  for (const fc of faceConns) {
    if (fc.kind === "OO") OO(fc.a, fc.b);
    else OP(fc.a, fc.b, fc.p!);
  }

  // ---- Definitions counts (derived from the objects actually emitted) ----
  const typeCounts: Record<string, number> = {};
  for (const o of objects) typeCounts[o.name] = (typeCounts[o.name] ?? 0) + 1;
  const objectTypes = Object.entries(typeCounts).map(([name, count]) =>
    node("ObjectType", [S(name)], [node("Count", [I(count)])]),
  );
  const totalDefs = 1 + objects.length;
  const definitions = node("Definitions", [], [
    node("Version", [I(100)]),
    node("Count", [I(totalDefs)]),
    node("ObjectType", [S("GlobalSettings")], [node("Count", [I(1)])]),
    ...objectTypes,
  ]);

  // ---- top-level ---------------------------------------------------------
  const header = node("FBXHeaderExtension", [], [
    node("FBXHeaderVersion", [I(1003)]),
    node("FBXVersion", [I(7700)]),
    node("EncryptionType", [I(0)]),
    node("CreationTimeStamp", [], [
      node("Version", [I(1000)]),
      node("Year", [I(2026)]), node("Month", [I(1)]), node("Day", [I(1)]),
      node("Hour", [I(0)]), node("Minute", [I(0)]), node("Second", [I(0)]), node("Millisecond", [I(0)]),
    ]),
    node("Creator", [S("WANIMxFBX")]),
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
    ]),
  ]);
  const fileId = node("FileId", [R(GENERIC_FILEID)]);
  const creationTime = node("CreationTime", [S("1970-01-01 10:00:00:000")]);
  const creator = node("Creator", [S("WANIMxFBX")]);

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

  // No legacy "Takes" section — deprecated since FBX 7.4; its presence makes
  // MotionBuilder treat the file as legacy. The AnimationStack IS the take.
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
  ];

  return serializeFbxBinary(top, 7700);
}
