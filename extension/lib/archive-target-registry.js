// Single authority for classifying durable targets by their EXACT store
// grammar. Derived from the write-site census (target-census-authoritative.md)
// and the coordinator policy (COORDINATOR-TARGET-POLICY.md) — every row cites
// an owning module there. Unknown roots, unknown KV keys, and paths violating
// a known root's grammar are "unclassified": never exported, never deleted —
// export fails with an owner-visible report, import rejects before mutation.
//
// Classes: portable-user-data · portable-terminal-validated (exact ids,
// trusted import path) · portable-redacted (secret fields stripped) ·
// portable-revalidate (owning validator/quarantine on import) ·
// portable-deny-union (merge, never weaken) · rebuildable · ephemeral ·
// authority (never crosses an archive) · transaction-private ·
// internal-secret · unclassified. Pure module: no I/O, no chrome.*.

const PORTABLE = "portable-user-data";
const TERMINAL = "portable-terminal-validated";

const OPFS_ROOTS = new Map([
  ["memory", PORTABLE],                    // memory.js ROOT — store subrules below
  ["cap-user-wasm-v1", PORTABLE],          // user-wasm-store.js — flat-pair subrules
  ["agent-workspaces", PORTABLE],
  ["cap-skills", PORTABLE],
  ["cache", "rebuildable"],
  ["usage", "rebuildable"],
  ["wasm-tool-streams-v1", "ephemeral"],
  ["tool-jobs", "ephemeral"],
  ["chrome-agent-platform-private", "internal-secret"],
  ["archive-transactions-v1", "transaction-private"],
]);

