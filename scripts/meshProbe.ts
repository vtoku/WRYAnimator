// Minimal mesh-in-FBX probes for bisecting MotionBuilder's mesh acceptance.
// Usage: node --experimental-strip-types scripts/meshProbe.ts <variant: plain|underBone|blend>
import { writeFileSync } from "node:fs";
import {
  serializeFbxBinary, node, objName, FILE_ID, CREATION_TIME,
  type FbxNode, type FbxProp, I, L, D, C, S, R, aI, aD,
} from "../src/fbx/fbxBinary.ts";

const variant = process.argv[2] ?? "plain";
const P = (name: string, ...rest: FbxProp[]): FbxNode => node("P", [S(name), ...rest]);

let nextId = 1000000;
const id = () => ++nextId;

// one triangle, 10cm
const verts = new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
const poly = new Int32Array([0, 1, -3]);
const normals = new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);

const geoId = id();
const modelId = id();
const objects: FbxNode[] = [];
const conns: FbxNode[] = [];
const OO = (a: number, b: number) => conns.push(node("C", [S("OO"), L(a), L(b)]));

objects.push(node("Geometry", [L(geoId), S(objName("Tri", "Geometry")), S("Mesh")], [
  node("GeometryVersion", [I(124)]),
  node("Vertices", [aD(verts)]),
  node("PolygonVertexIndex", [aI(poly)]),
  node("LayerElementNormal", [I(0)], [
    node("Version", [I(102)]),
    node("Name", [S("")]),
    node("MappingInformationType", [S("ByVertice")]),
    node("ReferenceInformationType", [S("Direct")]),
    node("Normals", [aD(normals)]),
  ]),
  ...(variant === "mat"
    ? [node("LayerElementMaterial", [I(0)], [
        node("Version", [I(101)]),
        node("Name", [S("")]),
        node("MappingInformationType", [S("AllSame")]),
        node("ReferenceInformationType", [S("IndexToDirect")]),
        node("Materials", [aI(new Int32Array([0]))]),
      ])]
    : []),
  node("Layer", [I(0)], [
    node("Version", [I(100)]),
    node("LayerElement", [], [node("Type", [S("LayerElementNormal")]), node("TypedIndex", [I(0)])]),
    ...(variant === "mat"
      ? [node("LayerElement", [], [node("Type", [S("LayerElementMaterial")]), node("TypedIndex", [I(0)])])]
      : []),
  ]),
]));

if (variant === "mat") {
  const matId = id();
  objects.push(node("Material", [L(matId), S(objName("FaceMat", "Material")), S("")], [
    node("Version", [I(102)]),
    node("ShadingModel", [S("phong")]),
    node("MultiLayer", [I(0)]),
    node("Properties70", [], [
      P("DiffuseColor", S("Color"), S(""), S("A"), D(0.8), D(0.8), D(0.8)),
    ]),
  ]));
  conns.push(node("C", [S("OO"), L(matId), L(modelId)]));
}
objects.push(node("Model", [L(modelId), S(objName("FaceMesh", "Model")), S("Mesh")], [
  node("Version", [I(232)]),
  node("Properties70", [], [
    // Without DefaultAttributeIndex=0 the SDK template default (-1) applies =
    // "no active node attribute" -> the model imports as a Null, not a Mesh.
    P("DefaultAttributeIndex", S("int"), S("Integer"), S(""), I(0)),
    P("InheritType", S("enum"), S(""), S(""), I(1)),
    P("Lcl Translation", S("Lcl Translation"), S(""), S("A"), D(0), D(100), D(0)),
    P("Lcl Rotation", S("Lcl Rotation"), S(""), S("A"), D(0), D(0), D(0)),
    P("Lcl Scaling", S("Lcl Scaling"), S(""), S("A"), D(1), D(1), D(1)),
  ]),
  node("MultiLayer", [I(0)]),
  node("MultiTake", [I(0)]),
  node("Shading", [C(true)]),
  node("Culling", [S("CullingOff")]),
]));
OO(geoId, modelId);

