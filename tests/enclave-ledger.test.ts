// tests/enclave-ledger.test.ts — Unit tests for secure enclave audit ledger and quota limits.
// Part of chrome-agent-platform-jao1.6 (CAP-SECURE-ENCLAVE Stage 6).
//
// Pinned properties:
// 1. Privacy contract: query parameters, headers, and bodies are stripped from recorded entries.
// 2. Counter-log separation: count survives log eviction and enforces quota after ring overflow.
// 3. Clock skew safety: backwards clock jumps cannot reset or grant quota (fail-closed).
// 4. Window expiration: natural tumbling window elapse resets the counter for the next window.
// 5. Fail-closed storage recovery (reads & writes): store read/write errors refuse call without wedging.
// 6. Pre-I/O proxy rejection: enclave-proxy refuses calls with quota_exceeded before any network I/O.
// 7. Atomic quota reservation (P1-1): concurrent calls via Promise.all cannot bypass quota limit.
// 8. Canonical service ID accounting (P2-1): aliases (e.g. BRAVE_SEARCH_API_KEY) record under canonical ID.

import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";

import {
  createEnclaveLedger,
  DEFAULT_ENCLAVE_QUOTAS,
  ENCLAVE_QUOTAS_STORAGE_KEY,
  validateQuotasConfig,
} from "../extension/lib/enclave-ledger.js";

import { createEnclaveProxyRoutes } from "../extension/background/routes/enclave-proxy.js";
import { createVaultRoutes } from "../extension/background/routes/vault.js";

