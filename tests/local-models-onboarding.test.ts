// tests/local-models-onboarding.test.ts — Scoped local-model onboarding and resolution test suite.
// (CAP-FEATURE-LOCAL-MODELS-01).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  SUPPORTED_LOCAL_MODEL_ROUTES,
  validateLocalEndpoint,
  inspectLocalModelRoute,
} from "../extension/lib/local-model-catalog.js";
import {
  resolveModelFromConfig,
  PROVIDER_CHOICES,
} from "../extension/lib/provider.js";

Deno.test("local models: SUPPORTED_LOCAL_MODEL_ROUTES enumerates all 4 local routes with honest capability notes", () => {
  assertEquals(SUPPORTED_LOCAL_MODEL_ROUTES.length, 4);
  const ids = SUPPORTED_LOCAL_MODEL_ROUTES.map((r) => r.id);
  assert(ids.includes("local-opfs"), "must include local-opfs (Gemma 4)");
  assert(ids.includes("prompt-api"), "must include prompt-api (Gemini nano)");
  assert(ids.includes("ollama"), "must include ollama");
  assert(ids.includes("lm-studio"), "must include lm-studio");

  for (const route of SUPPORTED_LOCAL_MODEL_ROUTES) {
    assert(typeof route.name === "string" && route.name.length > 0);
    assert(typeof route.description === "string" && route.description.length > 0);
    assert(typeof route.kind === "string");
  }
});

Deno.test("local models: validateLocalEndpoint canonicalizes localhost URLs and rejects non-local hosts", () => {
  // Valid Ollama localhost endpoint
  const r1 = validateLocalEndpoint("http://localhost:11434");
  assertEquals(r1.ok, true);
  assertEquals(r1.baseURL, "http://localhost:11434/v1");

  // Valid 127.0.0.1 endpoint with /v1
  const r2 = validateLocalEndpoint("http://127.0.0.1:1234/v1");
  assertEquals(r2.ok, true);
  assertEquals(r2.baseURL, "http://127.0.0.1:1234/v1");

  // Non-local host is rejected
  const r3 = validateLocalEndpoint("http://example.com/v1");
  assertEquals(r3.ok, false);
  assertEquals(r3.error, "non_local_host");

  // Invalid protocol is rejected
  const r4 = validateLocalEndpoint("ftp://localhost:11434");
  assertEquals(r4.ok, false);
  assertEquals(r4.error, "invalid_protocol");

  // Empty string is rejected
  const r5 = validateLocalEndpoint("");
  assertEquals(r5.ok, false);
  assertEquals(r5.error, "endpoint_required");
});

Deno.test("local models: inspectLocalModelRoute provides truthful available/configured status", () => {
  // OPFS: download required when not installed
  const opfsUninstalled = inspectLocalModelRoute("local-opfs", { isOpfsInstalled: false });
  assertEquals(opfsUninstalled.available, false);
  assertEquals(opfsUninstalled.status, "download-required");

  // OPFS: ready when installed
  const opfsInstalled = inspectLocalModelRoute("local-opfs", { isOpfsInstalled: true });
  assertEquals(opfsInstalled.available, true);
  assertEquals(opfsInstalled.status, "installed");

  // Prompt API: ready vs unavailable
  const promptReady = inspectLocalModelRoute("prompt-api", { isPromptApiReady: true });
  assertEquals(promptReady.available, true);
  assertEquals(promptReady.status, "ready");

  const promptUnready = inspectLocalModelRoute("prompt-api", { isPromptApiReady: false });
  assertEquals(promptUnready.available, false);
  assertEquals(promptUnready.status, "unavailable");

  // Ollama: not-configured vs configured
  const ollamaNotConfigured = inspectLocalModelRoute("ollama", { providerConfig: { provider: "demo" } });
  assertEquals(ollamaNotConfigured.status, "not-configured");

  const ollamaConfigured = inspectLocalModelRoute("ollama", { providerConfig: { provider: "ollama", baseURL: "http://localhost:11434/v1" } });
  assertEquals(ollamaConfigured.status, "configured");
});

Deno.test("local models: resolveModelFromConfig gracefully degrades to demo model when unconfigured", async () => {
  // Unconfigured Ollama (missing model id) -> falls back to demo model, never throws
  const unconfiguredOllama = await resolveModelFromConfig({
    provider: "ollama",
    baseURL: "http://localhost:11434/v1",
    model: "",
  });
  assertEquals(unconfiguredOllama.modelId, "demo-local");
  assert(unconfiguredOllama.providerName.includes("fell back to demo"));

  // Unconfigured LM Studio (missing model id) -> falls back to demo model
  const unconfiguredLmStudio = await resolveModelFromConfig({
    provider: "lm-studio",
    baseURL: "http://localhost:1234/v1",
    model: "",
  });
  assertEquals(unconfiguredLmStudio.modelId, "demo-local");
  assert(unconfiguredLmStudio.providerName.includes("fell back to demo"));

  // Configured Ollama with model id -> resolves OpenAI compatible model
  const configuredOllama = await resolveModelFromConfig({
    provider: "ollama",
    baseURL: "http://localhost:11434/v1",
    model: "llama3.2",
  });
  assertEquals(configuredOllama.modelId, "llama3.2");
  assertEquals(configuredOllama.providerName, "ollama");
  assert(typeof configuredOllama.model?.doGenerate === "function");
});

Deno.test("provider: PROVIDER_CHOICES includes lm-studio with needsKey: false", () => {
  const lmStudio = PROVIDER_CHOICES.find((p) => p.id === "lm-studio");
  assert(lmStudio, "lm-studio must be registered in PROVIDER_CHOICES");
  assertEquals(lmStudio.needsKey, false, "lm-studio needs no API key (local server)");
  assertEquals(lmStudio.baseURL, "http://localhost:1234/v1");
  assertEquals(lmStudio.needsModel, true);
});
