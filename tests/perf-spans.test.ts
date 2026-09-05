// @ts-nocheck
// tests/perf-spans.test.ts — pure test on the hub's span names and dumpTrace merge helper.
// CAP-FB-20260830-SEEDED-PROFILE-GATES-01

import { assert, assertEquals } from "jsr:@std/assert@1";
import { NTP_PERF_SPANS, mergePerfMeasures } from "../extension/lib/cap-perf.js";

Deno.test("the hub's span names are a fixed list", () => {
  const expected = [
    "ntp:boot→composer-ready",
    "ntp:thread-list-hydrated",
    "ntp:agents-panel-hydrated",
    "ntp:artifacts-panel-hydrated",
    "ntp:send",
    "ntp:open_thread",
  ];
  assertEquals([...NTP_PERF_SPANS].sort(), [...expected].sort(), "NTP perf spans must match the fixed constitution list");
});

Deno.test("dumpTrace merges page measures into the perf summary", () => {
  const baseSummary = {
    measures: [
      { name: "thread.get:view", count: 2, totalMs: 80, avgMs: 40, maxMs: 45, lastMs: 45 },
      { name: "scheduler:task_fire", count: 1, totalMs: 20, avgMs: 20, maxMs: 20, lastMs: 20 },
    ],
    truncated: 0,
    generatedAt: new Date().toISOString(),
  };

  const pageMeasures = [
    { name: "ntp:boot→composer-ready", count: 1, totalMs: 110, avgMs: 110, maxMs: 110, lastMs: 110 },
    { name: "thread.get:view", count: 1, totalMs: 30, avgMs: 30, maxMs: 30, lastMs: 30 },
  ];

  const merged = mergePerfMeasures(baseSummary, pageMeasures);

  // Sorting check: highest totalMs first
  // ntp:boot→composer-ready (110)
  // thread.get:view (80 + 30 = 110)
  // scheduler:task_fire (20)
  assertEquals(merged.measures.length, 3);
  const threadView = merged.measures.find((m) => m.name === "thread.get:view");
  assert(threadView, "thread.get:view must exist in merged output");
  assertEquals(threadView.count, 3);
  assertEquals(threadView.totalMs, 110);
  assertEquals(threadView.avgMs, 36.7);
  assertEquals(threadView.maxMs, 45);

  const composerReady = merged.measures.find((m) => m.name === "ntp:boot→composer-ready");
  assert(composerReady, "ntp:boot→composer-ready must exist in merged output");
  assertEquals(composerReady.count, 1);
  assertEquals(composerReady.totalMs, 110);

  // Empty page measures preserves base
  const unchanged = mergePerfMeasures(baseSummary, []);
  assertEquals(unchanged.measures.length, 2);
  assertEquals(unchanged.measures[0].name, "thread.get:view");
});

Deno.test("seedGrantedPermissions writes granted_permissions to Preferences", async () => {
  const { seedGrantedPermissions, computeUnpackedExtensionId } = await import("../scripts/lib/chrome-launch.ts");
  const tempDir = await Deno.makeTempDir({ prefix: "test-prefs-" });
  try {
    const extId = await seedGrantedPermissions(tempDir, "extension", ["tabs", "notifications"]);
    assert(/^[a-p]{32}$/.test(extId), "extension ID must be 32 base16 characters");
    const prefs = JSON.parse(await Deno.readTextFile(`${tempDir}/Default/Preferences`));
    const setting = prefs.extensions.settings[extId];
    assert(setting, "extension setting must exist in Preferences");
    assertEquals(setting.granted_permissions.api, ["tabs", "notifications"]);
    assertEquals(setting.granted_permissions.explicit_host, ["<all_urls>"]);
    assertEquals(setting.active_permissions.api, ["tabs", "notifications"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
