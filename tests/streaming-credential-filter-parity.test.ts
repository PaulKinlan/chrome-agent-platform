// tests/streaming-credential-filter-parity.test.ts — pins the 11rm streaming
// credential filter and reserved-member (__proto__) parity contract (chrome-agent-platform-66t3).
//
// Invariants guarded:
//   1. JSON.parse input with own "__proto__" properties (not JS object literals) must
//      demonstrably produce own enumerable properties on Object.keys() / getOwnPropertyDescriptors.
//   2. In all recursive redacted targets (providerConfig, namedAgents, logicalSiteAgentConfig):
//      - The credential keys (apiKey, authToken, clientSecret) are stripped.
//      - Own "__proto__" properties are explicitly stripped (cross-runtime deterministic).
//      - Benign sibling fields (constructor, prototype, tokenLimit, name, model) are preserved.
//   3. In global MCP servers (sanitizeMcpServer):
//      - auth is stripped and url is normalized.
//      - Own "__proto__" is preserved under rest/spread parity until owning schema validation.
//      - Contrasts with nested MCP servers in named agents, where the enclosing named agent
//        filter explicitly strips "__proto__".
//   4. Falsification counter-proof:
//      - A naive 3-key streaming filter that omits only [apiKey, authToken, clientSecret]
//        preserves own "__proto__", proving it is NOT equivalent to the canonical sanitizer.
//   5. Prototype safety:
//      - Object.prototype is never polluted by any sanitization operation.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  sanitizeMcpServer,
  sanitizeNamedAgents,
  sanitizeProviderConfig,
} from "../extension/lib/archive-target-registry.js";
import { sanitizeLogicalSiteAgentConfig } from "../extension/lib/logical-site-agent-config.js";

// Helper to create genuine own "__proto__" objects via JSON.parse
function jsonWithOwnProto<T = Record<string, unknown>>(jsonString: string): T {
  const parsed = JSON.parse(jsonString);
  return parsed as T;
}

// ── 1. Baseline: JSON.parse Own Property Ground Truth ───────────────────────

Deno.test("66t3: JSON.parse creates genuine own enumerable __proto__ properties", () => {
  const json = '{"nested":{"__proto__":{"polluted":1},"ok":2}}';
  const parsed = JSON.parse(json);

  // In contrast to object literals ({ __proto__: ... }) which set [[Prototype]],
  // JSON.parse creates an own property named "__proto__".
  assert(Object.hasOwn(parsed.nested, "__proto__"), "must have own property __proto__");
  assertEquals(Object.keys(parsed.nested).includes("__proto__"), true);
  assertEquals(parsed.nested.__proto__.polluted, 1);
  assertEquals(parsed.nested.ok, 2);

  // Object.prototype must remain clean
  assertEquals((Object.prototype as any).polluted, undefined);
});

// ── 2. Flat Provider Config Parity ──────────────────────────────────────────

Deno.test("66t3: flat providerConfig omits apiKey and own __proto__, preserves benign fields", () => {
  const input = jsonWithOwnProto<Record<string, unknown>>(`{
    "provider": "openai",
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "sk-planted-secret",
    "__proto__": { "polluted": true },
    "nested": {
      "__proto__": { "innerPolluted": true },
      "tokenLimit": 4096,
      "constructor": "benign-constructor",
      "prototype": "benign-prototype"
    }
  }`);

  const cleaned = sanitizeProviderConfig(input);

  // Assert credentials stripped
  assertEquals(Object.hasOwn(cleaned, "apiKey"), false, "apiKey must be stripped");
  assertEquals(JSON.stringify(cleaned).includes("sk-planted-secret"), false);

  // Assert own __proto__ stripped at both outer and nested levels
  assertEquals(Object.hasOwn(cleaned, "__proto__"), false, "outer __proto__ must be stripped");
  assertEquals(Object.hasOwn((cleaned as any).nested, "__proto__"), false, "nested __proto__ must be stripped");

  // Assert benign fields preserved
  assertEquals(cleaned.provider, "openai");
  assertEquals(cleaned.baseURL, "https://api.openai.com/v1");
  assertEquals((cleaned as any).nested.tokenLimit, 4096);
  assertEquals((cleaned as any).nested.constructor, "benign-constructor");
  assertEquals((cleaned as any).nested.prototype, "benign-prototype");

  // Verify Object.prototype purity
  assertEquals((Object.prototype as any).polluted, undefined);
  assertEquals((Object.prototype as any).innerPolluted, undefined);
});

// ── 3. Legacy Nested Providers Parity ───────────────────────────────────────

