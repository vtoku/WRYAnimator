// Options of the one-shot commands (info / convert / unpack). ONE table, used
// three ways: CLI flags (cli/wry.mjs), MCP tool input schemas (cli/mcp.mjs),
// and the --help text. Add an option here and it shows up everywhere;
// cli/core.mjs mergeOptions() is where it takes effect.
//
// The EDITING operations (scan, evaluate, limit.apply, ...) are not here: they
// live in src/api/ops.ts, which carries its own JSON schemas.
//
// type: "boolean" | "number" | "string" | "toggle-number"
//   toggle-number = on/off with an optional amount. CLI: `--despike` turns it
//   on, `--despike-deg 40` turns it on at 40, `--no-despike` turns it off.
//   MCP: true | false | number.

const SIDES = ["left", "right", "both"];

export const OPTIONS = [
  // -- input selection --
  { key: "character", type: "number", for: ["info", "convert"], desc: "Character index in a multi-character .wanim (default 0)." },
  { key: "take", type: "string", for: ["info", "convert"], desc: "FBX input only: take name or index (default: the longest take)." },

  // -- cleaning --
  { key: "despike", type: "toggle-number", amountFlag: "despike-deg", for: ["convert"], desc: "Remove single-frame pops / hand flips. Amount = jump threshold in degrees (default 35)." },
  { key: "smooth", type: "toggle-number", amountFlag: "cutoff-hz", for: ["convert"], desc: "Zero-lag Butterworth low-pass on rotations + hips. Amount = cutoff in Hz, lower is smoother (default 7)." },
  { key: "fixFeet", type: "boolean", for: ["convert"], desc: "Pin planted feet (no sliding) and keep them on the floor." },
  { key: "limitWrists", type: "boolean", for: ["convert"], desc: "Clamp wrist rotation to the human range." },
  { key: "limitForearms", type: "boolean", for: ["convert"], desc: "Clamp forearm axial twist to the human range." },
  { key: "lockWrists", type: "string", enum: SIDES, for: ["convert"], desc: "Freeze the hand's local rotation (hand follows the forearm)." },
  { key: "lockForearmTwist", type: "string", enum: SIDES, for: ["convert"], desc: "Zero the forearm's axial twist, keeping elbow bend." },
  { key: "noClean", type: "boolean", cliFlag: "no-clean", for: ["convert"], desc: "Ignore the cleaning toggles saved in a scene (flags given alongside still apply)." },

  // -- shape / edits --
  { key: "proportions", type: "string", enum: ["recorded", "body"], for: ["convert"], desc: "Skeleton proportions: the recorded avatar's (default for bare recordings) or the body mesh's skeleton. Ignored for wanim output." },
  { key: "body", type: "string", for: ["convert"], desc: "Path to a VRM/GLB to use as the body (proportions + mesh). Default: the scene's embedded body, else the bundled one." },
  { key: "spreadSpine", type: "toggle-number", amountFlag: "spread-spine-amt", for: ["convert"], desc: "Spread a spine bend concentrated on one joint across the spine. Amount 0..1 (default 0.5)." },
  { key: "mirror", type: "boolean", for: ["convert"], desc: "Swap left/right across the whole clip." },
  { key: "hipsHeightCm", type: "number", for: ["convert"], desc: "Raise/lower the hips in cm; feet stay planted." },
  { key: "rig", type: "string", for: ["convert"], desc: "Path to a .rig.json (or a scene) whose layers, modifiers, time warp and filter stack to apply." },

  // -- output --
  { key: "out", type: "string", short: "o", for: ["convert"], desc: "Output path. The extension picks the format; a directory needs --format. Default: <name>_cleaned.<format> next to the input." },
  { key: "format", type: "string", short: "f", enum: ["fbx", "vrma", "anim", "wanim"], for: ["convert"], desc: "Output format, when not implied by the output path. anim = Unity humanoid .anim (BETA)." },
  { key: "facePath", type: "string", for: ["convert"], desc: "anim only: hierarchy path of the mesh that owns the face blendshapes (default \"Face\", the usual name in a VRM import)." },
  { key: "tposeHipsHeight", type: "number", for: ["convert"], desc: "anim only: the avatar's hips height above the ground in its T-pose, meters. Default: estimated from where the feet rest in the take." },
  { key: "keyTolerance", type: "number", for: ["convert"], desc: "anim only: key reduction tolerance in muscle units (default 0.002; 0 keeps every frame, larger = smaller file)." },
  { key: "overwrite", type: "boolean", for: ["convert", "unpack"], desc: "Replace an existing output file." },
  { key: "resample", type: "boolean", for: ["convert"], desc: "Required to write a .wanim here: convert RESAMPLES (new frame count + timestamps, breaks audio sync). For a timing-exact .wanim use `wry export` / `wry edit`." },
  { key: "fps", type: "number", for: ["convert"], desc: "Output frame rate, 1-240 (default 60, or the scene's)." },
  { key: "speed", type: "number", for: ["convert"], desc: "Retime: 2 plays twice as fast, 0.5 half speed (0.25-4)." },
  { key: "trimStart", type: "number", for: ["convert"], desc: "Start of the exported range, seconds from clip start." },
  { key: "trimEnd", type: "number", for: ["convert"], desc: "End of the exported range, seconds from clip start." },
  { key: "names", type: "string", enum: ["unity", "motionbuilder"], for: ["convert"], desc: "FBX bone names: Unity HumanBodyBones (default) or MotionBuilder/HumanIK (auto-characterizes)." },
  { key: "rest", type: "string", enum: ["tpose", "first"], for: ["convert"], desc: "FBX rest pose: T-pose (default) or the first frame." },
  { key: "face", type: "boolean", for: ["convert"], desc: "Export recorded face blendshapes (default on; --no-face drops them)." },
  { key: "mesh", type: "string", enum: ["none", "face", "body", "all"], for: ["convert"], desc: "FBX only: skinned meshes to embed. Default 'face' (the stand-in head that carries the face blendshape animation); 'none' = skeleton + animation only." },
  { key: "takeName", type: "string", for: ["convert"], desc: "FBX take name (default: the output file's base name)." },

  // -- unpack --
  { key: "outDir", type: "string", for: ["unpack"], desc: "Directory to write the unpacked files into (default: next to the scene)." },
];

