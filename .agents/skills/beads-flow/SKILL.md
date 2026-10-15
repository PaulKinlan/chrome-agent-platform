# Skill: beads-flow — pick up and ship the next piece of work

The fast loop for this repo: pick a bead, work it in isolation, gate it, ship it.
Every agent (this session, a fresh subagent, a different model) follows the same loop.

## 0. Orient (30 seconds)
```
git fetch origin
bd -C <repo> ready            # the claimable frontier — no open blockers
bd -C <repo> list --status in_progress   # what is already in flight (don't duplicate)
```
Pick the highest-priority ready bead that nobody else has claimed. Skip beads
already claimed by another lane (check `bd list --status in_progress`).

## 1. Claim + isolate
```
bd -C <repo> update <id> --claim
git worktree add <durable-path>/<short-id> -b cap-beads-<short-id> origin/main
cd <worktree> && deno install && npm install && npm run build
```
Never work in the shared primary checkout. Never push to main yourself.

## 2. Check for prior art (features land between filing and pickup)
```
git log origin/main --oneline --grep <feature-keywords>
git log origin/<prior-art-branch> --oneline   # if the bead names a branch
```
- Behavior already COMPLETE on main → add falsification tests that pin the
  contract (each must fail if the behavior regresses), push, close with evidence
  of what exists where. Do not re-implement.
- Behavior PARTIAL → implement only the missing remainder, on top of what exists.

## 3. Implement
- Follow AGENTS.md hard rules (constitution, CSP, OPFS origin-keying, no inline
  scripts, textContent not innerHTML, components not one-offs).
- Every fix ships with falsification-gated tests: RED without the change, GREEN
  with it. An assertion never observed failing is not evidence.
- **Never run `git stash` in a worktree.** Stashes belong to the repository,
  not the worktree; another lane can pop your edit (or you can pop theirs).
  For a regular source file, use ignored `.cap-scratch/` copies instead:
  ```sh
  path=extension/lib/threads.js # replace with the file under test
  mkdir -p .cap-scratch/red-green
  scratch=$(mktemp -d .cap-scratch/red-green/XXXXXX)
  cp -- "$path" "$scratch/edited"
  trap 'cp -- "$scratch/edited" "$path"' EXIT # restore even if RED exits nonzero
  if git cat-file -e "origin/main:$path" 2>/dev/null; then
    git show "origin/main:$path" > "$scratch/base"
    cp -- "$scratch/base" "$path"
  else
    rm -f -- "$path" # a new file must be absent for RED, not empty
  fi
  # Run the focused test and capture the intended RED.
  cp -- "$scratch/edited" "$path"
  trap - EXIT
  # Re-run the focused test and capture GREEN.
  ```
  a path that does not exist on origin/main (a file your fix ADDS) has no base to copy - git show fails and the redirect leaves an empty file; for those, RED is rm -f $path and GREEN is cp -- $scratch/edited $path.
  Save each changed file separately; do not pop/drop old stashes to clean up.
- Found a NEW bug/blocker along the way? File it NOW, linked to what you were doing:
  ```
  bd -C <repo> create --title "..." --description "observed + repro + acceptance" --priority <n>
  bd -C <repo> link <new-id> <current-id> --type discovered-from
  ```
  Then get back to your task. Never silently absorb or ignore a discovered defect.

## 4. Gate — ONE COMMAND AT A TIME, output to a log, read the tail before the next
For a RED/GREEN gate, use the §3 file-copy procedure and restore edits before
GREEN. **Never `git stash` to switch versions**: another worktree shares the
same stash stack, even while its test is running.
```
npm run build  > /tmp/build-<short>.log 2>&1; tail -3 /tmp/build-<short>.log
deno test --allow-all tests/ > /tmp/test-<short>.log 2>&1; tail -5 /tmp/test-<short>.log
```
The full suite takes 5-10 minutes. That is normal — never interrupt it, never
skip it. A red gate is information, not an obstacle.

## 5. Ship
- Commit with a plain user-facing subject (what changed for the user; no tracker
  ids, no lane names). Reference the bead id in the subject when it closes one.
- `git push -u origin <branch>`
- Close the bead ONLY if the complete fix (or complete test-pinning for a
  pre-existing feature) is on the pushed branch. Otherwise:
  `bd comment <id> "remaining: ..."` and leave it open/in_progress.
- `bd dolt push` (a post-commit hook usually does this).

## 6. Review (coordinator runs this)
A DIFFERENT model/session reviews the diff against the claims, falsification-focused.
REVISE findings come back as exact per-finding fixes; repeat until PASS. Only the
coordinator merges to main, after re-running the gates on the merged tree.
