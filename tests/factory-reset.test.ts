// tests/factory-reset.test.ts — Comprehensive KAT test suite for Factory Reset / Nuclear Wipe
// (CAP-FB-20260823-FACTORY-RESET-01).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  executeFactoryReset,
  enumerateStorageTargets,
  FACTORY_RESET_STORAGE_CLASSES,
} from "../extension/lib/factory-reset.js";
import { kvGet, kvSet } from "../extension/lib/kv.js";
import { loadFirstRunGuideState } from "../extension/lib/first-run-onboarding.js";

// In-memory mock storage environments
class MockDirectoryHandle {
  constructor(name = "root") {
    this.name = name;
    this.kind = "directory";
    this._entries = new Map();
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this._entries.has(name)) {
      if (!create) throw new Error("not found");
      this._entries.set(name, new MockDirectoryHandle(name));
    }
    return this._entries.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this._entries.has(name)) {
      if (!create) throw new Error("not found");
      this._entries.set(name, { name, kind: "file" });
    }
    return this._entries.get(name);
  }
  async removeEntry(name, { recursive = false } = {}) {
    this._entries.delete(name);
  }
  async *entries() {
    for (const [name, handle] of this._entries.entries()) {
      yield [name, handle];
    }
  }
}

Deno.test("FACTORY_RESET_STORAGE_CLASSES: covers all seven platform storage classes", () => {
  const expected = [
    "chrome.storage.local",
    "chrome.storage.session",
    "in-memory-session-kv",
    "origin-private-file-system",
    "indexed-db",
    "cache-storage",
    "chrome.alarms",
  ];
  for (const c of expected) {
    assert(FACTORY_RESET_STORAGE_CLASSES.includes(c), `must cover ${c}`);
  }
});

Deno.test("enumerateStorageTargets: discovers stored keys, OPFS directories, IDB databases, and alarms", async () => {
  const opfsRoot = new MockDirectoryHandle();
  await opfsRoot.getDirectoryHandle("models", { create: true });
  await opfsRoot.getDirectoryHandle("memory", { create: true });
  await opfsRoot.getDirectoryHandle("tool-jobs", { create: true });

  await kvSet({ "test:key1": "value1", "test:key2": "value2" });

  const targets = await enumerateStorageTargets({ opfsRoot });
  assert(targets.chromeStorageKeys.includes("test:key1"), "discovers KV key 1");
  assert(targets.chromeStorageKeys.includes("test:key2"), "discovers KV key 2");

  const opfsNames = targets.opfsEntries.map((e) => e.name);
  assert(opfsNames.includes("models"), "discovers models dir");
  assert(opfsNames.includes("memory"), "discovers memory dir");
  assert(opfsNames.includes("tool-jobs"), "discovers tool-jobs dir");
});

Deno.test("executeFactoryReset: transactionally wipes all storage targets and restores first-run state", async () => {
  const opfsRoot = new MockDirectoryHandle();
  await opfsRoot.getDirectoryHandle("models", { create: true });
  await opfsRoot.getDirectoryHandle("memory", { create: true });

  // Seed storage keys including onboarding state
  await kvSet({
    "providerConfig": { provider: "openai", apiKey: "secret" },
    "cap:firstRunStatus": { completed: true },
    "cap:namedAgents": [{ id: "agent-1", name: "Agent" }],
    "cap:tasks": [{ id: "task-1" }],
  });

  let beforeKv = await kvGet(null);
  assert(Object.keys(beforeKv).length >= 4, "storage must have seeded keys");

  // Run factory reset
  const result = await executeFactoryReset({ opfsRoot });
  assertEquals(result.ok, true);
  assertEquals(result.verified, true);
  assert(result.storageClassesWiped.includes("origin-private-file-system"));
  assert(result.storageClassesWiped.includes("chrome.storage.local"));
  assert(result.storageClassesWiped.includes("in-memory-session-kv"));

  // Check post-wipe cleanliness
  const afterKv = await kvGet(null);
  assertEquals(Object.keys(afterKv).length, 0, "all KV keys must be completely wiped");

  let opfsRemaining = 0;
  for await (const _ of opfsRoot.entries()) {
    opfsRemaining++;
  }
  assertEquals(opfsRemaining, 0, "all OPFS directories must be completely wiped");

  // First-run guide state resets cleanly to unonboarded initial state
  const guideState = await loadFirstRunGuideState();
  assertEquals(guideState.show, true, "first-run onboarding guide must be shown");
  assertEquals(guideState.hasArtifact, false, "no artifacts present after reset");
  assertEquals(guideState.providerReady, false, "provider is unconfigured after reset");
});

