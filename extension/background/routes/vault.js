// extension/background/routes/vault.js — the Settings surface for the secret
// vault (chrome-agent-platform-jao1.5, CAP-SECURE-ENCLAVE Stage 5).
//
// Every route is Settings-gated (requireSettingsSender — the same surface
// authorization the provider credential routes use). The status route carries
// the MASKED projection only; set/rotate/delete are mutations with the value
// riding the extension-internal runtime message exactly like provider.set's
// API key does today. The test-connection route runs ONE minimal request
// through the enclave proxy and reports {ok, status} — never the body, never
// the secret.

export const KNOWN_VAULT_TEST_CODES = Object.freeze([
  "auth_failed", "connection_failed", "timeout", "redirect_refused",
  "bound_exceeded", "target_refused", "origin_not_approved",
  "unknown_service", "bad_method", "secret_unavailable",
  "template_error", "unbounded_response", "not_wired",
]);

/** @param {{ vault: any, requireSettingsSender: Function, testConnection?: Function, services?: object }} deps */
export function createVaultRoutes({
  vault,
  requireSettingsSender,
  testConnection = null,
  services = {},
} = {}) {
  if (!vault || typeof vault.listMasked !== "function") {
    throw new TypeError("vault routes require the Stage-1 secret vault");
  }
  if (typeof requireSettingsSender !== "function") {
    throw new TypeError("vault routes require requireSettingsSender");
  }

  return {
    async "vault.status"(m, context) {
      requireSettingsSender(context);
      const masked = await vault.listMasked({ caller: "ui" });
      return { ok: true, services: vaultPanelRowsOf(masked) };
    },

    async "vault.set"({ keyId, value } = {}, context) {
      requireSettingsSender(context);
      await vault.setSecret(String(keyId ?? ""), String(value ?? ""), { by: "sw" });
      return { ok: true, keyId };
    },

    async "vault.rotate"({ keyId, value } = {}, context) {
      requireSettingsSender(context);
      await vault.rotateSecret(String(keyId ?? ""), String(value ?? ""), { by: "sw" });
      return { ok: true, keyId };
    },

    async "vault.delete"({ keyId } = {}, context) {
      requireSettingsSender(context);
      return await vault.deleteSecret(String(keyId ?? ""), { by: "sw" });
    },

    /** One minimal authenticated request through the enclave proxy: proves the
     * stored token is accepted WITHOUT logging or returning it.
     * SECURITY (voicebox-dsflash1's review): the proxy's error TEXT is never
     * passed through — an error envelope can embed the request URL, and a
     * query-injected token would leak into the Settings DOM. The caller gets
     * { ok, status, code } with a strict whitelisted code only. */
    async "vault.test"({ service } = {}, context) {
      requireSettingsSender(context);
      if (typeof testConnection !== "function") {
        return { ok: false, code: "not_wired" };
      }
      const res = await testConnection({ service });
      const ok = res?.ok === true;
      const KNOWN_CODES = new Set(KNOWN_VAULT_TEST_CODES);
      const code = ok ? null : (typeof res?.code === "string" && KNOWN_CODES.has(res.code) ? res.code : "connection_failed");
      return { ok, status: typeof res?.status === "number" ? res.status : null, code };
    },
  };
}

import { vaultPanelRows } from "../../lib/secret-vault.js";

function vaultPanelRowsOf(masked) {
  return vaultPanelRows(masked);
}
