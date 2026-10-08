// @ts-nocheck
// Security documentation is a boundary inventory, not a free-form promise.
// Keep these guards executable against the source they describe (im4e1, em71i,
// xbjki, 5x4iw); the mutants below demonstrate each guard can actually fail.
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
  assertNoRetiredSourcePointer("extension/shared/components.js", shipped);
  assertNoRetiredSourcePointer("docs/components.js", generated);
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
function sourceAnchorLines(ast: unknown, symbol: string): number[] {
  const lines: number[] = [];
  const memberPath = (node: unknown): string | null => {
    if (node?.type === "Identifier") return node.name;
    if (node?.type !== "MemberExpression" || node.computed || node.property?.type !== "Identifier") return null;
    const object = memberPath(node.object);
    return object ? `${object}.${node.property.name}` : null;
  };
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if ((node.type === "VariableDeclarator" || node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
        node.id?.type === "Identifier" && node.id.name === symbol) lines.push(node.id.loc.start.line);
    if (node.type === "CallExpression" && symbol.includes(".") && memberPath(node.callee) === symbol) {
      lines.push(node.loc.start.line); // bare names must resolve to declarations, not callers
    }
    if (node.type === "Property" && node.method && node.key?.type === "Literal" && node.key.value === symbol) {
      lines.push(node.key.loc.start.line); // quoted SW route method, not a comment/string use
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return lines.sort((a, b) => a - b);
}

function assertLiveRouteCitations(model: string, pure: string, worker: string, register = read("docs/RISK-REGISTER.md")): void {
  const sources = new Map([
    ["extension/lib/pure.js", pure],
    ["extension/background/service-worker.js", worker],
  ]);
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
  const pureRoute = ["extension/lib/pure.js", "PAGE_ALLOWED_ROUTES"];
  const listener = ["extension/background/service-worker.js", "chrome.runtime.onMessage.addListener"];
  const allowlist = ["extension/background/service-worker.js", "PAGE_ALLOWED_ROUTES.has"];
  const classifier = ["extension/lib/pure.js", "authorizeToolReport"];
  const swRoute = (name: string) => ["extension/background/service-worker.js", name];
  const fetchRoute = swRoute("cap:fetch");
  const pythonFetch = swRoute("python.fetch");
  const namedTools = swRoute("named-agent.set-tools");
  const exportFolder = swRoute("asset.export-to-folder");
  const hooksSubscribe = swRoute("hooks.subscribe");
  const backgroundSet = swRoute("background-agent.set");
  const sections: Array<[string, string[][]]> = [
    [section(model, "## 1. System Overview", "## 2. Trust Boundaries"), [listener]],
    [section(model, "**TB2 —", "**TB3 —"), [pureRoute, listener, allowlist]],
    [section(model, "**TB4 —", "**TB5 —"), [fetchRoute, pythonFetch]],
    [section(model, "| S1 |", "| S2 |"), [pureRoute, listener]],
    [section(model, "### T2.", "### T3."), [pureRoute, listener, allowlist, classifier]],
    [section(model, "### T4.", "### T5."), [allowlist, namedTools, exportFolder]],
    [section(model, "### T6.", "### T7."), [fetchRoute, pythonFetch]],
    [section(model, "### T13.", "### T14."), [hooksSubscribe, backgroundSet, swRoute("dispatchHook")]],
    [section(model, "**INV-1 —", "**INV-2 —"), [listener, classifier]],
    [section(model, "**INV-2 —", "**INV-3 —"), [pureRoute]],
    [section(model, "**INV-5 —", "**INV-6 —"), [fetchRoute, pythonFetch]],
    [section(register, "### R11", "### R12"), [namedTools, exportFolder, swRoute("background-agent.delete")]],
    [section(register, "### R22", "### R23"), [pureRoute, listener, allowlist, classifier]],
  ];
  for (const [piece, anchors] of sections) for (const [path, symbol] of anchors) check(piece, path, symbol);
  assert(!/extension\/background\/service-worker\.js:\d+/.test(model),
    "THREAT_MODEL must cite service-worker symbols, not drift-prone source lines");
  assert(!/extension\/background\/service-worker\.js:\d+/.test(section(register, "### R22", "### R23")),
    "R22 must cite service-worker symbols, not drift-prone source lines");
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
  const shipped = read("extension/shared/components.js");
  const generated = read("docs/components.js");
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

Deno.test("5x4iw: page route and dispatcher citations resolve at current source symbols", () => {
  const model = read("THREAT_MODEL.md");
  const pure = read("extension/lib/pure.js");
  const worker = read("extension/background/service-worker.js");
  assertLiveRouteCitations(model, pure, worker);
  assertThrows(() => assertLiveRouteCitations(model.replaceAll("extension/lib/pure.js#PAGE_ALLOWED_ROUTES", "extension/lib/pure.js#ABSENT_ROUTE_SET"),
    pure, worker), Error, "missing security anchor", "a citation to a missing symbol must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure.replace("export const PAGE_ALLOWED_ROUTES =", "export const REMOVED_ROUTES ="), worker),
    Error, "missing security anchor extension/lib/pure.js#PAGE_ALLOWED_ROUTES", "removing a cited declaration must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure, worker.replace("!PAGE_ALLOWED_ROUTES.has(message.type)", "true")),
    Error, "missing security anchor extension/background/service-worker.js#PAGE_ALLOWED_ROUTES.has", "removing the live allowlist check must fail");
  assertThrows(() => assertLiveRouteCitations(model, pure, worker.replace('async "cap:fetch"(', 'async "retired:fetch"(')),
    Error, "missing security anchor extension/background/service-worker.js#cap:fetch", "removing a cited SW route must fail");
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
