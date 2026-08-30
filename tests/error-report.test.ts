import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  describeError,
  formatError,
  errorDetail,
  ERROR_CATEGORY,
} from "../extension/lib/error-report.js";

Deno.test("error-report: unwraps a 401 APICallError into provider-auth with the body", () => {
  const e = Object.assign(new Error("[AI_APICallError] 401"), {
    name: "AI_APICallError",
    statusCode: 401,
    responseBody: JSON.stringify({ error: { message: "Incorrect API key provided" } }),
    url: "https://api.openai.com/v1/chat/completions",
  });
  const d = describeError(e, { provider: "openai", model: "gpt-4o-mini" });
  assertEquals(d.category, ERROR_CATEGORY.AUTH);
  assertStringIncludes(d.reason.toLowerCase(), "incorrect api key");
  assertStringIncludes(d.action.toLowerCase(), "api key");
  assertStringIncludes(d.detail, "provider: openai");
  assertStringIncludes(d.detail, "status: 401");
});

Deno.test("error-report: native quota exhaustion is storage, never provider rate-limit", () => {
  const d = describeError(new DOMException("Quota exceeded while writing OPFS", "QuotaExceededError"));
  assertEquals(d.category, ERROR_CATEGORY.STORAGE);
  assertStringIncludes(d.action.toLowerCase(), "browser storage");
});

Deno.test("error-report: unwraps a 429 rate-limit", () => {
  const e = Object.assign(new Error("[AI_APICallError] 429"), {
    name: "AI_APICallError",
    statusCode: 429,
    responseBody: JSON.stringify({ error: { message: "Rate limit reached" } }),
  });
  const d = describeError(e, { provider: "gemini" });
  assertEquals(d.category, ERROR_CATEGORY.RATE_LIMIT);
  assertStringIncludes(d.action.toLowerCase(), "rate-limit");
});

Deno.test("error-report: unwraps the useless 'No output generated' wrapper into model-no-output", () => {
  const e = Object.assign(new Error("AI_NoOutputGeneratedError: No output generated. Check the stream for errors."), {
    name: "AI_NoOutputGeneratedError",
  });
  const d = describeError(e, { model: "gemini-3.7-flash" });
  assertEquals(d.category, ERROR_CATEGORY.NO_OUTPUT);
  assertStringIncludes(d.reason.toLowerCase(), "no content");
  assertStringIncludes(d.message.toLowerCase(), "retry");
  // The actionable message must NOT be the useless wrapper.
  assert(!/check the stream/i.test(d.message));
});

Deno.test("error-report: unwraps a RetryError into its underlying lastError", () => {
  const inner = Object.assign(new Error("[AI_APICallError] 403"), {
    name: "AI_APICallError",
    statusCode: 403,
    responseBody: JSON.stringify({ error: { message: "Access denied" } }),
  });
  const e = Object.assign(new Error("AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError"), {
    name: "AI_RetryError",
    lastError: inner,
  });
  const d = describeError(e, {});
  assertEquals(d.category, ERROR_CATEGORY.AUTH);
  assertStringIncludes(d.reason.toLowerCase(), "access denied");
});

Deno.test("error-report: maps 'Failed to fetch' to network + actionable host-permission hint", () => {
  const e = new TypeError("Failed to fetch");
  const d = describeError(e, { provider: "gemini" });
  assertEquals(d.category, ERROR_CATEGORY.NETWORK);
  assertStringIncludes(d.reason.toLowerCase(), "could not reach");
  assertStringIncludes(d.detail.toLowerCase(), "host permission");
});

Deno.test("error-report: the provider-run gate refusal maps to HOST_PERMISSION (not network/permission)", () => {
  const e = new Error("network access to the provider (https://generativelanguage.googleapis.com/*) is not granted — click \"Use\"/\"Test connection\" in Settings to grant it");
  e.name = "ProviderUnavailableError";
  const d = describeError(e, { provider: "gemini" });
  assertEquals(d.category, ERROR_CATEGORY.HOST_PERMISSION);
  assertStringIncludes(d.action.toLowerCase(), "grant network access");
});

Deno.test("error-report: categorizes a plain auth text error", () => {
  const e = new Error("Unauthorized: invalid api key");
  const d = describeError(e, {});
  assertEquals(d.category, ERROR_CATEGORY.AUTH);
});

Deno.test("error-report: never throws on a malformed / string error", () => {
  const d = describeError("just a string", {});
  assertEquals(d.category, ERROR_CATEGORY.UNKNOWN);
  assert(d.action && d.reason);
});

