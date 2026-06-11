// Compare binary FBX header-level facts between files.
import { readFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  const b = readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint32(23, true);
  const hex = (a) => [...a].map((x) => x.toString(16).padStart(2, "0")).join(" ");

  // FBXHeaderVersion: find "FBXHeaderVersion" name, value is I <i32> right after
  const hv = b.indexOf(Buffer.from("FBXHeaderVersion"));
  const headerVersion = hv > 0 ? dv.getInt32(hv + 16 + 1, true) : -1;
  // FBXVersion node
  const fv = b.indexOf(Buffer.from("FBXVersion"));
  const nodeVersion = fv > 0 ? dv.getInt32(fv + 10 + 1, true) : -1;
  // EncryptionType
  const et = b.indexOf(Buffer.from("EncryptionType"));
  const enc = et > 0 ? dv.getInt32(et + 14 + 1, true) : null;
  // FileId payload
  const fi = b.indexOf(Buffer.from("FileId"));
  const fileId = fi > 0 ? hex(b.subarray(fi + 6 + 1 + 4, fi + 6 + 1 + 4 + 16)) : "none";
  // CreationTime string (skip CreationTimeStamp matches)
  let ct = -1, p = 0;
  while ((p = b.indexOf(Buffer.from("CreationTime"), p + 1)) > 0) {
    if (b[p + 12] !== 0x53 /* 'S' of Stamp */) { ct = p; break; }
  }
  const ctStr = ct > 0 ? b.subarray(ct + 12 + 1 + 4, ct + 12 + 1 + 4 + 23).toString() : "none";
  const n = b.length;
  const footMagic = hex(b.subarray(n - 16));
  const footVersion = dv.getUint32(n - 16 - 120 - 4, true);
  let q = n - 16 - 120 - 4;
  while (b[q - 1] === 0) q--;
  const footCode = hex(b.subarray(q - 16, q));
  const takes = b.indexOf(Buffer.from("Takes")) > 0;
  const sceneInfo = b.indexOf(Buffer.from("SceneInfo")) > 0;
  const tpl = b.indexOf(Buffer.from("PropertyTemplate")) > 0;

  console.log(`=== ${file}`);
  console.log(`  binVersion=${version} nodeVersion=${nodeVersion} headerVersion=${headerVersion} encryption=${enc}`);
  console.log(`  FileId       ${fileId}`);
  console.log(`  CreationTime "${ctStr}"`);
  console.log(`  footerCode   ${footCode}`);
  console.log(`  footVersion=${footVersion} magicOK=${footMagic.startsWith("f8 5a 8c 6a")}`);
  console.log(`  Takes=${takes} SceneInfo=${sceneInfo} PropertyTemplate=${tpl}`);
}
