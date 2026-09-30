// Tests for chrome-agent-platform-e5oe:
// Migrate persisted `recipe:` task identities to `skill:` (alarms + KV re-key +
// hooks subscription re-key + OPFS memory/workspace directory migration).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";

// ── In-memory Chrome storage + alarms + OPFS mocks ──────────────────────────
const store: Record<string, any> = {};
const alarms = new Map<string, any>();
const alarmOrder: string[] = [];
let failAlarmCreateFor: string | null = null;

function makeOpfsDir(name = ""): any {
  const files = new Map<string, string>();
  const dirs = new Map<string, any>();
  return {
    name,
    _files: files,
    _dirs: dirs,
    async getDirectoryHandle(n: string, opts?: { create?: boolean }) {
      if (!dirs.has(n)) {
        if (!opts?.create) throw new DOMException("NotFound", "NotFoundError");
        dirs.set(n, makeOpfsDir(n));
      }
      return dirs.get(n);
    },
    async getFileHandle(n: string, opts?: { create?: boolean }) {
      if (!files.has(n)) {
        if (!opts?.create) throw new DOMException("NotFound", "NotFoundError");
        files.set(n, "");
      }
      return {
        name: n,
        async getFile() {
          const text = files.get(n) ?? "";
          return {
            size: new TextEncoder().encode(text).byteLength,
            text: async () => text,
          };
        },
        async createWritable() {
          let buf = "";
          return {
            async write(chunk: any) {
              buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            },
            async close() {
              files.set(n, buf);
            },
          };
        },
      };
    },
    async removeEntry(n: string, opts?: { recursive?: boolean }) {
      if (files.has(n)) {
        files.delete(n);
        return;
      }
      if (dirs.has(n)) {
        const sub = dirs.get(n);
        if (!opts?.recursive && (sub._files.size > 0 || sub._dirs.size > 0)) {
          throw new DOMException("InvalidModificationError", "InvalidModificationError");
        }
        dirs.delete(n);
        return;
      }
      throw new DOMException("NotFound", "NotFoundError");
    },
    async *entries() {
      for (const [k, f] of files) {
        yield [k, {
          kind: "file",
          name: k,
          async getFile() {
            return {
              size: new TextEncoder().encode(f).byteLength,
              text: async () => f,
            };
          },
        }];
      }
      for (const [k, d] of dirs) {
        yield [k, { kind: "directory", name: k, ...d }];
      }
    },
  };
}

let opfsRoot = makeOpfsDir("root");
Object.defineProperty(globalThis, "navigator", {
  value: {
    storage: {
      getDirectory: async () => opfsRoot,
    },
    locks: {
      request: async (_name: string, _optsOrFn: any, maybeFn?: any) => {
        const fn = typeof _optsOrFn === "function" ? _optsOrFn : maybeFn;
        return await fn({ name: _name });
      },
    },
  },
  configurable: true,
  writable: true,
});

