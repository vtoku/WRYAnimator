#!/usr/bin/env node
// wry — WRYAnimator on the command line: the same numeric editing API the MCP
// server exposes (src/api), plus one-shot format conversion. No browser.
//
//   node cli/wry.mjs <command> [args]      (or `npm run wry -- <command> …`,
//                                            or `wry …` after `npm link`)
//
// Conventions for scripts and agents:
//   - stdout is ONE JSON document, always (pass --text for a human summary
//     where one exists); warnings and notes go to stderr
//   - errors are {"error": "..."} on stdout with a nonzero exit
//   - exit 0 = ok, 1 = failed, 2 = bad usage
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { parseArgsConfig, bagFromArgs, helpFor, kebab } from "./options.mjs";

const SESSION_FLAGS = [
  ["time-offset", "<s>", "Seconds added to playback time, so an excerpt answers to its source take's times. Default: `sourceTimeStart` from a sidecar <file>.json if present, else 0."],
  ["deny", "<bones>", "Comma-separated bones no operation may write (names, indexes, globs, LeftHandAll / RightFingers …)."],
  ["allow", "<bones>", "Comma-separated bones that are the ONLY ones operations may write."],
  ["rig", "<file>", "Load a .rig.json (layers + filters) into the session first."],
  ["no-protect-twist", "", "Allow forearm twist edits on a *TWISTFIX* file (protected by default)."],
];

const COMMANDS = {
  info: { args: "<file>", about: "Describe a .wanim / .scene.json / .fbx: frames, timing, bones, face channels, saved edits." },
  scan: { args: "<file.wanim>", op: "scan", about: "Find problems (wrist hyperbend / flips, finger claw, pops, jitter, foot slide …), ranked, each with a suggested fix." },
  evaluate: { args: "<file.wanim> --bones …", op: "evaluate", about: "Read exact joint values (quat, Euler, wrist flex/deviation/twist, finger curl/splay), base and edited." },
  edit: { args: "<file.wanim> <script.json> [-o out.wanim]", about: "Run an edit script (a list of operations) and write a timing-exact .wanim and/or a .rig.json." },
  diff: { args: "<file.wanim> --rig edits.rig.json", op: "diff", about: "What a rig changes versus the recording: bones, frame ranges, max change, edge steps." },
  export: { args: "<file.wanim> [--rig edits.rig.json] -o out.wanim", about: "Write a timing-exact .wanim: original timestamps and frame count, only edited cells changed." },
  ops: { args: "[name]", about: "List the editing operations (for edit scripts), or show one operation's arguments." },
  convert: { args: "<file> -o out.fbx|.vrma", about: "One-shot conversion to FBX / VRMA (resamples to a fixed frame rate), with optional whole-clip cleaning." },
  unpack: { args: "<file.scene.json>", about: "Extract the recording, custom body and rig state embedded in a scene file." },
  mcp: { args: "", about: "Run as an MCP server on stdio (for Claude Code / Claude Desktop / other agents)." },
};

class Usage extends Error {}

function mainHelp(version) {
  const w = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  return [
    `wry ${version} — WRYAnimator command line`,
    "",
    "Usage: wry <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([c, d]) => `  ${c.padEnd(w)}  ${d.about}`),
    "",
    "Output is one JSON document on stdout. Errors are {\"error\": …} with a nonzero exit.",
    "  --text      Human-readable summary instead of JSON (info, scan, convert)",
    "  -h, --help  Help for wry or for a command (wry scan --help)",
    "  --version   Print the version",
    "",
    "Examples:",
    "  wry scan take.wanim --bones RightHandAll",
    "  wry evaluate take.wanim --bones RightHand --t0 190 --t1 193 --step 6",
    "  wry edit take.wanim fix.json -o take_fixed.wanim --save-rig take.rig.json",
    "  wry diff take.wanim --rig take.rig.json",
    "  wry convert take.wanim -o take.fbx --names motionbuilder",
    "",
    "An edit script is {\"denyBones\": [\"LeftHandAll\"], \"ops\": [{\"op\": \"limit.apply\", \"bones\": [\"RightHand\"], \"t0\": 190, \"t1\": 193}]}.",
    "`wry ops` lists every operation.",
  ].join("\n");
}

const sessionHelp = () => {
  const w = Math.max(...SESSION_FLAGS.map(([f, a]) => `--${f} ${a}`.length));
  return SESSION_FLAGS.map(([f, a, d]) => `  ${`--${f} ${a}`.padEnd(w)}  ${d}`).join("\n");
};

