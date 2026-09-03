// tests/lifecycle-cleanup.test.ts — falsification gates for
// chrome-agent-platform-4ffg (tab/window lifecycle cleanup).
//
// Gates (each must be able to go RED):
//  1. every lifecycle tool's DESCRIPTION carries cleanup guidance (walks the
//     LIFECYCLE_OPEN_TOOLS list against the real shipped toolset);
//  2. the run-end summary lists the ids of the tabs/windows the run opened
//     (pure runEndCleanupNote / appendRunEndCleanupNote);
//  3. auto-close plans EXACTLY the run's still-open opened tabs and nothing
//     else (autoCloseTabPlan) — and the tracker never leaks across runs.
// @ts-nocheck — tool maps/metadata.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { browserToolset } from "../extension/lib/browser-tools.js";
import {
  LIFECYCLE_OPEN_TOOLS,
  LIFECYCLE_RELEASE_TOOLS,
  cleanupGuidanceFor,
  lifecycleIdsInResult,
  createLifecycleTracker,
  autoCloseTabPlan,
  runEndCleanupNote,
  appendRunEndCleanupNote,
} from "../extension/lib/lifecycle-cleanup.js";

// ── Gate 1: description cleanup guidance on every lifecycle tool ───────────
Deno.test("4ffg: every lifecycle tool description carries cleanup guidance", () => {
  const names = Object.keys(LIFECYCLE_OPEN_TOOLS);
  assert(names.length >= 4, `lifecycle list must cover open_tab/duplicate_tab/create_window/restore_closed (${names.join(", ")})`);
  const toolset = browserToolset(false);
  for (const name of names) {
    const def = toolset[name];
    assert(def, `${name} must exist in browserToolset()`);
    assert(typeof def.description === "string" && def.description.length > 0, `${name} has a description`);
    assertStringIncludes(def.description, "Cleanup:", `${name} description must carry the Cleanup marker`);
    assertStringIncludes(def.description.toLowerCase(), "close", `${name} description must tell the model to close what it no longer needs`);
    assertStringIncludes(def.description, "deliberate choice", `${name} description must say leaving something open is a deliberate choice`);
  }
});

Deno.test("4ffg: cleanup guidance is single-sourced per lifecycle tool", () => {
  for (const name of Object.keys(LIFECYCLE_OPEN_TOOLS)) {
    const guidance = cleanupGuidanceFor(name);
    assert(guidance && guidance.includes("Cleanup:"), `${name} has guidance text`);
    assertStringIncludes(guidance.toLowerCase(), "close", `${name} guidance mentions closing`);
    assertStringIncludes(guidance, "deliberate choice", `${name} guidance mentions deliberate choice`);
  }
  assertEquals(cleanupGuidanceFor("list_tabs"), null, "non-lifecycle tools have no lifecycle guidance");
});

// ── Gate 2: the run-end summary lists the run's opened ids ─────────────────
Deno.test("4ffg: run-end cleanup note lists the tabs/windows the run opened", () => {
  const note = runEndCleanupNote({
    openedTabs: [{ id: 104 }, { id: 105 }],
    openedWindows: [{ id: 3 }],
    closedTabIds: [],
    closedWindowIds: [],
    restoredSessions: 0,
  });
  assert(note, "a run that opened tabs must produce a note");
  assertStringIncludes(note, "#104", "note lists opened tab 104");
  assertStringIncludes(note, "#105", "note lists opened tab 105");
  assertStringIncludes(note, "#3", "note lists opened window 3");
  assertStringIncludes(note, "2 still open", "note states what is still open");
});

Deno.test("4ffg: appendRunEndCleanupNote rides the run's final summary text", () => {
  const out = appendRunEndCleanupNote("Done.", {
    openedTabs: [{ id: 12 }],
    openedWindows: [],
    closedTabIds: [],
    closedWindowIds: [],
    restoredSessions: 0,
  }, []);
  assertStringIncludes(out, "Done.", "the model's own summary stays intact");
  assertStringIncludes(out, "#12", "the appended runtime note names the opened tab id");
  // Clean runs stay quiet — nothing appended when nothing is left open.
  const quiet = appendRunEndCleanupNote("Done.", {
    openedTabs: [],
    openedWindows: [],
    closedTabIds: [],
    closedWindowIds: [],
    restoredSessions: 0,
  }, []);
  assertEquals(quiet, "Done.");
  // A tab the run already closed itself is not re-listed as left open (the
  // tracker removes released ids from openedTabs — this snapshot is what it
  // reports after a close_tab of its own tab).
  const selfClosed = appendRunEndCleanupNote("Done.", {
    openedTabs: [],
    openedWindows: [],
    closedTabIds: [7],
    closedWindowIds: [],
    restoredSessions: 0,
  }, []);
  assertEquals(selfClosed, "Done.", "a run that closed its own tabs has nothing left to tidy");
});

// ── Gate 3: auto-close closes exactly the run's tabs ───────────────────────
Deno.test("4ffg: auto-close plan is exactly the run's still-open opened tabs — nothing else", () => {
  const plan = autoCloseTabPlan({
    openedTabs: [{ id: 12 }, { id: 13 }, { id: 14 }],
    openedWindows: [],
    closedTabIds: [13], // the run already closed 13 itself
    closedWindowIds: [],
    restoredSessions: 0,
  });
  assertEquals([...plan].sort((a, b) => a - b), [12, 14],
    "plan = opened minus run-closed; a foreign tab id can never enter it");
  // A foreign tab (999) is not in the plan even when present in the world.
  const plan2 = autoCloseTabPlan({ openedTabs: [{ id: 12 }], openedWindows: [], closedTabIds: [], closedWindowIds: [], restoredSessions: 0 });
  assertEquals(plan2, [12]);
  assertEquals(autoCloseTabPlan({ openedTabs: [], openedWindows: [], closedTabIds: [], closedWindowIds: [], restoredSessions: 0 }), []);
});

