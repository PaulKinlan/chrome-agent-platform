// scripts/acp-bridge.ts — Loopback WebSocket-to-stdio bridge for ACP harnesses.
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)
//
// Bridges Chrome Extension WebSocket connections to a locally spawned ACP adapter (e.g. pi-acp).
// Usage: npm run acp:bridge [--port 3210] [--adapter path/to/adapter] [--cwd /working/dir]
//
// Host defaults the extension cannot know live HERE, never as source literals:
// the adapter path and the session working directory resolve from $HOME at run
// time, and a `session/new`/`session/load` arriving without a cwd gets the
// bridge's --cwd (default $HOME/journal). A machine-path literal in the
// extension would be wrong on every other machine (3khn/evidence-durable).

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, {
  string: ["port", "adapter", "harness", "cwd", "token", "allow-origin"],
  collect: ["allow-origin"],
  default: {
    port: "3210",
    adapter: "",
    harness: "pi",
    cwd: "",
    token: "",
    "allow-origin": [],
  },
});

const PORT = parseInt(args.port, 10);
const ADAPTER_PATH = args.adapter;
const HARNESS = args.harness;

const HOME = Deno.env.get("HOME") ?? "";

/** Extra origin prefixes `--allow-origin` admitted (repeatable). */
const ALLOWED_ORIGIN_PREFIXES = (Array.isArray(args["allow-origin"]) ? args["allow-origin"] : []).filter(Boolean);

/** Shared-secret requirement (`--token`): when set, the upgrade URL must carry
 * `?token=…`, binding the bridge to one client even on a shared machine. */
const TOKEN = String(args.token ?? "");

/** May this WebSocket Origin drive the harness? Browsers ALWAYS send Origin on
 * an upgrade, so an ABSENT one is a local script (deno/node test clients).
 * Default: extension pages only. `--allow-origin <prefix>` admits others
 * explicitly, and `--token` adds the shared-secret requirement on top. The
 * residual is documented: any INSTALLED extension matches the extension
 * scheme, so the token (or naming one extension in --allow-origin) is how an
 * operator binds the bridge to a single client. */
function originAllowed(origin: string | null): boolean {
  if (!origin) return true; // local script client
  if (ALLOWED_ORIGIN_PREFIXES.some((p) => origin.startsWith(p))) return true;
  return /^(chrome|moz)-extension:\/\//.test(origin);
}

/** The adapter a bare `npm run acp:bridge` runs: $HOME at run time, never a
 * source literal. Fails loudly when HOME is unset and no --adapter was given. */
function defaultAdapterPath() {
  if (!HOME) throw new Error("HOME is not set — pass --adapter <path to the ACP adapter>");
  return `${HOME}/.pi/agent/npm/node_modules/pi-acp/dist/index.js`;
}

/** The working directory a session request without one gets (host-side default). */
function defaultCwd() {
  return args.cwd || (HOME ? `${HOME}/journal` : "");
}

/** Give a client frame the host defaults only the bridge knows: a session/new
 * or session/load with no working directory gets `hostCwd` (undefined = the
 * bridge's --cwd / $HOME/journal; "" = no host default configured, so nothing
 * is invented and the adapter reports the missing cwd itself). Exported so the
 * rule is unit-tested rather than pinned by a substring. */
export function applyHostDefaults(raw: string, hostCwd?: string): string {
  try {
    const msg: any = JSON.parse(raw);
    if (msg?.method === "session/new" || msg?.method === "session/load") {
      const params = msg.params ?? (msg.params = {});
      if (!params.cwd) {
        const cwd = hostCwd === undefined ? defaultCwd() : hostCwd;
        if (cwd) params.cwd = cwd;
      }
      return JSON.stringify(msg);
    }
  } catch { /* not JSON (should not happen) — pass through untouched */ }
  return raw;
}

console.log(`[acp-bridge] Starting bridge for harness "${HARNESS}" using adapter: ${ADAPTER_PATH || "(default: $HOME pi-acp)"}`);

