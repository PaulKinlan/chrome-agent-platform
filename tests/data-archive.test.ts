// @ts-nocheck — the archive module ships as plain JS with injected backends;
// the DI fakes below exercise it from Deno (same precedent as changelog-shipping).
// tests/data-archive.test.ts — owner export/import of all agent data
// (chrome-agent-platform-ykb / CAP-FB-20260825-DATA-EXPORT-IMPORT-01).
//
// The bundle is a STORAGE-LEVEL snapshot (inspectable JSON, documented
// format): chrome.storage.local keys + the whole OPFS tree + scheduled
// alarms, with a precise secret-exclusion policy (provider API keys and MCP
// auth headers are NEVER serialized — the bundle only records which providers
// were configured). Import is two-phase: validate everything first, refuse a
// non-clean target without an explicit overwrite choice, then apply and
// verify. Export/import are owner-gesture routes — never model-callable.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  ARCHIVE_MAGIC,
  ARCHIVE_FORMAT_VERSION,
  MAX_ARCHIVE_OPFS_FILES,
  MAX_ARCHIVE_TOTAL_BYTES,
  buildArchive,
  parseArchive,
  collectExportData,
  sanitizeKvForExport,
  importArchive,
  isExcludedOpfsPath,
  ArchiveFormatError,
} from "../extension/lib/data-archive.js";

// ── mock backends (pure DI — no chrome.*, no OPFS, no window) ──────────────

function mockKv(initial = {}) {
  const store = new Map(Object.entries(structuredClone(initial)));
  return {
    store,
    kvGet: async (key: string | null) => {
      if (key === null) return Object.fromEntries(store);
      return store.has(key) ? structuredClone(store.get(key)) : undefined;
    },
    kvSet: async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
    },
    kvRemove: async (key: string) => {
      store.delete(key);
    },
  };
}

/** A flat in-memory OPFS stand-in: path → { bytes: Uint8Array }. */
function mockOpfs(files = {}) {
  const map = new Map(Object.entries(files).map(([p, v]) => [p, v instanceof Uint8Array ? v : new TextEncoder().encode(v)]));
  return {
    map,
    listFiles: async () => [...map.keys()].sort(),
    readFile: async (path: string) => {
      if (!map.has(path)) throw new Error(`ENOENT: ${path}`);
      return map.get(path).slice();
    },
    writeFile: async (path: string, bytes: Uint8Array) => {
      map.set(path, bytes.slice());
    },
    removeFile: async (path: string) => {
      map.delete(path);
    },
  };
}

function mockAlarms(alarms = []) {
  let list = structuredClone(alarms);
  return {
    getAll: async () => structuredClone(list),
    create: async (name: string, info: Record<string, unknown>) => {
      list = list.filter((a) => a.name !== name);
      list.push({ name, ...info });
    },
    clearAll: async () => {
      list = [];
    },
  };
}

/** The fixture profile: two named agents, master memory, a site store, an
 * artifact body, a durable run, a scheduled task, provider config WITH a
 * secret key, and an MCP server WITH an auth header. */