function opFlagHelp(op) {
  const rows = Object.entries(op.properties).map(([k, p]) => {
    const t = Array.isArray(p.type) ? p.type.join("|") : p.type;
    const arg = t === "boolean" ? "" : t === "array" ? " <a,b,…>" : t === "object" ? " <json>" : p.enum ? ` <${p.enum.join("|")}>` : " <value>";
    return [`--${kebab(k)}${arg}${op.required.includes(k) ? " (required)" : ""}`, p.description ?? ""];
  });
  if (!rows.length) return "  (no arguments)";
  const w = Math.min(34, Math.max(...rows.map((r) => r[0].length)));
  return rows.map(([l, d]) => `  ${l.padEnd(w)}  ${d}`).join("\n");
}

async function commandHelp(cmd) {
  const d = COMMANDS[cmd];
  const lines = [`Usage: wry ${cmd} ${d.args}`.trimEnd(), "", d.about];
  if (d.op) {
    const { getOp } = await import("./core.mjs");
    lines.push("", "Options:", opFlagHelp(getOp(d.op)), "", "Session options:", sessionHelp());
  } else if (cmd === "edit") {
    lines.push("", "Options:",
      "  -o, --out <file>    Timing-exact .wanim to write (default <name>_fixed.wanim next to the input, unless --save-rig is the only output).",
      "  --save-rig <file>   Also write the edits as .rig.json (opens in the web editor on the same recording).",
      "  --dry-run           Run the script and report the diff; write nothing.",
      "  --overwrite         Replace existing output files.",
      "", "Session options (override the script's own timeOffset / denyBones / allowBones):", sessionHelp(),
      "", "Script: {\"timeOffset\"?, \"denyBones\"?, \"allowBones\"?, \"ops\": [{\"op\": …}, …]} or a bare array. Use - to read it from stdin.",
      "All-or-nothing: if any step fails, nothing is written.");
  } else if (cmd === "export") {
    lines.push("", "Options:",
      "  -o, --out <file>  Output .wanim (default <name>_fixed.wanim next to the input).",
      "  --overwrite       Replace an existing output file.",
      "", "Session options:", sessionHelp(),
      "", "For FBX / VRMA output use `wry convert`.");
  } else if (cmd === "ops") {
    lines.push("", "With a name (e.g. `wry ops limit.apply`) prints that operation's JSON schema.");
  } else if (cmd !== "mcp") {
    lines.push("", "Options:", helpFor(cmd), "", "Boolean options accept a --no- prefix (e.g. --no-face) to override a scene's saved value.");
  }
  return lines.join("\n");
}

// ---- argument mapping ------------------------------------------------------------

const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));

function sessionOptions(values) {
  const o = {};
  if (values["time-offset"] !== undefined) {
    o.timeOffset = Number(values["time-offset"]);
    if (!Number.isFinite(o.timeOffset)) throw new Usage(`--time-offset needs a number, got ${JSON.stringify(values["time-offset"])}`);
  }
  if (values.deny !== undefined) o.denyBones = list(values.deny);
  if (values.allow !== undefined) o.allowBones = list(values.allow);
  if (values.rig !== undefined) o.rig = values.rig;
  if (values["no-protect-twist"]) o.protectForearmTwist = false;
  return o;
}

const SESSION_PARSE = {
  "time-offset": { type: "string" }, deny: { type: "string" }, allow: { type: "string" }, rig: { type: "string" },
  "no-protect-twist": { type: "boolean" },
};

/** Build an operation's argument object from CLI flags, driven by its JSON schema. */
function opArgsFromFlags(op, values) {
  const args = {};
  for (const [k, p] of Object.entries(op.properties)) {
    const v = values[kebab(k)];
    if (v === undefined) continue;
    const types = Array.isArray(p.type) ? p.type : [p.type];
    if (types.includes("array")) args[k] = list(v);
    else if (types.includes("object")) {
      try { args[k] = JSON.parse(v); } catch { throw new Usage(`--${kebab(k)} needs JSON, got ${JSON.stringify(v)}`); }
    } else if (types.includes("boolean")) args[k] = v;
    else if (types.includes("number") || types.includes("integer")) {
      const n = Number(v);
      if (Number.isFinite(n) && v !== "") args[k] = n;
      else if (types.includes("string")) args[k] = v;
      else throw new Usage(`--${kebab(k)} needs a number, got ${JSON.stringify(v)}`);
    } else args[k] = v;
  }
  return args;
}

