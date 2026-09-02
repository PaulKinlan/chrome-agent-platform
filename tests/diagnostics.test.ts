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

Deno.test("diagnostics: owner-direct audit marker is its own kind and rejects bad refs", () => {
  fresh();
  const ref = "b".repeat(32);
  const entry = mod.securityApprovalEvent("owner-direct", "asset.delete", ref);
  assert(entry);
  assertEquals(entry.kind, "owner-direct");
  assert(entry.message.includes("owner-direct") && entry.message.includes("asset.delete"));
  // Same closed grammar: unknown decisions and raw targets still fail closed.
  assertEquals(mod.securityApprovalEvent("owner-directly", "asset.delete", ref), null);
  assertEquals(mod.securityApprovalEvent("owner-direct", "asset.delete", "raw"), null);
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

// CAP-FB-20260830-HUB-POLLING-01 — the badge counts are PUSH-driven: the SW
// bumps an integer revision in chrome.storage.session whenever a diagnostic /
// security / usage entry lands, and the page refreshes on that change. An
// open hub must never install a periodic timer (it kept the MV3 worker awake
// for the life of every new tab).
Deno.test("diagnostics client refreshes on revision change and never installs an interval", async () => {
  const sent: string[] = [];
  const listeners: Array<(changes: Record<string, unknown>, area?: string) => void> = [];
  let intervals = 0;
  const g = globalThis as Record<string, unknown>;
  const saved = { chrome: g.chrome, document: g.document, setInterval: g.setInterval };
  g.chrome = {
    runtime: {
      sendMessage: (msg: { type?: string }, cb: (v: unknown) => void) => {
        sent.push(String(msg?.type));
        cb({ ok: true, count: 2 });
      },
    },
    storage: { session: { onChanged: { addListener: (fn: (c: Record<string, unknown>, a?: string) => void) => listeners.push(fn) } } },
  };
  const attrs = new Map<string, string>();
  const badge = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
  };
  g.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
    querySelector: (sel: string) => (sel === "error-console" || sel === "security-shield" ? badge : null),
  };
  g.setInterval = () => { intervals += 1; return 0; };
  try {
    const client = await import("../extension/shared/diagnostics-client.js");
    client.startDiagnosticSubscription();
    await new Promise((r) => setTimeout(r, 0));
    sent.length = 0; // the one refresh on start is not the thing under test
    assertEquals(listeners.length, 1, "subscribes to the session revision exactly once");
    listeners[0]({ "cap:diagnosticsRevision": { newValue: 7 } });
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(sent.filter((t) => t === "diagnostics.list").length, 1, "diagnostics.list sent exactly once on the change");
    assertEquals(sent.filter((t) => t === "security.state").length, 1, "security.state sent exactly once on the change");
    assertEquals(attrs.get("count"), "2");
    assertEquals(attrs.has("attention"), true, "a non-zero shield count sets attention");
    assertEquals(intervals, 0, "never installs an interval");
    client.stopDiagnosticSubscription();
  } finally {
    g.chrome = saved.chrome;
    g.document = saved.document;
    g.setInterval = saved.setInterval;
  }
});
