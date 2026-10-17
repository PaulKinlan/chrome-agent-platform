# chrome-agent-platform-re8v7 — the beads export checker reads with no fixed buffer ceiling

## Deliverable & Scope
- Code: `scripts/check-beads-export-divergence.mjs` — the two reads that used a fixed
  `maxBuffer: 16 * 1024 * 1024` (`git show HEAD:.beads/issues.jsonl` and
  `bd export --all`) now collect stdout from a streamed child and are bounded by wall
  clock (30 s), not by a byte constant.
- Tests: `tests/beads-export-divergence.test.ts` (4) — a committed *and* canonical
  export past the old ceiling is read in full; a >16 MiB canonical export that would
  drop an ID is still refused and names the ID; no executable `maxBuffer` may return.
- Deliberately NOT changed: whether lane commits keep refreshing the 16.8 MB passive
  export at all. That is a hook-contract decision owned by coord/architect and tracked
  in `chrome-agent-platform-7unpg`; this change only removes the size cliff.

## Why it blocked every lane
`spawnSync` died with `ENOBUFS` once a read exceeded 16 MiB. On 2026-10-17 the
canonical export was 16,863,729 B and the committed snapshot 16,754,718 B, so the
pre-commit hook refused commits across the fleet; the workaround in use was
`--no-verify`, which bypasses the divergence guard the hook exists for.

## Measured, on the real export in this worktree (not a fixture)
- `origin/main`'s checker: exit 1,
  `[beads-export] cannot verify committed IDs: bd export --all failed: spawnSync bd ENOBUFS`.
- This branch's checker: exit 0,
  `[beads-export] OK: all 1657 committed/on-disk issue IDs exist in the canonical DB (1669 IDs)`
  (5.5 s wall, dominated by the real `bd export --all`).
- The commit that carries this change passed the installed pre-commit hook, which ran
  the new checker against that same over-16-MiB export.

## Falsification (two-state, executed)
- RED with `origin/main`'s `scripts/check-beads-export-divergence.mjs` restored:
  `tests/beads-export-divergence.test.ts` **0 passed | 3 failed**, both behavioural
  cases failing with `git show HEAD:.beads/issues.jsonl failed: spawnSync git ENOBUFS`.
- GREEN with the branch script: **3 passed | 0 failed** (2 s).
- The refusal case is the anti-overfit half: at the same >16 MiB size, dropping
  `cap-drop-me` from the canonical export still exits 1 and names it, so "stream and
  stop checking" cannot pass.
- A fourth case pins usage validation before any read, and spells the repo-relative
  script path inline so a coverage oracle can place this file: fleet's
  `check-coverage.py` subprocess pattern does not recognise `spawnSync(`, so the
  first version of this file was reported "unmapped" while the repo's own manifest
  in the SAME log said `status=mapped`. Filed as fleet defect `fleet-8ymew`.

## Scratch placement
The fixture's two 16.9 MB exports are `durableDir("re8v7-beads-export")`-routed and
removed in the test's own `finally` — `tests/durable-root.test.ts` red-lit the first
version of this file for using the OS temp dir, which is the guard working.
`tests/durable-root.test.ts` 22/0 and `tests/beads-export-divergence.test.ts` 3/0 on
this tip.

## Cost
`tests/beads-export-divergence.test.ts` measured 2 s (one 16.9 MB fixture string built
once per run, ~37k rows). It is not in the always-on set, so it runs when its own file
or the checker changes.

## Raw logs (outside the repo, as the fleet convention)
`/home/exedev/cap-evidence/imp-guard-20261017/`
- `re8v7-RED.log` sha256 `277457489d5bc6f19425f47e5bc37fd9d0fb88a71ac89f68ec04f97de0720ef2`
- `re8v7-GREEN.log` sha256 `ab9da39039722beb68696ceeb7e07e73d4d73fcfa8cefff6be957f3ab9a0ee34`

(They are raw `.log`/`.err` files: `scripts/lib/content-exemptions.mjs` does not exempt
those extensions, so committing them would fail the fast gate closed to the full suite
for every later lane edit. That is also why the earlier run's `cap-evidence/**` was
removed from the branch.)
