// tests/best-effort-write-guard.test.ts — chrome-agent-platform-yqhb2.
//
// The sweep is only worth doing once: a one-off audit of "which catch blocks swallow a write" grows
// back the next day. This file makes the CLASS enforceable — a `catch` whose body is empty (or a
// bare comment) around a write call fails the gate, with an explicit allowance list for the sites we
// have deliberately converted to a VISIBLE counter.
//
// The incident: the refusal ledger appended to a path that was a DIRECTORY, every append raised
// EISDIR, and `catch { /* best-effort */ }` threw the error away. Unmeasured suites were then
// silently unreported, and the only symptom was persistentCount=0 in a field nobody asserted on.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  bestEffortWrite,
  createWriteCounters,
  requireWrite,
  writeReport,
} from "../scripts/lib/best-effort-write.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// chrome-agent-platform-aaakp: the sweep is RECURSIVE over these roots — the flat
// list missed nested route dirs (extension/background/routes/*) entirely and never
// scanned tests/fixtures, where real swallowed writes lived (acp-fake-adapter,
// build-once, fake-acp-harness under scripts/fixtures). Recursion, not a longer
// flat list, is what keeps the next nested tree covered.
const SCAN_DIRS = ["scripts", "scripts/lib", "extension/lib", "extension/background", "tests/fixtures"];

/** Write calls that a discarded catch could silently lose. */
const WRITE_CALL = /\b(appendFileSync|writeFileSync|writeTextFileSync|Deno\.writeTextFile|appendFile|createWriteStream)\s*\(/;

/**
 * Files where a bare catch around a write is DELIBERATE and visible elsewhere, each with the reason
 * it is allowed. An entry here is a claim to re-verify, not a permanent exemption.
 */
const ALLOWED = new Map<string, string>([
  [
    "scripts/lib/browser-harness-refusal.mjs",
    "yqhb2: the ledger write is routed through bestEffortWrite with visible attempted/written/failed counters; the remaining catches here wrap READS (a torn line, a missing ledger), where a discarded error loses nothing that a count could recover",
  ],
  [
    "scripts/lib/best-effort-write.mjs",
    "yqhb2: this module IS the counter; its catch increments `failed` and logs, which the regex cannot see through the helper call",
  ],
  [
    // chrome-agent-platform-aaakp: surfaced by the recursive sweep. Deliberate BY
    // IMPACT: the record is a build ledger whose loss costs nothing the caller
    // does not already hold — the comment on the catch says exactly that, and the
    // swallowed value is a duplicate of output the caller returns in-process.
    "tests/fixtures/build-once.mjs",
    "aaakp: the build-record write is a cache/ledger ('a record we cannot write is not fatal: the caller already has the output'); the real output travels in-process, so a lost record changes no verdict",
  ],
]);

/**
 * Find `try { … } catch { … }` blocks whose TRY BODY performs a write and whose CATCH BODY is empty
 * or a bare comment. This is matched structurally rather than by proximity: the first version looked
 * back eight lines for a write, which blamed `catch { /* not loaded yet *\/ }` around a
 * `launchctl` call for the `writeFileSync` two lines above it — a guard that cries wolf on 10 files
 * is a guard every lane learns to ignore.
 */
export function swallowedWriteCatches(source: string): number[] {
  const text = String(source);
  const lines = text.split("\n");
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;

  /** Index just past the `{` that opens at `open`, or -1 when unbalanced. */
  const matchBrace = (open: number): number => {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  };

  const hits: number[] = [];
  const tryRe = /\btry\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = tryRe.exec(text))) {
    const bodyOpen = text.indexOf("{", m.index);
    const bodyEnd = matchBrace(bodyOpen);
    if (bodyEnd < 0) continue;
    const body = text.slice(bodyOpen, bodyEnd);
    if (!WRITE_CALL.test(body)) continue;
    // The catch must follow the try body (comments/whitespace between are allowed).
    const rest = text.slice(bodyEnd);
    const catchMatch = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(rest);
    if (!catchMatch) continue;
    const catchOpen = bodyEnd + catchMatch[0].length - 1;
    const catchEnd = matchBrace(catchOpen);
    if (catchEnd < 0) continue;
    const catchBody = text.slice(catchOpen + 1, catchEnd - 1);
    const withoutComments = catchBody.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim();
    if (withoutComments === "") hits.push(lineOf(m.index));
  }
  return hits;
}

/**
 * chrome-agent-platform-aaakp: recurse a scan root, yielding RELATIVE paths of
 * code files at every depth. The flat one-level loop this replaces skipped
 * nested route dirs and test-fixture trees wholesale.
 */
export async function* recurse(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = Deno.readDir(join(ROOT, root));
  } catch {
    return; // a directory that does not exist in this layout is not an offender
  }
  for await (const entry of entries) {
    const rel = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      yield* recurse(rel);
    } else if (entry.isFile && /\.(mjs|ts|js)$/.test(entry.name)) {
      yield rel;
    }
  }
}

Deno.test("yqhb2 guard: no catch may swallow a write in silence", async () => {
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    // recurse() already yields ROOT-relative paths — do not re-prefix.
    for await (const rel of recurse(dir)) {
      if (ALLOWED.has(rel)) continue;
      const source = await Deno.readTextFile(join(ROOT, rel));
      const hits = swallowedWriteCatches(source);
      for (const line of hits) offenders.push(`${rel}:${line}`);
    }
  }
  assertEquals(
    offenders,
    [],
    `a catch that discards a WRITE failure is silent data loss (yqhb2). Route it through ` +
      `bestEffortWrite so attempted/written/failed are visible, or add it to ALLOWED with the reason ` +
      `its loss cannot change a verdict. Offenders: ${offenders.join(", ")}`,
  );
});