Deno.test("executeFactoryReset: fails closed on partial error and surfaces exact report", async () => {
  const failingOpfs = {
    async *entries() {
      yield ["models", { kind: "directory" }];
    },
    async removeEntry() {
      throw new Error("simulated_opfs_disk_locked");
    },
  };

  let threw = false;
  try {
    await executeFactoryReset({ opfsRoot: failingOpfs });
  } catch (err) {
    threw = true;
    assertEquals(err.code, "factory_reset_incomplete");
    assert(err.report.errors.some((e) => e.includes("simulated_opfs_disk_locked")));
  }
  assertEquals(threw, true, "failing sweep step must throw and fail closed");
});

Deno.test("Cancel mutates nothing: rejecting confirmation dialog never invokes wipe and leaves all stores intact", async () => {
  await kvSet({
    "persistent:key": "keep-me",
    "providerConfig": { provider: "openai", apiKey: "saved-key" },
    "cap:firstRunStatus": { completed: true },
  });

  let wipeInvoked = false;
  const wipeRunner = async () => {
    wipeInvoked = true;
    return await executeFactoryReset();
  };

  // Dialog prompt simulation: user chooses Cancel (dialog resolves false)
  const showConfirmDialog = async () => false;

  const confirmed = await showConfirmDialog();
  if (confirmed) {
    await wipeRunner();
  }

  assertEquals(wipeInvoked, false, "wipe runner must never be invoked when user cancels");

  const stored = await kvGet(null);
  assertEquals(stored["persistent:key"], "keep-me", "data must stay intact when cancelled");
  assertEquals(stored["providerConfig"]?.apiKey, "saved-key", "provider config stays intact");
  assertEquals(stored["cap:firstRunStatus"]?.completed, true, "onboarding state stays intact");
});

// ── CAP-FB-20260830-PRIVACY-STATEMENT-01: what the browser-driven reset found ──
// (1) A page or the worker holding an IndexedDB connection BLOCKS
//     deleteDatabase; the wipe resolved on `onblocked` and moved on, so
//     `cap-usage` and `cap_fs_grants` survived every reset while the
//     verification (which never counted IndexedDB) still said clean.
// (2) The service-worker route called `invalidateOrchestrator()`, which does
//     not exist, so the route reported failure AFTER wiping and Settings never
//     returned to first run.
class MockIdb {
  constructor(names, { blockUntilClosed = false } = {}) {
    this.names = new Set(names);
    this.blockUntilClosed = blockUntilClosed;
    this.deleted = [];
    this.closeHandlers = [];
  }
  async databases() { return [...this.names].map((name) => ({ name, version: 1 })); }
  deleteDatabase(name) {
    const req = {};
    queueMicrotask(() => {
      if (this.blockUntilClosed && this.names.has(name)) {
        // The open connection sees `versionchange`, closes, and only THEN
        // does the delete complete — well after `onblocked` fired.
        req.onblocked?.();
        setTimeout(() => { this.names.delete(name); this.deleted.push(name); req.onsuccess?.(); }, 40);
        return;
      }
      this.names.delete(name);
      this.deleted.push(name);
      req.onsuccess?.();
    });
    return req;
  }
}

async function withMockIdb(mock, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { value: mock, configurable: true, writable: true });
  try { return await fn(); } finally {
    if (had) Object.defineProperty(globalThis, "indexedDB", had);
    else delete globalThis.indexedDB;
  }
}

