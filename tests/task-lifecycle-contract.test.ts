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
  assertStringIncludes(ntp, "Stop schedules for deleted agents");
});

Deno.test("contract: host access is permanent and capability permissions are OPTIONAL (JIT)", () => {
  assert((manifest.host_permissions ?? []).includes("<all_urls>"));
  const required = manifest.permissions ?? [];
  assert(required.includes("storage"), "storage stays mandatory");
  assert(required.includes("alarms"), "alarms stays mandatory");
  assert(required.includes("sidePanel"), "sidePanel stays mandatory");
  assert(required.includes("offscreen"), "offscreen stays mandatory");
  const optional = manifest.optional_permissions ?? [];
  assert(optional.includes("bookmarks"), "bookmarks is optional (JIT)");
  assert(optional.includes("history"), "history is optional (JIT)");
  for (const p of optional) assert(!required.includes(p), p + " appears in both lists");
  for (const p of required) assert(!optional.includes(p), p + " appears in both lists");
});
