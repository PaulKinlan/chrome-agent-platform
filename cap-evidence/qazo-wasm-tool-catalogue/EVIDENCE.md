# chrome-agent-platform-qazo — WebAssembly Library Catalogue & Import Pipeline (Delta Re-Review)

**Candidate:** branch `cap/gemini-qazo-wasm-catalogue-pipeline` @ worktree `/home/paulkinlan/worktrees/cap-gemini-qazo`.  
**Base:** `origin/main` @ `3a5d002f0`.  
**Date:** 2026-09-26.  
**Authority:** Technical research catalogue, host execution lanes, and import pipeline specification for managed default Wasm tools across 65 categories.

---

## 1. Scope & Execution Lane Architecture

This deliverable provides the complete architecture and import pipeline specification for `chrome-agent-platform-qazo`, with every lane and tier explicitly classified as **BUILT** or **SPECIFIED, NOT BUILT**:

### The Three Execution Host Lanes
- **Lane A: WASI Preview 1 Command Modules (Default Core):**
  - **Status:** **BUILT** (`extension/lib/wasm-stream-files.js`, `extension/lib/tool-stream-platform.js`).
  - Shipped manifests: 37 command tool packages in `extension/wasm/manifests/`.
  - Contract: `_start` entry point, streaming `stdin` → `stdout`, isolated per-job preopen mounts (`/job/inputs`), wall-clock execution limits, zero host networking, origin-keyed OPFS isolation.
- **Lane B: Call-Export Pure Compute Modules (Minimal Host):**
  - **Status:** **BUILT** (`extension/lib/wasm-callexport-host.js`, registered in `offscreen/offscreen.js`; closed under `chrome-agent-platform-uslb`).
  - Shipped package: `cap.bundled.hash.blake3-1.0.0` (in-repo build, entry `Hash_Calculate`, zero imports). Instantiates in-thread within the offscreen document host.
  - Proposed admits: **SPECIFIED, NOT BUILT** (`awasm-noble` — bead `2uhx`, OPEN; `hash-wasm` — bead `3wei`, BLOCKED).
- **Lane C: Offscreen Emscripten/Pyodide Runtime (Complex System Runtimes):**
  - **Status:** **BUILT (Python-only)** (`extension/lib/python-host.js`, `extension/lib/python-runtime.js`; tested by `scripts/kat-pyodide.ts`).
  - Host model: Offscreen document (`offscreen/offscreen.html`) spawns a dedicated Web Worker per run with a 30s timeout and `worker.terminate()` cleanup. Ambient network globals stripped per `4p7j.1`.
  - General Emscripten runtime with SharedArrayBuffer and killable pthreads: **SPECIFIED, NOT BUILT** (owning epic: `chrome-agent-platform-ltkj` / `CAP-FB-20260905-EMSCRIPTEN-RUNTIME-01`).

### The 5-Step Admission & Import Pipeline
1. Upstream provenance & license audit.
2. Static binary audit via `auditWasmBinary` (`extension/lib/wasm-package-authority.js`) verifying memory32, import limits, zero network access.
3. Content-addressed storage (`extension/wasm/cas/<sha256>.wasm`) and canonical manifest creation (`extension/wasm/manifests/`).
4. Cryptographic provenance & SBOM generation (`extension/wasm/licenses/` and `extension/wasm/sbom/`).
5. Build-time inventory generation (`node scripts/build-bundled-tool-packages.mjs`, verified by `scripts/dist-complete.mjs`).

---

## 2. Python / Pyodide Three-Tier Architecture (§§58–60)

### Tier 1: Pinned Built-in Package Set (Pre-bundled Tier)
- **Status:** Core Pyodide runtime is **BUILT** (`wasm-tools/python/MANIFEST.json`, `extension/lib/python-runtime.js`). Built package set is **SPECIFIED, NOT BUILT** (owning bead: `chrome-agent-platform-4p7j`).
- Runtime: Pyodide v0.26.4 (CPython 3.12.1, Emscripten 3.1.58, ABI `2024_0`). License: `MPL-2.0 AND PSF-2.0`.
- Mechanics: `pyodide.loadPackage([...])` from JavaScript in offscreen worker. Packages are pinned in `wasm-tools/python/pyodide-lock.json`. Unpacks into in-memory MEMFS `site-packages` via `unpackArchive` (tested in KAT).
- 8 Core Packages Hash-Pinned in `pyodide-lock.json`:
  - **numpy** v1.26.4: `numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `4a2f5303...`)
  - **pandas** v2.2.0: `pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `ae979af0...`, deps: numpy, python-dateutil, pytz)
  - **scipy** v1.12.0: `scipy-1.12.0-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `1a081410...`, deps: numpy, openblas)
  - **scikit-learn** v1.4.2: `scikit_learn-1.4.2-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `5caa3a4c...`, deps: scipy, joblib, threadpoolctl)
  - **matplotlib** v3.5.2: `matplotlib-3.5.2-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `7321e0aa...`, deps: cycler, fonttools, kiwisolver, numpy, packaging, pillow, pyparsing, python-dateutil, pytz, matplotlib-pyodide)
  - **regex** v2024.4.16: `regex-2024.4.16-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `a7fc7d2a...`)
  - **pyyaml** v6.0.1: `PyYAML-6.0.1-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `7e2c1229...`)
  - **cryptography** v42.0.5: `cryptography-42.0.5-cp312-cp312-pyodide_2024_0_wasm32.whl` (sha256: `79653f8d...`, deps: openssl, six, cffi)

### Tier 2: Pure-Python Wheels via Micropip (On-Demand Install)
- **Status:** **SPECIFIED, NOT BUILT** (owning bead: `chrome-agent-platform-4p7j`).
- Networking: **No ambient network route exists today** in `python-worker.js` (`4p7j.1` stripped ambient network globals to eliminate unauthorized network egress; asserted by `scripts/kat-python-no-ambient-network.ts`). Wheel fetches will route through the permissioned proxy bridge (`chrome-agent-platform-4p7j.2`) when it lands.
- Storage & Execution: Pure wheels unpack into in-memory MEMFS `site-packages`. (OPFS venv `agent-workspaces/<agent>/python_env/` is proposed future architecture under `4p7j`, not built today).

### Tier 3: Out-of-Tree C/Rust Extensions (Pyodide Build Platform)
- **Status:** **SPECIFIED, NOT BUILT / DEFERRED**. Platform tag `cp312-cp312-pyodide_2024_0_wasm32.whl` deferred pending PEP 783 standardization.

---

## 3. Productivity Category Workflows (§65)

- **Status:** **SPECIFIED FUTURE COMPOSITIONS (NOT YET WIRED)**.
- Shipped Tools Used: `cap.bundled.markdown` (Lane A, BUILT from cmark 0.31.1), `cap.bundled.compressops` (Lane A, BUILT, zstd & brotli streaming), `cap.bundled.imageops` (Lane A, BUILT), `cap.bundled.csvtool` (Lane A, BUILT), `cap.bundled.awk` (Lane A, BUILT).
- Proposed Future Admits: `harper.js` (§53), `typst.ts` (§19), `duckdb-wasm` (§27), `tantivy-wasm` (§32), `sqlite-vec` (§28) — all SPECIFIED, NOT BUILT.

---

## 4. Verification

- `tests/docs-process-truth.test.ts`: **10 passed / 0 failed**.
- `npm run check:vocabulary`: Clean (17 surfaces verified).
- `npm run note:dist`: Clean.