Deno.test("4ffg: run-end note reports auto-closed ids instead of telling the user to close them", () => {
  const note = runEndCleanupNote({
    openedTabs: [{ id: 20 }, { id: 21 }],
    openedWindows: [],
    closedTabIds: [],
    closedWindowIds: [],
    restoredSessions: 0,
  }, [20]);
  assertStringIncludes(note, "#20");
  assertStringIncludes(note, "auto-closed", "the note says tab 20 was auto-closed");
  assertStringIncludes(note, "1 still open", "only the non-auto-closed tab stays listed as open");
});

// ── tracker accounting (feeds gates 2 + 3 in the real run) ─────────────────
Deno.test("4ffg: tracker records opens and releases exactly per run", () => {
  const t = createLifecycleTracker();
  t.onToolResult("open_tab", true, JSON.stringify({ ok: true, tabId: 1, url: "https://a.example" }));
  t.onToolResult("duplicate_tab", true, JSON.stringify({ ok: true, tabId: 1, newTabId: 2 }));
  t.onToolResult("create_window", true, JSON.stringify({ ok: true, windowId: 9 }));
  t.onToolResult("restore_closed", true, JSON.stringify({ ok: true, sessionId: "s1", kind: "tab" }));
  // A failed open never counts; an unrelated tool never counts.
  t.onToolResult("open_tab", false, JSON.stringify({ ok: false, error: "nope" }));
  t.onToolResult("navigate_tab", true, JSON.stringify({ ok: true, tabId: 999, url: "https://x.example" }));

  let s = t.snapshot();
  assertEquals(s.openedTabs.map((x) => x.id).sort(), [1, 2], "open + duplicate tracked");
  assertEquals(s.openedWindows.map((x) => x.id), [9]);
  assertEquals(s.restoredSessions, 1);
  assertEquals(autoCloseTabPlan(s).sort(), [1, 2], "tabs auto-closeable; window + restored session are not");

  // The run closes its own tab → released from the still-open set.
  t.onToolResult("close_tab", true, JSON.stringify({ ok: true, tabId: 1 }));
  t.onToolResult("close_window", true, JSON.stringify({ ok: true, windowId: 9 }));
  s = t.snapshot();
  assertEquals(s.openedTabs.map((x) => x.id), [2], "closed tab no longer open");
  assertEquals(s.openedWindows, [], "closed window no longer open");
  assertEquals(autoCloseTabPlan(s), [2], "auto-close never re-closes what the run closed");
});

Deno.test("4ffg: trackers are per-run — one run's opens never leak into another", () => {
  const runA = createLifecycleTracker();
  const runB = createLifecycleTracker();
  runA.onToolResult("open_tab", true, JSON.stringify({ ok: true, tabId: 111 }));
  assertEquals(runB.snapshot().openedTabs, [], "a fresh run starts with nothing opened");
  assertEquals(runB.snapshot().closedTabIds, []);
  assertEquals(autoCloseTabPlan(runA.snapshot()), [111]);
  assertEquals(autoCloseTabPlan(runB.snapshot()), []);
});

// ── id extraction tolerance ─────────────────────────────────────────────────
Deno.test("4ffg: lifecycleIdsInResult reads top-level ids and lazy envelopes, never nested echoes", () => {
  assertEquals(lifecycleIdsInResult({ ok: true, tabId: 4 }), { tabIds: [4], windowIds: [] });
  assertEquals(lifecycleIdsInResult({ ok: true, newTabId: 5 }), { tabIds: [5], windowIds: [] });
  assertEquals(lifecycleIdsInResult({ ok: true, windowId: 7 }), { tabIds: [], windowIds: [7] });
  assertEquals(lifecycleIdsInResult('{"ok":true,"tabId":8}'), { tabIds: [8], windowIds: [] });
  // A lazy envelope nests the real result one level down.
  assertEquals(lifecycleIdsInResult({ ok: true, selectedTool: "open_tab", result: { ok: true, tabId: 9 } }), { tabIds: [9], windowIds: [] });
  // Plain text and unrelated shapes carry no ids.
  assertEquals(lifecycleIdsInResult("opened https://a.example"), { tabIds: [], windowIds: [] });
  assertEquals(lifecycleIdsInResult(null), { tabIds: [], windowIds: [] });
  // Release-tool refs are the same ids.
  assertEquals(lifecycleIdsInResult({ ok: true, tabId: 12 }), { tabIds: [12], windowIds: [] });
});

// ── the release-tool table stays aligned with reality ──────────────────────
Deno.test("4ffg: release tools exist in the shipped toolset", () => {
  const toolset = browserToolset(false);
  for (const name of Object.keys(LIFECYCLE_RELEASE_TOOLS)) {
    assert(toolset[name], `${name} must exist in browserToolset()`);
  }
  assertEquals(Object.keys(LIFECYCLE_RELEASE_TOOLS).sort(), ["close_tab", "close_window"]);
});
