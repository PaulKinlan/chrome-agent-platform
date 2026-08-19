# Permission remediation UX — research/design (public-safe)

Task: `CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01`. Read-only design. No
implementation, no credentials, no local paths, no private IDs. Maps the state at
public base `bbeff7b` (current main `5e5c81e` = `bbeff7b` + TASKS.md only) and
designs the user-facing remediation surface. All policy decisions — including
auto-resume, one-shot JIT continuation, and any `<all_urls>` introduction — are
explicitly OPEN and NOT approved by this document.

## 1. Missing-permission / error source map (current bbeff7b)

Known user-visible missing-permission/error sources observed during this review,
and the Settings surface each points at. This is a working map, NOT a formal or
exhaustive inventory.

| # | Source (file:area) | Missing thing | Current message / UX | Settings surface |
|---|---|---|---|---|
| 1 | `service-worker.js:1195-1203` + `provider-gate.js:115-131` (the EARLY provider run gate) | provider host access (network origin) | `ProviderUnavailableError` with the grant reason | Providers pane |
| 2 | `service-worker.js` `injectScriptsIntoOpenTabs` discovery (~932) | `scripting` | "scripting permission not granted" | Permissions → Site agents |
| 3 | `service-worker.js` tab read (~1832) | exact host origin | "network access to `<host>` is not granted — enable host permission … or read the active tab" | Permissions (host origin) |
| 4 | `service-worker.js` `capability.request` (~3174) | optional capability | "capability `<id>` not granted" / "needs a user gesture" | Permissions panel |
| 5 | `service-worker.js` tab listing (~2626) | `tabs` | tabs-needed-to-list error | Permissions → Browser control |
| 6 | `browser-tools.js` capture (~403) | `activeTab` **or** `tabs` | "activeTab permission not granted — enable Screenshots in Settings" | Permissions → Screenshots / Browser control |
| 7 | `browser-tools.js` capture (~455) | per-origin browser-control grant | "browser control not granted for this tab's origin …" | Settings → Browser control origins |
| 8 | `browser-tools.js` scripting (~585) | `scripting` | "scripting permission not granted …" | Permissions → Site agents |
| 9 | `browser-tools.js` side panel (~621) | `sidePanel` | "sidePanel permission not granted …" | Permissions → Side panel |
| 10 | `browser-tools.js` tabs (~658) | `tabs` | "tabs permission not granted …" | Permissions → Browser control |
| 11 | `scheduler.js` (~155) | `alarms` | alarms-not-granted failure | Permissions → Scheduled tasks |
| 12 | `enrollment.js` (~108) | exact host origin | missing host permission for enrollment | Permissions (host origin) |
| 13 | `options.js` provider host / enrollment host / activeTab / storage (~236, 345, 909, 1499) | host + optional caps | Settings-internal grant/deny messages | Providers / Permissions |
| 14 | `components.js` tabs status (~2529) | `tabs` | tab-permission status indicator | Permissions → Browser control |
| 15 | `components.js:4548` (`role="status"` session-only note) | `storage` | "Session-only: the optional storage permission is not granted…" | Permissions → Memory & settings |
| 16 | `ntp.js` enrollment host denial (~208) | exact host origin | enrollment host denial | Permissions (host origin) |
| 17 | `chat.js` side panel (~102) | `sidePanel` | "side panel permission is not granted …" | Permissions → Side panel |
| 18 | `conversation.js:395-449` (pre-Permissions inline retry) | provider host access | proactive `permissions.request` on the Run click + an inline "Grant network access" button | Providers pane |
| 19 | `error-report.js:44-45` (`ERROR_CATEGORY.PERMISSION`) | any optional capability | generic "A required permission is not granted — enable it in Settings." | Permissions panel |

Grant/revoke contract: the **reviewed public source** (`management-tools.js:31-32,
155-164`) still exposes `grant_capability`/`revoke_capability` and
`enroll_origin` to the model. Their removal exists only in the separate,
**unshipped** Permissions candidate (see §4). They are a defect to be removed, not
already-removed behavior.

## 2. Chrome optional/site state vs agent/task policy

- **Chrome state (browser-global, owner-only via `chrome.permissions`):** optional
  API permissions (`storage`, `alarms`, `tabs`, `activeTab`, `scripting`,
  `notifications`, `sidePanel`, `declarativeNetRequest`, …) and site access (host
  match patterns). Mutated ONLY through a genuine browser gesture. Surfaced as
  real `permissions.contains` state.
  - The browser-control grant records `scope: "global"` or `scope: "origins"`
    with a non-empty allowlist; the deny-all sentinel is `scope: "origins",
    origins: []` (`browser-tools.js:155-163`). There is no `"all"` scope label.
  - `<all_urls>` is **NOT** declared by `extension/manifest.json`. Introducing it
    is a separate manifest/product-security decision, not assumed here.
- **Agent/task policy (extension-internal, NOT `chrome.permissions`):** which
  agent/task may use which capability/origin, for how long, one-shot or scoped,
  and multi-run ordering. Owner-issued, model-unwritable, revoked independently.
  - **Least-privilege truth:** an exact origin is the MINIMUM persistent Chrome
    host grant (Chrome ignores host-permission paths). Any finer narrowing —
    path, tool, task, one-shot — belongs ONLY in this policy layer, never in
    `chrome.permissions`.

## 3. Design

### 3.1 Owner-only prompt / inbox