// ---- Exact store grammars (COORDINATOR-TARGET-POLICY.md, OPFS section) ----
//
// A MemoryStore is FLAT: files are exactly `<key>.json` (nonempty key) plus
// `__gen.json`/`__tombs.json`/`__epoch.json` integrity files, direct
// `*.tomb` and legacy dot-`*.version` sidecars, and the one nested family
// `memory/master/screenshots/shot_<32hex>.json` (memory.js:1705-1721).
const INTEGRITY_LEAF = /^(?:__gen|__tombs|__epoch)\.json$/u;
const TOMB_LEAF = /^[^/]+\.tomb$/u;
const LEGACY_VERSION_LEAF = /^\.[^/]+\.version$/u;
const KEY_LEAF = /^[^/]+\.json$/u;
const RESIDUE_LEAF = /^__(?:wal|tx|wasmTx)/u;
const SCREENSHOT_LEAF = /^shot_[0-9a-f]{32}\.json$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
// Canonical encodeURIComponent output: unreserved chars + %XX escapes only.
const ENCODED = /^(?:[A-Za-z0-9\-._~!*'()]|%[0-9A-Fa-f]{2})+$/u;
// Source parity with memory.js:229 (DURABLE_KEY_RE is constructed with "i").
const EXEC_ID = /^(?:exec:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|exec_[A-Za-z0-9][A-Za-z0-9_-]{7,194})$/iu;
const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/u; // memory.js:240 THREAD_ID_RE
const WORKSPACE_KEY = /^(?:named|background)-[a-z0-9][a-z0-9-]{0,63}$/u;
const SKILL_ID = /^[a-z0-9-_]+$/u;
const MAX_WORKSPACE_DEPTH = 8; // agent-workspace.js:37

const MASTER_TERMINAL = new Set([
  "threads.json", "assets.json", "screenshots.json", "run-registry.json",
  "run-dismissed-failed.json", "cap:board-jobs.json", "cap:board-messages.json",
  "cap:action-ledger.json", "cap:delegation-log.json",
]);
const MASTER_REVALIDATE = new Set(["scripts.json", "cap:board-wakes.json"]);
const MASTER_AUTHORITY = new Set(["enrolled.json", "origins.json", "wasmPkg.json"]);
const MASTER_RESIDUE = new Set(["wasmPkgRepair.json", "assetRepair.json"]);
const ORIGIN_AUTHORITY = new Set([
  "profile:webmcp-tool-consent-v1.json", // site-tool-consent.js:13
  "enrolled.json",
  "approvals.json",
]);
const ORIGIN_TERMINAL = new Set(["journal.json", "assets.json"]);
// Only the known profile dossier/audit keys are portable (profile memory
// sections); unknown profile:* leaves fail closed.
const PROFILE_KEYS = new Set([
  "profile:basic.json", "profile:work_history.json", "profile:education.json",
  "profile:disclosures.json", "profile:audit_log.json", "profile:audit_log_archive.json",
]);

const BAD_SEGMENT = /^(?:\.{1,2})$|[\\\x00-\x1f]/u;

const WASM_DIGEST_FILE = /^[0-9a-f]{64}\.(?:wasm|json)$/u;
const WASM_RESIDUE = /^(?:delete-[0-9a-f]{64}\.json|upload-[0-9a-f-]+\.wasm)$/u;

function leafKind(leaf) {
  if (RESIDUE_LEAF.test(leaf)) return "residue";
  if (INTEGRITY_LEAF.test(leaf) || TOMB_LEAF.test(leaf) || LEGACY_VERSION_LEAF.test(leaf)) return "integrity";
  if (KEY_LEAF.test(leaf)) return "key";
  return null;
}

const WITH_STORE = "portable-with-store"; // integrity/tomb/version travel with their store

// Classify a master-store key leaf (already known to be `<key>.json`).
function masterKeyClass(leaf) {
  // agent-board.js persists this policy in master MemoryStore, never KV.
  if (leaf === "cap:board-deny-rules.json") return "portable-deny-union";
  if (MASTER_AUTHORITY.has(leaf)) return "authority";
  if (MASTER_RESIDUE.has(leaf)) return "transaction-private";
  if (MASTER_TERMINAL.has(leaf)) return TERMINAL;
  if (MASTER_REVALIDATE.has(leaf)) return "portable-revalidate";
  const key = leaf.slice(0, -5); // strip .json
  if (key.startsWith("asset:") || key.startsWith("asset-")) return TERMINAL;
  if (key.startsWith("thread:")) return TERMINAL; // reserved thread bodies
  if (key === "run-resume" || key.startsWith("run-resume:")) return "transaction-private";
  if (/^run(?:-outbox|-log|-log-idx|-payload)?:/.test(key)) return TERMINAL;
  if (PROFILE_KEYS.has(leaf)) return PORTABLE;
  if (key.startsWith("profile:")) return "unclassified"; // unknown profile section
  return PORTABLE; // safe arbitrary logical user key (pinned fallthrough)
}

function originKeyClass(leaf) {
  if (ORIGIN_AUTHORITY.has(leaf)) return "authority";
  if (ORIGIN_TERMINAL.has(leaf)) return TERMINAL;
  if (leaf === "toolDirectory.json") return "rebuildable";
  if (leaf === "agentConfig.json") return "portable-redacted";
  if (leaf === "scripts.json") return "portable-revalidate";
  if (PROFILE_KEYS.has(leaf)) return PORTABLE;
  if (leaf.startsWith("profile:")) return "unclassified";
  return PORTABLE;
}


// ---- KV table: write-site-derived storage.local keys ONLY (message types
// and memory-master leaves are deliberately absent: impostors reject) ----
const KV_AUTHORITY = new Set([
  "cap:attestationKey", "cap:browserControlGrant", "cap:enrollment",
  "cap:enrollmentGen", "cap:webmcpStatus", "cap:webmcpSnapshotGate",
  "cap:agent-workers:alive", "cap:webmcpBridgeNonces", // legacy marker
]);
const KV_REBUILDABLE = new Set(["cap:knownWebmcpOrigins", "cap:diagnosticsRevision"]);
const KV_EPHEMERAL = new Set([
  "cap:scheduledInflight", "cap:pendingCleanup", "cap:threadQueues",
  "agents-pending-teardown", "cap:notifications:index",
]);
const KV_EPHEMERAL_PREFIXES = ["cap:notification:"];
const KV_DENY_UNION = new Set([
  "cap:hooksDeny", "cap:destructiveActionPolicy",
]);
const KV_REVALIDATE = new Set([
  "cap:hooks", "cap:scheduledTasks", "cap:developerFeatures",
  "cap:promptOverrides", "cap:promptOverrides:quarantine",
]);
const KV_REDACTED = new Set(["providerConfig", "cap:mcpServers", "cap:namedAgents"]);
const KV_TERMINAL = new Set([
  "cap:events", "cap:usage:v2", "cap:usage:tools:v1", "cap:usage:server-tools:v1",
  "cap:requestActivity", "cap:rawAlarms",
]);
const KV_PORTABLE = new Set([
  "cap:autoCloseRunTabs", "cap:multiAgent", "cap:providerServerTools",
  "cap:logVerbosity", "cap:logFullDetail", "cap:sidepanelTarget",
  "cap:sidepanel:page-threads", "cap:sidepanel:selected-agent",
  "cap:siteActivityFocus", "cap:first-run-browser-choice",
  "cap:first-run-guide-dismissed", "cap:webmcpDiagnostics", "cap:runRetention",
]);
const KV_PORTABLE_PREFIXES = ["cap:hub-seen:"];

function result(cls, root) {
  return Object.freeze({ cls, root });
}

// Exact canonical encode: the segment must BE encodeURIComponent(decoded) —
// raw hosts, %41 aliases, and lowercase-normalized escapes all reject.
function canonicalId(segment) {
  let decoded;
  try { decoded = decodeURIComponent(segment); } catch { return null; }
  if (decoded.length === 0 || encodeURIComponent(decoded) !== segment) return null;
  return decoded;
}

// Origin dirs are canonical http(s) URL origins under exact encodeURIComponent.
function canonicalOrigin(segment) {
  const decoded = canonicalId(segment);
  if (decoded === null) return false;
  try {
    const url = new URL(decoded);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === decoded;
  } catch {
    return false;
  }
}

function classifyMemory(segments) {
  // segments[0] === "memory"
  const scope = segments[1];
  if (scope === "master") {
    if (segments.length === 3) {
      const kind = leafKind(segments[2]);
      if (kind === "residue") return "transaction-private";
      if (kind === "integrity") return WITH_STORE;
      if (kind !== "key") return "unclassified";
      return masterKeyClass(segments[2]);
    }
    // The one nested family: master screenshots.
    if (segments.length === 4 && segments[2] === "screenshots") {
      return SCREENSHOT_LEAF.test(segments[3]) ? TERMINAL : "unclassified";
    }
    return "unclassified";
  }
  if ((scope === "agents" || scope === "background") && segments.length === 4) {
    if (!SLUG.test(segments[2])) return "unclassified";
    const kind = leafKind(segments[3]);
    if (kind === "residue") return "transaction-private";
    if (kind === "integrity") return WITH_STORE;
    if (kind === null) return "unclassified";
    return PORTABLE;
  }
  if (scope === "origins" && segments.length === 4) {
    if (!canonicalOrigin(segments[2])) return "unclassified";
    const kind = leafKind(segments[3]);
    if (kind === "residue") return "transaction-private";
    if (kind === "integrity") return WITH_STORE;
    if (kind !== "key") return "unclassified";
    return originKeyClass(segments[3]);
  }
  if (scope === "durable-runs") {
    // Exact owning leaves per store (writer-derived; the adjudicated durable
    // fixture). DURABLE_KEY_RE `(?::|$)` is only a ROUTING recognizer —
    // admission requires the actual written key shapes with the embedded id
    // equal to the decoded directory id. Sidecars (*.tomb / .*.version) are
    // owned only when their base .json leaf is itself an owning leaf;
    // __gen/__tombs/__epoch remain unconditional store metadata.
    if (segments[2] === "registry" && segments.length === 4) {
      return durableLeafClass(segments[3], (leaf) =>
        leaf === "run-registry.json" || leaf === "run-dismissed-failed.json");
    }
    if ((segments[2] === "executions" || segments[2] === "payloads" || segments[2] === "threads") &&
        segments.length === 5) {
      const id = canonicalId(segments[3]);
      if (id === null) return "unclassified"; // not an exact canonical encode
      if (segments[2] === "threads") {
        if (!THREAD_ID.test(id)) return "unclassified";
        // The one owning key; there is NO run.log sidecar under threads.
        return durableLeafClass(segments[4], (leaf) => leaf === `thread-runs:${id}.json`);
      }
      if (!EXEC_ID.test(id)) return "unclassified";
      if (segments[2] === "executions") {
        if (segments[4] === "run.log") return TERMINAL; // executions-only sidecar
        return durableLeafClass(segments[4], (leaf) =>
          executionLeafOk(leaf.slice(0, -5), id));
      }
      // payloads
      return durableLeafClass(segments[4], (leaf) =>
        payloadLeafOk(leaf.slice(0, -5), id));
    }
    return "unclassified";
  }
  return "unclassified";
}

// Classify a durable-store leaf against the store's exact owning .json
// grammar. `ownsJsonLeaf` receives a `<key>.json` leaf. run.log.json is
// fabricated everywhere under durable-runs (the sidecar never carries .json).
function durableLeafClass(leaf, ownsJsonLeaf) {
  if (RESIDUE_LEAF.test(leaf)) return "transaction-private";
  if (leaf === "run.log.json") return "unclassified";
  if (INTEGRITY_LEAF.test(leaf)) return WITH_STORE; // unconditional store metadata
  // Sidecar names wrap the OWNING FILE leaf: `<key>.json.tomb` and
  // `.<key>.json.version` — stripping the suffix yields the base .json leaf
  // directly (do NOT append another .json).
  if (TOMB_LEAF.test(leaf)) {
    const base = leaf.slice(0, -".tomb".length);
    return ownsJsonLeaf(base) ? WITH_STORE : "unclassified";
  }
  const legacy = leaf.match(/^\.(.+)\.version$/u);
  if (legacy) {
    return ownsJsonLeaf(legacy[1]) ? WITH_STORE : "unclassified";
  }
  if (!KEY_LEAF.test(leaf)) return "unclassified";
  return ownsJsonLeaf(leaf) ? TERMINAL : "unclassified";
}

// Actual execution-store writers (durable-runs.js): run:<id> record,
// run-outbox:<id>, run-log-idx:<id>, run-log-wal:<id> (migration marker),
// run-log:<id>:<row> rows, run-resume:<id>:manifest | :NNNNNN chunks.
// NO bare run-resume:<id> — the recognizer's `(?::|$)` is routing-only.
function executionLeafOk(key, id) {
  if (key === `run:${id}` || key === `run-outbox:${id}` ||
      key === `run-log-idx:${id}` || key === `run-log-wal:${id}`) return true;
  if (key.startsWith(`run-log:${id}:`) && key.length > `run-log:${id}:`.length) return true;
  if (key === `run-resume:${id}:manifest`) return true;
  if (key.startsWith(`run-resume:${id}:`) &&
      /^\d{6}$/u.test(key.slice(`run-resume:${id}:`.length))) return true;
  return false;
}

// Payload store: run-payload:<execId>:<payloadId>:manifest | :NNNNNN
// (durable-runs.js:462-465). payloadId is exactly `terminal` or lowercase
// 64-hex (the actual call sites); the embedded execution id must equal the
// decoded directory id.
function payloadLeafOk(key, id) {
  const prefix = `run-payload:${id}:`;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length); // <payloadId>:(manifest|NNNNNN)
  const at = rest.lastIndexOf(":");
  if (at <= 0) return false;
  const payloadId = rest.slice(0, at);
  if (payloadId !== "terminal" && !/^[0-9a-f]{64}$/u.test(payloadId)) return false;
  const tail = rest.slice(at + 1);
  return tail === "manifest" || /^\d{6}$/u.test(tail);
}


export function classifyOpfsPath(path) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("archive_target_path");
  // OPFS consumes USVString: lone UTF-16 units would alias literal U+FFFD.
  // Check globally, including roots that otherwise short-circuit classification.
  if (!path.isWellFormed()) return result("unclassified", path.split("/", 1)[0]);
  const segments = path.split("/");
  const root = segments[0];
  if (root.startsWith(".") || root === "archive-transactions-v1") {
    return result("transaction-private", root);
  }
  const cls = OPFS_ROOTS.get(root);
  if (!cls) return result("unclassified", root);
  if (cls !== PORTABLE) return result(cls, root);
  // Known roots still require valid grammar: no empty/dot/backslash/control segments.
  if (segments.some((seg) => seg.length === 0 || BAD_SEGMENT.test(seg))) {
    return result("unclassified", root);
  }
  if (root === "memory") return result(classifyMemory(segments), root);
  if (root === "cap-user-wasm-v1") {
    if (segments.length !== 2) return result("unclassified", root); // flat store grammar
    const leaf = segments[1];
    if (WASM_RESIDUE.test(leaf)) return result("transaction-private", root);
    if (!WASM_DIGEST_FILE.test(leaf)) return result("unclassified", root);
    return result(PORTABLE, root);
  }
  if (root === "agent-workspaces") {
    // agent-workspaces/<named|background>-<slug>/<relative-file>, depth-bounded.
    if (segments.length < 3 || segments.length - 2 > MAX_WORKSPACE_DEPTH ||
        !WORKSPACE_KEY.test(segments[1])) {
      return result("unclassified", root);
    }
    return result(PORTABLE, root);
  }
  if (root === "cap-skills") {
    // cap-skills/<sanitized-skill-id>/<relative-file> — a bare id is not a file.
    if (segments.length < 3 || !SKILL_ID.test(segments[1])) {
      return result("unclassified", root);
    }
    return result(PORTABLE, root);
  }
  return result(PORTABLE, root);
}

