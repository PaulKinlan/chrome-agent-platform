// tests/heavy-gate-death-note.test.ts — HOW a killed heavy run says it was killed
// (chrome-agent-platform-qg9xa).
//
// A killed producer writes no receipt, so a consumer can only say "no receipt" — and the fleet
// narrator then supplied a cause it could not know. Measured by the merger on the erxkj run
// (2026-11-12): the acquirer had WON its quiet window, the wall-clock suite went green in 1m51s,
// and the job was SIGTERMed from outside at 135s — and the gate reported "exit 143 after 135s
// (KILLED by the 3600s bound: not a pass or fail)". exit 143 was right; the sentence was invented,
// and it is the same defect class as an instrument answering a question it cannot answer.
//
// So the PRODUCER records the distinction (it holds both clocks: the phase's elapsed time and the
// bound it was handed), in a file that can never be mistaken for a receipt, and the gate-receipt
// stage prints that sentence instead of guessing.
//
// Falsification: a mutant that always records "killed-bound" reds the external-kill leg; a mutant
// that writes the note where receipts live (`<tree>.json`) reds the "a death note is not a receipt"
// leg; a mutant that drops the signal wiring reds the behavioural SIGTERM leg.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkHeavyReceipt,
  currentTreeHash,
  deathNotePath,
  readDeathNote,
  receiptPath,
  writeDeathNote,
  writeHeavyReceipt,
} from "../scripts/lib/heavy-receipt.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** The tree a real producer run records against — the behavioural legs use the real one. */
const REPO_TREE = currentTreeHash(ROOT);
/** A tree with no receipt and no history: the unit legs must not depend on whether THIS repo's
 *  tree happens to carry a certifying receipt (measured: main's did, from the merger's own run). */
const SYNTHETIC_TREE = "0123456789abcdef0123456789abcdef01234567";

/** Every leg that touches the durable root cleans up, so a later gate on this tree is unaffected. */
function clearDeathNote(tree: string) {
  rmSync(deathNotePath(tree), { force: true });
}

Deno.test("qg9xa: an external kill is recorded with the cause the producer can actually prove", () => {
  const tree = SYNTHETIC_TREE;
  try {
    const path = writeDeathNote({
      tree,
      outcome: "killed-external",
      signal: "SIGTERM",
      phase: "WALL-CLOCK tests/x.test.ts",
      elapsedMs: 135_000,
      boundMs: 3_600_000,
    });
    assertEquals(path, deathNotePath(tree));
    assert(path !== null && existsSync(path), "the note is on disk");
    const note = readDeathNote(tree);
    assertEquals(note.outcome, "killed-external");
    assertEquals(note.verdict, "unknown", "a death note is never a verdict");
    assertEquals(note.signal, "SIGTERM");
    assertStringIncludes(note.headline, "EXTERNAL signal");
    assertStringIncludes(note.headline, "135s", "the run's own elapsed time");
    assertStringIncludes(note.headline, "bound was 3600s and had not fired",
      "the sentence the fleet narrator got wrong: it named a bound that had not fired");
    assertStringIncludes(note.headline, "not a pass or fail");
    assertStringIncludes(note.headline, "WALL-CLOCK", "it names the phase that was running");
  } finally {
    clearDeathNote(tree);
  }
});

Deno.test("qg9xa: the bound's own kill is recorded as killed-bound, naming the bound as the cause", () => {
  try {
    writeDeathNote({ tree: SYNTHETIC_TREE, outcome: "killed-bound", elapsedMs: 3_600_100, boundMs: 3_600_000, phase: "PARALLEL batch" });
    const note = readDeathNote(SYNTHETIC_TREE);
    assertEquals(note.outcome, "killed-bound");
    assertStringIncludes(note.headline, "its OWN 3600s bound");
    assertStringIncludes(note.headline, "not a pass or fail");
  } finally {
    clearDeathNote(SYNTHETIC_TREE);
  }
});

Deno.test("qg9xa: a death note is NOT a receipt — the gate still refuses to certify", () => {
  try {
    writeDeathNote({ tree: SYNTHETIC_TREE, outcome: "killed-external", signal: "SIGTERM", elapsedMs: 135_000, boundMs: 3_600_000 });
    const verdict = checkHeavyReceipt(SYNTHETIC_TREE);
    assertEquals(verdict.ok, false, "a killed run cannot certify a tree");
    assertEquals(verdict.outcome, "refused");
  } finally {
    clearDeathNote(SYNTHETIC_TREE);
  }
});

