# Committed Beads export vs canonical database (vf69)

`.beads/issues.jsonl` is a **passive snapshot**; Dolt is the tracker. A stale
snapshot can contain IDs no longer in the DB. Do not overwrite it silently, but
also do **not** bulk-import it: a deletion may have been intentional.

## Check before re-export

From the worktree being committed, run
`node scripts/check-beads-export-divergence.mjs`. It compares the union of
issue IDs in `HEAD:.beads/issues.jsonl` and the on-disk export against
`bd export --all`; it prints missing IDs and exits nonzero if one would
disappear. It makes no changes. A missing or empty *on-disk* export is
recoverable from the committed snapshot; a missing, empty, or malformed
*candidate* export is not. The tracked
`scripts/git-hooks/pre-commit` checks its already-generated candidate before
replacing/staging the export. On an older branch without the checker (or a
machine without Node) it skips the refresh, warns, and allows the commit;
it must not silently refresh an unverified snapshot. Hooks are installed in the *shared* Git directory,
not in each worktree; where they are not installed, run this command manually
before manually refreshing `.beads/issues.jsonl`. Write a temporary export
and atomically move it only after it succeeds and is nonempty; a failed/empty
export must not truncate or replace the committed snapshot.

For a missing ID, preserve the original Git ref and JSON line as evidence;
check `bd show`, `bd history`, `bd restore`, the Dolt history and related issue
references. Ask the issue owner whether it was deliberately deleted/retired.
Only after that decision should an individual record be recovered using
`bd import <single-record.jsonl>` and confirmed with `bd show` and
`bd export --all`. Never treat the committed export as an automatically
correct replacement for the canonical DB.

**Intentional deletion escape hatch (owner: `chrome-agent-platform-coord`):**
The project coordinator must record the deletion rationale, old Git snapshot
ref and exact removed issue IDs as a comment on a decision bead first. For
*that one commit only*, provide both environment variables inline to the
commit command (or inline to a manual pre-export check):

```sh
CAP_BEADS_EXPORT_APPROVED_REMOVALS=chrome-agent-platform-abc,chrome-agent-platform-def \
CAP_BEADS_EXPORT_DECISION_BEAD=chrome-agent-platform-DECISION-ID \
git commit -m 'Record coordinator-approved Beads removal'
```

The checker requires the allowlist to equal **exactly** the IDs absent from the
canonical DB and a nonempty decision-bead ID; it prints both to stderr for
review. It does not query the bead to authenticate the human decision — the
coordinator must make and verify that decision. A missing/partial/stale list,
or a missing decision reference, still blocks the commit. Never export this
setting persistently in a shell, use blanket `--no-verify`, disable the hook,
or import all historical issues just to make the check pass. On branches
without the checker or Node, the shared hook skips refreshing the passive
export and warns rather than silently erasing IDs.

## 2026-10-07 incident inventory

- The merger recovered `chrome-agent-platform-vyhl` individually from
  `origin/main:.beads/issues.jsonl` using `bd import`; `bd show` and
  `bd export --all` both confirmed it afterwards (vf69 bead comment,
  2026-10-06 17:51). No bulk import was done.
- At `origin/main` `8ed08a98`, the committed snapshot has **1,016** issue IDs;
  the live DB export has **1,052**, and **zero committed IDs are missing**. This
  satisfies the *current-tree* check, but not the historical disappearance
  question.
- The older committed snapshot at `51feb4a9` has **942** issue IDs.
  Comparing it with the same live DB still finds **59 historical-only IDs**,
  not 58. The earlier merger note's 58 count is not reproducible with these
  exact inputs; preserve the discrepancy rather than silently adjusting the
  inventory. These IDs no longer occur in the *current* committed snapshot,
  which is why the current-tree guard passes. `bd show`, `bd history` and
  `bd restore` returned not found for the missing IDs in the merger's earlier
  investigation; that does not distinguish intentional deletion from loss.
- **20 last recorded open — deletion/retirement not established:**
  `3kej`, `3p3e`, `3p3e.3`, `3p3e.8`, `3p3e.9`, `3p3e.11`, `3p3e.12`,
  `8das`, `9epn`, `9epn.6`, `9epn.10`, `9epn.11`, `9epn.12`, `bth6`, `d5ih`,
  `epfj`, `gg1o`, `jt7y`, `s06h`, `uf9l`. None has an exact-title duplicate
  in the live DB. These are **unresolved possible losses**, not automatically
  open work to recreate.
- **39 last recorded closed — closure is known, deletion intent unknown:**
  `3p3e.1`, `3p3e.2`, `3p3e.4`, `3p3e.5`, `3p3e.6`, `3p3e.7`, `3p3e.10`,
  `5vk4`, `716s`, `716s.1`, `716s.2`, `716s.3`, `716s.4`, `716s.5`,
  `716s.6`, `716s.7`, `716s.8`, `716s.9`, `716s.10`, `716s.11`,
  `716s.12`, `716s.13`, `914l`, `9epn.1`, `9epn.2`, `9epn.3`,
  `9epn.4`, `9epn.5`, `9epn.7`, `9epn.8`, `9epn.9`, `bd06`, `djft`,
  `gym6`, `kr97`, `l1ah`, `mxra`, `qvve`, `rtzf`. Do not equate a closed
  status with permission to erase the historical record.

The source of truth for owner decisions and any future per-ID recovery is the
`chrome-agent-platform-vf69` bead, not this document. This inventory records
what was observable at those exact snapshots, not a claim that any of the 59
were intentionally deleted or should be resurrected.
