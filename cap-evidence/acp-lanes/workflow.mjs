// cap-evidence/acp-lanes/workflow.mjs — the lane fan-out for "start on all".
// Every child works ONE bead, in its own git worktree off origin/main, runs the
// repo gates, and commits on its own branch. Nothing merges: the coordinator
// verifies each delivery against the claims and lands it.
//
// Kept on disk (AGENTS.md recovery rule): the text that ran is the text that
// gets retried.

const RULES = `
REPO RULES (read /home/paulkinlan/chrome-agent-platform/AGENTS.md first — it is binding):
- You are in a managed git worktree on your own branch off origin/main. Work only there.
- beads (bd) is the ONLY tracker: \`bd show <id>\` for the task's full intent; add findings as comments; do NOT create markdown trackers.
- Gates: \`npm run test:file -- tests/<file>.test.ts\` while iterating, \`npm run test:changed\` per change, and \`npm test\` ONCE before you finish. A raw \`deno test tests/\` is refused by this repo.
- Every NEW assertion needs a mutant you observed failing (falsification), reported by assertion + message.
- UI work is verified in a REAL loaded extension (headless Chrome + CDP, evidence under cap-evidence/), never "it serves".
- Commit on your branch with the bead id in the subject: "chrome-agent-platform-<id>: <what the user gets>". DO NOT push to main, DO NOT open a PR, DO NOT merge.
- Report back: branch, commit sha, the exact gates you ran with their numbers, the mutants, and anything you could NOT do.
`;

const TASKS = [
  {
    key: "approval",
    task: `${RULES}
WORK ITEM: chrome-agent-platform-9mz1 (P1 [bug]) "Permission prompt says 'approvals are available only in Settings' for an already-granted action".

The owner hit this live: an agent ran asset.update, the surface said "Permission request — The agent wants to asset.update: <id>. approvals are available only in Settings", the capability was ALREADY granted to the extension, and there was no way to approve inline.

Two defects to fix, in this order:
1. An approval the extension ALREADY holds must not raise a blocked state at all — the action proceeds.
2. When a decision genuinely is needed, render the decision INLINE in the surface that raised it (the repo's existing approval card / appendApproval / permission-approval-card machinery in extension/shared/components.js), with the Settings route as a secondary link — never "only in Settings". This is the repo's own rule (AGENTS.md: "Ask for permissions on need, never fail silently").

Start by finding the path that produces the "available only in Settings" text (grep for it) and the requirement/approval decision in extension/background/service-worker.js for asset.update. Reproduce it first (a focused test that currently fails), then fix, then prove the fix with a real browser check in the loaded extension (the side panel + hub both render approval cards already — reuse that component, never hand-roll a second one).

DO NOT: widen any permission to make the prompt disappear.`,
  },
  {
    key: "acp-permissions",
    task: `${RULES}
WORK ITEM: chrome-agent-platform-e24e (P1) "ACP interactive permission cards (Allow/Deny) instead of auto-grant".

Today the ACP path auto-approves: extension/lib/acp-client.js _handleAgentRequest picks the first /allow/-matching option and answers immediately, and extension/lib/acp-runner.js passes NO permissionHandler. So an external harness (pi/claude/codex) can run shell and file commands with no owner gate.

Deliver: the runner passes a permissionHandler that renders ONE inline Allow/Deny card in the conversation for the requested tool call (reuse the existing permission/approval card components — do not hand-roll), waits for the owner's click, and returns the chosen optionId to the harness. A denied action must be reported honestly in the transcript; a card that is never answered must not leave the turn hanging forever (state the timeout behaviour you choose and why).

Tests: unit-test the client's answer path with an injected permissionHandler (option chosen, denial, no-answer), and add a falsification mutant for each new assertion. Keep the auto-grant available ONLY as an explicit mode (kv \`acp.permissions\` = "auto" | "ask"), and make "ask" the default.

DO NOT change the ACP wire protocol, and do not remove the existing auto-grant path — it stays as the explicit mode.`,
  },
  {
    key: "slow-open",
    task: `${RULES}
WORK ITEM: chrome-agent-platform-h638 (P2 [bug]) "Opening a RUNNING task from the task list is slow".

The owner: "clicking on a task in the task list that is currently running takes way too long to open."

FIRST MEASURE, then fix — do not guess. Profile the open path in a real loaded extension (CDP timing around the task-row click: the repo's harness pattern in scripts/), record the numbers in the bead, THEN optimise, then re-measure the same way and report before/after. State the budget you are holding yourself to.

Hypothesis to confirm or kill: the open waits on live-run material (durable run-log read + run-registry snapshot + transcript projection) before painting anything, when the journaled transcript is already the authority on disk. If confirmed, paint the journaled transcript first and let the live tail reconcile afterwards, respecting the existing ownership/fence rules (runSurfaceOwner, the terminal-reconciliation rules) — a stale run must never paint into a newer surface.

DO NOT: drop the live-run binding (Stop and the live status row depend on it) or weaken an existing fence to make it fast.`,
  },
  {
    key: "acp-persistence",
    task: `${RULES}
WORK ITEM: chrome-agent-platform-hg03 (P2) "Persist ACP harness turns into the CAP task/thread store".

Today extension/ntp/ntp.js's ACP branch calls runAcpTaskTurn directly and creates no SW thread: the result has no threadId, nothing is journaled, and the hub task list never shows an ACP turn (the harness keeps its own session, but CAP-side history is lost when you leave the surface).

Deliver: an ACP turn from the hub or the pi surface creates a real task row that appears in the task list and reopens with its transcript after a page reload; the durable run is visible to the run registry so the shared run controls (and Stop — chrome-agent-platform-c6gq, which depends on this) can see it. Reuse the existing thread/journal/run routes that runConversationTurn already uses — ONE source of truth, no second task store. Keep the ACP wire protocol and the session-continuity behaviour untouched.

Tests: the runner's return carries the thread it journaled into; a focused test proves the thread row + journal entry are created; a mutant kills the journaling call-site. Then verify in the loaded extension: run an ACP turn (the fixture adapter is fine), reload, and confirm the task is listed with its transcript.`,
  },
  {
    key: "budget",
    task: `${RULES}
WORK ITEM: chrome-agent-platform-ehsl (P2) "Store service-worker bundle is ~10 bytes under its budget".

The store build currently reports 2,999,994 <= 3,000,000 — any new service-worker code fails the build. Reclaim headroom by REDUCING bytes, never by raising the budget: candidates are (a) building the ACP registry rows from the bridge's harness table at runtime instead of a literal list, (b) moving a feature behind a lazily-imported module, (c) trimming other SW literals. Measure with \`npm run build:production\` (the budget line prints the number) and report before/after. Aim for at least a few hundred bytes of headroom.

DO NOT: touch scripts/bundle-budget.mjs's number, delete a test, or weaken the budget check.`,
  },
];

const children = TASKS.map(({ key, task }) => ({
  key,
  agent: "worker",
  task,
  isolation: "worktree",
  output: `cap-evidence/acp-lanes/${key}-report.md`,
}));

const results = await runs.all(children);

return results.map((r, i) => ({
  key: TASKS[i].key,
  status: r?.status ?? "unknown",
  summary: (r?.output ?? r?.summary ?? "(no summary)").slice(0, 4000),
  outputReference: r?.outputReference ?? null,
  artifactPaths: Array.isArray(r?.artifactPaths) ? r.artifactPaths : [],
}));