function opParseConfig(op) {
  const options = { ...SESSION_PARSE };
  for (const [k, p] of Object.entries(op.properties)) {
    const types = Array.isArray(p.type) ? p.type : [p.type];
    options[kebab(k)] = { type: types.length === 1 && types[0] === "boolean" ? "boolean" : "string" };
  }
  return options;
}

// ---- text printers (opt-in) --------------------------------------------------------

const kv = (rows) => {
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.filter((r) => r[1] !== undefined && r[1] !== "").map(([k, v]) => `${k.padEnd(w)}  ${v}`).join("\n");
};
const short = (a, max = 8) => (a.length <= max ? a.join(", ") : `${a.slice(0, max).join(", ")}, … (${a.length} total)`);
const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} kB`);

const TEXT = {
  info(r) {
    const c = r.clip;
    const rows = [
      ["file", r.file],
      ["kind", r.kind === r.source ? r.kind : `${r.kind} (embedded ${r.source})`],
      ["frames", `${c.frames}`],
      ["duration", `${c.durationS} s`],
      ["rate", `${c.avgFps} fps avg (frame gaps ${c.minDtMs}–${c.maxDtMs} ms)`],
      ["starts at", `${c.startTimeS} s`],
      ["characters", r.characters !== undefined ? `${r.characters}` : undefined],
      ["takes", r.takes ? r.takes.map((t) => `${t.name} (${t.durationS} s)`).join(", ") : undefined],
      ["bones", `${c.bones}${c.deadBones.length ? ` (not recorded: ${short(c.deadBones)})` : ""}`],
      ["face", c.faceChannels.length ? `${c.faceChannels.length} blendshape channels` : "none"],
      ["hips", `start [${c.hips.startM.join(", ")}] m, floor travel ${c.hips.travelM} m`],
    ];
    if (r.scene) {
      const e = r.scene.edits;
      rows.push(
        ["scene", `v${r.scene.version}${r.scene.customBody ? `, custom body ${r.scene.customBody}` : ""}`],
        ["  filters", e.filters.length ? e.filters.join(", ") : "none"],
        ["  proportions", e.proportions],
        ["  rig", `${e.rigLayers.length} layer(s), ${e.rigKeys} key(s)`],
      );
    }
    return kv(rows);
  },
  scan(r) {
    if (!r.issues.length) return "no issues found";
    return r.issues.map((i) =>
      `${String(i.severity).padStart(6)}  ${i.kind.padEnd(22)} ${String(i.tStart).padStart(9)}–${String(i.tEnd).padEnd(9)} ${i.detail}`).join("\n");
  },
  convert(r) {
    return kv([
      ["wrote", r.output],
      ["format", `${r.format}, ${mb(r.bytes)} (resampled)`],
      ["frames", `${r.frames} @ ${r.fps} fps (${r.durationS} s${r.speed !== 1 ? `, ${r.speed}× speed` : ""})`],
      ["range", `${r.trimS.start}–${r.trimS.end} s of the source`],
      ["proportions", r.proportions],
      ["bones", r.boneNames ? `${r.boneNames} names, ${r.restPose} rest` : undefined],
      ["meshes", r.embeddedMeshes ? (r.embeddedMeshes.length ? r.embeddedMeshes.join("; ") : "none") : undefined],
      ["face", `${r.faceChannels} channel(s)`],
      ["filters", r.filters.length ? r.filters.join(", ") : "none"],
    ]);
  },
};

// ---- entry -------------------------------------------------------------------

async function main(argv) {
  const cmd = argv[0];
  const emit = (result, text) => {
    const { notes, ...rest } = result ?? {};
    if (text) console.log(text);
    else console.log(JSON.stringify(result, null, 2));
    if (text) for (const n of notes ?? []) console.error(`note: ${n}`);
    void rest;
  };
  const fail = (msg, code, extra = {}) => {
    console.log(JSON.stringify({ error: msg, ...extra }, null, 2));
    console.error(`wry: ${msg}`);
    return code;
  };

  if (cmd === "mcp") {
    const { serve } = await import("./mcp.mjs");
    await serve();
    return 0;
  }

  let core;
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      const topic = cmd === "help" ? argv[1] : undefined;
      if (topic && COMMANDS[topic]) console.log(await commandHelp(topic));
      else console.log(mainHelp((await import("./core.mjs")).VERSION));
      return 0;
    }
    if (cmd === "--version" || cmd === "-v") {
      console.log((await import("./core.mjs")).VERSION);
      return 0;
    }
    if (!COMMANDS[cmd]) throw new Usage(`unknown command "${cmd}" (try: ${Object.keys(COMMANDS).join(", ")})`);
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(await commandHelp(cmd));
      return 0;
    }
    core = await import("./core.mjs");
    const common = { text: { type: "boolean" }, json: { type: "boolean" } };
    const parse = (options) => {
      try {
        return parseArgs({ args: argv.slice(1), options: { ...common, ...options }, allowPositionals: true, allowNegative: true });
      } catch (err) {
        throw new Usage(err.message);
      }
    };
    const oneFile = (positionals) => {
      const [file, ...extra] = positionals;
      if (!file) throw new Usage(`missing input file — usage: wry ${cmd} ${COMMANDS[cmd].args}`);
      if (extra.length) throw new Usage(`unexpected argument "${extra[0]}"`);
      return file;
    };

    if (cmd === "ops") {
      const name = argv[1];
      if (name && !name.startsWith("-")) {
        const op = core.getOp(name);
        if (!op) throw new Usage(`unknown op "${name}" (run \`wry ops\` for the list)`);
        emit({ op: op.name, title: op.title, mutates: op.mutates, description: op.description, arguments: core.opSchema(op) });
      } else {
        emit({ ops: core.OPS.map((o) => ({ op: o.name, mutates: o.mutates, description: o.description, required: o.required, arguments: Object.keys(o.properties) })) });
      }
      return 0;
    }

    if (COMMANDS[cmd].op) {
      const op = core.getOp(COMMANDS[cmd].op);
      const { values, positionals } = parse(opParseConfig(op));
      const file = oneFile(positionals);
      const { session, notes } = core.openFileSession(file, sessionOptions(values));
      const result = core.runOp(session, { op: op.name, ...opArgsFromFlags(op, values) });
      const out = { file: session.name, timeRange: session.status().timeRange, ...result, notes };
      emit(out, values.text && TEXT[cmd] ? TEXT[cmd](out) : null);
      return 0;
    }

    if (cmd === "edit") {
      const { values, positionals } = parse({
        ...SESSION_PARSE, out: { type: "string", short: "o" }, "save-rig": { type: "string" }, "dry-run": { type: "boolean" }, overwrite: { type: "boolean" },
      });
      const [file, scriptPath, ...extra] = positionals;
      if (!file || !scriptPath) throw new Usage(`usage: wry edit ${COMMANDS.edit.args}`);
      if (extra.length) throw new Usage(`unexpected argument "${extra[0]}"`);
      let script;
      try {
        script = JSON.parse(readFileSync(scriptPath === "-" ? 0 : scriptPath, "utf8").replace(/^﻿/, ""));
      } catch (err) {
        throw new Usage(`edit script ${scriptPath}: ${err.message}`);
      }
      const { rig, ...so } = sessionOptions(values);
      emit(core.runEditScript(file, script, { ...so, rig, out: values.out, saveRig: values["save-rig"], dryRun: values["dry-run"], overwrite: values.overwrite }));
      return 0;
    }

    if (cmd === "export") {
      const { values, positionals } = parse({ ...SESSION_PARSE, out: { type: "string", short: "o" }, overwrite: { type: "boolean" } });
      const file = oneFile(positionals);
      if (values.out && !/\.wanim$/i.test(values.out)) {
        throw new Usage("`wry export` writes a timing-exact .wanim; for FBX / VRMA use `wry convert`");
      }
      const { session, file: abs, notes } = core.openFileSession(file, sessionOptions(values));
      emit({ ...core.exportSessionWanim(session, abs, values.out, { overwrite: values.overwrite }), diff: session.diff(), notes });
      return 0;
    }

    // One-shot commands driven by cli/options.mjs.
    const { values, positionals } = parse(parseArgsConfig(cmd));
    const file = oneFile(positionals);
    const bag = bagFromArgs(cmd, values, (m) => { throw new Usage(m); });
    const run = { info: core.info, convert: core.convert, unpack: core.unpackScene }[cmd];
    const result = await run(file, bag);
    emit(result, values.text && TEXT[cmd] ? TEXT[cmd](result) : null);
    return 0;
  } catch (err) {
    if (err instanceof Usage) return fail(err.message, 2);
    if (core && err instanceof core.UsageError) return fail(err.message, 2);
    if (core && err instanceof core.ApiError) return fail(err.message, 1, err.steps ? { completedSteps: err.steps } : {});
    if (process.env.WRY_DEBUG) console.error(err);
    return fail(err instanceof Error ? err.message : String(err), 1);
  }
}

process.exitCode = await main(process.argv.slice(2));
