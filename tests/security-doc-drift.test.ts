// @ts-nocheck
// Security documentation is a boundary inventory, not a free-form promise.
// Keep these guards executable against the source they describe (im4e1, em71i,
// xbjki, 5x4iw, of68a); the mutants below demonstrate each guard can actually fail.
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => Deno.readTextFileSync(`${ROOT}${path}`);

function registeredOffscreenHosts(source: string): string[] {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const hosts: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" &&
        /^register[A-Z]\w*Host$/.test(node.callee.name)) hosts.push(node.callee.name);
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return hosts.sort();
}

function assertOffscreenInventory(source: string, model: string, register: string): void {
  const table = /\*\*Offscreen host inventory[\s\S]*?(?=\n---)/.exec(model)?.[0];
  assert(table, "THREAT_MODEL must retain its authoritative offscreen host table");
  const documented = [...table.matchAll(/^\|\s*`(register[A-Z]\w*Host)`\s*\|/gm)]
    .map((match) => match[1]).sort();
  const actual = registeredOffscreenHosts(source);
  assertEquals(actual.length, new Set(actual).size, "an offscreen host should register once");
  assertEquals(documented, actual, "update the threat-model lane/trust-boundary row for every register*Host() call");
  assert(table.includes("handleScriptRunMessage") && table.includes("cap:clipboard-write"),
    "offscreen's two non-register listeners must stay in the inventory");
  assert(source.includes("handleScriptRunMessage(message, sender") && source.includes('message?.type === "cap:clipboard-write"'),
    "the listed script/clipboard listeners must still exist in the offscreen source");
  assert(register.includes("THREAT_MODEL.md") && register.includes("Offscreen host inventory") &&
    !/single point of failure for five subsystems|multiplexes five independent subsystems/i.test(register),
    "R12 must defer to the single authoritative inventory, not maintain a stale second list");
}

function assertUserWasmDocs(readme: string, catalog: string, offscreen: string, host: string): void {
  const bullet = /^- \*\*Your WebAssembly files\*\*([\s\S]*?)(?=^- \*\*|^## |$(?![\s\S]))/m.exec(readme)?.[1];
  assert(bullet, "README must describe the owner's Wasm files");
  assert(/`user-wasm`/.test(bullet) && /wasm-execution-worker\.js/.test(bullet) && /15-second deadline/.test(bullet),
    "README must explain callable owner-Wasm, its worker and the bounded execution deadline");
  assert(!/storage only|uploads are not run|not registered as callable/i.test(bullet),
    "do not call an executable owner-Wasm source inert storage");
  assert(catalog.includes('"user-wasm"') && offscreen.includes("registerUserWasmHost()") &&
    host.includes('runtime.getURL("lib/wasm-execution-worker.js")'),
    "README's execution claim requires an actual catalog kind, host registration and worker URL");
}

function trackedExtensionJs(): string[] {
  const out: string[] = [];
  const walk = (relative: string) => {
    for (const entry of Deno.readDirSync(`${ROOT}${relative}`)) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory) walk(path);
      else if (entry.isFile && entry.name.endsWith(".js")) out.push(path);
    }
  };
  walk("extension");
  return out;
}

const RETIRED_SOURCE_POINTER = /\bdocs\/(?:KNOWN-ISSUES|TASKS|UI-FIXES-TRACKER)\.md\b|\bUI-FIXES-TRACKER\s+item\b/;
function assertNoRetiredSourcePointer(path: string, source: string): void {
  assert(!RETIRED_SOURCE_POINTER.test(source), `${path} points at a retired tracker instead of live security authority`);
}

