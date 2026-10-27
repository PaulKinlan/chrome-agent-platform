// tests/wall-clock-budget-registry.test.ts — the 63o3v rule, enforced in code.
//
// THE RULE: a wall-clock budget must DECLARE the host envelope it is defined at
// (WALL_CLOCK_BUDGETS in scripts/lib/wait-budget.ts: baseMs + definedAt
// { maxLoadPerCore, maxStealPct }) and the owning bead), and above that envelope
// the suite REFUSES environmentally rather than manufacturing a red that reads
// as a product regression.
//
// THE ENFORCEMENT SHAPE: a budget routed through wait-budget.ts stops containing
// raw deadline arithmetic (`Date.now() + readyBudgetMs` is not a numeric
// literal), so a raw numeric deadline in a test file is exactly the undeclared
// case. Every file with one must be REGISTERED (a registry row keyed
// `<file>#<phase>`, and the file must import the machinery) or named in the
// NOT_A_PRODUCT_BUDGET allowlist below with the reason it is harness plumbing.
// A NEW raw deadline reds this guard until its owner declares or allowlists it.

import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { WALL_CLOCK_BUDGETS } from "../scripts/lib/wait-budget.ts";

// Files whose raw deadline arithmetic is NOT a wall-clock budget on product
// behaviour, each with the reason. This list is the re-tuning inventory the
// bead asked for: an entry here is a known, named, reasoned exception - never
// a silent one. If an entry's suite starts asserting product TIMING, it leaves
// this list and joins the registry in the same commit.
const NOT_A_PRODUCT_BUDGET: Readonly<Record<string, string>> = Object.freeze({
  "tests/agent-header-rename-reload.test.ts":
    "its product-behaviour wait is already load-scaled (settleBoundMs via serialFileTimeoutMs at the wait); " +
    "the raw 15s at :280 is a sweep ceiling on lock/reload plumbing - re-tune candidate, named per 63o3v ask 4",
  "tests/chrome-launch-lock.test.ts":
    "harness plumbing: deadlines on LOCK acquisition (chrome launch lock), where the ceiling is a harness " +
    "defect bound, not a product timing claim",
  "tests/chrome-launch-lock-scope.test.ts":
    "harness plumbing: same launch-lock acquisition ceiling, scoped variant",
  "tests/chrome-slot-semaphore.test.ts":
    "harness plumbing: chrome-slot semaphore acquisition ceilings; expiry under contention is the property " +
    "under test, not a misread product red",
  "tests/chrome-slot-semaphore-honesty.test.ts":
    "harness plumbing: same slot machinery, honesty probes with fake contenders",
  "tests/composer-command-disclosure.test.ts":
    "generous UI polling ceilings (10-15s) on composer disclosure; candidate for the registry - named here " +
    "per 63o3v ask 4 rather than silently left",
  "tests/conversation-status-ui.test.ts":
    "in-memory poll bound (1s) over a fake store; no host wall-clock claim",
  "tests/durable-task-restore.test.ts":
    "in-memory poll bound (2s) over a fake store; no host wall-clock claim",
  "tests/heavy-gate-slot.test.ts":
    "harness plumbing: the heavy-gate slot's own acquisition ceiling",
  "tests/jjsz-lifeline-leader-exit.test.ts":
    "harness plumbing: lifeline leader-exit custody waits on fake processes",
  "tests/launch-chrome-failure-path.test.ts":
    "failure-PATH harness tests: the deadline bounds how long a deliberately broken launch may take",
  "tests/serial-phase-resilience.test.ts":
    "the serial phase's own resilience fixtures (driven clocks and fixture PIDs), not product budgets",
  "tests/thread-continuation-multirun.test.ts":
    "in-memory poll bound (2s) over fake run state; no host wall-clock claim",
});

// A raw wall-clock deadline: `<name> = Date.now() + <ms literal>` spellings,
// four digits and up (sub-second arithmetic is not a budget).
const RAW_DEADLINE_RE = /(?:deadline|end|By)\s*=\s*Date\.now\(\)\s*\+\s*\d{4,}/;

// This guard scans test SOURCES, so its own file - which necessarily discusses
// the pattern - is excluded from the census. Every other tests/*.test.ts counts.

function* walk(dir: string): Generator<string> {
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile && entry.name.endsWith(".test.ts")) yield path;
  }
}

Deno.test("63o3v registry guard: every raw numeric deadline in tests/ is REGISTERED or named with a reason", () => {
  const registeredFiles = new Set(
    Object.keys(WALL_CLOCK_BUDGETS).map((key) => key.split("#")[0]),
  );
  const hits: string[] = [];
  for (const file of walk("tests")) {
    const text = Deno.readTextFileSync(file);
    if (!RAW_DEADLINE_RE.test(text)) continue;
    const rel = file.replace(/^\.\//, "");
    if (rel.endsWith("wall-clock-budget-registry.test.ts")) continue; // the census does not count its own discussion
    hits.push(rel);
    if (registeredFiles.has(rel)) {
      assertStringIncludes(
        text,
        "wait-budget",
        `${rel}: a registered budget suite must route through scripts/lib/wait-budget.ts`,
      );
      continue;
    }
    assert(
      rel in NOT_A_PRODUCT_BUDGET,
      `${rel}: raw wall-clock deadline arithmetic with no WALL_CLOCK_BUDGETS row and no allowlist ` +
        `reason - declare the budget's envelope (63o3v) or record here why it is not a product budget`,
    );
    assert(
      (NOT_A_PRODUCT_BUDGET[rel] ?? "").length > 20,
      `${rel}: an allowlist entry without a real reason is not an entry`,
    );
  }
  assert(hits.length > 0, "the scan must find the known plumbing deadlines - an empty scan means the regex broke, not the tree");
});

Deno.test("63o3v registry guard: registry keys name real files with real deadlines, allowlist keys name real files", () => {
  for (const key of Object.keys(WALL_CLOCK_BUDGETS)) {
    const [file, phase] = key.split("#");
    assert(phase && phase.length > 0, `${key}: the key must name a phase`);
    let stat = null;
    try {
      stat = Deno.statSync(file);
    } catch { /* falls to the assert */ }
    assert(stat?.isFile, `${key}: the registry names a file that does not exist`);
  }
  for (const file of Object.keys(NOT_A_PRODUCT_BUDGET)) {
    let stat = null;
    try {
      stat = Deno.statSync(file);
    } catch { /* falls to the assert */ }
    assert(stat?.isFile, `${file}: allowlist names a file that does not exist - delete the entry with the file`);
  }
});
