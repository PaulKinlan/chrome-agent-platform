// tests/agent-edit-partial-save.test.ts
// Regression tests for chrome-agent-platform-9gn7:
// [CAP-FB-20260908-AGENT-PARTIAL-SAVE-01] Agent Save reports persona failure as success and Settings approval.
//
// Tests the REAL production helper extension/lib/agent-config-save.js (resolveAgentSaveResult),
// which openAgentConfig in ntp.js uses to decide save outcomes.
//
// When a schedule update succeeds but named-agent.update fails, resolveAgentSaveResult
// must NOT return { ok: true } and must NOT claim Settings approval is needed.
// It must return ok: false with an honest composite error preserving both the partial
// schedule success and the actual persona failure reason.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { resolveAgentSaveResult } from "../extension/lib/agent-config-save.js";

Deno.test("9gn7 source pin: ntp.js uses resolveAgentSaveResult; does not claim false Settings approval", async () => {
  const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(
    ntpJs.includes("resolveAgentSaveResult({ scheduleNote, updateResult: r })"),
    "ntp.js openAgentConfig must resolve save outcomes through resolveAgentSaveResult",
  );
  assert(
    !ntpJs.includes("the persona edit needs approval in Settings"),
    "ntp.js must NOT claim persona edit needs approval in Settings on partial schedule save",
  );
  assert(
    !ntpJs.includes("{ ok: true, note: `${scheduleNote}; the persona edit needs approval in Settings` }"),
    "ntp.js must NOT return { ok: true } when persona update fails after schedule succeeds",
  );
});

Deno.test("9gn7 production helper: schedule succeeds but persona update fails returns ok:false with honest error", () => {
  const res = resolveAgentSaveResult({
    scheduleNote: "scheduled every 30 min",
    updateResult: { ok: false, error: "an agent needs a name" },
  });

  assertEquals(res.ok, false, "Must report ok:false when persona update fails");
  assertEquals(
    res.error,
    "scheduled every 30 min, but persona update failed: an agent needs a name",
    "Must preserve schedule note and concrete persona failure reason",
  );
  assert(!res.error?.includes("needs approval in Settings"), "Must not claim false Settings approval");
});

Deno.test("9gn7 production helper: unchanged schedule and failing persona update returns persona error directly", () => {
  const res = resolveAgentSaveResult({
    scheduleNote: "",
    updateResult: { ok: false, error: "role too long (500 > 300)" },
  });

  assertEquals(res.ok, false);
  assertEquals(res.error, "role too long (500 > 300)");
});

Deno.test("9gn7 production helper: successful persona update with schedule note preserves note under ok:true", () => {
  const res = resolveAgentSaveResult({
    scheduleNote: "scheduled every 15 min",
    updateResult: { ok: true },
  });

  assertEquals(res.ok, true);
  assertEquals(res.note, "scheduled every 15 min");
});

Deno.test("9gn7 production helper: successful persona update without schedule change returns plain ok:true", () => {
  const res = resolveAgentSaveResult({
    scheduleNote: "",
    updateResult: { ok: true },
  });

  assertEquals(res.ok, true);
  assertEquals(res.note, undefined);
  assertEquals(res.error, undefined);
});

Deno.test("9gn7 production helper: null or missing updateResult fails closed honestly", () => {
  const withSched = resolveAgentSaveResult({
    scheduleNote: "schedule removed",
    updateResult: null,
  });
  assertEquals(withSched.ok, false);
  assertEquals(withSched.error, "schedule removed, but persona update failed: unknown");

  const withoutSched = resolveAgentSaveResult({
    scheduleNote: "",
    updateResult: null,
  });
  assertEquals(withoutSched.ok, false);
  assertEquals(withoutSched.error, "unknown");
});
