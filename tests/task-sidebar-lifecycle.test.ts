// Focused deterministic coverage for the NTP Tasks-sidebar live lifecycle.
// @ts-nocheck — deferred authority responses are intentionally hand-controlled.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createTaskSidebarLifecycle,
  loadThreadsWithOneRestartRetry,
} from "../extension/lib/task-sidebar-lifecycle.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function runningRun(revision = 1) {
  return {
    executionId: "exec:sidebar-live-owner-001",
    threadId: "thread-owner-1",
    revision,
    phase: "running",
  };
}

Deno.test("task sidebar: a new owner thread is rendered from a running run update before terminal completion", async () => {
  let authority = { threads: [] };
  let visible = [];
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: async () => authority,
    commitThreads: (threads) => { visible = threads.map((thread) => ({ ...thread })); },
  });

  await lifecycle.render();
  assertEquals(visible, []);

  authority = { threads: [{ id: "thread-owner-1", name: "Focused durability proof" }] };
  const run = runningRun(1);
  await lifecycle.onRunSnapshot({ runs: [run] });

  assertEquals(run.phase, "running", "the visibility signal must not wait for terminal completion");
  assertEquals(visible.map((row) => row.id), ["thread-owner-1"]);
});

Deno.test("task sidebar: run/progress revisions replace rather than duplicate the owner row", async () => {
  const authority = { threads: [{ id: "thread-owner-1", name: "One task" }] };
  let visible = [];
  let commits = 0;
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: async () => authority,
    commitThreads: (threads) => {
      commits += 1;
      visible = threads.map((thread) => ({ ...thread }));
    },
  });

  await lifecycle.onRunSnapshot({ runs: [runningRun(1)] });
  await lifecycle.onRunSnapshot({ runs: [runningRun(2)] });
  await lifecycle.onRunSnapshot({ runs: [runningRun(3)] });
  assertEquals(visible.map((row) => row.id), ["thread-owner-1"]);
  assertEquals(new Set(visible.map((row) => row.id)).size, visible.length);

  await lifecycle.onRunSnapshot({ runs: [runningRun(3)] });
  assertEquals(commits, 3, "an unchanged run snapshot must not schedule a duplicate render");
});

Deno.test("task sidebar: returning from another view re-renders the same native-click target", async () => {
  const authority = { threads: [{ id: "thread-owner-1", name: "Still running" }] };
  let visible = [];
  let opened = null;
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: async () => authority,
    commitThreads: (threads) => {
      // Model the production replaceChildren + native click listener contract.
      visible = threads.map((thread) => ({
        id: thread.id,
        click: () => { opened = thread.id; },
      }));
    },
  });

  await lifecycle.onRunSnapshot({ runs: [runningRun(1)] });
  visible = []; // covered by Settings
  await lifecycle.render(); // owner returns through closeView
  assertEquals(visible.map((row) => row.id), ["thread-owner-1"]);
  visible[0].click();
  assertEquals(opened, "thread-owner-1");

  const source = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assertStringIncludes(source, 'item.addEventListener("click", () => openThread(t.id))');
  assertStringIncludes(source, "taskSidebarLifecycle.onRunSnapshot(snapshot, currentThreadId)");
  assertStringIncludes(source, "renderTasks(currentThreadId);");
});

Deno.test("task sidebar: a delayed stale render cannot overwrite a newer sidebar state", async () => {
  const oldRead = deferred();
  const newRead = deferred();
  const reads = [oldRead.promise, newRead.promise];
  const commits = [];
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: () => reads.shift(),
    commitThreads: (threads) => commits.push(threads.map((thread) => thread.id)),
  });

  const older = lifecycle.render();
  const newer = lifecycle.render();
  newRead.resolve({ threads: [{ id: "thread-new" }] });
  assertEquals(await newer, true);
  oldRead.resolve({ threads: [{ id: "thread-stale" }] });
  assertEquals(await older, false);

  assertEquals(commits, [["thread-new"]]);
  assert(!commits.flat().includes("thread-stale"));
});

