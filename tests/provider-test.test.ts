// @ts-nocheck — the probe body is a plain object whose optional OpenAI field is asserted absent/present.
// Unit tests for the "Test connection" provider probe — the no-network parts:
// the HTTP-status → error-kind mapping and the config validation. (The real
// fetch + Prompt API paths need a browser/network, so they're exercised by the
// options page itself + the Chrome journeys.)

import { assertEquals } from "jsr:@std/assert@1";

import {
  errorKindForStatus,
  testProvider,
} from "../extension/lib/provider-test.js";

Deno.test("errorKindForStatus maps statuses to actionable kinds", () => {
  assertEquals(errorKindForStatus(401), "auth");
  assertEquals(errorKindForStatus(403), "auth");
  assertEquals(errorKindForStatus(404), "not-found");
  assertEquals(errorKindForStatus(429), "rate-limit");
  assertEquals(errorKindForStatus(500), "server");
  assertEquals(errorKindForStatus(400), "http");
});

Deno.test("testProvider demo always succeeds with no network", async () => {
  const res = await testProvider(
    { id: "demo", name: "Demo (local)", baseURL: "", needsKey: false },
    {},
  );
  assertEquals(res.ok, true);
  assertEquals(typeof res.latencyMs, "number");
  assertEquals(typeof res.detail, "string");
});

Deno.test("testProvider openai-compatible requires baseURL + model + key", async () => {
  const byo = {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    baseURL: "",
    needsKey: true,
    needsModel: true,
  };
  // Missing everything.
  assertEquals((await testProvider(byo, {})).errorKind, "config");
  // Missing the model id.
  assertEquals(
    (await testProvider(byo, { baseURL: "https://byo.example/v1", apiKey: "k" }))
      .errorKind,
    "config",
  );
  // Missing the key.
  assertEquals(
    (await testProvider(byo, { baseURL: "https://byo.example/v1", model: "my-model" }))
      .errorKind,
    "config",
  );
  // And the REAL openai preset still behaves the same.
  const openai = { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", needsKey: true, needsModel: true };
  assertEquals((await testProvider(openai, {})).errorKind, "config");
});

Deno.test("testProvider unknown provider id fails closed", async () => {
  const res = await testProvider({ id: "not-a-provider", name: "?" }, {});
  assertEquals(res.ok, false);
  assertEquals(res.errorKind, "config");
});

Deno.test("testProvider keyless local (ollama) does not require a key", async () => {
  const ollama = {
    id: "ollama",
    name: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    needsKey: false,
    needsModel: true,
  };
  // Missing the model (still a config error), but NOT a key error.
  const res = await testProvider(ollama, { baseURL: "http://localhost:11434/v1" });
  assertEquals(res.errorKind, "config");
  assertEquals(String(res.error ?? "").includes("model"), true);
});

// CAP-FB-20260830-MODEL-CATALOG-CURRENT-01 — Test connection and the hub share
// one request shape: every current OpenAI model rejects `max_tokens` (400
// unsupported_parameter) and gpt-5.x rejects the default reasoning effort.
Deno.test("the OpenAI probe body uses max_completion_tokens and reasoning_effort none", async () => {
  const { buildProbeBody } = await import("../extension/lib/provider-test.js");
  const luna = buildProbeBody({ baseURL: "https://api.openai.com/v1", model: "gpt-5.6-luna" });
  assertEquals(luna.max_completion_tokens, 8);
  assertEquals("max_tokens" in luna, false);
  assertEquals(luna.reasoning_effort, "none");
  assertEquals(luna.stream, false);
  // Other endpoints: the token cap is universal, the reasoning field is OpenAI-only.
  const gemini = buildProbeBody({ baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.7-flash" });
  assertEquals(gemini.max_completion_tokens, 8);
  assertEquals("reasoning_effort" in gemini, false);
  const grok = buildProbeBody({ baseURL: "https://api.x.ai/v1", model: "grok-4.6" });
  assertEquals("reasoning_effort" in grok, false);
});
