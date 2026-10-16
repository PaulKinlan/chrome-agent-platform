// tests/heavy-gate-slot-static.test.ts — chrome-agent-platform-uvo3.
//
// The STATIC half of tests/heavy-gate-slot.test.ts, split out by the existing remedy for a mixed file:
// that file is a 15-test harness for the heavy-gate slot and SPAWNS processes to take and hold the
// slot, so it fails the host-independent and cost-budgeted criteria an always-on entry must meet (the
// qepn/3bv7/j3o1 lesson). The one invariant there that reads tracked source as data — the registry's
// loadSensitive set must be exactly the set of sources that take the fleet-wide slot — lives here,
// where it spawns nothing and only reads scripts/*.ts and the registry.
//
// It has no import edge to what it inspects, so it is registered in SOURCE_INSPECTING_GUARDS (part of
// ALWAYS_ON) in scripts/select-tests.mjs. Do not fold it back into the spawning harness.
// @ts-nocheck
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("0lj3: the fleet slot is PAIRED with the load-sensitive declaration, both directions", async () => {
  // A declaration nobody honours is worse than none: the harness that says "my
  // reds are environmental" (registry `loadSensitive`) is exactly the one that
  // must take turns, and a harness that did not declare itself must NOT hold the
  // fleet-wide slot. Same shape as the mkax guard for requireQuiet.
  const { HARNESSES } = await import("../scripts/lib/harness-registry.ts");
  const declared = Object.entries(HARNESSES)
    .filter(([, entry]) => entry.loadSensitive !== undefined)
    .map(([file]) => file)
    .sort();
  assert(declared.length >= 1, "at least one harness declares itself load-sensitive");

  const taking = (await Promise.all(
    [...Deno.readDirSync(`${ROOT}scripts`)]
      .filter((e) => e.isFile && e.name.endsWith(".ts"))
      .map(async (e) => ({ name: e.name, src: await Deno.readTextFile(`${ROOT}scripts/${e.name}`) })),
  )).filter((f) => /fleetSlot:\s*(true|\{)/u.test(f.src)).map((f) => f.name).sort();

  assertEquals(
    taking,
    declared,
    "the registry's loadSensitive set and the sources that take the fleet-wide slot must be the SAME set",
  );
  // The batch runner takes one turn for many browsers, so it is named here even
  // though it is not a `loadSensitive` harness itself (it launches no browser of
  // its own — its KATs do).
  const katRunner = await Deno.readTextFile(`${ROOT}scripts/kat-runner.ts`);
  assert(/acquireHeavyGateSlot\(\{\s*gate:\s*"kat-runner"/u.test(katRunner), "the KAT batch takes the fleet-wide turn for the whole run");
});
