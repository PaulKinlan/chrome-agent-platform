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

/** Extra exact origins `--allow-origin` admitted (repeatable). */
const ALLOWED_ORIGINS = (Array.isArray(args["allow-origin"]) ? args["allow-origin"] : []).filter(Boolean);

/** Shared-secret requirement (`--token`): when set, the upgrade URL must carry
 * `?token=…`, binding the bridge to one client even on a shared machine. */
const TOKEN = String(args.token ?? "");

/** May this WebSocket Origin drive the harness? Browsers ALWAYS send Origin on
 * an upgrade, so an ABSENT one is a local script (deno/node test clients).
 * Default: extension pages only. `--allow-origin <origin>` admits others
 * explicitly by EXACT origin (a prefix would also admit
 * `https://trusted.example.evil.test`), and `--token` adds the shared-secret
 * requirement on top. The residual is documented: any INSTALLED extension
 * matches the extension scheme, so the token (or naming one exact extension
 * origin in --allow-origin) is how an operator binds the bridge to one
 * client. */
function originAllowed(origin: string | null): boolean {
  if (!origin) return true; // local script client
  const normalized = origin.replace(/\/$/, "");
  if (ALLOWED_ORIGINS.some((p) => p.replace(/\/$/, "") === normalized)) return true;
  return /^(chrome|moz)-extension:\/\//.test(origin);
}

/** The ACP adapters CAP knows how to launch, from the official registry
 * (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json):
 * package + pinned version, run with `npx -y` so NOTHING has to be installed
 * by hand. `--adapter <path>` still overrides for a local/custom build. */
export const HARNESS_ADAPTERS: Record<string, { pkg: string; version: string; label: string }> = {
  "pi": { pkg: "pi-acp", version: "0.0.33", label: "pi" },
  "claude-code": { pkg: "@agentclientprotocol/claude-agent-acp", version: "0.78.0", label: "Claude Code" },
  "codex": { pkg: "@agentclientprotocol/codex-acp", version: "1.12.0", label: "Codex" },
};

/** How to launch a harness's adapter: an explicit `--adapter <path>` (run with
 * node), else the registry package via npx. Unknown harnesses fail loudly with
 * the known list instead of spawning something arbitrary. Exported for tests. */
export function resolveAdapter(harness: string, adapterOverride = ""): { cmd: string; args: string[]; describe: string } {
  if (adapterOverride) return { cmd: "node", args: [adapterOverride], describe: adapterOverride };
  const spec = HARNESS_ADAPTERS[harness];
  if (!spec) {
    throw new Error(
      `unknown harness "${harness}" — known harnesses: ${Object.keys(HARNESS_ADAPTERS).join(", ")} ` +
        `(or pass --adapter <path to an ACP adapter>)`,
    );
  }
  return {
    cmd: "npx",
    args: ["-y", `${spec.pkg}@${spec.version}`],
    describe: `${spec.pkg}@${spec.version}`,
  };
}

/** A WebSocket close reason must be ≤123 BYTES or the close throws. 
 * Exported so the bound is unit-tested. */
export function clipCloseReason(reason: string, limit = 123): string {
  const bytes = new TextEncoder().encode(String(reason ?? ""));
  if (bytes.length <= limit) return String(reason ?? "");
  // Slice on a UTF-8 boundary, then trim to the last whole word.
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const clipped = new TextDecoder().decode(bytes.subarray(0, end)).trimEnd();
  return clipped.length > 0 ? clipped : "adapter error";
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

try {
  const startResolved = resolveAdapter(HARNESS, ADAPTER_PATH);
  console.log(`[acp-bridge] Starting bridge for harness "${HARNESS}" via: ${startResolved.cmd} ${startResolved.args.join(" ")}`);
} catch (e) {
  console.error(`[acp-bridge] ${(e as Error).message}`);
}

export function createAcpServer(port: number, adapterPathOverride = ADAPTER_PATH) {
  return Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      let defaultCwdValue = "";
      let adapterDescribe = "";
      let adapterPresent = false;
      let error = "";
      try { defaultCwdValue = defaultCwd(); } catch { defaultCwdValue = ""; }
      try {
        const resolved = resolveAdapter(HARNESS, adapterPathOverride);
        adapterDescribe = resolved.describe;
        // For an explicit --adapter (a file) we can say whether it exists; for
        // a registry package npx resolves (and if needed downloads) it at run
        // time, so "present" is not knowable here and is not claimed.
        adapterPresent = resolved.cmd === "node" ? Deno.statSync(resolved.args[0]).isFile : true;
      } catch (e) {
        error = String((e as Error)?.message ?? e);
      }
      // `ok` is the BRIDGE being up. A readiness probe would need a turn, so
      // this endpoint never pretends to know more than it does.
      return new Response(
        JSON.stringify({
          ok: true,
          harness: HARNESS,
          adapter: adapterDescribe || "(unresolved)",
          adapterPresent,
          defaultCwd: defaultCwdValue,
          knownHarnesses: Object.keys(HARNESS_ADAPTERS),
          ...(error ? { error } : {}),
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
        const resolved = resolveAdapter(HARNESS, adapterPathOverride);
        // An explicit adapter is a file: say so plainly instead of letting node
        // die with a module-not-found stack.
        if (resolved.cmd === "node" && !Deno.statSync(resolved.args[0]).isFile) {
          throw new Error(`adapter not found: ${resolved.args[0]}`);
        }
        const cmd = new Deno.Command(resolved.cmd, {
          args: resolved.args,
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
          try { socket.close(1011, clipCloseReason(`adapter exited: ${detail}`)); } catch { /* already closed */ }
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
        // A close reason is capped at 123 BYTES — an unbounded one throws
        // (seen live: a long adapter path turned this into an uncaught
        // SyntaxError instead of a clean, reported failure).
        socket.close(1011, clipCloseReason(`Failed to spawn adapter: ${err}`));
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
