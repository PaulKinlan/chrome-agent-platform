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

The 32-action destructive allowlist audited in `extension/lib/owner-approval.js` (`DESTRUCTIVE_ACTIONS`, lines 23-98) is:
- Agent lifecycle: `agent.delete`, `agent.update`, `named-agent.create`, `named-agent.delete`, `named-agent.set-provider`, `named-agent.set-schedule`, `named-agent.update`
- Artifacts: `asset.delete`, `asset.restore`, `asset.update`
- Filesystem: `fs.write`
- Scripts and Workflows: `script.create`, `script.delete`, `script.run`, `script.update`, `task.schedule-script`, `workflow.run`
- Capabilities and Hooks: `capability.revoke`, `hooks.subscribe`, `hooks.unsubscribe`
- Tasks: `task.pause`, `task.resume`, `task.update`
- External & WebMCP tools: `browser.cookie-value`, `mcp.use-server`, `webmcp.use-tool`
- Browser mutations: `browser.close-foreign-tab`, `browser.close-window`, `browser.remove-bookmark`, `browser.remove-cookie`, `browser.set-cookie`, `browser.wipe`

The 13-action owner-direct allowlist audited in `extension/lib/owner-approval.js` (`OWNER_DIRECT_ACTIONS`, lines 135-156) is:
`agent.delete`, `asset.delete`, `asset.restore`, `named-agent.delete`, `named-agent.set-mcp-servers`, `named-agent.set-schedule`, `named-agent.update`, `recipe.delete`, `script.create`, `script.run`, `task.pause`, `task.resume`, `task.update`.
When initiated directly by the owner from an extension UI or Options document (`isOwnerDirectApproval`), these actions execute without a pending card. Crucially, `named-agent.set-mcp-servers` is strictly owner-only: it is absent from `DESTRUCTIVE_ACTIONS` and absent from `MANAGEMENT_TOOL_NAMES`, so model callers fail closed (`operation is not approvable`) and cannot trigger an approval card to configure MCP servers.

Not run-originated: provider-host preflight (before model execution), site enrollment, Settings capability toggles, and direct owner UI mutations. They retain their existing owner-click/Settings flows and do not create a pending run tool.

Behavioral coverage: `owner-approval-security.test.ts` checks pending/approve/deny/expiry/exact consumption; `permission-approval-in-context.test.ts` checks originating-run rendering, trusted decisions, browser grant and no whole-turn restart; `inline-approval-pause.test.ts` checks the agent-do nested-denial pause seam and bounded production wiring.
