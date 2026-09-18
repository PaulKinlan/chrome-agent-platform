# chrome-agent-platform-tptx (+4f3j, absorbed) — Doc.compile denial wired over all four bundles

**Candidate:** this branch (stacked on cap/ol0j-doc-denial-binding @ 311a4246). **Date:** 2026-09-18.

## The change
`build.mjs` scrub loop now covers `[SW, WORKER, OPT, DIFF_CORE]` (was SW/WORKER/DIFF_CORE)
and applies `denyZodDocCompiles` (ol0j-fixed) to each bundle pre-minify. Build report:
`removed 2 new-Function + 7 probes + 7 pinned Doc.compile methods`.

## Behavior change (explicit, per coord's collapse condition 1)
OPT moves from zod's JIT path to its jitless interpreter path BY DESIGN: the scrubbed probe
throws inside zod's own `try/catch` (`util.allowsEval`, util.js:119), consumers gate JIT on it
(schemas.js:781-783), and `core.globalConfig.jitless` is the supported user knob for the same
path. SW/WORKER/DIFF_CORE were already jitless on main (probe regex-scrubbed); their surviving
Doc.compile aliases were unreachable dead code. **OPT was the only bundle still JIT-ing.**
- Parity proof: tests/zod-jitless-fallback.test.ts — scrubbed zod/v4 bundle validates
  byte-identically to unmodified zod and to `z.config({ jitless: true })` across a nested/
  union/discriminated-union/refinement/transform/default/email battery incl. failure issues.
- Perf delta (measured, single sample, informational — not gated): 2000 parses of a 9-field
  schema: jitless 4.1ms vs jit 3.6ms (ratio 1.15x) on a loaded fleet box.

## Final-output proof (evidence-level; permanent gate = kdax)
Post-minify store bytes (dist-versions/v-837284-1789721873622), bounded classifier:
service-worker.js 0, options.bundle.js 0, diff-core.bundle.js 0, agent-worker.js 0 evaluator
sites. (Same probe on unmodified main found 8: SW 3, OPT 2, worker 3.)

## Falsification (bypass drill)
With `denyZodDocCompiles` bypassed in build.mjs, tests/store-doc-denial.test.ts goes RED at the
tooth assertion (build log reports `0 pinned Doc.compile methods`, failing `[1-9]`); the same
bypass leaves 8 classifier sites in the final bytes (measured on unmodified main during kdax
scouting). Restored: green.

## Gates
- test:file store-doc-denial: 1/1 (serial phase, real store build). test:file zod-jitless: 1/1.
- test:changed: serial phase (16 build/artifact files) GREEN in 166s; parallel 4278 passed /
  1 failed — the one failure is the known jp78/rgsx acp-runner RESUMES flake (branch predates
  the jp78 fix).
- npm test: 4279 passed / 0 failed / 1 ignored, 466 files, wall 174s.
- Developer build (`npm run build`): green with the wiring.
