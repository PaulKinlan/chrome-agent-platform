# UI batch — acceptance report

Implemented the 6-item owner P2 UI batch in worktree `/home/paulkinlan/worktrees/cap-ui-batch-0e887a8` (candidate `e427fb0ab24e9b8eaeea08d5ee0973d590761f84`, tree `7989b71332ef6427c82427a122efd5781763dafe`, base `0e887a8`/0.2.299).

All six items addressed; five required code changes, one (NTP add-agent) was already satisfied and is KAT-pinned. Full suite 1748/1748 green, `npm run build:production` RC=0, worktree clean (no staged files).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Six narrow, targeted edits: discovered-sites banner spacing (ntp.js), tool-library row bound 64->256 (tool-catalog-shadow.js + components.js), local-models nav+section+wiring removed (options.html/options.js), approvals nav+section+wiring removed (options.html/options.js), system prompt search-first + corrected tool signatures (master-skill.js). No security gates, permission model, or runtime-policy touched."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "5 new KATs (tests/ui-batch-20260826.test.ts) + 3 updated tests to the new contract; full suite 1748 passed 0 failed; npm run build:production RC=0; per-item notes in /tmp/cap-ui-batch-impl/WORKER.md."
    }
  ],
  "changedFiles": [
    "extension/ntp/ntp.js",
    "extension/lib/tool-catalog-shadow.js",
    "extension/shared/components.js",
    "extension/options/options.html",
    "extension/options/options.js",
    "extension/lib/master-skill.js",
    "docs/components.js"
  ],
  "testsAddedOrUpdated": [
    "tests/ui-batch-20260826.test.ts",
    "tests/owner-approval-security.test.ts",
    "tests/tool-library.test.ts",
    "tests/local-model-catalog.test.ts"
  ],
  "commandsRun": [
    {
      "command": "deno test --allow-all tests/",
      "result": "passed",
      "summary": "1748 passed (14 steps), 0 failed"
    },
    {
      "command": "npm run build:production",
      "result": "passed",
      "summary": "RC=0; seam scan clean; dist.complete marker"
    }
  ],
  "validationOutput": [
    "node --check passed for ntp.js, options.js, tool-catalog-shadow.js, master-skill.js, components.js",
    "5/5 new KATs pass",
    "bundled-package count verified honest: 26 manifests in bundled-inventory-data.js; UI reads bySource dynamically (no hardcoded '26')"
  ],
  "residualRisks": [
    "Dormant local-model modules (local-model-catalog.js/local-model-manager.js) + <local-model-catalog> component remain, no longer imported by options.js; full deletion is a separate cleanup and they stay unit-tested.",
    "Item 1 (NTP add-agent) required no code change — already satisfied; KAT-pinned only.",
    "Approvals SW routes kept intentionally (in-context reuse); only the Settings UI was removed."
  ],
  "noStagedFiles": true,
  "diffSummary": "94 insertions, 242 deletions across 11 files: hide local models + remove orphaned Approvals settings page (the bulk of deletions), tool-library row bound fix, system-prompt search-first rewrite, discovered-sites spacing, +5 KATs and 3 test updates.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "The system-prompt edit initially broke the template literal (stray backticks); fixed by removing inner backticks — MASTER_SKILL is 7045 bytes, within the 32 KiB cap, and its SHA-256 is recomputed at runtime (system-prompts.test.ts passes)."
}
```