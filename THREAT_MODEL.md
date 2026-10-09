# Threat Model — Chrome Agent Platform

**Bead:** `chrome-agent-platform-oa3o` · **Created:** 2026-10-06 · **Re-read:** 2026-10-08

**Current audit pin:** `origin/main@28c7189d` (extension `0.3.593`) for the
component map, TB2, S1/S6, T2/T4/T11/T18 and INV-1/2/4/15 revised here.
Other threat and register entries retain their own historical pins until separately
re-read; named symbols are anchors and line numbers are locators, not authority.
`docs/RISK-REGISTER.md` uses the same convention for entries it added after its base pin.
Broker citations use `path#symbol` (for example
`extension/background/service-worker.js#PAGE_ALLOWED_ROUTES.has`):
`tests/security-doc-drift.test.ts` resolves the named declaration, call or route
method in the live source AST and fails if it disappears or is ambiguous. No
renumbering is needed when unrelated code moves. Remaining `path:line`
citations outside the broker inventory are historical locators, not live pins.

This document is the entry point an audit or scanning agent reads BEFORE it reports a
finding. It exists for one reason: a scan that does not know what this project has
already adjudicated re-derives the same decisions, re-rates them critical, and pulls
the andon cord. Section 3 states what is trusted (so a scanner does not report it),
section 4 states what is hostile, and every threat in sections 5 and 6 cites the repo
location that evidences it. Anything plausible that has NO repo evidence belongs in
section 9 and is marked as an open question — it is not asserted as a threat.

**Companion documents (do not restate them; cite them):**

| Document | What it is authoritative for |
|---|---|
| [`docs/RISK-REGISTER.md`](docs/RISK-REGISTER.md) | the architectural risk register (R1–R21 + the withheld decisions) |
| [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md) §1 | the security vector list every change is reviewed against |
| [`docs/INTERNAL-SENDER-CONTRACT-AUDIT.md`](docs/INTERNAL-SENDER-CONTRACT-AUDIT.md) | the sender-classifier adjudication (bead `lw6d`) |
| [`docs/SW-DISPATCH-AUTHORITY-CENSUS.md`](docs/SW-DISPATCH-AUTHORITY-CENSUS.md) | the 290-route dispatch census and its 37 unclassified mutations |
| [`docs/CHROME-TEST-CONTRACT.md`](docs/CHROME-TEST-CONTRACT.md) | which gate runs a real browser, and why a subset gate cannot see a cross-cutting guard |
| [`docs/STREAMING-CREDENTIAL-FILTER-RESERVED-MEMBERS.md`](docs/STREAMING-CREDENTIAL-FILTER-RESERVED-MEMBERS.md) | the archive credential/`__proto__` filter parity contract |
| [`docs/PERMISSION-MATRIX.md`](docs/PERMISSION-MATRIX.md) | the permission-state mechanism classes and their headless acceptance |

---

## 1. System Overview and Architecture

Chrome Agent Platform is a Manifest V3 Chrome extension that makes the browser the
agent runtime. It runs with broad browser power (a new-tab agent hub, a side panel, a
service worker, an offscreen document, sandboxed pages, two content scripts on every
http(s) page) and it acts on two different untrusted feeds at once: web page content
and model output.

Component map, with the file that owns each surface:
- **Offscreen-inventory evidence pin: `origin/main@28c7189d`.** The dispatch census and `tests/sw-dispatch-authority-census.test.ts` assert 290 registered routes on this branch; that earlier main pin had fewer routes. The offscreen host inventory below is taken from the actual `register*Host()` calls and listeners in `extension/offscreen/offscreen.js`, not inferred from the incomplete onMessage-only census §6.2. Re-read named symbols at a newer tree; line numbers are locators.

| Component | Where | Notes |
|---|---|---|
| Service worker (the privileged broker) | `extension/background/service-worker.js#chrome.runtime.onMessage.addListener` | the ONE central dispatcher listener; 290 registered routes |
| Route modules | `extension/background/routes/` | dispatched through `mergeRouteMaps` (census §2) |
| New-tab hub / Settings / side panel | `extension/ntp/`, `extension/options/`, `extension/sidepanel/` | extension documents; principal `extension` / `owner-options` |
| Offscreen document | `extension/offscreen/offscreen.js` | single runtime host: 11 `register*Host()` calls (ACP model, agent worker, Python, Wasm stream, call-export, Emscripten, WASI job, table worker, owner-uploaded Wasm, SVG rasterise, on-device text), plus the script-sandbox and clipboard listeners; reclaim can interrupt in-flight work across those lanes (R12) |
| Sandboxed pages (opaque origin) | `extension/manifest.json:108-113` | `sandbox/script-sandbox.html`, `sandbox/artifact-preview.html` |
| Content scripts | `extension/manifest.json:127-152` | MAIN-world detector + ISOLATED-world relay |
| OPFS memory | `extension/lib/memory.js` | ONE OPFS root, origin-keyed by path (`canonicalOrigin` at `extension/lib/memory.js:308`) |
| Providers | `extension/lib/provider.js`, `extension/lib/provider-server-tools.js` | the two provider paths (boundary TB4) |
| MCP | `extension/lib/mcp-config.js:113`, `extension/lib/mcp-client-core.js:99` | owner-registered external servers |
| WebMCP site tools | `extension/lib/webmcp-authority.js`, `extension/lib/tools.js:511` | page-declared tools, owner-enrolled |
| ACP bridge (host-side) | `scripts/acp-bridge.ts:52`, `:785` | loopback WebSocket in front of a shell-capable harness |

**Offscreen host inventory (authority for register R12; `origin/main@28c7189d`).**
The single `extension/offscreen/offscreen.js` document registers these **11**
`register*Host()` calls, plus two listeners. “SW-only” means the receiver
checks a browser-attested service-worker sender, not just the extension ID;
this does **not** make tool inputs, package bytes, SVG or model output trusted.
The ACP host uses `onConnect` and its own sender predicate; other listeners use
`isTrustedServiceWorkerSender`, its alias, or an equivalent strict predicate.

