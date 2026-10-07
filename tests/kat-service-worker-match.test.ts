// tests/kat-service-worker-match.test.ts — chrome-agent-platform-mzd6
//
// Background: Chrome for Testing ships component extensions with their own
// service workers (such as thunk.js). Previously, waitForServiceWorker in
// scripts/lib/chrome-launch.ts defaulted to the first target with
// `type === "service_worker"`. If a component worker registered first, a harness
// could attach to it, derive a bogus extension ID, and fail RPCs with
// `sendMessage undefined` as a fake product red.
//
// Bead mzd6 acceptance:
// 1. Hoist and export ONE SW_MATCH next to waitForServiceWorker in chrome-launch.ts.
// 2. Make SW_MATCH the default match filter for waitForServiceWorker so all
//    unfiltered callers use it.
// 3. One authority, not 35 ad-hoc copies across KAT harnesses.
// 4. Falsify it: demonstrate that without SW_MATCH, an earlier component worker
//    is picked (mis-attach), while SW_MATCH correctly skips it and targets our extension.
// 5. Ensure no script re-declares a private SW_MATCH.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { SW_MATCH, waitForServiceWorker } from "../scripts/lib/chrome-launch.ts";

const EXTENSION_SW = Object.freeze({
  targetId: "target-ext-sw",
  type: "service_worker",
  url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/dist/background/service-worker.js",
});

const THUNK_COMPONENT_SW = Object.freeze({
  targetId: "target-component-thunk",
  type: "service_worker",
  url: "chrome-extension://componentextensionthunkid/thunk.js",
});

const OTHER_EXTENSION_SW = Object.freeze({
  targetId: "target-other-sw",
  type: "service_worker",
  url: "chrome-extension://someotherextensionid/background.js",
});

const EXTENSION_PAGE = Object.freeze({
  targetId: "target-ntp-page",
  type: "page",
  url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/dist/background/service-worker.js",
});

Deno.test("SW_MATCH: accurately identifies our extension background service worker", () => {
  assertEquals(SW_MATCH(EXTENSION_SW), true, "must match extension service worker in dist/background");
});

Deno.test("SW_MATCH: rejects component extension workers and non-matching targets", () => {
  assertEquals(SW_MATCH(THUNK_COMPONENT_SW), false, "must reject component thunk.js worker");
  assertEquals(SW_MATCH(OTHER_EXTENSION_SW), false, "must reject non-dist/background worker");
  assertEquals(SW_MATCH(EXTENSION_PAGE), false, "must reject non-service-worker target type");
  assertEquals(SW_MATCH(null), false, "must handle null without throwing");
  assertEquals(SW_MATCH(undefined), false, "must handle undefined without throwing");
  assertEquals(SW_MATCH({}), false, "must handle empty object without throwing");
  assertEquals(SW_MATCH({ type: "service_worker" }), false, "must handle missing url");
});

Deno.test("waitForServiceWorker: defaults to SW_MATCH and selects our worker over earlier component worker", async () => {
  // Scenario: Chrome for Testing registers component thunk worker first (index 0),
  // then our extension worker (index 1).
  const targetInfos = [THUNK_COMPONENT_SW, EXTENSION_SW];
  const mockSend = async (method: string) => {
    assertEquals(method, "Target.getTargets");
    return { result: { targetInfos } };
  };

  // Calling without explicit match must select EXTENSION_SW by default.
  const target = await waitForServiceWorker(mockSend, { timeoutMs: 1000 });
  assertEquals(target?.targetId, EXTENSION_SW.targetId, "default waitForServiceWorker must select our extension worker");
  assertEquals(new URL(target.url).host, "abcdefghijklmnopabcdefghijklmnop", "must derive our extension ID");
});

Deno.test("waitForServiceWorker: FALSIFICATION — legacy unfiltered match mis-attaches to component worker", async () => {
  const targetInfos = [THUNK_COMPONENT_SW, EXTENSION_SW];
  const mockSend = async () => ({ result: { targetInfos } });

  // Simulate legacy pre-mzd6 unfiltered match:
  const legacyMatch = (t: any) => t.type === "service_worker";
  const misAttachedTarget = await waitForServiceWorker(mockSend, { timeoutMs: 1000, match: legacyMatch });

  // Falsification proof: the legacy match picks index 0 (thunk), deriving the wrong extension ID
  assertEquals(misAttachedTarget?.targetId, THUNK_COMPONENT_SW.targetId);
  const derivedId = new URL(misAttachedTarget.url).host;
  assertEquals(derivedId, "componentextensionthunkid", "legacy match mis-attaches to component worker ID");
  assert(derivedId !== "abcdefghijklmnopabcdefghijklmnop", "legacy match fails to identify our extension");
});

Deno.test("harness audit: no script declares a private SW_MATCH or inline thunk workarounds", async () => {
  const scriptsDir = new URL("../scripts/", import.meta.url);
  const offenders: string[] = [];

  for await (const entry of Deno.readDir(scriptsDir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, scriptsDir));
    // Check for local re-declarations of SW_MATCH
    if (/(?:const|let|var)\s+SW_MATCH\s*=/.test(text)) {
      offenders.push(`${entry.name}: declares private SW_MATCH`);
    }
    // Check for ad-hoc duplicate dist/background matches in waitForServiceWorker or cdp.serviceWorker
    if (/match:\s*\(.*?\)\s*=>.*?dist\/background/.test(text)) {
      offenders.push(`${entry.name}: uses ad-hoc inline dist/background match instead of shared SW_MATCH`);
    }
  }

  assertEquals(
    offenders,
    [],
    "all scripts must use the single exported SW_MATCH authority from lib/chrome-launch.ts:\n" + offenders.join("\n"),
  );
});

Deno.test("KAT callers enumeration: every KAT harness calling waitForServiceWorker/serviceWorker targets SW_MATCH", async () => {
  const scriptsDir = new URL("../scripts/", import.meta.url);
  const katFilesCallingSw: string[] = [];

  for await (const entry of Deno.readDir(scriptsDir)) {
    if (!entry.isFile || !entry.name.startsWith("kat-") || !entry.name.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, scriptsDir));
    if (text.includes("waitForServiceWorker(") || text.includes(".serviceWorker(")) {
      katFilesCallingSw.push(entry.name);
    }
  }

  // Exactly 49 KAT harnesses call waitForServiceWorker / cdp.serviceWorker,
  // including the rkrn sidebar-hydration browser acceptance moved out of tests/.
  assertEquals(katFilesCallingSw.length, 49, "all 49 KAT harnesses call waitForServiceWorker / cdp.serviceWorker");

  // Every one of them either relies on the SW_MATCH default or explicitly passes SW_MATCH
  for (const file of katFilesCallingSw) {
    const text = await Deno.readTextFile(new URL(file, scriptsDir));
    const matchUses = [...text.matchAll(/match:\s*([^\n,}]+)/g)];
    for (const m of matchUses) {
      assertEquals(
        m[1].trim(),
        "SW_MATCH",
        `${file} must use SW_MATCH when an explicit match is provided (got ${m[1]})`,
      );
    }
  }
});
