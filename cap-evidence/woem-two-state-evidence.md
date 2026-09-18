# woem — two-state evidence and standing controls

Bug: the fresh-checkout materialization in `tests/evidence-durable.test.ts` copied `git ls-files` (the TRACKED
set) plus one explicitly named ignored evidence tree. A candidate that ADDS a source module therefore
materialized without it, the child generator died with `ERR_MODULE_NOT_FOUND`, and the "fresh checkout" evidence
described a tree the candidate never built — a fixture failure that reads like a product red. (The original
trigger, `scripts/lib/emit-frozen-data.mjs`, is gone from main; the mechanism is what this pins.)

## Reproduction on 53e28546 (pre-fix fixture)

Recipe (temporary, reverted afterwards — the repo must not be left dirty):

1. `printf 'export const WOEM_PROBE = true;\n' > scripts/lib/woem-probe-untracked.mjs` — an untracked,
   non-ignored source module.
2. Insert `import { WOEM_PROBE } from "./lib/woem-probe-untracked.mjs"; void WOEM_PROBE;` into the tracked
   `scripts/build-bundled-tool-packages.mjs` **after its shebang** (a probe inserted before line 1 makes Node
   reject the file with a SyntaxError instead — that mistake produced one wrong "reproduction" during this
   work and is recorded here so nobody repeats it).
3. Run `npm run test:file -- tests/evidence-durable.test.ts` against the PRE-FIX fixture.

Observed (pre-fix):

```
fresh-checkout: FULL verify (not fallback) passes on a pristine tree materialization with no /tmp evidence ... FAILED
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/tmp/a47127f343c1dbbd/scripts/lib/woem-probe-untracked.mjs' imported from
  '/tmp/a47127f343c1dbbd/scripts/build-bundled-tool-packages.mjs'
  code: 'ERR_MODULE_NOT_FOUND'
FAILED | 1 passed | 1 failed
```

Observed (post-fix, same probe, same command):

```
no text artifact references paths outside the source tree (/tmp, /home) ... ok
fresh-checkout: FULL verify (not fallback) passes on a pristine tree materialization with no /tmp evidence ... ok
ok | 2 passed | 0 failed
```

So the two states differ only by the materializer, with everything else — including the untracked dependency —
identical.

## Standing controls (`tests/source-materialization.test.ts`, hermetic)

Each case builds its own scratch git repo under the durable root; none of them dirty the checkout.

| control | what it asserts |
| --- | --- |
| untracked dependency | the closure includes it, it is COPIED, the copy carries no ignored content, and the materialized entry **runs** (`node dest/src/entry.mjs` prints `DEP-OK`) |
| missing listed source | a tracked file deleted from the working tree makes the materialization **fail closed** with "missing on disk" |
| ignored inputs | ignored `scratch/` and `node_modules/` never enter the closure; a NAMED evidence root does; the closure is deterministic |

Plus the negative control inside `tests/evidence-durable.test.ts`: with a required source module
(`scripts/lib/shared-strings.mjs`) removed from the materialized tree, the real `--verify` run must exit non-zero
— so a materializer that copies nothing (or a verifier that treats a degraded input as green) cannot look
healthy.

## Falsification of the helper's guards

| mutant | observed |
| --- | --- |
| tracked-only enumeration (`git ls-files`, the pre-fix set) | `AssertionError: the untracked dependency is missing from the closure: [".gitignore","src/entry.mjs"]` — 1 failed |
| silently skip a listed file missing on disk (`continue` instead of throw) | 1 failed (fail-closed control) |
| drop `--exclude-standard` | `AssertionError: ignored scratch entered the closure` — 2 failed |
| restored | `ok | 3 passed | 0 failed` |