| Host / offscreen entry | What runs there | Boundary at entry |
|---|---|---|
| `registerAcpModelHost` | ACP model backend/stream, potentially connected to the owner's shell-capable harness | `onConnect` port sender ID, no tab, exact SW URL (`extension/lib/acp-model-host.js:5-13`); no arbitrary page caller |
| `registerAgentWorkerHost` | Per-agent SharedWorker task logic; tools proxy back to the SW | SW-only sender (`extension/lib/agent-worker-host.js:160-163`), SW retains tool authority |
| `registerPythonHost` | Pinned Pyodide runtime and admitted Python code in a fresh worker | SW-only sender (`extension/lib/python-host.js:197-203`), network requests brokered by SW policy (TB4) |
| `registerWasmStreamHost` | Bundled Wasm stream jobs with OPFS stdin/stdout | SW-only sender (`extension/lib/wasm-stream-host.js:225-232`); packaged asset/authority checks |
| `registerCallexportHost` | Zero-import Wasm call-export compute jobs | SW-only sender (`extension/lib/wasm-callexport-host.js:253-259`); package authority |
| `registerEmscriptenHost` | Admitted schema-2 Emscripten glue and Wasm in a fresh worker | SW-only sender (`extension/lib/emscripten-host.js:293-300`); exact job keys and asset hashes |
| `registerWasmJobHost` | Non-stream bundled WASI tool jobs in a worker | SW-only sender (`extension/lib/wasm-job-host.js:17-26`); manifest/CAS re-validation |
| `registerTableWorkerHost` | Bounded table operations in a fresh module worker | SW-only sender (`extension/lib/table-worker-host.js:141-158`); SW retains run custody |
| `registerUserWasmHost` | Owner-uploaded, per-agent-allowlisted Wasm digest in a fresh worker | SW-only sender (`extension/lib/user-wasm-host.js:43-59`); verify stored bytes by digest |
| `registerSvgRasteriseHost` | SVG processed by the browser renderer (not Wasm execution) | SW-only sender (`extension/lib/svg-rasterise-host.js:85-89`); external resources denied |
| `registerOnDeviceTextHost` | Browser Summarizer, LanguageDetector, Translator APIs (not Wasm execution) | SW-only sender (`extension/lib/on-device-text-host.js:248-251`); model input remains untrusted |
| `handleScriptRunMessage` listener | Agent-authored JS in an opaque sandboxed iframe; NTP is a separate on-demand host | SW-only sender (`extension/lib/script-host.js`); sandbox + brokered fetch, not parent-document eval |
| `cap:clipboard-write` listener | Clipboard write in the offscreen document | SW-only sender (`extension/offscreen/offscreen.js:79-89`); not a general page clipboard route |

This table comes from the actual offscreen registration sites; the dispatch
census §6.2 counts only `onMessage` listeners and cannot by itself cover ACP's
`onConnect` port or future hosts. New entries require updating both this
inventory and the sender/inventory guard described in INV-15.

---

## 2. Trust Boundaries and Actors

### 2.1 The boundaries this model assumes

- **TB1 — Extension realm vs page realm.** Everything served from the extension origin
  (hub, Settings, side panel, offscreen, the two sandbox pages) is on the trusted side
  of the code/UI boundary. Everything that loads from a web origin — the page's own
  scripts, the MAIN-world detector's peer, iframes the page embeds — is on the hostile
  side. The boundary is the browser's origin + process split, evidenced by the
  manifest's `content_scripts` split at `extension/manifest.json:127-152` and the
  sandbox page list at `extension/manifest.json:108-113`.
- **TB2 — The service worker is the privileged broker.** No other component may reach
  storage, OPFS, providers or browser control directly: the content-script realm may
  reach exactly seven routes (`PAGE_ALLOWED_ROUTES` in `extension/lib/pure.js#PAGE_ALLOWED_ROUTES`),
  and every other route is refused by `chrome.runtime.onMessage.addListener` at
  `extension/background/service-worker.js#chrome.runtime.onMessage.addListener`
  (check: `extension/background/service-worker.js#PAGE_ALLOWED_ROUTES.has`).
  The receiver derives the origin from the BROWSER-ATTESTED `sender` in that listener,
  never the message body.
- **Evidence pin: `origin/main@28c7189d`.** The cited symbols and closed set were re-read at this tree; line numbers are locators.
- **TB3 — The two provider paths.** Path A sends the conversation from the service
  worker directly to a hosted provider host, listed exhaustively in `OUTBOUND_HOSTS`
  (`extension/lib/provider-catalog.js:111`, pinned by `tests/privacy-statement.test.ts`);
  local presets address loopback addresses the owner configured. Path B is
  provider-EXECUTED tools, where the provider's own server runs the tool and returns the
  result (`extension/lib/provider-server-tools.js`). Both cross the same boundary: the
  conversation and any attached page content leave the machine.
- **TB4 — Brokered fetch egress.** A sandboxed script and the Python worker never fetch
  directly. Their fetch is bridged to the service worker, which fetches from the user's
  network position with the extension's host permission — `cap:fetch` at
  `extension/background/service-worker.js#cap:fetch` and `python.fetch` at
  `extension/background/service-worker.js#python.fetch`, both applying
  `extension/lib/fetch-policy.js:135`.
- **TB5 — The ACP bridge.** A loopback WebSocket on the host in front of an agent
  harness that can run shell commands and write files
  (`scripts/acp-bridge.ts:52` defaults to `127.0.0.1`, `:785` binds the server;
  `:203-208` defines the Origin guard and `:859-867` refuses an unapproved Origin
  or wrong token by default). This is a host-process boundary, not an extension one — the
  extension only ever holds the client end.
- **TB6 — The OPFS root and the extension origin.** Chromium grants the extension
  origin exactly one OPFS root; per-site, per-agent and per-workspace separation is
  application-level path resolution (`extension/lib/memory.js:308`, reserved namespaces
  at `:227` and `:262`). This is register R1 and it is the weakest isolation seam in the
  system, because it has no platform backstop.

### 2.2 Which actor is assumed hostile

Addressed by the model as **hostile**:

1. **Any web page the user visits**, and every byte and every message it controls —
   including the site's own WebMCP tool descriptors and tool results, and any HTML that
   reaches the artifact-preview sandbox.
2. **Model output, in both directions** — a page can steer the model, and a provider (or
   a compromised provider host) can return text and tool calls. Tool calls are
   policy-gated; model *claims* are never authority.
