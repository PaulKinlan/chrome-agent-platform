# chrome-agent-platform-2uhx — Admit awasm-noble as Managed Wasm Tool (Auditable Crypto)

**Bead:** `chrome-agent-platform-2uhx`  
**Candidate branch:** `cap/gemini-2uhx-awasm-noble` @ worktree `/home/paulkinlan/worktrees/cap-gemini-2uhx`  
**Base:** `origin/main` @ `3a5d002f0`  
**Author:** `cap-gemini` (Gemini 3.8 Flash)  
**Date:** 2026-09-26  

---

## 1. Summary & Motivation

`chrome-agent-platform-2uhx` admits `@awasm/noble` as a managed Wasm tool in Chrome Agent Platform. Following the structural precedent established by `chrome-agent-platform-uslb` (commit `5b128f12b`), `@awasm/noble` 0.1.4's `chacha_poly1305` module is admitted via the minimal zero-import `call-export` host lane (`extension/lib/wasm-callexport-host.js`).

This expands CAP's native on-device cryptographic capability with authenticated symmetric encryption (AEAD RFC 8439) using audited pure WebAssembly compute with zero external imports.

---

## 2. Package Pinning & Provenance

- **Upstream Package:** `@awasm/noble` v0.1.4 (MIT License, Paul Miller)
- **Registry Integrity:** `sha512-LFkAq7VnGc8Hum4x12yxBsyoQYq9mWDf02j1lltzXaeZ14qcXwEYnOl5ByJ49xiBk1L7h6m3vkKkInvtDUIvOg==`
- **Tarball:** `packages/bundled/evidence/awasm-chacha/awasm-noble-0.1.4.tgz` (3,312,149 bytes, sha256 `a78cc0db73a29bacb87ad8d8610130df4cc6c4f69f7a0f64ac433e9f3445da91`)
- **Extracted Wasm Binary:** `packages/bundled/evidence/awasm-chacha/binaries/chacha_poly1305.wasm`
  - Size: 43,461 bytes
  - SHA-256: `e1acae9b3ee3da01b2bd0574f906fede6f5219da4b9b43fd5c36ee16fbf11330`
  - Extraction tool: `packages/bundled/evidence/awasm-chacha/extract.mjs` (deterministic single-blob decode)
- **CycloneDX 1.5 SBOM:** `packages/bundled/evidence/awasm-chacha/sbom/cyclonedx-1.5.json` → `extension/wasm/sbom/chacha20_poly1305.cdx.json`
- **License Text:** `packages/bundled/evidence/awasm-chacha/LICENSES/awasm-noble-MIT.txt`

---

## 3. Architecture & Security Invariants

1. **Zero Package JS Execution:** No third-party package JS runs in the extension service worker or offscreen document. The module is driven strictly through a CAP-authored WebAssembly host harness (`extension/lib/wasm-callexport-host.js`).
2. **Authority & Pre-execution Audit:** Before every run, `auditWasmBinary` re-verifies:
   - Zero imports (`imports.length === 0`).
   - Memory bounds conforming to declared tier (`default` tier, max 512 pages).
   - Exported functions required for the `chacha20_poly1305` ABI: `encryptInit`, `encryptBlocks`, `decryptInit`, `decryptBlocks`, `tagFinish`, and `memory`.
3. **Fresh Instance per Call:** Fresh `WebAssembly.Module` and `WebAssembly.Instance` per execution (never pooled, zero cross-call memory bleed).
4. **Fail-Closed Authenticated Encryption:**
   - Poly1305 authentication tags verified with constant-time equality (`timingSafeEqual`).
   - Ciphertext or tag tampering fails closed with `callexport fail-closed: invalid_tag`.
   - Associated Authenticated Data (AAD) binds cryptographically to the ciphertext; altered AAD fails closed.
   - Strict argument validation (key must be 32 bytes, nonce 12 bytes; mode must be `"encrypt"` or `"decrypt"`).

---

## 4. Verification & Gates

- **Targeted Callexport Tests:**
  - `tests/callexport-admission.test.ts`: **10 passed / 0 failed** in 22ms.
    - Verified audit of real `chacha_poly1305.wasm`.
    - Verified round-trip encrypt and decrypt against noble vectors.
    - Verified authenticated associated data (AAD) binding.
    - Verified fail-closed defense against tampered ciphertext.
- **Inventory & Allowlist Tests:**
  - `tests/agent-wasm-discovery.test.ts`: **6 passed / 0 failed** (updated 38 → 39 bundled tools).
  - `tests/bundled-tool-packages.test.ts`: **23 passed / 0 failed** (updated 38 → 39 manifests, CAS blobs, allowlist, store map).
  - `tests/bundled-tools-live-execution.test.ts`: **5 passed / 0 failed** (updated 38 → 39 live records).
  - `tests/chrome-tool-capabilities.test.ts`: **17 passed / 0 failed** (updated 38 → 39 bundled rows).
  - `tests/gzip-preview.test.ts`: **8 passed / 0 failed** (updated 38 → 39 census).
  - `tests/tool-descriptions.test.ts`: **5 passed / 0 failed** (updated 38 → 39 tool descriptions).
  - `tests/tool-exec-preview.test.ts`: **15 passed / 0 failed** (updated 38 → 39 allowlisted tools).
  - `tests/wasm-task-execution.test.ts`: **6 passed / 0 failed** (updated 38 → 39 records).
  - `tests/tool-purpose-groups.test.ts`: **7 passed / 0 failed** (classified `chacha20_poly1305` in `hashes-ids`).
  - `tests/evidence-durable.test.ts`: **2 passed / 0 failed** (verified 144 generated files byte-identical).
  - `tests/test-partition-guard.test.ts`: **9 passed / 0 failed**.
- **Full Changed Suite:**
  - `npm run test:changed`: **4,569 passed across 508 files / 0 failed** in 253s.
- **Build & Vocabulary:**
  - `npm run build:production`: Store SW bundle built atomically, 39 packages / 39 manifests / 114 shipped files, budget OK (2,990,177 <= 3,000,000 bytes).
  - `npm run note:dist`: Clean.
  - `npm run check:vocabulary`: Clean (17 surfaces).
