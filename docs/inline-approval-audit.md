# Inline approval surface audit

Audit date: 2026-08-29. Scope: requests that can originate while an agent run is executing.

| Class | Production gate | In-conversation behavior | Decision authority | Timeout |
|---|---|---|---|---|
| Owner-approved destructive management mutations | `requireOwnerApproval` + `DESTRUCTIVE_ACTIONS` | The original tool promise publishes an `approval-request` and remains pending. Approve consumes the exact run/action/target/payload digest once; deny performs nothing. | `management.resolve-approval`, extension surface, opaque pending ID | 60 seconds, fail closed |
| Optional Chrome API permissions | Structured `permissionRequirement.permissions` from browser tools | The awaited agent-do post-tool hook pauses the run. The card's trusted click verifies the install grant with `chrome.permissions.contains`; it never requests permission at runtime. An unverifiable grant fails closed. The blocked tool must be freshly selected and retried after verification. | Trusted click with transient user activation plus run-bound opaque request ID | 60 seconds, fail closed |
| Host access | Install-granted manifest host permission plus structured browser-control scope | No runtime host-permission request occurs. The paused card verifies required authority and keeps the product grant scoped to the exact requested origin. | Trusted click with transient user activation plus run-bound opaque request ID | 60 seconds, fail closed |
| Product browser-control grant (exact origins or global) | Structured `permissionRequirement.grantOrigins` / `grantGlobal` | Same paused hook. The card writes only the requested scope, then resolves the pending run. | Trusted card click plus run-bound opaque request ID | 60 seconds, fail closed |
| Scheduler task pause/resume/update | Owner-approved destructive gate above | Uses the generic destructive card; no scheduler-specific retry path is needed. Task creation is not in `DESTRUCTIVE_ACTIONS`. | Exact owner approval tuple | 60 seconds, fail closed |
| Named-agent, asset, script, hook, capability and agent lifecycle mutations | Owner-approved destructive gate above | Uses the generic destructive card. | Exact owner approval tuple | 60 seconds, fail closed |

The 17-action destructive allowlist audited in `extension/lib/owner-approval.js` is:
`agent.delete`, `agent.update`, `asset.delete`, `asset.update`, `capability.revoke`, `hooks.subscribe`, `hooks.unsubscribe`, `named-agent.create`, `named-agent.delete`, `named-agent.set-provider`, `named-agent.set-schedule`, `named-agent.update`, `script.delete`, `script.update`, `task.pause`, `task.resume`, and `task.update`.

Not run-originated: provider-host preflight (before model execution), site enrollment, Settings capability toggles, and direct owner UI mutations. They retain their existing owner-click/Settings flows and do not create a pending run tool.

Behavioral coverage: `owner-approval-security.test.ts` checks pending/approve/deny/expiry/exact consumption; `permission-approval-in-context.test.ts` checks originating-run rendering, trusted decisions, browser grant and no whole-turn restart; `inline-approval-pause.test.ts` checks the agent-do nested-denial pause seam and bounded production wiring.
