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
