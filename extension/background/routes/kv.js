// extension/background/routes/kv.js — KV store message routes.

import { kvGet, kvSet, kvRemove } from "../../lib/kv.js";
import { redactSecrets } from "../../lib/pure.js";
import { ATTESTATION_KEY_STORE, PROMPT_OWNED_KEYS } from "../../lib/system-prompts.js";
import { securityEvent } from "../../lib/diagnostics.js";

const SECRET_KV_KEYS = new Set(["cap:namedAgents", "providerConfig"]);
const SECRET_CONTROLLED = ["providerConfig", "cap:namedAgents"];

export const kvRoutes = Object.freeze({
  // Shared key-value access, EXTENSION-ONLY. Page surfaces route their key-value
  // reads/writes through these routes so the service worker is the SINGLE
  // authority for shared state (provider, theme, browser-control grant, multi-
  // agent). When storage is absent, the SW's session Map is the one shared store
  // — pages must never call kv* directly in their own realm (the round-15
  // split-authority finding: Settings said granted while the worker said no).
  async "kv.get"(m) {
    // ONE composed secret-safe read path (static-review finding 1): the
    // attestation key is denied outright on explicit reads and stripped from
    // read-alls; EVERY secret-bearing namespace (the per-agent provider
    // overrides + the global provider config) is deep-redacted recursively —
    // both BEFORE the single reachable return. No unreachable dead code.
    const keys = m?.keys;
    const list = keys == null ? null : Array.isArray(keys) ? keys : [keys];
    if (list && list.includes(ATTESTATION_KEY_STORE)) {
      return {
        ok: false,
        error: `${ATTESTATION_KEY_STORE} is key material managed by the prompt.* routes — never exposed by a generic read`,
      };
    }
    const raw = list == null ? await kvGet(null) : await kvGet(list);
    delete raw[ATTESTATION_KEY_STORE];
    for (const k of Object.keys(raw)) {
      if (SECRET_KV_KEYS.has(k)) raw[k] = redactSecrets(raw[k]);
    }
    return raw;
  },

  async "kv.set"(m, context) {
    if (!m?.values || typeof m.values !== "object") {
      return { ok: false, error: "kv.set needs a values object" };
    }
    // Key-specific storage authority: the prompt-override store (its
    // quarantine + the attestation key) is owned by the prompt.* routes — a
    // generic kv.set must never mutate it outside the overrides mutex, the
    // strict schema, and the CAS guard (the review's bypass finding).
    const owned = Object.keys(m.values).filter((k) => PROMPT_OWNED_KEYS.includes(k));
    if (owned.length) {
      return {
        ok: false,
        error: `${owned.join(", ")} is managed by the prompt.* routes — direct kv writes are refused`,
      };
    }
    // SECRET-BEARING NAMESPACES (review a258f814 HIGH): providerConfig and the
    // named-agent registry are credential-bearing and lifecycle-controlled.
    // Generic kv writes must NEVER mutate them outside the Settings surface —
    // providerConfig goes through provider.set (key-preserving, invalidateAgent)
    // and the registry through the named-agent routes (revision-fenced). Without
    // this, any extension principal (NTP, a compromised surface) bypasses owner
    // authorization by writing the store directly.
    const secretKeys = Object.keys(m.values).filter((k) => SECRET_CONTROLLED.includes(k));
    if (secretKeys.length && context?.principal !== "owner-options") {
      securityEvent("blocked-action", `kv.set denied for secret-controlled keys (${secretKeys.join(", ")}) from principal ${context?.principal ?? "unknown"}`);
      return {
        ok: false,
        error: `${secretKeys.join(", ")} are secret-controlled stores — mutation requires the Settings surface (provider.set / named-agent routes)`,
      };
    }
    try {
      const mode = await kvSet(m.values);
      return { ok: true, mode };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },

  async "kv.remove"(m, context) {
    if (m?.keys == null) return { ok: false, error: "kv.remove needs keys" };
    const list = Array.isArray(m.keys) ? m.keys : [m.keys];
    const owned = list.filter((k) => PROMPT_OWNED_KEYS.includes(k));
    if (owned.length) {
      return {
        ok: false,
        error: `${owned.join(", ")} is managed by the prompt.* routes — direct kv removes are refused`,
      };
    }
    // SECRET-BEARING NAMESPACES (review a258f814 HIGH): removing providerConfig
    // from a non-Settings principal would bypass provider.clear-key (the only
    // sanctioned key-removal path); removing the registry bypasses the fenced
    // delete lifecycle.
    const secretKeys = list.filter((k) => SECRET_CONTROLLED.includes(k));
    if (secretKeys.length && context?.principal !== "owner-options") {
      securityEvent("blocked-action", `kv.remove denied for secret-controlled keys (${secretKeys.join(", ")}) from principal ${context?.principal ?? "unknown"}`);
      return {
        ok: false,
        error: `${secretKeys.join(", ")} are secret-controlled stores — removal requires the Settings surface (provider.clear-key / named-agent routes)`,
      };
    }
    await kvRemove(list);
    return { ok: true };
  },
});
