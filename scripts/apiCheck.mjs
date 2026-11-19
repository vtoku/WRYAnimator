// Acceptance check for the headless editing API, the timing-exact .wanim
// export, the `wry` CLI and the MCP server.
//
// Usage: node scripts/apiCheck.mjs [take.wanim] [--ptid ptid_excerpt.wanim] [--ab ab_excerpt.wanim]
//
//   (no args)  runs the generic checks on the bundled sample (generated on
//              the fly by scripts/makeSampleWanim.mjs if missing)
//   --ptid     adds the PTID acceptance tests (right wrist hyperbend + axis
//              flip, limit.apply round trip). Reads <file>.json for the
//              excerpt's sourceTimeStart.
//   --ab       adds the AndroidBana wrist hyperbend test.
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { openSession, ApiError } = await import("../src/api/session.ts");
const { parseWanim, decompressPayload } = await import("../src/wanim/parse.ts");
const { compose, decompose, boneAxes } = await import("../src/api/anatomy.ts");
const { lz4CompressBlock, lz4DecompressBlock } = await import("../src/wanim/lz4.ts");
const { OPS } = await import("../src/api/ops.ts");

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const ptidPath = flag("ptid");
const abPath = flag("ab");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};
const refused = (fn) => { try { fn(); return null; } catch (e) { return e instanceof ApiError ? e.message : `WRONG ERROR TYPE: ${e}`; } };

