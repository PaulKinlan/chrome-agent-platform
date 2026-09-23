// tests/composer-selector-migration.test.ts — chrome-agent-platform-4vfj
//
// The GUARD half of an unfinished migration. Bead sndb removed the composer's
// fixed ids on purpose and pinned the removal in
// tests/agent-composer-unique-ids.test.ts; the harness half never followed, so
// `npm run test:a11y` was red on main and 35 files addressed the composer by
// `task-input` / `run-task`. scripts/lib/composer-target.ts is the resolver half.
// This test is what stops site 151 being written.
//
// HOW MANY ARE LEFT is the ledger below, not a number in this comment — a count in
// prose is a pin that rots the first time a file migrates. Two are done
// (a11y-audit.ts, and sidebar-parity.ts by bead cwy2); a migrated file keeps one
// explanatory line, so read the MIGRATED section rather than counting entries.
//
// The rule it pins is the CLASS, not today's instances:
//   • a file that is not in the inventory may not name a retired id at all, so a
//     NEW site anywhere in scripts/, cap-evidence/ or tests/ fails;
//   • an inventoried file's count may only SHRINK, so adding a site to a
//     known-stale file fails too;
//   • reaching zero demands the entry be pruned, so the ledger cannot rot into a
//     list of files that are already clean.
//
// Migrating a file = import from scripts/lib/composer-target.ts, then lower or
// delete its line here. The inventory line moving IS the migration record.
//
// MUTANTS (both must be re-run if this file changes — a rule-pin that only
// covers today's snapshot is a pin on the snapshot):
//   M-A  add a retired id to a file NOT in the inventory -> first test reds.
//   M-B  add one more retired id to an inventoried file  -> second test reds.
import { assertEquals, assert } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { COMPOSER_HOSTS } from "../scripts/lib/composer-target.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCAN_ROOTS = ["scripts", "cap-evidence", "tests"];
const CODE_EXT = [".ts", ".mts", ".js", ".mjs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-versions"]);

// The retired ids as they appear in a selector. `run-task-button` is a DIFFERENT
// thing (a gallery-only custom element, bead adu), so a trailing hyphen is out.
const RETIRED = /\btask-input\b(?!-)|\brun-task\b(?!-)/;

// The only sanctioned places that may name the retired ids: the resolver that
// explains what replaced them, the sndb pin that asserts their absence, and this
// guard.
const EXEMPT = new Set([
  "scripts/lib/composer-target.ts",
  "tests/agent-composer-unique-ids.test.ts",
  "tests/composer-selector-migration.test.ts",
]);

// MEASURED, not remembered:
//   grep -rlP '\btask-input\b(?!-)|\brun-task\b(?!-)' scripts cap-evidence tests
// counted per file, on origin/main @ d0f01545 (2026-09-22). Classes, so the list
// is readable: GATES inside test:all first (chrome-journeys, security-suite,
// a11y-audit, component-gallery-smoke), then the KATs run by test:kat, then the
// named harnesses, then one-off evidence, then unit tests that mention the ids.
const INVENTORY: Record<string, number> = {
  // ── gates inside test:all ────────────────────────────────────────────────
  "scripts/chrome-journeys.ts": 38, // was 44. COUNTING CAVEAT, corrected on review:
  // this is a count of matching LINES, not of call sites, and it is NOT a measure
  // of what still works. The criterion that matters is whether a read routes
  // through boxOf (:367-380), which carries the compat mapping
  // #task-input -> [data-composer-input] / #run-task -> [data-composer-send].
  // Most do (via typeInto -> clickSel -> boxOf, verified by reading all three),
  // but NOT ALL: :6263 read '#thread-composer #task-input' directly for a debug
  // line, so it logged on every call and said nothing about why. Migrated sites:
  // :2688 and :2721 (the two that fed real assertions), the sendTask trio at
  // :6262-6264, and the multi-slash Run-task click. What remains is unverified
  // line-by-line against boxOf coverage — treat it as unmigrated until read.
  "scripts/component-gallery-smoke.ts": 3, // :200,:216,:217
  // MIGRATED, so pruned from the ledger (a clean file that stays listed fails the
  // second test on purpose — the ledger must list only work that is left):
  //   scripts/a11y-audit.ts (was 3) — it was the red gate: four combobox checks
  //     read ARIA attributes off the absent element with ?., so attrs came back {}
  //     and a missing element reported itself as a product ARIA defect.
  //   scripts/security-suite.ts (was 4, at :339,:347,:417,:426) — the second red
  //     gate. Measured on unmodified main c80b8abc: 16 PASS then
  //     FAIL composer:false, providerRequests:[], then the suite burned its whole
  //     120 s PRODUCTION_TIMEOUT_MS in polling loops waiting on a run that could
  //     never start and was TERM'd (exit 124), so the two cookie-redaction checks
  //     never ran at all. Repairing the four selectors: 19 passed / 0 failed in
  //     15 s, exit 0. The hang was arithmetic, not a second bug.
  // ── KATs (npm run test:kat) ──────────────────────────────────────────────
  "scripts/kat-local-files.ts": 7,
  "scripts/kat-thinking-trace.ts": 4,
  "scripts/kat-tool-call-clarity.ts": 3,
  "scripts/kat-mic-state.ts": 3,
  "scripts/kat-composer-slash-commands.ts": 3,
  "scripts/kat-composer-grow.ts": 3,
  "scripts/kat-webmcp-honest-errors.ts": 2,
  "scripts/kat-patch-asset.ts": 2,
  "scripts/kat-bundled-execute.ts": 2,
  "scripts/kat-progress-inline.ts": 1,
  "scripts/kat-mcp-tool-injection.ts": 1,
  // ── named harnesses (run on demand) ──────────────────────────────────────
  "scripts/agent-access-journeys.ts": 11, // registry says 81/7
  "scripts/webmcp-acceptance.ts": 8,
  "scripts/ui-integration.ts": 4,
  "scripts/run-status-lifecycle.ts": 4,
  "scripts/read-page-host-grant-acceptance.ts": 4,
  "scripts/system-prompts-integration.ts": 3,
  "scripts/tool-call-evidence.ts": 2,
  "scripts/page-actions-journey.ts": 2,
  "scripts/live-run-evidence.ts": 2,
  "scripts/live-every-tab.ts": 2,
  "scripts/keyless-first-result.ts": 2,
  "scripts/mic-transcript-smoke.ts": 1,
  // ── MIGRATED: the residual count is the explanatory comment, not a selector ──
  // Both were measured again after cwy2 landed (983706df). A migrated file keeps
  // one line naming what it used to read, so the next lane can find the history;
  // the ratchet still fails if a real site is added to either.
  "scripts/sidebar-parity.ts": 1, // migrated by bead cwy2; was 3
  "scripts/lib/harness-registry.ts": 1, // prose in cwy2's sidebar-parity reason row, not a selector
  // ── one-off evidence drivers ─────────────────────────────────────────────
  "cap-evidence/sndb-composer-unique-evidence.ts": 15,
  "cap-evidence/h638-open-trace.ts": 4,
  // ── unit tests that mention the ids (audit: pin, fixture, or stale?) ─────
  "tests/durable-runs.test.ts": 3,
  "tests/sw-route-modularization.test.ts": 1,
  "tests/sw-dispatch-authority-census.test.ts": 1,
  "tests/first-run-onboarding-composition.test.ts": 1,
};

