# chrome-agent-platform-qazo — Wasm Tool Catalogue: status classification, verified against main

**Candidate:** branch `fleet/qazo` (tip SHA recorded on bead `chrome-agent-platform-qazo`).
**Base:** `origin/main` @ `2260ab3a` (2026-10-04).
**Date:** 2026-10-04.
**Lineage:** content salvaged from `origin/cap/gemini-qazo-wasm-catalogue-pipeline` @
`96c29265` (whose delta review PASSED at `f3e6dff27` + R1/R4), then re-verified
claim-by-claim against the current tree — `96c29265`'s base was `3a5d002f0`, 212
commits behind, and the Python runtime changed materially in between.

---

## 1. What this increment does

The catalogue (`docs/wasm-tool-catalogue.md`) is a status document. Two rounds of
independent review (`factory-opus`) found that its status words did not match the
code: lanes described as built with no shipped tool, a Tier-1 install path
described as built that did not exist, and items marked **SPECIFIED, NOT BUILT**
with no owning bead. This increment lands the salvaged classification and makes
the status words checkable by a gate that reads the doc.

The check is `tests/wasm-catalogue-status-truth.test.ts` (new), declared in
`SOURCE_INSPECTING_GUARDS` so it runs in every `test:changed` subset — a
docs-only diff selects no test otherwise (`scripts/select-tests.mjs` filters
`docs/` out of the changed set). It asserts:

1. every **BUILT** claim that cites a repo path names a path that exists;
2. every **SPECIFIED, NOT BUILT** item names an owning bead that exists in
   `.beads/issues.jsonl`, or is marked **PROPOSED**;
3. the §65 verdict is future-tense and claims no unbuilt lane;
4. the doc's Lane A census equals the manifests on disk.

## 2. Execution lanes (verified 2026-10-04)

- **Lane A — WASI Preview 1 command modules: BUILT.**
  `extension/lib/wasm-stream-files.js`, `extension/lib/tool-stream-platform.js`.
  `extension/wasm/manifests/` holds 38 manifests: **37** WASI command packages
  plus **1** call-export package (computed by the doc-truth test, not asserted).
  The doc no longer claims "bounded byte buffers": `extension/lib/wasi-preview1-runtime.js`
  states "no per-call IO byte cap"; what is bounded is memory32 `maxPages` and
  path/envelope bytes.
- **Lane B — call-export pure compute: BUILT.**
  `extension/lib/wasm-callexport-host.js`, registered in
  `extension/offscreen/offscreen.js`; closed under `chrome-agent-platform-uslb`.
  One shipped package: `cap.bundled.hash.blake3-1.0.0` (zero imports, entry
  `Hash_Calculate`), instantiated in-thread. The node-glue admits named as
  *proposed* are `awasm-noble` (bead `2uhx`, IN_PROGRESS) and `hash-wasm`
  (bead `3wei`, BLOCKED) — neither has a manifest, and no admit work is opened
  here.
- **Lane C — offscreen Pyodide runtime: BUILT (Python-only).**
  `extension/lib/python-host.js`, `extension/lib/python-runtime.js`; driven by
  `scripts/kat-pyodide.ts`. A fresh worker per run, hard timeout
  (`PYTHON_EXEC_TIMEOUT_MS`, 30 s) and `worker.terminate()`. It is **not** a
  pthreads build and the workers are threads, not process-isolated: the general
  Emscripten runtime with SharedArrayBuffer and killable pthreads stays
  **SPECIFIED, NOT BUILT** under epic `chrome-agent-platform-ltkj` (OPEN).
- **5-step admission pipeline:** each step's cited path exists —
  `extension/lib/wasm-package-authority.js` (`auditWasmBinary`),
  `extension/wasm/cas/`, `extension/wasm/manifests/`,
  `extension/wasm/licenses/`, `extension/wasm/sbom/`,
  `scripts/build-bundled-tool-packages.mjs`, `scripts/dist-complete.mjs`.

## 3. Python / Pyodide tiers (the material corrections)

`chrome-agent-platform-4p7j` **closed on 2026-10-03** (children `.1`–`.6`), and
its slices landed on main @ `788092d8`. The salvaged text was written before
that, so its Python statuses were re-derived from the tree:

