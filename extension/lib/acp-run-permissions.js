import { acpAllowOptionId, acpDenyOptionId } from "./acp-client.js";

/** Decisions belong to one live run and its originating extension document. */
export function createAcpRunPermissions({ isActive, timeoutMs = 60_000 }) {
  const pending = new Map();
  return {
    ask({ executionId, documentId, harnessId, request, emit, auto = false }) {
      const deny = acpDenyOptionId(request.options);
      if (!isActive(executionId)) return Promise.resolve(deny);
      if (auto) return Promise.resolve(acpAllowOptionId(request.options));
      if (!documentId) return Promise.resolve(deny);
      const requestId = `acp:${crypto.randomUUID()}`;
      return new Promise((resolve) => {
        const finish = (optionId) => {
          clearTimeout(timer); pending.delete(requestId); resolve(optionId);
        };
        const timer = setTimeout(() => finish(deny), timeoutMs);
        pending.set(requestId, { executionId, documentId, request, finish, deny });
        Promise.resolve().then(() => emit({ type: "acp-permission", requestId,
          request: { ...request, title: `${harnessId}: ${request.title || "native tool"}` } })).catch(() => finish(deny));
      });
    },
    resolve(requestId, optionId, context) {
      const row = pending.get(requestId);
      if (!row || !isActive(row.executionId)) return { ok: false, error: "harness permission request expired" };
      if (context?.principal !== "extension" || context.documentId !== row.documentId) return { ok: false, error: "only the originating conversation can answer" };
      const valid = row.request.options.some((o) => o.optionId === optionId);
      row.finish(valid ? optionId : row.deny);
      return { ok: true };
    },
    cancel(executionId) {
      for (const row of pending.values()) if (row.executionId === executionId) row.finish(row.deny);
    },
  };
}