Deno.test("error-report: formatError produces a one-line actionable summary", () => {
  const e = Object.assign(new Error("[AI_APICallError] 500"), {
    name: "AI_APICallError",
    statusCode: 500,
    responseBody: JSON.stringify({ error: { message: "Internal server error" } }),
  });
  const line = formatError(e, { provider: "deepseek" });
  assertStringIncludes(line, "provider-server:");
  assertStringIncludes(line.toLowerCase(), "internal server error");
});

Deno.test("error-report: errorDetail returns the same structured shape", () => {
  const e = Object.assign(new Error("[AI_APICallError] 404"), {
    name: "AI_APICallError",
    statusCode: 404,
    responseBody: JSON.stringify({ error: { message: "model not found" } }),
  });
  const d = errorDetail(e, { model: "gemini-9.9-flash" });
  assertEquals(d.category, ERROR_CATEGORY.MODEL_CONFIG);
  assertStringIncludes(d.reason.toLowerCase(), "model not found");
  assertStringIncludes(d.detail, "model: gemini-9.9-flash");
});

// CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01 — the AI SDK collapses a provider
// HTTP failure into AI_NoOutputGeneratedError (no status on the object). The
// model wrapper records the last provider error and passes it as a hint; the
// hint must win over the "returned no content" regex.
Deno.test("error-report: a 401 behind AI_NoOutputGeneratedError maps to AUTH with the Settings action", () => {
  const e = Object.assign(new Error("No output generated. Check the stream for errors."), {
    name: "AI_NoOutputGeneratedError",
  });
  const d = describeError(e, {
    provider: "openai",
    model: "gpt-5.6-sol",
    providerError: { status: 401, provider: "openai", message: "Incorrect API key provided: sk-proj-abc123DEF456" },
  });
  assertEquals(d.category, ERROR_CATEGORY.AUTH);
  assertStringIncludes(d.reason, "rejected the API key (401)");
  assertStringIncludes(d.reason, "OpenAI");
  assertStringIncludes(d.action, "Settings");
  assert(!/returned no content/i.test(d.reason + " " + d.action + " " + d.message));
  for (const text of [d.reason, d.action, d.message, d.detail]) {
    assert(!/sk-[A-Za-z0-9]/.test(text), `secret leaked: ${text}`);
  }
});

Deno.test("error-report: a 429 behind AI_NoOutputGeneratedError maps to RATE_LIMIT", () => {
  const e = Object.assign(new Error("No output generated. Check the stream for errors."), {
    name: "AI_NoOutputGeneratedError",
  });
  const d = describeError(e, {
    provider: "openai-compatible",
    providerError: { status: 429, provider: "openai-compatible", message: "Insufficient balance or no resource package" },
  });
  assertEquals(d.category, ERROR_CATEGORY.RATE_LIMIT);
  assertStringIncludes(d.reason, "(429)");
  assertStringIncludes(d.reason.toLowerCase(), "insufficient balance");
  assert(!/returned no content/i.test(d.reason));
});

Deno.test("error-report: a 400 behind AI_NoOutputGeneratedError maps to MODEL_CONFIG with the provider message", () => {
  const e = Object.assign(new Error("No output generated. Check the stream for errors."), {
    name: "AI_NoOutputGeneratedError",
  });
  const d = describeError(e, {
    provider: "openai",
    model: "gpt-5.6-sol",
    providerError: { status: 400, provider: "openai", message: "Function tools with reasoning_effort are not supported for gpt-5.6-sol" },
  });
  assertEquals(d.category, ERROR_CATEGORY.MODEL_CONFIG);
  assertStringIncludes(d.reason, "(400)");
  assertStringIncludes(d.reason, "reasoning_effort");
  assert(!/returned no content/i.test(d.reason));
});

Deno.test("error-report: an empty HTTP 200 stream (no providerError) still says returned no content", () => {
  const e = Object.assign(new Error("No output generated. Check the stream for errors."), {
    name: "AI_NoOutputGeneratedError",
  });
  const d = describeError(e, { provider: "openai", model: "gpt-5.6-sol" });
  assertEquals(d.category, ERROR_CATEGORY.NO_OUTPUT);
  assertStringIncludes(d.reason, "returned no content");
  // And a hint with a 2xx status is not a provider failure — ignored.
  const d2 = describeError(e, { model: "gpt-5.6-sol", providerError: { status: 200, message: "" } });
  assertEquals(d2.category, ERROR_CATEGORY.NO_OUTPUT);
});
