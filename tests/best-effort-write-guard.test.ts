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
const SCAN_DIRS = ["scripts", "scripts/lib", "extension/lib", "extension/background"];

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

Deno.test("yqhb2 guard: no catch may swallow a write in silence", async () => {
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    let entries: AsyncIterable<{ name: string; isFile: boolean }>;
    try {
      entries = Deno.readDir(join(ROOT, dir));
    } catch {
      continue; // a directory that does not exist in this layout is not an offender
    }
    for await (const entry of entries) {
      if (!entry.isFile || !/\.(mjs|ts|js)$/.test(entry.name)) continue;
      const rel = `${dir}/${entry.name}`;
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
