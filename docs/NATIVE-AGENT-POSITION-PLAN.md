# Position Plan: Native Agent Support on the Web Platform and Chrome

**Bead:** `chrome-agent-platform-cdld` (umbrella `9zw7`)  
**Status:** Living Strategic Reference  
**Context:** Grounded against shipped Chrome/Web platform reality and `chrome-agent-platform` at `origin/main@326ebf37` (v0.3.387+).  
**Companion Documents:** `docs/WEB-PLATFORM-AGENT-CONCEPT.md` (standards advocacy), `docs/ARCHITECTURE.md` (system architecture), `docs/RISK-REGISTER.md` (risk analysis).

---

## 1. Grounding Audit: Platform Reality vs. Aspiration

We distinguish three tiers of platform status with strict checkability:
1. **Shipped in Chrome / Web Standards** (verifiable in current stable browsers).
2. **Announced / In-Flight / Incubation** (verifiable in origin trials, WICG specifications, or Chromium bug trackers, but not production-ready).
3. **Pure Aspiration / Non-Existent** (conjectures or wishful proposals with no upstream tracking, no intent to prototype, and no standard).

### 1.1 The Reality Matrix

| Subsystem | Shipped Reality (Stable Web/Chrome) | Announced / In-Flight / Incubation | Pure Aspiration (Not On Any Roadmap) | CAP Reality Today (v0.3.387) |
|---|---|---|---|---|
| **Agent Identity & Principals** | Three principals only: User, Origin, Extension ID. | None. W3C has no agent identity incubation. | `chrome.agents` API; Web `AgentPrincipal` namespace. | Synthetic logical principals (`named:<slug>`, `site:<origin>`) managed in SW dispatch (`docs/SW-DISPATCH-AUTHORITY-CENSUS.md`). |
| **Code Sandboxing** | Manifest `sandbox.pages` (opaque origin, `null` origin, no `chrome.*`); dedicated Web Workers with wall-clock termination; Wasm instantiate. | In-browser model-guided isolation experiments. | Lightweight zero-process isolate spawning; in-SW Workers (`new Worker()` in SW). | Manifest sandbox page + explicit sandbox CSP permitting `blob:` (`ovfm.1-2`); offscreen doc hosting 5 subsystems; fresh WASI workers per job. |
| **Python Isolation** | None (Wasm/Pyodide is userland web code). | None. | Native Python execution in web browsers. | Pyodide classic worker in offscreen document; ambient network stripped; ambient storage stripped (`indexedDB`, `caches`, `getDirectory`) with teaching errors (`4p7j.3`). |
| **Storage Partitioning** | OPFS (`navigator.storage.getDirectory()`): exactly **one root per origin/bucket**. Storage Buckets API (WICG, web-only). | Chrome storage buckets UI integration. | Agent-scoped storage buckets with per-agent quota and UI attribution in Chrome settings. | Subdirectory multiplexing under single extension OPFS root (`memory/master/`, `memory/origins/`, `memory/agents/`); board deny rules in master MemoryStore (`5ihd`). |
| **Backup & Storage Scaling** | File System Access API (`showSaveFilePicker` / `FileSystemWritableFileStream`) on desktop on user gesture. | None. | Native background bulk OPFS streaming export without user gesture. | Monolithic in-memory JSON/Base64 archive capped at 512 MiB / 100k files in `data-archive.js` today; streaming TAR design pinned in `tests/streamed-backup-contract.test.ts` (`2g90`, pending wiring in `8fuc`). |
| **Tool Calling & Site Contracts** | None natively. Content scripts (`chrome.scripting`) on user gesture. | WebMCP (`navigator.modelContext`) exploratory incubation in W3C WICG (no browser ships it). | Declarative `<link rel="tools">` or `/.well-known/tools.json` with native browser dispatch. | Passive dual content-script detection (MAIN + ISOLATED with HMAC MACs) over `<all_urls>`; per-origin enrollment; per-tool invocation consent (Q23). |
| **Model Execution** | None on stable. | Chrome Prompt API (`window.ai.languageModel` / Gemini Nano) in Origin Trial/Canary. Strict token limits (4k-8k), text-only, low instruction adhering. | Native high-parameter models with multi-tool calling and large context windows built into browser engine. | Multi-provider API routing (OpenAI, Anthropic, Google) with 4-key credential filter (`apiKey`, `authToken`, `clientSecret`, `__proto__`) per `66t3`. |
| **Durable Long-Running Work** | Service worker terminates on idle (~30s). `chrome.alarms` wakeups. | None. | `chrome.runtime.durableTask` with crash-proof journaling and process recovery. | OPFS-authoritative WAL run registry (`run-outbox`, `bootId`, revision CAS, replay-safety classes) surviving SW restarts. |

---

## 2. Core Strategic Positions for CAP and isocan

### Position 1: DO NOT re-architect around speculative native "Agent Principals" (`chrome.agents`); maintain the Service Worker as the Single Dispatch Authority.
- **The Stance:** CAP must treat the Service Worker as the authoritative security boundary and continue managing logical agent principals via software dispatch fences.
- **The Rationale & Evidence:** Chromium's security architecture is strictly anchored to the process/site-isolation boundary (the Origin) and the Extension boundary. There is zero upstream movement toward a 4th principal (`chrome.agents`). Even if Chrome were to introduce an agent identity, platform-level permissions would likely be coarse, prompt-heavy, and disruptive to cross-agent workflows (`delegate_to_agent`).
- **Trade-off:** We maintain a 258-route dispatch authority (`docs/SW-DISPATCH-AUTHORITY-CENSUS.md`) and custom credential sanitizers (`archive-target-registry.js`), but we retain full control over fine-grained execution fences and inter-agent delegation without platform prompts.