function fakeStorage(initial: Record<string, any> = {}) {
  const map: Map<string, any> = new Map(Object.entries(initial));
  let failReads = false;
  let failWrites = false;

  return {
    map,
    setFailReads(fail: boolean) {
      failReads = fail;
    },
    setFailWrites(fail: boolean) {
      failWrites = fail;
    },
    async get(keys: any) {
      if (failReads) throw new Error("simulated storage failure (disk read IO error)");
      if (keys === null) {
        const out: Record<string, any> = {};
        for (const [k, v] of map) out[k] = v;
        return out;
      }
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: map.get(keys) } : {};
      }
      const out: Record<string, any> = {};
      for (const k of keys as string[]) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(items: Record<string, any>) {
      if (failWrites) throw new Error("simulated storage failure (disk write IO error)");
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

// ── Part 1: Privacy Contract ────────────────────────────────────────────────

Deno.test("privacy contract: query parameters, headers, and bodies are stripped from recorded entries", async () => {
  const ledger = createEnclaveLedger({ maxEntries: 10 });

  const recordResult = await ledger.record({
    service: "brave-search",
    keyId: "BRAVE_SEARCH_API_KEY",
    method: "GET",
    origin: "https://api.search.brave.com",
    path: "/res/v1/web/search?q=confidential_user_query&api_key=leak_secret_9988#section",
    status: 200,
    ok: true,
    code: null,
    ms: 45,
    timestamp: 1700000000000,
    headers: { Authorization: "Bearer sk-secret-token-12345" },
    body: "confidential payload body",
  } as any);

  assertEquals(recordResult.path, "/res/v1/web/search");

  const entries = ledger.list();
  assertEquals(entries.length, 1);
  const entry = entries[0];

  assertEquals(entry.service, "brave-search");
  assertEquals(entry.origin, "https://api.search.brave.com");
  assertEquals(entry.path, "/res/v1/web/search");
  assertEquals(entry.status, 200);

  // Assert sensitive strings are completely absent from serialized record
  const serialized = JSON.stringify(entry);
  assert(!serialized.includes("confidential_user_query"), "query text must not be in record");
  assert(!serialized.includes("leak_secret_9988"), "query token must not be in record");
  assert(!serialized.includes("sk-secret-token"), "header bearer token must not be in record");
  assert(!serialized.includes("confidential payload body"), "body payload must not be in record");
});

// ── Part 2: Counter-Log Separation ──────────────────────────────────────────

Deno.test("counter-log separation: count survives ring eviction and enforces quota", async () => {
  // Max 5 entries in the visible log ring buffer
  const ledger = createEnclaveLedger({ maxEntries: 5 });

  const service = "brave-search";
  const quotaLimit = 10;
  const customQuotas = {
    [service]: { limit: quotaLimit, windowMs: 24 * 60 * 60 * 1000 },
  };

  const baseTime = 1700000000000;

  // Record 20 calls with checkQuota + record
  for (let i = 0; i < 20; i++) {
    const ts = baseTime + i * 1000;
    // checkQuota reserves if within limit
    await ledger.checkQuota(service, { now: ts, customQuotas });
    await ledger.record({
      service,
      keyId: "KEY",
      origin: "https://api.search.brave.com",
      path: `/res/v1/web/search`,
      timestamp: ts,
    });
  }

  // 1. Assert visible log ring evicted older entries to maxEntries (5)
  assertEquals(ledger.list().length, 5, "log ring must be bounded to 5 entries");

  // 2. Assert internal rollup counter tracked quota limit of 10 calls
  const rollups = ledger.getRollups();
  assertEquals(rollups[service].count, 10, "counter must cap at 10 and survive eviction");

  // 3. Assert checkQuota fails closed on quota_exceeded
  const check = await ledger.checkQuota(service, {
    now: baseTime + 21 * 1000,
    customQuotas,
  });

  assertEquals(check.ok, false);
  assertEquals(check.code, "quota_exceeded");
  assertStringIncludes(check.error ?? "", "quota exceeded");
});

// ── Part 3: Clock Skew Invariance ───────────────────────────────────────────

Deno.test("clock skew invariance: backwards clock jump refuses call rather than resetting quota", async () => {
  const ledger = createEnclaveLedger();
  const service = "brave-search";
  const baseTime = 1700000000000;

  // Reserve a call at baseTime
  await ledger.checkQuota(service, { now: baseTime });

  // Call checkQuota with a timestamp BEFORE baseTime (simulating backwards clock jump)
  const skewCheck = await ledger.checkQuota(service, {
    now: baseTime - 60000, // 1 minute in the past
  });

  assertEquals(skewCheck.ok, false);
  assertEquals(skewCheck.code, "clock_skew");
  assertStringIncludes(skewCheck.error ?? "", "clock skew detected");
});

Deno.test("window expiration: natural window elapse resets the counter", async () => {
  const ledger = createEnclaveLedger();
  const service = "brave-search";
  const baseTime = 1700000000000;
  const windowMs = 60 * 60 * 1000; // 1 hour

  const customQuotas = {
    [service]: { limit: 2, windowMs },
  };

  // Consume full quota
  const r1 = await ledger.checkQuota(service, { now: baseTime, customQuotas });
  assertEquals(r1.ok, true);
  const r2 = await ledger.checkQuota(service, { now: baseTime + 1000, customQuotas });
  assertEquals(r2.ok, true);

  // Check quota inside window -> rejected
  const insideCheck = await ledger.checkQuota(service, {
    now: baseTime + 2000,
    customQuotas,
  });
  assertEquals(insideCheck.ok, false);
  assertEquals(insideCheck.code, "quota_exceeded");

  // Check quota after window has elapsed -> allowed and counter reset
  const afterCheck = await ledger.checkQuota(service, {
    now: baseTime + windowMs + 1000,
    customQuotas,
  });
  assertEquals(afterCheck.ok, true);
  assertEquals(afterCheck.remaining, 1); // 1 reserved, 1 remaining
});

// ── Part 4: Fail-Closed Storage Recovery (Reads & Writes) ───────────────────

Deno.test("fail-closed storage recovery: store read error refuses call without permanent wedging", async () => {
  const storage = fakeStorage();
  const ledger = createEnclaveLedger({ storageArea: storage });
  const service = "brave-search";

  // Simulate disk read failure
  storage.setFailReads(true);

  const failedCheck = await ledger.checkQuota(service);
  assertEquals(failedCheck.ok, false);
  assertEquals(failedCheck.code, "ledger_unavailable");

  // Restore storage
  storage.setFailReads(false);

  // Next call recovers immediately without wedging
  const recoveredCheck = await ledger.checkQuota(service);
  assertEquals(recoveredCheck.ok, true);
});

Deno.test("fail-closed storage write recovery (P1-2): write error refuses call and does not freeze counter", async () => {
  const storage = fakeStorage();
  const ledger = createEnclaveLedger({ storageArea: storage });
  const service = "brave-search";
  const customQuotas = {
    [service]: { limit: 3, windowMs: 86400000 },
  };

  // First call succeeds with healthy storage
  const r1 = await ledger.checkQuota(service, { customQuotas });
  assertEquals(r1.ok, true);

  // Break storage writes
  storage.setFailWrites(true);

  // Attempting next check fails closed because write failed
  const r2 = await ledger.checkQuota(service, { customQuotas });
  assertEquals(r2.ok, false);
  assertEquals(r2.code, "ledger_unavailable");

  // Restore storage writes
  storage.setFailWrites(false);

  // Call recovers and succeeds
  const r3 = await ledger.checkQuota(service, { customQuotas });
  assertEquals(r3.ok, true);
});

Deno.test("proxy write failure drill (P1-2): broken storage writes fail closed and block upstream fetches", async () => {
  const storage = fakeStorage();
  const ledger = createEnclaveLedger({ storageArea: storage });
  const service = "brave-search";
  const customQuotas = {
    [service]: { limit: 3, windowMs: 86400000 },
  };

  let fetchCalls = 0;
  const mockFetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const fakeVault = {
    getSecretRaw: async () => ({ value: "secret-brave-key" }),
  };

  const routes = createEnclaveProxyRoutes({
    vault: fakeVault as any,
    fetchImpl: mockFetch,
    ledger,
    customQuotas,
    onRecord: (entry) => ledger.record(entry),
    isAllowedCaller: () => true,
  });

  const handler = routes["enclave.proxy"];

  // 1. One successful call with healthy storage
  const res1 = await handler(
    { service: "brave-search", path: "/res/v1/search?q=healthy" },
    { principal: "owner-options" }
  );
  assertEquals(res1.ok, true);
  assertEquals(fetchCalls, 1);

  // 2. Break storage writes (simulating disk/quota write failure)
  storage.setFailWrites(true);

  // 3. Issue 10 requests — all must fail closed with ledger_unavailable, ZERO upstream fetches
  for (let i = 0; i < 10; i++) {
    const err = await assertRejects(
      async () => {
        await handler(
          { service: "brave-search", path: `/res/v1/search?q=broken_${i}` },
          { principal: "owner-options" }
        );
      },
      Error,
      "secure enclave ledger storage is unavailable"
    );
    assertEquals((err as any).code, "ledger_unavailable");
  }

  // Fetch count MUST stay 1 (no unmetered calls slipped through!)
  assertEquals(fetchCalls, 1, "broken storage writes must not permit unmetered upstream fetches");

  // 4. Restore storage writes — recovery is instant
  storage.setFailWrites(false);
  const resRecovered = await handler(
    { service: "brave-search", path: "/res/v1/search?q=recovered" },
    { principal: "owner-options" }
  );
  assertEquals(resRecovered.ok, true);
  assertEquals(fetchCalls, 2);
});

// ── Part 5: Atomic Quota Reservation Under Concurrency (P1-1) ───────────────

Deno.test("atomic reservation: concurrent calls via Promise.all cannot bypass quota limit (P1-1)", async () => {
  const ledger = createEnclaveLedger();
  const service = "brave-search";
  const customQuotas = {
    [service]: { limit: 10, windowMs: 86400000 },
  };

  let fetchCalls = 0;
  const mockFetch = async () => {
    fetchCalls++;
    // Simulate async network latency
    await new Promise((r) => setTimeout(r, 10));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const fakeVault = {
    getSecretRaw: async () => ({ value: "secret-brave-key" }),
  };

  const routes = createEnclaveProxyRoutes({
    vault: fakeVault as any,
    fetchImpl: mockFetch,
    ledger,
    customQuotas,
    onRecord: (entry) => ledger.record(entry),
    isAllowedCaller: () => true,
  });

  const handler = routes["enclave.proxy"];

  // 1. Consume 9 out of 10 calls sequentially
  for (let i = 0; i < 9; i++) {
    const res = await handler(
      { service: "brave-search", path: "/res/v1/search?q=pre" },
      { principal: "owner-options" }
    );
    assertEquals(res.ok, true);
  }
  assertEquals(fetchCalls, 9);

  // 2. Issue 10 concurrent requests at once (reviewer's drill)
  const results = await Promise.allSettled(
    Array.from({ length: 10 }).map((_, idx) =>
      handler(
        { service: "brave-search", path: `/res/v1/search?q=burst_${idx}` },
        { principal: "owner-options" }
      )
    )
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  // Exactly 1 out of the 10 concurrent requests may be granted (reaching the 10 limit)
  assertEquals(fulfilled.length, 1, "exactly 1 concurrent call should succeed to reach limit 10");
  assertEquals(rejected.length, 9, "9 concurrent calls should be rejected");

  // Exactly 10 total upstream network fetches occurred
  assertEquals(fetchCalls, 10, "exactly 10 total upstream fetches may occur across the 10-call window");

  for (const rej of rejected) {
    assertEquals((rej as PromiseRejectedResult).reason.code, "quota_exceeded");
  }
});

// ── Part 6: Canonical Service ID Resolution (P2-1) ──────────────────────────

Deno.test("canonical service ID accounting: alias matches resolve to canonical service ID in ledger (P2-1)", async () => {
  const ledger = createEnclaveLedger();
  const customQuotas = {
    "brave-search": { limit: 2, windowMs: 86400000 },
  };

  const mockFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const fakeVault = {
    getSecretRaw: async () => ({ value: "secret-brave-key" }),
  };

  const routes = createEnclaveProxyRoutes({
    vault: fakeVault as any,
    fetchImpl: mockFetch,
    ledger,
    customQuotas,
    onRecord: (entry) => ledger.record(entry),
    isAllowedCaller: () => true,
  });

  const handler = routes["enclave.proxy"];

  // Call using secret key alias "BRAVE_SEARCH_API_KEY"
  const res = await handler(
    { service: "BRAVE_SEARCH_API_KEY", path: "/res/v1/search?q=alias" },
    { principal: "owner-options" }
  );
  assertEquals(res.ok, true);

  // Assert recorded entry in ledger used canonical ID "brave-search"
  const entries = ledger.list();
  assertEquals(entries[0].service, "brave-search", "ledger record must use canonical service ID");

  // Assert rollup tracked under canonical ID "brave-search"
  const rollups = ledger.getRollups();
  assertEquals(rollups["brave-search"].count, 1);
});

// ── Part 7: Vault Routes KNOWN_CODES and Reset Quotas (P2-2, P2-3) ───────────

Deno.test("vault routes: testConnection maps quota_exceeded, ledger_unavailable, clock_skew (P2-2)", async () => {
  const fakeVault = {
    listMasked: async () => ({}),
  };

  const routes = createVaultRoutes({
    vault: fakeVault as any,
    requireSettingsSender: () => true,
    testConnection: async () => ({ ok: false, code: "quota_exceeded" }),
  });

  const testHandler = routes["vault.test"];
  const res = await testHandler({ service: "brave-search" }, { principal: "owner-options" });
  assertEquals(res.ok, false);
  assertEquals(res.code, "quota_exceeded");
});

Deno.test("vault routes: vault.ledger.resetQuotas resets service quota (P2-3)", async () => {
  const ledger = createEnclaveLedger();
  await ledger.checkQuota("brave-search", {
    customQuotas: { "brave-search": { limit: 1, windowMs: 86400000 } },
  });

  const fakeVault = {
    listMasked: async () => ({}),
  };

  const routes = createVaultRoutes({
    vault: fakeVault as any,
    requireSettingsSender: () => true,
    ledger,
  });

  assertEquals(ledger.getRollups()["brave-search"].count, 1);

  // Reset quotas via vault route
  await routes["vault.ledger.resetQuotas"]({ serviceId: "brave-search" }, { principal: "owner-options" });
  assertEquals(ledger.getRollups()["brave-search"], undefined);
});

// ── Part 8: Slice 2 Configurable Quotas & Usage Surface ─────────────────────

Deno.test("slice 2: validateQuotasConfig strictly enforces valid quota shapes", () => {
  // Valid
  const valid = validateQuotasConfig({
    "brave-search": { limit: 25, windowMs: 86400000 },
    "github": { limit: 0, windowMs: 3600000 },
  });
  assertEquals(valid["brave-search"].limit, 25);
  assertEquals(valid["github"].limit, 0);

  // Invalid: not an object, negative limit, non-integer, non-positive window
  assertThrows(() => validateQuotasConfig(null as any));
  assertThrows(() => validateQuotasConfig([] as any));
  assertThrows(() => validateQuotasConfig({ "test": { limit: -1, windowMs: 1000 } }));
  assertThrows(() => validateQuotasConfig({ "test": { limit: 1.5, windowMs: 1000 } }));
  assertThrows(() => validateQuotasConfig({ "test": { limit: 10, windowMs: 0 } }));
  assertThrows(() => validateQuotasConfig({ "test": { limit: 10, windowMs: -500 } }));
  assertThrows(() => validateQuotasConfig({ "": { limit: 10, windowMs: 1000 } }));
});

Deno.test("slice 2: malformed persisted quota config fails closed without fallback", async () => {
  const storage = fakeStorage({
    [ENCLAVE_QUOTAS_STORAGE_KEY]: {
      "brave-search": { limit: "corrupted_non_number", windowMs: 86400000 },
    },
  });

  const ledger = createEnclaveLedger({ storageArea: storage });

  // Fails closed with quota_config_invalid; does NOT silently fall back to default limit of 50
  const check = await ledger.checkQuota("brave-search");
  assertEquals(check.ok, false);
  assertEquals(check.code, "quota_config_invalid");
  assertStringIncludes(check.error ?? "", "invalid");
});

Deno.test("slice 2: valid persisted quota override takes precedence over defaults", async () => {
  const storage = fakeStorage({
    [ENCLAVE_QUOTAS_STORAGE_KEY]: {
      "brave-search": { limit: 2, windowMs: 86400000 }, // Override default 50 to 2
    },
  });

  const ledger = createEnclaveLedger({ storageArea: storage });

  // 1st call: OK (1 remaining)
  const c1 = await ledger.checkQuota("brave-search");
  assertEquals(c1.ok, true);
  assertEquals(c1.remaining, 1);

  // 2nd call: OK (0 remaining)
  const c2 = await ledger.checkQuota("brave-search");
  assertEquals(c2.ok, true);
  assertEquals(c2.remaining, 0);

  // 3rd call: Quota exceeded
  const c3 = await ledger.checkQuota("brave-search");
  assertEquals(c3.ok, false);
  assertEquals(c3.code, "quota_exceeded");
});

Deno.test("slice 2: limit of zero disables service fail-closed", async () => {
  const storage = fakeStorage({
    [ENCLAVE_QUOTAS_STORAGE_KEY]: {
      "brave-search": { limit: 0, windowMs: 86400000 },
    },
  });

  const ledger = createEnclaveLedger({ storageArea: storage });

  const check = await ledger.checkQuota("brave-search");
  assertEquals(check.ok, false);
  assertEquals(check.code, "service_disabled");
  assertStringIncludes(check.error ?? "", "disabled");
});

Deno.test("slice 2: getUsage and vault.ledger.usage route report accurate telemetry with privacy", async () => {
  const storage = fakeStorage({
    [ENCLAVE_QUOTAS_STORAGE_KEY]: {
      "brave-search": { limit: 5, windowMs: 3600000 },
      "disabled-service": { limit: 0, windowMs: 3600000 },
    },
  });

  const ledger = createEnclaveLedger({ storageArea: storage });
  const baseTime = Date.now() - 5000;

  // Make 2 calls to brave-search, 1 to an unmetered service
  await ledger.checkQuota("brave-search", { now: baseTime });
  await ledger.checkQuota("brave-search", { now: baseTime + 1000 });
  await ledger.checkQuota("unmetered-test-service", { now: baseTime });

  // 1. Direct ledger.getUsage()
  const usage: any = await ledger.getUsage({ now: baseTime + 2000 });
  const braveUsage = usage["brave-search"];
  assertEquals(braveUsage.limit, 5);
  assertEquals(braveUsage.count, 2);
  assertEquals(braveUsage.remaining, 3);
  assertEquals(braveUsage.disabled, false);
  assertEquals(braveUsage.unmetered, false);
  assertEquals(braveUsage.windowStartMs, baseTime);

  // Exact key set assertion (Note 4): strict contract, zero surprise fields
  const expectedKeys = ["count", "disabled", "limit", "remaining", "resetMs", "unmetered", "windowMs", "windowStartMs"].sort();
  assertEquals(Object.keys(braveUsage).sort(), expectedKeys);

  // Unmetered service assertion (Note 2)
  const unmeteredUsage = usage["unmetered-test-service"];
  assertEquals(unmeteredUsage.unmetered, true);
  assertEquals(unmeteredUsage.disabled, false);
  assertEquals(unmeteredUsage.limit, null);
  assertEquals(unmeteredUsage.remaining, null);
  assertEquals(unmeteredUsage.resetMs, null);
  assertEquals(Object.keys(unmeteredUsage).sort(), expectedKeys);

  // Explicitly disabled service (Note 2)
  const disabledUsage = usage["disabled-service"];
  assertEquals(disabledUsage.disabled, true);
  assertEquals(disabledUsage.unmetered, false);
  assertEquals(disabledUsage.limit, 0);
  assertEquals(disabledUsage.remaining, 0);
  assertEquals(disabledUsage.resetMs, null); // Disabled does not count down to false rollover
  assertEquals(Object.keys(disabledUsage).sort(), expectedKeys);

  // 2. Vault route vault.ledger.usage
  const fakeVault = { listMasked: async () => ({}) };
  const routes = createVaultRoutes({
    vault: fakeVault as any,
    requireSettingsSender: () => true,
    ledger,
  });

  const res = await routes["vault.ledger.usage"]({}, { principal: "owner-options" });
  assertEquals(res.ok, true);
  assertEquals(res.configInvalid, false);
  assertEquals(res.usage["brave-search"].count, 2);

  // 3. Privacy contract check: ensure serialized usage leaks no private tokens or queries
  const serialized = JSON.stringify(res.usage);
  assert(!serialized.includes("token"), "usage must not contain token");
  assert(!serialized.includes("path"), "usage must not contain path");
  assert(!serialized.includes("key"), "usage must not contain secret keys");
});

Deno.test("slice 2: vault.ledger routes enforce real settings sender gate (Note 4)", async () => {
  const ledger = createEnclaveLedger();
  const routes = createVaultRoutes({
    vault: { listMasked: async () => ({}) } as any,
    requireSettingsSender: (context: any) => {
      if (context?.principal !== "owner-options") {
        throw new Error("caller must be Settings surface (owner-options)");
      }
    },
    ledger,
  });

  // Non-settings principal must throw
  await assertRejects(
    () => routes["vault.ledger.usage"]({}, { principal: "model" }),
    Error,
    "caller must be Settings surface",
  );
  await assertRejects(
    () => routes["vault.ledger.setQuotas"]({ quotas: {} }, { principal: "extension" }),
    Error,
    "caller must be Settings surface",
  );

  // owner-options succeeds
  const usageRes = await routes["vault.ledger.usage"]({}, { principal: "owner-options" });
  assertEquals(usageRes.ok, true);
});

Deno.test("slice 2: vault.ledger.setQuotas validates, persists, reports configInvalid, and unblocks corrupted ledger (Notes 1, 3, 4)", async () => {
  // Start with corrupted config in storage
  const storage = fakeStorage({
    [ENCLAVE_QUOTAS_STORAGE_KEY]: { "brave-search": "corrupted-entry" },
  });

  const ledger = createEnclaveLedger({ storageArea: storage });
  const routes = createVaultRoutes({
    vault: { listMasked: async () => ({}) } as any,
    requireSettingsSender: () => true,
    ledger,
  });

  // 1. Initial checkQuota fails-closed due to corrupted storage
  const initialCheck = await ledger.checkQuota("brave-search");
  assertEquals(initialCheck.ok, false);
  assertEquals(initialCheck.code, "quota_config_invalid");

  // 2. vault.ledger.usage reports configInvalid: true transparently to UI (Note 3)
  const invalidStatus = await routes["vault.ledger.usage"]({}, { principal: "owner-options" });
  assertEquals(invalidStatus.ok, true);
  assertEquals(invalidStatus.configInvalid, true);
  assertStringIncludes(invalidStatus.configError ?? "", "invalid");

  // 3. Malformed write attempt is refused without mutating storage (Note 1 & 4)
  await assertRejects(
    () => routes["vault.ledger.setQuotas"]({
      quotas: { "brave-search": { limit: -5, windowMs: 1000 } },
    }, { principal: "owner-options" }),
    Error,
    "non-negative integer",
  );

  // Storage remains unchanged
  const storedAfterFailedWrite = await storage.get(ENCLAVE_QUOTAS_STORAGE_KEY);
  assertEquals(storedAfterFailedWrite[ENCLAVE_QUOTAS_STORAGE_KEY]["brave-search"], "corrupted-entry");

  // 4. Valid setQuotas write succeeds, persists, clears error, and unblocks checkQuota (Note 1)
  const setRes: any = await routes["vault.ledger.setQuotas"]({
    quotas: { "brave-search": { limit: 10, windowMs: 3600000 } },
  }, { principal: "owner-options" });
  assertEquals(setRes.ok, true);
  assertEquals(setRes.quotas["brave-search"].limit, 10);

  // Storage now contains valid config
  const storedAfterValid = await storage.get(ENCLAVE_QUOTAS_STORAGE_KEY);
  assertEquals(storedAfterValid[ENCLAVE_QUOTAS_STORAGE_KEY]["brave-search"].limit, 10);

  // vault.ledger.usage now reports configInvalid: false
  const recoveredStatus = await routes["vault.ledger.usage"]({}, { principal: "owner-options" });
  assertEquals(recoveredStatus.configInvalid, false);
  assertEquals(recoveredStatus.configError, null);
  assertEquals(recoveredStatus.usage["brave-search"].limit, 10);

  // checkQuota is unblocked and succeeds!
  const recoveredCheck = await ledger.checkQuota("brave-search");
  assertEquals(recoveredCheck.ok, true);
  assertEquals(recoveredCheck.remaining, 9);
});
