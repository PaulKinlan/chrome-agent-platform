// harness-registry.ts — every browser harness in scripts/ has exactly one class.
// CAP-FB-20260830-SUITE-HONESTY-01
//
// tests/harness-registry.test.ts fails when a scripts/*.ts is missing here,
// when an entry names a file that no longer exists, when a `gate` is not in
// `test:all`, or when a KAT is neither run by scripts/kat-runner.ts nor
// explicitly set aside with a reason. The classes:
//
//   gate    — an npm script that `npm run test:all` runs.
//   named   — an npm script run on demand; `reason` says why it is not a gate
//             (and its tally at the 2026-09-02 re-inventory).
//   kat     — run by scripts/kat-runner.ts (`npm run test:kat`), one at a time
//             under the canonical serialized-Chrome lock. A KAT that was RED at
//             the re-inventory carries `expectedRed` (its OWNER) and `redReason`
//             (the failure mode): the runner still runs it, prints it as
//             EXPECTED-RED with both, and fails the run the moment it passes so
//             the fields are removed. Never a silent skip.
//   manual  — an evidence/repro/bisect tool run by hand or by
//             scripts/evidence-runner.sh; explicitly not a gate; `reason` says why.
//   helper  — a server or tool other harnesses import/spawn; not a harness.
//
// Tallies below are from the re-inventory of 2026-09-02 (every harness run once
// on this tree, serialized). "n/m" = passed/failed.

export type HarnessClass = "gate" | "named" | "kat" | "manual" | "helper";

export interface HarnessEntry {
  class: HarnessClass;
  /** The npm script that runs this file (gate / named). */
  npm?: string;
  /** For a gate/named entry whose npm script runs a wrapper rather than the file itself. */
  via?: string;
  /** Why it is named-only, manual, or a helper. */
  reason?: string;
  /** kat only: WHO owns the known failure (a CAP-FB id, a lane, or "unassigned …"); the runner prints it as the owner. */
  expectedRed?: string;
  /** kat only: the failure mode recorded at the re-inventory (required with expectedRed). */
  redReason?: string;
  /** A generator with nothing to assert may opt out of the exit-code gate — with a reason. */
  noVerdict?: string;
  /** kat only: this KAT's own time budget in the runner, when the default (600 s green / 90 s red) does not fit. */
  budgetMs?: number;
}

const RED = (tally: string, mode: string, owner = "unassigned (a fix or a retirement decision is the next action)") => ({
  expectedRed: owner,
  redReason: `red at the 2026-09-02 re-inventory (${tally}): ${mode}`,
});

