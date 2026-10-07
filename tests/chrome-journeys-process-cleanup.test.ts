// The long Chrome journey used to kill only the Chrome parent + processes whose
// argv contained its profile. Crashpad sidecars need the isolated group owned
// by launchChrome; exercise this journey's actual cleanup seam without starting
// a browser or importing chrome-journeys.ts (which starts one on import).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));
const start = source.indexOf("async function teardownJourneyChrome(");
const end = source.indexOf("\nawait main();", start);
assert(start >= 0 && end > start, "find the journey's real cleanup function");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function build(teardownChrome: (proc: unknown, profile: string) => Promise<void>) {
  const fn = new AsyncFunction("teardownChrome", `${source.slice(start, end)}\nreturn teardownJourneyChrome;`);
  return fn(teardownChrome) as Promise<(proc: unknown, profile: string) => Promise<void>>;
}

Deno.test("g599r: all three journey finalizers use the group-aware cleanup seam", () => {
  const sites = [...source.matchAll(/if\s*\(proc\)\s*await\s+teardownJourneyChrome\(proc,\s*profile\);\s*else\s+await\s+runBounded\(RM,\s*\["-rf",\s*profile\]\);/g)];
  assertEquals(sites.length, 3, "main, demo-path and factory-reset use shared teardown; rm only if Chrome never spawned");
  assert(!source.includes("async function killChromiumTree("), "do not restore the parent-only pkill helper");
  // Crashpad double-forks out of Chrome's group in CfT 155 even with
  // --disable-crash-reporter. Reaper ownership of that helper is a fleet gate,
  // not proof this group/profile-scoped teardown can kill it.
});

Deno.test("g599r: journey cleanup awaits the exact proc/profile in shared group-aware teardown", async () => {
  const proc = { pid: 24123 };
  const profile = "/home/exedev/.cache/cap-review/g599r-cleanup-fixture";
  const calls: unknown[][] = [];
  const cleanup = await build(async (...args: unknown[]) => { calls.push(args); });
  await cleanup(proc, profile);
  assertEquals(calls, [[proc, profile]]);
});

Deno.test("g599r: group cleanup failure propagates rather than crediting a clean shutdown", async () => {
  const cleanup = await build(async () => { throw new Error("group-survivor"); });
  await assertRejects(() => cleanup({ pid: 24123 }, "/home/exedev/.cache/cap-review/g599r-cleanup-fixture"), Error, "group-survivor");
});