function assertLiveBridgePointers(bridge: string, shipped: string, generated: string): void {
  const bridgePointer = "TRUST LIMIT (documented in THREAT_MODEL.md T11)";
  const rendererPointer = "the structured tool-call renderer (extension/shared/tool-tree.js)";
  assert(bridge.includes(bridgePointer) && shipped.includes(rendererPointer) && generated.includes(rendererPointer),
    "shipped and generated comments must carry the live threat-model/tool-tree pointers");
  assert(Deno.statSync(`${ROOT}THREAT_MODEL.md`).isFile &&
    Deno.statSync(`${ROOT}extension/shared/tool-tree.js`).isFile,
    "the cited live documents/source must exist");
  assertNoRetiredSourcePointer("extension/content/bridge-auth.js", bridge);
  assertNoRetiredSourcePointer("extension/shared/components-conversation.js", shipped);
  assertNoRetiredSourcePointer("docs/components-conversation.js", generated);
}

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert(from >= 0, `missing documented section: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert(to > from, `missing next section: ${end}`);
  return text.slice(from, to);
}

// Resolve source AST nodes, not text occurrences: a comment or a second copy
// must not satisfy a missing security check (o75bp; 5x4iw's line pins drifted).
interface AnchorNodeMatch {
  line: number;
  node: { start: number; end: number; loc: { start: { line: number } }; arguments?: any[] };
}

function sourceAnchorNodes(ast: unknown, symbol: string): AnchorNodeMatch[] {
  const matches: AnchorNodeMatch[] = [];
  const memberPath = (node: unknown): string | null => {
    if (node?.type === "Identifier") return node.name;
    if (node?.type !== "MemberExpression" || node.computed || node.property?.type !== "Identifier") return null;
    const object = memberPath(node.object);
    return object ? `${object}.${node.property.name}` : null;
  };
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if ((node.type === "VariableDeclarator" || node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
        node.id?.type === "Identifier" && node.id.name === symbol) matches.push({ line: node.id.loc.start.line, node: node as any });
    if (node.type === "CallExpression" && symbol.includes(".") && memberPath(node.callee) === symbol) {
      matches.push({ line: node.loc.start.line, node: node as any }); // bare names must resolve to declarations, not callers
    }
    if (node.type === "Property" && node.method && node.key?.type === "Literal" && node.key.value === symbol) {
      matches.push({ line: node.key.loc.start.line, node: node as any }); // quoted SW route method, not a comment/string use
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return matches.sort((a, b) => a.line - b.line);
}

function sourceAnchorLines(ast: unknown, symbol: string): number[] {
  return sourceAnchorNodes(ast, symbol).map((m) => m.line);
}

function mcpGuardedTransportWiring(ast: unknown): string[] {
  const wired: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "NewExpression" && node.callee?.type === "Identifier" &&
        (node.callee.name === "StreamableHTTPClientTransport" || node.callee.name === "SSEClientTransport")) {
      const guarded = (Array.isArray(node.arguments) ? node.arguments : []).some((argument) =>
        argument?.type === "ObjectExpression" && (argument.properties ?? []).some((property: any) =>
          property?.type === "Property" && !property.computed &&
          property.key?.type === "Identifier" && property.key.name === "fetch" &&
          property.value?.type === "Identifier" && property.value.name === "guardedFetch"));
      if (guarded) wired.push(node.callee.name);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return wired.sort();
}

function identifierUseLines(ast: unknown, name: string, callsOnly: boolean): number[] {
  const lines: number[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const type = (node as any).type;
    if (type === "ImportSpecifier" || type === "ImportDefaultSpecifier" || type === "ImportNamespaceSpecifier") return;
    if (callsOnly) {
      if (type === "CallExpression") {
        const callee = (node as any).callee;
        if ((callee?.type === "Identifier" && callee.name === name) ||
          (callee?.type === "MemberExpression" && !callee.computed &&
            callee.property?.type === "Identifier" && callee.property.name === name)) {
          lines.push((node as any).loc.start.line);
        }
      }
    } else if (type === "Identifier" && (node as any).name === name) {
      lines.push((node as any).loc.start.line); // import specifiers never reach here
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      // A declaration's own id is not a USE of the name.
      if ((type === "VariableDeclarator" || type === "FunctionDeclaration" || type === "ClassDeclaration") &&
        key === "id" && (value as any)?.type === "Identifier" && (value as any).name === name) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return lines.sort((a, b) => a - b);
}

function assertLiveRouteCitations(model: string, pure: string, worker: string,
  register = read("docs/RISK-REGISTER.md"), extraSources: Map<string, string> = new Map()): void {
  // chrome-agent-platform-atxc6: extracted route modules are anchorable sources too — a citation must
  // resolve to the executable member wherever it now lives, and an unregistered source fails closed.
  const hooks = read("extension/background/routes/hooks.js");
  // of68a: the surface-presence registry. Every THREAT_MODEL.md control anchor resolves against
  // the file the model names; a citation whose file is not registered here FAILS CLOSED, and a
  // cited declaration that disappears from a landing merge fails the gate (surface presence).
  const sources = new Map<string, string>([
    ["extension/lib/pure.js", pure],
    ["extension/lib/pure-webmcp.js", read("extension/lib/pure-webmcp.js")],
    ["extension/lib/pure-trust.js", read("extension/lib/pure-trust.js")],
    ["extension/lib/pure-redact.js", read("extension/lib/pure-redact.js")],
    ["extension/background/service-worker.js", worker],
    ["extension/background/routes/hooks.js", hooks],
    ["extension/lib/fetch-policy.js", read("extension/lib/fetch-policy.js")],
    ["extension/lib/python-network.js", read("extension/lib/python-network.js")],
    ["extension/background/routes/enclave-proxy.js", read("extension/background/routes/enclave-proxy.js")],
    ["extension/lib/skill-import.js", read("extension/lib/skill-import.js")],
    ["extension/lib/script-host.js", read("extension/lib/script-host.js")],
    ["extension/lib/mcp-config.js", read("extension/lib/mcp-config.js")],
    ["extension/lib/mcp-client-core.js", read("extension/lib/mcp-client-core.js")],
    ["extension/lib/mcp-client.js", read("extension/lib/mcp-client.js")],
    ["extension/lib/settings-session.js", read("extension/lib/settings-session.js")],
    ["extension/background/routes/auth.js", read("extension/background/routes/auth.js")],
    ["extension/lib/untrusted-fence.js", read("extension/lib/untrusted-fence.js")],
    ["extension/lib/system-prompts.js", read("extension/lib/system-prompts.js")],
    ["extension/lib/memory.js", read("extension/lib/memory.js")],
    ["extension/lib/archive-target-registry.js", read("extension/lib/archive-target-registry.js")],
    ["extension/lib/browser-tools.js", read("extension/lib/browser-tools.js")],
    ["extension/lib/owner-approval.js", read("extension/lib/owner-approval.js")],
    ["extension/lib/acp-model-host.js", read("extension/lib/acp-model-host.js")],
    ["extension/lib/emscripten-host.js", read("extension/lib/emscripten-host.js")],
    // vuhqh: files whose enforcement CALLS are censused below — registered here so the
    // same fail-closed rule applies (a census file that vanishes fails the gate).
    ["extension/lib/runtime-context.js", read("extension/lib/runtime-context.js")],
    ["extension/lib/tool-summary.js", read("extension/lib/tool-summary.js")],
    ["extension/shared/components-hub.js", read("extension/shared/components-hub.js")],
    ["extension/background/routes/kv.js", read("extension/background/routes/kv.js")],
    ["extension/lib/owner-approval.js", read("extension/lib/owner-approval.js")],
  ]);
  for (const [path, source] of extraSources) sources.set(path, source);
  const parsed = new Map<string, unknown>();
  const check = (piece: string, path: string, symbol: string) => {
    const anchor = `${path}#${symbol}`;
    assert(piece.includes(`\`${anchor}\``), `missing security anchor ${anchor} in documented section`);
    const source = sources.get(path);
    assert(source, `unregistered security anchor source ${path}`);
    if (!parsed.has(path)) parsed.set(path, acorn.parse(source, {
      ecmaVersion: "latest", sourceType: "module", locations: true,
    }));
    const lines = sourceAnchorLines(parsed.get(path), symbol);
    assert(lines.length === 1, `${lines.length ? "ambiguous" : "missing"} security anchor ${anchor}; ` +
      `candidates: ${lines.map((line) => `${path}:${line}`).join(", ") || "none"}`);
  };
  const pureRoute = ["extension/lib/pure-webmcp.js", "PAGE_ALLOWED_ROUTES"];
  const listener = ["extension/background/service-worker.js", "chrome.runtime.onMessage.addListener"];
  const allowlist = ["extension/background/service-worker.js", "PAGE_ALLOWED_ROUTES.has"];
  const classifier = ["extension/lib/pure-trust.js", "authorizeToolReport"];
  const swRoute = (name: string) => ["extension/background/service-worker.js", name];
  const fetchRoute = swRoute("cap:fetch");
  const pythonFetch = swRoute("python.fetch");
  const namedTools = swRoute("named-agent.set-tools");
  const exportFolder = swRoute("asset.export-to-folder");
  // chrome-agent-platform-atxc6: hooks.* moved to extension/background/routes/hooks.js, so its anchor is
  // resolved in THAT module — the citation still points at the executable member, just in its new home.
  const hooksSubscribe = ["extension/background/routes/hooks.js", "hooks.subscribe"];
  const backgroundSet = swRoute("background-agent.set");
  // of68a: the remaining documented control anchors — each pair must appear in the named
  // section as a full backticked `path#symbol` citation AND resolve to exactly one live
  // AST declaration in the registered source. Adding a control to the model without
  // registering its source fails closed; deleting the control from the tree fails here.
  const fetchPolicyPrivate = ["extension/lib/fetch-policy.js", "isPrivateOrLoopbackHost"];
  const fetchPolicyCheck = ["extension/lib/fetch-policy.js", "checkFetchPolicy"];
  const fetchPolicyExtract = ["extension/lib/fetch-policy.js", "extractFetchHosts"];
  const pythonNetwork = ["extension/lib/python-network.js", "checkPythonNetworkRequest"];
  const enclaveProxyRoutes = ["extension/background/routes/enclave-proxy.js", "createEnclaveProxyRoutes"];
  const skillUrl = ["extension/lib/skill-import.js", "validateHttpUrl"];
  const skillRedirects = ["extension/lib/skill-import.js", "fetchWithSafeRedirects"];
  const skillGitHub = ["extension/lib/skill-import.js", "fetchGitHubSkill"];
  const skillDiscover = ["extension/lib/skill-import.js", "discoverRepoSkillsAndCommands"];
  const skillBatch = ["extension/lib/skill-import.js", "installBatchSkillsAndCommands"];
  const scriptHostFetch = ["extension/lib/script-host.js", "runFetch"];
  const mcpNormalize = ["extension/lib/mcp-config.js", "normalizeMcpServerList"];
  const mcpMount = ["extension/lib/mcp-client-core.js", "mountRemoteMcpServers"];
  const mcpGuardedFetch = ["extension/lib/mcp-client-core.js", "createGuardedMcpFetch"];
  const mcpGuardedBinding = ["extension/lib/mcp-client.js", "guardedFetch"];
  const settingsRoutes = ["extension/lib/settings-session.js", "SETTINGS_SESSION_ROUTES"];
  const settingsSessions = ["extension/lib/settings-session.js", "createSettingsSessions"];
  const authSession = ["extension/background/routes/auth.js", "requireSettingsSession"];
  const authSurface = ["extension/background/routes/auth.js", "requireSettingsSurface"];
  const destructiveActions = ["extension/lib/owner-approval.js", "DESTRUCTIVE_ACTIONS"];
  const secretKeyRe = ["extension/lib/pure-redact.js", "SECRET_KEY_RE"];
  const redactSecrets = ["extension/lib/pure-redact.js", "redactSecrets"];
  const mintToken = ["extension/lib/untrusted-fence.js", "mintUntrustedToken"];
  const wrapUntrusted = ["extension/lib/untrusted-fence.js", "wrapUntrustedContent"];
  const tagUntrusted = ["extension/lib/untrusted-fence.js", "tagUntrusted"];
  const renderBoundary = ["extension/lib/system-prompts.js", "renderBoundarySkills"];
  const reservedMaster = ["extension/lib/memory.js", "isReservedMasterKey"];
  const siteReserved = ["extension/lib/memory.js", "SITE_RESERVED_KEYS"];
  const reservedRead = ["extension/lib/memory.js", "isReservedReadKey"];
  const reservedWrite = ["extension/lib/memory.js", "isReservedWriteKey"];
  const credentialKeys = ["extension/lib/archive-target-registry.js", "CREDENTIAL_KEYS"];
  const webDestination = ["extension/lib/browser-tools.js", "webDestination"];
  const trustedSwSender = ["extension/lib/pure-trust.js", "isTrustedServiceWorkerSender"];
  const acpModelHost = ["extension/lib/acp-model-host.js", "registerAcpModelHost"];
  const emscriptenHost = ["extension/lib/emscripten-host.js", "registerEmscriptenHost"];
  const sections: Array<[string, string[][]]> = [
    [section(model, "## 1. System Overview", "## 2. Trust Boundaries"), [listener]],
    [section(model, "**TB2 —", "**TB3 —"), [pureRoute, listener, allowlist]],
    [section(model, "**TB4 —", "**TB5 —"), [fetchRoute, pythonFetch]],
    [section(model, "| S1 |", "| S2 |"), [pureRoute, listener]],
    [section(model, "### T2.", "### T3."), [pureRoute, listener, allowlist, classifier]],
    [section(model, "### T4.", "### T5."), [allowlist, namedTools, exportFolder]],
    [section(model, "### T6.", "### T7."), [fetchRoute, pythonFetch, fetchPolicyPrivate, fetchPolicyCheck,
      fetchPolicyExtract, pythonNetwork, enclaveProxyRoutes, skillUrl, skillRedirects, skillGitHub,
      skillDiscover, skillBatch, scriptHostFetch, swRoute("skill.import")]],
    [section(model, "### T13.", "### T14."), [hooksSubscribe, backgroundSet, swRoute("dispatchHook")]],
    [section(model, "### T14.", "### T15."), [mcpNormalize, mcpMount, mcpGuardedFetch, mcpGuardedBinding]],
    [section(model, "### T19.", "## 6."), [swRoute("browser.destructive-action"), destructiveActions]],
    [section(model, "### T20.", "## 6."), [settingsRoutes, settingsSessions, authSession, authSurface,
      swRoute("settings.session.open"), swRoute("settings.session.close")]],
    [section(model, "**INV-1 —", "**INV-2 —"), [listener, classifier]],
    [section(model, "**INV-2 —", "**INV-3 —"), [pureRoute]],
    [section(model, "**INV-5 —", "**INV-6 —"), [fetchRoute, pythonFetch]],
    [section(model, "**INV-6 —", "**INV-7 —"), [secretKeyRe, redactSecrets]],
    [section(model, "**INV-7 —", "**INV-8 —"), [mintToken, wrapUntrusted, tagUntrusted, renderBoundary]],
    [section(model, "**INV-8 —", "**INV-9 —"), [destructiveActions]],
    [section(model, "**INV-9 —", "**INV-10 —"), [reservedMaster, siteReserved, reservedRead, reservedWrite]],
    [section(model, "**INV-10 —", "**INV-11 —"), [credentialKeys]],
    [section(model, "**INV-11 —", "**INV-12 —"), [webDestination]],
    [section(model, "**INV-15 —", "## 7."), [trustedSwSender, acpModelHost, emscriptenHost]],
    [section(register, "### R6", "### R7"), [swRoute("withRunLock"), swRoute("runTask")]],
    [section(register, "### R8", "### R9"), [swRoute("runTask")]],
    [section(register, "### R11", "### R12"), [namedTools, exportFolder, swRoute("background-agent.delete")]],
    [section(register, "### R12", "### R13"), [swRoute("ensureOffscreen")]],
    [section(register, "### R13", "### R14"), [swRoute("resumeInterruptedRuns")]],
    [section(register, "### R19", "### R20"), [swRoute("owner.import.all")]],
    [section(register, "### R20", "### R21"), [swRoute("readShadowCatalogInputs")]],
    [section(register, "### R22", "### R23"), [pureRoute, listener, allowlist, classifier]],
  ];
  for (const [piece, anchors] of sections) for (const [path, symbol] of anchors) check(piece, path, symbol);

  // Surface presence (of68a): T14 claims BOTH remote MCP transports receive the egress-guarded
  // fetch. The census fails if either construction loses its `fetch: guardedFetch` member — the
  // exact silent-deletion shape (a landing merge dropping a wiring line while every behavioral
  // test mocks the transport) this gate exists for.
  const mcpClientAst = parsed.get("extension/lib/mcp-client.js");
  assert(mcpClientAst,
    "the guarded-transport census requires extension/lib/mcp-client.js to be cited and parsed");
  const wired = mcpGuardedTransportWiring(mcpClientAst);
  assert(wired.includes("StreamableHTTPClientTransport") && wired.includes("SSEClientTransport") &&
      wired.length === 2,
    "both MCP transports must receive the guarded fetch (StreamableHTTPClientTransport, " +
      `SSEClientTransport); wired: ${JSON.stringify(wired)}`);

  // vuhqh: declaration presence is not enforcement. The remaining call/wiring controls get
  // the same census style the MCP transports got: the symbol must still be CALLED (or, for
  // the DESTRUCTIVE_ACTIONS set, REFERENCED by the approval flow) in the file that documents
  // the enforcement. Deleting a call site while keeping its declaration reds here, naming
  // the invariant. Import-specifier mentions and declaration ids never count as use, and a
  // census file missing from the registry above fails closed.
  const astOf = (path: string): any => {
    const source = sources.get(path);
    assert(source !== undefined, `call-site census source ${path} is not registered`);
    if (!parsed.has(path)) parsed.set(path, acorn.parse(source, {
      ecmaVersion: "latest", sourceType: "module", locations: true,
    }));
    return parsed.get(path);
  };
  const REQUIRED_CALL_SITES: Array<[string, string, boolean, string]> = [
    ["extension/lib/skill-import.js", "wrapUntrustedContent", true, "INV-7 (import-time fence)"],
    ["extension/lib/runtime-context.js", "isReservedMasterKey", true, "INV-9 (digest filter)"],
    ["extension/lib/memory.js", "isReservedMasterKey", true, "INV-9 (write gate)"],
    ["extension/lib/browser-tools.js", "webDestination", true, "INV-11 (destination checks)"],
    ["extension/lib/owner-approval.js", "DESTRUCTIVE_ACTIONS", false, "INV-8 (approval keys on the set)"],
    ["extension/lib/tool-summary.js", "redactSecrets", true, "INV-6 (tool-summary surface)"],
    ["extension/shared/components-hub.js", "redactSecrets", true, "INV-6 (hub surface)"],
    ["extension/background/routes/kv.js", "redactSecrets", true, "INV-6 (kv route)"],
    ["extension/background/service-worker.js", "redactSecrets", true, "INV-6 (service-worker surface)"],
  ];
  for (const [path, symbol, callsOnly, why] of REQUIRED_CALL_SITES) {
    const uses = identifierUseLines(astOf(path), symbol, callsOnly);
    assert(uses.length >= 1,
      `the ${why} enforcement is gone: ${path} no longer ${callsOnly ? "calls" : "references"} ${symbol}` +
        ` (a live declaration is not a live control)`);
  }

  // Assert containment (hf1u0): PAGE_ALLOWED_ROUTES.has must lie within the chrome.runtime.onMessage.addListener callback
  const swAst = parsed.get("extension/background/service-worker.js");
  if (swAst) {
    const listenerMatches = sourceAnchorNodes(swAst, "chrome.runtime.onMessage.addListener");
    const allowlistMatches = sourceAnchorNodes(swAst, "PAGE_ALLOWED_ROUTES.has");
    if (listenerMatches.length === 1 && allowlistMatches.length === 1) {
      const listenerCall = listenerMatches[0].node;
      let callback = listenerCall.arguments?.[0];
      // Resolve Identifier callback to its function declaration/variable declarator (uuq1o)
      if (callback?.type === "Identifier") {
        const name = callback.name;
        let resolved = null;
        const findDecl = (node: any) => {
          if (!node || typeof node !== "object" || resolved) return;
          if (node.type === "FunctionDeclaration" && node.id?.name === name) {
            resolved = node;
            return;
          }
          if (node.type === "VariableDeclarator" && node.id?.name === name && node.init &&
              (node.init.type === "FunctionExpression" || node.init.type === "ArrowFunctionExpression")) {
            resolved = node.init;
            return;
          }
          for (const key of Object.keys(node)) {
            if (key === "start" || key === "end" || key === "loc") continue;
            const val = node[key];
            if (Array.isArray(val)) val.forEach(findDecl);
            else if (val && typeof val === "object") findDecl(val);
          }
        };
        findDecl(swAst);
        if (resolved) callback = resolved;
      }
      const allowlistCall = allowlistMatches[0].node;
      assert(
        callback &&
          typeof callback.start === "number" &&
          typeof callback.end === "number" &&
          allowlistCall.start >= callback.start &&
          allowlistCall.end <= callback.end,
        "extension/background/service-worker.js#PAGE_ALLOWED_ROUTES.has must be contained within " +
          "the extension/background/service-worker.js#chrome.runtime.onMessage.addListener callback",
      );
      // Verify allowlistCall is directly within the listener callback, not an inner function (uuq1o)
      let enclosingFunction: any = null;
      const findEnclosing = (node: any) => {
        if (!node || typeof node !== "object") return;
        const isFn = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
        if (isFn && allowlistCall.start >= node.start && allowlistCall.end <= node.end) {
          if (!enclosingFunction || (node.start >= enclosingFunction.start && node.end <= enclosingFunction.end)) {
            enclosingFunction = node;
          }
        }
        for (const key of Object.keys(node)) {
          if (key === "start" || key === "end" || key === "loc") continue;
          const val = node[key];
          if (Array.isArray(val)) val.forEach(findEnclosing);
          else if (val && typeof val === "object") findEnclosing(val);
        }
      };
      findEnclosing(swAst);
      assertEquals(
        enclosingFunction,
        callback,
        "PAGE_ALLOWED_ROUTES.has must be directly inside the message listener callback body, not hidden in an inner function",
      );
    }
  }

  assert(!/extension\/background\/service-worker\.js:\d+/.test(model),
    "THREAT_MODEL must cite service-worker symbols, not drift-prone source lines");
  assert(!/extension\/background\/service-worker\.js:\d+/.test(section(register, "### R22", "### R23")),
    "R22 must cite service-worker symbols, not drift-prone source lines");
  // R11's concrete locator is required by the register's four-field contract;
  // R20's 200-origin expression has no unique named AST declaration. Both are
  // explicitly approximate; no other register SW number may look authoritative.
  const numericSwRows = register.split("\n").filter((line) => /extension\/background\/service-worker\.js:\d+/.test(line));
  assert(numericSwRows.length === 2 &&
    numericSwRows[0].includes("#named-agent.set-tools") && numericSwRows[0].includes("approximate source-line locator") &&
    numericSwRows[1].includes("#readShadowCatalogInputs") && numericSwRows[1].includes("deliberately approximate"),
    "register SW numeric locators must be the two labeled approximations (R11/R20), never an unguarded precise-looking citation");
  assert(!/\b287\b/.test(model), "threat model must not reintroduce the historical 287-route count");
  assert(model.includes(`${registeredOffscreenHosts(read("extension/offscreen/offscreen.js")).length} \`register*Host()\` calls`),
    "the component map must use the actual offscreen registration count");
}

