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

import { vaultPanelRows } from "../../lib/secret-vault.js";
import { validateQuotasConfig } from "../../lib/enclave-ledger.js";

function vaultPanelRowsOf(masked) {
  return vaultPanelRows(masked);
}

/**
 * @param {{
 *   vault: any,
 *   requireSettingsSender: Function,
 *   testConnection?: Function,
 *   services?: object,
 *   storageArea?: any,
 *   getProxyRules?: Function,
 *   setProxyRule?: Function,
 *   deleteProxyRule?: Function,
 *   proxyRulesStore?: { getRules?: Function, setRule?: Function, deleteRule?: Function },
 *   ledger?: { list?: Function, clear?: Function },
 * }} deps
 */
export function createVaultRoutes({
  vault,
  requireSettingsSender,
  testConnection = null,
  services = {},
  storageArea = (typeof chrome !== "undefined" && chrome?.storage?.local) ? chrome.storage.local : null,
  getProxyRules = null,
  setProxyRule = null,
  deleteProxyRule = null,
  proxyRulesStore = null,
  ledger = null,
} = {}) {
  if (!vault || typeof vault.listMasked !== "function") {
    throw new TypeError("vault routes require the Stage-1 secret vault");
  }
  if (typeof requireSettingsSender !== "function") {
    throw new TypeError("vault routes require requireSettingsSender");
  }

  const memoryRules = new Map();

  async function loadProxyRules() {
    if (typeof proxyRulesStore?.getRules === "function") {
      return await proxyRulesStore.getRules();
    }
    if (typeof getProxyRules === "function") {
      return await getProxyRules();
    }
    if (storageArea && typeof storageArea.get === "function") {
      try {
        const got = await storageArea.get(["cap:vault:proxy-rules", "cap:vault:custom-services"]);
        const raw = got?.["cap:vault:proxy-rules"] || got?.["cap:vault:custom-services"] || {};
        return Array.isArray(raw) ? raw : Object.values(raw);
      } catch {
        return [];
      }
    }
    return [...memoryRules.values()];
  }

  async function saveProxyRule(rule) {
    const keyId = String(rule?.keyId ?? "");
    if (!keyId) return null;
    const origin = rule.origin ? String(rule.origin) : "";
    const origins = origin ? [origin] : (Array.isArray(rule.origins) ? rule.origins : []);
    const normalized = {
      keyId,
      origin,
      origins,
      authType: rule.authType || "bearer",
      authName: rule.authName || "Authorization",
      testPath: rule.testPath || "/",
      label: rule.label || keyId,
    };

    if (typeof proxyRulesStore?.setRule === "function") {
      return await proxyRulesStore.setRule(normalized);
    }
    if (typeof setProxyRule === "function") {
      return await setProxyRule(normalized);
    }
    if (storageArea && typeof storageArea.get === "function" && typeof storageArea.set === "function") {
      const got = await storageArea.get(["cap:vault:proxy-rules"]);
      const raw = got?.["cap:vault:proxy-rules"] || {};
      const map = Array.isArray(raw) ? Object.fromEntries(raw.map((r) => [r.keyId, r])) : { ...raw };
      map[keyId] = normalized;
      await storageArea.set({
        "cap:vault:proxy-rules": map,
        "cap:vault:custom-services": map,
      });
      return normalized;
    }
    memoryRules.set(keyId, normalized);
    return normalized;
  }

  async function removeProxyRule(keyId) {
    const id = String(keyId ?? "");
    if (!id) return;
    if (typeof proxyRulesStore?.deleteRule === "function") {
      return await proxyRulesStore.deleteRule(id);
    }
    if (typeof deleteProxyRule === "function") {
      return await deleteProxyRule(id);
    }
    if (storageArea && typeof storageArea.get === "function" && typeof storageArea.set === "function") {
      const got = await storageArea.get(["cap:vault:proxy-rules"]);
      const raw = got?.["cap:vault:proxy-rules"] || {};
      const map = Array.isArray(raw) ? Object.fromEntries(raw.map((r) => [r.keyId, r])) : { ...raw };
      delete map[id];
      await storageArea.set({
        "cap:vault:proxy-rules": map,
        "cap:vault:custom-services": map,
      });
      return;
    }
    memoryRules.delete(id);
  }

  return {
    async "vault.status"(m, context) {
      requireSettingsSender(context);
      const masked = await vault.listMasked({ caller: "ui" });
      const proxyRules = await loadProxyRules();
      const ledgerEntries = typeof ledger?.list === "function" ? ledger.list() : [];
      const usage = typeof ledger?.getUsage === "function" ? await ledger.getUsage() : {};
      const status = typeof ledger?.getConfigStatus === "function" ? ledger.getConfigStatus() : { configInvalid: false };
      return {
        ok: true,
        services: vaultPanelRowsOf(masked),
        proxyRules,
        ledger: ledgerEntries,
        usage,
        configInvalid: Boolean(status.configInvalid),
      };
    },

    async "vault.set"({ keyId, value, origin, authType, authName, testPath, label } = {}, context) {
      requireSettingsSender(context);
      const id = String(keyId ?? "");
      await vault.setSecret(id, String(value ?? ""), { by: "sw" });
      if (origin || authType || authName || testPath || label) {
        await saveProxyRule({ keyId: id, origin, authType, authName, testPath, label });
      }
      return { ok: true, keyId: id };
    },

    async "vault.configureProxy"({ keyId, origin, authType, authName, testPath, label } = {}, context) {
      requireSettingsSender(context);
      const id = String(keyId ?? "");
      const rule = await saveProxyRule({ keyId: id, origin, authType, authName, testPath, label });
      return { ok: true, keyId: id, rule };
    },

    async "vault.rotate"({ keyId, value } = {}, context) {
      requireSettingsSender(context);
      const id = String(keyId ?? "");
      await vault.rotateSecret(id, String(value ?? ""), { by: "sw" });
      return { ok: true, keyId: id };
    },

    async "vault.delete"({ keyId } = {}, context) {
      requireSettingsSender(context);
      const id = String(keyId ?? "");
      const res = await vault.deleteSecret(id, { by: "sw" });
      await removeProxyRule(id);
      return res;
    },

    async "vault.ledger.clear"(m, context) {
      requireSettingsSender(context);
      ledger?.clear?.();
      return { ok: true };
    },

    async "vault.ledger.resetQuotas"({ serviceId } = {}, context) {
      requireSettingsSender(context);
      await ledger?.resetQuotas?.(serviceId);
      return { ok: true };
    },

    async "vault.ledger.usage"(m, context) {
      requireSettingsSender(context);
      const usage = typeof ledger?.getUsage === "function" ? await ledger.getUsage() : {};
      const status = typeof ledger?.getConfigStatus === "function" ? ledger.getConfigStatus() : { configInvalid: false };
      return {
        ok: true,
        usage,
        configInvalid: Boolean(status.configInvalid),
      };
    },

    /**
     * Sets and persists owner enclave quota overrides.
     * Passing { quotas: {} } clears all custom overrides back to defaults.
     */
    async "vault.ledger.setQuotas"({ quotas } = {}, context) {
      requireSettingsSender(context);
      if (typeof ledger?.setQuotas !== "function") {
        return { ok: false, code: "not_wired" };
      }
      let validated;
      try {
        validated = validateQuotasConfig(quotas);
      } catch (err) {
        const e = new Error(`enclave quotas: ${String(err?.message ?? err)}`);
        e.code = "invalid_quota_config";
        throw e;
      }
      try {
        const updated = await ledger.setQuotas(validated);
        return { ok: true, quotas: updated };
      } catch (err) {
        const e = new Error(`enclave quotas storage write failed: ${String(err?.message ?? err)}`);
        e.code = "ledger_unavailable";
        throw e;
      }
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
      const KNOWN_CODES = new Set([
        "auth_failed", "connection_failed", "timeout", "redirect_refused",
        "bound_exceeded", "target_refused", "origin_not_approved",
        "unknown_service", "bad_method", "secret_unavailable",
        "template_error", "unbounded_response", "not_wired",
        "quota_exceeded", "ledger_unavailable", "clock_skew",
        "quota_config_invalid", "service_disabled", "invalid_quota_config",
      ]);
      const code = ok ? null : (typeof res?.code === "string" && KNOWN_CODES.has(res.code) ? res.code : "connection_failed");
      return { ok, status: typeof res?.status === "number" ? res.status : null, code };
    },
  };
}