3. **Imported data** — a backup archive, an imported skill, an admitted Wasm or Python
   package, an MCP server's tool output.
4. **External peers** — MCP servers and provider hosts, once the owner has enrolled
   them.

Addressed as **trusted**, and explicitly not to be reported as threats (section 3):
the browser's own sender attestation, the bundled extension source itself, the owner's
gesture in the owner's own UI, and the repository's test suites and fixtures.

---

## 3. Explicitly Trusted (Non-Threats)

Audits should NOT flag these as vulnerabilities. Each is trusted by construction or by
the platform, and each has a mechanical check:

1. **The browser's `MessageSender` attestation.** `sender.tab.id`, `sender.documentId`,
   `sender.documentLifecycle`, `sender.url` and `sender.id` are populated by the browser
   process, not by the renderer, so a content script cannot forge them — see
   `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md` §5 (Assumption 3, "SUPPORTED") and the
   fixtures at `tests/internal-sender-contract-audit.test.ts:62-104`.
2. **The absence of an external messaging channel.** `extension/manifest.json` declares
   no `externally_connectable` and the service worker attaches no
   `chrome.runtime.onMessageExternal` listener; both are pinned executably by
   `tests/internal-sender-contract-audit.test.ts:113-114`. A synthetic "foreign sender"
   fixture is therefore NOT a threat — see section 7, item 1.
3. **The bundled extension source.** MV3 CSP, no `eval`/`new Function` in the bundle
   (`extension/manifest.json:114-117`); the single exemption is the sandbox page, whose
   opaque origin IS the boundary (`extension/sandbox/script-sandbox.js:299`).
4. **The owner's own gesture in the owner's own UI document.** A click in Settings or on
   a card is the authority for the audited owner-direct action list
   (`extension/lib/owner-approval.js:126`, `:178`), pinned by
   `tests/owner-approval-security.test.ts:49-90`. Do not report an owner-direct action
   as "gated by an approval the user already gave".
5. **The repository's test suites, fixtures and harnesses.** `tests/`, `scripts/` and
   `fixtures/` are build-time and operator-time only; nothing there ships in the bundle.
   A finding in a test fixture is a test-quality finding, not a product vulnerability.
   Where a gate runs a real browser is stated in `docs/CHROME-TEST-CONTRACT.md` §2.
6. **The durable evidence and scratch roots.** `~/cap-evidence` (operator machine state)
   and the per-gate Chrome profile directory are not product state.
7. **Local model presets addressing `http://localhost`.** Owner-entered, loopback-only
   by definition, and listed as such in the privacy statement
   (`extension/lib/provider-catalog.js:107`).

---

## 4. Untrusted Attack Surfaces

Ordered by how much authority sits behind them. Every row is an entry point an auditor
should reason about; the threats that use them are in sections 5 and 6.
- **Evidence pin: `origin/main@28c7189d` for S1 and S6–S6f.** Re-read the named symbols at this tree; line numbers are locators.

| ID | Surface | Where it enters | What is hostile about it |
|---|---|---|---|
| S1 | Page content and page messages | `chrome.runtime.onMessage.addListener` at `extension/background/service-worker.js#chrome.runtime.onMessage.addListener`; `PAGE_ALLOWED_ROUTES` at `extension/lib/pure.js#PAGE_ALLOWED_ROUTES` | a page's content script may call only the seven page-allowed routes for its OWN origin, and may put anything in the message body |
| S2 | WebMCP tool descriptors and tool results | `extension/lib/tools.js:511`, `extension/lib/webmcp-authority.js:68` | a site authors its own tool schema and result text |
| S3 | Model output (tool calls and prose) | `extension/lib/lazy-tool-protocol.js:1`, `extension/lib/untrusted-fence.js:59` | a steered model calls real tools |
| S4 | Tool results rendered into the transcript | `extension/shared/components.js:566` (`renderHtmlFrame`) | an artifact body or fetched body is untrusted HTML |
| S5 | Agent-authored script source | `extension/sandbox/script-sandbox.js:299` | the model writes code, the sandbox runs it |
| S6 | Python and bundled Wasm stream/call-export workers | `registerPythonHost`, `registerWasmStreamHost`, `registerCallexportHost` in `extension/offscreen/offscreen.js`; `extension/lib/wasm-executor.js` | admitted or bundled code with brokered execution and bounded workers; Python network requests cross TB4 |
| S6b | Owner-uploaded Wasm tool bytes | `registerUserWasmHost` in `extension/offscreen/offscreen.js`; `extension/lib/user-wasm-host.js` | stored without binary validation; once an agent allows a digest, its catalog tool executes verified bytes in a fresh worker |
| S6c | Admitted Emscripten JS glue and Wasm assets | `registerEmscriptenHost` in `extension/offscreen/offscreen.js`; `extension/lib/emscripten-host.js` | package assets and scalar arguments enter an exact-key job envelope and a fresh module worker |
| S6d | Bundled WASI job modules | `registerWasmJobHost` in `extension/offscreen/offscreen.js`; `extension/lib/wasm-job-host.js` | non-stream bundled tools run after manifest/CAS re-validation; an untrusted caller must not forge the job |
| S6e | SVG rasterise requests | `registerSvgRasteriseHost` in `extension/offscreen/offscreen.js`; `extension/lib/svg-rasterise-host.js` | untrusted SVG is rendered by the browser; this is a document/renderer lane, not Wasm execution |
| S6f | On-device text requests | `registerOnDeviceTextHost` in `extension/offscreen/offscreen.js`; `extension/lib/on-device-text-host.js` | untrusted inputs reach browser-provided Summarizer/LanguageDetector/Translator APIs in the offscreen document, not a Wasm worker |
| S7 | Imported archives | `extension/lib/archive-target-registry.js:375`, `:427` | a file the owner restores carries attacker-chosen keys and values |
| S8 | MCP server output | `extension/lib/mcp-client-core.js:99` | a registered server returns arbitrary text and tool results |
| S9 | Provider responses and provider errors | `extension/lib/pure.js:1034`, `:1102` | an endpoint can echo a credential back into a log or a card |
| S10 | Host-side ACP WebSocket clients | `scripts/acp-bridge.ts:859-867` | a local client with the token (or unauthenticated under --allow-anonymous-loopback) can drive a shell-capable agent; a web page without an approved Origin and token is refused |
| S11 | Owner-supplied local folders (fs grants) | `extension/lib/fs-grants.js:47`, `:130` | path strings the owner grants are still resolved by the extension |
| S12 | Hook event payloads | `extension/lib/hooks.js:494`, `:550` | a hook body is serialized into a model INSTRUCTION position |
| S14 | Model-authored user-script and content-script registration | `extension/lib/browser-tools.js:6345`, `:6484` | a model registers persistent JavaScript (up to 32 KiB) to execute across web origins via chrome.userScripts.register or chrome.scripting.registerContentScripts |