export function classifyKvKey(key) {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("archive_target_key");
  if (KV_AUTHORITY.has(key)) return Object.freeze({ cls: "authority" });
  if (KV_REBUILDABLE.has(key)) return Object.freeze({ cls: "rebuildable" });
  if (KV_EPHEMERAL.has(key) || KV_EPHEMERAL_PREFIXES.some((p) => key.startsWith(p))) {
    return Object.freeze({ cls: "ephemeral" });
  }
  if (KV_DENY_UNION.has(key)) return Object.freeze({ cls: "portable-deny-union" });
  if (KV_REVALIDATE.has(key)) return Object.freeze({ cls: "portable-revalidate" });
  if (KV_REDACTED.has(key)) return Object.freeze({ cls: "portable-redacted" });
  if (KV_TERMINAL.has(key)) return Object.freeze({ cls: TERMINAL });
  if (KV_PORTABLE.has(key) || KV_PORTABLE_PREFIXES.some((p) => key.startsWith(p))) {
    return Object.freeze({ cls: PORTABLE });
  }
  return Object.freeze({ cls: "unclassified" });
}

// Credential fields are the exact schema fields the owning modules define
// (provider.js apiKey; mcp-config.js auth.token; named-agents provider.apiKey)
// — never a name regex (tokenLimit and friends are benign config).
const CREDENTIAL_KEYS = new Set(["apiKey", "authToken", "clientSecret"]);

