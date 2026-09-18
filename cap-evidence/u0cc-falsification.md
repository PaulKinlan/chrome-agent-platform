# u0cc falsification record — a failed ACP session/load must not be a silent new conversation

Candidate: branch `cap/u0cc-resume-truth`, commit `a3e1118a` (see the branch tip; this
fix's later harness edits are in the tip commit).
Tree: isolated worktree `/home/paulkinlan/worktrees/cap-u0cc-resume-truth`, off fetched `origin/main` 0c387326.

## Two-state evidence (the real path, not a test-only shape)

`cap-evidence/acp-resume-failure-probe.ts` drives `runAcpTaskTurn` through the real
loopback bridge + the deterministic fixture adapter (no pi, no tokens), with a stored
session id the harness no longer holds (`ses_gone_stale` → the fixture rejects
`session/load`).

| state | captured output | observed |
|---|---|---|
| BEFORE (origin/main runner) | `cap-evidence/u0cc-before-state.txt` | `resumed:false`, no restore note rendered, no `resumeFailed` field; 2/6 checks FAIL (`exit 1`) — the fallback silently became the conversation |
| AFTER (this candidate) | `cap-evidence/u0cc-after-state.txt` | `resumed:false`, `resumeFailed:true`, `resumeError:"session ses_gone_stale is gone"`, system note rendered before the fresh reply; 6/6 checks PASS (`exit 0`) |

Both captures are byte-for-byte reproducible with
`deno run -A cap-evidence/acp-resume-failure-probe.ts` (exit 1 before, 0 after).

## Mutants (each must red the pin in `tests/acp-runner.test.ts`)

| # | mutation of `extension/lib/acp-runner.js` | expected failure | observed |
|---|---|---|---|
| M1 | the surface note is removed | the surface is never told | FAILED (1 failed, 0 passed) |
| M2 | note kept, `resumeFailed` dropped from the result | the fallback is not distinguishable | FAILED |
| M3 | the load failure is rethrown instead of falling back | the turn is blocked (hard failure) | FAILED |
| M4 | the note becomes unconditional | a first turn gets a restore note it must not get | FAILED |
| M5 | `resumed = true` set after a failed load | a failed resume reported as a resume | FAILED |
| M6 | the load error swallowed without setting `resumeFailed` | silence again | FAILED |

Command per mutant (the runner file was restored from a saved copy after each):
`CAP_TEST_RUNNER=1 deno test -A --config deno.runner.jsonc tests/acp-runner.test.ts --filter "u0cc"`

## Cross-file leak check (the jp78 class)

An earlier revision of this pin set a `CAP_ACP_FIXTURE_FAIL_LOAD` env switch and read a
`CAP_ACP_FIXTURE_LOG` frame count. Under `deno test --parallel` (one process for all
files) that leaked into `tests/acp-end-to-end.test.ts` and red it — the exact class
`chrome-agent-platform-jp78` documents (removing that lane's separate fix was NOT the
intent here).

Fixed in this candidate: the fixture induces the failure by SESSION ID (`ses_gone…`),
not process env; the pin reads no frame log at all (it proves the same facts through
the result, the rendered note, and the store); and the standalone probe keeps the
frame-level observer in its own process.

Verified together in ONE process (the shape that leaked):
`deno test -A --config deno.runner.jsonc tests/acp-runner.test.ts tests/acp-end-to-end.test.ts`
→ 18 passed, 0 failed, 1 ignored.

## Gates (captured logs under /tmp on this host; counts here)

| gate | result |
|---|---|
| `npm run test:file -- tests/acp-runner.test.ts` | 17 passed, 0 failed (380ms) |
| `npm run test:changed` | serial phase GREEN; parallel 4272 passed / 1 failed / 1 ignored — the failure is `tests/acp-runner.test.ts:129` (the pin at `turn 2 RESUMES…`), the load-sensitive process-env leak already filed as `chrome-agent-platform-jp78` (merger's lane). Same pin 1/1 GREEN three times in isolation on this tree. |
| `npm test` (once) | **GREEN — 4273 passed, 0 failed, 1 ignored, 463 files, wall 127s** |

Worktree note (unrelated to this fix, hit while gating): a fresh worktree built with
`npm run build` reds the serial phase on `dist.complete … marker indexed source authority is
stale` after the commit hook bumps the version, and `tests/emscripten-abi-loaded-harness.test.ts`
needs a **store** build. `npm run build:production` before the suite is the fix.