Deno.test("im4e1: offscreen host registrations equal the threat-model rows, with R12 pointing to one table", () => {
  const source = read("extension/offscreen/offscreen.js");
  const model = read("THREAT_MODEL.md");
  const register = read("docs/RISK-REGISTER.md");
  assertOffscreenInventory(source, model, register);
  assertThrows(() => assertOffscreenInventory(`${source}\nregisterNewRuntimeHost();\n`, model, register),
    Error, "registerNewRuntimeHost", "adding a host without a documented row must fail");
  assertThrows(() => assertOffscreenInventory(source,
    model.replace(/^\| `registerUserWasmHost`[^\n]*\n/m, ""), register),
    Error, "registerUserWasmHost", "removing a row while execution remains must fail");
});

Deno.test("em71i: owner Wasm README must reflect the callable catalog and worker", () => {
  const readme = read("README.md");
  const catalog = read("extension/lib/tool-catalog.js");
  const offscreen = read("extension/offscreen/offscreen.js");
  const host = read("extension/lib/user-wasm-host.js");
  assertUserWasmDocs(readme, catalog, offscreen, host);
  assertThrows(() => assertUserWasmDocs(readme.replace("wasm-execution-worker.js", "storage only: uploads are not run"),
    catalog, offscreen, host), Error, "README", "the former false claim must fail");
  assertThrows(() => assertUserWasmDocs(readme, catalog.replaceAll('"user-wasm"', '"inert-store"'), offscreen, host),
    Error, "catalog", "an executable-source removal must invalidate the capability claim");
});

