# u0cc follow-ups — falsification and evidence record

Two beads I filed while working `chrome-agent-platform-u0cc`, both fixed on branch
`cap/u0cc-followups` (isolated worktree `/home/paulkinlan/worktrees/cap-u0cc-followups`,
base fetched `origin/main` 0c387326). Local only: no PR, no merge, no push.

## `chrome-agent-platform-mdhs` — `deno.lock` missing `jsr:@std/path@1`

Root cause corrected while fixing: the trigger is **not** a runner test run. `deno.runner.jsonc`
sets `"lock": false` on purpose ("never rewrite deno.lock from a test run"), so the gate never
touches the lock; a bare `deno check`/`deno run` of a repo file resolves `jsr:@std/path@1`
(the four importers use `@std/path@1/from-file-url`) and adds the entry.

| state | command | observed |
|---|---|---|
| BEFORE (entry absent, as on `origin/main`) | `deno check tests/acp-runner.test.ts` | `deno.lock` rewritten: sha256 `b0eb376d3822…` → `dc010ba0c216…` |
| AFTER (entry present) | the same command | `deno.lock` byte-identical (`dc010ba0c216…`), clean against HEAD |

The mutant above is the falsification: remove the entry and the drift returns, byte for byte.
No gate is needed for a lockfile completion; the control run proves the fix.

## `chrome-agent-platform-1mz2` — any commit invalidates the built tree

Root cause corrected while fixing, and it is broader than the bead said: the marker binds
**HEAD** as well as every indexed source byte, so it is not the version bump that invalidates a
build — *every commit does*. Measured directly: after a bookkeeping commit with **no** version
change, `validateDistCompleteMarker` reported `marker commit is stale` (the version bump only
adds a second reason). The hook's `git commit --amend` moves HEAD a second time inside the same
commit.

What changed:
- `scripts/dist-complete.mjs` — both staleness verdicts keep their pinned front and now carry
  the cause and the exact fix (`… rebuild before the gate: npm run build:production`).
- `scripts/dist-staleness-note.mjs` (+ `npm run check:dist`) — validates the marker against the
  target it was built for, prints one actionable line when stale, stays silent when current or
  absent, and always exits 0: a note, never a gate (~0.2 s).
- `scripts/git-hooks/post-commit` — runs the note after the amend, so the cause is printed in
  the commit's own terminal. Installed into the common `.git/hooks` on this machine.
- `AGENTS.md` — the worktree setup now says `npm run build:production` (the serial phase needs
  the STORE target; `npm run build` is developer-only) and both the setup list and the gate
  ladder state the invariant: rebuild after the LAST commit, before `npm test`.
- `tests/dist-staleness-note.test.ts` — pins the note against scratch git repos: silent with no
  marker, silent when current (so it is not always-on), names the fix once a commit invalidates
  it, carries the fix in both marker verdicts, judges a developer build against itself, and
  exits 0 in every case.

Two-state evidence (real repo, real serial-phase reader):
`cap-evidence/u0cc-1mz2-before-state.txt` (stale: the note names the fix; the serial test reds
with the same actionable message) and `cap-evidence/u0cc-1mz2-after-state.txt` (after
`npm run build:production`: the note is silent and the same test is 23 passed / 0 failed).

Live hook proof — the commit that lands this fix printed, in its own terminal:

```
[bump-version] commit note "…" does not pass user-facing filter — NOT bumping version …
[dist] the built extension is stale against this tree: dist.complete validation failed: marker commit is stale — …
[dist] rebuild before the gate — npm run build:production  (npm run check:dist re-checks)
```

Mutation evidence (`npm run test:file -- tests/dist-staleness-note.test.ts`, each mutant applied
to a saved copy and restored):

| # | mutation | observed |
|---|---|---|
| M1 | the note claims stale without validating (unconditional) | FAILED (1 passed / 2 failed) |
| M2 | the two marker verdicts lose the fix guidance | FAILED (2 passed / 1 failed) |
| M3 | the note exits non-zero when stale | FAILED (1 passed / 2 failed) |
| M4 | the note never prints | FAILED (2 passed / 1 failed) |

Partition guard: the new test touches only scratch repos, and
`npm run test:file -- tests/test-partition-guard.test.ts` is green (5 passed) with it in the
parallel phase.