export const HARNESSES: Record<string, HarnessEntry> = {
  // ── gates (npm run test:all) ────────────────────────────────────────────
  "chrome-journeys.ts": { class: "gate", npm: "test:chrome" },
  "security-suite.ts": { class: "gate", npm: "test:security", via: "scripts/security-suite-supervisor.sh" },
  "security-injection.ts": { class: "gate", npm: "test:security:injection" },
  "component-gallery-smoke.ts": { class: "gate", npm: "test:components" },
  "a11y-audit.ts": { class: "gate", npm: "test:a11y" },
  "kat-runner.ts": { class: "gate", npm: "test:kat" },

  // ── named (npm script, run on demand) ───────────────────────────────────
  "agent-access-journeys.ts": { class: "named", npm: "test:agent-access", reason: "81/7 at the re-inventory (seven agent-access checks red); 90 s; promote to a gate once green" },
  "agent-directory-ui.ts": { class: "named", npm: "test:directory", reason: "15/5 at the re-inventory (directory UI checks red); promote once green" },
  "agent-role-preview.ts": { class: "named", npm: "test:role-preview", reason: "7/0 at the re-inventory (4 s); run on demand — promotion to test:all is the owner's call" },
  "capability-lifecycle.ts": { class: "named", npm: "test:capabilities", reason: "12/9 at the re-inventory (capability lifecycle checks red); promote once green" },
  "data-memory-clear.ts": { class: "named", npm: "test:data-clear", reason: "13/0 at the re-inventory (8 s); run on demand — promotion is the owner's call" },
  "kat-local-files.ts": { class: "kat" },
  "opfs-real-browser.ts": { class: "named", npm: "test:opfs", reason: "6/0 at the re-inventory (2 s); run on demand — promotion is the owner's call" },
  "perf-leak-trace.ts": { class: "named", npm: "test:perf", reason: "8/0 at the re-inventory (3 s); run on demand — promotion is the owner's call" },
  "perf-seeded-scale.ts": { class: "named", npm: "test:perf:seeded", reason: "takes a seed-count argument (120) and a seeded profile; SEEDED-PROFILE-GATES-01 owns wiring it as a gate" },
  "read-page-host-grant-acceptance.ts": { class: "named", npm: "test:read-page-host-grant", reason: "11/11 at the re-inventory (14 s); run on demand — promotion is the owner's call" },
  "sidebar-parity.ts": { class: "named", npm: "test:sidebar", reason: "18/2 at the re-inventory (two sidebar parity checks red); promote once green" },
  "ui-integration.ts": { class: "named", npm: "test:ui", reason: "56/0 after the 5ht repair (hub moved #run-log → action-ledger; theme switching removed; durability contract now state-conditional; 6-min watchdog caps any hang; falsification: a rail-width break produces 4 failing checks); ~90s; run on demand — promotion is the owner's call" },
  "webmcp-acceptance.ts": { class: "named", npm: "test:webmcp", reason: "82/0 at the re-inventory (after its stderr-reader crash was removed by the launcher migration); the WebMCP lane's acceptance, run on demand with its fresh-profile picker proof" },
  "webmcp-realsite-probe.ts": { class: "manual", reason: "network-dependent diagnostic (chrome-agent-platform-ajcc): drives the REAL search_docs on beads.gascity.com through production enrollment + invocation with the diagnostics channel on, capturing the raw page-side error the bridge redaction strips; run by hand when the dispatch path changes" },

  // ── KATs (npm run test:kat via scripts/kat-runner.ts) ───────────────────
  "kat-activity-explorer.ts": { class: "kat", ...RED("7/5", "the backend 'ok' scenario renders 1 row with options ['', 'master']") },
  "kat-agent-board.ts": { class: "kat" },
  // 61/0 since CAP-FB-20260902-KAT-AGENT-DELEGATION-RED-01 re-baselined the over-cap
  // scenario to the admission-time budget refusal (three delegation runs ≈ 3 min).
  "kat-agent-delegation.ts": { class: "kat", budgetMs: 300_000 },
  "kat-browser-grant-persistence.ts": { class: "kat" },
  "kat-agent-templates.ts": { class: "kat", ...RED("13/24", "the first-run empty state now reads 'Browse starter templates' and seeds nothing automatically — the KAT predates the templates redesign") },
  "kat-artifact-library-capacity.ts": { class: "kat" },
  "kat-artifact-preview.ts": { class: "kat", ...RED("4/2", "the chat no longer renders the restricted artifact-preview host iframe the KAT expects") },
  "kat-background-run-transcript.ts": { class: "kat" },
  "kat-back-stack.ts": { class: "kat" },
  "kat-bgagent-delete.ts": { class: "kat" },
  "kat-composer-grow.ts": { class: "kat" },
  "kat-composer-slash-commands.ts": { class: "kat", ...RED("4/5", "the /tabs picker lists '(untitled)' rows and selecting one inserts no reference") },
  "kat-dark-scheme.ts": { class: "kat", ...RED("33/4", "options/dark and sidepanel/dark .btn contrast 2.88 and the artifact-noid light probe samples too few styles", "CAP-FB-20260827-SETTINGS-MONOLITH-01 (the accent-on-fill ink token)") },
  "kat-dialog-consolidation.ts": { class: "kat", ...RED("hang", "never finishes — killed at the 400 s inventory cap; the runner caps it at 90 s") },
  "kat-exec-build-flag.ts": { class: "kat", ...RED("29/1", "'flag on: all thirteen nav items are visible' — the nav now has fourteen entries") },
  "kat-failed-runs.ts": { class: "kat" },
  "kat-generated-image-strip.ts": { class: "kat" },
  "kat-genui-error-state.ts": { class: "kat", ...RED("16/2", "two generated-UI error-state checks red", "the generated-UI bootstrap syntax lane (in flight)") },
  "kat-hub-timeline.ts": { class: "kat" },
  "kat-interactive-artifact-click.ts": { class: "kat", budgetMs: 240_000 },
  "kat-mcp-agent-ui.ts": { class: "kat" },
  "kat-mcp-global-ui.ts": { class: "kat" },
  "kat-mcp-tool-injection.ts": { class: "kat" },
  "kat-mcp-transport.ts": { class: "kat" },
  "kat-mic-state.ts": { class: "kat", ...RED("59/1", "axe: the device picker controls carry an aria attribute not allowed on their role") },
  "kat-narrow-toggle.ts": { class: "kat" },
  "kat-notify-icon.ts": { class: "kat" },
  "kat-noun-discipline.ts": { class: "kat" },
  "kat-patch-asset.ts": { class: "kat" },
  "kat-permission-approval.ts": { class: "kat", ...RED("8/1", "'Approvals section displays pending revocation' finds 0 approvals") },
  "kat-pipeline-steps.ts": { class: "kat" },
  "kat-progress-inline.ts": { class: "kat" },
  "kat-provider-keyed-strip.ts": { class: "kat" },
  "kat-providers-recommended.ts": { class: "kat" },
  "kat-providers-tabs.ts": { class: "kat" },
  "kat-pyodide.ts": { class: "kat", budgetMs: 120_000 },
  "kat-recent-activity.ts": { class: "kat", ...RED("crash", "the explorer never mounts on the NTP ({mounted:false}) and the KAT then throws") },
  "kat-scheduled-next-run-widget.ts": { class: "kat" },
  "kat-scheduled-run-output.ts": { class: "kat" },
  "kat-settings-cleanliness.ts": { class: "kat" },
  "kat-settings-multi-section.ts": { class: "kat" },
  "kat-settings-server-tools.ts": { class: "kat" },
  "kat-site-delegation-attachments.ts": { class: "kat" },
  "kat-task-lifecycle.ts": { class: "kat", ...RED("0/1", "'no service worker target' — the KAT does not wait for the MV3 worker to register") },
  "kat-task-view-simplify.ts": { class: "kat", ...RED("21/1", "'a settled run leaves no debug affordance' — a toggle is still visible") },
  "kat-template-cards.ts": { class: "kat", ...RED("0/6", "the create dialog no longer has the template select the KAT expects (Name / What it does / Run on a schedule)") },
  "kat-tool-call-clarity.ts": { class: "kat" },
  "kat-ui-repair.ts": { class: "kat", ...RED("crash", "'Settings restores one compact background-agent add section' fails and the KAT then throws on a null select") },
  "kat-usage-viz.ts": { class: "kat" },
  "kat-webmcp-honest-errors.ts": { class: "kat" },
  "kat-ux-lows.ts": { class: "kat", ...RED("9/1", "UX-010: the wide form-factor two-column grid is not active") },
  "kat-wasi-tranche2.ts": { class: "kat", ...RED("1/9", "tool.preview.run answers 'offscreen unavailable: Could not establish connection'") },

  // ── manual (evidence / repro / bisect tools; not gates) ─────────────────
  "dump-tool-corpus-tokens.ts": { class: "manual", reason: "4kl tablegen input generator: prints the built-in tool corpus tokens (or --mode=texts) for scripts/build-tool-vector-table.mjs; runs by hand only when regenerating the committed vector table", noVerdict: "pure generator — it prints the corpus; there is nothing to assert" },
  "agent-provider-picker.ts": { class: "manual", reason: "the picker-50 evidence run (scripts/evidence-runner.sh gate 16); 0/2 at the re-inventory both before and after the launcher migration — its build-test-extension.mjs copy does not load on this tree ('extension target not found'), which is outside this lane" },
  "axe-audit.ts": { class: "manual", reason: "4/3 at the re-inventory; a11y-audit.ts is the gate — this is the axe-core cross-check kept for comparison" },
  "flake-evidence.ts": { class: "manual", reason: "a bisect tool: runs the journey suite N times on a branch and its base and compares failure sets; exits 1 only for a branch-only failure" },
  "focus-shots.ts": { class: "manual", reason: "a screenshot generator for focus-ring evidence (3/0 at the re-inventory: the Tab walk reaches the control, the ring is present, the shot is written)" },
  "headed-acceptance.ts": { class: "manual", reason: "needs a display (headed Chrome); run by hand for the headed acceptance" },
  "keyless-first-result.ts": { class: "manual", reason: "green at the re-inventory (16 s); the behaviour is journey 2k in chrome-journeys.ts (KEYLESS-FIRST-RESULT-01) — kept as the standalone repro" },
  "live-every-tab.ts": { class: "manual", reason: "needs a real Gemini key (GEMINI_API_KEY); the 30-tab sourced-digest live check for RUN-BUDGET-EVERY-ITEM-01 (arrived from main after the re-inventory; it launches through launchChrome and exits on its own verdict)" },
  "live-run-evidence.ts": { class: "manual", reason: "needs a real provider key; the live model evidence run" },
  "mic-transcript-smoke.ts": { class: "manual", reason: "4/0 at the re-inventory (3 s); the mic transcript smoke, run by hand when the mic path changes" },
  "opfs-wal-probe.ts": { class: "manual", reason: "PASS at the re-inventory; a one-shot OPFS WAL probe in the service worker (it used to load the primary checkout's extension by absolute path; now this tree's)" },
  "p0-repro.ts": { class: "manual", reason: "0/1 at the re-inventory; a repro script for a P0 that has since moved on — kept for bisecting" },
  "page-actions-journey.ts": { class: "manual", reason: "green at the re-inventory (7 s); the page-actions journey standalone, run by hand" },
  "panel-leak-probe.ts": { class: "manual", reason: "a leak probe with an honest verdict since the re-inventory: docs/frames grow only while each of the three panels is first visited, then stay flat for the remaining cycles and 0 options/ targets are retained after a forced GC (PASS); its old unconditional exit is gone" },
  "permission-matrix-acceptance.ts": { class: "manual", reason: "26/0 ATTESTED at the re-inventory (28 s); the permission-matrix acceptance run by hand for evidence" },
  "repro-recent-activity.ts": { class: "manual", reason: "a repro probe for the stale Recent-activity bug; exits 0 when the live explorer shows new activity" },
  "run-status-lifecycle.ts": { class: "manual", reason: "30/34 at the re-inventory: three hard-stop checks (the @demo-slow run completes before a Stop button renders) and the clean-worktree manifest gate; kept for bisecting" },
  "screenshot-vision-evidence.ts": { class: "manual", reason: "green at the re-inventory (25 s); the screenshot-to-model evidence run" },
  "sidepanel-companion-journey.ts": { class: "manual", reason: "9/0 at the re-inventory (54 s); the side-panel companion journey standalone" },
  "skills-in-settings-evidence.ts": { class: "manual", reason: "9/0 at the re-inventory (23 s); the skills-in-Settings evidence run" },
  "system-prompts-integration.ts": { class: "manual", reason: "3/11 at the re-inventory and then a crash: <system-prompt-editor> never renders on options.html#prompts (Settings drift); kept for bisecting" },
  "thread-open-trace.ts": { class: "manual", reason: "a tracing probe for thread-open latency (3/3 matrix rows at the re-inventory); evidence only" },
  "tool-call-evidence.ts": { class: "manual", reason: "the tool-call legibility evidence run (28/6 in --mode=tree at the re-inventory, then a DOM.focus crash; --mode=raw is the deliberate pre-fix repro); screenshots" },
  "validate-package-load.ts": { class: "manual", reason: "loads the PACKAGED build (scripts/evidence-runner.sh gate 18 after gate 17 packages it)" },
  "verify-script-run.ts": { class: "manual", reason: "a verification probe for the script-run path; evidence only" },

  // ── helpers ─────────────────────────────────────────────────────────────
  "mcp-test-server.ts": { class: "helper", reason: "a local MCP server the MCP KATs spawn; not a harness" },
};

