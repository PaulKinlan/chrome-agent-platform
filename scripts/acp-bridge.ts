// scripts/acp-bridge.ts — Loopback WebSocket-to-stdio bridge for ACP harnesses.
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)
//
// Bridges Chrome Extension WebSocket connections to a locally spawned ACP adapter (e.g. pi-acp).
// Usage: npm run acp:bridge [--port 3210] [--adapter path/to/adapter] [--cwd /working/dir]
//
// Host defaults the extension cannot know live HERE, never as source literals:
// the adapter path and the session working directory resolve from $HOME at run
// time, and a `session/new`/`session/load` arriving without a cwd gets the
// bridge's --cwd (or nothing at all). A machine-path literal in the
// extension would be wrong on every other machine (3khn/evidence-durable).

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { existsSync } from "node:fs";
import { hostname } from "node:os";

const args = parseArgs(Deno.args, {
  string: ["port", "adapter", "harness", "cwd", "token", "allow-origin", "host"],
  collect: ["allow-origin"],
  default: {
    port: "3210",
    adapter: "",
    harness: "pi",
    cwd: "",
    token: "",
    "allow-origin": [],
    // Loopback by default: this process spawns a shell-capable agent, so it is
    // only exposed deliberately (--host 0.0.0.0 / a LAN address).
    host: "127.0.0.1",
  },
});

const PORT = parseInt(args.port, 10);
const ADAPTER_PATH = args.adapter;
const HARNESS = args.harness;

const HOME = Deno.env.get("HOME") ?? "";

/** Extra exact origins `--allow-origin` admitted (repeatable). */
const ALLOWED_ORIGINS = (Array.isArray(args["allow-origin"]) ? args["allow-origin"] : []).filter(Boolean);

const HOST = String(args.host || "127.0.0.1");

