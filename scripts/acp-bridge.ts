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
import { acpChildEnv, acpChildEnvNote, actionableAuthWarning } from "./lib/acp-child-env.ts";
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
): { cmd: string; args: string[]; describe: string; adapterName: string | null } {
  if (adapterOverride) return { cmd: "node", args: [adapterOverride], describe: adapterOverride, adapterName: null };
  const spec = HARNESS_ADAPTERS[harness];
  if (!spec) {
    throw new Error(
      `unknown harness "${harness}" — known harnesses: ${Object.keys(HARNESS_ADAPTERS).join(", ")} ` +
        `(or pass --adapter <path to an ACP adapter>)`,
    );
  }
  const local = localAdapterPath(spec.pkg, opts.home ?? HOME, opts.exists);
  if (local) return { cmd: "node", args: [local], describe: `${local} (local install)`, adapterName: spec.pkg };

  const npx = resolveCliOnPath("npx", pathValue || (Deno.env.get("PATH") ?? ""));
  if (!npx) {
    throw new Error(
      `cannot run the "${harness}" adapter: "npx" is not on this process's PATH ` +
        `(PATH=${pathValue || (Deno.env.get("PATH") ?? "(unset)")}). Install Node/npx, or pass ` +
        `--adapter <path to the ${spec.pkg} entry file>.`,
    );
  }
  return { cmd: npx, args: ["-y", `${spec.pkg}@${spec.version}`], describe: `${spec.pkg}@${spec.version} via ${npx}`, adapterName: spec.pkg };
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

/** A custom adapter's identity comes from its initialize reply, never the URL
 * label. A resolved Pi package stays Pi even if its reply omits/renames itself. */
export function adapterNameFromInitialize(raw: string, initializeId: unknown, currentName: string | null) {
  if (currentName === "pi-acp" || initializeId == null) return currentName;
  try {
    const msg = JSON.parse(raw);
    const name = msg?.id === initializeId ? msg.result?.agentInfo?.name : null;
    return typeof name === "string" && name.trim() ? name : currentName;
  } catch { return currentName; }
}

/** CAP refuses a session it cannot provide as requested. pi-acp documents that
 * mcpServers are stored, not mounted. This is the jjzm honesty fix, not qnd4's
 * client-tool binding: empty-server Pi sessions can still use local tools.
 * Keep this shared by the WebSocket bridge and native host. */
export function toolServerError(raw: string, adapterName: string | null) {
  if (adapterName !== null && adapterName !== "pi-acp") return null;
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if ((msg?.method !== "session/new" && msg?.method !== "session/load")
    || !Array.isArray(msg.params?.mcpServers) || msg.params.mcpServers.length === 0) return null;
  return {
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: {
      code: -32602,
      message: adapterName === null
        ? "CAP cannot identify this custom adapter, so it cannot accept supplied MCP servers. "
          + "Use an adapter that reports agentInfo.name during initialize, or omit mcpServers (local tools only)."
        : "CAP cannot supply these tools: Pi's ACP adapter does not mount supplied MCP servers. "
          + "Use Claude Code or Codex for MCP server tools, or omit mcpServers to run Pi with local tools only. "
          + "This path does not bind CAP's browser tools.",
    },
  };
}

/**
 * THE BROWSER TOOLS CAP OFFERS THE HARNESS (chrome-agent-platform-2amt).
 *
 * Paul's directive: "I need tools in the browser to be available to the harness (like claude) and
 * then have it called and messaged back to Chrome over a protocol inside this app (not via MCP)."
 *
 * So there is no MCP server and no HTTP surface: the harness is TOLD the catalogue in its opening
 * prompt and calls back over the ACP connection it already has, with
 *   {"jsonrpc":"2.0","id":"…","method":"browser/call_tool","params":{"name":…,"args":{…}}}
 * which extension/lib/acp-client.js dispatches into browserToolset(). The tools' own permission and
 * browser-control grants are untouched, so this adds reach, not authority.
 *
 * THE NAMES HERE ARE CHECKED AGAINST THE IMPLEMENTATION. tests/browser-tool-proxy.test.ts compares
 * this list with Object.keys(browserToolset()) in both directions, so a tool cannot be declared
 * without existing and cannot exist without being declared — the drift that would make the harness
 * call something that is not there (or miss one that is).
 *
 * chrome-agent-platform-wfo5 (Paul: "there is a lot of browser functionality that should be enabled
 * and available to claude code and other harnesses to call... please land asap"): this list is now
 * the WHOLE default toolset, not a three-name sample. Two consequences worth stating, because both
 * were measured rather than assumed:
 *
 *   • It is GENERATED from browserToolset()'s own descriptions and zod schemas, not retyped. The
 *     bridge cannot import that module at runtime — it runs under a plain `deno run -A` with no
 *     node_modules resolution, so `import "zod"` fails — which is why this is committed data with a
 *     both-directions test rather than a runtime derivation.
 *   • The block costs roughly 19 KB / ~4.7k tokens, injected ONCE per session by
 *     applyBrowserToolDeclaration. That is the price of the harness knowing what it can call; the
 *     alternative (a harness guessing tool names) produces refusals and retries that cost more.
 */
export const BROWSER_TOOL_DECLARATIONS: ReadonlyArray<{ name: string; args: string; summary: string }> = [
  { name: "add_history_url", args: "{\"url\":string}", summary: "Add a URL to browsing history (http/https only)." },
  { name: "add_network_rule", args: "{\"id\":number,\"priority\"?:number,\"action\":block|allow|redirect|upgradeScheme|modifyHeaders,\"urlFilter\"?:string,\"regexFilter\"?:string,\"resourceTypes\"?:array,\"requestDomains\"?:array,\"redirectUrl\"?:string}", summary: "Add a dynamic network rule (block/allow/redirect/upgradeScheme)." },
  { name: "add_reading_list_entry", args: "{\"url\":string,\"title\":string,\"hasBeenRead\"?:boolean}", summary: "Add a url to the browser reading list (http/https only)." },
  { name: "cancel_download", args: "{\"downloadId\":number}", summary: "Cancel an in-progress download by id." },
  { name: "capture_screenshot", args: "{\"tabId\"?:number}", summary: "Capture a PNG screenshot of the requested tab (or the active tab)." },
  { name: "clear_alarm", args: "{\"name\":string}", summary: "Clear a scheduled alarm by name." },
  { name: "clear_all_history", args: "{\"confirm\"?:boolean}", summary: "Delete ALL browsing history." },
  { name: "clear_content_settings", args: "{\"resource\":cookies|images|javascript|location|notifications|popups,\"primaryPattern\":string}", summary: "Reset one content setting for a SINGLE-ORIGIN pattern to the resource default (allow for cookies/images/javascript, ask for location/notifications,…" },
  { name: "clear_font_settings", args: "{}", summary: "Clear custom font settings (default size + per-family fonts) back to Chrome's defaults." },
  { name: "clear_notification", args: "{\"notificationId\":string}", summary: "Clear an active system notification by id." },
  { name: "clear_proxy_settings", args: "{}", summary: "Clear the proxy configuration back to the system default." },
  { name: "click_element", args: "{\"tabId\"?:number,\"ref\":number}", summary: "Click an element by a ref from the last find_elements snapshot." },
  { name: "close_tab", args: "{\"tabId\":number}", summary: "Close a tab by id. Requires browser-control permission (scoped + expiring)." },
  { name: "close_window", args: "{\"windowId\":number}", summary: "Close a window by id (closing every tab in it)." },
  { name: "create_alarm", args: "{}", summary: "Create a raw scheduled alarm by name with a delay or period in minutes (low-level alarm trigger; for scheduling autonomous agent tasks or scripts,…" },
  { name: "create_bookmark", args: "{\"title\":string,\"url\"?:string,\"parentId\"?:string}", summary: "Create a new bookmark or bookmark folder." },
  { name: "create_context_menu", args: "{\"id\":string,\"title\":string,\"contexts\"?:array,\"parentId\"?:string}", summary: "Create an extension context menu item." },
  { name: "create_window", args: "{\"url\"?:string,\"focused\"?:boolean,\"left\"?:number,\"top\"?:number,\"width\"?:number,\"height\"?:number}", summary: "Open a new browser window, optionally at a URL." },
  { name: "delete_file", args: "{\"path\":string,\"grantId\"?:string}", summary: "Delete a file (or empty subdirectory) inside a granted local folder or the current agent's private workspace." },
  { name: "delete_history_range", args: "{}", summary: "Delete browsing history within a bounded time range (epoch ms; both bounds required — no open-ended wipes)." },
  { name: "delete_history_url", args: "{\"url\":string}", summary: "Delete all history entries for one URL (http/https only)." },
  { name: "disable_action", args: "{\"tabId\"?:number}", summary: "Disable this extension's own toolbar action (globally or for one tab)." },
  { name: "discard_tab", args: "{\"tabId\":number}", summary: "Discard a tab's content to free memory (the tab stays in the strip; Chrome refuses to discard the active tab)." },
  { name: "download_file", args: "{\"url\":string,\"filename\"?:string,\"conflictAction\"?:uniquify|overwrite|prompt}", summary: "Download a URL. ONLY http/https URLs are accepted (file://, chrome://, extension://, data: and other schemes are refused). The optional filename is…" },
  { name: "duplicate_tab", args: "{\"tabId\":number,\"keep\"?:boolean}", summary: "Duplicate a tab (the copy opens next to it)." },
  { name: "enable_action", args: "{\"tabId\"?:number}", summary: "Enable this extension's own toolbar action (globally or for one tab)." },
  { name: "erase_download", args: "{\"ids\":array}", summary: "Erase the download records for the given ids from the download shelf (the files themselves may remain on disk)." },
  { name: "find_elements", args: "{\"tabId\"?:number,\"maxResults\"?:number}", summary: "Snapshot the interactive/labelled elements on a page (or the active tab) as a bounded list of { ref, role, accessibleName, tag } — the ref is an op…" },
  { name: "find_files", args: "{\"query\":string,\"grantId\"?:string,\"limit\"?:number}", summary: "Find files by name inside a granted local folder (recursive, bounded)." },
  { name: "focus_window", args: "{\"windowId\":number}", summary: "Bring a window to the front by id." },
  { name: "get_action_state", args: "{}", summary: "Read this extension's own toolbar action state (badge text/colour, hover title)." },
  { name: "get_content_setting", args: "{\"resource\":cookies|images|javascript|location|notifications|popups,\"primaryPattern\":string}", summary: "Read one content setting (cookies/images/javascript/location/notifications/popups) for a single-origin pattern." },
  { name: "get_extension", args: "{\"id\":string}", summary: "Get one installed extension's details by id (name, version, enabled, type, permissions, homepage)." },
  { name: "get_extension_manifest", args: "{}", summary: "Read this extension's own manifest (name, version, permissions)." },
  { name: "get_extension_permission_warnings", args: "{\"id\":string}", summary: "Get the human-readable permission warnings Chrome shows when installing the given extension id." },
  { name: "get_font_settings", args: "{}", summary: "Read the default font size and the default font for each generic family." },
  { name: "get_history_visits", args: "{\"url\":string,\"maxResults\"?:number}", summary: "List the recorded visits for one history URL (visitTime, transition)." },
  { name: "get_navigation_frame", args: "{\"tabId\":number,\"frameId\":number}", summary: "Get one frame of a tab by frameId (chrome.webNavigation.getFrame)." },
  { name: "get_navigation_frames", args: "{\"tabId\":number}", summary: "List all frames of a tab (chrome.webNavigation.getAllFrames)." },
  { name: "get_network_rule_matches", args: "{\"url\":string,\"tabId\"?:number,\"resourceType\"?:main_frame|sub_frame|stylesheet|script|image|font|object|xml_http_request|ping|csp_report|media|websocket|other}", summary: "Test which dynamic network rules would match a hypothetical request (testMatchOutcome)." },
  { name: "get_platform_info", args: "{}", summary: "Read the browser's platform info (os, cpu architecture)." },
  { name: "get_privacy_setting", args: "{\"setting\":network.webRTCIpHandlingPolicy|network.networkPredictionEnabled|services.alternateErrorPagesEnabled|services.autofillAddressEnabled|services.autofillCreditCardEnabled|services.passwordSavingEnabled|services.safeBrowsingEnabled|services.safeBrowsingExtendedReportingEnabled|services.searchSuggestEnabled|services.spellingServiceEnabled|services.translationServiceEnabled|websites.adMeasurementEnabled|websites.doNotTrackEnabled|websites.hyperlinkAuditingEnabled|websites.protectedContentEnabled|websites.referrersEnabled|websites.thirdPartyCookiesAllowed}", summary: "Read one of Chrome's desktop privacy preferences (network/services/websites)." },
  { name: "get_proxy_settings", args: "{}", summary: "Read the current proxy configuration (mode + PAC script URL + fixed rules)." },
  { name: "get_request_activity", args: "{\"maxResults\"?:number,\"tabId\"?:number,\"phase\"?:started|completed}", summary: "Read recent observed web request activity (MV3 NON-BLOCKING webRequest observation only — blocking webRequest requires enterprise policy and is exc…" },
  { name: "get_side_panel_options", args: "{\"tabId\"?:number}", summary: "Read the side panel options (bundled page path + enabled), globally or for one tab." },
  { name: "get_system_cpu", args: "{}", summary: "Read system CPU info (model, architecture, processor count, per-processor load)." },
  { name: "get_system_display", args: "{}", summary: "List attached displays (id, name, primary, resolution, bounds)." },
  { name: "get_system_memory", args: "{}", summary: "Read system memory info (capacity, available)." },
  { name: "get_system_storage", args: "{}", summary: "List attached storage units (id, name, type, capacity)." },
  { name: "get_tab_zoom", args: "{\"tabId\":number}", summary: "Read a tab's current zoom factor (1 = 100%)." },
  { name: "grep_files", args: "{\"query\":string,\"grantId\"?:string,\"path\"?:string,\"regex\"?:boolean,\"ignoreCase\"?:boolean,\"maxMatches\"?:number}", summary: "Search the CONTENT of files inside a granted local folder (recursive, bounded)." },
  { name: "group_tabs", args: "{\"tabIds\":array,\"title\"?:string,\"color\"?:grey|blue|red|yellow|green|pink|purple|cyan|orange}", summary: "Group the given tabs into a new tab group (optional title/color)." },
  { name: "highlight_tabs", args: "{}", summary: "Highlight (select) a set of tabs in a window, by tab id or by window position index." },
  { name: "list_alarms", args: "{}", summary: "List all scheduled extension alarms (name, scheduledTime, periodInMinutes)." },
  { name: "list_bookmarks", args: "{\"query\"?:string,\"parentId\"?:string,\"maxResults\"?:number}", summary: "Search or list browser bookmarks (id, title, url, parentId)." },
  { name: "list_commands", args: "{}", summary: "List the extension's declared keyboard commands (name, shortcut, description)." },
  { name: "list_content_scripts", args: "{\"maxResults\"?:number}", summary: "List dynamically registered content scripts (id, matches, runAt, world, js size + bounded preview)." },
  { name: "list_context_menus", args: "{}", summary: "Check context menu support state." },
  { name: "list_cookie_stores", args: "{}", summary: "List the browser's cookie stores (id + tab ids)." },
  { name: "list_cookies", args: "{\"domain\"?:string,\"url\"?:string,\"maxResults\"?:number}", summary: "List cookie NAMES and metadata (domain, path, flags, expiry) for a domain or URL, bounded." },
  { name: "list_downloads", args: "{\"query\"?:string,\"state\"?:in_progress|interrupted|complete,\"limit\"?:number}", summary: "Search the browser's download history (bounded query/filters/limit)." },
  { name: "list_extensions", args: "{\"maxResults\"?:number}", summary: "List the installed browser extensions/apps (id, name, version, enabled, type, install source)." },
  { name: "list_files", args: "{\"grantId\"?:string,\"path\"?:string,\"limit\"?:number}", summary: "List files and subfolders inside a granted local folder." },
  { name: "list_folders", args: "{}", summary: "List the local folders available to this task (granted via /folder or in Settings → Local folders)." },
  { name: "list_granted_permissions", args: "{}", summary: "List the permissions + host origins this extension currently holds (read-only owner inventory — no permission required)." },
  { name: "list_network_rules", args: "{}", summary: "List the extension's dynamic network rules (declarativeNetRequest)." },
  { name: "list_recently_closed", args: "{\"maxResults\"?:number}", summary: "List recently closed tabs and windows (sessionId, kind, url, title, lastModified) so they can be restored with restore_closed." },
  { name: "list_synced_devices", args: "{}", summary: "List devices synced to this Chrome profile and their recently closed sessions." },
  { name: "list_tab_groups", args: "{\"windowId\"?:number}", summary: "List the browser's tab groups (id, title, color, collapsed, windowId), optionally scoped to one window." },
  { name: "list_tabs", args: "{}", summary: "List EVERY open tab across every window, with a count so completeness can be checked." },
  { name: "list_top_sites", args: "{\"maxResults\"?:number}", summary: "List the browser's top sites (url, title)." },
  { name: "list_tts_voices", args: "{\"maxResults\"?:number}", summary: "List the available text-to-speech voices (bounded)." },
  { name: "list_user_scripts", args: "{\"maxResults\"?:number}", summary: "List registered user scripts (id, matches, runAt, js size + bounded preview)." },
  { name: "list_windows", args: "{}", summary: "List the browser windows (id, focused, type, state, bounds)." },
  { name: "move_tab", args: "{}", summary: "Move a tab to a new position and/or window." },
  { name: "move_tab_to_group", args: "{\"tabIds\":array,\"groupId\":number}", summary: "Move the given tabs into an existing tab group." },
  { name: "move_window", args: "{\"windowId\":number,\"left\"?:number,\"top\"?:number,\"width\"?:number,\"height\"?:number,\"state\"?:normal|minimized|maximized|fullscreen}", summary: "Move/resize a window or set its state (normal/minimized/maximized/fullscreen) by id." },
  { name: "navigate_tab", args: "{\"tabId\"?:number,\"url\":string}", summary: "Navigate an existing tab to a URL." },
  { name: "notify", args: "{\"title\":string,\"message\":string,\"iconUrl\"?:string,\"priority\"?:number}", summary: "Display a system notification to the user (title, message)." },
  { name: "open_download", args: "{\"downloadId\":number}", summary: "Open a completed download with its default application (owner-OVERRIDDEN Phase-1 exclusion; keep hard grant-gated — global browser-control grant)." },
  { name: "open_tab", args: "{\"url\":string,\"keep\"?:boolean,\"split\"?:boolean}", summary: "Open a URL in a new browser tab." },
  { name: "pause_download", args: "{\"downloadId\":number}", summary: "Pause an in-progress download by id." },
  { name: "query_idle_state", args: "{\"detectionIntervalInSeconds\"?:number}", summary: "Query the system idle state ('active', 'idle', or 'locked') given a detection interval." },
  { name: "query_reading_list", args: "{\"url\"?:string,\"title\"?:string,\"hasBeenRead\"?:boolean,\"maxResults\"?:number}", summary: "Query the browser reading list (url/title/hasBeenRead filters, bounded)." },
  { name: "read_file", args: "{\"path\":string,\"grantId\"?:string,\"offset\"?:number,\"length\"?:number,\"maxBytes\"?:number}", summary: "Read a text file inside a granted local folder, or — when no local folder is available to this task and the run belongs to a named or background ag…" },
  { name: "read_page", args: "{\"tabId\"?:number}", summary: "Read the title, URL and visible text of a tab (or the active tab)." },
  { name: "recent_browser_events", args: "{\"limit\"?:number}", summary: "Read the recent browser events (tab opened/updated/navigated)." },
  { name: "register_content_script", args: "{\"id\":string,\"js\":string,\"matches\":array,\"runAt\"?:document_start|document_end|document_idle,\"world\"?:ISOLATED|MAIN}", summary: "Register a DYNAMIC content script via chrome.scripting (id + js + matches + runAt, optional world ISOLATED|MAIN)." },
  { name: "register_user_script", args: "{\"id\":string,\"js\":string,\"matches\":array,\"runAt\"?:document_start|document_end|document_idle}", summary: "Register a USER_SCRIPT-world user script (id + js + matches)." },
  { name: "release_keep_awake", args: "{}", summary: "Release a previously requested keep-awake." },
  { name: "reload_tab", args: "{\"tabId\":number,\"bypassCache\"?:boolean}", summary: "Reload a tab, optionally bypassing the cache." },
  { name: "remove_bookmark", args: "{\"id\":string}", summary: "Remove a bookmark or bookmark folder by id." },
  { name: "remove_context_menu", args: "{\"id\":string}", summary: "Remove an extension context menu item by id." },
  { name: "remove_download_file", args: "{\"downloadId\":number}", summary: "Delete the downloaded file for the given download id from disk (destructive)." },
  { name: "remove_network_rule", args: "{\"ruleIds\":array}", summary: "Remove dynamic network rules by id." },
  { name: "remove_reading_list_entry", args: "{\"url\":string}", summary: "Remove a reading list entry by url (http/https only)." },
  { name: "request_keep_awake", args: "{\"level\":system|display}", summary: "Keep the system or the display awake." },
  { name: "restore_closed", args: "{\"sessionId\":string}", summary: "Restore a recently closed tab or window by sessionId (from list_recently_closed)." },
  { name: "resume_download", args: "{\"downloadId\":number}", summary: "Resume a paused download by id." },
  { name: "save_page_as_mhtml", args: "{\"tabId\"?:number}", summary: "Save a tab as MHTML (single-file page snapshot) and return its content inline (bounded; over-cap pages are refused with the size reported, never si…" },
  { name: "schedule_task", args: "{\"task\":string,\"at\"?:number,\"delayMs\"?:number,\"periodInMinutes\"?:number,\"scriptId\"?:string}", summary: "Schedule a future task to run the agent." },
  { name: "scroll_page", args: "{\"tabId\"?:number,\"ref\"?:number,\"direction\"?:up|down|left|right|top|bottom,\"amount\"?:number}", summary: "Scroll a page (or the active tab): pass a direction (up/down/left/right/top/bottom) with an optional pixel amount, or a ref from the last find_elem…" },
  { name: "search_history", args: "{\"text\"?:string,\"startTime\"?:number,\"endTime\"?:number,\"maxResults\"?:number}", summary: "Search browsing history (url, title, visitCount, lastVisitTime)." },
  { name: "search_query", args: "{\"text\":string}", summary: "Run a search with the browser's default search engine (chrome.search.query only — it opens the engine's results, never an arbitrary URL)." },
  { name: "select_option", args: "{\"tabId\"?:number,\"ref\":number,\"value\":string}", summary: "Choose an option in a <select> dropdown by a ref from the last find_elements snapshot, matching the option's value or its visible text." },
  { name: "set_action_state", args: "{}", summary: "Set this extension's own toolbar action state (badge text/colour, hover title, icon)." },
  { name: "set_content_setting", args: "{\"resource\":cookies|images|javascript|location|notifications|popups,\"primaryPattern\":string,\"setting\":string}", summary: "Set one content setting for a SINGLE-ORIGIN pattern (broad/wildcard patterns are rejected)." },
  { name: "set_default_font", args: "{\"genericFamily\":standard|sansserif|serif|fixed|cursive|fantasy,\"fontId\":string}", summary: "Set the default font for a generic family." },
  { name: "set_extension_enabled", args: "{\"id\":string,\"enabled\":boolean}", summary: "Enable or disable an installed extension by id." },
  { name: "set_font_size", args: "{\"pixelSize\":number}", summary: "Set the default font size in pixels." },
  { name: "set_panel_behavior", args: "{\"openPanelOnActionClick\":boolean}", summary: "Set the side panel behavior (whether clicking the toolbar action opens the panel)." },
  { name: "set_privacy_setting", args: "{\"setting\":network.webRTCIpHandlingPolicy|network.networkPredictionEnabled|services.alternateErrorPagesEnabled|services.autofillAddressEnabled|services.autofillCreditCardEnabled|services.passwordSavingEnabled|services.safeBrowsingEnabled|services.safeBrowsingExtendedReportingEnabled|services.searchSuggestEnabled|services.spellingServiceEnabled|services.translationServiceEnabled|websites.adMeasurementEnabled|websites.doNotTrackEnabled|websites.hyperlinkAuditingEnabled|websites.protectedContentEnabled|websites.referrersEnabled|websites.thirdPartyCookiesAllowed,\"value\":union}", summary: "Set one of Chrome's desktop privacy preferences." },
  { name: "set_proxy_settings", args: "{\"mode\":direct|auto_detect|pac_script|fixed_servers|system,\"pacScript\"?:object,\"rules\"?:object}", summary: "Set the browser proxy configuration (mode + optional PAC script or fixed rules)." },
  { name: "set_side_panel_options", args: "{\"path\":any,\"enabled\"?:boolean,\"tabId\"?:number}", summary: "Set the side panel options." },
  { name: "set_tab_pinned", args: "{\"tabId\":number,\"pinned\":boolean}", summary: "Pin or unpin a tab. Requires browser-control permission (scoped + expiring) for the tab's origin." },
  { name: "set_tab_zoom", args: "{\"tabId\":number,\"zoomFactor\":number}", summary: "Set a tab's zoom factor (bounded 0.25–8, i.e." },
  { name: "show_download", args: "{\"downloadId\":number}", summary: "Show a completed download in the OS file manager." },
  { name: "tab_go_back", args: "{\"tabId\":number}", summary: "Navigate a tab back one entry in its history." },
  { name: "tab_go_forward", args: "{\"tabId\":number}", summary: "Navigate a tab forward one entry in its history." },
  { name: "tts_is_speaking", args: "{}", summary: "Whether text-to-speech is currently speaking." },
  { name: "tts_speak", args: "{\"text\":string,\"voiceName\"?:string,\"rate\"?:number,\"pitch\"?:number,\"volume\"?:number}", summary: "Speak text aloud with Chrome's text-to-speech." },
  { name: "tts_stop", args: "{}", summary: "Stop any ongoing text-to-speech." },
  { name: "type_text", args: "{\"tabId\"?:number,\"ref\":number,\"value\":string,\"submit\"?:boolean}", summary: "Type text into a field by a ref from the last find_elements snapshot (sets the value + dispatches input/change)." },
  { name: "ungroup_tabs", args: "{\"tabIds\":array}", summary: "Remove the given tabs from their tab groups (they return to the tab strip ungrouped)." },
  { name: "uninstall_extension", args: "{\"id\":string,\"confirm\"?:boolean}", summary: "Uninstall an installed extension by id." },
  { name: "unregister_content_script", args: "{\"id\":string}", summary: "Unregister a dynamic content script by id." },
  { name: "unregister_user_script", args: "{\"id\":string}", summary: "Unregister a user script by id." },
  { name: "update_content_script", args: "{\"id\":string,\"js\":string,\"matches\":array,\"runAt\"?:document_start|document_end|document_idle,\"world\"?:ISOLATED|MAIN}", summary: "Update a registered dynamic content script (full replacement: id + js + matches)." },
  { name: "update_network_rule", args: "{\"ruleId\":number,\"priority\"?:number,\"action\":block|allow|redirect|upgradeScheme|modifyHeaders,\"urlFilter\"?:string,\"regexFilter\"?:string,\"resourceTypes\"?:array,\"requestDomains\"?:array,\"redirectUrl\"?:string}", summary: "Replace an existing dynamic network rule (by ruleId) with a new bounded rule shape." },
  { name: "update_reading_list_entry", args: "{\"url\":string,\"title\"?:string,\"hasBeenRead\"?:boolean}", summary: "Update a reading list entry by url (http/https only)." },
  { name: "update_tab_group", args: "{}", summary: "Update a tab group's title, color, or collapsed state." },
  { name: "update_user_script", args: "{\"id\":string,\"js\":string,\"matches\":array,\"runAt\"?:document_start|document_end|document_idle}", summary: "Update a registered user script (full replacement: id + js + matches)." },
  { name: "wait_for", args: "{\"tabId\"?:number,\"ref\"?:number,\"text\"?:string,\"timeoutMs\"?:number}", summary: "Wait (bounded, up to 10 s) for a ref from the last find_elements snapshot to resolve, or for a piece of visible text to appear on the page." },
  { name: "wipe_browsing_data", args: "{\"dataTypes\":array,\"sinceMs\"?:number}", summary: "Wipe explicitly enumerated browsing data types (cache/cookies/history/downloads/fileSystems/formData/indexedDB/localStorage/passwords/pluginData/se…" },
  { name: "write_file", args: "{\"path\":string,\"content\":string,\"grantId\"?:string}", summary: "Write a UTF-8 text file." },
];

/** The prompt block that tells the harness what it can call and how. Injected once per session. */
export function browserToolPromptBlock(): string {
  const lines = BROWSER_TOOL_DECLARATIONS.map((t) => `- ${t.name}(${t.args}) — ${t.summary}`);
  return [
    "## Browser tools available in this app",
    "You are running inside the Chrome Agent Platform. The browser exposes tools to you DIRECTLY over this",
    "connection (no MCP server, no HTTP endpoint). To call one, emit a JSON-RPC request as your next line:",
    '{"jsonrpc":"2.0","id":"<any id>","method":"browser/call_tool","params":{"name":"<tool>","args":{…}}}',
    "The result arrives as the JSON-RPC response with the same id, and each call is subject to the same",
    "browser permissions and user consent as the app's own tools.",
    "",
    // wfo5: some of these ask the owner for approval BEFORE they act. Say so
    // here rather than letting the harness discover it as a refusal — a model
    // told "you may call this" and then refused with no reason retries blindly.
    "Some actions need the owner's approval first: closing a tab or window you did not open, removing a",
    "bookmark, setting or removing a cookie, wiping browsing data, writing a file, and scheduling a saved",
    "script. Those return an approval outcome, never a silent success — read the result. Today they come",
    "back asking for approval in Settings, so treat them as unavailable unless the owner says otherwise.",
    "A refusal is a result, not a transport error: fix the arguments, or choose another tool and say what",
    "you could not do. Everything else — opening and reading tabs, screenshots, clicking, typing,",
    "scrolling, history, bookmarks, downloads, windows, system info — runs subject to the same browser",
    "permissions and consent the app's own tools use.",
    "",
    ...lines,
    "",
    "Example — grouping the user's tabs: call list_tabs, choose the tabIds, then call group_tabs with a",
    'title (e.g. {"name":"group_tabs","args":{"tabIds":[…],"title":"Reading","color":"blue"}}).',
  ].join("\n");
}

/** Sessions already told about the browser tools, so the block is added once, not once per turn. */
const browsertoolsGreeted = new Set<string>();

/** Prepend the browser-tool block to a session's FIRST prompt (pc: params.sessionId). */
export function applyBrowserToolDeclaration(raw: string): string {
  try {
    const msg: any = JSON.parse(raw);
    if (msg?.method !== "session/prompt") return raw;
    const sessionId = String(msg.params?.sessionId ?? msg.sessionId ?? "");
    if (browsertoolsGreeted.has(sessionId)) return raw;
    const blocks = msg.params?.prompt;
    if (!Array.isArray(blocks) || blocks.length === 0) return raw;
    browsertoolsGreeted.add(sessionId);
    const block = { type: "text", text: browserToolPromptBlock() };
    msg.params.prompt = [block, ...blocks];
    return JSON.stringify(msg);
  } catch {
    return raw;
  }
}

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
    let adapterName: string | null = null;
    let initializeId: unknown = null;

    socket.onopen = async () => {
      console.log(`[acp-bridge] Client connected from ${clientOrigin || "local script"} (harness: ${connectionHarness})`);
      try {
        const resolved = resolveAdapter(connectionHarness, adapterPathOverride);
        adapterName = resolved.adapterName;
        // An explicit adapter is a file: say so plainly instead of letting node
        // die with a module-not-found stack.
        if (resolved.cmd === "node" && !Deno.statSync(resolved.args[0]).isFile) {
          throw new Error(`adapter not found: ${resolved.args[0]}`);
        }
        // The scoped child environment, computed once per connection so the host-side note is emitted
        // even when the adapter dies later (5f5u).
        const acpChildEnvResult = acpChildEnv({ ...Deno.env.toObject(), ...childEnv });
        const acpChildEnvNoteText = acpChildEnvNote(acpChildEnvResult, connectionHarness);
        if (acpChildEnvNoteText) console.error(acpChildEnvNoteText);
        const cmd = new Deno.Command(resolved.cmd, {
          args: resolved.args,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          // clearEnv IS REQUIRED, AND IT WAS FOUND BY AN INTEGRATION CHECK RATHER THAN BY A UNIT TEST
          // (5f5u): Deno MERGES `env` over the parent's environment by default, so simply omitting
          // ANTHROPIC_API_KEY left the child seeing the host's value — while the host-side note
          // claimed it had been scoped out. Measured directly: with the default the child prints
          // PRESENT, with clearEnv:true it prints ABSENT. Passing the composed env plus clearEnv
          // makes the child environment exactly what this block builds and nothing more.
          clearEnv: true,
          // 5f5u: the CHILD environment is scoped, not inherited wholesale. An ANTHROPIC_API_KEY in
          // the host takes precedence over a claude.ai login (the adapter's own warning), so a
          // native-login user would be switched auth source silently. Your environment is untouched —
          // CAP_ACP_KEEP_API_KEY=1 passes it through instead.
          env: {
            ...acpChildEnvResult.env,
            PI_ACP_HARNESS: connectionHarness,
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
                  adapterName = adapterNameFromInitialize(line, initializeId, adapterName);
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
                // 5f5u: an auth-precedence warning only visible in a child's stderr is invisible in
                // the surface the user is watching — say it host-side, with the way to change it.
                const authNote = actionableAuthWarning(text);
                if (authNote) console.error(authNote);
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
        const frame = JSON.parse(String(event.data));
        if (frame?.method === "initialize") initializeId = frame.id;
        const refusal = toolServerError(String(event.data), adapterName);
        if (refusal) {
          socket.send(JSON.stringify(refusal));
          return;
        }
        // Host defaults first, then the browser-tool declaration: the harness learns what it can call
        // BACK to Chrome with on its first prompt of the session (2amt).
        const data = applyBrowserToolDeclaration(applyHostDefaults(String(event.data), hostCwdDefault || undefined));
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
