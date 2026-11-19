// MCP server (stdio transport): the agent's primary interface to WRYAnimator.
//
//   wry_open  →  wry_scan / wry_evaluate  →  wry_limit_apply / wry_hold_insert /
//   wry_key_set / wry_filter_add …  →  wry_diff  →  wry_export_wanim
//
// Files are opened BY LOCAL PATH (no size limit) and sessions live in memory,
// addressed by id. There is one tool per operation in src/api/ops.ts — the
// same table the CLI and edit scripts use — plus open/close, rig save/load,
// timing-exact export, and the one-shot info / convert tools.
//
// Hand-rolled and dependency-free like the rest of the repo: MCP over stdio is
// newline-delimited JSON-RPC 2.0 and only the tools slice is needed here.
// Start it with `node cli/wry.mjs mcp` (or `npm run mcp`). stdout carries ONLY
// protocol messages; logs and three.js warnings go to stderr.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { schemaProps } from "./options.mjs";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const FILE_PROP = { type: "string", description: "Absolute path to the file on this machine." };
const SESSION_PROP = {
  type: "string",
  description: "Session id returned by wry_open. May be omitted while exactly one session is open.",
};
const BONE_LIST = (what) => ({
  type: "array",
  items: { type: ["string", "integer"] },
  description: `${what} Unity HumanBodyBones names ("LeftHand"), indexes, * globs, or groups LeftHandAll / RightHandAll / LeftFingers / RightFingers.`,
});

const INSTRUCTIONS =
  "WRYAnimator, headless: inspect and repair Warudo motion-capture recordings (.wanim) with numeric, scoped edits. " +
  "Typical job: wry_open the take by path (set denyBones for anything that must not be touched), wry_scan to find problems " +
  "(each has a suggestedFix), wry_evaluate to read exact joint values, fix with wry_limit_apply / wry_hold_insert / " +
  "wry_key_set / wry_filter_add, re-scan, check wry_diff (only the intended bones and frames changed; small edgeStepDeg), " +
  "then wry_export_wanim. Exports are TIMING-EXACT: same frame count, original timestamps, untouched bones and all face " +
  "blendshapes byte-identical — safe for takes synced to music and lip-sync. Edits never touch face blendshapes, and a " +
  "hand edit never spills onto the forearm. All times are seconds in the session's time base (see timeRange from wry_open). " +
  "Angles are degrees: wrist flex (+ palm-ward, − bent back), deviation (+ thumb side), twist (+ supination); finger curl " +
  "(+ closing, − hyperextended) and splay. Every edit is undoable (wry_undo).";

