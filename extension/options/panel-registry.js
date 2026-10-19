// extension/options/panel-registry.js — Stage 3a pure-data Settings panel registry (chrome-agent-platform-8v5l.1).
//
// Each entry corresponds 1:1 with `SETTINGS_SECTIONS` (`extension/lib/pure.js:830`)
// in canonical navigation order.
//
// Host classification (`host: "hub-ok" | "exact-document"`):
// - Resolved per owner decision `chrome-agent-platform-l354r` (2026-10-14):
//   only `skills`, `usage`, and `about` are `"hub-ok"`; the remaining 13 panels
//   are `"exact-document"`.
// - Audit of previously-unaudited panels recorded here for 8v5l.1 / l354r:
//   1. `usage`: sends only `usage.get` via `boundedSend` (`READ_ONLY_STATUS_TELEMETRY`
//      in `docs/SW-DISPATCH-AUTHORITY-CENSUS.md` §4); zero `SETTINGS_ONLY_DIRECT`
//      or owner-approval routes -> `"hub-ok"`.
//   2. `prompts`: sends `named-agent.list` (`HUB_AND_SETTINGS_MUTATIONS`),
//      `prompt.describe` (`READ_ONLY_STATUS_TELEMETRY`), and `prompt.set`,
//      `prompt.reset`, `prompt.keep` (`SETTINGS_ONLY_DIRECT`, guarded by
//      `requireSettingsSender`) -> `"exact-document"`.
//   3. `board-permissions`: sends `named-agent.list`, `board.deny.list`,
//      `board.deny.add`, `board.deny.remove` (`HUB_AND_SETTINGS_MUTATIONS`) and
//      subscribes to the `"agent-progress"` port; kept `"exact-document"` per
//      owner decision `chrome-agent-platform-l354r`.

/* @__NO_SIDE_EFFECTS__ */
function def(id, host, developerOnly, boundedRoutes, rawSendSites = []) {
  return /* @__PURE__ */ Object.freeze({
    id,
    developerOnly,
    host,
    modulePath: `./panels/${id}.js`,
    routes: /* @__PURE__ */ Object.freeze([...new Set([...boundedRoutes, ...rawSendSites])]),
    rawSendSites: /* @__PURE__ */ Object.freeze([...rawSendSites]),
  });
}

export const PANEL_REGISTRY = /* @__PURE__ */ Object.freeze([
  def(
    "providers",
    "exact-document",
    false,
    ["provider.get", "provider.status", "kv.get", "kv.set", "named-agent.list"],
    ["provider.set", "provider.test", "provider.clear-key", "invalidate-agent"],
  ),
  def(
    "mcp-servers",
    "exact-document",
    false,
    ["mcp.servers.get", "mcp.servers.set", "mcp.servers.test"],
  ),
  def(
    "local-folders",
    "exact-document",
    false,
    ["fs-grant.list"],
    ["fs-grant.remove"],
  ),
  def(
    "user-wasm",
    "exact-document",
    false,
    [],
  ),
  def(
    "tool-library",
    "exact-document",
    true,
    ["tool.package.validation-list", "tool-catalog.shadow"],
    ["tool.package.validate", "tool.preview.run"],
  ),
  def(
    "skills",
    "hub-ok",
    false,
    [
      "skill.list",
      "skill.delete",
      "skill.import",
      "skill.discover",
      "skill.importBatch",
      "command.list",
      "command.delete",
      "command.adopt",
    ],
  ),
  def(
    "agents",
    "exact-document",
    false,
    [
      "kv.get",
      "kv.set",
      "kv.remove",
      "named-agent.list",
      "background-agent.list",
      "provider.get",
      "agent.list",
      "agent.discoverable-tabs",
      "webmcp.consent.tool.set",
      "webmcp.consent.site.reset",
      "tools.policy.set",
      "webmcp.consent.snapshot",
      "webmcp.audit.list",
      "webmcp.diagnostics.get",
    ],
    [
      "invalidate-agent",
      "named-agent.create",
      "named-agent.set-provider",
      "management.pending-approvals",
      "management.resolve-approval",
      "named-agent.delete",
      "background-agent.set",
      "background-agent.duplicate",
      "background-agent.delete",
      "background-agent.update",
      "agent.enroll-origin",
      "agent.delete",
      "webmcp.diagnostics.set",
      "webmcp.status",
      "site-skills.get",
      "site-skills.set",
    ],
  ),
  def(
    "browser",
    "exact-document",
    false,
    ["browser-control.get", "browser-control.set", "kv.get", "kv.set"],
    ["browser-control.revoke", "browser-control.set", "browser-control.get"],
  ),
  def(
    "board-permissions",
    "exact-document",
    true,
    [],
    ["board.deny.list", "board.deny.add", "board.deny.remove", "named-agent.list"],
  ),
  def(
    "permissions",
    "exact-document",
    false,
    [],
    [
      "capability.revoke",
      "management.pending-approvals",
      "management.resolve-approval",
      "python.network.grants",
      "python.network.grant",
      "python.network.revoke",
    ],
  ),
  def(
    "web-services",
    "exact-document",
    false,
    [],
    [
      "vault.status",
      "vault.set",
      "vault.rotate",
      "vault.test",
      "vault.delete",
      "vault.ledger.clear",
      "vault.ledger.usage",
      "vault.ledger.setQuotas",
    ],
  ),
  def(
    "hooks",
    "exact-document",
    true,
    [],
    ["hooks.status", "hooks.deny"],
  ),
  def(
    "prompts",
    "exact-document",
    true,
    ["named-agent.list"],
    ["prompt.describe", "prompt.set", "prompt.reset", "prompt.keep"],
  ),
  def(
    "usage",
    "hub-ok",
    false,
    ["usage.get"],
  ),
  def(
    "data",
    "exact-document",
    false,
    [
      "agent.list",
      "agent.pending-cleanup",
      "named-agent.list",
      "memory.purgeJournals",
      "memory.sweepOrphans",
    ],
    [
      "run.list",
      "memory.stores",
      "memory.list",
      "memory.get",
      "memory.clear",
      "agent.retry-cleanup",
      "agent.enroll-origin",
      "invalidate-agent",
      "system.factoryReset",
    ],
  ),
  def(
    "about",
    "hub-ok",
    false,
    ["kv.get", "kv.set"],
    ["invalidate-agent"],
  ),
]);

export const PANEL_BY_ID = /* @__PURE__ */ new Map(/* @__PURE__ */ PANEL_REGISTRY.map((entry) => [entry.id, entry]));

export function getPanelEntry(id) {
  return PANEL_BY_ID.get(id) ?? null;
}
