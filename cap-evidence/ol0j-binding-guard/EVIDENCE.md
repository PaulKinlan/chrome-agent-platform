# chrome-agent-platform-ol0j — lexical-binding guard for the pinned Doc denial

**Candidate:** this branch. **Base:** origin/main 0c387326. **Date:** 2026-09-18.

## What shipped
- `scripts/lib/dynamic-evaluator-scan.mjs` — the bounded binding classifier (preserved from
  cap-evidence/astra/emscripten-admission-development-20260907/iteration-5/source-final/, byte-identical).
- `scripts/lib/scrub-zod-doc.mjs` — the pinned Doc.compile denial + the ol0j guard: a hash-matched
  Doc class body is rewritten ONLY when its `new F(...)` node is a recognized global evaluator
  (`evaluators.has(body.body.at(-1).argument)`).
- `tests/scrub-zod-doc.test.ts` — 6 tests (below).

## RED -> GREEN (falsification)
`scrub-zod-doc.prefix-broken.mjs` is the pre-fix scrub (iteration-4 = 48d3abcb shape: class-body
hash only, no lexical guard). With it swapped in, the 4 shadow tests RED (denied count 1 on a
parameter-bound `Function`, code rewritten), the 2 global-denial tests stay green (the broken
scrub denies globals fine — that was never the defect). Restored: 6/6 green.

## The pins have real teeth (live probe, developer bundles, this worktree 2026-09-18)
Fixed scrub over the actual built bundles:
- background/service-worker.js: 3 evaluator sites -> 0, denied 3
- workers/agent-worker.js: 3 -> 0, denied 3
- options.bundle.js: 2 -> 1, denied 1 (the survivor is the zod `const F=Function; new F("")`
  capability probe — NOT a Doc.compile body; that is 4f3j's scope: Options is excluded from the
  current regex scrub loop)
- shared/diff-core.bundle.js: 0 sites

NOTE: the class-body pins match PRE-minify emitted bytes (identifier names are pinned). The scrub
must run pre-minify (the pipeline's scrub loop position); post-minify bytes have renamed
identifiers and the pins correctly do not fire there — the final AST gate (kdax) owns post-minify.

## Gates
- `npm run test:file -- tests/scrub-zod-doc.test.ts`: 6/6 green.
- `npm run test:changed`: 64 passed / 0 failed.
- `npm test`: 4277 passed / 1 failed — the one failure is the known jp78/rgsx acp-runner RESUMES
  flake (this branch predates the jp78 fix; reviewed PASS separately today).
