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
     * stored token is accepted WITHOUT logging or returning it. */
    async "vault.test"({ service } = {}, context) {
      requireSettingsSender(context);
      if (typeof testConnection !== "function") {
        return { ok: false, error: "the enclave proxy is not wired for connection tests" };
      }
      const res = await testConnection({ service });
      // The proxy result is { ok, status?, error? } — never a body, never the
      // secret. Pass through exactly those fields.
      return { ok: res?.ok === true, status: res?.status ?? null, error: res?.error ?? null };
    },
  };
}

import { vaultPanelRows } from "../../lib/secret-vault.js";

function vaultPanelRowsOf(masked) {
  return vaultPanelRows(masked);
}
