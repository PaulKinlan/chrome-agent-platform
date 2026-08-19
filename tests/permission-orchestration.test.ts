import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  computePermissionPlan,
  exactOriginPattern,
  normalizeHostPattern,
  normalizeRequirement,
  requestPermissionBundleFromGesture,
  verifyPermissionBundle,
} from "../extension/lib/permission-orchestration.js";

Deno.test("permission declarations normalize exact origins and minimal deterministic union", async () => {
  const calls: unknown[] = [];
  const plan = await computePermissionPlan([
    { tool: "provider", reason: "Call configured provider", origins: ["https://api.example.com/v1".replace("/v1", "/*")] },
    { tool: "site", reason: "Drive selected site", permissions: ["scripting"], origins: ["https://site.example/*"] },
    { tool: "site duplicate", reason: "Same site", permissions: ["scripting"], origins: ["https://site.example/*"] },
  ], {
    ownerId: "owner-a", taskId: "task-a", executionId: "exec-a",
    contains: async (bundle) => { calls.push(bundle); return false; },
  });
  assertEquals(plan.bundle, { permissions: ["scripting"], origins: ["https://api.example.com/*", "https://site.example/*"] });
  assertEquals(plan.state, "waiting-for-permission");
  assertEquals(calls.length, 3);
});

Deno.test("malformed, decorated, and wildcard-escalated declarations fail closed", () => {
  assertThrows(() => normalizeHostPattern("https://*.example.com/*"));
  assertThrows(() => normalizeHostPattern("<all_urls>"));
  assertThrows(() => normalizeHostPattern("https://example.com/private/*"));
  assertThrows(() => normalizeHostPattern("https://user:secret@example.com/*"));
  assertThrows(() => normalizeHostPattern("https://example.com/*?scope=all"));
  assertThrows(() => normalizeHostPattern("file:///tmp/*"));
  assertEquals(normalizeHostPattern("<all_urls>", { arbitrarySites: true }), "<all_urls>");
  assertThrows(() => normalizeRequirement({ tool: "network", reason: "network", origins: ["<all_urls>"] }));
  assertThrows(() => normalizeRequirement({ tool: "network", reason: "network", origins: ["<all_urls>", "https://example.com/*"], arbitrarySites: true }));
  assertThrows(() => normalizeRequirement({ tool: "network", reason: "network", origins: ["https://example.com/*"], arbitrarySites: true }));
  assertThrows(() => normalizeRequirement({ tool: "network", reason: "network", permissions: "tabs" }));
  assertThrows(() => normalizeRequirement({ tool: "network", reason: "network", permissions: ["debugger"] }));
  assertThrows(() => normalizeRequirement({ tool: "network", reason: "network", permissions: [], origins: [] }));
  assertEquals(exactOriginPattern("https://example.com"), "https://example.com/*");
  assertThrows(() => exactOriginPattern("https://example.com/path"));
});

Deno.test("activeTab is current-tab owner gesture only, never a background fallback", async () => {
  assertThrows(() => normalizeRequirement({ tool: "capture", reason: "capture", permissions: ["activeTab"] }));
  const plan = await computePermissionPlan([{ tool: "capture", reason: "Capture the tab the owner invoked", permissions: ["activeTab"], context: "owner-current-tab" }], { contains: async () => false });
  assertEquals(plan.transientActiveTab, true);
  assertEquals(plan.bundle.permissions, []);
  assertEquals(plan.state, "waiting-for-permission");
});

Deno.test("gesture request invokes the authority synchronously with only the exact bundle", async () => {
  const events: unknown[] = [];
  let returned = false;
  const promise = requestPermissionBundleFromGesture({ permissions: ["tabs", "tabs"], origins: ["https://example.com/*"] }, (bundle) => {
    events.push({ bundle, beforeReturn: !returned });
    return Promise.resolve(true);
  });
  returned = true;
  assertEquals(events, [{ bundle: { permissions: ["tabs"], origins: ["https://example.com/*"] }, beforeReturn: true }]);
  assertEquals(await promise, true);
  assertThrows(() => requestPermissionBundleFromGesture({ permissions: ["activeTab"] }, () => Promise.resolve(true)));
});

Deno.test("verification detects partial and revoked grants", async () => {
  const result = await verifyPermissionBundle({ permissions: ["tabs", "scripting"], origins: ["https://example.com/*"] }, async (bundle) => !(bundle.permissions?.includes("scripting")));
  assertEquals(result.granted, false);
  assertEquals(result.missing.permissions, ["scripting"]);
  assertEquals(result.missing.origins, []);
});

Deno.test("plans reject unbounded or malformed declaration metadata", async () => {
  const huge = Array.from({ length: 33 }, (_, i) => ({ tool: `tool-${i}`, reason: "needed", permissions: ["tabs"] }));
  await assertRejects(() => computePermissionPlan(huge, { contains: async () => false }));
  assertThrows(() => normalizeRequirement({ tool: "x".repeat(161), reason: "needed", permissions: ["tabs"] }));
  assertThrows(() => normalizeRequirement({ tool: "tabs", reason: "x".repeat(161), permissions: ["tabs"] }));
  assertThrows(() => normalizeRequirement({ tool: "tabs\u0000spoof", reason: "needed", permissions: ["tabs"] }));
});
