# chrome-agent-platform-kdax — final evaluator AST gate: falsification evidence

**Candidate:** cap/kdax-final-evaluator-gate @ ca4ef457 (stacked on cap/tptx-doc-denial-wiring @ 1c595d77). **Date:** 2026-09-18.

## Gate scope decision (evidence)
`walkJs(STAGE)` (the worker's preserved design) would cover `wasm-tools/python/pyodide.asm.js`,
which carries 6 evaluator sites inside the SEPARATELY reviewed, manifest-hash-pinned runtime lane
(scripts/store-target-policy.mjs, "bundled-reviewed-only") — a false red the design never hit
because its build was already red on the zod sites. The gate therefore covers exactly the four
GENERATED bundles (SW / agent-worker / OPT / diff-core). Measured on the final developer dist of
this branch: all four 0 sites; pyodide.asm.js 6 (deliberately out of scope, hash-pinned lane).

## Source-scan upgrade safety
The classifier over all 259 shipped source files: exactly 1 site, in
`extension/sandbox/script-sandbox.js` — the pre-existing allowedDynamicEvaluatorFiles exemption.
Zero false positives.

## Drills (run AFTER committing ca4ef457, restored via git reset --hard — no in-place loss)
- **Drill A (injection, gate present):** build.mjs edited to append
  `const qe = globalThis.Function; new qe("return 1");` to the staged SW post-scrub (an alias
  the regex scrub cannot see). `npm run build` exit 1:
  `service-worker.js: dynamic source evaluator is forbidden (1 AST sites)`. The gate is what
  stands between an injected alias and publication.
- **Drill B (gate disabled + injection):** build exit 0 — publication WOULD proceed — and the
  tptx wiring test (tests/store-doc-denial.test.ts, independent final-bytes classifier scan)
  goes RED: `background/service-worker.js must carry no dynamic evaluator site`.
- Both drills restored; tree verified clean at ca4ef457; both test files green after restore.

## Gates (final state)
- test:file tests/build-evaluator-scan.test.ts: 2/2 (11 gap controls + 7 shadow controls,
  preserved from the worker's iteration-5 source, byte-identical).
- test:file tests/store-doc-denial.test.ts: 1/1.
- Store build: green, "removed 2 new-Function + 7 probes + 7 pinned Doc.compile methods",
  budget 2996116 <= 3000000. Developer build: green.
- npm run test:changed: 4281 passed / 0 failed / 1 ignored (serial 17 files GREEN; parallel 451 GREEN).
- npm test: 4281 passed / 0 failed / 1 ignored, 467 files, wall 229s.

## Chain
ol0j (311a4246, gemini review PASS) → tptx+4f3j (1c595d77) → kdax (ca4ef457). The whole chain
reviewed as one stack per coord seq 118. Landings via merger under the reviewed tip.