Deno.test("66t3: legacy nested providers strip credentials and own __proto__ across arrays", () => {
  const input = jsonWithOwnProto<Record<string, unknown>>(`{
    "activeProvider": "anthropic",
    "__proto__": { "outerPolluted": true },
    "providers": [
      {
        "id": "anthropic",
        "baseURL": "https://api.anthropic.com/v1",
        "apiKey": "sk-ant-secret",
        "model": "claude-3-5-sonnet",
        "__proto__": { "elementPolluted": true }
      }
    ]
  }`);

  const cleaned = sanitizeProviderConfig(input) as { activeProvider: string; providers: any[] };

  assertEquals(cleaned.activeProvider, "anthropic");
  assertEquals(Object.hasOwn(cleaned, "__proto__"), false, "outer __proto__ must be stripped");
  assertEquals(cleaned.providers.length, 1);

  const provider = cleaned.providers[0];
  assertEquals(provider.id, "anthropic");
  assertEquals(provider.model, "claude-3-5-sonnet");
  assertEquals(Object.hasOwn(provider, "apiKey"), false, "element apiKey must be stripped");
  assertEquals(Object.hasOwn(provider, "__proto__"), false, "element __proto__ must be stripped");

  assertEquals((Object.prototype as any).outerPolluted, undefined);
  assertEquals((Object.prototype as any).elementPolluted, undefined);
});

// ── 4. Named Agents Map Parity ──────────────────────────────────────────────

Deno.test("66t3: namedAgents strips map __proto__, agent __proto__, and nested provider/MCP __proto__", () => {
  const input = jsonWithOwnProto<Record<string, unknown>>(`{
    "__proto__": {
      "id": "malicious-agent",
      "name": "Injected Agent",
      "role": "attacker",
      "skills": [],
      "canDelegateTo": [],
      "mcpServers": []
    },
    "writer": {
      "id": "writer",
      "name": "Writer",
      "role": "drafting",
      "skills": [],
      "canDelegateTo": [],
      "__proto__": { "agentPolluted": true },
      "provider": {
        "provider": "anthropic",
        "apiKey": "sk-nested-agent-key",
        "model": "claude-3-5-haiku",
        "__proto__": { "providerPolluted": true }
      },
      "mcpServers": [
        {
          "id": "m1",
          "name": "search",
          "transport": "http",
          "url": "https://mcp.example.com",
          "auth": { "token": "mcp-secret-token" },
          "__proto__": { "nestedMcpPolluted": true }
        }
      ]
    }
  }`);

  const cleaned = sanitizeNamedAgents(input);

  // 1. Map-level "__proto__" entry must be skipped entirely
  assertEquals(Object.hasOwn(cleaned, "__proto__"), false, "map-level __proto__ must be dropped");
  assertEquals(Object.keys(cleaned), ["writer"], "only legitimate agent keys survive");

  const writer = (cleaned as Record<string, any>).writer;
  assertEquals(writer.name, "Writer");
  assertEquals(Object.hasOwn(writer, "__proto__"), false, "agent-level __proto__ must be stripped");

  // 2. Embedded provider credentials and __proto__ stripped
  assertEquals(writer.provider.provider, "anthropic");
  assertEquals(writer.provider.model, "claude-3-5-haiku");
  assertEquals(Object.hasOwn(writer.provider, "apiKey"), false, "embedded provider apiKey stripped");
  assertEquals(Object.hasOwn(writer.provider, "__proto__"), false, "embedded provider __proto__ stripped");

  // 3. Nested MCP server under named agent has auth AND __proto__ stripped
  assertEquals(writer.mcpServers.length, 1);
  const nestedMcp = writer.mcpServers[0];
  assertEquals(nestedMcp.id, "m1");
  assertEquals(Object.hasOwn(nestedMcp, "auth"), false, "nested MCP auth stripped");
  assertEquals(Object.hasOwn(nestedMcp, "__proto__"), false, "nested MCP __proto__ stripped");

  assertEquals((Object.prototype as any).agentPolluted, undefined);
  assertEquals((Object.prototype as any).providerPolluted, undefined);
  assertEquals((Object.prototype as any).nestedMcpPolluted, undefined);
});

// ── 5. Logical Site Agent Config Parity ─────────────────────────────────────

Deno.test("66t3: logicalSiteAgentConfig drops defensive credentials and own __proto__", () => {
  const input = jsonWithOwnProto<Record<string, unknown>>(`{
    "name": "Site Assistant",
    "apiKey": "sk-defensive-secret",
    "authToken": "tok-secret",
    "clientSecret": "sec-secret",
    "__proto__": { "siteConfigPolluted": true }
  }`);

  const cleaned = sanitizeLogicalSiteAgentConfig(input);

  assertEquals((cleaned as Record<string, any>).name, "Site Assistant");
  assertEquals(Object.hasOwn(cleaned, "apiKey"), false);
  assertEquals(Object.hasOwn(cleaned, "authToken"), false);
  assertEquals(Object.hasOwn(cleaned, "clientSecret"), false);
  assertEquals(Object.hasOwn(cleaned, "__proto__"), false, "siteConfig __proto__ stripped");

  assertEquals((Object.prototype as any).siteConfigPolluted, undefined);
});

