# Pyodide bounded-build spec (CAP-FB-20260823-PYODIDE-PYTHON-01, owner OPTION A)

> STATUS (2026-09-04, bead chrome-agent-platform-4usu): the runtime is BUILT and
> ADMITTED, by the owner-approved simplification of this spec — the pinned
> OFFICIAL Pyodide 0.26.4 core distribution (wasm-tools/python/, MANIFEST.json with
> exact sha256, fetched from the GitHub release
> pyodide-core-0.26.4.tar.bz2), not a custom Emscripten build. The byte ceilings this
> spec sized for were removed by owner directive dptw (2026-09-03), so the
> custom memory-bounded build (sections 1–2 below) is moot: official-dist bytes
> are admitted whole and executed through a dedicated classic-worker dispatcher
> (extension/lib/python-host.js + wasm-tools/python/python-worker.js), fresh
> interpreter per run, pinned + hash-verified at the build/store gates.
> build.mjs verifies every byte against MANIFEST.json and copies the runtime into
> the packaged extension at dist/wasm-tools/python/ (the generated-artifact
> tree; chrome-extension:// serves it, so nothing fetches the network). The
> service worker injects the runtime provider through python-tool.js's
> setPythonRuntimeProvider seam; each python.execute is transported to a fresh
> classic Pyodide worker inside the offscreen document and the captured stdout
> is returned whole. Section 6's acceptance maps to: python_execute executes
> real code. `tests/python-runtime.test.ts` runs the pinned interpreter
> in-process; `scripts/kat-pyodide.ts` loads the production extension in Chrome,
> calls the real `python.execute` route, and retains JSON + screenshot evidence
> that `print(1+1)` returns captured stdout `2`.

Owner-approved MVS: a credential-free, OPFS-cached, **bounded-memory** Pyodide runtime
admitted through the existing wasm-package authority, driving ONE bounded `python` tool.
This document is the precise, unblocking build spec for the runtime BINARY — the actual
Emscripten build is a multi-hour, toolchain-dependent step that runs in a dedicated build
lane, NOT in a feature-authoring session. Everything downstream (admission record, OPFS
cache, live tool execution) is contingent on the artifact produced here.

## 1. The memory bound (the one non-negotiable)

Pyodide's stock `Makefile.envs` sets `MAXIMUM_MEMORY=4GB` + `ALLOW_MEMORY_GROWTH=1`
(= 65536 wasm pages). Every authority tier ceiling is far below that:

- `tiny` — 512 pages / 4 MiB — Pyodide core (8.4–12.3 MB) does NOT fit.
- `default` — 2048 pages / 16 MiB — **target** (allowed admission).
- `large` — 4096 pages / 64 MiB — **blocked** by the authority.

The build MUST produce a runtime whose declared `MAXIMUM_MEMORY` is ≤ **2048 pages**
(128 MiB) and whose actual binary size is ≤ 16 MiB, so it admits at `default`. With
`ALLOW_MEMORY_GROWTH=0` (or 1 with the 2048 ceiling) so the ceiling is a hard cap, not
a floor.

### Exact build override (no source fork)

In `pyodide/Makefile.envs`, the Emscripten linker flags are the lever. Set:

```
export EMSCRIPTEN_SETTINGS += -s MAXIMUM_MEMORY=134217728   # 128 MiB == 2048 pages
export EMSCRIPTEN_SETTINGS += -s ALLOW_MEMORY_GROWTH=0
```

(If the 2048-page ceiling must be expressed in pages, `-s MAXIMUM_MEMORY=134217728` is
the byte-equivalent of 2048 × 64 KiB. Do NOT leave the stock 4 GB / growth=1.)

Pin the upstream release tag (currently `0.26.4`), verify the SHA of the produced
`pyodide.asm.wasm`, and record BOTH the tag and the artifact SHA in the admission
manifest — provenance is frozen, never a moving `latest`.

## 2. The admission record (default-tier `runtime`)

`extension/lib/wasm-package-authority.js` already has a `runtime` package type and a
`default` tier. The admission manifest is:

```
pkg:       pyodide.runtime
type:      runtime
tier:      default            # 2048 pages / 16 MiB — memory-evidence gate applies
license:   { spdx: "MPL-2.0 AND PSF-2.0" }   # now valid (PSF-2.0 added to SPDX_IDS)
files:     pyodide.asm.wasm (SHA-pinned), pyodide.js (glue), stdlib archive (SHA-pinned)
```

The `default` admission is the FIRST non-tiny runtime admission in the corpus — the
memory-evidence gate (the measured wasm memory-section max pages ≤ 2048 AND byte size
≤ 16 MiB) must be attached, same as the bundled-lane gate. `license.spdx` is the exact
two-operand composite the validator already accepts.

## 3. OPFS cache (no CDN, no network)

> SUPERSEDED by the status note above (bead chrome-agent-platform-4usu): the
> runtime is not OPFS-cached — it ships inside the packaged extension
> (dist/wasm-tools/python/, verified byte-exact by build.mjs) and is served by
> the chrome-extension:// origin. The network-free property is unchanged and
> stronger: there is no first-run download to cache at all.

The existing `lib/python-runtime.js` scaffold fetches from a CDN (jsdelivr) with SRI —
that is the OLD, network-bearing approach and is **replaced** by Option A. The runtime
lives as an admitted artifact in the content-addressed OPFS cache (the same model as the
bundled CAS): `pyodide.asm.wasm` + `pyodide.js` + the stdlib archive persisted ONCE,
reused across jobs, keyed by the artifact SHA. Zero network at execution time.

## 4. The `python` tool contract (non-eval, top-level only, fail-closed)

- Input: `code` (≤ 2 KiB) + optional `stdin` (≤ 2 KiB). Output: stdout ≤ 64 KiB
  (honest truncation as an error, never a silent partial).
- **Non-eval entrypoint**: the code is handed to the wasm Python interpreter via
  `runPythonAsync`/`eval_code` — NEVER `eval(...)` / `new Function(...)` at the JS
  level (the MV3 CSP forbids JS `eval`; `wasm-unsafe-eval` covers only wasm instantiation).
- **Top-level only**: the program text is top-level code; no package install, no
  arbitrary module import beyond the stdlib archive that ships with the runtime
  (document the final allowlist at admission — none-or-stdlib-only).
- The existing `lib/python-execution.js` bound contract (2 KiB stdin / 64 KiB stdout /
  wall-clock fence / fresh-per-run) is the tool's skeleton; its `runPython` call must be
  re-pointed to the real non-eval entrypoint once the runtime lands.
- **Dispatcher separation**: Python is NOT a WASI binary — it runs under a SEPARATE
  Emscripten/JS-glue dispatcher profile. The WASI host (`wasi-preview1-runtime.js`) and
  its import allowlist are NOT widened. One python dispatcher profile, distinct from the
  28-tool WASI lane.

## 5. What is NOT changed

No new permissions, no provider keys, no network at runtime, no manifest CSP change
(`script-src 'self' 'wasm-unsafe-eval'` already covers wasm loads), no bundle-size
change (the runtime lives in OPFS, not the extension bundle).

## 6. Acceptance for the build lane

1. `pyodide.asm.wasm` built at the pinned tag with `MAXIMUM_MEMORY ≤ 2048 pages` and
   `ALLOW_MEMORY_GROWTH=0`; SHA-pinned; measured memory section ≤ 2048 pages; binary
   ≤ 16 MiB.
2. The admission manifest above validates through `wasm-package-authority` (licence
   composite, tier, memory-evidence gate).
3. The `python` tool KATs: in/out caps, non-eval refusal (a JS-eval-shaped input path
   is refused), memory bound, termination fence, fresh-per-run.
4. Zero permissions/keys/network/manifest changes.
