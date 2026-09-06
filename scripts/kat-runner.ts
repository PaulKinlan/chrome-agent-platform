// kat-runner.ts — `npm run test:kat`: every KAT in the registry, each with a
// real exit code. CAP-FB-20260830-SUITE-HONESTY-01, de-serialized by
// chrome-agent-platform-uzik.
//
// Before this runner, 43 of 44 `scripts/kat-*.ts` ran nowhere. Now every KAT
// the registry classes `kat` runs here; a KAT the re-inventory found red is
// STILL run and printed as EXPECTED-RED with its recorded failure mode and
// owner (never skipped), and the run fails the moment one of them passes so
// the registry entry gets pruned. A hang counts as red: an expected-red KAT
// gets a short cap, a green one the full budget.
//
// The budget is the KAT's OWN time. This runner used to wrap every KAT in an
// outer `flock` on the canonical serialized-Chrome lock and set
// CAP_CHROME_LOCK_HELD=1 so the KAT's launcher would not deadlock on it — 57
// KATs strictly one at a time for the whole machine. uzik removed that: each
// KAT's launcher now takes a slot of the bounded-concurrency semaphore itself
// (scripts/lib/chrome-slots.ts) and prints CAP_CHROME_GATE_ACQUIRED when it has
// one, which is the marker the budget clock starts at. Queueing behind another
// lane's browsers is still measured separately and still bounded — it is just
// no longer exclusive, and no longer this runner's job to hold.
//
//   deno run -A scripts/kat-runner.ts                 # everything
//   deno run -A scripts/kat-runner.ts --only=mic      # name filter (substring)
//   deno run -A scripts/kat-runner.ts --green-only    # skip the owned reds (local convenience; the gate runs all)

import { HARNESSES, isKat, KAT_VERDICTS_PATH, readKatVerdicts } from "./lib/harness-registry.ts";
import { makeChecker } from "./lib/expected-red.ts";
import { runLockAware } from "./lib/lock-aware-command.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { pruneChromeProfileDirs } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const GREEN_BUDGET_MS = 600_000;
const LOCK_WAIT_MS = 20 * 60_000;
const RED_BUDGET_MS = 90_000;
const only = Deno.args.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "";
const greenOnly = Deno.args.includes("--green-only");
const LOG_DIR = durableDir(`cap-kat-runner-${Date.now()}`);

const kats = Object.entries(HARNESSES)
  .filter(([f, e]) => isKat(f) && e.class === "kat")
  .filter(([f]) => !only || f.includes(only))
  .filter(([, e]) => !greenOnly || !e.expectedRed)
  .sort(([a], [b]) => a.localeCompare(b));

const expectedRed: Record<string, string> = {};
for (const [f, e] of kats) if (e.expectedRed) expectedRed[`KAT ${f}`] = e.expectedRed;
const checker = makeChecker({ expectedRed });

async function runOne(file: string, budgetMs: number): Promise<{ code: number; ms: number; lockWaitMs: number; tail: string }> {
  const log = `${LOG_DIR}/${file.replace(/\.ts$/, "")}.log`;
  // The KAT's own launcher takes a concurrency slot and prints the gate marker
  // when it has one, so the KAT's budget starts when it actually has a browser
  // — queueing behind another lane's browsers is measured separately and
  // bounded, never charged to the KAT. The same marker mechanism the custody
  // self-tests use (scripts/lib/lock-aware-command.ts). Every KAT launches a
  // browser (all 58 import chrome-launch.ts), so the marker always arrives
  // unless the launch itself failed — which is a real finding, reported as one.
  const r = await runLockAware({
    executable: "sh",
    args: [
      "-c",
      `cd ${JSON.stringify(ROOT)} && exec deno run -A ${JSON.stringify(`${ROOT}scripts/${file}`)}`,
    ],
    env: { CAP_CHROME_SLOT_MARKER: "1" },
    budgetMs,
    lockWaitMs: LOCK_WAIT_MS,
    lockMarker: "CAP_CHROME_GATE_ACQUIRED",
  });
  await Deno.writeTextFile(log, r.text);
  const code = r.killedFor ? 124 : r.code;
  return { code, ms: r.ranMs, lockWaitMs: r.lockWaitMs, tail: r.text.slice(-1200) };
}

// Chrome profiles live outside the repo now (chrome-agent-platform-9t1b), and
// harnesses have never cleaned up after themselves, so the durable profile dir
// self-prunes once per run. A profile in use is minutes old, never hours: this
// cannot touch a live browser, and a removal failure is hygiene, not a red gate.
const pruned = await pruneChromeProfileDirs();
if (pruned.removed > 0 || pruned.errors.length > 0) {
  console.log(`kat-runner: pruned ${pruned.removed} stale Chrome profile(s), kept ${pruned.kept}${pruned.errors.length ? `, ${pruned.errors.length} error(s): ${pruned.errors.slice(0, 3).join("; ")}` : ""}`);
}

console.log(`kat-runner: ${kats.length} KATs (${Object.keys(expectedRed).length} owned reds) — logs in ${LOG_DIR}`);
for (const [file, entry] of kats) {
  const budget = entry.budgetMs ?? (entry.expectedRed ? RED_BUDGET_MS : GREEN_BUDGET_MS);
  const r = await runOne(file, budget);
  const lastLine = r.tail.trim().split("\n").filter((l) => /RESULT|passed|pass|SUMMARY|checks/.test(l)).pop() ?? r.tail.trim().split("\n").pop() ?? "";
  console.log(`  ${file}: exit ${r.code} in ${(r.ms / 1000).toFixed(0)}s${r.lockWaitMs > 1500 ? ` (queued ${(r.lockWaitMs / 1000).toFixed(0)}s for a browser slot)` : ""} — ${lastLine.slice(0, 140)}`);
  checker.check(`KAT ${file}`, r.code === 0, { exit: r.code, ms: r.ms, lockWaitMs: r.lockWaitMs, ...(entry.redReason ? { known: entry.redReason } : {}), tail: r.tail.slice(-300) });
  // Record this KAT's verdict in the durable ledger (after EVERY KAT, so a
  // killed run still leaves what it saw): tests/harness-registry.test.ts fails
  // when a KAT listed expected-red was last seen green here.
  try {
    const verdicts = readKatVerdicts();
    verdicts[file] = { exit: r.code, at: new Date().toISOString(), ms: Math.round(r.ms), expectedRed: entry.expectedRed ?? null };
    await Deno.mkdir(KAT_VERDICTS_PATH.slice(0, KAT_VERDICTS_PATH.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(KAT_VERDICTS_PATH, JSON.stringify(verdicts, null, 2) + "\n");
  } catch (e) {
    console.log(`  (could not record the verdict ledger: ${String(e)})`);
  }
}
console.log(`\n${checker.summary()}`);
Deno.exit(checker.exitCode());