Deno.test("xbjki: shipped and generated JS cite live authority; new retired pointers fail", () => {
  for (const path of trackedExtensionJs()) assertNoRetiredSourcePointer(path, read(path));
  const bridge = read("extension/content/bridge-auth.js");
  const shipped = read("extension/shared/components-conversation.js");
  const generated = read("docs/components-conversation.js");
  assertLiveBridgePointers(bridge, shipped, generated);
  assertThrows(() => assertNoRetiredSourcePointer("extension/new-host.js", "// authority: docs/KNOWN-ISSUES.md"),
    Error, "retired tracker", "a fresh source-file citation must fail");
  assertThrows(() => assertLiveBridgePointers(
    bridge.replace("THREAT_MODEL.md T11", "docs/KNOWN-ISSUES.md"), shipped, generated),
    Error, "live threat-model/tool-tree", "the original bridge citation must fail");
  assertThrows(() => assertLiveBridgePointers(
    bridge, shipped.replace("extension/shared/tool-tree.js", "UI-FIXES-TRACKER item 4"), generated),
    Error, "live threat-model/tool-tree", "the original shipped renderer citation must fail");
  assertThrows(() => assertLiveBridgePointers(
    bridge, shipped, generated.replace("extension/shared/tool-tree.js", "UI-FIXES-TRACKER item 4")),
    Error, "live threat-model/tool-tree", "the original generated renderer citation must fail");
});