function fixtureBackends() {
  const kv = mockKv({
    "cap:namedAgents": [
      { id: "writer", name: "Writer", model: "gemini-3.7-flash", icon: "pen" },
      { id: "critic", name: "Critic", model: "k3", icon: "eye" },
    ],
    "cap:scheduledTasks": [{ id: "morning-digest", schedule: "daily-08:00", agent: "writer" }],
    providerConfig: {
      providers: [
        { id: "anthropic", apiKey: "sk-ant-live-SECRET-DEADBEEF0123", model: "claude-opus-4-6" },
        { id: "gemini", apiKey: "", model: "gemini-3.7-flash" },
      ],
    },
    "cap:mcpServers": [
      { name: "docs", transport: { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer SECRET-tok-9f8e7d" } } },
    ],
    "cap:webmcpBridgeNonces": { n1: "ephemeral-value" },
    "cap:fetch": { allow: ["example.com"] },
  });
  const opfs = mockOpfs({
    "memory/master/threads": JSON.stringify({ "t_1": { title: "the editing task" } }),
    "memory/master/thread:t_1": JSON.stringify({ messages: [{ role: "user", text: "hello" }] }),
    "memory/master/assets": JSON.stringify({ "a_1": { title: "the essay", version: 2 } }),
    "memory/master/asset:a_1:body": "<html><body>the essay, version two</body></html>",
    "memory/agents/writer/notes": "writer remembers the style guide",
    "memory/agents/critic/notes": "critic remembers the rubric",
    "memory/origins/https%3A%2F%2Fexample.com/journal": JSON.stringify([{ kind: "result", ok: true }]),
    "durable-runs/exec_abc12345/run.log": "step 1\nstep 2\n",
    "cache/models/catalog.json": '{"cached":true}',
  });
  const alarms = mockAlarms([{ name: "cap-scheduled:morning-digest", scheduledTime: 1750000000000, periodInMinutes: 1440 }]);
  return { kv, opfs, alarms };
}

async function runExport(b) {
  const snapshot = await collectExportData({ kvGet: b.kv.kvGet, opfs: b.opfs, alarms: b.alarms });
  return buildArchive(snapshot, { extensionVersion: "0.3.39", now: () => 1750000000000 });
}

// ── 1. round-trip identity ─────────────────────────────────────────────────

Deno.test("archive round-trip: export → wipe → import restores agent identities, memories, artifacts and references", async () => {
  const source = fixtureBackends();
  const bundle = await runExport(source);

  // The bundle is inspectable JSON with a documented envelope.
  const parsed = parseArchive(bundle);
  assertEquals(parsed.magic, ARCHIVE_MAGIC);
  assertEquals(parsed.formatVersion, ARCHIVE_FORMAT_VERSION);
  assert(parsed.manifest && typeof parsed.manifest.totalBytes === "number");

  // Import into a CLEAN profile.
  const target = { kv: mockKv({}), opfs: mockOpfs({}), alarms: mockAlarms([]) };
  const report = await importArchive(bundle, { kvSet: target.kv.kvSet, kvGet: target.kv.kvGet, kvRemove: target.kv.kvRemove, opfs: target.opfs, alarms: target.alarms });
  assertEquals(report.ok, true);

  // Agent identities survive.
  assertEquals(target.kv.store.get("cap:namedAgents"), source.kv.store.get("cap:namedAgents"));
  // Memory contents survive (writer/critic stores, master threads, site journal).
  assertEquals(new TextDecoder().decode(target.opfs.map.get("memory/agents/writer/notes")), "writer remembers the style guide");
  assertEquals(new TextDecoder().decode(target.opfs.map.get("memory/agents/critic/notes")), "critic remembers the rubric");
  assertEquals(JSON.parse(new TextDecoder().decode(target.opfs.map.get("memory/master/threads"))), { "t_1": { title: "the editing task" } });
  assertEquals(JSON.parse(new TextDecoder().decode(target.opfs.map.get("memory/origins/https%3A%2F%2Fexample.com/journal"))), [{ kind: "result", ok: true }]);
  // Artifact REFERENCES and bodies survive (asset index + CAS body).
  assertEquals(JSON.parse(new TextDecoder().decode(target.opfs.map.get("memory/master/assets"))), { "a_1": { title: "the essay", version: 2 } });
  assertEquals(new TextDecoder().decode(target.opfs.map.get("memory/master/asset:a_1:body")), "<html><body>the essay, version two</body></html>");
  // Durable run history survives.
  assertEquals(new TextDecoder().decode(target.opfs.map.get("durable-runs/exec_abc12345/run.log")), "step 1\nstep 2\n");
  // Scheduled tasks survive.
  assertEquals(target.kv.store.get("cap:scheduledTasks"), source.kv.store.get("cap:scheduledTasks"));
  const restored = await target.alarms.getAll();
  assertEquals(restored.length, 1);
  assertEquals(restored[0].name, "cap-scheduled:morning-digest");
  // Binary fidelity: byte-for-byte on every restored file.
  for (const [path, bytes] of source.opfs.map) {
    if (path.startsWith("cache/")) continue; // caches are excluded by policy
    assertEquals(target.opfs.map.get(path), bytes, `byte-identical: ${path}`);
  }
});

// ── 2. credential exclusion ────────────────────────────────────────────────

Deno.test("archive bytes never contain credential material; the bundle records WHICH providers were configured", async () => {
  const source = fixtureBackends();
  const bundle = await runExport(source);
  assert(!bundle.includes("sk-ant-live-SECRET-DEADBEEF0123"), "the provider API key must never be serialized");
  assert(!bundle.includes("SECRET-tok-9f8e7d"), "the MCP auth header must never be serialized");
  assert(!bundle.includes("apiKey"), "no apiKey field at all in the bundle");
  assert(!bundle.includes("Authorization"), "no header names that carried secrets");
  const parsed = parseArchive(bundle);
  // Which providers were configured — names and shapes only.
  assertEquals(parsed.configuredProviders, [
    { id: "anthropic", model: "claude-opus-4-6", keyConfigured: true },
    { id: "gemini", model: "gemini-3.7-flash", keyConfigured: false },
  ]);
  assertEquals(parsed.mcpServers, [{ name: "docs", transportType: "http", url: "https://mcp.example/mcp", hadAuthHeaders: true }]);
  // The exclusion policy is stated plainly in the bundle itself.
  assertStringIncludes(bundle, "provider API keys");
  assert(parsed.policy.excluded.length >= 4);
});

Deno.test("sanitizeKvForExport strips ephemeral keys and never leaks providerConfig", () => {
  const { kv } = fixtureBackends();
  const out = sanitizeKvForExport(Object.fromEntries(kv.store));
  assertEquals(out.providerConfig, undefined);
  assertEquals(out["cap:webmcpBridgeNonces"], undefined);
  assertEquals(out["cap:namedAgents"].length, 2);
  assertEquals(out["cap:fetch"], { allow: ["example.com"] });
});

// ── 3. corrupt / foreign bundles ───────────────────────────────────────────

Deno.test("parseArchive rejects corrupt and foreign bundles with typed errors", () => {
  for (const bad of ["not json at all", '{"magic":"wrong","formatVersion":1}', '{"magic":"cap-export","formatVersion":99}', '{"magic":"cap-export","formatVersion":1}', "", "[1,2,3]"]) {
    let threw = false;
    try {
      parseArchive(bad);
    } catch (err) {
      threw = true;
      assert(err instanceof ArchiveFormatError, `typed error for: ${bad.slice(0, 40)}`);
      assert(typeof err.code === "string" && err.code.length > 0);
    }
    assert(threw, `must reject: ${bad.slice(0, 40)}`);
  }
});

Deno.test("import of a corrupt bundle applies nothing", async () => {
  const target = { kv: mockKv({ existing: 1 }), opfs: mockOpfs({}), alarms: mockAlarms([]) };
  await assertRejects(
    () => importArchive('{"magic":"cap-export"', { kvSet: target.kv.kvSet, kvGet: target.kv.kvGet, kvRemove: target.kv.kvRemove, opfs: target.opfs, alarms: target.alarms }),
    ArchiveFormatError,
  );
  assertEquals([...target.kv.store.keys()], ["existing"]);
  assertEquals(target.opfs.map.size, 0);
});

// ── 4. transactional import: never overwrite without explicit choice ──────

Deno.test("import refuses a non-clean target without an explicit overwrite choice (and touches nothing)", async () => {
  const source = fixtureBackends();
  const bundle = await runExport(source);
  const target = { kv: mockKv({ "cap:namedAgents": [{ id: "existing-agent" }] }), opfs: mockOpfs({ "memory/master/threads": "{}" }), alarms: mockAlarms([]) };
  await assertRejects(
    () => importArchive(bundle, { kvSet: target.kv.kvSet, kvGet: target.kv.kvGet, kvRemove: target.kv.kvRemove, opfs: target.opfs, alarms: target.alarms }),
    Error,
    "not empty",
  );
  // The pre-existing profile is byte-identical to before.
  assertEquals(target.kv.store.get("cap:namedAgents"), [{ id: "existing-agent" }]);
  assertEquals(new TextDecoder().decode(target.opfs.map.get("memory/master/threads")), "{}");
});

Deno.test("import with overwrite:true replaces the target profile completely", async () => {
  const source = fixtureBackends();
  const bundle = await runExport(source);
  const target = { kv: mockKv({ "cap:namedAgents": [{ id: "existing-agent" }], staleKey: true }), opfs: mockOpfs({ "stale/file": "x" }), alarms: mockAlarms([{ name: "stale-alarm" }]) };
  const report = await importArchive(bundle, { kvSet: target.kv.kvSet, kvGet: target.kv.kvGet, kvRemove: target.kv.kvRemove, opfs: target.opfs, alarms: target.alarms, overwrite: true });
  assertEquals(report.ok, true);
  assertEquals(target.kv.store.get("cap:namedAgents"), source.kv.store.get("cap:namedAgents"));
  assertEquals(target.kv.store.has("staleKey"), false, "overwrite clears keys the archive does not carry");
  assertEquals(target.opfs.map.has("stale/file"), false, "overwrite clears files the archive does not carry");
  const alarms = await target.alarms.getAll();
  assertEquals(alarms.map((a) => a.name), ["cap-scheduled:morning-digest"]);
});

// ── 5. bounds: large bundles fail with honest errors, never silently ──────

Deno.test("archive bounds are named and enforced (file count and total bytes)", async () => {
  assert(MAX_ARCHIVE_OPFS_FILES >= 1000);
  assert(MAX_ARCHIVE_TOTAL_BYTES >= 64 * 1024 * 1024);
  // Too many files.
  const manyFiles = {};
  for (let i = 0; i < 12; i++) manyFiles[`memory/master/f${i}`] = `v${i}`;
  const opfs = mockOpfs(manyFiles);
  const kv = mockKv({});
  const snapshot = await collectExportData({
    kvGet: kv.kvGet,
    opfs,
    alarms: mockAlarms([]),
    maxOpfsFiles: 5, // injectable bound for the test
  });
  let threw = false;
  try {
    buildArchive(snapshot, { extensionVersion: "0.3.39" });
  } catch (err) {
    threw = true;
    assert(err instanceof ArchiveFormatError);
    assertEquals(err.code, "archive-too-many-files");
  }
  assert(threw);
  // Too many bytes.
  const bigOpfs = mockOpfs({ "memory/master/big": new Uint8Array(2048).fill(65) });
  const snapshot2 = await collectExportData({ kvGet: kv.kvGet, opfs: bigOpfs, alarms: mockAlarms([]), maxTotalBytes: 1024 });
  let threw2 = false;
  try {
    buildArchive(snapshot2, { extensionVersion: "0.3.39" });
  } catch (err) {
    threw2 = true;
    assertEquals(err.code, "archive-too-large");
  }
  assert(threw2);
});

// ── 6. export is idempotent and never emits a partial archive ─────────────

Deno.test("export is re-runnable (SW-restart safe) and a failing backend emits NOTHING", async () => {
  const b = fixtureBackends();
  const first = await runExport(b);
  const second = await runExport(b);
  // Same deterministic envelope (exportedAt pinned by the injected clock).
  assertEquals(parseArchive(first).manifest, parseArchive(second).manifest);

  const failingOpfs = {
    listFiles: async () => ["memory/master/x"],
    readFile: async () => {
      throw new Error("disk gone");
    },
  };
  let threw = false;
  try {
    await collectExportData({ kvGet: b.kv.kvGet, opfs: failingOpfs, alarms: b.alarms });
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err?.message || err), "disk gone");
  }
  assert(threw, "a read failure surfaces — never a silent partial snapshot");
});