if (variant === "underBone" || variant === "blend") {
  const boneId = id();
  const attrId = id();
  objects.push(node("NodeAttribute", [L(attrId), S(objName("", "NodeAttribute")), S("LimbNode")], [
    node("TypeFlags", [S("Skeleton")]),
  ]));
  objects.push(node("Model", [L(boneId), S(objName("Bone", "Model")), S("LimbNode")], [
    node("Version", [I(232)]),
    node("Properties70", [], [
      P("Lcl Translation", S("Lcl Translation"), S(""), S("A"), D(0), D(0), D(0)),
    ]),
  ]));
  OO(attrId, boneId);
  OO(boneId, 0);
  OO(modelId, boneId);
} else {
  OO(modelId, 0);
}

if (variant === "blend") {
  const bsId = id();
  const chId = id();
  const shapeId = id();
  objects.push(node("Deformer", [L(bsId), S(objName("", "BlendShape")), S("BlendShape")], [
    node("Version", [I(100)]),
  ]));
  objects.push(node("Deformer", [L(chId), S(objName("jawOpen", "SubDeformer")), S("BlendShapeChannel")], [
    node("Version", [I(100)]),
    node("DeformPercent", [D(0)]),
    node("FullWeights", [aD(new Float64Array([100]))]),
  ]));
  objects.push(node("Geometry", [L(shapeId), S(objName("jawOpen", "Geometry")), S("Shape")], [
    node("Version", [I(100)]),
    node("Indexes", [aI(new Int32Array([0, 1, 2]))]),
    node("Vertices", [aD(new Float64Array([0, 0, 5, 0, 0, 5, 0, 0, 5]))]),
  ]));
  OO(bsId, geoId);
  OO(chId, bsId);
  OO(shapeId, chId);
}

const top: FbxNode[] = [
  node("FBXHeaderExtension", [], [
    node("FBXHeaderVersion", [I(1004)]),
    node("FBXVersion", [I(7700)]),
    node("EncryptionType", [I(0)]),
    node("CreationTimeStamp", [], [
      node("Version", [I(1000)]),
      node("Year", [I(1970)]), node("Month", [I(1)]), node("Day", [I(1)]),
      node("Hour", [I(10)]), node("Minute", [I(0)]), node("Second", [I(0)]), node("Millisecond", [I(0)]),
    ]),
    node("Creator", [S("FBX SDK/FBX Plugins version 2020.3.7")]),
    node("OtherFlags", [], [node("TCDefinition", [I(127)])]),
  ]),
  node("FileId", [R(FILE_ID)]),
  node("CreationTime", [S(CREATION_TIME)]),
  node("Creator", [S("FBX SDK/FBX Plugins version 2020.3.7 build=0")]),
  node("GlobalSettings", [], [
    node("Version", [I(1000)]),
    node("Properties70", [], [
      P("UpAxis", S("int"), S("Integer"), S(""), I(1)),
      P("UpAxisSign", S("int"), S("Integer"), S(""), I(1)),
      P("FrontAxis", S("int"), S("Integer"), S(""), I(2)),
      P("FrontAxisSign", S("int"), S("Integer"), S(""), I(1)),
      P("CoordAxis", S("int"), S("Integer"), S(""), I(0)),
      P("CoordAxisSign", S("int"), S("Integer"), S(""), I(1)),
      P("UnitScaleFactor", S("double"), S("Number"), S(""), D(1)),
    ]),
  ]),
  node("Documents", [], [
    node("Count", [I(1)]),
    node("Document", [L(id()), S("Scene"), S("Scene")], [
      node("Properties70", [], [
        P("SourceObject", S("object"), S(""), S("")),
        P("ActiveAnimStackName", S("KString"), S(""), S(""), S("")),
      ]),
      node("RootNode", [L(0)]),
    ]),
  ]),
  node("References", []),
  node("Definitions", [], [
    node("Version", [I(100)]),
    node("Count", [I(objects.length)]),
    ...Object.entries(objects.reduce((m: Record<string, number>, o) => ((m[o.name] = (m[o.name] ?? 0) + 1), m), {}))
      .map(([name, count]) => node("ObjectType", [S(name)], [node("Count", [I(count)])])),
  ]),
  node("Objects", [], objects),
  node("Connections", [], conns),
];

const out = `scripts/probe-${variant}.fbx`;
writeFileSync(out, serializeFbxBinary(top, 7700));
console.log("wrote", out);