(globalThis as any).chrome = {
  storage: {
    local: {
      async get(k: any) {
        if (typeof k === "string") return { [k]: store[k] };
        if (Array.isArray(k)) {
          const out: Record<string, any> = {};
          for (const key of k) out[key] = store[key];
          return out;
        }
        return { ...store };
      },
      async set(obj: Record<string, any>) {
        Object.assign(store, obj);
      },
      async remove(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
  },
  permissions: {
    async contains() {
      return true;
    },
  },
  alarms: {
    async create(name: string, info: any) {
      alarmOrder.push(`create:${name}`);
      if (failAlarmCreateFor === name) {
        throw new Error(`simulated alarm.create failure for ${name}`);
      }
      alarms.set(name, {
        name,
        scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? 1) * 60_000,
        periodInMinutes: info.periodInMinutes,
      });
    },
    async get(name: string) {
      return alarms.get(name) ?? null;
    },
    async getAll() {
      return [...alarms.values()];
    },
    async clear(name: string) {
      alarmOrder.push(`clear:${name}`);
      return alarms.delete(name);
    },
  },
};

const {
  SKILL_IDENTITY_MIGRATION_KEY,
  SKILL_IDENTITY_MIGRATION_VERSION,
  migrateSkillIdentities,
} = await import("../extension/lib/skill-identity-migration.js");
const {
  recoverOnBoot,
  listScheduledTasks,
} = await import("../extension/lib/scheduler.js");
const {
  backgroundAgentMemory,
  usageLedgerInspector,
  openDirOptional,
} = await import("../extension/lib/memory.js");
const {
  subscribeHook,
  unsubscribeHook,
  getHookSubscriptions,
  hookStatus,
} = await import("../extension/lib/hooks.js");
const { canonicalOperationTarget } = await import("../extension/lib/owner-approval.js");
const { scheduledReportSlug } = await import("../extension/lib/scheduled-run-report.js");
const { sweepOrphanAgentData } = await import("../extension/lib/durable-runs.js");

const TASK_KEY = "cap:scheduledTasks";
const INFLIGHT_KEY = "cap:scheduledInflight";

function resetState() {
  for (const k of Object.keys(store)) delete store[k];
  alarms.clear();
  alarmOrder.length = 0;
  failAlarmCreateFor = null;
  opfsRoot = makeOpfsDir("root");
  usageLedgerInspector.reset();
}

Deno.test("e5oe: migrateSkillIdentities re-keys cap:scheduledTasks and recreates skill:<id> alarm BEFORE clearing recipe:<id>", async () => {
  resetState();
  const fireAt = Date.now() + 180_000;
  store[TASK_KEY] = {
    "recipe:auto-group-by-domain": {
      task: "Group tabs by domain",
      at: fireAt,
      periodInMinutes: 30,
      createdAt: 1700000000000,
      owner: {
        agentRole: "background:auto-group-by-domain",
        agentSurfaceRef: "background:auto-group-by-domain",
      },
    },
    "agent:researcher": {
      task: "Research digest",
      at: fireAt,
      periodInMinutes: 60,
      createdAt: 1700000000000,
    },
  };
  alarms.set("recipe:auto-group-by-domain", {
    name: "recipe:auto-group-by-domain",
    scheduledTime: fireAt,
    periodInMinutes: 30,
  });
  alarms.set("agent:researcher", {
    name: "agent:researcher",
    scheduledTime: fireAt,
    periodInMinutes: 60,
  });

  const res = await migrateSkillIdentities();
  assertEquals(res.ok, true);
  assertEquals(res.tasksMigrated, 1);

  // Legacy key removed; skill:<id> entry carries the exact schedule metadata.
  assertEquals(store[TASK_KEY]["recipe:auto-group-by-domain"], undefined);
  assertEquals(store[TASK_KEY]["skill:auto-group-by-domain"]?.task, "Group tabs by domain");
  assertEquals(store[TASK_KEY]["skill:auto-group-by-domain"]?.periodInMinutes, 30);
  assertEquals(store[TASK_KEY]["skill:auto-group-by-domain"]?.at, fireAt);
  // Non-recipe tasks remain untouched.
  assertEquals(store[TASK_KEY]["agent:researcher"]?.task, "Research digest");

  // New alarm created with exact scheduledTime + periodInMinutes BEFORE old alarm cleared.
  assertEquals(alarms.has("recipe:auto-group-by-domain"), false);
  const newAlarm = alarms.get("skill:auto-group-by-domain");
  assert(newAlarm, "skill:auto-group-by-domain alarm must be armed");
  assertEquals(newAlarm.scheduledTime, fireAt);
  assertEquals(newAlarm.periodInMinutes, 30);
  const createIdx = alarmOrder.indexOf("create:skill:auto-group-by-domain");
  const clearIdx = alarmOrder.indexOf("clear:recipe:auto-group-by-domain");
  assert(createIdx >= 0 && clearIdx > createIdx, `new alarm must be created before old alarm is cleared (${alarmOrder.join(", ")})`);

  // Completion marker persisted.
  assertEquals(store[SKILL_IDENTITY_MIGRATION_KEY]?.version, SKILL_IDENTITY_MIGRATION_VERSION);
});

Deno.test("e5oe: migrateSkillIdentities does not clobber an existing skill:<id> schedule when both skill:<id> and recipe:<id> exist", async () => {
  resetState();
  const newerWhen = Date.now() + 300_000;
  store[TASK_KEY] = {
    "skill:tab-hygiene": {
      task: "Newer skill schedule",
      at: newerWhen,
      periodInMinutes: 15,
      createdAt: 1700000005000,
    },
    "recipe:tab-hygiene": {
      task: "Stale legacy schedule",
      at: Date.now() + 60_000,
      periodInMinutes: 60,
      createdAt: 1700000000000,
    },
  };
  alarms.set("recipe:tab-hygiene", {
    name: "recipe:tab-hygiene",
    scheduledTime: Date.now() + 60_000,
    periodInMinutes: 60,
  });

  const res = await migrateSkillIdentities();
  assertEquals(res.ok, true);
  assertEquals(store[TASK_KEY]["recipe:tab-hygiene"], undefined);
  assertEquals(store[TASK_KEY]["skill:tab-hygiene"].task, "Newer skill schedule");
  assertEquals(store[TASK_KEY]["skill:tab-hygiene"].periodInMinutes, 15);
  assertEquals(alarms.has("recipe:tab-hygiene"), false);
});

Deno.test("e5oe: migrateSkillIdentities migrates OPFS memory/background/recipe-<id> and agent-workspaces/background-recipe-<id> without losing journal or files", async () => {
  resetState();
  // Seed legacy OPFS memory through backgroundAgentMemory("recipe:digest")
  const legacyMem = backgroundAgentMemory("recipe:digest");
  const journalEntries = [
    { type: "task", id: "recipe:digest:1", task: "Run digest", ts: 1700000001000 },
    { type: "done", id: "recipe:digest:1", result: "Digest complete", ts: 1700000002000 },
  ];
  await legacyMem.setTrusted("journal", journalEntries);
  await legacyMem.set("lastCursor", { page: 4 });

  // Seed legacy OPFS private workspace `agent-workspaces/background-recipe-digest`
  const wsParent = await opfsRoot.getDirectoryHandle("agent-workspaces", { create: true });
  const legacyWs = await wsParent.getDirectoryHandle("background-recipe-digest", { create: true });
  const notesFh = await legacyWs.getFileHandle("notes.md", { create: true });
  const notesWr = await notesFh.createWritable();
  await notesWr.write("# Saved digest notes\n");
  await notesWr.close();

  const res = await migrateSkillIdentities();
  assertEquals(res.ok, true);
  assertEquals(res.memoryDirsMigrated, 1);
  assertEquals(res.workspaceDirsMigrated, 1);

  // New memory location `backgroundAgentMemory("skill:digest")` reads the migrated journal + keys!
  const migratedMem = backgroundAgentMemory("skill:digest");
  assertEquals(await migratedMem.get("journal"), journalEntries);
  assertEquals(await migratedMem.get("lastCursor"), { page: 4 });

  // Legacy OPFS directories were removed after verification.
  assertEquals(await openDirOptional(["memory", "background", "recipe-digest"]), null);
  assertEquals(await openDirOptional(["agent-workspaces", "background-recipe-digest"]), null);

  // Migrated workspace file is intact under `agent-workspaces/background-skill-digest`.
  const migratedWs = await openDirOptional(["agent-workspaces", "background-skill-digest"]);
  assert(migratedWs, "migrated workspace directory must exist");
  const migratedFh = await migratedWs.getFileHandle("notes.md");
  const migratedFile = await migratedFh.getFile();
  assertEquals(await migratedFile.text(), "# Saved digest notes\n");
});

Deno.test("e5oe: FALSIFICATION — OPFS migration fails closed when verification fails, preserving legacy recipe-<id> directory for retry", async () => {
  resetState();
  const legacyMem = backgroundAgentMemory("recipe:precious");
  await legacyMem.setTrusted("journal", [{ type: "task", id: "1", task: "Do not lose me" }]);

  // Simulate a verification failure during copy -> verify -> delete.
  const failedRes = await migrateSkillIdentities({
    verifyFileContent: ({ relPath }: { relPath: string }) => relPath !== "journal.json",
  });
  assertEquals(failedRes.ok, false, "migration must report ok:false when verification fails");
  assert(failedRes.errors.some((e: string) => e.includes("verification failed")));

  // Legacy directory and its journal MUST still exist intact.
  const stillThere = await openDirOptional(["memory", "background", "recipe-precious"]);
  assert(stillThere, "legacy OPFS directory must NOT be deleted when verification fails");
  assertEquals(
    await backgroundAgentMemory("recipe:precious").get("journal"),
    [{ type: "task", id: "1", task: "Do not lose me" }],
  );
  // Completion marker MUST NOT be set so the next boot retries.
  assertEquals(store[SKILL_IDENTITY_MIGRATION_KEY], undefined);

  // Subsequent retry with normal verification succeeds and completes the migration.
  const retryRes = await migrateSkillIdentities();
  assertEquals(retryRes.ok, true);
  assertEquals(
    await backgroundAgentMemory("skill:precious").get("journal"),
    [{ type: "task", id: "1", task: "Do not lose me" }],
  );
  assertEquals(await openDirOptional(["memory", "background", "recipe-precious"]), null);
  assertEquals(store[SKILL_IDENTITY_MIGRATION_KEY]?.version, SKILL_IDENTITY_MIGRATION_VERSION);
});

Deno.test("e5oe: FALSIFICATION — alarm creation failure preserves legacy recipe:<id> schedule and alarm", async () => {
  resetState();
  const fireAt = Date.now() + 120_000;
  store[TASK_KEY] = {
    "recipe:tab-hygiene": {
      task: "Clean tabs",
      at: fireAt,
      periodInMinutes: 30,
      createdAt: 1700000000000,
    },
  };
  alarms.set("recipe:tab-hygiene", {
    name: "recipe:tab-hygiene",
    scheduledTime: fireAt,
    periodInMinutes: 30,
  });
  failAlarmCreateFor = "skill:tab-hygiene";

  const failedRes = await migrateSkillIdentities();
  assertEquals(failedRes.ok, false);
  // Legacy task and legacy alarm are preserved.
  assert(store[TASK_KEY]["recipe:tab-hygiene"], "legacy recipe: task must survive alarm creation failure");
  assert(alarms.has("recipe:tab-hygiene"), "legacy recipe: alarm must survive alarm creation failure");
  assertEquals(store[SKILL_IDENTITY_MIGRATION_KEY], undefined);

  // Clear fault and retry -> succeeds cleanly.
  failAlarmCreateFor = null;
  const retryRes = await migrateSkillIdentities();
  assertEquals(retryRes.ok, true);
  assertEquals(store[TASK_KEY]["recipe:tab-hygiene"], undefined);
  assert(store[TASK_KEY]["skill:tab-hygiene"]);
  assertEquals(alarms.has("recipe:tab-hygiene"), false);
  assert(alarms.has("skill:tab-hygiene"));
});

Deno.test("e5oe: migrateSkillIdentities migrates cap:hooks recipeId to skillId and hooks APIs accept both", async () => {
  resetState();
  // Seed legacy hook subscriptions with `recipeId` only.
  store["cap:hooks"] = [
    {
      hookId: "runtime.onStartup",
      recipeId: "auto-group-by-domain",
      promptTemplate: null,
      enabled: true,
      at: 1700000000000,
    },
    {
      hookId: "bookmarks.onCreated",
      recipeId: null,
      promptTemplate: "Bookmark created: {{payload}}",
      enabled: true,
      at: 1700000001000,
    },
  ];

  const res = await migrateSkillIdentities();
  assertEquals(res.ok, true);
  assertEquals(res.hooksMigrated, 2);

  const subs = await getHookSubscriptions();
  assertEquals(subs.length, 2);
  assertEquals(subs[0].skillId, "auto-group-by-domain");
  assertEquals("recipeId" in subs[0], false, "migrated hook subscription should persist canonical skillId");
  assertEquals(subs[1].skillId, null);

  // Subscribing again with skillId or legacy recipeId is idempotent on the same record.
  await subscribeHook({ hookId: "runtime.onStartup", skillId: "auto-group-by-domain" });
  await subscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-group-by-domain" });
  assertEquals((await getHookSubscriptions()).length, 2);

  // hookStatus reports the subscriber under its skillId.
  const status = await hookStatus();
  const startup = status.find((h: any) => h.id === "runtime.onStartup");
  assertEquals(startup?.subscribers, ["auto-group-by-domain"]);

  // canonicalOperationTarget("hook", ...) produces identical targets for skillId and recipeId.
  assertEquals(
    canonicalOperationTarget("hook", { hookId: "runtime.onStartup", skillId: "auto-group-by-domain" }),
    canonicalOperationTarget("hook", { hookId: "runtime.onStartup", recipeId: "auto-group-by-domain" }),
  );

  // Unsubscribing by skillId removes the migrated subscription.
  const unsub = await unsubscribeHook({ hookId: "runtime.onStartup", skillId: "auto-group-by-domain" });
  assertEquals(unsub.ok, true);
  assertEquals(unsub.skillId, "auto-group-by-domain");
  assertEquals((await getHookSubscriptions()).length, 1);
});

Deno.test("e5oe: recoverOnBoot runs migrateSkillIdentities before reconciling scheduled tasks and is idempotent", async () => {
  resetState();
  const fireAt = Date.now() + 240_000;
  store[TASK_KEY] = {
    "recipe:auto-pin-favorites": {
      task: "Pin favorite tabs",
      at: fireAt,
      periodInMinutes: 60,
      createdAt: 1700000000000,
    },
  };
  store[INFLIGHT_KEY] = {
    "recipe:auto-pin-favorites": {
      token: "stale-boot-token",
      startedAt: Date.now() - 600_000,
      heartbeatAt: Date.now() - 600_000,
    },
  };

  await recoverOnBoot();

  const tasks = await listScheduledTasks();
  assertEquals(tasks.map((t: any) => t.name), ["skill:auto-pin-favorites"]);
  assert(alarms.has("skill:auto-pin-favorites"), "reconcileScheduledTasks must arm skill:auto-pin-favorites");
  assertEquals(alarms.has("recipe:auto-pin-favorites"), false);

  // Second recoverOnBoot is a clean idempotent no-op.
  await recoverOnBoot();
  assertEquals((await listScheduledTasks()).map((t: any) => t.name), ["skill:auto-pin-favorites"]);
});

Deno.test("e5oe: sweepOrphanAgentData and scheduledReportSlug recognize both skill: and legacy recipe: identities", async () => {
  resetState();
  assertEquals(scheduledReportSlug("skill:weekly-digest"), "weekly-digest");
  assertEquals(scheduledReportSlug("recipe:weekly-digest"), "weekly-digest");

  // Seed three background OPFS sandboxes: skill-active-bg, recipe-active-bg, and skill-orphan-bg.
  await backgroundAgentMemory("skill:active-bg").set("k", "v1");
  await backgroundAgentMemory("recipe:active-bg").set("k", "v2");
  await backgroundAgentMemory("skill:orphan-bg").set("k", "v3");

  const res = await sweepOrphanAgentData({
    listAgents: async () => [],
    listTasks: async () => [{ name: "skill:active-bg" }],
  });
  assertEquals(res.ok, true);
  // Both skill-active-bg and recipe-active-bg are protected while skill:active-bg is live;
  // only skill-orphan-bg is swept.
  assert(await openDirOptional(["memory", "background", "skill-active-bg"]), "skill-active-bg must survive sweep");
  assert(await openDirOptional(["memory", "background", "recipe-active-bg"]), "recipe-active-bg must survive sweep while skill:active-bg is live");
  assertEquals(await openDirOptional(["memory", "background", "skill-orphan-bg"]), null, "skill-orphan-bg must be swept");
});