Deno.test("o75bp: unrelated source-line insertions do not invalidate live security citations", () => {
  const model = read("THREAT_MODEL.md");
  const pure = read("extension/lib/pure.js");
  const worker = read("extension/background/service-worker.js");
  assertLiveRouteCitations(model, pure, `\n`.repeat(45) + worker);
});

Deno.test("nk7vi: register symbols survive relocation but missing or ambiguous sources fail closed", () => {
  const model = read("THREAT_MODEL.md");
  const pure = read("extension/lib/pure.js");
  const worker = read("extension/background/service-worker.js");
  assertLiveRouteCitations(model, pure, `\n`.repeat(45) + worker);
  assertThrows(() => assertLiveRouteCitations(model, pure,
    worker.replace("async function resumeInterruptedRuns()", "async function retiredInterruptedRuns()")),
    Error, "missing security anchor extension/background/service-worker.js#resumeInterruptedRuns");
  assertThrows(() => assertLiveRouteCitations(model, pure,
    worker.replace('async "owner.import.all"(', 'async "owner.retired-import"(')),
    Error, "missing security anchor extension/background/service-worker.js#owner.import.all");
  const ambiguous = assertThrows(() => assertLiveRouteCitations(model, pure,
    `${worker}\n{ function readShadowCatalogInputs() {} }\n`),
    Error, "ambiguous security anchor extension/background/service-worker.js#readShadowCatalogInputs");
  assert(/candidates: (?:extension\/background\/service-worker\.js:\d+, ){1}extension\/background\/service-worker\.js:\d+/.test(ambiguous.message),
    "duplicate R20 enclosing-function symbols must list both source lines");
});

