// lib/pure.js — pure, dependency-free helpers (no chrome.*, no AI SDK) so the
// security-critical logic can be unit-tested in Deno without a browser.
//
// chrome-agent-platform-ux4ud: this module is now the PUBLIC SURFACE, not the
// implementation. The seams the select-tests fan-in proved out live in their own
// modules and are re-exported here unchanged, so every existing import of this
// module keeps working and no behaviour moved. The barrel path is deliberately
// NOT written as an import statement in these comments: tests/gallery-imports.test.ts
// scans these files for import-shaped text and would resolve it against docs/.
//   ./pure-schema.js   the hostile-descriptor schema converter + work budget
//   ./pure-hash.js     FNV-1a, SHA-256, HMAC, tool-name sanitising, digests
//   ./pure-text.js     UTF-8 byte maths, surrogate safety, truncation, ids, time
//   ./pure-redact.js   credential redaction + durable-log normalisers
//   ./pure-trust.js    settings sections + SW/options sender predicates
//   ./pure-webmcp.js   WebMCP lifecycle/status bounding + snapshot gate ordering
//   ./pure-tabs.js     tab/URL predicates, tab-change notifier, keyboard commands
// WHY: the selector's coverage graph is FILE-level, so one module imported by 139
// files made every landing that touched it select 547 test files. Importers now
// import the seam they use; this barrel remains for callers that genuinely want
// the whole surface, and it is what the generated docs/ mirror publishes.
export * from "./pure-schema.js";
export * from "./pure-hash.js";
export * from "./pure-text.js";
export * from "./pure-redact.js";
export * from "./pure-trust.js";
export * from "./pure-webmcp.js";
export * from "./pure-tabs.js";