// Global MCP copies all own data; recursive provider/named/origin contexts
// additionally omit their exact reserved fields. Descriptors never run getters.
function copyConfigData(value, redact = true) {
  if (!value || typeof value !== "object") return value;
  const out = Array.isArray(value) ? new Array(value.length) : {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) throw new TypeError("archive_target_accessor");
    if (redact && (CREDENTIAL_KEYS.has(key) || key === "__proto__")) continue;
    Object.defineProperty(out, key, {
      value: copyConfigData(descriptor.value, redact), enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}

function requireRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(code);
}

// Count raw UTF-8 without materializing an encoded copy or parsing first.
// Iteration combines valid pairs; lone units count as the encoder's U+FFFD.
function requireUtf8Bound(value, bound) {
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0);
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > bound) throw new TypeError("archive_target_url_bound");
  }
}

function sanitizeProviderRecord(record, identity, named = false) {
  requireRecord(record, "archive_target_provider");
  if (!Object.hasOwn(record, identity) || typeof record[identity] !== "string" ||
      (identity === "id" && (record.id.length === 0 || Object.hasOwn(record, "provider")))) {
    throw new TypeError("archive_target_provider_identity");
  }
  let baseURL;
  if (Object.hasOwn(record, "baseURL")) {
    baseURL = record.baseURL;
    if (typeof baseURL !== "string") throw new TypeError("archive_target_provider_url");
    if (named && baseURL.length > 512) throw new TypeError("archive_target_provider_url_bound");
    requireUtf8Bound(baseURL, 10 * 1024 * 1024);
    if (baseURL !== "") {
      let url;
      try { url = new URL(baseURL); } catch { throw new TypeError("archive_target_provider_url"); }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.host ||
          url.username || url.password || url.search || url.hash) {
        throw new TypeError("archive_target_provider_url");
      }
      baseURL = url.href;
    }
  }
  const out = copyConfigData(record);
  if (Object.hasOwn(record, "baseURL")) out.baseURL = baseURL;
  return out;
}

