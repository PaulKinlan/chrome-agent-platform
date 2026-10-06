# Threat Model — Chrome Agent Platform

**Bead:** `chrome-agent-platform-oa3o` · **Date:** 2026-10-06 ·  
**Tree pinned at:** `origin/main@75e032f7` (extension `0.3.577`). A threat re-read after
that pin carries its own `Evidence pin:` line naming the tree it was read at (T13 does);
`docs/RISK-REGISTER.md` uses the same convention for entries it added after its base pin.

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
| [`docs/SW-DISPATCH-AUTHORITY-CENSUS.md`](docs/SW-DISPATCH-AUTHORITY-CENSUS.md) | the 260-route dispatch census and its 31 unclassified mutations |
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

| Component | Where | Notes |
|---|---|---|
| Service worker (the privileged broker) | `extension/background/service-worker.js:11923` | the ONE `chrome.runtime.onMessage` listener; 260 registered routes |
| Route modules | `extension/background/routes/` | dispatched through `mergeRouteMaps` (census §2) |
| New-tab hub / Settings / side panel | `extension/ntp/`, `extension/options/`, `extension/sidepanel/` | extension documents; principal `extension` / `owner-options` |
| Offscreen document | `extension/offscreen/offscreen.js` | one document multiplexes five subsystems (register R12) |
| Sandboxed pages (opaque origin) | `extension/manifest.json:108-113` | `sandbox/script-sandbox.html`, `sandbox/artifact-preview.html` |
| Content scripts | `extension/manifest.json:127-152` | MAIN-world detector + ISOLATED-world relay |
| OPFS memory | `extension/lib/memory.js` | ONE OPFS root, origin-keyed by path (`canonicalOrigin` at `extension/lib/memory.js:308`) |
| Providers | `extension/lib/provider.js`, `extension/lib/provider-server-tools.js` | the two provider paths (boundary TB4) |
| MCP | `extension/lib/mcp-config.js:113`, `extension/lib/mcp-client-core.js:99` | owner-registered external servers |
| WebMCP site tools | `extension/lib/webmcp-authority.js`, `extension/lib/tools.js:511` | page-declared tools, owner-enrolled |
| ACP bridge (host-side) | `scripts/acp-bridge.ts:44` | loopback WebSocket in front of a shell-capable harness |

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
  reach exactly eight routes (`extension/lib/pure.js:1178-1187`) and every other route
  is refused at the listener (`extension/background/service-worker.js:11953-11957`).
  The receiver's authority is derived from the BROWSER-ATTESTED `sender`, never from the
  message body (`extension/background/service-worker.js:11935-11940`, `:11960`,
  `:11969-11979`).
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
  `extension/background/service-worker.js:6882` and `python.fetch` at
  `extension/background/service-worker.js:6955`, both applying
  `extension/lib/fetch-policy.js:135`.
- **TB5 — The ACP bridge.** A loopback WebSocket on the host in front of an agent
  harness that can run shell commands and write files
  (`scripts/acp-bridge.ts:44` binds `127.0.0.1` by default; the Origin guard is
  `scripts/acp-bridge.ts:67-71` and the refusal at `:641-646`). This is a host-process
  boundary, not an extension one — the extension only ever holds the client end.
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