export const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
export const flagOf = (opt) => opt.cliFlag ?? kebab(opt.key);
export const optionsFor = (cmd) => OPTIONS.filter((o) => o.for.includes(cmd));

/** JSON Schema `properties` for an MCP tool taking this command's options. */
export function schemaProps(cmd) {
  const props = {};
  for (const o of optionsFor(cmd)) {
    const p = { description: o.desc };
    if (o.type === "toggle-number") p.type = ["boolean", "number"];
    else p.type = o.type;
    if (o.enum) p.enum = o.enum;
    props[o.key] = p;
  }
  return props;
}

/** `options` config for node:util parseArgs. */
export function parseArgsConfig(cmd) {
  const options = { json: { type: "boolean" }, help: { type: "boolean", short: "h" } };
  for (const o of optionsFor(cmd)) {
    const flag = flagOf(o);
    if (o.type === "toggle-number") {
      options[flag] = { type: "boolean" };
      options[o.amountFlag] = { type: "string" };
    } else if (o.type === "boolean") {
      // "no-clean" is itself the positive spelling of the noClean key.
      options[flag] = { type: "boolean" };
    } else {
      options[flag] = { type: "string" };
    }
    if (o.short) options[flag].short = o.short;
  }
  return options;
}

/** Turn parseArgs `values` into the flat option bag core.mjs expects. */
export function bagFromArgs(cmd, values, fail) {
  const bag = {};
  const toNum = (v, flag) => {
    const n = Number(v);
    if (v === "" || !Number.isFinite(n)) fail(`--${flag} needs a number, got ${JSON.stringify(v)}`);
    return n;
  };
  for (const o of optionsFor(cmd)) {
    const flag = flagOf(o);
    const v = values[flag];
    if (o.type === "toggle-number") {
      const amt = values[o.amountFlag];
      if (v === false) bag[o.key] = false;
      else if (amt !== undefined) bag[o.key] = toNum(amt, o.amountFlag);
      else if (v === true) bag[o.key] = true;
    } else if (v !== undefined) {
      if (o.type === "number") bag[o.key] = toNum(v, flag);
      else bag[o.key] = v;
    }
  }
  return bag;
}

export function helpFor(cmd) {
  const rows = [];
  for (const o of optionsFor(cmd)) {
    const flag = flagOf(o);
    let left = `${o.short ? `-${o.short}, ` : "    "}--${flag}`;
    if (o.type === "number") left += " <n>";
    else if (o.type === "string") left += o.enum ? ` <${o.enum.join("|")}>` : " <value>";
    rows.push([left, o.desc]);
    if (o.type === "toggle-number") rows.push([`    --${o.amountFlag} <n>`, `Turn --${flag} on with this amount.`]);
  }
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([l, d]) => `  ${l.padEnd(w)}  ${d}`).join("\n");
}