Deno.test("qg9xa: an unknown outcome or a missing tree records NOTHING (a note is never invented)", () => {
  // @ts-expect-error — the vocabulary is closed on purpose; an unknown outcome must record nothing.
  assertEquals(writeDeathNote({ tree: SYNTHETIC_TREE, outcome: "nonsense" }), null);
  assert(!existsSync(deathNotePath(SYNTHETIC_TREE)), "no file for an unknown outcome");
  assertEquals(writeDeathNote({ tree: "", outcome: "killed-external" }), null);
});

Deno.test("qg9xa: no note reads as null, so a consumer says 'no receipt' rather than guessing", () => {
  clearDeathNote(SYNTHETIC_TREE);
  assertEquals(readDeathNote(SYNTHETIC_TREE), null);
});

// --- behavioural: the real producer, killed both ways -------------------------------------------

/** Spawn the real heavy gate on one fast file and hand control back as soon as it announces the
 *  phase (that line prints BEFORE the child starts, so both kills below are deterministic). */
function startHeavyGate(file: string, env: Record<string, string> = {}) {
  const child = spawn("deno", ["run", "-A", "scripts/heavy-gate.ts", file], {
    cwd: ROOT,
    env: { ...process.env, CAP_HARDENED_DEATH_NOTE_TEST: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const sawPhase = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      if (/file\(s\)/.test(output)) resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
  return { child, sawPhase, output: () => output };
}

Deno.test("qg9xa: SIGTERMed from outside, the real gate records killed-external and exits BY THE SIGNAL", async () => {
  clearDeathNote(REPO_TREE);
  const { child, sawPhase } = startHeavyGate("tests/durable-root.test.ts");
  try {
    await sawPhase;
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    // 143 (bash-visible 128+SIGTERM) or a null code with signalTerm SIGTERM: either way it is NOT a verdict.
    assert(code === null || code === 143 || code === 143 - 128, `exited by the signal, got ${code}`);
    const note = readDeathNote(REPO_TREE);
    assert(note, "the producer wrote a death note before it died");
    assertEquals(note.outcome, "killed-external");
    assertEquals(note.signal, "SIGTERM");
    assertEquals(note.verdict, "unknown");
    assert(note.elapsedMs < note.boundMs, `an external kill is EARLIER than the bound (${note.elapsedMs} < ${note.boundMs})`);
    assertStringIncludes(note.headline, "had not fired");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    clearDeathNote(REPO_TREE);
  }
});

Deno.test("qg9xa: a run that hits its OWN bound records killed-bound, not killed-external", async () => {
  clearDeathNote(REPO_TREE);
  // 1ms of bound: the phase timer fires before any suite can finish, so this is deterministic and
  // costs one process start rather than a real 60-minute tier.
  const { child } = startHeavyGate("tests/durable-root.test.ts", { CAP_HEAVY_GATE_TIMEOUT_MS: "1" });
  try {
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    assertEquals(code, 124, "the bound kill keeps the tier's 124 vocabulary");
    const note = readDeathNote(REPO_TREE);
    assert(note, "the bound path wrote a death note");
    assertEquals(note.outcome, "killed-bound");
    assertStringIncludes(note.headline, "its OWN");
    assertEquals(note.boundMs, 1);
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    clearDeathNote(REPO_TREE);
  }
});

Deno.test("qg9xa: the gate-receipt stage prints the producer's sentence instead of inventing a cause", async () => {
  // A throwaway git repo: its tree has no receipt by construction, so this leg does not depend on
  // whether the real repo's tree happens to carry one.
  // durable-root convention: a plain Deno.makeTempDir lands in /tmp, which tests/durable-root.test.ts
  // (rightly) reds — the same guard the release-note suites follow. Scratch lives under the durable
  // root and is removed in the finally below.
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-qg9xa-" });
  const git = (...args: string[]) =>
    new Deno.Command("git", { args: ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], cwd: dir, stdout: "piped", stderr: "piped" }).output();
  try {
    await git("init", "-q");
    await Deno.writeTextFile(`${dir}/x.txt`, "x\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
    const treeOut = await git("rev-parse", "HEAD^{tree}");
    const tree = new TextDecoder().decode(treeOut.stdout).trim();
    clearDeathNote(tree);
    writeDeathNote({ tree, outcome: "killed-external", signal: "SIGTERM", phase: "WALL-CLOCK tests/x.test.ts", elapsedMs: 135_000, boundMs: 3_600_000 });
    const result = await new Deno.Command("node", {
      args: [`${ROOT}scripts/gate-receipt.mjs`],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 2, "still fails closed: there is no receipt");
    assertStringIncludes(stderr, "EXTERNAL signal");
    assertStringIncludes(stderr, "UNKNOWN, not a failure of the tree");
    assertStringIncludes(stderr, "WALL-CLOCK tests/x.test.ts");
  } finally {
    try {
      const treeOut = await git("rev-parse", "HEAD^{tree}");
      clearDeathNote(new TextDecoder().decode(treeOut.stdout).trim());
    } catch { /* no commit */ }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ozbod: a LATER failed run for the same tree is not narrated by an earlier attempt's death note", async () => {
  // chrome-agent-platform-ozbod (delta review of qg9xa). The note is keyed by TREE, and a tree can carry
  // more than one run. Reading it on ANY refusal let a note left by an earlier killed attempt narrate a
  // LATER run that did write a receipt: measured by the reviewer as a stale "EXTERNAL signal … UNKNOWN"
  // printed instead of the failure that actually happened. A note answers exactly one question — "why is
  // there no receipt?" — and a run that finished has a receipt that speaks for itself.
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-ozbod-" });
  const git = (...args: string[]) =>
    new Deno.Command("git", { args: ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], cwd: dir, stdout: "piped", stderr: "piped" }).output();
  let tree = "";
  try {
    await git("init", "-q");
    await Deno.writeTextFile(`${dir}/x.txt`, "x\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
    tree = new TextDecoder().decode((await git("rev-parse", "HEAD^{tree}")).stdout).trim();
    // Both legs build the SAME throwaway content, so they share a tree hash by construction. Clear the
    // receipt and the note up front as well as in the finally: a crash between the assertions and the
    // cleanup must not leave a receipt that the other leg reads as "this tree was already run".
    rmSync(receiptPath(tree), { force: true });
    clearDeathNote(tree);
    // The earlier attempt died; the LATER one ran and FAILED, so it wrote a receipt of its own.
    writeDeathNote({ tree, outcome: "killed-external", signal: "SIGTERM", phase: "WALL-CLOCK tests/x.test.ts", elapsedMs: 135_000, boundMs: 3_600_000 });
    assertEquals(existsSync(deathNotePath(tree)), true, "the killed attempt's note exists before the later run");
    writeHeavyReceipt({ tree, result: "fail", command: "heavy", args: [], exitCode: 1 });
    // A non-passing receipt KEEPS the note: on the bound path the gate records rc 124 AND a note for the
    // SAME run, and the note holds the sentence the receipt cannot (which bound fired, after how long).
    assertEquals(existsSync(deathNotePath(tree)), true, "the note survives a non-passing receipt (same run)");

    // The READER is what closes ozbod: a refusal that has a receipt never consults the note, so a note
    // left by an earlier killed attempt cannot narrate the later failure.
    const result = await new Deno.Command("node", {
      args: [`${ROOT}scripts/gate-receipt.mjs`],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 2, "still fails closed on a non-passing receipt");
    assertStringIncludes(stderr, "IS NOT A PASS");
    assert(
      !stderr.includes("EXTERNAL signal") && !stderr.includes("UNKNOWN, not a failure of the tree"),
      `a stale note must not narrate a run that has its own receipt; got:\n${stderr}`,
    );
  } finally {
    if (tree) {
      clearDeathNote(tree);
      rmSync(receiptPath(tree), { force: true });
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("qg9xa: the source pins the wiring — the bound path and the signal handlers both record", () => {
  const gate = readFileSync(`${ROOT}scripts/heavy-gate.ts`, "utf8");
  assertStringIncludes(gate, 'outcome: "killed-bound"');
  assertStringIncludes(gate, 'outcome: "killed-external"');
  assertStringIncludes(gate, 'Deno.addSignalListener(sig, handler)');
  assertStringIncludes(gate, "Deno.kill(Deno.pid, signal)", "the kill is re-raised so the exit status stays honest");
  const receipt = readFileSync(`${ROOT}scripts/gate-receipt.mjs`, "utf8");
  assertStringIncludes(receipt, "readDeathNote(tree)");
  assertStringIncludes(receipt, "death.headline");
});

Deno.test("o43z7: a note that PARSES but lacks the narrated fields is refused, not crashed on", () => {
  // The reviewer's repro (o43z7): {version:1, kind:'heavy-gate-death-note', verdict:'unknown',
  // outcome:'killed-external'} — valid JSON, no `at`/`headline`. readDeathNote used to return it and
  // the READER then threw RangeError from new Date(undefined).toISOString(), so a diagnostics stage
  // exited 1 with a stack instead of its documented 2. A malformed note is reported, never guessed at.
  const tree = SYNTHETIC_TREE;
  try {
    rmSync(deathNotePath(tree), { force: true });
    writeFileSync(deathNotePath(tree), JSON.stringify({
      version: 1,
      kind: "heavy-gate-death-note",
      verdict: "unknown",
      outcome: "killed-external",
    }));
    assert(existsSync(deathNotePath(tree)), "the incomplete note is on disk");
    assertEquals(readDeathNote(tree), null, "an incomplete note answers no question");

    // Each required field is load-bearing on its own: dropping any one refuses the note.
    const complete = {
      version: 1,
      kind: "heavy-gate-death-note",
      verdict: "unknown",
      outcome: "killed-external",
      headline: "heavy-gate was killed by an EXTERNAL signal (SIGTERM) after 135s (not a pass or fail)",
      at: 1_700_000_000_000,
      producer: "impl-c",
    };
    assertEquals(readDeathNote(tree), null, "still the incomplete note");
    writeFileSync(deathNotePath(tree), JSON.stringify(complete));
    assertEquals(readDeathNote(tree)?.headline, complete.headline, "a complete note is read as before");
    for (const field of ["headline", "at", "kind", "outcome"] as const) {
      const missing = { ...complete };
      delete (missing as Record<string, unknown>)[field];
      writeFileSync(deathNotePath(tree), JSON.stringify(missing));
      assertEquals(readDeathNote(tree), null, `a note without ${field} is refused`);
    }
    // A timestamp that is not an instant is refused too, and an ISO string is honoured.
    writeFileSync(deathNotePath(tree), JSON.stringify({ ...complete, at: "not-a-date" }));
    assertEquals(readDeathNote(tree), null, "an unparseable `at` is refused, not passed to toISOString");
    writeFileSync(deathNotePath(tree), JSON.stringify({ ...complete, at: "2026-11-14T06:00:00.000Z" }));
    assertEquals(readDeathNote(tree)?.headline, complete.headline, "an ISO timestamp is a valid instant");
  } finally {
    clearDeathNote(tree);
  }
});

Deno.test("o43z7: the gate-receipt stage keeps its exit-2 vocabulary on an incomplete death note", async () => {
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-o43z7-" });
  const git = (...args: string[]) =>
    new Deno.Command("git", { args: ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], cwd: dir, stdout: "piped", stderr: "piped" }).output();
  let tree = "";
  try {
    await git("init", "-q");
    await Deno.writeTextFile(`${dir}/x.txt`, "x\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
    tree = new TextDecoder().decode((await git("rev-parse", "HEAD^{tree}")).stdout).trim();
    rmSync(receiptPath(tree), { force: true });
    // The reviewer's exact note: parses, omits `at` and `headline`.
    writeFileSync(deathNotePath(tree), JSON.stringify({
      version: 1,
      kind: "heavy-gate-death-note",
      verdict: "unknown",
      outcome: "killed-external",
    }));
    const result = await new Deno.Command("node", {
      args: [`${ROOT}scripts/gate-receipt.mjs`],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 2, `the structural refusal code survives corrupt input; stderr:\n${stderr}`);
    assertStringIncludes(stderr, "malformed and is ignored", "the note is reported as malformed");
    assertStringIncludes(stderr, "is not a timestamp", "the missing timestamp is named, not printed");
    assertStringIncludes(stderr, "HEAVY RECEIPT MISSING", "the structural refusal sentence still prints");
    assert(!stderr.includes("gate-receipt: undefined") && !stderr.includes("recorded "),
      `an ignored note narrates nothing (that "undefined" line was the crash's first symptom):\n${stderr}`);
    assert(!stderr.includes("RangeError"), `no crash from a corrupt note:\n${stderr}`);
    assert(!/\n\s+at .*gate-receipt/.test(stderr), `no stack trace:\n${stderr}`);
  } finally {
    if (tree) {
      clearDeathNote(tree);
      rmSync(receiptPath(tree), { force: true });
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
