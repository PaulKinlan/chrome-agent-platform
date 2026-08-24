// Focused deterministic coverage for terminal durable-run projection refresh.
// @ts-nocheck — deferred authority responses are intentionally hand-controlled.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createTerminalThreadProjectionLifecycle } from "../extension/lib/terminal-thread-projection-lifecycle.js";
import { createRunSurfaceOwner } from "../extension/shared/run-surface-owner.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function run({
  executionId = "exec:terminal-projection-001",
  threadId = "thread-owner-1",
  revision = 12,
  phase = "terminal",
} = {}) {
  return { executionId, threadId, revision, phase };
}

function harness({ loadThread } = {}) {
  const owner = createRunSurfaceOwner();
  owner.claim();
  let openThreadId = "thread-owner-1";
  const commits = [];
  let loads = 0;
  const lifecycle = createTerminalThreadProjectionLifecycle({
    loadThread: async (id) => {
      loads += 1;
      return loadThread ? await loadThread(id) : {
        ok: true,
        thread: {
          id,
          messages: [
            { role: "user", content: "run the task" },
            { role: "assistant", content: "finished durably" },
          ],
        },
      };
    },
    commitThread: (thread, terminalRun, projectionOwner) => commits.push({
      thread: structuredClone(thread),
      run: structuredClone(terminalRun),
      owner: projectionOwner,
    }),
    getOpenOwnerThreadId: () => openThreadId,
    captureSurfaceOwner: () => owner.current(),
    ownsSurfaceOwner: (token) => owner.owns(token),
  });
  return {
    lifecycle,
    owner,
    commits,
    get loads() { return loads; },
    setOpenThread(id) { openThreadId = id; },
  };
}

Deno.test("terminal thread projection: same-thread terminal transition performs one authoritative refresh", async () => {
  const h = harness();
  await h.lifecycle.onRunSnapshot({ runs: [run({ revision: 11, phase: "running" })] });
  assertEquals(h.loads, 0);

  assertEquals(await h.lifecycle.onRunSnapshot({ runs: [run()] }), true);
  assertEquals(h.loads, 1);
  assertEquals(h.commits.length, 1);
  assertEquals(h.commits[0].thread.messages.at(-1), {
    role: "assistant",
    content: "finished durably",
  });
  assertEquals(h.commits[0].owner, 1, "the projection commit carries the captured surface owner");
});

Deno.test("terminal thread projection: duplicate terminal snapshot and revision are no-ops", async () => {
  const h = harness();
  await h.lifecycle.onRunSnapshot({ runs: [run()] });
  await h.lifecycle.onRunSnapshot({ runs: [run()] });
  await h.lifecycle.onRunSnapshot({ runs: [run()] });

  assertEquals(h.loads, 1);
  assertEquals(h.commits.length, 1);
});

Deno.test("terminal thread projection: nonterminal and other-thread events are no-ops", async () => {
  const h = harness();
  await h.lifecycle.onRunSnapshot({ runs: [run({ phase: "settling" })] });
  await h.lifecycle.onRunSnapshot({ runs: [run({ executionId: "exec:other", threadId: "thread-other", phase: "cancelled" })] });

  assertEquals(h.loads, 0);
  assertEquals(h.commits, []);
});

Deno.test("terminal thread projection: navigation and owner change fence a delayed terminal read", async () => {
  const read = deferred();
  const h = harness({ loadThread: () => read.promise });
  const pending = h.lifecycle.onRunSnapshot({ runs: [run()] });
  assertEquals(h.loads, 1);

  h.setOpenThread("thread-newer");
  h.owner.claim();
  read.resolve({
    ok: true,
    thread: { id: "thread-owner-1", messages: [{ role: "assistant", content: "stale" }] },
  });

  assertEquals(await pending, false);
  assertEquals(h.commits, []);
});

Deno.test("terminal thread projection: authoritative replacement leaves exactly one assistant result", async () => {
  let visible = [{ role: "user", content: "run the task" }];
  const owner = createRunSurfaceOwner();
  owner.claim();
  let loads = 0;
  const lifecycle = createTerminalThreadProjectionLifecycle({
    loadThread: async (id) => {
      loads += 1;
      return {
        ok: true,
        thread: {
          id,
          messages: [
            { role: "user", content: "run the task" },
            { role: "assistant", content: "finished durably", executionId: "exec:terminal-projection-001" },
          ],
        },
      };
    },
    commitThread: (thread) => { visible = structuredClone(thread.messages); },
    getOpenOwnerThreadId: () => "thread-owner-1",
    captureSurfaceOwner: () => owner.current(),
    ownsSurfaceOwner: (token) => owner.owns(token),
  });

  await lifecycle.onRunSnapshot({ runs: [run()] });
  await lifecycle.onRunSnapshot({ runs: [run()] });
  assertEquals(loads, 1);
  assertEquals(visible.filter((message) => message.role === "assistant").length, 1);

  const source = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assertStringIncludes(source, "terminalThreadProjectionLifecycle.onRunSnapshot(snapshot)");
  assertStringIncludes(source, "threadConversation.setMessages?.(projectThreadMessages(thread))");
});
