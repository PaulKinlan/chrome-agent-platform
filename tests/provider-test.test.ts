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
  const openai = {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    needsKey: true,
    needsModel: true,
  };
  // Missing everything.
  assertEquals((await testProvider(openai, {})).errorKind, "config");
  // Missing the model id.
  assertEquals(
    (await testProvider(openai, { baseURL: "https://api.openai.com/v1", apiKey: "k" }))
      .errorKind,
    "config",
  );
  // Missing the key.
  assertEquals(
    (await testProvider(openai, { baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini" }))
      .errorKind,
    "config",
  );
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