// ── 7. model unreachability ────────────────────────────────────────────────

Deno.test("export/import are owner routes: no model-callable tool registers them", async () => {
  // The model's tool catalog is built from these registries — none may name
  // the archive routes (a full memory export is a high-value exfiltration
  // target and must not be model-callable).
  const sources = [
    "extension/lib/management-tools.js",
    "extension/lib/browser-tools.js",
    "extension/lib/tools.js",
  ];
  for (const src of sources) {
    const text = await Deno.readTextFile(new URL(`../${src}`, import.meta.url));
    assert(!/owner\.export\.all|owner\.import\.all/.test(text), `${src} must not expose the archive routes`);
  }
});

// ── 8. chrome-agent-platform-5l73: owner-approval HMAC & internal root exclusion ──

Deno.test("5l73 exclusion: owner-approval HMAC and transient roots NEVER enter export across chunk boundaries", async () => {
  // Sentinel across chunk boundary (65,536 bytes)
  const hmacSentinel = "SENTINEL_OWNER_APPROVAL_HMAC_SECRET_" + "K".repeat(65536) + "_END";
  const streamSentinel = "SENTINEL_WASM_TOOL_STREAM_" + "S".repeat(65536) + "_END";
  const cacheSentinel = "SENTINEL_CACHE_DATA_" + "C".repeat(65536) + "_END";
  const userSentinel = "USER_AUTHORED_DATA_WITH_WORD_SECRET_" + "U".repeat(65536) + "_PRESERVED";

  const opfs = mockOpfs({
    // Internal authority / secret roots:
    "chrome-agent-platform-private/owner-approval-hmac-v1": hmacSentinel,
    "chrome-agent-platform-private/site-tool-audit-v1/audit.jsonl": "{\"internal\":true}",
    "wasm-tool-streams-v1/transient-pipe/stdout.bin": streamSentinel,
    "cache/models/catalog.json": cacheSentinel,
    // Legitimate user data (must be preserved byte-faithfully):
    "memory/master/notes.txt": userSentinel,
    "agent-workspaces/writer/draft.md": "# My Document\nSecret analysis",
  });
  const kv = mockKv({
    "cap:namedAgents": [{ id: "writer", name: "Writer" }],
  });
  const alarms = mockAlarms([]);

  const snapshot = await collectExportData({ kvGet: kv.kvGet, opfs, alarms });

  // 1. snapshot.files excludes every internal authority / secret / transient root
  const exportedPaths = snapshot.files.map((f) => f.path);
  assertEquals(exportedPaths.includes("chrome-agent-platform-private/owner-approval-hmac-v1"), false);
  assertEquals(exportedPaths.includes("chrome-agent-platform-private/site-tool-audit-v1/audit.jsonl"), false);
  assertEquals(exportedPaths.includes("wasm-tool-streams-v1/transient-pipe/stdout.bin"), false);
  assertEquals(exportedPaths.includes("cache/models/catalog.json"), false);
  assertEquals(exportedPaths.includes("memory/master/notes.txt"), true);
  assertEquals(exportedPaths.includes("agent-workspaces/writer/draft.md"), true);

  // 2. Serialized bundle bytes contain NONE of the secret or transient sentinels
  const bundle = buildArchive(snapshot, { extensionVersion: "0.3.265", now: () => 1750000000000 });
  assert(!bundle.includes(hmacSentinel), "HMAC secret sentinel must NEVER enter archive bytes");
  assert(!bundle.includes("SENTINEL_OWNER_APPROVAL_HMAC"), "no HMAC sentinel fragment in archive");
  assert(!bundle.includes(streamSentinel), "transient stream sentinel must NEVER enter archive bytes");
  assert(!bundle.includes(cacheSentinel), "cache sentinel must NEVER enter archive bytes");

  // 3. User-authored data is byte-faithful (not heuristically redacted)
  assert(bundle.includes(userSentinel), "user-authored sentinel must be preserved whole");
  assert(bundle.includes("Secret analysis"), "user-authored content is not heuristically stripped");

  // 4. Round-trip restore preserves user data byte-faithfully
  const target = { kv: mockKv({}), opfs: mockOpfs({}), alarms: mockAlarms([]) };
  await importArchive(bundle, {
    kvSet: target.kv.kvSet,
    kvGet: target.kv.kvGet,
    kvRemove: target.kv.kvRemove,
    opfs: target.opfs,
    alarms: target.alarms,
  });
  assertEquals(
    new TextDecoder().decode(target.opfs.map.get("memory/master/notes.txt")),
    userSentinel,
    "restored user file is byte-identical",
  );
  assertEquals(
    target.opfs.map.has("chrome-agent-platform-private/owner-approval-hmac-v1"),
    false,
    "HMAC file was never restored into target",
  );
});