// Current flat { provider, baseURL, apiKey, model, ... } and defensive legacy
// { activeProvider?, providers: [{ id, ... }] } have distinct own identities.
export function sanitizeProviderConfig(config) {
  requireRecord(config, "archive_target_provider");
  if (!Object.hasOwn(config, "providers")) return sanitizeProviderRecord(config, "provider");
  if (!Array.isArray(config.providers) || Object.hasOwn(config, "provider") ||
      (Object.hasOwn(config, "activeProvider") && typeof config.activeProvider !== "string")) {
    throw new TypeError("archive_target_provider_layout");
  }
  const { providers, ...rest } = config;
  return { ...copyConfigData(rest), providers: providers.map((record) => sanitizeProviderRecord(record, "id")) };
}

// Named-agent maps retain identities/order. Optional provider null is the
// owning default, unlike a present defensive origin provider container.
export function sanitizeNamedAgents(agents) {
  requireRecord(agents, "archive_target_agents");
  const out = {};
  for (const [id, agent] of Object.entries(agents)) {
    if (id === "__proto__" || CREDENTIAL_KEYS.has(id)) continue;
    requireRecord(agent, "archive_target_agent");
    const { provider, mcpServers, ...rest } = agent;
    const clean = copyConfigData(rest);
    if (Object.hasOwn(agent, "provider")) {
      clean.provider = provider === null ? null : sanitizeProviderRecord(provider, "provider", true);
    }
    if (Object.hasOwn(agent, "mcpServers")) {
      if (!Array.isArray(mcpServers)) throw new TypeError("archive_target_agent_mcp");
      clean.mcpServers = [];
      for (const server of mcpServers) {
        const sanitized = sanitizeMcpServer(server);
        if (sanitized !== null) clean.mcpServers.push(copyConfigData(sanitized));
      }
    }
    out[id] = clean;
  }
  return out;
}

