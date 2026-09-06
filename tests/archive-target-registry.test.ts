// @ts-nocheck — registry contract test (module: extension/lib/archive-target-registry.js).
// Single authority classifying durable targets by EXACT store grammar, per the
// write-site census (target-census-authoritative.md) + coordinator policy.
// Classes: portable-user-data, portable-terminal-validated (exact ids, trusted
// import path), portable-redacted, portable-revalidate, portable-deny-union,
// rebuildable, ephemeral, authority, transaction-private, internal-secret,
// unclassified (never exported/deleted; export fails with an owner report).
import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import {
  classifyOpfsPath,
  classifyKvKey,
  sanitizeMcpServer,
  sanitizeProviderConfig,
  sanitizeNamedAgents,
} from "../extension/lib/archive-target-registry.js";

const PORTABLE = "portable-user-data";
const TERMINAL = "portable-terminal-validated";

Deno.test("OPFS roots: exact, fail-closed, no fabricated roots", () => {
  for (const path of [
    "cap-user-wasm-v1/de5aad1e66d17831992ceba91563a235327863744d66ffc3316ca0e3c81fd0b9.wasm",
    "agent-workspaces/named-writer/notes.md",
    "cap-skills/research-assistant/SKILL.md",
  ]) assertEquals(classifyOpfsPath(path).cls, PORTABLE, path);

  assertEquals(classifyOpfsPath("cache/thumbs/1.bin").cls, "rebuildable");
  assertEquals(classifyOpfsPath("usage/legacy.json").cls, "rebuildable");
  assertEquals(classifyOpfsPath("wasm-tool-streams-v1/s1/in.bin").cls, "ephemeral");
  assertEquals(classifyOpfsPath("tool-jobs/exe/call/in.txt").cls, "ephemeral");
  assertEquals(classifyOpfsPath("chrome-agent-platform-private/owner-approval-hmac-v1").cls, "internal-secret");
  assertEquals(classifyOpfsPath("archive-transactions-v1/job-1/state.json").cls, "transaction-private");
  assertEquals(classifyOpfsPath(".staging/x").cls, "transaction-private");

  for (const path of ["brand-new-store/x", "memory2/x", "Memory/x", " memory/x", "durable-runs/run-1/state.json"]) {
    assertEquals(classifyOpfsPath(path).cls, "unclassified", path);
  }
});

Deno.test("memory stores are FLAT per store; reserved leaves carry their class", () => {
  // Master store: memory/master/<key>.json (3 segments).
  assertEquals(classifyOpfsPath("memory/master/notes.json").cls, PORTABLE);
  assertEquals(classifyOpfsPath("memory/master/profile:basic.json").cls, PORTABLE);
  for (const leaf of ["threads", "assets", "run-registry", "run-dismissed-failed",
    "cap:board-jobs", "cap:board-messages", "cap:action-ledger", "cap:delegation-log"]) {
    assertEquals(classifyOpfsPath(`memory/master/${leaf}.json`).cls, TERMINAL, leaf);
  }
  for (const leaf of ["scripts", "cap:board-wakes"]) {
    assertEquals(classifyOpfsPath(`memory/master/${leaf}.json`).cls, "portable-revalidate", leaf);
  }
  assertEquals(classifyOpfsPath("memory/master/enrolled.json").cls, "authority");
  assertEquals(classifyOpfsPath("memory/master/origins.json").cls, "authority");
  assertEquals(classifyOpfsPath("memory/master/wasmPkg.json").cls, "authority");
  assertEquals(classifyOpfsPath("memory/master/wasmPkgRepair.json").cls, "transaction-private");

  // Store integrity metadata travels byte-faithfully WITH its store.
  for (const leaf of ["__gen.json", "__tombs.json", "__epoch.json", "k.tomb"]) {
    assertEquals(classifyOpfsPath(`memory/master/${leaf}`).cls, "portable-with-store", leaf);
  }
  // In-flight transaction residue is settled by owning recovery, never archived.
  for (const leaf of ["__wal-1.json", "__tx9.json", "__wasmTx.json"]) {
    assertEquals(classifyOpfsPath(`memory/master/${leaf}`).cls, "transaction-private", leaf);
  }

  // Agent/background/site stores: <scope>/<id>/<key>.json (4 segments).
  assertEquals(classifyOpfsPath("memory/agents/writer/notes.json").cls, PORTABLE);
  assertEquals(classifyOpfsPath("memory/background/critic/log.json").cls, PORTABLE);
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/data.json").cls, PORTABLE);
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/profile:work_history.json").cls, PORTABLE);
});

