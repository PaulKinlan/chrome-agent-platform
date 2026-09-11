# Architectural Design: Installable JavaScript Modules in the Script Sandbox

**Status:** Architectural Design & Recommendation (chrome-agent-platform-ovfm / split from 4p7j)  
**Author:** `merger` lane  
**Base:** `origin/main` @ `555da4bc` (2026-09-11)  
**Scope:** Design specification for installable, offline-executable JavaScript ES modules in `extension/sandbox/script-sandbox.html`.  
**Grounding:** Extends §8 of `/home/paulkinlan/cap-evidence/claude/4p7j-analysis.md` with source-code verification.

---

## 1. Substrate Verification (Facts in Code)

Before designing the module resolution layer, the underlying sandbox execution properties were verified directly against committed source code:

| Substrate Property | Source Location | Verified Behavior |
|---|---|---|
| **Manifest Sandbox Key** | `extension/manifest.json:99-103` | `sandbox/script-sandbox.html` is declared under `sandbox.pages`. In Chromium MV3, sandbox pages are assigned a unique, opaque origin (`null`). |
| **Opaque Origin Confinement** | `extension/sandbox/script-sandbox.js:1-10` | The sandbox page has **no access to `chrome.*` APIs** (`chrome.runtime`, `chrome.storage`, etc. are undefined). It has no same-origin access to extension documents or OPFS storage. |
| **Storage Teaching Guards** | `extension/sandbox/script-sandbox.js:28-64` | `installScriptSandboxTeachGuards()` intercepts `window.localStorage`, `window.sessionStorage`, `window.indexedDB` (`open`, `deleteDatabase`), `window.caches` (`open`, `keys`, `delete`, `match`, `has`), `document.cookie`, and `navigator.storage.getDirectory`. Any access throws a descriptive, instructive error rather than failing mutely. |
| **Host-Bridged Fetch** | `extension/sandbox/script-sandbox.js:79` | `window.fetch` is shadowed by an async RPC over `postMessage` (`type: "cap:script-call"`, `kind: "fetch"`). The sandbox has no direct network capability. |
| **Host URL & Protocol Gate** | `extension/lib/script-host.js:13-39` | `runFetch` validates that requests are strictly `http:` or `https:`, contain no embedded credentials (`user:pass`), and use only `GET` or `HEAD` methods. |
| **SSRF Denial & Host Allowlist** | `extension/lib/fetch-policy.js:92-132` | The Service Worker executes `checkFetchPolicy` via `isPrivateOrLoopbackHost`, refusing loopback (`127.0.0.0/8`, `localhost`), private LAN (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local/cloud metadata (`169.254.0.0/16`), and IPv6 unique-local (`fc00::/7`). Requests are restricted to the per-run host allowlist extracted statically from script source (`extractFetchHosts`). |
| **Anonymity & Laundering Protection** | `extension/background/service-worker.js:790` | The Service Worker executes requests with `credentials: "omit"` and `redirect: "manual"` (refusing 3xx redirects to prevent allowlist laundering). |
| **Current Execution Primitive** | `extension/sandbox/script-sandbox.js:97` | Code currently executes as an async function body via `new Function("return (async function(){\n" + source + "\n})();")`. |

---

## 2. The Resolution Problem

While the Python execution environment (Pyodide in a dedicated Worker) faced a **payload and sandbox hole problem** (lack of shipped wheels + ambient network access), the JavaScript sandbox faces a **pure module resolution problem**:

1. **No Network for Module Retrieval:** The sandbox cannot dynamically download packages from `npm`, `unpkg`, or CDNs at runtime. Modules must resolve entirely offline from stored bytes.
2. **No Direct Storage Access:** The sandbox has an opaque origin (`null`). It cannot read `localStorage`, `IndexedDB`, or OPFS directly. Stored modules must be provided to the sandbox by the host.
3. **The Bare Specifier Wall:** In standard JavaScript, executing `import { chunk } from "lodash-es"` or `const d3 = await import("d3-array")` requires resolving a **bare specifier** (`"lodash-es"`). Browsers only resolve bare specifiers if an **Import Map** (`<script type="importmap">`) is present in the document.
4. **Syntax Conflict with `new Function`:** Static import statements (`import ... from ...`) are **illegal syntax** inside function bodies. The current `new Function(...)` execution model rejects any script containing static `import` declarations with a `SyntaxError`.
5. **Import Map Browser Behavior & The Real Security Spine:**
   - While the initial HTML specification envisioned `<script type="importmap">` as immutable after module evaluation, actual Chromium behavior (measured in Chrome 152+) accepts subsequent import map insertions and resolves late unapproved specifiers. "Immutable after first load" is therefore **not** a platform security boundary the architecture can rely on, and the system will not engage in a fragile DOM `MutationObserver` arms race to simulate it.
   - **The Real Security Properties:** The sandbox security spine rests entirely on three robust, checkable invariants:
     1. **The Opaque Origin (`null`)**: Zero same-origin access to extension documents, credentials, or OPFS.
     2. **Host-Bridged Fetch with SSRF Denial**: Zero ambient network capability; every network call is routed through the Service Worker with strict allowlists and loopback/private IP blocking.
     3. **Cryptographic Digest Verification of Host-Supplied Modules**: The host and sandbox only ever mint Blob URLs for modules whose bytes match the owner-approved SHA-256 digest.
   - A late import map injected by script code can only point at bytes the script itself could already execute (the sandbox permits `eval` and dynamic script execution by design); it introduces no privilege escalation, but the contract must state what the browser actually provides rather than claiming nonexistent browser immutability guarantees.
6. **Module Identity & Anti-Impersonation:**
   - What defines a module's identity?
   - How are namespace collisions resolved (e.g. two modules named `utils`)?
   - How does the system ensure that a script requesting `"date-fns"` executes the exact, uncompromised code the owner approved?

---

## 3. Options Analysis

Four architectural options were evaluated to resolve JavaScript modules inside the script sandbox:

### Option A: Inline Module Concatenation / Synthetic Scope (CommonJS/IIFE Wrapper)
- **Mechanism:**
  - The host looks up the requested modules from OPFS, bundles their source into the postMessage payload:
    `{ type: "cap:script-source", source, modules: { "my-utils": "export function foo() { ... }" } }`.
  - In `script-sandbox.js`, the sandbox transforms or wraps the modules into an in-memory dictionary `__modules`, providing a synthetic `require(name)` or injecting exports as global variables.
  - The script executes via the existing `new Function` runner.
- **Cost / Complexity:** Low. Minimal changes to `script-sandbox.js`; no browser import map required.
- **Security:** Strict digest binding. Tamper-evident in the postMessage payload.
- **Why It Fails:** It does not support canonical ES Module syntax. Agents and developers cannot write `import { x } from "module"`. Forcing agents to use non-standard wrappers breaks LLM code-generation expectations.

### Option B: Per-Run Blob URLs + Dynamic `<script type="importmap">` + Native ESM (Recommended)
- **Mechanism:**
  - Modules are stored in the shared owner-blob store (`cap-owner-blobs-v1/` in OPFS) keyed by content SHA-256 with metadata `{ name, version, digest, description }`.
  - When an agent-authored script is dispatched, the host announces the script and its module dependencies to the sandbox.
  - For each declared dependency, the sandbox receives the module text and mints a local Blob URL:
    ```javascript
    const blobUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
    ```
  - An import map is constructed and inserted into the sandbox DOM before any script runs:
    ```html
    <script type="importmap">
    {
      "imports": {
        "lodash-es": "blob:null/3e4f...",
        "my-utils": "blob:null/8a1b..."
      }
    }
    </script>
    ```
  - The script is executed as a true ES Module:
    ```javascript
    const scriptBlob = URL.createObjectURL(new Blob([
      `import * as __cap from "${capShimBlobUrl}";\n` +
      `const { fetch, log } = __cap;\n` +
      source
    ], { type: "text/javascript" }));
    await import(scriptBlob);
    ```
- **Cost / Complexity:** Moderate. Requires transitioning `script-sandbox.js` from `new Function` to native dynamic `import()`, managing object URL revocation (`URL.revokeObjectURL`) on teardown, and reloading the iframe per run due to import map immutability.
- **Security:** Total origin and network isolation. Resolves 100% offline via local in-memory blob references.
- **CSP Prerequisite & Risk Envelope:** Requires adding `blob:` to the sandbox CSP in `manifest.json`:
  ```json
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-src 'self' about: blob: data:",
    "sandbox": "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; child-src 'self';"
  }
  ```
  *Security containment analysis:* Permitting `blob:` in a sandboxed page's `script-src` widens what can load as script, but the threat is strictly contained: the sandbox is an opaque origin (`null`) with zero `chrome.*` APIs, no storage access, and no ambient network. Its only network reach is host-bridged `fetch` with SSRF denial and host allowlists enforced by the Service Worker in `extension/lib/fetch-policy.js`. A `blob:`-URL script is therefore fully contained by the sandbox isolation boundary rather than by CSP script-source restrictions.

### Option C: `data:` URLs + Import Map
- **Mechanism:** Same as Option B, but converting modules to `data:text/javascript;base64,...` strings instead of `blob:` URLs.
- **Cost / Complexity:** High encoding overhead. Base64 encoding adds 33% payload size inflation.
- **Security:** Fragile. Chrome extensions CSP strictly discourages or rejects `data:` in `script-src` to mitigate XSS vectors. `data:` module scripts are blocked in many modern Chromium sandbox configurations.

### Option D: Host-Side Bundling / Transpilation (Rollup/esbuild in Offscreen Host)
- **Mechanism:** The offscreen document runs a lightweight bundler (e.g. esbuild-wasm or a minimal single-pass module resolver) that rolls the script and its dependencies into a single standalone bundle before sending it to the sandbox.
- **Cost / Complexity:** Prohibitive. Squeezing a bundler into the extension adds significant bundle size (violating the razor-thin Store SW bundle budget of 3.0 MB) and introduces complex AST parsing overhead.
- **Security:** Unnecessary complexity that duplicates browser-native module resolution.

---

## 4. Recommendation & Concrete Architecture

**Recommendation: Adopt Option B (Per-Run Blob URLs + Native Import Map).**

### 4.1 Module Lifecycle and Storage
1. **Shared Owner-Blob Store Integration:**
   - Modules live in the shared owner-blob store (`cap-owner-blobs-v1/` in OPFS, established by `9ux7.1` and `m6x8`).
   - A JS module record carries:
     - `digest`: 64-hex SHA-256 of the exact UTF-8 module source.
     - `name`: Bare module specifier (e.g. `lodash-es`, `date-fns`, `csv-parser`). Must match `/^[a-z0-9_@/-]+$/i`.
     - `kind`: `"js-module"`.
     - `size`: Byte length.
     - `description`: Owner-supplied purpose description.
     - `addedAt`: Timestamp of owner install.

2. **Owner-Approval & Script Fencing:**
   - Model-initiated script creation (`script.create`) and execution (`script.run`, `task.schedule-script`) already require owner approval under `DESTRUCTIVE_ACTIONS` (`docs/inline-approval-audit.md`).
   - The approval card must disclose:
     1. The script source code.
     2. The static fetch hosts extracted by `extractFetchHosts`.
     3. **The exact module names and their SHA-256 digests bound to the run.**
   - A model cannot substitute or hijack an installed module: module resolution binds the exact stored digest at dispatch time.

3. **Anti-Impersonation & Pre-Execution Digest Verification:**
   - Module resolution must enforce cryptographic re-hashing before minting any Blob URL. A module whose actual bytes deviate by even one bit from its registered SHA-256 digest must fail closed with a typed `digest-mismatch` refusal.
   - *Test Requirement:* An executing unit test must prove that a corrupted or substituted module is rejected before any Blob URL is created or mounted, mirroring the pre-instantiate re-hash contract in `executeUserWasmRun`.

4. **Fresh-Per-Run Iframe Instantiation:**
   - The host (`script-host.js`) instantiates a fresh iframe for each script run that uses modules, tearing down the iframe upon completion (lines 88–133). This ensures clean, uncontaminated document state across runs, independent of browser import map mutability.

5. **Teardown & GC:**
   - Upon script resolution or timeout, `runScript` in `script-sandbox.js` revokes all created Blob URLs via `URL.revokeObjectURL(url)` to prevent memory leaks in long-running offscreen hosts.

---

## 5. What This Does NOT Solve (Explicitly Out of Scope)

To remain honest and avoid architectural over-promising, this design explicitly does **not** solve:

1. **No NPM Package Manager / Dependency Tree Resolution:**
   - This design does not resolve transitive dependencies. An installed module must be a **self-contained single-file bundle** (e.g. a bundled UMD/ESM file like `lodash-es.bundle.js`).
   - If an installed module attempts to import another uninstalled bare specifier, the browser will throw an unmapped bare specifier `TypeError`.
2. **No Native Extension APIs:**
   - Installed modules run strictly inside the sandbox opaque origin. A module cannot access `chrome.tabs`, `chrome.storage`, or any extension capabilities.
3. **No Storage Bypass:**
   - Installed modules cannot persist state. They are subject to the same storage teaching guards as the script itself.
4. **Network Access Inheritance:**
   - If an installed module calls `fetch()`, that call is routed through the sandbox's host-bridged `fetch`. It is governed by the exact same per-run host allowlist and SSRF restrictions as user-written script code. An installed module **cannot widen** the network reach of the script.
5. **No Privilege Escalation via Late Dynamic Import Maps:**
   - While a running script may dynamically insert an import map in modern Chromium engines, it cannot bypass the sandbox boundary: any late-mapped URL can only point to bytes the script itself created in-memory, and cannot widen network reach, access storage, or mint unapproved host-module digests.

---

## 6. Implementation Staging Plan

1. **Stage 1 (Store Binding & Anti-Impersonation Pin):** Connect JS module storage to the shared owner-blob store (`cap-owner-blobs-v1/`) with Settings UI for upload, digest inspection, and removal. Add an executing unit test asserting that byte-corrupted modules fail closed with `digest-mismatch` before Blob URL creation.
2. **Stage 2 (Manifest CSP & Containment Proof):** Declare `content_security_policy.sandbox` in `extension/manifest.json` permitting `blob:` in `script-src`, with the documented containment rationale (opaque null origin, no ambient network, host-bridged fetch).
3. **Stage 3 (Host Dispatch & Import Map Injection):** Update `script-host.js` and `script-sandbox.js` to mint Blob URLs and inject `<script type="importmap">` prior to module execution.
4. **Stage 4 (Verification & Falsification KAT):** Add test suite verifying:
   - Bare specifier import resolves to correct module.
   - Mismatched digest or missing module fails closed.
   - Storage teaching guards remain active inside imported modules.
   - Host-bridged fetch restrictions apply equally to imported module calls.