Deno.test("5x4iw: page route and dispatcher citations resolve at current source symbols", () => {
  const model = read("THREAT_MODEL.md");
  const pure = read("extension/lib/pure.js");
  const worker = read("extension/background/service-worker.js");
  assertLiveRouteCitations(model, pure, worker);
  assertThrows(() => assertLiveRouteCitations(model.replaceAll("extension/lib/pure-webmcp.js#PAGE_ALLOWED_ROUTES", "extension/lib/pure-webmcp.js#ABSENT_ROUTE_SET"),
    pure, worker), Error, "missing security anchor", "a citation to a missing symbol must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure, worker, undefined, new Map([
    ["extension/lib/pure-webmcp.js", read("extension/lib/pure-webmcp.js").replace("export const PAGE_ALLOWED_ROUTES =", "export const REMOVED_ROUTES =")],
  ])),
    Error, "missing security anchor extension/lib/pure-webmcp.js#PAGE_ALLOWED_ROUTES", "removing a cited declaration must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure, worker.replace("!PAGE_ALLOWED_ROUTES.has(message.type)", "true")),
    Error, "missing security anchor extension/background/service-worker.js#PAGE_ALLOWED_ROUTES.has", "removing the live allowlist check must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure,
    worker.replace("!PAGE_ALLOWED_ROUTES.has(message.type)", "true") +
      "\nvoid PAGE_ALLOWED_ROUTES.has('dead-code');\n"),
    Error, "must be contained within", "moving the allowlist check outside the listener callback must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure, worker.replace('async "cap:fetch"(', 'async "retired:fetch"(')),
    Error, "missing security anchor extension/background/service-worker.js#cap:fetch", "removing a cited SW route must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure,
    worker.replace('async "browser.destructive-action"(', 'async "retired:destructive-action"(')),
    Error, "missing security anchor extension/background/service-worker.js#browser.destructive-action",
    "renaming the newly cited T19 owner-approval route must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure,
    worker.replace("chrome.runtime.onMessage.addListener(", "renamedListener(") +
      "\n// chrome.runtime.onMessage.addListener( is not an executable site\n"),
    Error, "missing security anchor extension/background/service-worker.js#chrome.runtime.onMessage.addListener",
    "deleting the cited listener must fail even when a comment shadows its spelling");
  const ambiguous = assertThrows(() => assertLiveRouteCitations(model, pure,
    worker + "\nchrome.runtime.onMessage.addListener(() => {});\n"),
    Error, "ambiguous security anchor extension/background/service-worker.js#chrome.runtime.onMessage.addListener",
    "duplicating the listener must fail");
  assert(/candidates: (?:extension\/background\/service-worker\.js:\d+, ){1}extension\/background\/service-worker\.js:\d+/.test(ambiguous.message),
    "ambiguity diagnostic must list both newly resolved source lines for a mechanical retarget");
});