Deno.test("site authority leaves: consent/enrollment/approvals; journal terminal-validated", () => {
  for (const leaf of ["profile:webmcp-tool-consent-v1.json", "enrolled.json", "approvals.json"]) {
    assertEquals(classifyOpfsPath(`memory/origins/https%3A%2F%2Fexample.com/${leaf}`).cls, "authority", leaf);
  }
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/journal.json").cls, TERMINAL);
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/toolDirectory.json").cls, "rebuildable");
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/agentConfig.json").cls, "portable-redacted");
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/assets.json").cls, TERMINAL);
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/scripts.json").cls, "portable-revalidate");
  // Same-named leaves OUTSIDE an exact origin store are plain user data.
  assertEquals(classifyOpfsPath("memory/master/enrolled.json").cls, "authority", "master enrollment marker");
  assertEquals(classifyOpfsPath("memory/agents/x/profile:webmcp-tool-consent-v1.json").cls, PORTABLE);
});

Deno.test("durable-runs: exact owning-leaf grammar (writer-derived)", () => {
  const execId = "exec:12345678-1234-1234-9234-123456789012";
  const enc = encodeURIComponent(execId); // ':' → %3A
  const hexId = "a".repeat(64);
  // Registry store: only the two owning keys + with-store metadata.
  assertEquals(classifyOpfsPath("memory/durable-runs/registry/run-registry.json").cls, TERMINAL);
  assertEquals(classifyOpfsPath("memory/durable-runs/registry/run-dismissed-failed.json").cls, TERMINAL);
  assertEquals(classifyOpfsPath("memory/durable-runs/registry/__gen.json").cls, "portable-with-store");
  assertEquals(classifyOpfsPath("memory/durable-runs/registry/run-registry.json.tomb").cls, "portable-with-store"); // sidecar wraps the FILE leaf
  assertEquals(classifyOpfsPath("memory/durable-runs/registry/other-key.json").cls, "unclassified");
  assertEquals(classifyOpfsPath("memory/durable-runs/registry/other-key.json.tomb").cls, "unclassified"); // unowned sidecar
  // Executions: actual writer leaves with embedded id === dir id.
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run:${execId}.json`).cls, TERMINAL);
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run-outbox:${execId}.json`).cls, TERMINAL);
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run-log:${execId}:000000.json`).cls, TERMINAL);
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run-log-idx:${execId}.json`).cls, TERMINAL);
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run-log-wal:${execId}.json`).cls, TERMINAL);
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run-resume:${execId}:manifest.json`).cls, TERMINAL);
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run-resume:${execId}:000001.json`).cls, TERMINAL);
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run.log`).cls, TERMINAL); // executions-only sidecar
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run:${execId}.json.tomb`).cls, "portable-with-store"); // owned sidecar
  // Payloads: run-payload:<same-id>:<terminal|64hex>:manifest|NNNNNN.
  assertEquals(classifyOpfsPath(`memory/durable-runs/payloads/${enc}/run-payload:${execId}:terminal:manifest.json`).cls, TERMINAL);
  assertEquals(classifyOpfsPath(`memory/durable-runs/payloads/${enc}/run-payload:${execId}:${hexId}:000000.json`).cls, TERMINAL);
  // Threads: the one owning key; no run.log sidecar.
  assertEquals(classifyOpfsPath("memory/durable-runs/threads/t1/thread-runs:t1.json").cls, TERMINAL);
  assertEquals(classifyOpfsPath("memory/durable-runs/threads/t1/__epoch.json").cls, "portable-with-store");
  for (const path of [
    `memory/durable-runs/executions/${enc}`,                            // a store is not a file
    `memory/durable-runs/executions/${enc}/extra/out.json`,             // invented nesting
    `memory/durable-runs/executions/${enc}/run-resume:${execId}.json`,  // bare run-resume: routing-only, never written
    `memory/durable-runs/executions/${enc}/run.log.json`,               // fabricated .json on the sidecar
    `memory/durable-runs/executions/${enc}/run:exec:12345678-1234-1234-9234-999999999999.json`, // embedded id ≠ dir
    "memory/durable-runs/executions/exec-1/run.log",                    // not an EXECUTION_ID_SOURCE id
    `memory/durable-runs/payloads/${enc}/run-payload:${execId}:foo:manifest.json`, // payloadId not terminal|64hex
    `memory/durable-runs/payloads/${enc}/out.bin`,                      // not a key leaf
    "memory/durable-runs/threads/t1/run.log",                           // no run.log under threads
    "memory/durable-runs/threads/t1/thread-runs:OTHER.json",            // embedded threadId ≠ dir
    "memory/durable-runs/threads//thread-runs:x.json",                  // empty thread id
  ]) assertEquals(classifyOpfsPath(path).cls, "unclassified", path);
});

Deno.test("invalid memory grammar is unclassified, never guessed", () => {
  for (const path of [
    "memory//x.json",                       // empty segment
    "memory/master",                        // root-only store, no leaf
    "memory/master/../escape.json",
    "memory/master/a\\b.json",
    "memory/master/x.json/deeper.json",     // store files are flat
    "memory/agents/writer/nested/deep.json",
    "memory/origins/https%3A%2F%2Fexample.com/approvals.json/deeper.json",
    "memory/unknown-scope/x/y.json",
    "memory/durable-runs/unknownkind/x/y.json",
  ]) assertEquals(classifyOpfsPath(path).cls, "unclassified", path);
});

Deno.test("user-wasm flat grammar: committed pairs export; intents/staging/nesting do not", () => {
  const d = "a".repeat(64);
  assertEquals(classifyOpfsPath(`cap-user-wasm-v1/${d}.wasm`).cls, PORTABLE);
  assertEquals(classifyOpfsPath(`cap-user-wasm-v1/${d}.json`).cls, PORTABLE);
  assertEquals(classifyOpfsPath(`cap-user-wasm-v1/delete-${d}.json`).cls, "transaction-private");
  assertEquals(classifyOpfsPath("cap-user-wasm-v1/upload-3f2a-4b.wasm").cls, "transaction-private");
  for (const path of [
    `cap-user-wasm-v1/evil.txt`,
    `cap-user-wasm-v1/${"g".repeat(64)}.wasm`,
    `cap-user-wasm-v1/nested/${d}.wasm`,
  ]) assertEquals(classifyOpfsPath(path).cls, "unclassified", path);
});

Deno.test("KV exact table (write-site-derived only)", () => {
  for (const key of [
    "cap:attestationKey", "cap:browserControlGrant", "cap:enrollment", "cap:enrollmentGen",
    "cap:webmcpStatus", "cap:webmcpSnapshotGate", "cap:agent-workers:alive",
    "cap:webmcpBridgeNonces", // legacy marker: reject/revoke even though current writer is session
  ]) assertEquals(classifyKvKey(key).cls, "authority", key);
  for (const key of ["cap:knownWebmcpOrigins", "cap:diagnosticsRevision"]) {
    assertEquals(classifyKvKey(key).cls, "rebuildable", key);
  }
  for (const key of [
    "cap:scheduledInflight", "cap:pendingCleanup", "cap:threadQueues",
    "agents-pending-teardown", "cap:notifications:index", "cap:notification:abc",
  ]) assertEquals(classifyKvKey(key).cls, "ephemeral", key);
  for (const key of ["cap:hooksDeny", "cap:destructiveActionPolicy"]) {
    assertEquals(classifyKvKey(key).cls, "portable-deny-union", key);
  }
  for (const key of ["cap:hooks", "cap:scheduledTasks", "cap:developerFeatures",
    "cap:promptOverrides", "cap:promptOverrides:quarantine"]) {
    assertEquals(classifyKvKey(key).cls, "portable-revalidate", key);
  }
  for (const key of ["providerConfig", "cap:mcpServers", "cap:namedAgents"]) {
    assertEquals(classifyKvKey(key).cls, "portable-redacted", key);
  }
  for (const key of [
    "cap:events", "cap:usage:v2", "cap:usage:tools:v1", "cap:usage:server-tools:v1",
    "cap:requestActivity", "cap:rawAlarms",
  ]) assertEquals(classifyKvKey(key).cls, TERMINAL, key);
  for (const key of [
    "cap:autoCloseRunTabs", "cap:multiAgent", "cap:providerServerTools",
    "cap:logVerbosity", "cap:logFullDetail", "cap:sidepanelTarget",
    "cap:sidepanel:page-threads", "cap:sidepanel:selected-agent", "cap:siteActivityFocus",
    "cap:first-run-browser-choice", "cap:first-run-guide-dismissed",
    "cap:webmcpDiagnostics",
    "cap:runRetention",
  ]) assertEquals(classifyKvKey(key).cls, PORTABLE, key);
  assertEquals(classifyKvKey("cap:hub-seen:settings/data").cls, PORTABLE);
});

Deno.test("KV impostors: message types and memory-master rows are NOT storage keys", () => {
  for (const ghost of [
    "cap:preference", "cap:preference-ready", // preference-bridge message types
    "cap:artifact-preview-open", // components.js:560 → artifact-preview.js:67 message-only
    "cap:script-run", "cap:fetch", "cap:go-home", "cap:table-worker-run",
    "cap:wasm-stream-run", "cap:return-to-hub-composer",
    // These live as memory-master LEAVES, not KV keys:
    "cap:action-ledger", "cap:delegation-log", "cap:board-jobs", "cap:board-messages", "cap:board-wakes", "cap:board-deny-rules",
  ]) assertEquals(classifyKvKey(ghost).cls, "unclassified", ghost);
});

Deno.test("unknown KV keys are ALWAYS unclassified — sensitive name or not", () => {
  for (const key of [
    "cap:oauthTokenCache", "thirdPartyApiKey", "vendor_secret_blob",
    "myReadingList", "threadsIndex", "cap:brandNewFeature", "cap:usage:v9",
  ]) assertEquals(classifyKvKey(key).cls, "unclassified", key);
});

Deno.test("providerConfig keeps config, drops credentials at every supported nesting", () => {
  // Current real shape is FLAT (provider.js:179-195).
  const flat = sanitizeProviderConfig({ provider: "anthropic", baseURL: "https://api.anthropic.com", apiKey: "sk-FLAT-SECRET", model: "claude" });
  // r5 requires full WHATWG canonical form, including the root slash.
  assertEquals(flat, { provider: "anthropic", baseURL: "https://api.anthropic.com/", model: "claude" });
  // Legacy nested shape.
  const nested = sanitizeProviderConfig({
    activeProvider: "anthropic",
    providers: [
      { id: "anthropic", apiKey: "sk-ant-live-SECRET-1", model: "claude-opus-4-6" },
      { id: "openai", model: "gpt", apiKey: "sk-SECRET-2", organization: "org-1", tokenLimit: 4096 },
    ],
  });
  const json = JSON.stringify(nested);
  assert(!json.includes("SECRET"), json);
  assertEquals(nested.providers.length, 2);
  assert(!nested.providers.some((p) => "apiKey" in p));
  assertEquals(nested.providers[1].organization, "org-1");
  assertEquals(nested.providers[1].tokenLimit, 4096, "benign look-alike fields survive");
});

Deno.test("namedAgents is an OBJECT MAP; embedded provider credentials stripped", () => {
  const out = sanitizeNamedAgents({
    writer: { name: "Writer", model: "gemini-3.7-flash", icon: "pen" },
    critic: { name: "Critic", model: "k3", provider: { provider: "anthropic", apiKey: "sk-SECRET-9", model: "claude" } },
  });
  const json = JSON.stringify(out);
  assert(!json.includes("SECRET"), json);
  assertEquals(out.writer.name, "Writer");
  assertEquals(out.critic.provider.provider, "anthropic");
  // A legacy id is not a named override's provider identity.
  assertThrows(() => sanitizeNamedAgents({ critic: { provider: { id: "anthropic" } } }), TypeError);
  assert(!("apiKey" in out.critic.provider));
});

Deno.test("MCP real schema: string transport, auth dropped, URL depersonalized, malformed rejected", () => {
  const clean = sanitizeMcpServer({
    id: "m1", name: "docs", transport: "http", url: "https://user:pw@mcp.example:8443/mcp?key=abc#f",
    auth: { headerName: "X-T", token: "tok-SECRET" }, enabled: true,
  });
  const json = JSON.stringify(clean);
  for (const leak of ["tok-SECRET", "user:pw", "key=abc", "#f", "headerName"]) assert(!json.includes(leak), json);
  assertEquals(clean.url, "https://mcp.example:8443/mcp");
  assertEquals(clean.transport, "http");
  // A malformed URL rejects the whole server (null), never a placeholder.
  assertEquals(sanitizeMcpServer({ id: "bad", name: "x", transport: "http", url: "not a url" }), null);
});

Deno.test("classifiers reject malformed input, never guess", () => {
  assertThrows(() => classifyOpfsPath(""), Error);
  assertThrows(() => classifyOpfsPath(null), Error);
  assertThrows(() => classifyKvKey(42), Error);
});

Deno.test("grammar RED regressions: screenshots subtree, repair residue, skills/workspaces", () => {
  assertEquals(classifyOpfsPath("memory/master/screenshots/shot_0123456789abcdef0123456789abcdef.json").cls, TERMINAL);
  assertEquals(classifyOpfsPath("memory/master/assetRepair.json").cls, "transaction-private");
  assertEquals(classifyOpfsPath("memory/master/__gen.json").cls, "portable-with-store"); // integrity travels with the store
  assertEquals(classifyOpfsPath("memory/master/foo.txt").cls, "unclassified");
  assertEquals(classifyOpfsPath("memory/master/threads.json.bak").cls, "unclassified");
  for (const path of [
    "memory/master/screenshots",        // a directory is not a file
    "memory/master/screenshots/x.json", // not a shot_<32hex> id
    "memory/agents/a/screenshots/x.json", // screenshots only under master
    "memory/agents/a/not-json",
  ]) assertEquals(classifyOpfsPath(path).cls, "unclassified", path);
});

Deno.test("skills grammar: sanitized id + at least one file segment", () => {
  assertEquals(classifyOpfsPath("cap-skills/research-assistant/SKILL.md").cls, PORTABLE);
  assertEquals(classifyOpfsPath("cap-skills/research-assistant/references/api.md").cls, PORTABLE);
  assertEquals(classifyOpfsPath("cap-skills/anything").cls, "unclassified"); // bare id is not a file
  assertEquals(classifyOpfsPath("cap-skills/Bad Id/x.md").cls, "unclassified");
});

Deno.test("workspace grammar: named-/background- key + bounded depth", () => {
  assertEquals(classifyOpfsPath("agent-workspaces/named-writer/notes.md").cls, PORTABLE);
  assertEquals(classifyOpfsPath("agent-workspaces/background-researcher/deep/dir/file.txt").cls, PORTABLE);
  for (const path of [
    "agent-workspaces/evil",               // no key, no file
    "agent-workspaces/named-writer",       // key without a file
    "agent-workspaces/evil/x.txt",         // workspace key must carry named-/background-
    "agent-workspaces/named-Bad/x.txt",    // slug grammar
  ]) assertEquals(classifyOpfsPath(path).cls, "unclassified", path);
  const deep = "agent-workspaces/named-writer/" + Array.from({ length: 9 }, (_, i) => `d${i}`).join("/");
  assertEquals(classifyOpfsPath(deep).cls, "unclassified", "depth > 8");
});

Deno.test("unknown profile:* leaves fail closed; known sections portable", () => {
  assertEquals(classifyOpfsPath("memory/master/profile:basic.json").cls, PORTABLE);
  assertEquals(classifyOpfsPath("memory/master/profile:audit_log.json").cls, PORTABLE);
  assertEquals(classifyOpfsPath("memory/master/profile:invented.json").cls, "unclassified");
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/profile:invented.json").cls, "unclassified");
  assertEquals(classifyOpfsPath("memory/master/thread:t_1.json").cls, TERMINAL); // reserved thread bodies
  assertEquals(classifyOpfsPath("memory/master/asset:a1.json").cls, TERMINAL);
});

Deno.test("adjudication P1s: with-store integrity, thread terminal, canonical dirs, run.log.json", () => {
  // Integrity/tomb/version leaves are portable-WITH-STORE at every depth.
  assertEquals(classifyOpfsPath("memory/master/__gen.json").cls, "portable-with-store");
  assertEquals(classifyOpfsPath("memory/master/k.tomb").cls, "portable-with-store");
  assertEquals(classifyOpfsPath("memory/agents/main/k.tomb").cls, "portable-with-store");
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/__epoch.json").cls, "portable-with-store");
  assertEquals(classifyOpfsPath("memory/durable-runs/registry/__gen.json").cls, "portable-with-store");
  // Reserved thread bodies are terminal-validated.
  assertEquals(classifyOpfsPath("memory/master/thread:t_1.json").cls, TERMINAL);
  // Fabricated run.log.json is never a key leaf, anywhere.
  assertEquals(classifyOpfsPath("memory/durable-runs/executions/exec%3A12345678-1234-1234-9234-123456789012/run.log.json").cls, "unclassified");
  assertEquals(classifyOpfsPath("memory/master/run.log.json").cls, PORTABLE); // safe arbitrary master key — NOT globally reserved
  // Origin dirs: exact canonical encodeURIComponent of a real http(s) origin only.
  assertEquals(classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/journal.json").cls, TERMINAL);
  for (const dir of [
    "example.com",                    // raw, unencoded
    "https%3A%2F%2Fexample.com%2F",   // trailing slash is not an origin
    "https%3A%2F%2F%65xample.com",    // lowercase %65 alias (canonical form is uppercase... exact match required)
    "ftp%3A%2F%2Fexample.com",        // not http(s)
  ]) assertEquals(classifyOpfsPath(`memory/origins/${dir}/journal.json`).cls, "unclassified", dir);
  // Execution dirs: real EXECUTION_ID_SOURCE ids under exact canonical encode.
  const realExec = encodeURIComponent("exec:12345678-1234-1234-9234-123456789012");
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${realExec}/run.log`).cls, TERMINAL);
  for (const path of [
    "memory/durable-runs/executions/exec-1/run.log",   // not an EXECUTION_ID_SOURCE id
    "memory/durable-runs/payloads/exec-1/x.json",
  ]) assertEquals(classifyOpfsPath(path).cls, "unclassified", path);
});