export async function serve() {
  // Nothing but protocol on stdout: route stray console.log to stderr.
  console.log = (...a) => console.error(...a);
  console.info = console.log;
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

  let core = null; // loaded lazily so `initialize` answers instantly
  const getCore = async () => (core ??= await import("./core.mjs"));

  /** id → { session, file } */
  const sessions = new Map();
  let nextId = 1;
  const pick = (c, id) => {
    if (id === undefined || id === null || id === "") {
      if (sessions.size === 1) return [...sessions.entries()][0];
      throw new c.UsageError(sessions.size ? `several sessions are open (${[...sessions.keys()].join(", ")}) — pass session` : "no session is open — call wry_open first");
    }
    const s = sessions.get(String(id));
    if (!s) throw new c.UsageError(`no session "${id}" (open: ${[...sessions.keys()].join(", ") || "none"})`);
    return [String(id), s];
  };

  // ---- local link: the web app watching these sessions live (cli/link.mjs) ----
  let link = null;
  const publish = (id) => {
    const s = sessions.get(id);
    if (!link || !s) return;
    link.publish(id, {
      name: s.session.name,
      frames: s.session.frames,
      getWanim: () => s.session.source,
      getRig: () => s.session.saveRig(),
    });
  };
  /** Tell the page a session changed; `at` is a session time to move its playhead to. */
  const touch = (id, at) => {
    const s = sessions.get(id);
    if (link && s) link.touch(id, typeof at === "number" ? at - s.session.timeOffset : undefined);
  };

  // ---- tool table (built once core is loaded, because ops live in src/api) ----
  let tools = null;
  const buildTools = async () => {
    if (tools) return tools;
    const c = await getCore();
    const t = [];
    const add = (name, title, description, readOnly, inputSchema, run) => t.push({ name, title, description, readOnly, inputSchema, run });
    const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

    add("wry_open", "Open a recording",
      "Open a Warudo .wanim recording (or a WRYAnimator .scene.json that embeds one) by local path as an editing session. " +
      "Returns the session id, the clip summary, the session's time range, and the bone scope. Set denyBones to bones that must " +
      "never be edited (e.g. [\"LeftHandAll\"] when the left hand holds a microphone driven elsewhere) — any operation that would " +
      "write one is refused. A file whose name contains TWISTFIX gets forearm-twist protection automatically. If an excerpt has a " +
      "sidecar <file>.json with sourceTimeStart, times are reported in the source take's seconds.",
      false,
      obj({
        file: FILE_PROP,
        timeOffset: { type: "number", description: "Seconds added to playback time for every time in this session (default: sidecar sourceTimeStart, else 0)." },
        denyBones: BONE_LIST("Bones no operation may write."),
        allowBones: BONE_LIST("If given, the ONLY bones operations may write."),
        rig: { type: "string", description: "Path of a .rig.json to load into the session (layers + filters)." },
        protectForearmTwist: { type: "boolean", description: "Refuse forearm twist edits. Default: true when the file name contains TWISTFIX." },
        character: { type: "integer", description: "Character index in a multi-character recording (default 0)." },
      }, ["file"]),
      (a) => {
        const { session, file, notes } = c.openFileSession(a.file, a);
        const id = `s${nextId++}`;
        sessions.set(id, { session, file });
        publish(id);
        return { session: id, file, ...session.status(), notes };
      });

    add("wry_close", "Close a session", "Close a session and free its memory. Unsaved edits are discarded.", false,
      obj({ session: SESSION_PROP }),
      (a) => { const [id] = pick(c, a.session); sessions.delete(id); link?.remove(id); return { closed: id, open: [...sessions.keys()] }; });

    add("wry_view", "Show the session in the web editor",
      "Show a session live in the WRYAnimator web editor (https://wryanimator.com) in the user's browser on this machine, so a " +
      "person can watch and review the edit: the page loads the recording straight from this local process (nothing is uploaded) " +
      "and updates after every operation, moving its playhead to where you are working. Returns a link; by default it also opens " +
      "the link in the default browser. The page is a viewer — edits still go through these tools. Call it again with `time` to " +
      "point the viewer at a moment.",
      false,
      obj({
        session: SESSION_PROP,
        time: { type: "number", description: "Move the viewer's playhead here (session seconds)." },
        open: { type: "boolean", description: "Open the link in the default browser (default true the first time, false afterwards)." },
      }),
      async (a) => {
        const [id, s] = pick(c, a.session);
        const first = !link;
        if (!link) {
          link = await (await import("./link.mjs")).startLink();
          for (const sid of sessions.keys()) if (sid !== id) publish(sid);
        }
        publish(id);
        if (typeof a.time === "number") touch(id, a.time);
        const opened = (a.open ?? first) ? link.openBrowser() : false;
        return {
          session: id, url: link.url(), code: link.code, opened, viewersConnected: link.viewers(),
          note: `${s.session.name} is now served to the web editor from 127.0.0.1:${link.port}. If the page did not open, give the user the url ` +
            "(or have them choose File > Connect to local agent… on wryanimator.com and paste the code). Works in Chrome, Edge and Firefox; " +
            "the browser may ask permission to reach devices on the local network — that is this link.",
        };
      });

    add("wry_sessions", "List open sessions", "The sessions currently open in this server, with their files and edit counts.", true,
      obj({}),
      () => ({ sessions: [...sessions.entries()].map(([id, s]) => ({ session: id, file: s.file, layers: s.session.edits.layers.length, filters: s.session.edits.cleanOps.length })) }));

    for (const op of c.OPS) {
      add(`wry_${op.name.replace(/\./g, "_")}`, op.title, op.description, !op.mutates,
        c.opSchema(op, { session: SESSION_PROP }),
        ({ session: sid, ...args }) => {
          const [id, s] = pick(c, sid);
          const result = c.runOp(s.session, { op: op.name, ...args });
          if (op.mutates) touch(id, args.time ?? args.t0);
          return { session: id, ...result };
        });
    }

    add("wry_export_wanim", "Export a timing-exact .wanim",
      "Write the session's edited motion as a .wanim that is TIMING-EXACT: the original frame count and float64 timestamps, with " +
      "only the edited (bone, frame) cells overwritten. Untouched bones, the root track, and all face blendshapes are byte-identical " +
      "to the source. Returns the exact frame range and bones that changed. Never overwrites the source file; refuses to replace " +
      "an existing file unless overwrite is true.",
      false,
      obj({
        session: SESSION_PROP,
        out: { type: "string", description: "Output path ending in .wanim (default: <name>_fixed.wanim next to the source)." },
        overwrite: { type: "boolean", description: "Replace an existing output file." },
      }),
      (a) => { const [id, s] = pick(c, a.session); return { session: id, ...c.exportSessionWanim(s.session, s.file, a.out, a) }; });

    add("wry_save_rig", "Save edits as .rig.json",
      "Save the session's layers and filters as a .rig.json. It can be reloaded later (wry_open rig / wry_load_rig) or opened in the " +
      "WRYAnimator web editor on the same recording to review the edit visually.",
      false,
      obj({ session: SESSION_PROP, path: { type: "string", description: "Output path ending in .rig.json." }, overwrite: { type: "boolean" } }, ["path"]),
      (a) => { const [id, s] = pick(c, a.session); return { session: id, ...c.saveRigFile(s.session, a.path, a) }; });

    add("wry_load_rig", "Load a .rig.json",
      "Replace the session's edits with a .rig.json (undoable). Refused if it writes a bone outside the session's scope.",
      false,
      obj({ session: SESSION_PROP, path: { type: "string", description: "Path of the .rig.json." } }, ["path"]),
      (a) => { const [id, s] = pick(c, a.session); const res = c.loadRigFile(s.session, a.path); touch(id); return { session: id, ...res }; });

    add("wry_info", "Describe a motion file",
      "Describe a .wanim, .scene.json or animation .fbx without opening a session: frames, duration, frame timing, bones (and bones " +
      "the avatar did not record), face blendshape channels, hips travel, and a scene's saved edits.",
      true,
      obj({ file: FILE_PROP, ...schemaProps("info") }, ["file"]),
      ({ file, ...bag }) => c.info(file, bag));

    add("wry_convert", "Convert to FBX / VRMA",
      "One-shot conversion of a .wanim / .scene.json / .fbx to FBX (binary 7.7, 55-bone Unity humanoid; MotionBuilder, Blender, " +
      "Maya, Unity) or VRMA (Warudo, VSeeFace, Unity). RESAMPLES to a fixed frame rate, so it is for delivery formats, not for " +
      "fixing a synced take — use a session and wry_export_wanim for that. Whole-clip cleaning (despike, smooth, fixFeet, …) runs " +
      "only when asked for.",
      false,
      obj({ file: FILE_PROP, ...schemaProps("convert") }, ["file"]),
      ({ file, ...bag }) => c.convert(file, bag));

    add("wry_unpack_scene", "Unpack a scene file",
      "Extract what a WRYAnimator .scene.json embeds — the original recording, the custom VRM/GLB body, and the rig state as " +
      ".rig.json — into a directory.",
      false,
      obj({ file: FILE_PROP, ...schemaProps("unpack") }, ["file"]),
      ({ file, ...bag }) => c.unpackScene(file, bag));

    tools = t;
    return t;
  };

  async function callTool(params) {
    const all = await buildTools();
    const tool = all.find((t) => t.name === params?.name);
    if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${params?.name}` } };
    const c = await getCore();
    try {
      const args = params.arguments ?? {};
      for (const k of tool.inputSchema.required ?? []) {
        if (args[k] === undefined) throw new c.UsageError(`${tool.name}: missing required argument "${k}"`);
      }
      const result = await tool.run(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result };
    } catch (err) {
      // Tool failures are results (isError), so the model can read and react.
      if (!c.isCallerError(err)) console.error(err);
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => { if (isRequest) send({ jsonrpc: "2.0", id, result }); };
    const fail = (code, message) => { if (isRequest) send({ jsonrpc: "2.0", id, error: { code, message } }); };
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "wryanimator", title: "WRYAnimator", version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return reply({});
      case "tools/list": {
        const all = await buildTools();
        return reply({
          tools: all.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
          })),
        });
      }
      case "tools/call": {
        const res = await callTool(params);
        return res.rpcError ? fail(res.rpcError.code, res.rpcError.message) : reply(res);
      }
      default:
        if (typeof method === "string" && method.startsWith("notifications/")) return undefined;
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  // Requests run one at a time, in arrival order (they are CPU-bound anyway).
  let queue = Promise.resolve();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
      // A response to a request we never sent: ignore. Anything else is malformed.
      if (msg && typeof msg === "object" && !Array.isArray(msg) && msg.id !== undefined && msg.method === undefined) return;
      send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    queue = queue.then(() => handle(msg)).catch((err) => {
      console.error(err);
      if (msg.id !== undefined && msg.id !== null) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      }
    });
  });
  await new Promise((done) => rl.on("close", done));
  await queue;
}