Deno.test("of68a: documented control anchors resolve to live declarations — deleting one must red", () => {
  const model = read("THREAT_MODEL.md");
  const pure = read("extension/lib/pure.js");
  const worker = read("extension/background/service-worker.js");
  assertLiveRouteCitations(model, pure, worker);

  // The bead's own falsifier: a landing merge drops one transport's guarded-fetch wiring
  // while the model still claims it — the census must name the lost transport.
  const mcpClient = read("extension/lib/mcp-client.js");
  assertThrows(() =>
    assertLiveRouteCitations(model, pure, worker, undefined, new Map([
      ["extension/lib/mcp-client.js",
        mcpClient.replace("return new SSEClientTransport(url, { requestInit, fetch: guardedFetch });",
          "return new SSEClientTransport(url, { requestInit });")],
    ])),
    Error, "SSEClientTransport", "dropping the SSE transport's guarded fetch must fail the census");

  // A cited declaration is deleted from the tree (INV-7's fence).
  const fence = read("extension/lib/untrusted-fence.js");
  assertThrows(() =>
    assertLiveRouteCitations(model, pure, worker, undefined, new Map([
      ["extension/lib/untrusted-fence.js",
        fence.replace("export function wrapUntrustedContent(content, token = UNTRUSTED_TOKEN_PLACEHOLDER)",
          "export function retiredWrapUntrustedContent(content)")],
    ])),
    Error, "missing security anchor extension/lib/untrusted-fence.js#wrapUntrustedContent",
    "deleting a cited fence declaration must fail");

  // A cited declaration is duplicated (INV-9's reserved-key gate).
  const memory = read("extension/lib/memory.js");
  const ambiguous = assertThrows(() =>
    assertLiveRouteCitations(model, pure, worker, undefined, new Map([
      ["extension/lib/memory.js", `${memory}\n{\nfunction isReservedReadKey(also) { return false; }\n}\n`],
    ])),
    Error, "ambiguous security anchor extension/lib/memory.js#isReservedReadKey");
  assert(/candidates: extension\/lib\/memory\.js:\d+, extension\/lib\/memory\.js:\d+/.test(ambiguous.message),
    "the ambiguity diagnostic must list both candidate declarations");

  // The citation is stripped from the model while the code stays — doc drift, caught.
  assertThrows(() =>
    assertLiveRouteCitations(model.replace("extension/lib/memory.js#isReservedMasterKey", "extension/lib/memory.js"),
      pure, worker),
    Error, "missing security anchor extension/lib/memory.js#isReservedMasterKey in documented section",
    "removing a documented anchor must fail");

  // Stability (o75bp's rule, applied to the newly registered sources): unrelated line
  // shifts in a registered source must not invalidate its resolved anchors.
  const shifted = new Map([
    ["extension/lib/system-prompts.js", "\n".repeat(40) + read("extension/lib/system-prompts.js")],
  ]);
  assertLiveRouteCitations(model, pure, worker, undefined, shifted);
});

