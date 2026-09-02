// CAP-FB-20260830-SUITE-HONESTY-01 — every browser harness sets a REAL exit
// code. A harness that prints "FAIL: …" and then exits 0 (or never calls
// Deno.exit at all and lets a rejected promise decide) turns a red run green
// the moment it is wired into an aggregate: `npm run test:all` only sees the
// exit status. `scripts/flake-evidence.ts` always exited 0; `panel-leak-probe`
// and `repro-recent-activity` set no code at all.
//
// The guard is a static scan: every harness the registry classes as a gate,
// a named script, or a KAT must contain a `Deno.exit(<expr>)` whose argument
// is NOT the literal 0 — i.e. an exit computed from the run's own failures.
import { assertEquals } from "jsr:@std/assert@1";
import { HARNESSES, harnessFiles } from "../scripts/lib/harness-registry.ts";

const SCRIPTS = new URL("../scripts/", import.meta.url).pathname;

/** True when the source carries an exit whose code is derived, not `0`. */
export function hasFailureDerivedExit(src: string): boolean {
  for (const m of src.matchAll(/Deno\.exit\(\s*([^)]*?)\s*\)/gs)) {
    const arg = m[1].trim();
    if (arg === "" || arg === "0") continue;
    return true;
  }
  return false;
}

Deno.test("every harness exits with a code derived from its own failures", () => {
  const offenders: string[] = [];
  const unexplained: string[] = [];
  for (const file of harnessFiles()) {
    const entry = HARNESSES[file];
    if (!entry || entry.class === "helper") continue;
    if (entry.noVerdict) {
      // A generator with nothing to assert may opt out, but only with a reason.
      if (!entry.noVerdict.trim()) unexplained.push(file);
      continue;
    }
    const src = Deno.readTextFileSync(`${SCRIPTS}${file}`);
    if (!hasFailureDerivedExit(src)) offenders.push(file);
  }
  assertEquals(
    offenders,
    [],
    `these harnesses never exit on their own failures (a red run reads as green to any aggregate):\n${offenders.join("\n")}`,
  );
  assertEquals(unexplained, [], `noVerdict without a reason: ${unexplained.join(", ")}`);
});

Deno.test("the scan recognises a derived exit and rejects a constant one", () => {
  assertEquals(hasFailureDerivedExit("Deno.exit(0);"), false);
  assertEquals(hasFailureDerivedExit("console.log('x');"), false);
  assertEquals(hasFailureDerivedExit("Deno.exit(fail === 0 ? 0 : 1);"), true);
  assertEquals(hasFailureDerivedExit("Deno.exit(\n  failed > 0 ? 1 : 0,\n);"), true);
  assertEquals(hasFailureDerivedExit("Deno.exit(1);"), true);
});