Deno.test("EXEC_ID source parity: case-insensitive like DURABLE_KEY_RE (memory.js:229)", () => {
  const upper = encodeURIComponent("EXEC:12345678-1234-1234-9234-ABCDEFABCDEF".toLowerCase()) ===
    encodeURIComponent("exec:12345678-1234-1234-9234-abcdefabcdef"); // canonical lower form
  assert(upper);
  const encUpper = encodeURIComponent("EXEC:ABCDEF12-1234-1234-9234-ABCDEFABCDEF");
  // Uppercase hex/prefix forms accepted by existing store enumeration must classify.
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${encUpper}/run:EXEC:ABCDEF12-1234-1234-9234-ABCDEFABCDEF.json`).cls, TERMINAL);
});

Deno.test("master arbitrary logical keys remain portable (positive regression)", () => {
  for (const key of ["run.log", "my-notes", "shopping_list", "idea:2026"]) {
    assertEquals(classifyOpfsPath(`memory/master/${key}.json`).cls, PORTABLE, key);
  }
});

Deno.test("durable sidecars: exact unwrap — base .json leaf must be an owning leaf", () => {
  const execId = "exec:12345678-1234-1234-9234-123456789012";
  const enc = encodeURIComponent(execId);
  // Positive: sidecar of an owning leaf is portable-with-store.
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/run:${execId}.json.tomb`).cls, "portable-with-store");
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/.run:${execId}.json.version`).cls, "portable-with-store");
  assertEquals(classifyOpfsPath("memory/durable-runs/threads/t1/thread-runs:t1.json.tomb").cls, "portable-with-store");
  assertEquals(classifyOpfsPath(`memory/durable-runs/payloads/${enc}/run-payload:${execId}:terminal:manifest.json.tomb`).cls, "portable-with-store");
  // Negative: sidecar of a NON-owning base is unclassified (no laundering).
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/fabricated.json.tomb`).cls, "unclassified");
  assertEquals(classifyOpfsPath(`memory/durable-runs/executions/${enc}/.run-resume:${execId}.json.version`).cls, "unclassified"); // bare run-resume is not owning
  assertEquals(classifyOpfsPath("memory/durable-runs/threads/t1/run.log.tomb").cls, "unclassified"); // no run.log under threads
  assertEquals(classifyOpfsPath("memory/durable-runs/registry/other-key.json.tomb").cls, "unclassified");
});