Deno.test("yqhb2 guard: the detector actually detects (so a green sweep means something)", () => {
  // A guard nobody has seen fail is a guard nobody should trust: the first version of the
  // 0i477-style legs in this repo passed on the mutant.
  const swallowed = `try {
  appendFileSync(path, row);
} catch { /* best-effort */ }`;
  assertEquals(swallowedWriteCatches(swallowed).length, 1, "an empty catch around a write is a hit");
  const counted = `try {
  appendFileSync(path, row);
} catch (error) { counters.failed += 1; console.error(error); }`;
  assertEquals(swallowedWriteCatches(counted).length, 0, "a catch that counts and logs is not silent");
  const readOnly = `try { readFileSync(path, "utf8"); } catch { /* absent is fine */ }`;
  assertEquals(swallowedWriteCatches(readOnly).length, 0, "a swallowed READ is not the defect class");
});

Deno.test("yqhb2: EISDIR / EPERM / ENOSPC on a best-effort write are COUNTED and LOUD, never silent", () => {
  for (const code of ["EISDIR", "EPERM", "ENOSPC"]) {
    const counters = createWriteCounters();
    const logged: string[] = [];
    const outcome = bestEffortWrite({
      write: () => { const error = new Error(`${code}: simulated`); (error as Error & { code?: string }).code = code; throw error; },
      counters,
      label: "refusal ledger",
      log: (message: string) => logged.push(message),
    }, "/evidence/refusals.jsonl", "{}\n");
    assertEquals(outcome.ok, false, `${code} must be reported as a failure`);
    assertEquals(counters, { attempted: 1, written: 0, failed: 1 }, `${code} must be counted, not swallowed`);
    assertEquals(writeReport(counters).silent, 0, `${code}: no attempt may be unaccounted for`);
    assertEquals(logged.length, 1, `${code} must be LOUD`);
    assert(logged[0].includes(code), `the log must name ${code}: ${logged[0]}`);
  }
  // And the success path counts differently, so a silent zero and a real zero are distinguishable.
  const counters = createWriteCounters();
  assertEquals(bestEffortWrite({ write: () => {}, counters }, "p", "t").ok, true);
  assertEquals(counters, { attempted: 1, written: 1, failed: 0 });
  assertEquals(writeReport(counters).silent, 0);
  // The state the EISDIR bug produced — attempts nobody can account for — is exactly what `silent` names.
  assertEquals(writeReport({ attempted: 3, written: 0, failed: 0 }).silent, 3);
});

Deno.test("yqhb2: a write whose loss changes a VERDICT reports a refusal instead of crashing or vanishing", () => {
  // Coord's constraint: do not fix this by removing the catch and letting the gate crash. An
  // unwritable evidence tree means "this machine could not record the result" — a refusal.
  const error = new Error("EISDIR: is a directory");
  (error as Error & { code?: string }).code = "EISDIR";
  const refused = requireWrite({
    write: () => { throw error; },
    counters: createWriteCounters(),
    log: () => {},
  }, "/evidence/refusals.jsonl", "{}\n");
  assertEquals(refused.refused, true, "an unwritable verdict-bearing write must REFUSE");
  assertEquals(refused.ok, false);
  // It must not throw: a crash would take the whole gate down for an unwritable disk.
  const ok = requireWrite({ write: () => {}, log: () => {} }, "/evidence/ok.jsonl", "{}\n");
  assertEquals(ok, { ok: true, refused: false });
});


// chrome-agent-platform-aaakp — the RECURSION proofs, coord-shaped: a swallowed
// write under a NESTED ROUTE dir and one under a NESTED TEST-FIXTURE tree must
// each be flagged. The flat one-level loop this replaces saw neither (routes/*
// was a directory entry it skipped wholesale; tests/fixtures was not a scan
// root at all), so removing the recursion reds BOTH cases here.
Deno.test("aaakp: the sweep recurses — nested route dirs and nested fixture trees are covered", async () => {
  const swallowedFixture = `try {
  writeFileSync(path, state);
} catch { /* best-effort */ }
`;
  const probeRoutes = join(ROOT, "extension/background/routes/aaakp-recursion-probe");
  const probeFixtures = join(ROOT, "tests/fixtures/aaakp-recursion-probe/nested");
  try {
    Deno.mkdirSync(probeRoutes, { recursive: true });
    Deno.mkdirSync(probeFixtures, { recursive: true });
    await Deno.writeTextFile(join(probeRoutes, "zz-probe-route.mjs"), swallowedFixture);
    await Deno.writeTextFile(join(probeFixtures, "zz-probe-fixture.mjs"), swallowedFixture);

    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for await (const rel of recurse(dir)) {
        if (rel.includes("aaakp-recursion-probe")) offenders.push(rel);
      }
    }
    assert(
      offenders.some((f) => f.startsWith("extension/background/routes/")),
      `a swallowed write under a NESTED ROUTE dir must be flagged, got ${JSON.stringify(offenders)}`,
    );
    assert(
      offenders.some((f) => f.startsWith("tests/fixtures/")),
      `a swallowed write under a NESTED TEST-FIXTURE tree must be flagged, got ${JSON.stringify(offenders)}`,
    );
    assertEquals(offenders.length, 2, `exactly the two probe files may be flagged, got ${JSON.stringify(offenders)}`);
  } finally {
    await Deno.remove(join(ROOT, "extension/background/routes/aaakp-recursion-probe"), { recursive: true });
    await Deno.remove(join(ROOT, "tests/fixtures/aaakp-recursion-probe"), { recursive: true });
  }
});
