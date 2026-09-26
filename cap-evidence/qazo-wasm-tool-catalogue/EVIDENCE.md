# chrome-agent-platform-qazo — WebAssembly Library Catalogue & Import Pipeline

**Candidate:** branch `cap/gemini-qazo-wasm-catalogue-pipeline` @ worktree `/home/paulkinlan/worktrees/cap-gemini-qazo`.  
**Date:** 2026-09-26.  
**Authority:** Comprehensive research catalogue and import pipeline specification for managed default Wasm tools across 65 categories, including the three-tier Python/Pyodide architecture and productivity workflows.

---

## 1. Overview & Deliverables

This deliverable fulfills the full scope of `chrome-agent-platform-qazo` and its scope expansion directives:
1. **The Comprehensive 65-Category Catalogue (`docs/wasm-tool-catalogue.md`):**
   - Detailed technical evaluation of ~150 WebAssembly libraries and tool candidates.
   - Categorized by license (recorded SPDX, never gating per owner directive), unpacked footprint, WASI preview1 vs browser/Emscripten runtime profile, memory model (memory32 vs memory64), and technical admission verdict (`admit-now`, `investigate`, `reject-as-wasm`, `not-found`).
2. **The Three Wasm Execution Host Lanes:**
   - **Lane A (WASI Preview 1 Command):** Streaming `stdin` → `stdout`, isolated per-job preopen mounts (`/job/inputs`, `/job/outputs`), fuel/timeout bounds. Powers the 38 production bundled tools.
   - **Lane B (Call-Export Pure Compute):** Direct memory layout + exported function invocation. Zero imports, no POSIX glue, runs in lightweight Web Workers (e.g., `awasm-noble`, `hash-wasm`).
   - **Lane C (Offscreen Emscripten/Pyodide Runtime):** Sandboxed offscreen document hosting complex POSIX runtimes with SharedArrayBuffer and pthreads support. Powers `python_execute` via Pyodide.
3. **The 5-Step Admission & Import Pipeline:**
   - Step 1: Upstream provenance & license audit.
   - Step 2: Static binary audit via `auditWasmBinary` (verifying memory32, import boundaries, zero network access).
   - Step 3: Content-addressed storage (`extension/wasm/cas/<sha256>.wasm`) and canonical manifest creation (`extension/wasm/manifests/`).
   - Step 4: Cryptographic provenance & SBOM generation (`extension/wasm/licenses/` and `extension/wasm/sbom/`).
   - Step 5: Build-time inventory generation (`node scripts/build-bundled-tool-packages.mjs`).

---

## 2. Python / Pyodide Three-Tier Architecture (§§58–60)

The catalogue defines the three tiers of Python tool execution in CAP:

### Tier 1: Pinned Built-in Package Set (Pre-bundled / Lazy OPFS Cache)
Locked to **Pyodide v0.26.4** (CPython 3.12.1, Emscripten 3.1.58, ABI `2024_0`).
The 8 key scientific and utility packages are hash-pinned in `wasm-tools/python/pyodide-lock.json`:
- **numpy** v1.26.4: `numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `4a2f5303...`)
- **pandas** v2.2.0: `pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `ae979af0...`, deps: numpy, python-dateutil, pytz)
- **scipy** v1.12.0: `scipy-1.12.0-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `1a081410...`, deps: numpy, openblas)
- **scikit-learn** v1.4.2: `scikit_learn-1.4.2-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `5caa3a4c...`, deps: scipy, joblib, threadpoolctl)
- **matplotlib** v3.5.2: `matplotlib-3.5.2-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `7321e0aa...`, deps: cycler, fonttools, kiwisolver, numpy, pillow, pyparsing, python-dateutil, pytz, matplotlib-pyodide)
- **regex** v2024.4.16: `regex-2024.4.16-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `a7fc7d2a...`)
- **pyyaml** v6.0.1: `PyYAML-6.0.1-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `7e2c1229...`)
- **cryptography** v42.0.5: `cryptography-42.0.5-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `79653f8d...`, deps: openssl, six, cffi)

### Tier 2: Pure-Python Wheels via Micropip (On-Demand Install)
- Installs pure-Python wheels (`py3-none-any.whl`) at runtime into an OPFS virtual environment (`agent-workspaces/<agent>/python_env/`).
- Network fetches route through extension host permissions via `pyodide-http`.
- Enables long-tail ecosystem coverage (`rich`, `typer`, `pydantic`, `jinja2`, `beautifulsoup4`).

### Tier 3: Out-of-Tree C/Rust Extensions (Pyodide Build Platform)
- Target ABI tag: `cp312-cp312-pyodide_2024_0_wasm32.whl`.
- Status: **DEFERRED** pending PEP 783 standardization and version-locked container toolchain requirements.

---

## 3. Productivity Category Workflows (§65)

Rather than introducing redundant Wasm binaries for tasks solved natively by the web platform or JavaScript, the productivity category defines concrete multi-lane compositions:
1. **Document Authoring & QA:** `pulldown-cmark` (Lane A) → `harper.js` / `hunspell-wasm` (Lane B) → `typst.ts` (Lane C) for publication-grade documents.
2. **Local Data Processing:** `csvtool` / `awk` (Lane A) → `duckdb-wasm` (Lane C) for zero-egress in-browser analytics.
3. **Personal Knowledge Retrieval:** `tantivy-wasm` full-text search + `sqlite-vec` semantic similarity over OPFS memory.
4. **Offline Archival:** `zstd-wasm` / `brotli-wasm` (Lane B) streaming compression for MHTML snapshots.

---

## 4. Verification

- `tests/docs-process-truth.test.ts`: **10 passed / 0 failed**.
- `npm run check:vocabulary`: Clean (17 surfaces verified).
- `npm run note:dist`: Clean.