A run that needs an absent permission pauses and enqueues one visible
`owner-permission-request` item. The item carries the exact tool, capability id,
canonical origin, a one-line rationale, and the least-privilege choices that are
ACTUALLY available (exact origin or narrower **policy** scope — never a fake
"narrower Chrome path"). No model raw args, no provider secrets. The prompt is
owner-only (Settings-surface, sender-fenced, genuine click), keyboard/AX
announced, durable, bounded, and deduped by run/tool/capability/origin.

### 3.2 Paused-run state machine (resume policy left OPEN)

Durable per-run states:

```
RUNNING → PAUSED_WAITING_PERMISSION
           ├─ { grant }  → GRANTED_WAITING_RESUME_POLICY ─┬─ (explicit Resume gesture) → RESUMING → RUNNING → DONE
           │                                               └─ (auto-continue decision)  → RESUMING → RUNNING → DONE
           ├─ { deny }   → DENIED     (terminal)
           ├─ { cancel } → CANCELLED  (terminal)
           └─ { expire } → EXPIRED → DENIED (recorded)
```

- **A grant stops at the NEUTRAL `GRANTED_WAITING_RESUME_POLICY` state — it does
  NOT unconditionally resume.** Whether a granted run continues is the open
  resume-policy decision below, so the diagram branches into BOTH alternatives
  rather than taking `grant → RUNNING` as given.
- **DENIED and CANCELLED are distinct terminal states.** Each records its own
  timestamp + reason; neither implies the other.
- **Resume is a product decision, presented as two alternatives, neither
  normative yet:**
  1. *Explicit Resume gesture* — the run stays `GRANTED_WAITING_RESUME_POLICY`
     after the grant until the owner clicks "Resume" (or re-runs); no automatic
     continuation.
  2. *Automatic continuation* — a genuine-gesture grant immediately moves the
     granted run to `RESUMING` and continues the SAME execution id.
  This document does not choose; auto-resume and one-shot JIT continuation remain
  explicitly unapproved until the product decision.
- Re-attachment is by the immutable execution id + the pending tuple, re-validated
  for grant presence, stale-owner fence, and unchanged run generation. A stale or
  replayed resume is refused.

### 3.3 Deny / cancel / revoke / retry

- **Deny** → `DENIED` (terminal; the run does not execute; the exact
  tool/origin stays ungranted).
- **Cancel** → `CANCELLED` (terminal; the prompt leaves the inbox).
- **Revoke** → a later run pauses again; revoke composes with the grant lock.
- **Retry** → a fresh gesture; no stale inline retry loop.

### 3.4 Concurrency / multi-run ordering

When multiple runs wait on the SAME browser-global permission: granting it must
NOT implicitly authorize or auto-resume every waiter. The design reserves an
explicit ordering decision (FIFO vs owner-selected vs single-consume) and a
per-run task-policy check, so one grant never cascades into multiple resumes
before the policy decision. Restart/cancel/revoke fixtures for multiple waiters
are required.

### 3.5 Threat model

- No model/content-script-callable grant, no silent site-access broadening, no
  blanket `<all_urls>`.
- No secret/task-arg leakage into the inbox or page DOM.
- Single-use, fenced resume; exact-origin `permissions.contains` before any
  mutation; the check+capture holds the same lock as grant/revoke.
- `activeTab` is ONLY transient authority from Chrome's action / context-menu /
  command / omnibox invocation on the TARGET tab (not a Settings button, and it
  ends on navigation/closure). `permissions.contains({permissions:["activeTab"]})`
  alone is NOT proof that a paused target-tab operation can resume.

### 3.6 Loaded-MV3 acceptance fixtures (design; not run)

1. Settings mirrors `permissions.contains` for every optional capability + each
   exact origin (separate panes).
2. A run needing an absent permission pauses, creates one owner prompt, shows the
   exact tool/capability/origin + rationale + the actually-available choices.
3. Deny → `DENIED` (distinct, no execute); Cancel → `CANCELLED`; Revoke → next
   run re-pauses; Retry → fresh gesture (no loop).
4. The target-tab activeTab journey: the owner invokes the extension on the
   target tab (action/context-menu/command/omnibox), NOT a Settings button, to
   acquire transient authority; a Settings-only "activeTab" flow is NOT asserted.
5. Service-worker restart + view/tab reopen re-attach the paused run; resume
   re-validates ownership + generation.
6. Exact-origin minimum + policy-layer narrowing; `<all_urls>` only if a separate
   manifest/product decision lands (not a current choice).
7. Owner-only prompt + inbox AX/keyboard; no model/content-script resolution.
8. Stale-owner fence: a run paused on surface A does not resume onto surface B.
9. Multi-run ordering: N waiters on one permission → one grant resumes per the
   decided policy, others stay pending; deny/cancel/revoke/restart across waiters.

## 4. Relationship to CAP-FB-20260819-PERMISSIONS-01 (unshipped)

The separate Permissions lane is a **candidate, not shipped behavior**. Its
proposed foundation (declaration validation, exact-host background screenshot
gating, redacted preflight, grant/revoke/enroll removal, transient activeTab
action-click path, waiting banner) is a base this design would build on, but the
reviewed public source does not yet contain it — the model contract still exports
`grant_capability`/`revoke_capability`/`enroll_origin`. This document keeps that
workstream separate and labels it truthfully as unshipped.
