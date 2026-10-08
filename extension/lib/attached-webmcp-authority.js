// Run-local Q23 consent and mandatory WAL gate for an owner-attached declared
// tool. No Site Agent enrollment or origin-keyed site memory is created here.
// The SW supplies browser attestation and the separately guarded page-effect
// executor; this module never grants authority from payload origin/name alone.
import { canonicalOrigin } from "./memory.js";
import { digestSiteToolArguments } from "./site-tool-audit.js";

const fail = (error) => Object.freeze({ ok: false, error });
const NAME_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export function createAttachedDeclaredInvoker({
  consentStore, findBinding, runActive, readDeclared, validateArgs,
  requestApproval, audit, invoke,
} = {}) {
  if (!consentStore || typeof consentStore.binding !== "function" ||
    typeof consentStore.snapshot !== "function" || typeof consentStore.decide !== "function" ||
    [findBinding, runActive, readDeclared, validateArgs, requestApproval, audit, invoke]
      .some((f) => typeof f !== "function")) throw new TypeError("attached tool authority dependencies missing");
  return async (payload, context) => {
    const executionId = context?.principal === "model" ? context.executionId : null;
    const origin = typeof payload?.origin === "string" ? canonicalOrigin(payload.origin) : null;
    const name = payload?.name;
    const args = payload?.args;
    if (typeof executionId !== "string" || !executionId || !origin || origin !== payload.origin ||
      typeof name !== "string" || !name || name.length > 128 || !NAME_RE.test(name) ||
      !args || typeof args !== "object" || Array.isArray(args) || !runActive(executionId)) {
      return fail("attached_tool_not_authorized");
    }
    let scoped;
    try { scoped = findBinding(executionId, origin); } catch { return fail("attached_tool_not_authorized"); }
    const { binding, token } = scoped ?? {};
    const live = () => {
      if (!runActive(executionId)) return false;
      try {
        const current = consentStore.binding(token);
        return current.runId === executionId && current.origin === origin &&
          current.tabId === binding?.tabId && current.documentId === binding?.documentId;
      } catch { return false; }
    };
    if (!live()) return fail("attached_tool_not_authorized");
    const getTool = async () => {
      if (!live()) return null;
      let tools;
      try { tools = await readDeclared(binding, token); } catch { return null; }
      if (!live() || !Array.isArray(tools)) return null;
      return tools.find((item) => item?.name === name && item.source === "declared" &&
        item.origin === origin) ?? null;
    };
    let tool = await getTool();
    if (!tool) return fail("declared_tool_unavailable");
    let consent;
    try { consent = consentStore.snapshot(token, tool); } catch { return fail("attached_tool_not_authorized"); }
    if (consent.state === "denied") return fail("site_tool_consent_denied");
    let argDigest;
    try { argDigest = digestSiteToolArguments(args); } catch { return fail("attached_tool_invalid_arguments"); }
    const row = (event, direction, actor, outcome, reason, snapshot = consent) => ({
      event, direction, actor, outcome, reason,
      origin, tool: name, source: "declared", identityDigest: snapshot.identityDigest,
      enrollmentGen: 0, consentRevision: snapshot.revision,
      executionId, runId: executionId, agentId: context.agentId ?? null,
      argDigest, ephemeral: true, documentId: binding.documentId,
    });
    const append = (record) => audit(token, record);
    if (consent.state === "ask") {
      try { await append(row("consent-requested", "agent-to-owner", "agent", "pending", "first-use")); }
      catch { return fail("site_tool_audit_unavailable"); }
      if (!live()) return fail("attached_tool_not_authorized");
      let decision;
      try { decision = await requestApproval(context, binding, tool, consent, argDigest); }
      catch { return fail("owner_approval_unavailable"); }
      if (!live()) return fail("attached_tool_not_authorized");
      if (decision?.ok !== true) {
        if (decision?.approvalDenied === true) {
          try {
            await append(row("consent-decided", "owner-to-agent", "owner", "denied", "owner-denied"));
            consentStore.decide(token, tool, "denied", { expected: consent });
          } catch { return fail("site_tool_audit_unavailable"); }
        }
        return fail("owner_approval_denied");
      }
      try {
        await append(row("consent-decided", "owner-to-agent", "owner", "allowed", "owner-allowed"));
        consent = consentStore.decide(token, tool, "allowed", { expected: consent });
      } catch { return fail("site_tool_audit_unavailable"); }
    }
    if (!live()) return fail("attached_tool_not_authorized");
    tool = await getTool(); // re-read AFTER the owner card; navigation/drift rearms ASK
    if (!tool) return fail("declared_tool_unavailable");
    try { consent = consentStore.snapshot(token, tool); } catch { return fail("attached_tool_not_authorized"); }
    if (consent.state !== "allowed") return fail("attached_tool_authority_changed");
    let validated;
    try { validated = await validateArgs(tool.inputSchema, args); } catch { return fail("attached_tool_invalid_arguments"); }
    if (!live() || validated?.ok !== true) return fail("attached_tool_invalid_arguments");
    let res;
    let auditStarted = false;
    try {
      res = await invoke(binding, tool, validated.data, {
        token,
        runActive: live,
        requiredAudit: async () => {
          await append(row("invocation-started", "agent-to-site", "agent", "pending", "cached-allow"));
          auditStarted = true;
        },
      });
    } catch { return fail("site_tool_audit_unavailable"); }
    if (!auditStarted) return res?.error === "attached_tool_authority_changed"
      ? res : fail("site_tool_audit_unavailable");
    if (!live()) return fail("attached_tool_authority_changed");
    try {
      await append(row("invocation-finished", "site-to-agent", "system",
        res?.ok === true ? "succeeded" : "failed", res?.ok === true ? "page-result" : "page-error"));
    } catch { return fail("site_tool_audit_unavailable"); }
    return res && typeof res === "object" && typeof res.ok === "boolean"
      ? res : fail("attached_tool_invoke_failed");
  };
}