Deno.test("vuhqh: deleting a documented enforcement CALL SITE reds, not just deleting the declaration", () => {
  // The reviewer's exact repro: the INV-7 import-time fence call is replaced with a
  // passthrough while wrapUntrustedContent stays declared — the gate must red naming
  // the invariant (declaration presence is not enforcement).
  const model = read("THREAT_MODEL.md");
  const pure = read("extension/lib/pure.js");
  const worker = read("extension/background/service-worker.js");
  const skillImport = read("extension/lib/skill-import.js");
  assert(skillImport.includes("return wrapUntrustedContent(str, token);"),
    "the census's own fixture must match the live fence call in skill-import.js");
  assertThrows(() =>
    assertLiveRouteCitations(model, pure, worker, undefined, new Map([
      ["extension/lib/skill-import.js",
        skillImport.replace("return wrapUntrustedContent(str, token);", "return str;")],
    ])),
    Error, "INV-7 (import-time fence)", "unfencing the import path must fail the call-site census");

  // INV-9: the digest filter stops consulting isReservedMasterKey (the lx7en wiring).
  const runtimeContext = read("extension/lib/runtime-context.js");
  assertThrows(() =>
    assertLiveRouteCitations(model, pure, worker, undefined, new Map([
      ["extension/lib/runtime-context.js",
        runtimeContext.replace("return DIGEST_ADDITIONAL_SKIP_KEYS.has(k) || isReservedMasterKey(k);",
          "return DIGEST_ADDITIONAL_SKIP_KEYS.has(k);")],
    ])),
    Error, "INV-9 (digest filter)", "narrowing the digest filter past reserved keys must fail");

  // INV-8: the approval flow stops keying on DESTRUCTIVE_ACTIONS — a bare declaration
  // id and import mentions must NOT satisfy the census.
  const ownerApproval = read("extension/lib/owner-approval.js");
  assertThrows(() =>
    assertLiveRouteCitations(model, pure, worker, undefined, new Map([
      ["extension/lib/owner-approval.js",
        ownerApproval
          .replace("if (!store?.approvals || !DESTRUCTIVE_ACTIONS.has(action)) return { ok: false, error: \"operation is not approvable\" };",
            "if (!store?.approvals) return { ok: false, error: \"operation is not approvable\" };")
          .replace("if (typeof action !== \"string\" || !DESTRUCTIVE_ACTIONS.has(action)) return null;",
            "if (typeof action !== \"string\") return null;")],
    ])),
    Error, "INV-8 (approval keys on the set)", "a set that nothing keys on is not enforcement");

  // INV-6: one redaction caller surface loses its redactSecrets call.
  const kv = read("extension/background/routes/kv.js");
  const firstKvCall = kv.match(/redactSecrets\(/);
  assert(firstKvCall, "the kv route fixture must find a live redactSecrets call");
  assertThrows(() =>
    assertLiveRouteCitations(model, pure, worker, undefined, new Map([
      ["extension/background/routes/kv.js", kv.replace(/redactSecrets\(/, "retiredRedact(")],
    ])),
    Error, "INV-6 (kv route)", "dropping a redaction caller surface must fail");

  // Stability: line shifts in a census file never invalidate a live call site.
  assertLiveRouteCitations(model, pure, worker, undefined, new Map([
    ["extension/lib/runtime-context.js", "\n".repeat(30) + runtimeContext],
  ]));
});