// Receives the logical MemoryStore value, not its source version envelope.
export function sanitizeAgentConfig(config) {
  requireRecord(config, "archive_target_agent_config");
  const { provider, ...rest } = config;
  const out = copyConfigData(rest);
  if (Object.hasOwn(config, "provider")) out.provider = sanitizeProviderRecord(provider, "provider");
  return out;
}

// MCP real schema (mcp-config.js): only primitive http/sse transports and own
// top-level URLs. Corrupt types/oversized URLs throw; missing fields, unsupported
// transports and malformed within-bound URL strings omit the whole server.
export function sanitizeMcpServer(server) {
  requireRecord(server, "archive_target_mcp");
  server = copyConfigData(server, false);
  for (const key of ["transport", "url"]) {
    if (Object.hasOwn(server, key) && typeof server[key] !== "string") {
      throw new TypeError("archive_target_mcp_field");
    }
  }
  if (!Object.hasOwn(server, "transport") || !Object.hasOwn(server, "url") ||
      (server.transport !== "http" && server.transport !== "sse")) return null;
  requireUtf8Bound(server.url, 64 * 1024);
  let url;
  try { url = new URL(server.url); } catch { return null; }
  if (!url.host) return null;
  // Spread intentionally keeps global MCP rest members, including own
  // __proto__ as DATA. The enclosing named-agent filter removes it there.
  const { auth: _auth, ...rest } = server;
  return { ...rest, url: `${url.protocol}//${url.host}${url.pathname}` };
}