| ID | Surface | Where it enters | What is hostile about it |
|---|---|---|---|
| S1 | Page content and page messages | `extension/background/service-worker.js:11923` listener; page routes at `extension/lib/pure.js:1178-1187` | a page may call any of the eight allowed routes for its OWN origin, and may put anything in the message body |
| S2 | WebMCP tool descriptors and tool results | `extension/lib/tools.js:511`, `extension/lib/webmcp-authority.js:68` | a site authors its own tool schema and result text |
| S3 | Model output (tool calls and prose) | `extension/lib/lazy-tool-protocol.js:1`, `extension/lib/untrusted-fence.js:59` | a steered model calls real tools |
| S4 | Tool results rendered into the transcript | `extension/shared/components.js:566` (`renderHtmlFrame`) | an artifact body or fetched body is untrusted HTML |
| S5 | Agent-authored script source | `extension/sandbox/script-sandbox.js:299` | the model writes code, the sandbox runs it |
| S6 | Python worker and Wasm modules | `extension/lib/wasm-executor.js:226`, `extension/lib/python-network.js:1` | admitted code with a network proxy |
| S7 | Imported archives | `extension/lib/archive-target-registry.js:375`, `:427` | a file the owner restores carries attacker-chosen keys and values |
| S8 | MCP server output | `extension/lib/mcp-client-core.js:99` | a registered server returns arbitrary text and tool results |
| S9 | Provider responses and provider errors | `extension/lib/pure.js:1034`, `:1102` | an endpoint can echo a credential back into a log or a card |
| S10 | Host-side ACP WebSocket clients | `scripts/acp-bridge.ts:636-646` | a browser page that can open the socket could drive a shell-capable agent |
| S11 | Owner-supplied local folders (fs grants) | `extension/lib/fs-grants.js:47`, `:130` | path strings the owner grants are still resolved by the extension |
| S12 | Hook event payloads | `extension/lib/hooks.js:494`, `:550` | a hook body is serialized into a model INSTRUCTION position |

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

- **Boundary:** TB2. **Evidence:** `extension/lib/pure.js:912-950` (the classifier),
  `extension/background/service-worker.js:11960` (the receiver OVERWRITES `message.origin`
  with the browser-derived origin) and `:11953-11957` (route allowlist). **Answer:** the
  origin comes from the sender, never from the body; a claimed-origin mismatch is
  refused. **Live proof:** `scripts/security-suite.ts:306-308` (a page MAIN world has no
  `chrome.runtime` at all) and `docs/CONSTITUTION.md:17`.

### T3. Sender-classifier default: an out-of-spec sender is classified as an extension document

- **Boundary:** TB2. **Evidence:** `extension/lib/pure.js:934` — when a sender is not a
  content script and has no tab URL, the classifier returns `{ kind: "extension" }`.
  **Adjudication:** ADJUDICATED AND WITHHELD. There is no known producer for the
  browser-attested tabless/opaque sender shape:
  `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md` §3 and §5 (Assumption 2), pinned by
  `tests/internal-sender-contract-audit.test.ts:14-32` (synthetic fixture) and
  `:113-114` (no `externally_connectable`, no `onMessageExternal`). **Register entry:
  R22** — with its reopen trigger. Audits MUST NOT re-report this as new; cite R22.

### T4. Unclassified service-worker mutations

- **Boundary:** TB2. **Evidence:** `docs/SW-DISPATCH-AUTHORITY-CENSUS.md` §4.9 — 31
  routes mutate persistent state with no route-local principal check and no approval
  gate (for example `named-agent.set-tools` at `extension/background/service-worker.js:8087`
  and `background-agent.delete` at `:10655`). **Answer:** the central listener refuses every
  non-page-allowed route to page senders (`extension/background/service-worker.js:11953`),
  so the class is reachable only from extension principals. **Register:** R11.

### T5. Sandbox escape and network egress from the script sandbox

- **Boundary:** TB1 / TB4. **Evidence:** `extension/sandbox/script-sandbox.js:299`
  (`new Function` inside the opaque-origin sandbox), CSP at
  `extension/manifest.json:114-117`, `extension/shared/components.js:460` / `:566`
  (`injectCspMeta` / `renderHtmlFrame`). **Live proof (real browser, driven):**
  `scripts/security-suite.ts:264-284` — zero attacker requests, blocked
  `parent.document`, blocked top navigation, `window.opener === null`, no `chrome.runtime`.
  Unit half: `tests/security.test.ts:100` and `:122`.

### T6. SSRF and URL-channel exfiltration through the brokered fetch