Deno.test("5l73 security: import REJECTS bundles targeting internal authority, secrets, or transient roots", async () => {
  const validBundle = JSON.parse(await runExport(fixtureBackends()));

  // A hostile or compromised bundle attempting to overwrite the install HMAC key
  const forgedHmacBundle = structuredClone(validBundle);
  forgedHmacBundle.opfs.push({
    path: "chrome-agent-platform-private/owner-approval-hmac-v1",
    encoding: "utf8",
    data: "forged-evil-hmac-key",
  });

  const target = { kv: mockKv({}), opfs: mockOpfs({}), alarms: mockAlarms([]) };

  let threw = false;
  try {
    parseArchive(JSON.stringify(forgedHmacBundle));
  } catch (err) {
    threw = true;
    assert(err instanceof ArchiveFormatError);
    assertEquals(err.code, "archive-forbidden-target");
    assertStringIncludes(err.message, "chrome-agent-platform-private/owner-approval-hmac-v1");
  }
  assert(threw, "parseArchive must reject bundle targeting internal HMAC path");

  // Same rejection on importArchive
  await assertRejects(
    () => importArchive(JSON.stringify(forgedHmacBundle), {
      kvSet: target.kv.kvSet,
      kvGet: target.kv.kvGet,
      kvRemove: target.kv.kvRemove,
      opfs: target.opfs,
      alarms: target.alarms,
    }),
    ArchiveFormatError,
  );

  // Also reject transient streams and cache injection
  for (const forbidden of [
    "wasm-tool-streams-v1/forged-pipe.bin",
    "cache/forged-cache.json",
    ".staging/exploit.bin",
  ]) {
    const forged = structuredClone(validBundle);
    forged.opfs.push({ path: forbidden, encoding: "utf8", data: "injected" });
    await assertRejects(
      () => importArchive(JSON.stringify(forged), {
        kvSet: target.kv.kvSet,
        kvGet: target.kv.kvGet,
        kvRemove: target.kv.kvRemove,
        opfs: target.opfs,
        alarms: target.alarms,
      }),
      ArchiveFormatError,
    );
  }
});