---

## 5. Threats

Each threat names the boundary it crosses, its evidence location, and the control that
currently answers it. Numbering here is local to this document; the architectural
consequences are carried by the matching register entry where one exists.

### T1. Cross-origin memory read through path resolution on the single OPFS root

- **Boundary:** TB6. **Evidence:** `extension/lib/memory.js:308` (`canonicalOrigin`),
  `:227` / `:262` (reserved master and site namespaces),
  `extension/lib/opfs-tool-workspace.js:43` (`WORKSPACE_ROOT`). **Answer:** injective reversible origin
  encoding, rejection of non-web schemes, reserved-key fences, and the A/B isolation
  test. **Register:** R1.

### T2. Sender-origin spoofing by a content script

- **Boundary:** TB2. **Evidence:** `authorizeToolReport` at
  `extension/lib/pure.js#authorizeToolReport` (the classifier), `PAGE_ALLOWED_ROUTES` at
  `extension/lib/pure.js#PAGE_ALLOWED_ROUTES`, and the central listener at
  `extension/background/service-worker.js#chrome.runtime.onMessage.addListener`
  (page-route check: `extension/background/service-worker.js#PAGE_ALLOWED_ROUTES.has`;
  browser-derived `message.origin` overwrite immediately after). **Answer:** the
  origin comes from the sender, never from the body; a claimed-origin mismatch is
  refused. **Live proof:** `scripts/security-suite.ts:307-308` (a page MAIN world has no
  `chrome.runtime` at all) and `docs/CONSTITUTION.md:17`.
- **Evidence pin: `origin/main@28c7189d` for TB2/T2.** The sender-derived origin and page-route allowlist were re-read at the symbols in TB2; older T2 line locators are historical.

### T3. Sender-classifier default: an out-of-spec sender is classified as an extension document

- **Boundary:** TB2. **Evidence:** `extension/lib/pure.js:934` — when a sender is not a
  content script and has no tab URL, the classifier returns `{ kind: "extension" }`.
  **Adjudication:** ADJUDICATED AND WITHHELD. There is no known producer for the
  browser-attested tabless/opaque sender shape:
  `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md` §3 and §5 (Assumption 2), pinned by
  `tests/internal-sender-contract-audit.test.ts:14-25` (synthetic fixture) and
  `:113-114` (no `externally_connectable`, no `onMessageExternal`). **Register entry:
  R22** — with its reopen trigger. Audits MUST NOT re-report this as new; cite R22.

### T4. Unclassified service-worker mutations

- **Boundary:** TB2. **Evidence:** `docs/SW-DISPATCH-AUTHORITY-CENSUS.md` §4.9 — 37
  routes mutate persistent state with no route-local principal check and no approval
  gate (for example `named-agent.set-tools` at `extension/background/service-worker.js#named-agent.set-tools`
  and `asset.export-to-folder` at `extension/background/service-worker.js#asset.export-to-folder`; `background-agent.delete` is owner-direct,
  not in this 37). **Answer:** the central listener refuses every
  non-page-allowed route to page senders (allowlist check at
  `extension/background/service-worker.js#PAGE_ALLOWED_ROUTES.has`),
  so the class is reachable only from extension principals. **Register:** R11.
- **The executable census pins the current count.** The census §4.9 lists 37 unclassified mutations among 290 registered routes on this branch; consult its route rows for locations rather than interpreting older T4 line locators as current.

### T5. Sandbox escape and network egress from the script sandbox

- **Boundary:** TB1 / TB4. **Evidence:** `extension/sandbox/script-sandbox.js:299`
  (`new Function` inside the opaque-origin sandbox), CSP at
  `extension/manifest.json:114-117`, `extension/shared/components.js:460` / `:566`
  (`injectCspMeta` / `renderHtmlFrame`). **Live proof (real browser, driven):**
  `scripts/security-suite.ts:264-284` — zero attacker requests, blocked
  `parent.document`, blocked top navigation, `window.opener === null`, no `chrome.runtime`.
  Unit half: `tests/security.test.ts:100` and `:122`.

### T6. SSRF and URL-channel exfiltration through the brokered fetch

- **Boundary:** TB4. **Evidence:** `extension/lib/fetch-policy.js#isPrivateOrLoopbackHost`,
  `#checkFetchPolicy`, `#extractFetchHosts`; shared by `checkPythonNetworkRequest`
  (`extension/lib/python-network.js#checkPythonNetworkRequest`), the enclave proxy
  (`extension/background/routes/enclave-proxy.js#enclaveProxy`), and skill import
  (`extension/lib/skill-import.js#validateHttpUrl`, `#fetchWithSafeRedirects`, `#fetchGitHubSkill`,
  `#discoverRepoSkillsAndCommands`, `#installBatchSkillsAndCommands`); SW routes at
  `extension/background/service-worker.js#cap:fetch` (`cap:fetch`),
  `extension/background/service-worker.js#python.fetch` (`python.fetch`), and
  `extension/background/service-worker.js#skill.import` (`skill.import` / `skill.discover` / `skill.importBatch`).
  All skill-import remote fetches enforce `redirect: "manual"` via `fetchWithSafeRedirects`: uninspectable
  `opaqueredirect` responses are refused fail-closed (the live enforcement in browser environments), while
  inspectable 3xx responses re-validate each `Location` hop against `checkFetchTarget` up to a bounded hop count
  (`MAX_REDIRECT_HOPS = 5`) as defense-in-depth where `Location` is inspectable, closing open-redirect
  SSRF into private or metadata addresses. Direct GitHub raw links (`github.com/<owner>/<repo>/raw/...`) are
  pre-normalized to `raw.githubusercontent.com` to prevent browser redirect failures. Discovery paths validate
  repository trees, marketplace files (`.claude-plugin/marketplace.json`), and command/skill download URLs
  through the same predicate. **Tests:** `tests/cap-fetch-deny.test.ts`, `tests/skill-import-ssrf.test.ts`; live SSRF
  probe at `scripts/security-suite.ts:389`. **Residual, stated in the source:** DNS-to-private/rebinding of a public hostname
  remains out of scope without a resolving DNS-pinning proxy (`extension/lib/fetch-policy.js:21`); unlike sandboxed script
  runs (`checkFetchPolicy`), skill-import fetches do not enforce an approved-host allowlist because the owner directly supplies
  the target URL. **Register:** R23 (adjudicated and withheld in §7 item 9).