### Position 2: DO NOT adopt Chrome's Built-in AI (`window.ai` / Gemini Nano) for the core agent loop or tool orchestration.
- **The Stance:** Confine Built-in AI strictly to zero-cost peripheral tasks (e.g. classification, search indexing, title generation). Never allow it to execute the primary agent tool-calling loop.
- **The Rationale & Evidence:** The Prompt API in Canary/Origin Trial has severe context ceilings (4k–8k tokens) and weak function-calling fidelity. CAP's lazy tool protocol alone requires multi-turn search and schema validation across a 188-tool catalog and complex pipelines (up to 200 steps). Attempting to orchestrate multi-step browser tasks on Gemini Nano causes hallucinated tool calls and immediate context exhaustion.
- **Trade-off:** We accept reliance on external provider APIs and user credentials, but we gain the reasoning depth required to navigate real websites and execute code.

### Position 3: DO NOT abandon the Offscreen Document; harden it as an explicit disposable worker hub.
- **The Stance:** Reject speculative plans to eliminate the offscreen document until Chrome natively supports `new Worker()` in ServiceWorkerGlobalScope (which has been stalled in Chromium for over 6 years).
- **The Rationale & Evidence:** MV3 Service Workers cannot construct DOM or Workers. The offscreen document is an architectural necessity that currently hosts five critical subsystems (script-sandbox, SharedWorkers, Pyodide, Wasm streaming, table workers). The offscreen document *is* a single point of failure (if Chrome reclaims it, all workers die), but CAP's durable run architecture (`run-outbox`, `bootId`, monotonic revision CAS) already makes offscreen disposal crash-safe and recoverable on SW wake.
- **Trade-off:** We maintain the offscreen document and its IPC hop, avoiding premature rewrites for nonexistent SW Worker APIs.

### Position 4: DO transition Backup/Restore from Monolithic IPC to Client-Side Streaming TAR via the File System Access API.
- **The Stance:** Implement carrier bead `8fuc` according to `docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md` (pinned by `tests/streamed-backup-contract.test.ts`).
- **The Rationale & Evidence:** The shipped `data-archive.js` implementation reads all OPFS files into memory and Base64-encodes them into a monolithic JSON string passed via `chrome.runtime.sendMessage`. This forces hard caps of 512 MiB and 100,000 files and triggers OOMs. The File System Access API (`showSaveFilePicker`) is a stable, shipped Chrome feature that allows client-side streaming directly to disk.
- **Trade-off:** Exporting requires a user-gesture tab context (Options or Hub), meaning unattended headless backup via background alarms remains capped, but manual backup scales to arbitrary disk capacity.

### Position 5: DO decouple WebMCP discovery into Declarative Manifests first, with Content-Script Relay as a Fallback.
- **The Stance:** Advocate for declarative tool discovery (`/.well-known/mcp.json` or `<link rel="model-context">`) in W3C standards, while keeping CAP's content-script probe for legacy web pages.
- **The Rationale & Evidence:** Injecting MAIN-world and ISOLATED-world content scripts on every http(s) page requires broad `<all_urls>` host permissions and exposes an extension fingerprinting surface. A declarative manifest allows tool discovery with zero code injection on cooperating sites.
- **Trade-off:** Two discovery paths to maintain, but it significantly reduces the extension's attack surface and privacy footprint on modern web applications.

### Position 6: DO enforce strict isolation on guest language environments (Pyodide & Wasm).
- **The Stance:** Never treat in-browser language runtimes as ambient peers of the extension. Apply fresh-per-run sandboxing across both memory and storage.
- **The Rationale & Evidence:** In `4p7j.3`, we uncovered that Pyodide had ambient access to extension-origin `indexedDB` and `caches`, creating a covert persistence channel between tasks and agents. Enforcing ambient strips and ephemeral MEMFS ensures that guest scripts cannot build covert cross-agent state.
- **Trade-off:** Python and Wasm code cannot use browser storage APIs directly and must route through platform-managed data stores (`create_asset` / `memory_set`), which enforces auditability and owner oversight.

---

## 3. Implementation Roadmap (Beads & Deliverables)

1. **Immediate (Near-Term):**
   - **`chrome-agent-platform-8fuc`**: Implement the client-side streaming TAR backup/restore engine designed in `2g90`.
   - **`chrome-agent-platform-ovfm.3`**: Complete the script-sandbox installable JS module runtime using the digest verification from `ovfm.1-2`.
2. **Medium-Term (Standards & Ecosystem):**
   - Submit formal feedback to W3C WICG on WebMCP (`navigator.modelContext`):
     - Demand declared tool trust levels (`readonly` vs `mutating`).
     - Demand a declarative discovery mechanism (`/.well-known/mcp.json`) to eliminate `<all_urls>` content-script injection.
3. **Long-Term (Upstream Engagement):**
   - Continue tracking Chromium Issue 880768 (`new Worker()` in Service Workers). If Chrome ever implements it, migrate workers from offscreen document to Service Worker to eliminate offscreen IPC overhead.

---

## 4. Summary Recommendation

The web platform will not deliver a native "Agent OS" in the near future. Chrome will continue to treat the Origin as the primary security principal. The winning strategy for `chrome-agent-platform` and `isocan` is **not** to wait for platform miracles, but to:
1. Own the agent principal layer in software with mathematically rigorous capability fences.
2. Exploit genuine shipped web platform primitives (OPFS, File System Access API, Manifest Sandbox CSP, Wasm, Content Scripts).
3. Treat experimental browser features (Prompt API / Gemini Nano) as peripheral accelerators, never as architectural dependencies.
