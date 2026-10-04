// Focused deterministic coverage for the NTP Tasks-sidebar live lifecycle.
// @ts-nocheck — deferred authority responses are intentionally hand-controlled.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createTaskSidebarLifecycle,
  loadThreadsWithOneRestartRetry,
} from "../extension/lib/task-sidebar-lifecycle.js";
import { threadRowsDigest } from "../extension/lib/thread-rows-digest.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function runningRun(revision = 1, extra = {}) {
  return {
    executionId: "exec:sidebar-live-owner-001",
    threadId: "thread-owner-1",
    revision,
    phase: "running",
    ...extra,
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

Deno.test("task sidebar: heartbeat/preToolUse revision bumps with unchanged thread-visible state do not re-render", async () => {
  const authority = { threads: [{ id: "thread-owner-1", name: "One task" }] };
  let visible = [];
  let commits = 0;
  let loads = 0;
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: async () => {
      loads += 1;
      return authority;
    },
    commitThreads: (threads) => {
      commits += 1;
      visible = threads.map((thread) => ({ ...thread }));
    },
  });

  assertEquals(await lifecycle.onRunSnapshot({ runs: [runningRun(1)] }), true);
  assertEquals(commits, 1);
  // durableRuns.heartbeat()/preToolUse() bump run.revision every ~5s while
  // phase, threadId, taskPreview and terminal state (everything a row can
  // show) stay identical. None of those bumps may re-fetch thread.list —
  // that was the ~70 hydrations / 4 minutes storm.
  assertEquals(await lifecycle.onRunSnapshot({ runs: [runningRun(2)] }), false);
  assertEquals(
    await lifecycle.onRunSnapshot({ runs: [runningRun(3, { progressCount: 7, heartbeatAt: 99 })] }),
    false,
  );
  assertEquals(loads, 1, "a revision-only bump must not re-trigger loadThreads()");
  assertEquals(commits, 1);
  assertEquals(visible.map((row) => row.id), ["thread-owner-1"]);
  assertEquals(new Set(visible.map((row) => row.id)).size, visible.length);
});

Deno.test("task sidebar: a thread-visible change (taskPreview, phase, terminal) re-renders", async () => {
  const authority = { threads: [{ id: "thread-owner-1", name: "One task" }] };
  let commits = 0;
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: async () => authority,
    commitThreads: () => { commits += 1; },
  });

  assertEquals(await lifecycle.onRunSnapshot({ runs: [runningRun(1)] }), true);
  assertEquals(
    await lifecycle.onRunSnapshot({ runs: [runningRun(2, { taskPreview: "drafting the doc" })] }),
    true,
  );
  assertEquals(
    await lifecycle.onRunSnapshot({ runs: [runningRun(3, { phase: "terminal", terminal: { ok: true, summary: "done" } })] }),
    true,
  );
  assertEquals(
    await lifecycle.onRunSnapshot({ runs: [runningRun(4, { phase: "terminal", terminal: { ok: true, summary: "done — revised" } })] }),
    true,
  );
  assertEquals(commits, 4, "each thread-visible change is rendered exactly once");
});