### T7. Credential exfiltration into hook prompts, logs and errors

- **Boundary:** S12 / S9. **Evidence:** `extension/lib/pure.js:959` (`SECRET_KEY_RE`),
  `:1114` (`redactSecrets`), `:1034` (`redactSecretText`), `:1102` (`safeProviderError`).
  **Tests:** `tests/security.test.ts:79-99`, `tests/secret-redaction.test.ts:10-40`.
  The historical shape — the `storage.onChanged` hook forwarded `providerConfig.apiKey` —
  is the reason this module exists (`extension/lib/pure.js:952-958`).

### T8. Credential smuggling and prototype pollution through an imported archive

- **Boundary:** S7. **Evidence:**
  `docs/STREAMING-CREDENTIAL-FILTER-RESERVED-MEMBERS.md` §2 —
  `extension/lib/archive-target-registry.js:375` and `:444` strip `__proto__` together
  with the three credential keys inside every recursive redacted context, because a
  3-key streaming filter is demonstrably NOT equivalent to the canonical sanitizer.
  **Test:** `tests/streaming-credential-filter-parity.test.ts`.

### T9. Prompt injection: page content steering a model into a destructive action

- **Boundary:** S1 → S3. **Evidence:** `extension/lib/untrusted-fence.js:46-96`
  (per-assembly random boundary token, `wrapUntrustedContent`, `tagUntrusted`,
  `renderUntrustedPolicy`), the protected system-prompt layer at
  `extension/lib/system-prompts.js:763-773`, and the approval gate for the destructive
  action set at `extension/lib/owner-approval.js:23`. **Live proof:**
  `scripts/security-suite.ts:274` (no extension API inside the sandbox) and
  `:430-437` (a real run pauses on the card). **Register:** R4.

### T10. WebMCP tool invocation beyond the consent the owner gave

- **Boundary:** S2. **Evidence:** `extension/lib/tools.js:511` (`isApproved`), the
  authority evaluation at `extension/lib/webmcp-authority.js:68` and the dispatch gate at
  `:163`; enrolment-derived tool directory and per-tool consent generations. The
  residual question (does enrolment alone consent to a MUTATING tool?) is register R9.

### T11. Broad host access and the universal extension fingerprint

- **Boundary:** TB1 → page. **Evidence:** `extension/manifest.json:124-126`
  (`host_permissions: ["<all_urls>"]`) and `:127-152` (two content scripts at
  `document_start`); the MAIN-world probe sets `window.__cap_webmcp_detect` at
  `extension/content/webmcp-detect-main.js:5` with an HMAC tag minted at `:33-41`. **Answer:**
  the relay derives the origin from its OWN `location.origin`
  (`extension/content/webmcp-detect-relay.js:57`), so a page cannot forge a capability
  snapshot for another origin. **WebMCP MAC trust limit:** `extension/content/bridge-auth.js`
  tags cross-world `postMessage` traffic using an extension-delivered nonce and a
  monotonic sequence. That protects the transport from a page script merely observing
  or injecting messages; it does **not** make the MAIN world, the page's tool
  descriptors, or tool results trusted. A page that ran first or poisoned realm
  intrinsics can affect its own bridge. Sender-derived origin/document, generation
  fencing, exact binding and owner consent remain the SW authority boundary (TB1/TB2,
  S1/S2); the bridge must fail closed. **Register:** R3 and R16.

### T12. Wildcard `postMessage` targets carrying a payload that names a secret or an action

- **Boundary:** TB1 frame edges. **Evidence:** `tests/postmessage-wildcard-guard.test.ts:1-15`
  (every remaining wildcard target is a DELIBERATE allowlisted entry with a written
  reason, and a new wildcard whose payload names a secret or an action fails the guard).
  The channels that legitimately carry `"*"` are the opaque-origin sandbox bridges,
  whose target origin cannot be named, and they are guarded by a run id plus nonce.

### T13. Hooks: an event-driven model invocation as an un-gated write path

- **Boundary:** S12. **Evidence:** `extension/lib/hooks.js:399` (`checkHookAllowed` —
  the owner deny-list, checked FIRST and fail-closed), `:494` (`subscribeHook`), with the
  owner-approval seam invoked at `:550` (it was `:516` before 51cd). `hooks.subscribe` is
  classified approval-required in the dispatch census §4.4 and in
  `tests/owner-approval-classification.test.ts:25`.
- **Evidence pin: `origin/main@213bafbc`.** The file:line citations in this threat (and in
  the S12 row above) were re-read against that tree. They MOVED off the document pin when
  4h47 and hlgr landed after 51cd — the `subscribeHook` declaration, the `service-worker.js`
  route and the classification test line all shifted. Treat the named symbol as the anchor
  and the line as the locator, and re-read both if the tree has moved again.
