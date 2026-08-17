// tests/provider-gate.test.ts — the provider network gate + the circuit-breaker
// (the "Failed to fetch" root cause + the hook/task error FLOOD, Paul 2026-08-17).
//
// Tested WITHOUT a browser: chrome.permissions is absent, so the host-access
// check falls back to "true" (nothing to grant) — the parts we assert here are
// the origin-pattern derivation, the circuit-breaker trip/reset, and the
// provider-error classifier (all pure + deterministic).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  providerOriginPattern,
  isProviderError,
  ProviderUnavailableError,
  recordProviderFailure,
  recordProviderSuccess,
  providerBreakerOpen,
  logGateOnce,
  resetGateLog,
} from "../extension/lib/provider-gate.js";

// ---- providerOriginPattern ----
Deno.test("providerOriginPattern derives the host pattern for an http(s) URL", () => {
  assertEquals(
    providerOriginPattern({ baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" }),
    "https://generativelanguage.googleapis.com/*",
  );
  assertEquals(
    providerOriginPattern({ baseURL: "https://api.openai.com/v1" }),
    "https://api.openai.com/*",
  );
  assertEquals(
    providerOriginPattern({ baseURL: "http://localhost:11434/v1" }),
    "http://localhost:11434/*",
  );
});

Deno.test("providerOriginPattern returns null for a missing/invalid base URL", () => {
  assertEquals(providerOriginPattern({ baseURL: "" }), null);
  assertEquals(providerOriginPattern({}), null);
  assertEquals(providerOriginPattern({ baseURL: "not a url" }), null);
});

// ---- isProviderError (only provider failures trip the breaker) ----
Deno.test("isProviderError classifies provider/network/credential failures", () => {
  assert(isProviderError(new Error("TypeError: Failed to fetch")));
  assert(isProviderError(new Error("AI_APICallError: 401 unauthorized")));
  assert(isProviderError(new Error("AI_NoOutputGeneratedError: No output generated")));
  assert(isProviderError(new Error("AI_RetryError: Failed after 3 attempts")));
  assert(isProviderError(new Error("Invalid API key")));
});

Deno.test("isProviderError does NOT classify tool errors or fence aborts", () => {
  assert(!isProviderError(new Error("tab not found")));
  assert(!isProviderError(new Error("permission denied")));
  assert(!isProviderError(new Error("run aborted")));
  assert(!isProviderError(new Error("no matching tool")));
});

// ---- ProviderUnavailableError carries a clear, user-facing reason ----
Deno.test("ProviderUnavailableError is a distinct, message-preserving error type", () => {
  const e = new ProviderUnavailableError("network access to the provider is not granted");
  assert(e instanceof Error);
  assert(e instanceof ProviderUnavailableError);
  assertEquals(e.name, "ProviderUnavailableError");
  assertEquals(e.message, "network access to the provider is not granted");
});

// ---- circuit-breaker: trip after 3 failures, reset on success ----
Deno.test("the circuit-breaker trips after 3 consecutive provider failures", () => {
  recordProviderSuccess(); // start clean
  assertEquals(providerBreakerOpen(), false);
  recordProviderFailure("Failed to fetch");
  assertEquals(providerBreakerOpen(), false);
  recordProviderFailure("Failed to fetch");
  assertEquals(providerBreakerOpen(), false);
  const third = recordProviderFailure("Failed to fetch");
  assertEquals(third.tripped, true);
  assertEquals(providerBreakerOpen(), true);
  // a success closes it
  recordProviderSuccess();
  assertEquals(providerBreakerOpen(), false);
});

Deno.test("a non-provider failure never trips the breaker (classified before recording)", () => {
  recordProviderSuccess();
  // isProviderError guards the call site in runTask — a tool error is not recorded.
  assert(!isProviderError(new Error("tab not found")));
  // (the breaker is only advanced when isProviderError is true)
});

// ---- flood suppression (the per-event hook/task error FLOOD) ----
// The hook + scheduled-task catch handlers route ANY provider failure
// (including the agent-do re-thrown AI_NoOutputGeneratedError) through
// logGateOnce, which dedupes per reason — a tabs.onUpdated burst logs at most
// once, not one line per event.
Deno.test("logGateOnce dedupes a repeated provider-failure reason (flood suppression)", () => {
  resetGateLog();
  const reason = "No output generated. Check the stream for errors.";
  assertEquals(logGateOnce(reason), true);   // first time → logs
  assertEquals(logGateOnce(reason), false);  // same reason → suppressed
  assertEquals(logGateOnce(reason), false);  // still suppressed
  // a DIFFERENT reason logs (the dedupe key is the message)
  assertEquals(logGateOnce("network access to the provider is not granted"), true);
});

Deno.test("a no-output provider failure is classified as a provider error (so the hook catch backs off)", () => {
  // The exact error Paul saw flooding the console: the agent-do run re-throws
  // AI_NoOutputGeneratedError, which the hook/task catch must treat as a
  // provider failure (log once + trip the breaker), not a per-event console.error.
  assert(isProviderError(new Error("AI_NoOutputGeneratedError: No output generated. Check the stream for errors.")));
  assert(isProviderError(new Error("AI_APICallError: 401 unauthorized")));
  assert(isProviderError(new Error("AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError")));
});