Deno.test("5l73 lifecycle: existing install HMAC key in OPFS does not block import on clean profile, and is not deleted on overwrite", async () => {
  const source = fixtureBackends();
  const bundle = await runExport(source);

  // A freshly booted profile where owner-approval.js has already created the install HMAC key:
  const localHmacKey = "LOCAL_INSTALL_HMAC_SECRET_KEY_NEVER_OVERWRITTEN";
  const target = {
    kv: mockKv({}),
    opfs: mockOpfs({
      "chrome-agent-platform-private/owner-approval-hmac-v1": localHmacKey,
    }),
    alarms: mockAlarms([]),
  };

  // 1. Importing WITHOUT overwrite:true SUCCEEDS because the target profile has NO user files:
  const report = await importArchive(bundle, {
    kvSet: target.kv.kvSet,
    kvGet: target.kv.kvGet,
    kvRemove: target.kv.kvRemove,
    opfs: target.opfs,
    alarms: target.alarms,
    overwrite: false,
  });
  assertEquals(report.ok, true);

  // The local install key is completely intact:
  assertEquals(
    new TextDecoder().decode(target.opfs.map.get("chrome-agent-platform-private/owner-approval-hmac-v1")),
    localHmacKey,
  );

  // 2. Importing WITH overwrite:true also preserves the local install key:
  const report2 = await importArchive(bundle, {
    kvSet: target.kv.kvSet,
    kvGet: target.kv.kvGet,
    kvRemove: target.kv.kvRemove,
    opfs: target.opfs,
    alarms: target.alarms,
    overwrite: true,
  });
  assertEquals(report2.ok, true);
  assertEquals(
    new TextDecoder().decode(target.opfs.map.get("chrome-agent-platform-private/owner-approval-hmac-v1")),
    localHmacKey,
    "overwrite:true must NOT wipe the install-scoped owner approval key",
  );
});