// ── 6. Global MCP Rest/Spread Parity vs. Nested MCP Parity ──────────────────

Deno.test("66t3: global MCP rest/spread preserves own __proto__; nested MCP drops it", () => {
  const mcpInput = jsonWithOwnProto<Record<string, unknown>>(`{
    "id": "global-m1",
    "name": "Docs",
    "transport": "http",
    "url": "https://mcp.example.com/api?token=drop-query#frag",
    "auth": { "headerName": "Authorization", "token": "secret-token" },
    "customField": "preserved",
    "__proto__": { "globalMcpData": true }
  }`);

  // Global MCP: sanitizeMcpServer uses rest/spread parity, keeping own __proto__ as data
  const globalClean = sanitizeMcpServer(mcpInput) as any;
  assertEquals(globalClean.id, "global-m1");
  assertEquals(globalClean.url, "https://mcp.example.com/api");
  assertEquals(Object.hasOwn(globalClean, "auth"), false, "auth dropped");
  assertEquals(globalClean.customField, "preserved");
  assertEquals(Object.hasOwn(globalClean, "__proto__"), true, "global MCP preserves own __proto__ under rest/spread");
  assertEquals(globalClean.__proto__.globalMcpData, true);

  // Contrast with Nested MCP under named agents:
  const namedWrap = {
    agent1: {
      id: "agent1",
      name: "Agent",
      role: "test",
      skills: [],
      canDelegateTo: [],
      mcpServers: [mcpInput],
    },
  };
  const namedClean = sanitizeNamedAgents(namedWrap);
  const nestedMcp = ((namedClean as Record<string, any>).agent1 as any).mcpServers[0];
  assertEquals(nestedMcp.id, "global-m1");
  assertEquals(Object.hasOwn(nestedMcp, "__proto__"), false, "nested MCP under named-agent strips __proto__");
});

// ── 7. Benign Sibling Properties Preservation ───────────────────────────────

Deno.test("66t3: benign prototype-adjacent names (constructor, prototype) are preserved", () => {
  const input = jsonWithOwnProto<Record<string, unknown>>(`{
    "provider": "anthropic",
    "baseURL": "https://api.anthropic.com/v1",
    "apiKey": "sk-secret",
    "constructor": "benign-constructor-val",
    "prototype": "benign-prototype-val",
    "tokenLimit": 8192,
    "apiKeyPrefix": "sk-ant-",
    "__proto__": { "dropMe": true }
  }`);

  const cleaned = sanitizeProviderConfig(input) as any;

  assertEquals(cleaned.provider, "anthropic");
  assertEquals(cleaned.constructor, "benign-constructor-val");
  assertEquals(cleaned.prototype, "benign-prototype-val");
  assertEquals(cleaned.tokenLimit, 8192);
  assertEquals(cleaned.apiKeyPrefix, "sk-ant-");
  assertEquals(Object.hasOwn(cleaned, "apiKey"), false);
  assertEquals(Object.hasOwn(cleaned, "__proto__"), false);
});

// ── 8. Falsification: Naive 3-Key Stream Filter is NOT Equivalent ────────────

Deno.test("66t3: falsification — naive 3-key filter preserves __proto__ (not equivalent to canonical)", () => {
  const input = jsonWithOwnProto<Record<string, unknown>>(`{
    "provider": "openai",
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "sk-secret",
    "nested": {
      "__proto__": { "leakedProto": true },
      "ok": 42
    }
  }`);

  // Simulates a streaming filter that only inspects the 3 credential keys
  function naiveStreaming3KeyFilter(data: any): any {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === "apiKey" || k === "authToken" || k === "clientSecret") continue;
      // In a text-based stream or direct assignment, the key is emitted
      Object.defineProperty(out, k, {
        value: naiveStreaming3KeyFilter(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  const naiveResult = naiveStreaming3KeyFilter(input);
  const canonicalResult = sanitizeProviderConfig(input);

  // Proof of non-equivalence:
  // 1. Naive filter retains own __proto__ on nested object
  assertEquals(Object.hasOwn(naiveResult.nested, "__proto__"), true, "naive filter retains __proto__");

  // 2. Canonical sanitizer explicitly drops own __proto__
  assertEquals(Object.hasOwn(canonicalResult.nested, "__proto__"), false, "canonical sanitizer drops __proto__");

  // 3. Serialized outputs differ:
  const naiveJson = JSON.stringify(naiveResult);
  const canonicalJson = JSON.stringify(canonicalResult);
  assertNotEquals(naiveJson, canonicalJson, "naive 3-key filter and canonical output must differ");
  assert(naiveJson.includes("__proto__"), "naive output contains __proto__");
  assert(!canonicalJson.includes("__proto__"), "canonical output omits __proto__");
});
