// Local agent link (browser side).
//
// The site is static and uploads nothing. When an AI agent (or the `wry`
// CLI) is editing a recording ON THIS COMPUTER, it serves that session on
// 127.0.0.1 (cli/link.mjs) and this page can watch it live: it pulls the
// recording and the current edits straight from that local process and
// refreshes after every operation. Read-only — the page never sends edits
// back.
//
// Connect by opening the link the agent prints (…/#agent=<port>-<token>) or
// with File > Connect to local agent… and pasting the code.
//
// Browser note: an https page may fetch http://127.0.0.1 in Chrome, Edge and
// Firefox (loopback is a trustworthy origin); Chrome may show a one-time
// "access devices on your local network" prompt. Safari blocks it.

export interface AgentHost {
  /** Open a recording as the current session (replaces whatever is loaded). */
  loadRecording(name: string, bytes: ArrayBuffer): Promise<void>;
  /** Replace the session's rig state (layers, filters, …) with a .rig.json document. */
  applyRig(doc: Record<string, unknown>): Promise<void>;
  /** Pause and move the playhead (playback seconds). */
  seek(time: number): void;
}

interface LinkSession { id: string; name: string; frames: number; rev: number; focus: number | null; }
interface LinkState { active: string | null; sessions: LinkSession[]; }

const CODE = /(\d{2,5})-([0-9a-f]{16,64})/i;

/** Pull "<port>-<token>" out of a pasted link, a #agent=… fragment, or a bare code. */
export function parseAgentCode(text: string): { port: number; token: string } | null {
  const m = CODE.exec(text.trim());
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return { port, token: m[2].toLowerCase() };
}

export interface AgentLink {
  /** Connect with a pasted link / code. Returns false if it isn't one. */
  connect(text: string): boolean;
  disconnect(): void;
  connected(): boolean;
}

export function initAgentLink(host: AgentHost): AgentLink {
  let es: EventSource | null = null;
  let base = "";
  let live = false;
  // What the page currently shows, so only real changes trigger work.
  let shownId: string | null = null;
  let shownRev = -1;
  let shownFocus: number | null = null;
  let queue: Promise<void> = Promise.resolve();

  const pill = document.createElement("button");
  pill.className = "agent-pill";
  pill.hidden = true;
  pill.title = "Local agent link — click to disconnect";
  document.body.appendChild(pill);
  const show = (text: string, state: "ok" | "wait" | "err") => {
    pill.hidden = false;
    pill.dataset.state = state;
    pill.textContent = text;
  };
  pill.addEventListener("click", () => {
    const stuck = pill.dataset.state === "err"
      ? "Can't reach the local agent. Check that:\n" +
        "  • the agent (or `wry`) is still running on this computer;\n" +
        "  • this site is allowed to reach local devices — if the browser asked and it was blocked, open the site " +
        "settings (the icon left of the address) and allow \"Local network access\", then reload;\n" +
        "  • you are using Chrome, Edge or Firefox (Safari blocks this).\n\n"
      : "";
    if (window.confirm(`${stuck}Disconnect from the local agent? The recording stays open here.`)) api.disconnect();
  });

  async function sync(state: LinkState): Promise<void> {
    const s = state.sessions.find((x) => x.id === state.active) ?? state.sessions[0];
    if (!s) {
      show("Agent: connected — no session open yet", "wait");
      return;
    }
    if (s.id !== shownId) {
      show(`Agent: loading ${s.name}…`, "wait");
      const res = await fetch(`${base}/wanim/${s.id}`);
      if (!res.ok) throw new Error(`recording fetch failed (${res.status})`);
      // A distinct name keeps the agent's edits out of this browser's own
      // per-recording edit cache for the same file.
      await host.loadRecording(`[agent] ${s.name}`, await res.arrayBuffer());
      shownId = s.id;
      shownRev = -1;
      shownFocus = null;
      // Let the fresh session's first rebuild start before edits land on it.
      await new Promise((r) => setTimeout(r, 60));
    }
    if (s.rev !== shownRev) {
      const res = await fetch(`${base}/rig/${s.id}`);
      if (!res.ok) throw new Error(`edits fetch failed (${res.status})`);
      await host.applyRig((await res.json()) as Record<string, unknown>);
      shownRev = s.rev;
    }
    if (s.focus !== null && s.focus !== shownFocus) {
      host.seek(s.focus);
      shownFocus = s.focus;
    }
    show(`Agent: live — ${s.name}`, "ok");
  }

  const api: AgentLink = {
    connect(text: string): boolean {
      const code = parseAgentCode(text);
      if (!code) return false;
      api.disconnect();
      base = `http://127.0.0.1:${code.port}/${code.token}`;
      show("Agent: connecting…", "wait");
      es = new EventSource(`${base}/events`);
      es.addEventListener("state", (ev) => {
        live = true;
        let state: LinkState;
        try { state = JSON.parse((ev as MessageEvent<string>).data) as LinkState; } catch { return; }
        // One at a time, newest last: a burst of operations settles on the final state.
        queue = queue.then(() => sync(state)).catch((err) => {
          show(`Agent: ${err instanceof Error ? err.message : String(err)}`, "err");
        });
      });
      es.onerror = () => {
        // EventSource retries by itself; say so rather than going silent.
        show(live ? "Agent: connection lost — retrying…" : "Agent: can't connect — click for help (retrying…)", "err");
        live = false;
      };
      return true;
    },
    disconnect(): void {
      es?.close();
      es = null;
      live = false;
      shownId = null;
      shownRev = -1;
      pill.hidden = true;
    },
    connected: () => es !== null,
  };

  // A link from the agent carries the code in the fragment (never sent to the web host).
  const fromHash = /[#&]agent=([^&]+)/.exec(window.location.hash);
  if (fromHash) api.connect(decodeURIComponent(fromHash[1]));
  return api;
}