/** Is this bind address reachable from another machine? */
export function isLoopbackHost(host: string): boolean {
  const h = String(host || "").trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

/** Shared-secret requirement (`--token`): when set, the upgrade URL must carry
 * `?token=…`, binding the bridge to one client even on a shared machine. A
 * NETWORK bind always has one: either the operator's or a generated one, so a
 * shell-capable agent is never left open to the LAN. */
const TOKEN = String(args.token ?? "") || (isLoopbackHost(HOST) ? "" : crypto.randomUUID().replace(/-/g, ""));

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

/** The harness CLI each adapter drives, and the env var each adapter honours
 * for an EXPLICIT CLI path (verified against the pinned adapters, 2026-09-18:
 * claude-agent-acp@0.78.0 reads CLAUDE_CODE_EXECUTABLE in claudeCliPath();
 * codex-acp@1.12.0 reads CODEX_PATH in startAcpServer()). pi-acp has no other
 * way to find `pi`; the claude-code/codex adapters BUNDLE a CLI (the Claude
 * Agent SDK's native binary / @openai/codex/bin/codex.js), so for them a PATH
 * miss is not fatal — `bundledFallback` says what runs instead. */
export const HARNESS_CLI: Record<string, { cli: string; envVar?: string; install: string; bundledFallback?: string }> = {
  "pi": { cli: "pi", envVar: "PI_ACP_PI_COMMAND", install: "npm install -g @earendil-works/pi-coding-agent" },
  "claude-code": { cli: "claude", envVar: "CLAUDE_CODE_EXECUTABLE", install: "install the Claude Code CLI and sign in", bundledFallback: "the Claude Agent SDK's bundled native binary" },
  "codex": { cli: "codex", envVar: "CODEX_PATH", install: "install the Codex CLI and sign in", bundledFallback: "the bundled @openai/codex CLI" },
};

/** Find an executable on a PATH string (no shell, no side effects). Exported so
 * the resolution rule is unit-tested rather than pinned by a substring. */
export function resolveCliOnPath(cli: string, pathValue = ""): string {
  for (const dir of String(pathValue || "").split(":").filter(Boolean)) {
    const candidate = `${dir}/${cli}`;
    try { if (Deno.statSync(candidate).isFile) return candidate; } catch { /* not here */ }
  }
  return "";
}

/** Environment additions for the adapter child: when the harness CLI is on the
 * bridge's PATH, hand the adapter its ABSOLUTE path (pi-acp honours it), so a
 * harness found here is found even if the adapter's own PATH differs. */
export function childEnvForHarness(harness: string, pathValue = ""): Record<string, string> {
  const spec = HARNESS_CLI[harness];
  if (!spec?.envVar) return {};
  const resolved = resolveCliOnPath(spec.cli, pathValue);
  return resolved ? { [spec.envVar]: resolved } : {};
}

/** The env var pi's MCP adapter uses to STOP discovering the machine's own MCP
 * config files. Its documented effect is that host/imported configs and agent
 * plugins are skipped and only pi's own config remains
 * (pi-mcp-adapter/dist/config.js: `isExclusiveConfigMode()` gates
 * `getConfiguredHostConfigDiscovery` to "off" and short-circuits the import and
 * plugin paths). */
export const PI_MCP_EXCLUSIVE_ENV = "PI_MCP_CONFIG_MODE";

/** Names a CAP-spawned harness session must never inherit, whatever the
 * machine's MCP config says. Matched case-insensitively against the server
 * KEY, because the key is the operator's label and the label is not the thing
 * that launches. */
const BROWSER_LAUNCHING_MCP_HINTS = ["chrome-devtools", "chrome_devtools", "puppeteer", "playwright", "selenium", "browser-mcp", "browser_use"];

/** Does this MCP server key name something that launches its own browser?
 *
 * It exists because a CAP harness session must never be handed a second
 * browser: the owner's stated architecture is that the tools live in the
 * client, the harness asks, and the request routes BACK to the client, which
 * executes it against the tab the owner is actually looking at
 * (owner-reported 2026-09-22: a local process asking to run Google Chrome is
 * "exactly NOT what I want"). A patched browser is not the owner's browser.
 *
 * This is a NAME check, not a proof, and it is honest about that: a server
 * labelled oddly still gets through. It is the cheap half of the guard; the
 * load-bearing half is that CAP injects only its OWN tool server (see
 * `capMcpServerEntry`), so nothing else is ever offered by us. */
export function isBrowserLaunchingMcpServer(name: string): boolean {
  const key = String(name ?? "").trim().toLowerCase();
  return BROWSER_LAUNCHING_MCP_HINTS.some((hint) => key.includes(hint));
}

/** Environment additions that make a CAP-spawned harness session load ONLY the
 * MCP servers CAP intends it to have.
 *
 * WHY THIS EXISTS. `pi-mcp-adapter` discovers MCP servers from the machine's
 * global config (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, project
 * `.mcp.json`, plus host imports and agent plugins). A machine that has ever
 * configured a browser-automation server therefore hands one to EVERY harness
 * session CAP starts, and that server launches its own headless Chrome: a
 * local process asking to drive a browser the owner never opened. Measured on
 * the owner's machine 2026-09-22 — `~/.config/mcp/mcp.json` carries
 * `chrome-devtools-mcp` (node, `chrome-devtools-mcp.js --headless`), and a CAP
 * harness turn showed the owner a prompt to let a local process run Chrome.
 *
 * THE COST, STATED RATHER THAN HIDDEN. Exclusive mode is all-or-nothing: it
 * also stops the session inheriting any OTHER host MCP server the operator
 * configured (on the same machine, `web-reader`). That is a real loss and it is
 * the reason this is scoped to sessions CAP spawns rather than applied to the
 * machine: pi outside CAP keeps its full config. Narrowing it to "drop only the
 * browser-launching entries" needs a config-file override that pi-mcp-adapter
 * does not expose (it reads `PI_MCP_CONFIG_MODE`, `PI_PACKAGE_DIR` and `HOME`,
 * and no path override).
 *
 * Applied to pi only, because pi is the one adapter that both ignores the ACP
 * `mcpServers` channel (pi-acp 0.0.33 stores `params.mcpServers` and never
 * reads them) and reads a host config of its own. The claude-code and codex
 * adapters take their servers from ACP instead, so CAP controls those by
 * injection rather than by isolation. */
export function harnessMcpIsolationEnv(harness: string): Record<string, string> {
  return harness === "pi" ? { [PI_MCP_EXCLUSIVE_ENV]: "exclusive" } : {};
}

/** The startup lines for a harness CLI the bridge cannot see on ITS OWN PATH.
 * pi has no fallback: the adapter WILL fail with "executable not found", so
 * the warning names the fix. The claude-code/codex adapters bundle a CLI
 * (HARNESS_CLI.bundledFallback), so a PATH miss is a NOTE — the bundled CLI
 * runs — not a false "will fail" alarm. Empty when the CLI is visible or the
 * harness is unknown. Exported so the rule is unit-tested, not substring-pinned. */
export function harnessCliWarning(harness: string, pathValue = ""): string[] {
  const spec = HARNESS_CLI[harness];
  if (!spec) return [];
  if (resolveCliOnPath(spec.cli, pathValue)) return [];
  if (spec.bundledFallback) {
    return [
      `[acp-bridge] NOTE: "${spec.cli}" is not on THIS process's PATH — the adapter will use`,
      `[acp-bridge]          ${spec.bundledFallback}. To run a specific CLI instead, reinstall the`,
      `[acp-bridge]          launcher so it captures your PATH (npm run acp:service install) and the`,
      `[acp-bridge]          bridge will hand the adapter its absolute path. This process's PATH: ${pathValue || "(unset)"}`,
    ];
  }
  return [
    `[acp-bridge] WARNING: "${spec.cli}" is not on THIS process's PATH — the adapter will fail with`,
    `[acp-bridge]          "executable not found". Auto-started bridges (launchd/systemd/native host)`,
    `[acp-bridge]          get a minimal PATH, not your shell's. Fix: reinstall the launcher so it`,
    `[acp-bridge]          captures your PATH (npm run acp:service install), or install the harness CLI`,
    `[acp-bridge]          (${spec.install}). This process's PATH: ${pathValue || "(unset)"}`,
  ];
}

/** An adapter installed under the pi agent's npm prefix (how pi-acp gets
 * there). Preferring it avoids npx entirely — no PATH lookup, no network. */
export function localAdapterPath(pkg: string, home = HOME, exists: (p: string) => boolean = (p) => {
  try { return Deno.statSync(p).isFile; } catch { return false; }
}): string {
  if (!home) return "";
  const entry = `${home}/.pi/agent/npm/node_modules/${pkg}/dist/index.js`;
  return exists(entry) ? entry : "";
}

/** How to launch a harness's adapter. Order: an explicit `--adapter <path>`; a
 * LOCAL install of the registry package; otherwise `npx` — resolved to an
 * ABSOLUTE path here, because Deno.Command's PATH lookup happens in THIS
 * process's environment, and a launcher (launchd/systemd/Chrome native host)
 * does not inherit the shell's PATH: the spawn then dies with
 * "Failed to spawn 'npx': entity not found". Unknown harnesses fail loudly with
 * the known list instead of spawning something arbitrary. Exported for tests. */
export function resolveAdapter(
  harness: string,
  adapterOverride = "",
  pathValue = "",
  opts: { home?: string; exists?: (p: string) => boolean } = {},
): { cmd: string; args: string[]; describe: string } {
  if (adapterOverride) return { cmd: "node", args: [adapterOverride], describe: adapterOverride };
  const spec = HARNESS_ADAPTERS[harness];
  if (!spec) {
    throw new Error(
      `unknown harness "${harness}" — known harnesses: ${Object.keys(HARNESS_ADAPTERS).join(", ")} ` +
        `(or pass --adapter <path to an ACP adapter>)`,
    );
  }
  const local = localAdapterPath(spec.pkg, opts.home ?? HOME, opts.exists);
  if (local) return { cmd: "node", args: [local], describe: `${local} (local install)` };

  const npx = resolveCliOnPath("npx", pathValue || (Deno.env.get("PATH") ?? ""));
  if (!npx) {
    throw new Error(
      `cannot run the "${harness}" adapter: "npx" is not on this process's PATH ` +
        `(PATH=${pathValue || (Deno.env.get("PATH") ?? "(unset)")}). Install Node/npx, or pass ` +
        `--adapter <path to the ${spec.pkg} entry file>.`,
    );
  }
  return { cmd: npx, args: ["-y", `${spec.pkg}@${spec.version}`], describe: `${spec.pkg}@${spec.version} via ${npx}` };
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

/** The working directory a session request without one gets (host-side default).
 *
 * `--cwd`, or NOTHING (""). There is deliberately no `$HOME/journal` guess here:
 * this bridge is a tool, and a tool must not carry somebody's directory
 * convention. Guarding the guess with `existsSync` only made the invention SAFE —
 * on any machine that happens to have a `~/journal` it would still silently adopt
 * it as the working directory, and on Paul's Mac it handed the client
 * `/Users/paulkinlan/journal`, which does not exist there, so the turn died with
 * "Invalid params: `cwd` does not exist on the machine running the agent"
 * (chrome-agent-platform-7p7e). "" is the documented contract: nothing is
 * invented and the adapter reports the missing cwd itself. A client that wants a
 * directory declares one, and so does an install (`--cwd`). */
function defaultCwd() {
  return args.cwd || "";
}

/** Give a client frame the host defaults only the bridge knows: a session/new
 * or session/load with no working directory gets `hostCwd` (undefined = the
 * bridge's --cwd; "" = no host default configured, so nothing
 * is invented and the adapter reports the missing cwd itself). Exported so the
 * rule is unit-tested rather than pinned by a substring. */
/** The lines to print when a CLIENT sends a cwd this host does not have.
 *
 * chrome-agent-platform-5i9i, and the other half of 7p7e. `defaultCwd` no longer
 * invents anything; this is about a directory the CLIENT chose. That choice is
 * authoritative for its own session and is NEVER substituted here — but when it
 * does not exist on this host, the refusal arrives from the adapter, several
 * machines away from the cause, and reads like the bridge's own mistake (Paul's
 * "/Users/paulkinlan/journal" on a Linux bridge). Name the path, the host, and
 * whose choice it was. It carries no knowledge of any directory convention —
 * only the fact that two machines disagree.
 */
export function clientCwdWarning(
  raw: string,
  opts: { exists?: (path: string) => boolean; host?: string } = {},
): string[] {
  try {
    const msg: any = JSON.parse(raw);
    if (msg?.method !== "session/new" && msg?.method !== "session/load") return [];
    const cwd = msg?.params?.cwd;
    if (typeof cwd !== "string" || cwd === "") return [];
    const exists = opts.exists ?? ((path: string) => {
      try { return existsSync(path); } catch { return false; }
    });
    if (exists(cwd)) return [];
    let host = "this machine";
    try { host = opts.host ?? hostname(); } catch { /* keep the fallback */ }
    return [
      `[acp-bridge] WARNING: the client asked for cwd "${cwd}", which does not exist on THIS host (${host}) —`,
      `[acp-bridge]          the adapter will refuse it with "Invalid params". The client's choice is passed`,
      `[acp-bridge]          through unchanged (this bridge never substitutes one): fix it in the client's own`,
      `[acp-bridge]          settings, or install this service with --cwd if the host should declare it.`,
    ];
  } catch { return []; }
}

/** Warn once per distinct line, so a repeating frame cannot flood the log. */
const warnedClientCwdLines = new Set<string>();

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

// Startup logging belongs to a RUN, not an import: this module is imported by
// scripts/acp-native-host.ts for its harness table, and anything printed at
// import time would land in the native-messaging channel on stdout and desync
// Chrome's framing (found by tests/acp-native-host.test.ts).
if (import.meta.main) { try {
  const startResolved = resolveAdapter(HARNESS, ADAPTER_PATH);
  console.log(`[acp-bridge] Starting bridge (default harness "${HARNESS}" via: ${startResolved.cmd} ${startResolved.args.join(" ")})`);
  if (!ADAPTER_PATH) {
    console.log(`[acp-bridge] Per-connection harness selection enabled for: ${Object.keys(HARNESS_ADAPTERS).join(", ")} (via ?harness=...)`);
  }
} catch (e) {
  console.error(`[acp-bridge] ${(e as Error).message}`);
} }
if (import.meta.main) {
  for (const line of harnessCliWarning(HARNESS, Deno.env.get("PATH") ?? "")) console.error(line);
}
if (!isLoopbackHost(HOST) && import.meta.main) {
  console.log(`[acp-bridge] Bound to ${HOST} — reachable from other machines on this network.`);
  console.log(`[acp-bridge] Token required${args.token ? "" : " (generated)"}: ${TOKEN}`);
  console.log("[acp-bridge] Plain ws:// on a network is UNENCRYPTED (the token and the agent's traffic are visible");
  console.log("[acp-bridge] to anything on the path). For anything beyond a trusted LAN, put TLS in front (a reverse");
  console.log("[acp-bridge] proxy or a tunnel) and keep this process on loopback behind it.");
}

/** `childEnv` is added to the adapter child's environment on top of this
 * process's. It exists so a caller can pin the adapter's configuration for the
 * children IT causes, instead of setting a process-global variable: `deno test
 * --parallel` runs every test file in ONE process, so a `Deno.env.set` in one
 * file is inherited by another file's adapter spawn through this very spread.
 * Measured (chrome-agent-platform-jp78): a concurrent test file's fixture
 * appended its frames to the other file's frame log, which made a resume pin
 * that had actually resumed count two `session/new`. Explicit keys win over
 * the inherited environment. */
export function createAcpServer(
  port: number,
  adapterPathOverride = ADAPTER_PATH,
  childEnv: Record<string, string> = {},
  /** The host-side working directory, DECLARED by the caller (CLI --cwd for the
   * service, an explicit argument for a test or probe). There is no detection and
   * no guess: "" means a session without a cwd gets none, and the adapter reports
   * it (chrome-agent-platform-7p7e / 5i9i). */
  hostCwdDefault: string = args.cwd,
) {
  return Deno.serve({ port, hostname: HOST }, (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      const probeHarness = url.searchParams.get("harness")?.trim() || HARNESS;
      let defaultCwdValue = hostCwdDefault;
      let adapterDescribe = "";
      let adapterPresent = false;
      let error = "";
      try { defaultCwdValue = defaultCwd(); } catch { defaultCwdValue = ""; }
      try {
        const resolved = resolveAdapter(probeHarness, adapterPathOverride);
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
          probeHarness,
          supportsHarnessSelection: !adapterPathOverride,
          pinnedAdapter: Boolean(adapterPathOverride),
          adapter: adapterDescribe || "(unresolved)",
          adapterPresent,
          defaultCwd: defaultCwdValue,
          knownHarnesses: Object.keys(HARNESS_ADAPTERS),
          harnessCli: HARNESS_CLI[probeHarness]?.cli ?? null,
          harnessCliPath: HARNESS_CLI[probeHarness] ? (resolveCliOnPath(HARNESS_CLI[probeHarness].cli, Deno.env.get("PATH") ?? "") || null) : null,
          ...(error ? { error } : {}),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Per-connection harness selection: clients can request a specific harness
    // (e.g. ?harness=claude-code or ?harness=codex). Defaults to the bridge's
    // configured default harness.
    const requestedHarness = url.searchParams.get("harness")?.trim();
    if (!adapterPathOverride && requestedHarness && !HARNESS_ADAPTERS[requestedHarness]) {
      return new Response(
        `ACP Bridge: unknown harness "${requestedHarness}" — known harnesses: ${Object.keys(HARNESS_ADAPTERS).join(", ")}`,
        { status: 400 },
      );
    }
    const connectionHarness = requestedHarness || HARNESS;

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
      console.log(`[acp-bridge] Client connected from ${clientOrigin || "local script"} (harness: ${connectionHarness})`);
      try {
        const resolved = resolveAdapter(connectionHarness, adapterPathOverride);
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
            ...childEnv,
            PI_ACP_HARNESS: connectionHarness,
            ...harnessMcpIsolationEnv(connectionHarness),
            ...childEnvForHarness(connectionHarness, Deno.env.get("PATH") ?? ""),
            // Give the adapter a PATH that contains the binaries we resolved
            // (npx/CLI), because it spawns the harness CLI itself.
            PATH: [Deno.build.os === "windows" ? "" : "", Deno.env.get("PATH") ?? ""].filter(Boolean).join(":"),
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
          console.error(`[acp-bridge] adapter for harness "${connectionHarness}" exited (code ${exitStatus.code}, signal ${exitStatus.signal}): ${detail}`);
          try { socket.close(1011, clipCloseReason(`adapter for harness "${connectionHarness}" exited: ${detail}`)); } catch { /* already closed */ }
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
        console.error(`[acp-bridge] Failed to spawn adapter for harness "${connectionHarness}":`, err);
        // A close reason is capped at 123 BYTES — an unbounded one throws
        // (seen live: a long adapter path turned this into an uncaught
        // SyntaxError instead of a clean, reported failure).
        socket.close(1011, clipCloseReason(`Failed to spawn adapter for harness "${connectionHarness}": ${err}`));
      }
    };

    socket.onmessage = async (event) => {
      if (!writer) return;
      try {
        for (const line of clientCwdWarning(String(event.data))) {
          if (!warnedClientCwdLines.has(line)) {
            console.error(line);
            warnedClientCwdLines.add(line);
          }
        }
        const data = applyHostDefaults(String(event.data), hostCwdDefault || undefined);
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
  const bound = (server as any).addr?.port ?? PORT;
  const q = TOKEN ? `?token=${TOKEN}` : "";
  if (isLoopbackHost(HOST)) {
    console.log(`[acp-bridge] listening on ws://127.0.0.1:${bound}/acp${q}${TOKEN ? " (token required)" : ""}`);
  } else {
    const addrs = Deno.networkInterfaces()
      .filter((i) => i.family === "IPv4" && !i.address.startsWith("127."))
      .map((i) => i.address);
    for (const a of addrs) console.log(`[acp-bridge] reachable at ws://${a}:${bound}/acp${q}`);
    console.log(`[acp-bridge] paste one of those into CAP: acp.endpoint, and the token into acp.token`);
  }
}