- **BUILT today** — wheel storage and materialisation, not just the runtime:
  - OPFS owner-blob store `cap-owner-blobs-v1` holding `kind: "wheel"` blobs
    behind `wheel.list` / `wheel.put` / `wheel.delete`
    (`extension/lib/user-wasm-store.js`, `extension/background/service-worker.js`);
    pure-Python wheels only, refused by `validatePurePythonWheel`
    (`extension/lib/python-wheel-validator.js`).
  - `loadWheels()` in the `python.execute` provider feeds store bytes to the
    worker, which unpacks them into `/lib/python3.12/site-packages` via
    `pyodide.unpackArchive` before user code runs
    (`wasm-tools/python/python-worker.js` `materializeWheels`).
  - The sanctioned network route exists: ambient globals are stripped (`4p7j.1`)
    and `cap.fetch` reaches the permissioned Service Worker proxy
    (`extension/lib/python-network.js`; `4p7j.2`). The old claim "no ambient
    network route exists today, wheel fetches will route through `4p7j.2` when
    it lands" is corrected.
- **Still SPECIFIED, NOT BUILT** — the pinned package set itself:
  - **Zero `.whl` files ship in the tree** and **no first-party code calls
    `loadPackage`** (zero call sites under `extension/` or `wasm-tools/`), and
    `4p7j` measured `loadPackage` as a silent no-op in this worker. The 8
    hash-pinned packages install only when the owner supplies wheel bytes
    (S3 of the `4p7j` arc — **PROPOSED**, no owning bead).
  - `micropip` is not called by first-party code — **PROPOSED**, no owning bead.
  - There is no OPFS venv: `agent-workspaces/<agent>/python_env/` appears
    nowhere in the tree — **PROPOSED**, no owning bead.
  - Tier 3 (pyodide-build / PEP 783) — **PROPOSED / DEFERRED**, no owning bead.
- The pin table is unchanged and still exact against
  `wasm-tools/python/pyodide-lock.json` (including matplotlib's `packaging`
  dependency).

## 4. Productivity workflows (§65)

The section is headed **SPECIFIED FUTURE COMPOSITIONS (NOT YET WIRED)**. Every
Lane A tool named there ships a manifest: `cap.bundled.markdown` (built from
cmark 0.31.1, `packages/bundled/c2/build.sh`), `cap.bundled.compressops`,
`cap.bundled.csvtool`, `cap.bundled.awk`, `cap.bundled.imageops`. `csvtool` is
not §4 (it is not a catalogue entry at all) — it is the shipped package
`cap.bundled.csvtool`. Everything else named there (`harper.js`, `hunspell-wasm`,
`typst.ts`, `tantivy-wasm`, `sqlite-vec`, `duckdb-wasm`) ships no manifest and is
marked **PROPOSED**. No workflow uses a Lane B or Lane C tool, and the verdict
now says so.

## 5. Verification

| Gate | What it proves |
| --- | --- |
| `npm run test:file -- tests/wasm-catalogue-status-truth.test.ts` | the four status-word invariants hold (new; also always-on in subsets) |
| `npm run test:file -- tests/docs-process-truth.test.ts` | the retired-tracker/doc-process pins still hold |
| `npm run test:file -- tests/python-wheel-unpack.test.ts` | the wheel-materialisation path the doc now calls BUILT is green |
| `npm run test:file -- tests/wheel-store-routes.test.ts` | the OPFS wheel store + `wheel.*` routes the doc now calls BUILT are green |
| `npm run check:vocabulary` | vocabulary surfaces clean |
| `npm run test:changed` | per-change unit gate |
| `npm test` | full suite before push (mandatory, not replaced by a subset) |
| `npm run build:production` + `npm run note:dist` | dist current after the last commit |

Raw results (counts, exit codes) are recorded on bead
`chrome-agent-platform-qazo`; `docs-process-truth` and `check:vocabulary` are
process gates only — neither reads this doc, which is exactly why the new
doc-truth test exists.

## 6. What was dropped from the salvaged branch, and why

`origin/cap/gemini-qazo-wasm-catalogue-pipeline` was 212 commits behind main, so
only its two content files were taken. Dropped as stale artifacts of the
2026-09-26 base: its `.beads/issues.jsonl` edits (the export is regenerated, not
hand-merged), its `CHANGELOG.md` entry, and its `package.json` / `package-lock.json`
/ `extension/manifest.json` / `extension/lib/bundled-inventory-data.js` version
bumps. `fix/qazo-doc-status` no longer exists on origin; its `f3e6dff27` was
inspected and only the parts that survived verification were kept.
