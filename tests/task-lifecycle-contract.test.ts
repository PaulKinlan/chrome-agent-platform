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

Deno.test("contract §2: the hub composer continues an open task view (no silent fork)", () => {
  assertStringIncludes(
    ntp,
    "if (!threadView.hidden && currentThreadId && !agent?.ref) {",
    "the hub-composer continuation guard is present",
  );
});

Deno.test("contract §2: the thread composer always continues (never nulls the thread)", () => {
  const handler = ntp.slice(ntp.indexOf('threadComposer.addEventListener("send"'));
  const body = handler.slice(0, handler.indexOf("});"));
  assert(!body.includes("currentThreadId = null"), "the thread composer must not reset the thread");
});

Deno.test("contract §6: the orphaned-alarm cleanup route + UI affordance exist", () => {
  assertStringIncludes(sw, 'async "schedule.cancelOrphans"()');
  assertStringIncludes(sw, 'cancelled.push(t.name)');
  assertStringIncludes(ntp, "Cancel orphaned alarms");
});

Deno.test("contract: host access is permanent (<all_urls> install-granted)", () => {
  assert((manifest.host_permissions ?? []).includes("<all_urls>"));
  assertEqualsOptionalEmpty(manifest.optional_permissions);
});

function assertEqualsOptionalEmpty(v: unknown) {
  assert(
    v === undefined || (Array.isArray(v) && v.length === 0),
    "optional_permissions must be absent or empty — permissions are granted at install",
  );
}