export function createAcpServer(port: number, adapterPathOverride = ADAPTER_PATH) {
  return Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      let defaultCwdValue = "";
      let adapterValue = "";
      let adapterReady = false;
      try { defaultCwdValue = defaultCwd(); } catch { defaultCwdValue = ""; }
      try {
        adapterValue = adapterPathOverride || defaultAdapterPath();
        // Honest health: report whether the adapter this bridge would spawn is
        // actually present, so a missing adapter is visible before a turn.
        adapterReady = Deno.statSync(adapterValue).isFile;
      } catch { adapterReady = false; }
      return new Response(
        JSON.stringify({
          ok: adapterReady,
          harness: HARNESS,
          adapter: adapterValue || "(default)",
          adapterReady,
          defaultCwd: defaultCwdValue,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("ACP Bridge: Connect via WebSocket at /acp", { status: 426 });
    }

    // Origin guard: browsers ALWAYS send Origin on WebSocket upgrades. A web
    // page (http/https) may not drive the local harness over loopback — that
    // would let any site execute shell commands through the user's pi session.
    // Extension pages and local scripts (no Origin header) are allowed; the
    // optional --token binds the connection to a client that knows the secret.
    const clientOrigin = req.headers.get("origin");
    if (!originAllowed(clientOrigin)) {
      return new Response("ACP Bridge: web origins are not allowed to drive the harness", { status: 403 });
    }
    if (TOKEN && url.searchParams.get("token") !== TOKEN) {
      return new Response("ACP Bridge: missing or wrong token", { status: 403 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);

    // Spawn the ACP adapter process
    let child: Deno.ChildProcess | null = null;
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    /** Tail of the adapter's stderr, for the exit reason when it dies. */
    let lastStderr = "";

    socket.onopen = async () => {
      console.log(`[acp-bridge] Client connected from ${clientOrigin || "local script"}`);
      try {
        const adapterPath = adapterPathOverride || defaultAdapterPath();
        // Say so plainly before node has a chance to die with a
        // module-not-found stack.
        if (!Deno.statSync(adapterPath).isFile) {
          throw new Error(`adapter not found: ${adapterPath}`);
        }
        const cmd = new Deno.Command("node", {
          args: [adapterPath],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          env: {
            ...Deno.env.toObject(),
            PI_ACP_HARNESS: HARNESS,
          },
        });
        const proc = cmd.spawn();
        child = proc;
        writer = proc.stdin.getWriter();
        lastStderr = "";

        // A dead adapter must FAIL THE TURN, not hang it: when the child exits
        // (crash, missing module, bad flags) close the socket with its exit
        // status and the last stderr lines, so a client's pending requests
        // reject at once instead of waiting out the request timeout.
        (async () => {
          const exitStatus = await proc.status;
          if (socket.readyState !== WebSocket.OPEN) return;
          const detail = lastStderr.trim().split("\n").slice(-3).join(" | ") || "no stderr";
          console.error(`[acp-bridge] adapter exited (code ${exitStatus.code}, signal ${exitStatus.signal}): ${detail}`);
          try { socket.close(1011, `adapter exited: ${detail}`.slice(0, 120)); } catch { /* already closed */ }
        })();

        // Stream stdout from adapter to WebSocket client
        (async () => {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let nl: number;
              while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (line.trim() && socket.readyState === WebSocket.OPEN) {
                  socket.send(line);
                }
              }
            }
          } catch (e) {
            console.error("[acp-bridge] Error reading adapter stdout:", e);
          }
        })();

        // Relay stderr to console and remember its tail for the exit reason
        (async () => {
          const reader = proc.stderr.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              if (text.trim()) {
                lastStderr = (lastStderr + text).slice(-2000);
                console.error(`[adapter-stderr] ${text.trim()}`);
              }
            }
          } catch { /* stream closed */ }
        })();
      } catch (err) {
        console.error("[acp-bridge] Failed to spawn adapter:", err);
        socket.close(1011, `Failed to spawn adapter: ${err}`);
      }
    };

    socket.onmessage = async (event) => {
      if (!writer) return;
      try {
        const data = applyHostDefaults(String(event.data));
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(data + "\n"));
      } catch (err) {
        console.error("[acp-bridge] Failed to write to adapter stdin:", err);
      }
    };

    socket.onclose = () => {
      console.log("[acp-bridge] Client disconnected, cleaning up adapter process");
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    };

    socket.onerror = (e) => {
      console.error("[acp-bridge] WebSocket error:", e);
    };

    return response;
  });
}

// If invoked directly from CLI
if (import.meta.main) {
  const server = createAcpServer(PORT);
  console.log(`[acp-bridge] listening on ws://127.0.0.1:${(server as any).addr?.port ?? PORT}${TOKEN ? " (token required)" : ""}`);
}