/** A KAT file: kat-*.ts, except the runner that executes them. */
export function isKat(file: string): boolean {
  return file.startsWith("kat-") && file !== "kat-runner.ts";
}

/** The KATs the runner executes, in registry order. */
export function activeKats(): string[] {
  return Object.entries(HARNESSES).filter(([f, e]) => isKat(f) && e.class === "kat").map(([f]) => f);
}

/** The KATs set aside with a reason (none today: every KAT runs). */
export const RETIRED_KATS: ReadonlySet<string> = new Set(
  Object.entries(HARNESSES).filter(([f, e]) => isKat(f) && e.class === "manual").map(([f]) => f),
);

const SCRIPTS = new URL("../", import.meta.url).pathname;

/** Every top-level scripts/*.ts (the harnesses; lib/ is not a harness). */
export function harnessFiles(): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(SCRIPTS)) {
    if (e.isFile && e.name.endsWith(".ts")) out.push(e.name);
  }
  return out.sort();
}

export function katFiles(): string[] {
  return harnessFiles().filter(isKat);
}

/** The last verdict the KAT runner recorded for every KAT it executed, keyed
 * by file: `{ "kat-x.ts": { exit, at, ms, expectedRed } }`. Written by
 * scripts/kat-runner.ts after each KAT; read by tests/harness-registry.test.ts
 * so a KAT that has gone green while still listed expected-red fails
 * `deno test` too, not only the runner (CAP-FB-20260902-KAT-AGENT-DELEGATION-RED-01).
 * Gitignored (.cache/); absent on a machine that has not run the KATs. */
export const KAT_VERDICTS_PATH = new URL("../../.cache/kat-verdicts.json", import.meta.url).pathname;

export interface KatVerdict {
  exit: number;
  at: string;
  ms: number;
  expectedRed: string | null;
}

export function readKatVerdicts(): Record<string, KatVerdict> {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(KAT_VERDICTS_PATH));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The KATs listed expected-red whose LAST recorded runner verdict was green —
 * each is a stale listing to remove (with its redReason). */
export function staleExpectedReds(verdicts: Record<string, KatVerdict> = readKatVerdicts()): string[] {
  return Object.entries(HARNESSES)
    .filter(([f, e]) => isKat(f) && e.class === "kat" && e.expectedRed && verdicts[f]?.exit === 0)
    .map(([f, e]) => `${f}: green at ${verdicts[f].at} (listed expected-red, owner: ${e.expectedRed})`);
}