const bytesOf = (p) => { const b = readFileSync(p); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
const parse = (u8) => parseWanim(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const sidecar = (p) => (existsSync(`${p}.json`) ? JSON.parse(readFileSync(`${p}.json`, "utf8")) : null);

/** Compare two recordings cell by cell; returns what differs. */
function compare(a, b) {
  const ca = a.characters[0], cb = b.characters[0];
  const changed = new Map(); // bone -> [first, last, count]
  let pos = 0, root = 0;
  for (let f = 0; f < a.times.length; f++) {
    for (let bn = 0; bn < ca.boneRotations[f].length; bn++) {
      if (!sameArr(ca.boneRotations[f][bn], cb.boneRotations[f][bn])) {
        const e = changed.get(bn) ?? [f, f, 0];
        e[1] = f; e[2]++;
        changed.set(bn, e);
      }
      if (!sameArr(ca.bonePositions[f][bn], cb.bonePositions[f][bn])) pos++;
    }
    if (ca.rootPositions[f] && (!sameArr(ca.rootPositions[f], cb.rootPositions[f]) || !sameArr(ca.rootRotations[f], cb.rootRotations[f]))) root++;
  }
  return {
    frames: a.times.length === b.times.length,
    times: a.times.length === b.times.length && a.times.every((v, i) => Object.is(v, b.times[i])),
    changed, pos, root,
    face: JSON.stringify(ca.blendshapes) === JSON.stringify(cb.blendshapes),
  };
}

// ---- sample ---------------------------------------------------------------------
let samplePath = positional[0] ?? ptidPath;
if (!samplePath) {
  samplePath = join(repo, "public", "sample-idle.wanim");
  if (!existsSync(samplePath)) spawnSync(process.execPath, ["scripts/makeSampleWanim.mjs"], { cwd: repo, stdio: "ignore" });
}
console.log(`sample: ${samplePath}`);
const src = bytesOf(samplePath);
const rawSrc = parse(src);
const tmp = mkdtempSync(join(tmpdir(), "wry-check-"));

try {
  // ---- 1. anatomy round trip -----------------------------------------------------
  {
    const s = openSession(src, { name: "anatomy" });
    let worst = 0;
    for (const name of ["RightHand", "LeftHand", "RightLowerArm", "RightIndexProximal", "LeftThumbDistal", "RightLittleIntermediate"]) {
      const b = s.base.names.indexOf(name);
      const ax = boneAxes(s.base, b);
      for (const v of [{ flex: 30, deviation: -20, twist: 45 }, { flex: -85, deviation: 15, twist: -100 }, { flex: 0, deviation: 0, twist: 0 }, { flex: 120, deviation: 40, twist: 10 }]) {
        const d = decompose(ax, compose(ax, v));
        worst = Math.max(worst, Math.abs(d.flex - v.flex), Math.abs(d.deviation - v.deviation), Math.abs(d.twist - v.twist));
      }
    }
    check("anatomy: compose → decompose round-trips", worst < 1e-6, `worst error ${worst.toExponential(2)}°`);
    const rh = boneAxes(s.base, s.base.names.indexOf("RightHand"));
    const lh = boneAxes(s.base, s.base.names.indexOf("LeftHand"));
    // Mirror symmetry: the same anatomical pose on the left is the X-mirror of the right.
    const qr = compose(rh, { flex: 40, deviation: 20, twist: 30 });
    const ql = compose(lh, { flex: 40, deviation: 20, twist: 30 });
    const mirrorErr = Math.max(Math.abs(qr[0] - ql[0]), Math.abs(qr[1] + ql[1]), Math.abs(qr[2] + ql[2]), Math.abs(qr[3] - ql[3]));
    check("anatomy: left = mirror of right for equal components", mirrorErr < 0.02, `max component error ${mirrorErr.toFixed(4)}`);
    // Sign convention: +flex moves the right hand's fingertip direction DOWN (palm-ward in the T-pose).
    const q = compose(rh, { flex: 45, deviation: 0, twist: 0 });
    const [x, y, z, w] = q; const a = rh.axis;
    const ty = 2 * (z * a[0] - x * a[2]), tx = 2 * (y * a[2] - z * a[1]), tz = 2 * (x * a[1] - y * a[0]);
    const rotY = a[1] + w * ty + (z * tx - x * tz);
    check("anatomy: +flex bends the hand palm-ward (down in the T-pose)", rotY < a[1] - 0.3, `axis y ${a[1].toFixed(2)} → ${rotY.toFixed(2)}`);
  }

  // ---- 2. LZ4 ---------------------------------------------------------------------
  {
    const payload = decompressPayload(src);
    const n = Math.min(payload.length, 2 << 20);
    const comp = lz4CompressBlock(payload.subarray(0, n));
    const back = lz4DecompressBlock(comp, n);
    let ok = back.length === n;
    for (let i = 0; ok && i < n; i++) if (back[i] !== payload[i]) ok = false;
    check("lz4: compress → decompress is lossless", ok, `ratio ${(comp.length / n).toFixed(3)}`);
  }

  // ---- 3. timing-exact export ------------------------------------------------------
  {
    const s = openSession(src, { name: "roundtrip" });
    const noEdit = s.exportWanim();
    check("export: no-edit output is the source file byte for byte",
      noEdit.report.identicalToSource && noEdit.bytes.length === src.length && noEdit.bytes.every((v, i) => v === src[i]));

    const hand = s.base.names.indexOf("RightHand");
    const mid = s.timeOf(Math.floor(s.frames / 2));
    const L = s.layerCreate({ name: "t", mode: "additive", fade: 0.3 });
    const k = s.keySet({ layer: L.layer, bone: "RightHand", time: mid, value: { flex: 20 } });
    check("key.set: anatomical value lands exactly; omitted components keep their value",
      Math.abs(k.after.flex - 20) < 1e-3 && Math.abs(k.after.deviation - k.before.deviation) < 1e-3 && Math.abs(k.after.twist - k.before.twist) < 1e-3,
      `flex ${k.before.flex} → ${k.after.flex}, deviation ${k.before.deviation} → ${k.after.deviation}`);
    const ex = s.exportWanim();
    const cmp = compare(rawSrc, parse(ex.bytes));
    check("export: frame count + float64 timestamps identical", cmp.frames && cmp.times);
    check("export: only the edited bone changed", cmp.changed.size === 1 && cmp.changed.has(hand), `bones changed: [${[...cmp.changed.keys()]}]`);
    check("export: positions, root track and face blendshapes untouched", cmp.pos === 0 && cmp.root === 0 && cmp.face);
    const e = cmp.changed.get(hand) ?? [0, 0, 0];
    check("export: reported frame range matches the cells actually changed",
      ex.report.frameStart <= e[0] && ex.report.frameEnd >= e[1] && ex.report.bones.length === 1,
      `report ${ex.report.frameStart}-${ex.report.frameEnd}, file ${e[0]}-${e[1]}`);
    const fadeFrames = s.diff().changed[0];
    check("export: change stays inside the key's fade window",
      fadeFrames.tStart >= mid - 0.3 - 0.05 && fadeFrames.tEnd <= mid + 0.3 + 0.05, `${fadeFrames.tStart}–${fadeFrames.tEnd} s around ${mid.toFixed(3)}`);
    // Reopen the export: the edited value survives float32 storage.
    const re = openSession(ex.bytes, { name: "re" });
    const got = re.evaluate({ bones: ["RightHand"], time: mid }).frames[0].bones.RightHand.base.flex;
    check("export: edited value reads back from the written file", Math.abs(got - 20) < 0.01, `flex ${got}`);
    // Undo returns to byte-identical.
    s.undo(); s.undo();
    check("undo: back to a byte-identical export", s.exportWanim().report.identicalToSource);
    // Rig round trip: same edits from .rig.json give the same bytes.
    s.redo(); s.redo();
    const rig = s.saveRig();
    const s2 = openSession(src, { name: "rig" });
    s2.loadRig(rig);
    const ex2 = s2.exportWanim();
    check("rig: save → load reproduces the export byte for byte", ex2.bytes.length === ex.bytes.length && ex2.bytes.every((v, i) => v === ex.bytes[i]));
  }

  // ---- 4. scope guard ---------------------------------------------------------------
  {
    const s = openSession(src, { name: "deny", denyBones: ["LeftHandAll"] });
    const t0 = s.timeOf(10), t1 = s.timeOf(Math.min(s.frames - 1, 40));
    const L = s.layerCreate({ name: "g" }).layer;
    const tries = [
      ["limit.apply", () => s.limitApply({ bones: ["LeftHand"], t0, t1 })],
      ["hold.insert", () => s.holdInsert({ bones: ["LeftIndexProximal"], donorTime: t0, t0, t1 })],
      ["filter.add", () => s.filterAdd({ kind: "butterworth", bones: ["Left*"], t0, t1 })],
      ["key.set", () => s.keySet({ layer: L, bone: "LeftLittleDistal", time: t0, value: { curl: 10 } })],
      ["key.set (index)", () => s.keySet({ layer: L, bone: 17, time: t0, value: { flex: 0 } })],
    ];
    const res = tries.map(([n, fn]) => [n, refused(fn)]);
    check("deny list: every operation touching a denied bone is refused", res.every(([, m]) => m && /deny list/.test(m)), res.filter(([, m]) => !m).map(([n]) => n).join(","));
    check("deny list: refused operations change nothing", s.exportWanim().report.identicalToSource && s.status().edits.undoSteps === 1);
    check("deny list: the other side still works", !refused(() => s.keySet({ layer: L, bone: "RightHand", time: t0, value: { flex: 5 } })));
    const a = openSession(src, { name: "allow", allowBones: ["RightHand"] });
    check("allow list: a bone outside it is refused", /allow list/.test(refused(() => a.filterAdd({ kind: "despike", bones: ["RightLowerArm"], t0, t1 })) ?? ""));
    const tw = openSession(src, { name: "take 3 TWISTFIX" });
    check("TWISTFIX: forearm twist edits are refused", /protected/.test(refused(() => tw.limitApply({ bones: ["RightLowerArm"], t0, t1, limits: { twist: [-30, 30] } })) ?? ""));
  }

  // ---- 5. PTID acceptance -------------------------------------------------------------
  if (ptidPath) {
    const side = sidecar(ptidPath);
    const off = side?.sourceTimeStart ?? 0;
    const pb = bytesOf(ptidPath);
    const s = openSession(pb, { name: side?.source ?? "ptid", timeOffset: off, denyBones: ["LeftHandAll"] });
    const scan = s.scan({ bones: ["RightHand"], max: 100 }).issues;
    const hb = scan.find((i) => i.kind === "wrist_hyperbend" && i.side === "Right" && i.peakTime > 190.2 && i.peakTime < 191.05);
    check("PTID: wrist_hyperbend reported around 190.25–191.0 s", !!hb, hb ? `${hb.tStart}–${hb.tEnd} s, ${hb.measure} ${hb.peakValue}° at ${hb.peakTime} s, take p99 ${hb.takeRange?.p99}°` : "not found");
    check("PTID: its peak is ~91° of total bend at ~190.76 s", !!hb && hb.measure === "swing" && Math.abs(hb.peakValue - 91) < 3 && Math.abs(hb.peakTime - 190.76) < 0.1);
    const fl = scan.find((i) => i.kind === "wrist_axis_flip" && i.side === "Right" && i.tStart < 191.26 && i.tEnd > 191.0);
    check("PTID: wrist_axis_flip reported at 191.0–191.26 s", !!fl, fl ? `${fl.tStart}–${fl.tEnd} s, direction turns ${fl.peakValue}°` : "not found");
    const tw = scan.find((i) => i.kind === "twist_excess" && i.side === "Right" && i.tStart < 192.8 && i.tEnd > 191.3);
    check("PTID: hand + forearm twist excess reported in 191.3–192.8 s", !!tw, tw ? `${tw.peakValue}° at ${tw.peakTime} s` : "not found");

    const res = s.limitApply({ bones: [18], t0: 190, t1: 193, limits: { flex: [-70, 70], deviation: [-40, 30] }, softness: 8, blend: 0.25 });
    const d = s.diff();
    const ex = s.exportWanim();
    const cmp = compare(parse(pb), parse(ex.bytes));
    check("PTID round trip: same frame count, timestamps identical as float64", cmp.frames && cmp.times, `${ex.report.frames} frames`);
    check("PTID round trip: all bones except 18 identical", cmp.changed.size === 1 && cmp.changed.has(18) && cmp.pos === 0 && cmp.root === 0 && cmp.face, `changed bones [${[...cmp.changed.keys()]}]`);
    const e = cmp.changed.get(18) ?? [0, 0, 0];
    const tA = s.timeOf(e[0]), tB = s.timeOf(e[1]);
    check("PTID round trip: frames outside the edit + fade range identical", tA >= 190 - 0.25 - 0.02 && tB <= 193 + 0.25 + 0.02,
      `changed frames ${e[0]}–${e[1]} = ${tA.toFixed(3)}–${tB.toFixed(3)} s (${e[2]} cells; report says ${ex.report.frameStart}–${ex.report.frameEnd})`);
    check("PTID round trip: diff edge step ≤ 5° per frame", d.maxEdgeStepDeg <= 5, `${d.maxEdgeStepDeg}°`);
    check("PTID: the hyperbend is gone on re-scan", res.changed && !s.scan({ bones: ["RightHand"], kinds: ["wrist_hyperbend"], t0: 190, t1: 193 }).issues.length);
  } else {
    console.log("SKIP  PTID acceptance tests (pass --ptid <ptid_excerpt.wanim>)");
  }

  // ---- 6. AndroidBana acceptance --------------------------------------------------------
  if (abPath) {
    const side = sidecar(abPath);
    const s = openSession(bytesOf(abPath), { name: side?.source ?? "ab", timeOffset: side?.sourceTimeStart ?? 0 });
    const hb = s.scan({ bones: ["RightHand"], kinds: ["wrist_hyperbend"], max: 100 }).issues.find((i) => i.tStart < 209.6 && i.tEnd > 209.3);
    check("AB: wrist_hyperbend reported around 209.3–209.6 s", !!hb, hb ? `${hb.tStart}–${hb.tEnd} s: ${hb.detail}` : "not found");
  } else {
    console.log("SKIP  AndroidBana acceptance test (pass --ab <ab_excerpt.wanim>)");
  }

  // ---- 7. CLI --------------------------------------------------------------------------
  {
    const wry = (...args) => {
      const r = spawnSync(process.execPath, [join(repo, "cli", "wry.mjs"), ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    };
    const scan = wry("scan", samplePath, "--max", "5");
    check("cli: scan prints one JSON document, exit 0", scan.code === 0 && Array.isArray(scan.json?.issues), `exit ${scan.code}`);
    const s = openSession(src, { name: "cli" });
    const t = s.timeOf(Math.floor(s.frames / 2));
    const script = join(tmp, "fix.json");
    writeFileSync(script, JSON.stringify({ denyBones: ["LeftHandAll"], ops: [
      { op: "layer.create", name: "cli", mode: "additive", fade: 0.25 },
      { op: "key.set", layer: "cli", bone: "RightHand", time: t, value: { flex: 15 } },
    ] }));
    const out = join(tmp, "out.wanim");
    const rig = join(tmp, "out.rig.json");
    const ed = wry("edit", samplePath, script, "-o", out, "--save-rig", rig, "--time-offset", "0");
    check("cli: edit script writes a timing-exact .wanim + .rig.json", ed.code === 0 && existsSync(out) && existsSync(rig) && ed.json?.export?.preserveTiming === true,
      `exit ${ed.code} ${ed.json?.error ?? ""}`);
    if (ed.code === 0) {
      const cmp = compare(rawSrc, parse(bytesOf(out)));
      check("cli: edit output — timestamps identical, only RightHand changed", cmp.times && cmp.changed.size === 1 && cmp.changed.has(18));
      const df = wry("diff", samplePath, "--rig", rig, "--time-offset", "0");
      check("cli: diff --rig reports the same single bone", df.code === 0 && df.json?.bonesChanged?.join() === "RightHand", `${df.json?.bonesChanged}`);
      const ex = wry("export", samplePath, "--rig", rig, "-o", join(tmp, "out2.wanim"), "--time-offset", "0");
      const same = ex.code === 0 && Buffer.compare(readFileSync(out), readFileSync(join(tmp, "out2.wanim"))) === 0;
      check("cli: export --rig reproduces the edit output byte for byte", same, `exit ${ex.code}`);
    }
    const again = wry("edit", samplePath, script, "-o", out, "--time-offset", "0");
    check("cli: refuses to overwrite an existing output (exit 2, JSON error)", again.code === 2 && typeof again.json?.error === "string", `exit ${again.code}`);
    writeFileSync(script, JSON.stringify({ denyBones: ["LeftHandAll"], ops: [{ op: "limit.apply", bones: ["LeftHand"], t0: t, t1: t }] }));
    const denied = wry("edit", samplePath, script, "-o", join(tmp, "never.wanim"), "--time-offset", "0");
    check("cli: a denied edit fails (exit 1), names the step, writes nothing",
      denied.code === 1 && /step 1.*deny list/.test(denied.json?.error ?? "") && !existsSync(join(tmp, "never.wanim")), `exit ${denied.code}: ${denied.json?.error ?? ""}`);
    const resample = wry("convert", samplePath, "-o", join(tmp, "r.wanim"));
    check("cli: convert refuses to resample a .wanim without --resample", resample.code === 2 && /RESAMPLE/.test(resample.json?.error ?? ""), `exit ${resample.code}`);
    const fbx = wry("convert", samplePath, "-o", join(tmp, "a.fbx"), "--mesh", "none");
    const head = fbx.code === 0 ? readFileSync(join(tmp, "a.fbx")).subarray(0, 18).toString("latin1") : "";
    check("cli: convert writes a binary FBX", fbx.code === 0 && head === "Kaydara FBX Binary", `exit ${fbx.code} ${fbx.json?.error ?? ""}`);
    const bad = wry("scan", join(tmp, "missing.wanim"));
    check("cli: a missing file is a usage error (exit 2, JSON error)", bad.code === 2 && typeof bad.json?.error === "string", `exit ${bad.code}`);
  }

  // ---- 8. MCP ---------------------------------------------------------------------------
  {
    const child = spawn(process.execPath, [join(repo, "cli", "wry.mjs"), "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    let buf = "";
    let junk = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); } catch { junk++; }
      }
    });
    let id = 0;
    const rpc = (method, params) => new Promise((res, rej) => {
      const my = ++id;
      const timer = setTimeout(() => rej(new Error(`mcp: ${method} timed out`)), 60000);
      pending.set(my, (m) => { clearTimeout(timer); res(m); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    });
    const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
    try {
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apiCheck", version: "0" } });
      check("mcp: initialize negotiates the protocol version", init.result?.protocolVersion === "2025-06-18" && !!init.result?.capabilities?.tools && init.result?.serverInfo?.name === "wryanimator");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const list = (await rpc("tools/list", {})).result?.tools ?? [];
      const names = new Set(list.map((t) => t.name));
      const needed = ["wry_open", "wry_scan", "wry_evaluate", "wry_diff", "wry_layer_create", "wry_layer_set", "wry_layer_delete", "wry_key_set",
        "wry_key_delete", "wry_key_list", "wry_hold_insert", "wry_limit_apply", "wry_filter_add", "wry_filter_delete", "wry_save_rig", "wry_export_wanim"];
      check("mcp: one tool per operation, each with an object input schema",
        needed.every((n) => names.has(n)) && list.every((t) => t.inputSchema?.type === "object" && t.description) && list.length === OPS.length + 10,
        `${list.length} tools; missing [${needed.filter((n) => !names.has(n))}]`);
      const open = await call("wry_open", { file: samplePath, timeOffset: 0, denyBones: ["LeftHandAll"] });
      const sid = open.structuredContent?.session;
      check("mcp: wry_open opens by local path and returns a session id", !open.isError && typeof sid === "string", open.content?.[0]?.text?.slice(0, 80));
      const scan = await call("wry_scan", { session: sid, max: 3 });
      check("mcp: wry_scan returns structured issues", !scan.isError && Array.isArray(scan.structuredContent?.issues));
      const s = openSession(src, { name: "mcp" });
      const t = s.timeOf(Math.floor(s.frames / 2));
      const denied = await call("wry_limit_apply", { session: sid, bones: ["LeftHand"], t0: t, t1: t });
      check("mcp: a denied bone is a tool error the model can read (isError), not a crash", denied.isError === true && /deny list/.test(denied.content?.[0]?.text ?? ""));
      await call("wry_layer_create", { session: sid, name: "m", mode: "override", fade: 0.2 });
      const key = await call("wry_key_set", { layer: "m", bone: "RightHand", time: t, value: { flex: 10, deviation: 0 } });
      check("mcp: wry_key_set works with the session id omitted (one session open)", !key.isError && Math.abs(key.structuredContent?.after?.flex - 10) < 1e-3, key.content?.[0]?.text?.slice(0, 80));
      const diff = await call("wry_diff", {});
      check("mcp: wry_diff shows only the edited bone", diff.structuredContent?.bonesChanged?.join() === "RightHand");
      const out = join(tmp, "mcp.wanim");
      const ex = await call("wry_export_wanim", { out });
      const cmp = !ex.isError && existsSync(out) ? compare(rawSrc, parse(bytesOf(out))) : null;
      check("mcp: wry_export_wanim writes a timing-exact file", !!cmp && cmp.times && cmp.changed.size === 1 && cmp.changed.has(18) && cmp.face, ex.content?.[0]?.text?.slice(0, 80));
      const unknown = await rpc("tools/call", { name: "wry_nope", arguments: {} });
      check("mcp: unknown tool is a protocol error (-32602)", unknown.error?.code === -32602);
      const ping = await rpc("ping", {});
      check("mcp: stdout carried only protocol messages", junk === 0 && !!ping.result);
    } catch (err) {
      check("mcp: server answers", false, err.message);
    } finally {
      child.stdin.end();
      await new Promise((r) => { child.on("close", r); setTimeout(() => { child.kill(); r(); }, 3000); });
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("OK");
