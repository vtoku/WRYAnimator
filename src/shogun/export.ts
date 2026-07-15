import { buildExportModel } from "./build.ts";
import type { BuildInput, BuildResult } from "./build.ts";
import { writeFbx } from "./asciiFbx.ts";

// Ported from VRMxShogun (src/fbx/export.ts). FBX object ids must be unique
// int64s. A single generator is shared by the build step (bones) and the writer
// (everything else) so ids never collide.
function makeIdGen(): () => number {
  let id = 1000000;
  return () => (id += 1);
}

export function buildModel(input: BuildInput): {
  result: BuildResult;
  toFbx: () => string;
} {
  const idGen = makeIdGen();
  const result = buildExportModel(input, idGen);
  return {
    result,
    toFbx: () => writeFbx(result.model, idGen, { rotate: input.rotateExport }),
  };
}