- **CONTROL: LANDED (chrome-agent-platform-51cd, merge `2b4da1f3`).** The seam runs for
  EVERY subscribe rather than only a replacement — it is gated on
  `typeof gate === "function"`, not the old `if (existing && …)` — and it is invoked with
  `{ existing: existing ? { …existing } : null }`, so a FIRST-TIME `(hookId, skillId)` pair
  reaches the owner gate instead of being written on the deny-list check alone. A
  model-authored `promptTemplate` can no longer reach the instruction position either: the
  model-callable tool carries no template field (`extension/lib/management-tools.js:459-463`,
  its call at `:466`), and the route forces a model principal's template to empty
  (`extension/background/service-worker.js#hooks.subscribe`, the route's owner gate) — which
  matters because `dispatchHook` (`extension/background/service-worker.js#dispatchHook`)
  executes that template verbatim as the recurring run's task.
- **Falsifiable, not prose:** `tests/hook-subscribe-approval.test.ts` drives the REAL route
  through the MODEL path with the real approval store and asserts that a first-time
  subscribe publishes one approval card and leaves exactly one pending row, that nothing
  is persisted before the owner decides, and that a same-pair replacement still gates. The
  file names the mutant it is calibrated against
  (`tests/hook-subscribe-approval.test.ts:22-23`): restoring the old
  `if (existing && typeof gate === "function")` short-circuit must turn its first two
  tests RED. Those assertions, not this paragraph, are what would catch a regression.
- **Residual, to re-read at audit time:** the seam stays OPTIONAL in `hooks.js` by design —
  internal seed callers pass no gate (`extension/lib/agent-seeds.js:164` and
  `extension/background/service-worker.js#background-agent.set` for skill enable/disable) —
  so the control lives in the ROUTE, and a change to who may call `subscribeHook` directly
  reopens it.
- **Register:** no entry — an ENFORCED decision is a delivered control, not a withheld one,
  so it is held by this threat rather than by Class 5 (`docs/RISK-REGISTER.md`, Class 5
  preamble).

### T14. MCP: unbounded server count and argument egress to a third party

- **Boundary:** S8. **Evidence:** `extension/lib/mcp-config.js:113`
  (`normalizeMcpServerList` enforces no upper bound) and `extension/lib/mcp-client-core.js:99`
  (`mountRemoteMcpServers`). **Answer:** first-use per-server approval, fenced results,
  action-ledger rows. **Register:** R10.

### T15. A web page driving the local shell-capable ACP harness

- **Boundary:** TB5. **Evidence:** `scripts/acp-bridge.ts:52` (loopback default),
  `:191-208` (`originAllowed` admits extension origins and local clients without Origin),
  `:859-867` (403 on a refused Origin or wrong token, including loopback by default), and
  `:137-189` (the default shared secret persists across restarts). **Test:**
  `tests/acp-bridge-security.test.ts:49-60` (a web Origin is refused, an extension
  Origin is accepted); `:189-230` (the persisted token survives restart).
- **Residual (accepted, `chrome-agent-platform-6hly`):** by default, the loopback WebSocket
  bridge authenticates the client, not the server (under --allow-anonymous-loopback,
  neither authenticates the other). If an unprivileged local
  process binds `127.0.0.1:3210` before the real bridge (or while it is down),
  the extension hands the process its persisted token in the upgrade query
  (`extension/lib/acp-runner.js:260,292-298,551-552`); it can impersonate the
  shell-capable harness or reuse that token later. The decision assumes a
  single-user development machine whose local processes are owner-controlled;
  it must be reopened if that assumption changes. **Register:** R24.

### T16. Resource exhaustion rather than data theft

- **Boundary:** operator. **Evidence:** the de-fanged quota check at
  `extension/lib/memory.js:745` (the call site records the delta and enforces nothing,
  `:857`) and `extension/lib/artifacts.js:422`; the 180 s Wasm wall clock at
  `extension/lib/wasm-stream-host.js:12`; the archive caps at
  `extension/lib/data-archive.js:104-105`. **Register:** R5, R15, R19.

### T17. Approval-machinery limits that turn a gate into an outage

- **Boundary:** owner. **Evidence:** `extension/lib/owner-approval.js:15-16`
  (`MAX_PENDING_APPROVALS = 64`, `APPROVAL_TTL_MS = 60_000`). A run that raises a card
  while the owner is away aborts after 60 seconds with an expiration failure. **Register:** R7.

### T18. Forged offscreen execution messages or confused job envelopes

- **Boundary:** TB2 → S6–S6f. **Evidence:** `extension/offscreen/offscreen.js`
  registers 11 hosts alongside script/clipboard listeners; those runtime listeners
  share the extension message bus. A same-extension document or content script
  must not submit `cap:user-wasm-run`, `cap:emscripten-run`, `cap:wasm-wasi-job-run`
  or the other host job types as though it were the privileged broker.
  **Controls:** `isTrustedServiceWorkerSender` (`extension/lib/pure.js:959`) checks
  the extension ID, absent tab/document identities and exact background bundle URL;
  user-Wasm, WASI-job, Emscripten, SVG and on-device text listeners gate their
  respective commands before execution. The ACP model host uses `onConnect`,
  not the onMessage census, and validates the port sender's ID, absent tab and
  exact background URL (`extension/lib/acp-model-host.js:5-13`). The Emscripten
  request uses an exact-key envelope (`extension/lib/emscripten-host.js:30-54`,
  `:110`) and checks each asset's size and SHA-256 before a fresh worker (:168).
  **Residual:** census §6.2 is onMessage-only and does not enumerate the ACP
  port or every registered host; `tests/onmessage-sender-guard.test.ts` covers
  known listeners but does not yet pin the complete `register*Host()` inventory.
  A new host must be reviewed for sender and envelope authority, not inferred
  safe from another host's guard. **Register:** R12/R14/R15.

### T19. Persistent model-authored script registration without owner-visible digest approval

- **Boundary:** TB2 / TB4. **Evidence:** `extension/lib/browser-tools.js` (`register_user_script`,
  `update_user_script`, `register_content_script`, `update_content_script`),
  `extension/lib/owner-approval.js:90` (`DESTRUCTIVE_ACTIONS`),
  `extension/background/service-worker.js#browser.destructive-action`.
- **Threat:** a model steered by prompt injection or untrusted page content registers
  persistent JavaScript to execute on target web origins across future browsing sessions.
- **Answer:** the registration path requires host permissions and browser-control grants for
  every target origin, asserts run ownership, and enforces an owner-visible approval card
  bound to the canonical SHA-256 digest of the complete, untruncated script source (INV-8).

---

## 6. Security Invariants for Auditors

These are the properties a change must not break. Each is stated so it can be falsified,
and each names the executable check that would catch a regression.

- **INV-1 — Authority is derived from the browser-attested sender, never from the body.**
  `authorizeToolReport` at `extension/lib/pure.js#authorizeToolReport` and the central listener at
  `extension/background/service-worker.js#chrome.runtime.onMessage.addListener`
  (browser sender classification and derived-origin overwrite inside that listener);
  `scripts/security-suite.ts:307-308`. A new route that reads an origin, tab id or
  document id out of the message body breaks this.
- **Evidence pin: `origin/main@28c7189d` for INV-1/2.** The sender/allowlist symbols were re-read at this tree; other invariant citations retain their own historical context.
- **INV-2 — The page-reachable route set is closed and tiny.**
  `PAGE_ALLOWED_ROUTES` at `extension/lib/pure.js#PAGE_ALLOWED_ROUTES`, pinned by
  `tests/internal-sender-contract-audit.test.ts` (closed-page-route assertion).
  An admin route appearing in that set breaks this.
- **INV-3 — No external messaging channel exists.** No `externally_connectable`, no
  `onMessageExternal` listener: `tests/internal-sender-contract-audit.test.ts:113-114`.
  This invariant is what makes T3 a withheld decision rather than an exploit, so a change
  that adds either one REOPENS R22.
- **INV-4 — Ordinary extension JS has no dynamic `eval` / `new Function`.**
  The manifest sandbox page is the explicit JS-eval exemption
  (`extension/manifest.json:108-117`). This does **not** mean no code executes:
  the extension-pages CSP permits `'wasm-unsafe-eval'` (manifest :115), and
  the offscreen workers execute admitted Wasm/Emscripten/Python through the
  lanes in S6–S6d. A new JS-eval site in `extension/lib/` breaks the invariant.
- **INV-5 — Every broker-mediated fetch applies the private-address deny list AND the
  per-run host allow-list, with no credentials and no redirect following.**
  `extension/lib/fetch-policy.js:135`; `extension/background/service-worker.js#cap:fetch`,
  `extension/background/service-worker.js#python.fetch`. A new egress helper that calls `fetch` directly breaks this.
- **INV-6 — A credential-shaped key never reaches a prompt, a log, a receipt or an error
  string.** `extension/lib/pure.js:959`, `:1114`; `tests/security.test.ts:79-99`,
  `tests/secret-redaction.test.ts`.
- **INV-7 — Untrusted content reaches the model only inside a per-assembly random
  boundary, and the model is told that fenced text is data.**
  `extension/lib/untrusted-fence.js:46-96`; `extension/lib/system-prompts.js:763-773`.
- **INV-8 — Destructive actions require an approval bound to the exact action, target and
  payload digest, and expiring.** `extension/lib/owner-approval.js:23`, `:533`, `:634`;
  `extension/lib/browser-tools.js` (`register_user_script`, `update_user_script`,
  `register_content_script`, `update_content_script` digest approval via `browser.destructive-action`).
- **INV-9 — Origin-keyed isolation is injective and reserved namespaces are fenced.**
  `extension/lib/memory.js:227`, `:262`, `:308`.
- **INV-10 — Imported archives strip `__proto__` and the credential keys TOGETHER in every
  recursive redacted context.** `extension/lib/archive-target-registry.js:375`, `:444`;
  `docs/STREAMING-CREDENTIAL-FILTER-RESERVED-MEMBERS.md` §2.
- **INV-11 — Browser mutations accept `http(s)` destinations only, before any grant
  check.** `extension/lib/browser-tools.js:556`
  (`webDestination`); `docs/CONSTITUTION.md:29-33`.
- **INV-12 — A page's MAIN world has no extension API.** `extension/content/webmcp-detect-main.js:5`;
  `scripts/security-suite.ts:308`.
- **INV-13 — Every wildcard `postMessage` target is a deliberate, reasoned allowlist
  entry.** `tests/postmessage-wildcard-guard.test.ts:1-15`.
- **INV-14 — The ACP bridge refuses any non-extension Origin unless one was named
  explicitly, requires a token even on loopback by default, and binds loopback by default.**
  The explicit `--allow-anonymous-loopback` opt-out is a deliberate, loopback-only
  exception; combining the flag with a non-loopback bind or unvalidated hostname is a startup error.
  `scripts/acp-bridge.ts:52`, `scripts/acp-bridge.ts:109-116`, `scripts/acp-bridge.ts:203-208`,
  `scripts/acp-bridge.ts:859-867`; `tests/acp-bridge-security.test.ts:49-60`,
  `tests/acp-loopback-optout.test.ts`.
- **INV-15 — Every new offscreen execution host must authenticate the service
  worker before handling a job.** `isTrustedServiceWorkerSender` at
  `extension/lib/pure.js:959` is the common onMessage predicate; the ACP model
  host validates its `onConnect` sender separately (`extension/lib/acp-model-host.js:5-13`).
  An extension ID alone does not establish the SW principal because documents
  and content scripts share it. Validate each host's exact job envelope and
  asset identity as appropriate (`extension/lib/emscripten-host.js:30-54`,
  `:110`, `:168`). The existing onMessage sender guard does not yet prove
  inventory completeness; adding a new registration without updating this
  model and its guard must be treated as an unreviewed change.

---

## 7. Explicit Exclusions (Accepted Risks and Withheld Hardening)

Pre-approved. Do not open a new finding for these; cite the register entry that owns the
decision and, where one exists, the trigger that would reopen it.

1. **The tool-report classifier's extension default (T3).** ADJUDICATED AND WITHHELD
   (`chrome-agent-platform-lw6d`; `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md`). No
   `externally_connectable`, no `onMessageExternal`, and no known producer for the
   tabless/opaque sender shape — and a naive id/URL filter risks breaking legitimate
   tabless internal frames (the offscreen document, side panel, and sandboxed iframes all
   legitimately lack tab context: `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md` §4). **Owning
   register entry: R22, including its reopen trigger.**
2. **Broad `<all_urls>` host access and the passive fingerprint (T11).** Settled owner
   posture (question Q18, resolved (a) on 2026-08-31): the extension can read every page
   in order to notice when a site offers tools; it acts on a site only after the owner
   allows it (`extension/lib/privacy-statement.js:25-27`). Register R3, R16.
3. **Prompt-level fencing is a boundary made of instructions (T9).** Accepted: there is no
   web-platform primitive yet that enforces data/code separation at the model boundary.
   Register R4.
4. **Enrolment is the consent for an origin's tools (T10).** Accepted for reading tools;
   the mutating-tool question stays open in register R9.
5. **No application-level byte ceiling (T16).** Chromium's native OPFS quota is the
   operative ceiling since directive `dptw`. Register R5.
6. **The 60-second approval TTL (T17).** Accepted; the correct behaviour is an honest
   expiration failure rather than an approval that outlives the moment it was requested.
   Register R7.
7. **The 37 unclassified mutation routes (T4).** Inventory accepted; only extension
   principals can reach them. Register R11.
8. **The `debugger` permission is absent.** Not an accepted risk so much as a standing
   prohibition: `tests/chrome-tools-t12.test.ts` holds the removal guard and the journey
   suite asserts absence from the manifest (`docs/CONSTITUTION.md:107`).
9. **Brokered fetch DNS rebinding (TM-104 / v6ej).** ADJUDICATED AND WITHHELD.
   Accepted on 2026-10-05 by coordinator lane (`chrome-agent-platform-coord`) on
   platform-limitation grounds (no MV3 DNS/IP primitive; owner ratification pending).
   The service worker fetch policy (`extension/lib/fetch-policy.js:21`) enforces the
   private/loopback deny list on the URL host string and cannot resolve DNS or pin
   socket destination IPs within the MV3 platform. Bounded by the owner-approved
   per-run host allowlist (`checkFetchPolicy` for script fetch), per-origin grants
   (`python.fetch`), frozen service allowlists (enclave proxy), and owner-supplied
   source URLs with manual redirect controls (`skill.import` / `skill.discover` / `skill.importBatch`).
   **Owning register entry: R23, including its reopen trigger.**
10. **ACP loopback server-identity bind race (T15 / 6hly).** ADJUDICATED AND
    WITHHELD by the operator on 2026-10-06 under the single-user development-
    machine assumption. By default, a local process that wins the `127.0.0.1:3210` bind
    receives the persisted token; the client cannot authenticate that server.
    Reopen if the machine is shared or hosts an untrusted local process. This
    is not voicebox `k74h` (a cross-origin web-page threat in another project).
    **Owning register entry: R24, including alternatives and the reopen trigger.**

---

## 8. Bug-Shape Hints from History

Shapes distilled from this repo's own review canon, with the verification question each
one implies. `docs/CHROME-TEST-CONTRACT.md` §5 and the "Test honesty" section of
`AGENTS.md` are where these come from.

1. **A control that exists only on one path — usually the replace path.** A gate written
   as `if (existing && …)` fires on update and not on create. *Verification:* for every
   gated write in your diff, drive the CREATE case, not the update case. Historical
   instance, now CLOSED (`2b4da1f3`): the hook subscribe seam at `extension/lib/hooks.js:550`,
   which fired on the replace path only (T13) — and `tests/hook-subscribe-approval.test.ts`
   is the guard that fails if the shape returns.
2. **A fail-open default on an out-of-spec input.** A classifier that names a default for
   "I could not tell" rather than refusing. *Verification:* feed the classifier the
   degenerate sender (no tab, no url, no document id) and read what it returns.
   Live instance: `extension/lib/pure.js:934` (T3).
3. **A pin satisfied by the wrong occurrence.** A substring or import that exists in a
   comment, an import specifier or a log line pins nothing about execution.
   *Verification:* delete the construct and leave the import — does the pin fail?
4. **A gate that is claimed but not invoked.** The call site disappears while the config,
   the constant and the comment stay. *Verification:* find the CALL, not the name.
5. **A credential leak through a generic serializer.** `redactSecrets` exists because a
   hook forwarded a whole config object. *Verification:* for any new object crossing into
   a prompt or a log, ask which keys are credential-shaped.
6. **A wildcard `postMessage` target reappearing.** The origin-scoped pattern was closed
   once and was not generalised; the guard now forces every remaining site to be a
   considered entry. *Verification:* `tests/postmessage-wildcard-guard.test.ts` must be
   selected by the gate you ran — a subset gate does not necessarily see a cross-cutting
   guard (`docs/CHROME-TEST-CONTRACT.md` §5).
7. **A green result against the wrong tree.** A fixed debugging port, a stale
   `dist.complete`, or a build older than the source all produce confident verdicts about
   a tree that was never loaded. *Verification:* name the tree the evidence came from,
   and re-run the build if any commit landed after it.

---

## 9. Open Questions (No Repo Evidence — Not Asserted Threats)

These are plausible. None of them has a repo location that evidences it as a live defect,
so they are NOT threats here; they are questions for the owner or for a future audit that
brings evidence. Do not report them as findings without one.

1. **Provenance of the bundled third-party dependencies.** The build fails closed on
   dependency-integrity invariants (duplicated instances, lockfile drift: `build.mjs`),
   which constrains what is in the graph but does not attest where it came from. Is a
   supply-chain compromise of an npm/deno dependency in scope for a future audit, and
   what evidence would establish it?
2. **A platform-level defect in sender attestation.** The whole TB2 boundary rests on
   Chromium populating `MessageSender` truthfully. A browser bug there is out of the
   extension's control; is there a detection drill worth owning, or is this purely a
   "trust the browser" assumption to be restated rather than tested?
3. **A compromised browser profile reading user-entered keys.** The owner's provider key
   is stored as typed and not encrypted, and the privacy statement says so
   (`extension/lib/privacy-statement.js:40`). Whether that needs a stronger at-rest
   story is a product decision, not a code defect.
4. **Model-provider compromise beyond error echo.** The redaction layer covers a provider
   echoing a credential back. Whether an adversarial provider can do more with the
   conversation it receives is unanswered by any test in this repo.
5. **At-rest integrity of OPFS memory.** Origin isolation is one property; tamper
   detection of memory contents across sessions is another, and nothing in the repo
   claims it. Is that in scope?
6. **Distribution-channel security review.** The Store release requirement was closed as
   not required (question Q11, resolved 2026-09-18; distribution is the unpacked
   developer demo), so "Store review exposure" (register R16) has no consumer today.
   Whether that changes the R16 rating is an owner call, not an audit finding.