Deno.test("task sidebar recovery: a failed authoritative read preserves prior rows", async () => {
  let visible = [];
  let fail = false;
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: async () => {
      if (fail) throw new Error("MV3 worker restarting");
      return { threads: [{ id: "thread-owner-1" }] };
    },
    commitThreads: (threads) => { visible = structuredClone(threads); },
  });

  assertEquals(await lifecycle.render(), true);
  fail = true;
  assertEquals(await lifecycle.render(), false);
  assertEquals(visible.map((row) => row.id), ["thread-owner-1"]);
});

Deno.test("task sidebar recovery: an identical run snapshot retries after a failed read and succeeds", async () => {
  let loads = 0;
  let visible = [];
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: async () => {
      loads += 1;
      if (loads === 1) throw new Error("MV3 worker restarting");
      return { threads: [{ id: "thread-owner-1" }] };
    },
    commitThreads: (threads) => { visible = structuredClone(threads); },
  });
  const snapshot = { runs: [runningRun(12)] };

  assertEquals(await lifecycle.onRunSnapshot(snapshot), false);
  assertEquals(await lifecycle.onRunSnapshot(snapshot), true);
  assertEquals(loads, 2);
  assertEquals(visible.map((row) => row.id), ["thread-owner-1"]);
});

Deno.test("task sidebar recovery: a concurrent identical retry fences the stale result", async () => {
  const staleRead = deferred();
  const retryRead = deferred();
  const reads = [staleRead.promise, retryRead.promise];
  const commits = [];
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: () => reads.shift(),
    commitThreads: (threads) => commits.push(threads.map((thread) => thread.id)),
  });
  const snapshot = { runs: [runningRun(12)] };

  const stale = lifecycle.onRunSnapshot(snapshot);
  const retry = lifecycle.onRunSnapshot(snapshot);
  retryRead.resolve({ threads: [{ id: "thread-owner-1" }] });
  assertEquals(await retry, true);
  staleRead.resolve({ threads: [{ id: "thread-stale" }] });
  assertEquals(await stale, false);
  assertEquals(commits, [["thread-owner-1"]]);
});

Deno.test("task sidebar recovery: the restart loader performs at most one bounded retry", async () => {
  let loads = 0;
  let waits = 0;
  const response = await loadThreadsWithOneRestartRetry(
    async () => {
      loads += 1;
      if (loads === 1) throw new Error("MV3 worker restarting");
      return { threads: [{ id: "thread-owner-1" }] };
    },
    async () => { waits += 1; },
  );
  assertEquals(response.threads.map((row) => row.id), ["thread-owner-1"]);
  assertEquals(loads, 2);
  assertEquals(waits, 1);

  loads = 0;
  await assertRejects(
    () => loadThreadsWithOneRestartRetry(
      async () => {
        loads += 1;
        throw new Error("still unavailable");
      },
      async () => {},
    ),
    Error,
    "still unavailable",
  );
  assertEquals(loads, 2, "a second failure must not start a timer or third read");
});

Deno.test("task sidebar recovery: terminal reload renders exactly one persisted owner row", async () => {
  let loads = 0;
  let visible = [];
  let commits = 0;
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: () => loadThreadsWithOneRestartRetry(
      async () => {
        loads += 1;
        if (loads === 1) throw new Error("MV3 startup race");
        return { threads: [{ id: "thread-owner-1", status: "done" }] };
      },
      async () => {},
    ),
    commitThreads: (threads) => {
      commits += 1;
      visible = structuredClone(threads);
    },
  });
  const terminal = { runs: [{ ...runningRun(12), phase: "terminal" }] };

  assertEquals(await lifecycle.onRunSnapshot(terminal), true);
  assertEquals(await lifecycle.onRunSnapshot(terminal), false);
  assertEquals(loads, 2);
  assertEquals(commits, 1);
  assertEquals(visible.map((row) => row.id), ["thread-owner-1"]);
  assertEquals(new Set(visible.map((row) => row.id)).size, 1);
});
