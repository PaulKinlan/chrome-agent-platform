// tests/quiet-window-static.test.ts — the TRACKED-SOURCE half of chrome-agent-platform-mkax, split out
// by chrome-agent-platform-fgik so it can be an ALWAYS-ON guard.
//
// WHY A SPLIT: tests/quiet-window.test.ts belongs in the always-on set for THESE assertions — they read
// tracked source as data (the harness registry, scripts/, and the journey harness's exit wiring), which
// means they have no import edges and no subset gate can select them. But the same file also spawns REAL
// esbuild --minify processes as CPU burners, and it costs 23s under load — while the other thirty
// always-on guards together cost ~10-12s. Making a burner file always-on therefore triples every subset
// gate AND injects compiler load onto 2-vCPU lanes DURING other lanes' gates, which is worse than the
// seconds because our serial phase's red count tracks LOAD. Splitting keeps the tracked-source coverage
// always-on and leaves the burners to `npm test`.
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("mkax: load-sensitive harnesses DECLARE themselves, and the declaration is honoured in source", async () => {
  // Acceptance: gates declare themselves rather than being hardcoded in a
  // runner. A declaration nobody honours is worse than none, so both
  // directions are checked: registry → source, and source → registry.
  const { HARNESSES } = await import("../scripts/lib/harness-registry.ts");
  const declared = Object.entries(HARNESSES)
    .filter(([, entry]) => entry.loadSensitive !== undefined)
    .map(([file, entry]) => [file, entry.loadSensitive as string] as const);
  assert(declared.length >= 1, "at least one harness declares itself load-sensitive");

  const honouring: string[] = [];
  for (const entry of Deno.readDirSync(`${ROOT}scripts`)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = Deno.readTextFileSync(`${ROOT}scripts/${entry.name}`);
    if (/requireQuiet:\s*(true|\{)/u.test(src)) honouring.push(entry.name);
  }

  const declaredNames = declared.map(([file]) => file).sort();
  assertEquals(
    honouring.sort(),
    declaredNames,
    "the registry's loadSensitive set and the sources that pass requireQuiet must be the SAME set",
  );

  for (const [file, reason] of declared) {
    assert(reason.length > 40, `${file}: the declaration must carry its evidence, got "${reason}"`);
    const src = Deno.readTextFileSync(`${ROOT}scripts/${file}`);
    // The refusal must reach a THIRD exit code with the greppable marker, or an
    // aggregator cannot tell an environmental refusal from a product red.
    //
    // chrome-agent-platform-lrok: these three pins asserted the BARE WORDS, and each
    // word occurs in the target twice — once in the import block (chrome-journeys.ts
    // :34-36) and once in the handler (:136-139). Mutant W2 (census wzez) deleted the
    // whole five-line handler and left `throw e;` plus the imports: every token dropped
    // to a single occurrence, all three pins PASSED, and this test stayed green. The
    // kill came only from the executing gate below ("the REAL journey gate refuses with
    // exit 75 under artificial load") — the pins that named the property were the ones
    // that could not see it disappear. An import binding is not a handler, so each
    // property is now anchored INSIDE the handler: the typed catch, then the marker and
    // the exit code reached from it. Bounded so a marker printed in some unrelated
    // statement cannot satisfy it. The imports stay unpinned on purpose — provenance is
    // the module's job, and these three prove USE. Kept generic: the assertion runs once
    // per harness that declares itself load-sensitive, so it pins the declaration rule
    // and not today's single member (proven by mutant W4 on the bead).
    assert(
      /instanceof\s+QuietWindowRefusedError\s*\)/.test(src),
      `${file} must catch the refusal BY TYPE — an import binding is not a handler`,
    );
    assert(
      /instanceof\s+QuietWindowRefusedError\s*\)[\s\S]{0,400}?ENVIRONMENTAL_REFUSAL_MARKER/.test(src),
      `${file} must print the greppable marker from inside the refusal handler`,
    );
    assert(
      /instanceof\s+QuietWindowRefusedError\s*\)[\s\S]{0,400}?Deno\.exit\(\s*ENVIRONMENTAL_REFUSAL_EXIT\s*\)/.test(src),
      `${file} must exit with the environmental code from inside the refusal handler`,
    );
  }
});

Deno.test("mkax: no harness may quiet the box by interfering with other lanes", async () => {
  // The DO-NOT in the bead: measure and wait, or refuse. Never kill, renice, or
  // cgroup somebody else's build to manufacture a quiet window.
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/quiet-window.ts`);
  for (const forbidden of ["kill", "renice", "SIGKILL", "SIGTERM", "pkill", "killall", "ionice", "taskset"]) {
    const code = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    assertEquals(code.includes(forbidden), false, `quiet-window.ts must not ${forbidden} anything`);
  }
});

Deno.test("9t1p: the REAL harness routes its evaluate-timeout exit through the measured report", async () => {
  // A source pin would pass with the wiring removed, so this asserts the
  // STRUCTURE the harness must have: it measures at the catch, and its exit
  // site is the shared report rather than a hand-written marker line.
  const harness = await Deno.readTextFile(`${ROOT}scripts/chrome-journeys.ts`);
  const catchSite = harness.slice(harness.indexOf("if (isCdpEvaluateTimeout(String(e?.message ?? e)))"));
  assert(/measureEvaluateTimeout\(\)/.test(catchSite.slice(0, 1200)),
    "the catch must MEASURE the box, not assume load");
  assert(/evaluateTimeoutReport\(evaluateTimeoutVerdict\)/.test(harness),
    "the exit site must use the shared, tested decision");
  // The old fixed claim must be gone from the exit path entirely.
  assertEquals(harness.includes('{"reason":"cdp evaluate exceeded the budget under fleet load"}'), false,
    "the unconditional 'under fleet load' marker payload must not survive");
  // And the environmental exit must no longer be reachable without a verdict.
  assertEquals(/environmentalAbort/.test(harness), false,
    "the boolean that could not tell load from a hang is gone");
});
