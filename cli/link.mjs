// Local link: lets the WRYAnimator WEB APP (https://wryanimator.com, or a local
// dev build) watch the sessions this process is editing, live.
//
// The website is static and stays that way — nothing is ever uploaded. This
// is the opposite direction: a tiny HTTP server on 127.0.0.1 that the page
// (running in the user's own browser, on the same machine) reads from:
//
//   GET /<token>/events        Server-Sent Events: which session is active and its revision
//   GET /<token>/wanim/<id>    the recording's bytes
//   GET /<token>/rig/<id>      the current edits as .rig.json
//
// Safety: bound to 127.0.0.1 only; READ-ONLY (a page can look, never change a
// session); every path needs the random per-run token; and only the
// WRYAnimator site / localhost origins are answered. The token travels in
// the URL *fragment* (#agent=…), which browsers never send to the web host.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_SITE = "https://wryanimator.com/";
const DEFAULT_PORT = 47823;

const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o);

/**
 * Start the link server. Resolves once it is listening.
 *   site     page to open (default https://wryanimator.com/, or $WRY_SITE)
 *   origins  extra allowed page origins (default: the site's, plus localhost)
 */
export async function startLink(opts = {}) {
  const site = opts.site ?? process.env.WRY_SITE ?? DEFAULT_SITE;
  const allowed = new Set([new URL(site).origin, ...(opts.origins ?? []), ...(process.env.WRY_LINK_ORIGINS ?? "").split(",").filter(Boolean)]);
  const token = randomBytes(16).toString("hex");
  /** id → { name, frames, rev, focus, getWanim(), getRig() } */
  const sessions = new Map();
  let active = null;
  const clients = new Set();

  const state = () => JSON.stringify({
    active,
    sessions: [...sessions.entries()].map(([id, s]) => ({ id, name: s.name, frames: s.frames, rev: s.rev, focus: s.focus })),
  });
  const broadcast = () => {
    const msg = `event: state\ndata: ${state()}\n\n`;
    for (const res of clients) res.write(msg);
  };

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    // A page from anywhere else gets nothing — not even a CORS header.
    if (origin && !allowed.has(origin) && !isLocalOrigin(origin)) { res.writeHead(403).end(); return; }
    const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    if (req.method === "OPTIONS") {
      // Chrome's Private Network Access preflight (public site → loopback).
      res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" }).end();
      return;
    }
    const parts = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/").filter(Boolean);
    if (req.method !== "GET" || parts[0] !== token) { res.writeHead(404, cors).end(); return; }
    const [, what, id] = parts;
    if (what === "events") {
      res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`retry: 2000\nevent: state\ndata: ${state()}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const s = sessions.get(id);
    if (!s) { res.writeHead(404, cors).end(); return; }
    try {
      if (what === "wanim") {
        const bytes = s.getWanim();
        res.writeHead(200, { ...cors, "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" }).end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
      } else if (what === "rig") {
        res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }).end(s.getRig());
      } else res.writeHead(404, cors).end();
    } catch (err) {
      res.writeHead(500, cors).end(String(err?.message ?? err));
    }
  });
  // Keep SSE connections from being reaped as idle.
  const beat = setInterval(() => { for (const res of clients) res.write(": keep-alive\n\n"); }, 20000);
  beat.unref();

  const listen = (port) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  try { await listen(opts.port ?? DEFAULT_PORT); } catch { await listen(0); }
  const port = server.address().port;
  server.unref(); // never keeps the process alive on its own

  const url = () => `${site}${site.includes("#") ? "&" : "#"}agent=${port}-${token}`;

  return {
    port,
    code: `${port}-${token}`,
    url,
    viewers: () => clients.size,
    /** Add or replace a session the page can watch, and make it the active one. */
    publish(id, s) {
      sessions.set(id, { rev: 1, focus: null, ...s });
      active = id;
      broadcast();
    },
    /** The session changed: bump its revision; optionally move the page's playhead (playback seconds). */
    touch(id, focus) {
      const s = sessions.get(id);
      if (!s) return;
      s.rev++;
      if (typeof focus === "number" && Number.isFinite(focus)) s.focus = focus;
      active = id;
      broadcast();
    },
    remove(id) {
      sessions.delete(id);
      if (active === id) active = sessions.keys().next().value ?? null;
      broadcast();
    },
    /** Open the page in the user's default browser. */
    openBrowser() {
      const u = url();
      const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", u.replace(/&/g, "^&")]]
        : process.platform === "darwin" ? ["open", [u]] : ["xdg-open", [u]];
      try { spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); return true; } catch { return false; }
    },
    close() {
      clearInterval(beat);
      for (const res of clients) res.end();
      server.close();
    },
  };
}
