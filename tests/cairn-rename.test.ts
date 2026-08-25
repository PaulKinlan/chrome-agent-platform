// @ts-nocheck
// Cairn-rename KATs (owner: "cairn was a different project, don't use that name"):
// (1) no "cairn" identifier remains ANYWHERE in shipped code or tests except the
//     immutable legacy usage-storage key (documented migration source);
// (2) every cross-file bridge identifier moved TOGETHER (channel, auth global,
//     bootstrap hooks) — a partial rename breaks the bridge silently;
// (3) the legacy "cairn:usage" key is still the migration read-source (no orphan).
import { assert, assertEquals } from "jsr:@std/assert@1";

const SHIPPED_AND_TESTS = [
  "../extension/content/main-world.js",
  "../extension/content/bridge-auth.js",
  "../extension/content/content-script.js",
  "../extension/background/service-worker.js",
  "../extension/lib/enrollment.js",
  "../extension/lib/usage-store.js",
  "webmcp-discovery.test.ts",
  "webmcp-status.test.ts",
  "bridge-auth.test.ts",
  "usage-authority.test.ts",
];

Deno.test("rename: no cairn identifier remains except the immutable legacy usage key", async () => {
  for (const rel of SHIPPED_AND_TESTS) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    const hits = (src.match(/cairn/gi) ?? []).length;
    if (rel.endsWith("usage-store.js")) {
      assertEquals(hits, 2, "usage-store keeps ONLY the legacy key + its documentation comment");
      assert(src.includes('LEGACY_STORAGE_KEY = "cairn:usage"'), "the legacy key string is preserved as the migration source");
      assert(src.includes("IMMUTABLE LEGACY MIGRATION SOURCE"), "the keep-decision is documented at the key");
    } else if (rel.endsWith("usage-authority.test.ts")) {
      // The migration fixtures seed the legacy key by its literal name — allowed.
      for (const line of src.split("\n")) {
        if (/cairn/i.test(line)) assert(line.includes('"cairn:usage"'), `only the legacy key literal may reference cairn: ${line.trim()}`);
      }
    } else {
      assertEquals(hits, 0, `${rel} must be cairn-free`);
    }
  }
});

Deno.test("rename: the cross-file bridge identifiers moved together (consistency pins)", async () => {
  const mainWorld = await Deno.readTextFile(new URL("../extension/content/main-world.js", import.meta.url));
  const bridgeAuth = await Deno.readTextFile(new URL("../extension/content/bridge-auth.js", import.meta.url));
  const contentScript = await Deno.readTextFile(new URL("../extension/content/content-script.js", import.meta.url));
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));

  // The MAC'd channel name must be IDENTICAL in both worlds (a mismatch = a
  // silent bridge break that no type-checker catches). content-script and
  // main-world hold it as a CHANNEL string; bridge-auth destructures the field.
  assert(mainWorld.includes('"__cap_bridge"') && contentScript.includes('"__cap_bridge"'), "both worlds use the renamed channel string");
  assert(bridgeAuth.includes("__cap_bridge"), "bridge-auth routes the renamed channel field");
  for (const [label, src] of [["main-world", mainWorld], ["bridge-auth", bridgeAuth], ["content-script", contentScript]]) {
    assert(!src.includes("__cairn_bridge"), `${label} has no stale channel`);
  }
  // The auth global: installed by bridge-auth, consumed by both worlds.
  assert(bridgeAuth.includes("globalThis.CapBridgeAuth"), "bridge-auth installs the renamed global");
  assert(mainWorld.includes("globalThis.CapBridgeAuth") && contentScript.includes("globalThis.CapBridgeAuth"), "both worlds consume it");
  // The bootstrap hook + pending-bootstrap handoff between the SW and main-world.
  assert(sw.includes("__capMainWorldBootstrap") && mainWorld.includes("__capMainWorldBootstrap"), "bootstrap hook consistent");
  assert(sw.includes("capMainWorldPendingBootstrap") && mainWorld.includes("capMainWorldPendingBootstrap"), "pending-bootstrap handoff consistent");
  // The guards.
  assert(mainWorld.includes('"__capMainWorldBridge"'), "main-world guard renamed");
  assert(contentScript.includes('"__capIsolatedBridge"'), "isolated guard renamed");
  assert(mainWorld.includes("__capInternal") && mainWorld.includes("__capHook"), "internal markers renamed");
});

Deno.test("rename: the legacy usage key still migrates (no orphaned data)", async () => {
  const store = await Deno.readTextFile(new URL("../extension/lib/usage-store.js", import.meta.url));
  // The migration reads the legacy key and removes it after draining — both
  // operations must reference the SAME preserved constant.
  assert(store.includes("kvGet(LEGACY_STORAGE_KEY)"), "migration reads the legacy key");
  assert(store.includes("kvRemove(LEGACY_STORAGE_KEY)"), "migration drains the legacy key after success");
});
