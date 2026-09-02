// expected-red.ts — honest handling of a KNOWN failure inside a gate.
// CAP-FB-20260830-SUITE-HONESTY-01
//
// A harness that carries a failing check owned by another tracker entry has
// three dishonest options — delete the check, skip it silently, or leave the
// whole gate red so nobody runs it — and one honest one: keep running the
// check, print it as EXPECTED-RED with its owner every time, count it apart
// from real failures, and FAIL the run the moment it turns green so the entry
// is pruned. An entry that names a check that no longer runs is stale, and
// that fails the run too.
//
//   const checker = makeChecker({ expectedRed: { "settings: contrast — no AA failures": "CAP-FB-…" } });
//   checker.check("settings: contrast — no AA failures", ok, detail);
//   console.log(checker.summary()); Deno.exit(checker.exitCode());

export interface Checker {
  /** Record one named assertion. Returns `cond`. */
  check(name: string, cond: boolean, detail?: unknown): boolean;
  counts(): { pass: number; fail: number; expectedRed: number; unexpectedGreen: number };
  /** Expected-red names whose check never ran this run. */
  stale(): string[];
  /** The RESULT line: `RESULT: n passed, m failed[, k expected-red (owned: …)][, u unexpected-green …]`. */
  summary(): string;
  /** 0 only when nothing failed, nothing owned turned green, and nothing is stale. */
  exitCode(): number;
}

export function makeChecker(opts: {
  expectedRed?: Record<string, string>;
  log?: (line: string) => void;
} = {}): Checker {
  const owned = opts.expectedRed ?? {};
  const log = opts.log ?? ((l: string) => console.log(l));
  let pass = 0, fail = 0, expectedRed = 0, unexpectedGreen = 0;
  const ran = new Set<string>();
  const owners: string[] = [];
  return {
    check(name, cond, detail) {
      ran.add(name);
      const owner = owned[name];
      if (cond) {
        if (owner) {
          unexpectedGreen++;
          log(`UNEXPECTED-GREEN: ${name} — now passes; remove it from EXPECTED_RED (${owner})`);
        } else {
          pass++;
          log(`PASS: ${name}`);
        }
        return true;
      }
      if (owner) {
        expectedRed++;
        owners.push(owner);
        log(`EXPECTED-RED (${owner}): ${name} — ${JSON.stringify(detail)}`);
      } else {
        fail++;
        log(`FAIL: ${name} — ${JSON.stringify(detail)}`);
      }
      return false;
    },
    counts: () => ({ pass, fail, expectedRed, unexpectedGreen }),
    stale: () => Object.keys(owned).filter((n) => !ran.has(n)),
    summary() {
      let s = `RESULT: ${pass} passed, ${fail} failed`;
      if (expectedRed > 0) s += `, ${expectedRed} expected-red (owned: ${[...new Set(owners)].join(", ")})`;
      if (unexpectedGreen > 0) s += `, ${unexpectedGreen} unexpected-green (prune EXPECTED_RED)`;
      const st = this.stale();
      if (st.length > 0) s += `, ${st.length} stale expected-red (${st.join(", ")})`;
      return s;
    },
    exitCode() {
      return fail === 0 && unexpectedGreen === 0 && this.stale().length === 0 ? 0 : 1;
    },
  };
}
