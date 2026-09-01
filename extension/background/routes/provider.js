// extension/background/routes/provider.js — provider configuration and testing message routes.

import {
  getProviderConfig,
  PROVIDER_CHOICES,
  setProviderConfig,
} from "../../lib/provider.js";
import { publicProviderChoices } from "../../lib/provider-visibility.js";
import { keyedProviderConfigured } from "../../lib/first-run-onboarding.js";
import {
  isLocalProvider,
  providerOriginPattern,
  providerRunGate,
} from "../../lib/provider-gate.js";
import { testProvider } from "../../lib/provider-test.js";
import { defaultModelFor } from "../../lib/model-catalog.js";
import { withEffectiveBaseURL } from "../../lib/provider.js";
import { safeProviderError } from "../../lib/pure.js";
import { requireSettingsSender } from "./auth.js";

export function createProviderRoutes({ invalidateAgent = () => {} } = {}) {
  return Object.freeze({
    async "provider.get"(_m, context) {
      requireSettingsSender(context);
      // REDACTED (the final review's HIGH): the raw apiKey NEVER crosses into a
      // page — not even Settings. The response carries hasApiKey so the UI can
      // show "key set — leave blank to keep" and offer Clear key, and the rest
      // of the config (provider/baseURL/model) which are not credentials. The
      // key itself is SW-ONLY: preservation happens inside provider.set, the
      // connection test runs inside provider.test, and model resolution reads
      // the stored config directly.
      const cfg = await getProviderConfig();
      return { ...cfg, apiKey: "", hasApiKey: Boolean(cfg.apiKey) };
    },

    async "provider.summary"() {
      // A REDACTED summary for non-Settings surfaces (which provider is active,
      // the baseURL needed for the host-permission pattern, and a boolean setup
      // state). Neither the raw key nor the model crosses into a non-Settings DOM.
      const cfg = await getProviderConfig();
      return {
        provider: cfg.provider,
        baseURL: cfg.baseURL ?? "",
        configured: keyedProviderConfigured(cfg),
      };
    },

    async "provider.permission-summary"() {
      // Permission preflight must not pull the provider key/model/base URL into a
      // non-settings DOM. Return only the normalized origin match needed by the
      // owner surface; malformed network endpoints fail closed as unavailable.
      const cfg = await getProviderConfig();
      return {
        provider: String(cfg.provider ?? "").slice(0, 80),
        local: isLocalProvider(cfg),
        origin: providerOriginPattern(withEffectiveBaseURL(cfg)),
      };
    },

    async "provider.status"() {
      // Whether the active provider can RUN right now — the hub shows a warning
      // BEFORE a task when the provider is unreachable / misconfigured, so the
      // user isn't surprised by a failure after running. Redacted: only the id,
      // a boolean, and a human reason (never the key / base URL / model).
      const cfg = await getProviderConfig();
      // A network provider with no valid https:// origin cannot run — the
      // run-time preflight refuses it — so the hub strip must be red BEFORE the
      // run, not only after (CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01).
      if (!isLocalProvider(cfg) && !providerOriginPattern(withEffectiveBaseURL(cfg))) {
        return {
          provider: cfg.provider ?? "",
          ok: false,
          reason: "the provider endpoint is not configured — set it in Settings → Providers",
        };
      }
      const gate = await providerRunGate(cfg);
      // An empty model id runs the catalogue default — say so (the default is
      // a public catalogue id, not user data), so the hub and the journeys can
      // see that the run will NOT fall back to the demo model.
      const explicitModel = String(cfg.model ?? "").trim();
      const usingDefaultModel = !explicitModel && Boolean(defaultModelFor(cfg.provider));
      // The effective model id the run will use — an explicit id or the
      // catalogue default. A local/demo provider has none. Public catalogue id
      // (not a credential): the hub strip reads "Ready — <provider> · <model>".
      const modelId = isLocalProvider(cfg) ? "" : (explicitModel || defaultModelFor(cfg.provider) || "");
      return {
        provider: cfg.provider ?? "",
        ok: gate.ok,
        reason: gate.ok ? "" : gate.reason,
        usingDefaultModel,
        defaultModelId: usingDefaultModel ? defaultModelFor(cfg.provider) : "",
        modelId,
      };
    },

    async "provider.set"(m, sender) {
      requireSettingsSender(sender);
      // SW-SIDE KEY PRESERVATION (the final review's HIGH): when apiKey is
      // ABSENT (undefined — e.g. the Settings key field left blank on the SAME
      // provider), the stored key is preserved INSIDE the SW; an explicit ""
      // from the dedicated clear-key route is the only removal path. The route
      // returns the REDACTED config — the raw key never crosses back out.
      const cfg = m?.config ?? {};
      // Local providers (demo / prompt-api) need no model id — never gate them.
      const isLocal = isLocalProvider(cfg);
      // A provider that needs a model id must have one — an explicit id or the
      // catalogue default. An empty model with no catalogue would silently run
      // the demo model for a REAL provider id; refuse and keep the previous
      // model (CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01).
      const choice = PROVIDER_CHOICES.find((p) => p.id === cfg.provider) ?? null;
      const needsModel = !isLocal && choice?.needsModel !== false;
      if (needsModel && !String(cfg.model ?? "").trim() && !defaultModelFor(cfg.provider)) {
        const cur = await getProviderConfig();
        const previous = String(cur.model ?? "").trim();
        if (previous) cfg.model = previous; // keep the previous model in storage
        const preservedKey = Boolean(cur.provider === cfg.provider && cur.apiKey);
        return {
          ok: false,
          error: "model id missing",
          reason: "model id missing — set it in Settings → Providers",
          provider: cfg.provider ?? "",
          apiKey: "",
          // Report the PRESERVED state honestly: a stored key is still there,
          // only the model is missing (review r2 NOTE — never claim the key
          // is gone when the refusal kept it).
          hasApiKey: preservedKey,
        };
      }
      // Blank/absent key on the SAME provider → preserve (the final review's
      // HIGH: an explicit "" must NOT erase — provider.clear-key, restricted to
      // the Settings surface, is the ONLY removal path).
      if (cfg.apiKey === undefined || cfg.apiKey === "") {
        const cur = await getProviderConfig();
        cfg.apiKey = cur.provider === cfg.provider && cur.apiKey ? cur.apiKey : "";
      }
      const next = await setProviderConfig(cfg);
      // The running agent must switch immediately — invalidate the cached model + orchestrator.
      invalidateAgent();
      return { ...next, apiKey: "", hasApiKey: Boolean(next.apiKey) };
    },

    async "provider.clear-key"(_m, sender) {
      requireSettingsSender(sender);
      // The OWNER-GESTURE explicit clear (the Settings "Clear key" button). The
      // ONLY path that removes a stored key; returns the redacted config.
      const cur = await getProviderConfig();
      const next = await setProviderConfig({ ...cur, apiKey: "" });
      invalidateAgent();
      return { ok: true, config: { ...next, apiKey: "", hasApiKey: false } };
    },

    async "provider.test"(m, sender) {
      requireSettingsSender(sender);
      // The connection test runs INSIDE the SW so the stored key is merged here
      // — the page passes only the entered fields (an entered key wins; blank
      // means "use the stored one", which the page never sees). The page has
      // already performed the host-permission request on its user gesture.
      const cur = await getProviderConfig();
      const fields = {
        baseURL: String(m?.baseURL ?? cur.baseURL ?? ""),
        apiKey: String(m?.apiKey ?? "") || (cur.provider === (m?.provider ?? cur.provider) ? (cur.apiKey ?? "") : ""),
        model: String(m?.model ?? cur.model ?? ""),
      };
      const preset = PROVIDER_CHOICES.find((p) => p.id === (m?.provider ?? cur.provider)) ??
        { id: m?.provider ?? cur.provider, name: m?.provider ?? cur.provider, baseURL: fields.baseURL, needsKey: true };
      // The `list_tabs` dry run: after a green round-trip, exercise the SAME
      // permission-safe browser read the run uses, so a green Test predicts a
      // working RUN (not just a reachable endpoint). Reads the count only — no
      // tab url/title crosses back to the page.
      const listTabs = async () => {
        if (typeof chrome === "undefined" || !chrome.tabs?.query) return 0;
        const tabs = await chrome.tabs.query({}).catch(() => []);
        return Array.isArray(tabs) ? tabs.length : 0;
      };
      const res = await testProvider(preset, fields, { listTabs });
      return { ...res, error: res?.error ? safeProviderError(res.error, fields.apiKey ? [fields.apiKey] : []) : res?.error };
    },

    async "provider.models"() {
      // User-facing /model completion gets only public providers. The complete
      // authority remains intact for stored internal selections and test runs.
      return { choices: publicProviderChoices(PROVIDER_CHOICES) };
    },
  });
}