Deno.test("task sidebar: a threadless failed dispatch moves the observed signature (failed-runs visibility)", async () => {
  let loads = 0;
  let commits = 0;
  const lifecycle = createTaskSidebarLifecycle({
    loadThreads: async () => {
      loads += 1;
      return { threads: [] };
    },
    commitThreads: () => { commits += 1; },
  });
  const dispatch = (revision, phase, terminal = null) => ({
    executionId: "exec:dispatch-less-1",
    threadId: null,
    revision,
    phase,
    ...(terminal ? { terminal } : {}),
  });

  // A dispatch failure has no thread — no ROW changes, but the sections that
  // project run state (failed runs) still need the render it triggers.
  assertEquals(await lifecycle.onRunSnapshot({ runs: [dispatch(1, "terminal", { ok: false })] }), true);
  assertEquals(await lifecycle.onRunSnapshot({ runs: [dispatch(1, "terminal", { ok: false })] }), false);
  assertEquals(loads, 1, "the same terminal dispatch is consumed once");
  assertEquals(commits, 1);
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
  assertStringIncludes(source, 'open.addEventListener("click", () => openThread(t.id))');
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

// ── acceptance 2a: the renderTaskRows unchanged-digest fast path ─────────────
// The digest is what decides "these rows would render byte-identically, only
// the activeId highlight moved" (openThread / route changes) — the half of the
// hydration storm that survived the lifecycle fix: every render used to rebuild
// the whole sidebar DOM and re-fetch the failed-runs + board sections.

const digestThread = (over = {}) => ({
  id: "thread-1",
  name: "Write the brief",
  preview: "drafting…",
  updatedAt: Date.now(),
  ...over,
});

Deno.test("thread rows digest: identical lists produce identical digests", () => {
  assertEquals(threadRowsDigest([digestThread()], () => "running"), threadRowsDigest([digestThread()], () => "running"));
  assertEquals(threadRowsDigest([], () => ""), "");
});

Deno.test("thread rows digest: every rendered field is captured (id, name, preview, time bucket, dot)", () => {
  const now = Date.now();
  const base = threadRowsDigest([digestThread()], () => "running");
  assert(threadRowsDigest([digestThread({ id: "thread-2" })], () => "running") !== base);
  assert(threadRowsDigest([digestThread({ name: "Rename" })], () => "running") !== base);
  assert(threadRowsDigest([digestThread({ preview: "second draft" })], () => "running") !== base);
  // 120s old renders "2m ago" while `now` renders "just now" — a re-render
  // minutes later must not read as unchanged.
  assert(threadRowsDigest([digestThread({ updatedAt: now - 120_000 })], () => "running") !== base);
  assert(threadRowsDigest([digestThread()], () => "failed") !== base, "a run-phase dot change is a row change");
});

Deno.test("thread rows digest: row order and the 40-row render bound are honored", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => digestThread({ id: `t-${i}` }));
  assertEquals(
    threadRowsDigest(many(41), () => ""),
    threadRowsDigest(many(41).map((t, i) => (i === 40 ? { ...t, id: "t-INVISIBLE" } : t)), () => ""),
    "the 41st thread does not render, so it cannot change the digest",
  );
  assert(
    threadRowsDigest([digestThread({ id: "a" }), digestThread({ id: "b" })], () => "")
      !== threadRowsDigest([digestThread({ id: "b" }), digestThread({ id: "a" })], () => ""),
    "a reordered list renders different rows",
  );
});

Deno.test("thread rows digest: malformed input never throws", () => {
  assertEquals(threadRowsDigest(null), "");
  assertEquals(threadRowsDigest(undefined), "");
  assertEquals(
    threadRowsDigest([null, {}, digestThread()], () => ""),
    threadRowsDigest([null, {}, digestThread()], () => ""),
  );
});

Deno.test("ntp wiring: renderTaskRows gates the DOM rebuild and section re-fetches on the digest", async () => {
  const source = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));

  assertStringIncludes(source, "const digest = threadRowsDigest(threads, (t) => sidebarDotState(t));");
  // The gate itself: unchanged digest + not run-driven → the in-place path.
  assertStringIncludes(source, "meta?.runsChanged !== true && lastThreadRowsDigest === digest && el.children.length");
  assertStringIncludes(source, 'span.end("unchanged");');

  // ORDER: the digest gate sits inside renderTaskRows BEFORE the unconditional
  // rebuild + section re-fetches it exists to skip.
  const fnStart = source.indexOf("function renderTaskRows(");
  assert(fnStart >= 0, "renderTaskRows exists");
  const fnEnd = source.indexOf("\nfunction ", fnStart + 1);
  const body = source.slice(fnStart, fnEnd);
  const gate = body.indexOf("lastThreadRowsDigest === digest");
  const rebuild = body.indexOf("el.replaceChildren()");
  const failedRuns = body.indexOf("refreshFailedRuns();");
  const board = body.indexOf("refreshBoard();");
  const highlight = body.indexOf("highlightTaskSidebarRow(activeId);");
  assert(gate >= 0 && gate < rebuild, "the digest gate precedes the DOM rebuild");
  assert(gate < failedRuns && gate < board, "the digest gate precedes the section re-fetches");
  assert(highlight > gate, "the unchanged path updates aria-current in place");
});

Deno.test("ntp wiring: openThread answers the click before the thread.get read", async () => {
  const source = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const start = source.indexOf("async function openThread(id)");
  assert(start >= 0, "openThread exists");
  const end = source.indexOf("let liveTitleThreadId", start);
  const body = source.slice(start, end);

  const read = body.indexOf('await send("thread.get"');
  assert(read >= 0, "openThread reads the thread");
  assert(body.indexOf("showThreadView();") >= 0 && body.indexOf("showThreadView();") < read,
    "the view switches BEFORE the asynchronous read");
  assert(body.indexOf("highlightTaskSidebarRow(id);") < read,
    "the sidebar highlight moves BEFORE the asynchronous read");
  assert(body.indexOf("Loading task…") < read,
    "a loading state is set BEFORE the asynchronous read");
  assertStringIncludes(body, 'threadConversation?.setLiveStatus?.({ state: "running", activity: "Loading task…" });');
});
