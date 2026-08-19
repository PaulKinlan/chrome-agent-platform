// @ts-nocheck — Deno has no chrome.* / browser globals; the diagnostics module
// touches globalThis only inside installDiagnosticCapture (not at load), so the
// pure buffer functions are testable in isolation.
// tests/diagnostics.test.ts — the error + security ring buffer (the transparency
// surface). Bounded, newest-first, with a separate security buffer.

import { assert, assertEquals } from "jsr:@std/assert@1";

const mod = await import("../extension/lib/diagnostics.js");

function fresh() {
  // Reset both buffers to a known state before each case.
  mod.diagnosticClear();
  mod.securityClear();
}

Deno.test("diagnostics: push + list return newest-first with a count", () => {
  fresh();
  mod.push("warn", "first", "sw", "warning");
  mod.push("error", "second", "sw", "error");
  const { entries, count } = mod.diagnosticList();
  assertEquals(count, 2);
  assertEquals(entries[0].message, "second");
  assertEquals(entries[1].message, "first");
  assertEquals(entries[0].level, "error");
});

Deno.test("diagnostics: the buffer is bounded (no unbounded growth)", () => {
  fresh();
  for (let i = 0; i < 250; i++) mod.push("error", `e${i}`, "sw", "error");
  const { count } = mod.diagnosticList();
  assertEquals(count, 200);
});

Deno.test("diagnostics: clear empties the diagnostic buffer only", () => {
  fresh();
  mod.push("error", "a", "sw", "error");
  mod.securityEvent("csp", "blocked");
  mod.diagnosticClear();
  assertEquals(mod.diagnosticList().count, 0);
  // The security buffer is separate and survives a diagnostic clear.
  assertEquals(mod.securityState().count, 1);
});

Deno.test("diagnostics: securityEvent lands in both buffers, newest-first", () => {
  fresh();
  mod.securityEvent("denied-hook", "hook tabs.onCreated refused");
  mod.securityEvent("csp", "script-src 'self' blocked eval");
  const sec = mod.securityState();
  assertEquals(sec.count, 2);
  assertEquals(sec.violations[0].kind, "csp");
  assertEquals(sec.violations[1].kind, "denied-hook");
  // A security event is ALSO a diagnostic entry (the console shows it).
  const diag = mod.diagnosticList();
  assertEquals(diag.count, 2);
  assertEquals(diag.entries[0].kind, "csp");
});

Deno.test("diagnostics: approval audit retains only validated action + opaque reference", () => {
  fresh();
  const ref = "a".repeat(32);
  const entry = mod.securityApprovalEvent("denied", "asset.delete", ref);
  assert(entry);
  assertEquals(entry.kind, "owner-denied");
  assert(entry.message.includes(ref));
  assert(!entry.message.includes("https://") && !entry.message.includes("asset:master"));
  assertEquals(mod.securityApprovalEvent("denied", "asset.delete", "raw-target"), null);
});

Deno.test("diagnostics: securityClear empties the security buffer", () => {
  fresh();
  mod.securityEvent("blocked-action", "page route denied");
  mod.securityClear();
  assertEquals(mod.securityState().count, 0);
});

Deno.test("diagnostics: entries carry ts, level, source, kind", () => {
  fresh();
  mod.push("error", "boom", "service-worker", "runtime");
  const e = mod.diagnosticList().entries[0];
  assertEquals(typeof e.ts, "number");
  assertEquals(e.level, "error");
  assertEquals(e.source, "service-worker");
  assertEquals(e.kind, "runtime");
});
