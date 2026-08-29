// task-lifecycle-contract.test.ts — source-level pins for
// docs/TASK-LIFECYCLE-CONTRACT.md (the live-browser contract KAT is
// scripts/kat-task-lifecycle.ts; this file makes the invariants cheap to
// check on every suite run).
import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const ntp = await Deno.readTextFile(
  new URL("../extension/ntp/ntp.js", import.meta.url),
);
const sw = await Deno.readTextFile(
  new URL("../extension/background/service-worker.js", import.meta.url),
);
const manifest = JSON.parse(
  await Deno.readTextFile(new URL("../extension/manifest.json", import.meta.url)),
);

Deno.test("contract §2: the hub composer continues an open task view (no silent fork — mentions included)", () => {
  assertStringIncludes(
    ntp,
    "if (!threadView.hidden && currentThreadId) {",
    "the hub-composer continuation guard is present and has NO mention exclusion",
  );
  // Falsification for the review P1-b fix: the old guard excluded agent?.ref,
  // so an @mention while a task view was open silently forked a new task.
  assert(
    !ntp.includes("currentThreadId && !agent?.ref"),
    "the mention exclusion must be gone — a mention continues the open thread",
  );
  assertStringIncludes(
    ntp,
    "agent?.ref ? { kind: agent.kind, id: agent.id, name: agent.name } : null",
    "the mention rides the continuation as a delegation (same shape as the new-task path)",
  );
});

Deno.test("contract §2: the thread composer always continues (never nulls the thread)", () => {
  const handler = ntp.slice(ntp.indexOf('threadComposer.addEventListener("send"'));
  const body = handler.slice(0, handler.indexOf("});"));
  assert(!body.includes("currentThreadId = null"), "the thread composer must not reset the thread");
});

Deno.test("contract §7: the orphaned-alarm cleanup route + UI affordance exist", () => {
  assertStringIncludes(sw, 'async "schedule.cancelOrphans"()');
  assertStringIncludes(sw, 'cancelled.push(t.name)');
  assertStringIncludes(ntp, "Cancel orphaned alarms");
});

Deno.test("contract: host access stays permanent while only bookmark/history reads are optional", () => {
  assert((manifest.host_permissions ?? []).includes("<all_urls>"));
  assert(
    JSON.stringify([...(manifest.optional_permissions ?? [])].sort()) === JSON.stringify(["bookmarks", "history"]),
    "only bookmarks/history may be optional in this lane",
  );
});