- **Boundary:** TB4. **Evidence:** `extension/lib/fetch-policy.js:92`
  (`isPrivateOrLoopbackHost`), `:117` / `:135` (`checkFetchPolicy`), `:155`
  (`extractFetchHosts`); the route at `extension/background/service-worker.js:6882`
  (`credentials: "omit"`, no redirect following, per-run host allow-list, GET/HEAD only).
  **Tests:** `tests/cap-fetch-deny.test.ts`; live SSRF probe at
  `scripts/security-suite.ts:389`. **Residual, stated in the source:** DNS rebinding of a
  listed host is not covered (`extension/lib/fetch-policy.js:21`).

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
  snapshot for another origin. **Register:** R3 and R16.

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
  (`extension/background/service-worker.js:10918`, the route member at `:10911`) — which
  matters because `dispatchHook` executes that template verbatim as the recurring run's
  task (`:12155-12156`).
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
  `extension/background/service-worker.js:10590` for agent seeds and skill enable/disable) —
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

- **Boundary:** TB5. **Evidence:** `scripts/acp-bridge.ts:44` (loopback default),
  `:67-71` (`originAllowed` — extension schemes only unless an exact origin is named),
  `:641-646` (403 on a refused Origin or a wrong token), `:52-56` (shared-secret
  requirement when bound off loopback). **Test:** `tests/acp-bridge-security.test.ts:44-56`
  (a web Origin is refused, an extension Origin is accepted).

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

---

## 6. Security Invariants for Auditors

These are the properties a change must not break. Each is stated so it can be falsified,
and each names the executable check that would catch a regression.

- **INV-1 — Authority is derived from the browser-attested sender, never from the body.**
  `extension/background/service-worker.js:11935-11940`, `:11960`, `:11969`;
  `scripts/security-suite.ts:306-308`. A new route that reads an origin, tab id or
  document id out of the message body breaks this.
- **INV-2 — The page-reachable route set is closed and tiny.**
  `extension/lib/pure.js:1178-1187`, pinned by
  `tests/internal-sender-contract-audit.test.ts:117-120`. An admin route appearing in
  `PAGE_ALLOWED_ROUTES` breaks this.
- **INV-3 — No external messaging channel exists.** No `externally_connectable`, no
  `onMessageExternal` listener: `tests/internal-sender-contract-audit.test.ts:113-114`.
  This invariant is what makes T3 a withheld decision rather than an exploit, so a change
  that adds either one REOPENS R22.
- **INV-4 — The bundle contains no `eval` / `new Function`.** The single exemption is the
  manifest sandbox page (`extension/manifest.json:108-117`); a new site in
  `extension/lib/` breaks it.
- **INV-5 — Every broker-mediated fetch applies the private-address deny list AND the
  per-run host allow-list, with no credentials and no redirect following.**
  `extension/lib/fetch-policy.js:135`; `extension/background/service-worker.js:6882`,
  `:6955`. A new egress helper that calls `fetch` directly breaks this.
- **INV-6 — A credential-shaped key never reaches a prompt, a log, a receipt or an error
  string.** `extension/lib/pure.js:959`, `:1114`; `tests/security.test.ts:79-99`,
  `tests/secret-redaction.test.ts`.
- **INV-7 — Untrusted content reaches the model only inside a per-assembly random
  boundary, and the model is told that fenced text is data.**
  `extension/lib/untrusted-fence.js:46-96`; `extension/lib/system-prompts.js:763-773`.
- **INV-8 — Destructive actions require an approval bound to the exact action, target and
  payload digest, and expiring.** `extension/lib/owner-approval.js:23`, `:533`, `:634`.
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
  explicitly, and binds loopback by default.** `scripts/acp-bridge.ts:44`, `:67-71`,
  `:641-646`; `tests/acp-bridge-security.test.ts:44-56`.

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
7. **The 31 unclassified mutation routes (T4).** Inventory accepted; only extension
   principals can reach them. Register R11.
8. **The `debugger` permission is absent.** Not an accepted risk so much as a standing
   prohibition: `tests/chrome-tools-t12.test.ts` holds the removal guard and the journey
   suite asserts absence from the manifest (`docs/CONSTITUTION.md:107`).

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