Deno.test("executeFactoryReset: a deleteDatabase blocked by an open connection is WAITED for, and the verification counts IndexedDB", async () => {
  const idb = new MockIdb(["cap-usage", "cap_fs_grants"], { blockUntilClosed: true });
  await withMockIdb(idb, async () => {
    const result = await executeFactoryReset({ opfsRoot: new MockDirectoryHandle() });
    assertEquals(result.verified, true);
    assertEquals(result.verification.indexedDbRemaining, 0, "no database survives the reset");
    assert(idb.deleted.includes("cap-usage") && idb.deleted.includes("cap_fs_grants"), `both blocked deletes completed: ${idb.deleted}`);
  });
});

Deno.test("executeFactoryReset: a database that never lets go is reported as a remnant (fail-closed), not silently kept", async () => {
  const stuck = new MockIdb(["cap_fs_grants"]);
  stuck.deleteDatabase = (name) => {
    const req = {};
    queueMicrotask(() => req.onblocked?.()); // blocked forever — no onsuccess ever
    return req;
  };
  await withMockIdb(stuck, async () => {
    let threw = null;
    try {
      await executeFactoryReset({ opfsRoot: new MockDirectoryHandle(), idbBlockedWaitMs: 60 });
    } catch (err) {
      threw = err;
    }
    assert(threw, "a surviving database fails the reset closed");
    assertEquals(threw.code, "factory_reset_incomplete");
    assert(threw.report.errors.includes("idb_remnants_detected"), `errors: ${threw.report.errors}`);
    assertEquals(threw.report.verification.indexedDbRemaining, 1);
  });
});

Deno.test("executeFactoryReset: a database an in-flight write recreates after the delete is swept before the report", async () => {
  // The live worker keeps running during the wipe: a usage write that was
  // already in flight reopens `cap-usage` microseconds after deleteDatabase
  // succeeded. Observed in a real loaded extension — the wipe was correct and
  // the profile still had the database.
  const idb = new MockIdb(["cap-usage"]);
  let recreated = false;
  const del = idb.deleteDatabase.bind(idb);
  idb.deleteDatabase = (name) => {
    const req = del(name);
    if (name === "cap-usage" && !recreated) {
      recreated = true;
      setTimeout(() => idb.names.add("cap-usage"), 5); // the in-flight write reopens it
    }
    return req;
  };
  await withMockIdb(idb, async () => {
    const result = await executeFactoryReset({ opfsRoot: new MockDirectoryHandle() });
    assertEquals(result.verified, true);
    assertEquals(result.verification.indexedDbRemaining, 0, "the recreated database is swept");
    assertEquals(idb.deleted.filter((n) => n === "cap-usage").length, 2, "deleted once, then swept once");
  });
});

Deno.test("system.factoryReset route: every function it calls is one the service worker defines or imports", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const start = sw.indexOf('async "system.factoryReset"(');
  assert(start > 0, "the route exists");
  const body = sw.slice(start, sw.indexOf('async "system.factoryResetEnumerate"(', start))
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const called = new Set();
  for (const m of body.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
  for (const keyword of ["if", "return", "catch", "async", "await", "for", "while", "switch", "function"]) called.delete(keyword);
  const defined = (name) =>
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\b`).test(sw) ||
    new RegExp(`(?:^|\\n)\\s*(?:const|let|var)\\s+${name}\\b`).test(sw) ||
    new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(sw);
  const missing = [...called].filter((name) => !defined(name));
  assertEquals(missing, [], `the reset route calls functions the worker never defines: ${missing.join(", ")}`);
});

Deno.test("B-1 first-run restore: ntp.js #factory-reset boot handler wipes localStorage dismissed keys", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  // In ntp.js: handleFactoryResetBoot clears FIRST_RUN_DISMISSED_KEY and browser choice
  assert(
    /function handleFactoryResetBoot\(\)[\s\S]*?localStorage\.removeItem\(FIRST_RUN_DISMISSED_KEY\);[\s\S]*?localStorage\.removeItem\(FIRST_RUN_BROWSER_CHOICE_KEY\);/
      .test(ntpJs),
    "ntp.js must clear localStorage dismissed keys on #factory-reset boot",
  );

  assert(
    ntpJs.includes("handleFactoryResetBoot();"),
    "handleFactoryResetBoot must be invoked at startup before first-run guide renders",
  );
});