/** Lines matching a retired id, per repo-relative file path. */
function scan(): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (abs: string, rel: string) => {
    for (const entry of Deno.readDirSync(abs)) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name)) walk(`${abs}/${entry.name}`, relPath);
        continue;
      }
      if (!CODE_EXT.some((ext) => entry.name.endsWith(ext))) continue;
      const text = Deno.readTextFileSync(`${abs}/${entry.name}`);
      const lines = text.split("\n").filter((line) => RETIRED.test(line)).length;
      if (lines > 0) found.set(relPath, lines);
    }
  };
  for (const root of SCAN_ROOTS) {
    const abs = `${ROOT}${root}`;
    if (exists(abs)) walk(abs, root);
  }
  return found;
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("4vfj: no file outside the migration inventory addresses the composer by a retired id", () => {
  const unlisted: string[] = [];
  for (const [file, count] of scan()) {
    if (EXEMPT.has(file) || file in INVENTORY) continue;
    unlisted.push(`${file} (${count} line${count === 1 ? "" : "s"})`);
  }
  assertEquals(
    unlisted,
    [],
    `A file addresses the composer by a RETIRED id (task-input / run-task). Those ids were removed on
purpose by bead sndb — several documents carry more than one composer, so a fixed id silently
resolved to the first one and input went to a hidden element. Import
scripts/lib/composer-target.ts (composerInput / composerSend / composerPopup, scoped by host)
instead. If this really is a sanctioned mention, add the file to EXEMPT with a reason.
Unlisted: ${unlisted.join(", ")}`,
  );
});

Deno.test("4vfj: the retired-id inventory only shrinks, and a clean file is pruned from it", () => {
  const measured = scan();
  const grew: string[] = [];
  const prune: string[] = [];
  for (const [file, baseline] of Object.entries(INVENTORY)) {
    const actual = measured.get(file) ?? 0;
    if (actual > baseline) grew.push(`${file}: ${baseline} -> ${actual}`);
    if (actual === 0) prune.push(file);
  }
  assertEquals(
    grew,
    [],
    `An inventoried file gained MORE retired-id sites. The inventory is a ratchet: it may only
shrink as files migrate to scripts/lib/composer-target.ts. Growing it needs the count edited here
in the same commit, which is the point — the diff then shows the migration going backwards.
Grew: ${grew.join(", ")}`,
  );
  assertEquals(
    prune,
    [],
    `These files no longer name a retired id — delete their INVENTORY entry so the ledger lists
only work that is actually left: ${prune.join(", ")}`,
  );
  assert(
    Object.keys(INVENTORY).length > 0,
    "the inventory is empty: the migration is finished, so delete this test's inventory and keep the first test as the permanent rule",
  );
});

Deno.test("4vfj: the resolver covers every composer host the product ships", () => {
  // The resolver is the sanctioned replacement, so its host list must match the
  // markup — a host missing here is a harness about to invent its own selector.
  const markup: string[] = [];
  for (const page of ["extension/ntp/ntp.html", "extension/sidepanel/sidepanel.html"]) {
    const text = Deno.readTextFileSync(`${ROOT}${page}`);
    for (const m of text.matchAll(/<agent-composer[^>]*\bid="([^"]+)"/g)) markup.push(m[1]);
  }
  const declared = Object.values(COMPOSER_HOSTS).sort();
  assertEquals(
    declared,
    [...new Set(markup)].sort(),
    `COMPOSER_HOSTS in scripts/lib/composer-target.ts disagrees with the <agent-composer> host ids
in the shipped markup. A harness that cannot name its composer by host will reach for a
document-wide selector, which is the bug sndb removed the fixed ids to prevent.`,
  );
});
