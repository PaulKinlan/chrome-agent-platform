// panels/web-services.js — Web services & vault Settings panel module.

import { vaultPanelRows, resolveSaveAction } from "../../lib/secret-vault.js";
import { ENCLAVE_QUOTAS_STORAGE_KEY } from "../../lib/enclave-ledger.js";
import { createPanelContext, bindPanelCtx } from "../panel-context.js";

const VAULT_PRESETS = [
  {
    id: "BRAVE_SEARCH_API_KEY",
    serviceId: "brave-search",
    name: "Brave Search",
    origin: "https://api.search.brave.com",
    authType: "header",
    authName: "X-Subscription-Token",
    testPath: "/res/v1/web/search?q=ping&count=1",
    usage: "Tool: brave_search · Python: $VAULT{BRAVE_SEARCH_API_KEY}",
  },
  {
    id: "GITHUB_TOKEN",
    serviceId: "github",
    name: "GitHub API",
    origin: "https://api.github.com",
    authType: "bearer",
    authName: "Authorization",
    testPath: "/rate_limit",
    usage: "Python: $VAULT{GITHUB_TOKEN}",
  },
];


const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("web-services");

function vaultSend(type, payload = {}, ctx) {
  return send({ type, ...payload }).then(
    (v) => v,
    (e) => ({ ok: false, error: String(e?.message ?? e), code: e?.code }),
  );
}

function formatAuthInjection(authType, authName, keyId) {
  if (authType === "bearer") {
    return `Bearer token: ${authName || "Authorization"} ← $VAULT{${keyId}}`;
  }
  if (authType === "query") {
    return `Query param: ?${authName || "api_key"}=$VAULT{${keyId}}`;
  }
  return `Header: ${authName || "X-API-Key"} ← $VAULT{${keyId}}`;
}

async function renderVaultPanel(ctx) {
  const host = byId("vault-services");
  if (!host) return;
  const res = await vaultSend("vault.status", {});
  host.replaceChildren();
  const rows = vaultPanelRows(res?.services ?? []);
  const configuredMap = new Map(rows.map((r) => [r.keyId, r]));
  const rulesMap = new Map((res?.proxyRules ?? []).map((r) => [r.keyId, r]));

  const renderedKeyIds = new Set();
  for (const preset of VAULT_PRESETS) {
    renderedKeyIds.add(preset.id);
    const conf = configuredMap.get(preset.id);
    const item = {
      keyId: preset.id,
      name: preset.name,
      serviceId: preset.serviceId,
      origin: preset.origin,
      authType: preset.authType,
      authName: preset.authName,
      testPath: preset.testPath,
      usage: preset.usage,
      configured: Boolean(conf?.configured),
      masked: conf?.masked ?? "…",
      lastUsed: conf?.lastUsed ?? 0,
    };
    host.append(vaultCard(item));
  }

  const customKeys = new Set([...configuredMap.keys(), ...rulesMap.keys()]);
  for (const keyId of customKeys) {
    if (renderedKeyIds.has(keyId)) continue;
    const conf = configuredMap.get(keyId);
    const rule = rulesMap.get(keyId);
    const origin = rule?.origin || (Array.isArray(rule?.origins) ? rule.origins[0] : "") || "Any approved origin";
    const authType = rule?.authType || "bearer";
    const authName = rule?.authName || "Authorization";
    const item = {
      keyId,
      name: rule?.label || keyId,
      serviceId: keyId.toLowerCase(),
      origin,
      authType,
      authName,
      testPath: rule?.testPath || "/",
      usage: `Python: $VAULT{${keyId}}`,
      configured: Boolean(conf?.configured),
      masked: conf?.masked ?? "…",
      lastUsed: conf?.lastUsed ?? 0,
    };
    host.append(vaultCard(item));
  }

  await renderVaultQuotas(ctx);
  renderVaultLedger(res?.ledger ?? []);
}

function vaultCard(item, ctx) {
  const wrap = document.createElement("div");
  wrap.className = "vault-card vault-row";
  wrap.dataset.keyId = item.keyId;

  const header = document.createElement("div");
  header.className = "vault-card-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "vault-card-title";

  const keyIdEl = document.createElement("span");
  keyIdEl.className = "vault-key-id";
  keyIdEl.textContent = item.keyId;

  const nameEl = document.createElement("span");
  nameEl.className = "vault-service-name";
  nameEl.textContent = item.name ? `(${item.name})` : "";

  const badge = document.createElement("span");
  badge.className = `vault-badge ${item.configured ? "configured" : "unconfigured"}`;
  badge.textContent = item.configured ? `Configured · ${item.masked}` : "Not configured";

  titleGroup.append(keyIdEl, nameEl, badge);

  const lastUsedEl = document.createElement("span");
  lastUsedEl.className = "vault-last-used muted";
  lastUsedEl.textContent = item.lastUsed ? new Date(item.lastUsed).toLocaleString() : "never used";

  header.append(titleGroup, lastUsedEl);

  const meta = document.createElement("div");
  meta.className = "vault-proxy-meta";

  const originRow = document.createElement("div");
  originRow.className = "vault-meta-row";
  const originLabel = document.createElement("span");
  originLabel.className = "vault-meta-label";
  originLabel.textContent = "Pinned Origin:";
  const originVal = document.createElement("code");
  originVal.className = "vault-meta-val";
  originVal.textContent = item.origin;
  originRow.append(originLabel, originVal);

  const authRow = document.createElement("div");
  authRow.className = "vault-meta-row";
  const authLabel = document.createElement("span");
  authLabel.className = "vault-meta-label";
  authLabel.textContent = "Auth Injection:";
  const authVal = document.createElement("code");
  authVal.className = "vault-meta-val";
  authVal.textContent = formatAuthInjection(item.authType, item.authName, item.keyId);
  authRow.append(authLabel, authVal);

  const usageRow = document.createElement("div");
  usageRow.className = "vault-meta-row";
  const usageLabel = document.createElement("span");
  usageLabel.className = "vault-meta-label";
  usageLabel.textContent = "Usage:";
  const usageVal = document.createElement("span");
  usageVal.className = "vault-meta-val";
  usageVal.textContent = item.usage;
  usageRow.append(usageLabel, usageVal);

  meta.append(originRow, authRow, usageRow);

  const controls = document.createElement("div");
  controls.className = "vault-controls";

  const input = document.createElement("input");
  input.type = "password";
  input.className = "vault-input";
  input.placeholder = item.configured ? "leave blank to keep" : "paste API key";
  input.autocomplete = "off";
  input.setAttribute("aria-label", `New key for ${item.keyId}`);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn small ghost vault-toggle";
  toggle.textContent = "Show";
  toggle.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    toggle.textContent = input.type === "password" ? "Show" : "Hide";
  });

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn small vault-save";
  save.textContent = item.configured ? "Rotate" : "Save";
  save.disabled = true;

  input.addEventListener("input", () => {
    const action = resolveSaveAction({ configured: item.configured, inputValue: input.value });
    save.textContent = action === "rotate" ? "Rotate" : "Save";
    save.disabled = action === "none";
  });

  save.addEventListener("click", async () => {
    const action = resolveSaveAction({ configured: item.configured, inputValue: input.value });
    if (action === "none") return;
    save.disabled = true;
    let res;
    if (action === "rotate") {
      res = await vaultSend("vault.rotate", { keyId: item.keyId, value: input.value });
    } else {
      res = await vaultSend("vault.set", {
        keyId: item.keyId,
        value: input.value,
        origin: item.origin,
        authType: item.authType,
        authName: item.authName,
        testPath: item.testPath,
        label: item.name,
      });
    }
    input.value = "";
    save.disabled = true;
    setVaultStatus(res?.ok ? `${item.keyId} saved.` : `Save failed: ${res?.error ?? "unknown"}`, !res?.ok);
    await renderVaultPanel();
  });

  const test = document.createElement("button");
  test.type = "button";
  test.className = "btn small ghost vault-test";
  test.textContent = "Test connection";
  if (!item.configured) {
    test.disabled = true;
    test.title = "Save a key first to test the connection";
  }
  test.addEventListener("click", async () => {
    test.disabled = true;
    setVaultStatus(`Testing ${item.keyId}…`, false);
    const res = await vaultSend("vault.test", { service: item.serviceId || item.keyId });
    const ok = res?.ok === true;
    setVaultStatus(ok ? `Connection OK (status ${res.status}).` : `Connection failed (${res?.code ?? "connection_failed"}).`, !ok);
    test.disabled = false;
    await renderVaultPanel();
  });

  controls.append(input, toggle, save, test);

  if (item.configured) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn small ghost vault-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      const res = await vaultSend("vault.delete", { keyId: item.keyId });
      remove.disabled = false;
      const removedOk = res?.ok === true || res?.deleted === true;
      setVaultStatus(removedOk ? `${item.keyId} removed.` : `Remove failed: ${res?.error ?? "unknown"}`, !removedOk);
      await renderVaultPanel();
    });
    controls.append(remove);
  }

  wrap.append(header, meta, controls);
  return wrap;
}

// Element helper for the quota table: createElement + className + textContent tripled the source (and the
// shipped options bundle) for ~35 cells and controls, which is most of the quota UI's byte cost.
const mk = (tag, cls, text, style) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  if (style) Object.assign(node.style, style);
  return node;
};

function formatWindowDuration(windowMs) {
  if (!windowMs || typeof windowMs !== "number") return "—";
  // A whole-day window is a whole number of hours, so the %3600000 branch below already covers it.
  if (windowMs % 3600000 === 0) {
    const hours = windowMs / 3600000;
    return `${hours}h (${windowMs.toLocaleString()}ms)`;
  }
  if (windowMs % 60000 === 0) {
    const mins = windowMs / 60000;
    return `${mins}m (${windowMs.toLocaleString()}ms)`;
  }
  return `${windowMs.toLocaleString()}ms`;
}

function formatRemainingMs(resetMs) {
  if (resetMs === null || resetMs === undefined) return "—";
  if (resetMs <= 0) return "0s";
  const seconds = Math.floor(resetMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function setQuotaStatus(text, isError, ctx) {
  const el = byId("vault-quotas-status");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.style.color = isError ? "var(--danger,#b3261e)" : "";
}

let lastConfiguredQuotas = null;

// Storage is AUTHORITATIVE and is re-read on every call. The in-memory value is only a
// fallback for contexts without chrome.storage (unit tests). Caching it as the primary
// source meant a second options tab - or any out-of-band change - could make a set or a
// clear re-persist STALE overrides for other services, silently writing a config the user
// never chose. (fpb0's mirror bug in the same family: a stored value disagreeing with what
// the user just did.)
async function getStoredQuotas() {
  const read = globalThis.chrome?.storage?.local?.get;
  if (typeof read !== "function") {
    // No chrome.storage at all in this context (unit tests). There is nothing to read, so the
    // in-memory value is the only possible source and this is NOT a failure path.
    if (lastConfiguredQuotas && typeof lastConfiguredQuotas === "object") {
      return { ...lastConfiguredQuotas };
    }
    lastConfiguredQuotas = {};
    return {};
  }
  let got;
  try {
    got = await read.call(globalThis.chrome.storage.local, ENCLAVE_QUOTAS_STORAGE_KEY);
  } catch (err) {
    // SURFACED, deliberately not swallowed and deliberately NOT falling back to the cached
    // copy: writing a quota set from a value we could not read is how a stale override gets
    // re-persisted for another service, which is the F1 bug this read path exists to fix. An
    // observability hole here would sit directly under that fix. The callers catch a throw,
    // render it as a failure and never claim success.
    const e = new Error(`quota configuration could not be read: ${String(err?.message ?? err)}`);
    e.code = "quota_read_failed";
    throw e;
  }
  const raw = got?.[ENCLAVE_QUOTAS_STORAGE_KEY];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    lastConfiguredQuotas = { ...raw };
    return { ...raw };
  }
  // Storage IS readable and holds nothing, so the empty object is the authoritative answer.
  lastConfiguredQuotas = {};
  return {};
}

export async function renderVaultQuotas(ctx) {
  const host = byId("vault-quotas");
  if (!host) return;

  const res = await vaultSend("vault.ledger.usage", {});
  const isInvalid = Boolean(res?.configInvalid);
  const warningEl = byId("vault-quotas-warning");
  if (warningEl) {
    if (isInvalid) {
      warningEl.style.display = "";
      warningEl.hidden = false;
      warningEl.textContent = "Some saved quota settings were not valid, so the built-in limits are being used. Reset to defaults or set new limits here.";
    } else {
      warningEl.style.display = "none";
      warningEl.hidden = true;
    }
  }

  if (!res?.ok) {
    setQuotaStatus(`Failed to load quotas: ${res?.error || res?.code || "unknown"}`, true);
    return;
  }

  const usage = res.usage || {};
  const serviceIds = Object.keys(usage);
  if (serviceIds.length === 0) {
    const empty = mk("div", "muted");
    empty.style.padding = "12px";
    empty.textContent = "No service quotas or telemetry available.";
    host.replaceChildren(empty);
    return;
  }

  const table = mk("table", "vault-ledger-table vault-quotas-table");

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  for (const col of ["Service", "Status", "Calls", "Limit", "Remaining", "Window", "Reset In", "Actions"]) {
    const th = document.createElement("th");
    th.textContent = col;
    trHead.append(th);
  }
  thead.append(trHead);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const serviceId of serviceIds) {
    const item = usage[serviceId] || {};
    const tr = mk("tr", "vault-quota-row");
    tr.dataset.service = serviceId;
    tr.dataset.count = String(item.count ?? 0);
    tr.dataset.limit = String(item.limit ?? "");
    tr.dataset.remaining = String(item.remaining ?? "");
    tr.dataset.windowMs = String(item.windowMs ?? "");
    tr.dataset.disabled = String(Boolean(item.disabled));
    tr.dataset.unmetered = String(Boolean(item.unmetered));

    const tdService = mk("td", "vault-quota-service");
    const codeService = document.createElement("code");
    codeService.textContent = serviceId;
    tdService.append(codeService);

    const tdStatus = mk("td", "vault-quota-status");
    const statusPill = document.createElement("span");
    if (item.disabled) {
      statusPill.className = "vault-status-pill fail";
      statusPill.textContent = "Disabled";
    } else if (item.unmetered) {
      statusPill.className = "vault-status-pill";
      statusPill.textContent = "Unmetered";
    } else {
      statusPill.className = "vault-status-pill ok";
      statusPill.textContent = "Active";
    }
    tdStatus.append(statusPill);

    const tdCount = mk("td", "vault-quota-count", String(item.count ?? 0));

    const tdLimit = mk("td", "vault-quota-limit");
    if (item.disabled) {
      tdLimit.textContent = "0 (disabled)";
    } else if (item.unmetered) {
      tdLimit.textContent = "Unmetered";
    } else {
      tdLimit.textContent = String(item.limit);
    }

    const tdRemaining = mk("td", "vault-quota-remaining");
    if (item.disabled) {
      tdRemaining.textContent = "0";
    } else if (item.unmetered) {
      tdRemaining.textContent = "Unmetered";
    } else {
      tdRemaining.textContent = String(item.remaining);
    }

    const tdWindow = mk("td", "vault-quota-window");
    if (item.unmetered) {
      tdWindow.textContent = "—";
    } else {
      tdWindow.textContent = formatWindowDuration(item.windowMs);
    }

    const tdReset = mk("td", "vault-quota-reset");
    if (item.disabled || item.unmetered || item.resetMs === null || item.resetMs === undefined) {
      tdReset.textContent = "—";
    } else {
      tdReset.textContent = formatRemainingMs(item.resetMs);
    }

    const tdActions = mk("td", "vault-quota-actions");
    tdActions.style.whiteSpace = "nowrap";

    const limitInput = document.createElement("input");
    limitInput.type = "number";
    limitInput.min = "0";
    limitInput.className = "vault-quota-limit-input";
    Object.assign(limitInput.style, {width: "65px", padding: "2px 4px", fontSize: "12px", marginRight: "4px"});
    limitInput.placeholder = "Limit";
    limitInput.setAttribute("aria-label", `Limit for ${serviceId}`);
    if (typeof item.limit === "number") {
      limitInput.value = String(item.limit);
    }

    const windowSelect = mk("select", "input-select vault-quota-window-select");
    Object.assign(windowSelect.style, {width: "85px", padding: "2px 4px", fontSize: "12px", marginRight: "4px"});
    windowSelect.setAttribute("aria-label", `Window for ${serviceId}`);

    const opt1h = document.createElement("option");
    opt1h.value = "3600000";
    opt1h.textContent = "1 hour";
    const opt24h = document.createElement("option");
    opt24h.value = "86400000";
    opt24h.textContent = "24 hours";
    windowSelect.append(opt1h, opt24h);

    if (item.windowMs && item.windowMs !== 3600000 && item.windowMs !== 86400000) {
      const optCustom = document.createElement("option");
      optCustom.value = String(item.windowMs);
      optCustom.textContent = formatWindowDuration(item.windowMs);
      windowSelect.append(optCustom);
    }
    if (item.windowMs) {
      windowSelect.value = String(item.windowMs);
    } else {
      windowSelect.value = "86400000";
    }

    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "btn small vault-quota-set-btn";
    setBtn.textContent = "Set";
    Object.assign(setBtn.style, {padding: "2px 8px", fontSize: "12px", marginRight: "4px"});
    setBtn.addEventListener("click", async () => {
      const rawLimit = limitInput.value.trim();
      const numLimit = Number(rawLimit);
      if (rawLimit === "" || !Number.isInteger(numLimit) || numLimit < 0) {
        setQuotaStatus(`Limit for ${serviceId} must be a non-negative integer (0 to disable).`, true);
        return;
      }
      const numWindow = Number(windowSelect.value);
      if (!Number.isInteger(numWindow) || numWindow <= 0) {
        setQuotaStatus(`Window for ${serviceId} must be a positive integer.`, true);
        return;
      }
      setBtn.disabled = true;
      let stored;
      try {
        stored = await getStoredQuotas();
      } catch (err) {
        // A failed read must be VISIBLE and must not leave the control disabled, and it must not
        // proceed to write: building a quota set from a config we could not read is the stale-override
        // bug this read path exists to fix. vaultSend absorbs route rejections, so this is the only
        // path in these handlers that can reject - which is why it needs its own catch.
        setBtn.disabled = false;
        setQuotaStatus(`Could not read your saved quota settings: ${String(err?.message ?? err)}`, true);
        return;
      }
      const updated = {
        ...stored,
        [serviceId]: { limit: numLimit, windowMs: numWindow },
      };
      const writeRes = await vaultSend("vault.ledger.setQuotas", { quotas: updated });
      setBtn.disabled = false;
      if (!writeRes?.ok) {
        setQuotaStatus(`Failed to set quota for ${serviceId}: ${writeRes?.error || writeRes?.code || "invalid_quota_config"}`, true);
        return;
      }
      lastConfiguredQuotas = { ...(writeRes.quotas ?? updated) };
      setQuotaStatus(`Quota updated for ${serviceId}: limit ${numLimit}, window ${formatWindowDuration(numWindow)}.`, false);
      await renderVaultPanel();
    });

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn small ghost vault-quota-clear-btn";
    clearBtn.textContent = "Clear";
    Object.assign(clearBtn.style, {padding: "2px 8px", fontSize: "12px"});
    clearBtn.addEventListener("click", async () => {
      clearBtn.disabled = true;
      let stored;
      try {
        stored = await getStoredQuotas();
      } catch (err) {
        // A failed read must be VISIBLE and must not leave the control disabled, and it must not
        // proceed to write: building a quota set from a config we could not read is the stale-override
        // bug this read path exists to fix. vaultSend absorbs route rejections, so this is the only
        // path in these handlers that can reject - which is why it needs its own catch.
        clearBtn.disabled = false;
        setQuotaStatus(`Could not read your saved quota settings: ${String(err?.message ?? err)}`, true);
        return;
      }
      const updated = { ...stored };
      delete updated[serviceId];
      const writeRes = await vaultSend("vault.ledger.setQuotas", { quotas: updated });
      clearBtn.disabled = false;
      if (!writeRes?.ok) {
        setQuotaStatus(`Failed to clear quota for ${serviceId}: ${writeRes?.error || writeRes?.code || "unknown"}`, true);
        return;
      }
      lastConfiguredQuotas = { ...(writeRes.quotas ?? updated) };
      setQuotaStatus(`Quota cleared for ${serviceId}. Restored to default.`, false);
      await renderVaultPanel();
    });

    tdActions.append(limitInput, windowSelect, setBtn, clearBtn);
    tr.append(tdService, tdStatus, tdCount, tdLimit, tdRemaining, tdWindow, tdReset, tdActions);
    tbody.append(tr);
  }

  table.append(tbody);
  host.replaceChildren(table);
}

function renderVaultLedger(ledgerEntries, ctx) {
  const host = byId("vault-ledger");
  if (!host) return;
  host.replaceChildren();

  if (!Array.isArray(ledgerEntries) || ledgerEntries.length === 0) {
    const empty = mk("div", "muted");
    empty.style.padding = "12px";
    empty.textContent = "No proxied requests recorded yet.";
    host.append(empty);
    return;
  }

  const table = mk("table", "vault-ledger-table");

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  for (const col of ["Time", "Service", "Method", "Target & Path", "Status", "Latency"]) {
    const th = document.createElement("th");
    th.textContent = col;
    trHead.append(th);
  }
  thead.append(trHead);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const entry of ledgerEntries) {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "—";

    const tdService = document.createElement("td");
    tdService.textContent = entry.service || entry.keyId || "—";

    const tdMethod = document.createElement("td");
    const methodSpan = mk("span", "vault-method-tag", entry.method || "GET");
    tdMethod.append(methodSpan);

    const tdPath = document.createElement("td");
    const codePath = document.createElement("code");
    codePath.textContent = `${entry.origin || ""}${entry.path || "/"}`;
    Object.assign(codePath.style, {whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-all"});
    tdPath.append(codePath);

    const tdStatus = document.createElement("td");
    const statusPill = mk("span", `vault-status-pill ${entry.ok ? "ok" : "fail"}`, entry.status !== null ? String(entry.status) : (entry.code || (entry.ok ? "OK" : "Refused")));
    tdStatus.append(statusPill);

    const tdMs = document.createElement("td");
    tdMs.textContent = `${entry.ms ?? 0}ms`;

    tr.append(tdTime, tdService, tdMethod, tdPath, tdStatus, tdMs);
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
}

function setVaultStatus(text, isError, ctx) {
  const el = byId("vault-status");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.style.color = isError ? "var(--danger,#b3261e)" : "";
}

async function syncEnclaveToggle(ctx) {
  const enclaveToggle = byId("enclave-enabled-toggle");
  if (!enclaveToggle) return;
  try {
    const got = await globalThis.chrome?.storage?.local?.get?.("cap:enclave-enabled");
    enclaveToggle.checked = got?.["cap:enclave-enabled"] !== false; // default ON
  } catch {
    enclaveToggle.checked = true;
  }
}

export function initVaultStatic(ctx, { runInitialRender = true } = {}) {
  const panelCtx = wireOnce(ctx);
  if (!panelCtx) return;

  const vaultAddId = byId("vault-add-id");
  const vaultAddValue = byId("vault-add-value");
  const vaultAddToggle = byId("vault-add-toggle");
  const vaultAddOrigin = byId("vault-add-origin");
  const vaultAddAuthType = byId("vault-add-auth-type");
  const vaultAddAuthName = byId("vault-add-auth-name");

  vaultAddToggle?.addEventListener("click", () => {
    if (!vaultAddValue) return;
    vaultAddValue.type = vaultAddValue.type === "password" ? "text" : "password";
    vaultAddToggle.textContent = vaultAddValue.type === "password" ? "Show" : "Hide";
  });

  vaultAddId?.addEventListener("input", () => {
    const val = vaultAddId.value.trim().toUpperCase();
    const match = VAULT_PRESETS.find(
      (p) => p.id === val || p.serviceId === val.toLowerCase(),
    );
    if (match) {
      if (vaultAddOrigin) vaultAddOrigin.value = match.origin;
      if (vaultAddAuthType) vaultAddAuthType.value = match.authType;
      if (vaultAddAuthName) vaultAddAuthName.value = match.authName;
    }
  });

  byId("vault-add-save")?.addEventListener("click", async () => {
    const keyId = vaultAddId?.value.trim().toUpperCase() ?? "";
    const value = vaultAddValue?.value ?? "";
    const origin = vaultAddOrigin?.value.trim() ?? "";
    const authType = vaultAddAuthType?.value ?? "bearer";
    const authName = vaultAddAuthName?.value.trim() ?? "Authorization";
    if (!keyId || !value) {
      setVaultStatus("Both a key id and a value are required.", true);
      return;
    }
    const res = await vaultSend("vault.set", { keyId, value, origin, authType, authName });
    if (!res?.ok) {
      setVaultStatus(`Save failed: ${res?.error ?? "unknown"}`, true);
      return;
    }
    if (vaultAddValue) vaultAddValue.value = "";
    if (vaultAddId) vaultAddId.value = "";
    if (vaultAddOrigin) vaultAddOrigin.value = "";
    setVaultStatus(`${keyId} saved. The key is stored encrypted and origin-pinned.`, false);
    await renderVaultPanel();
  });

  byId("vault-ledger-clear")?.addEventListener("click", async () => {
    await vaultSend("vault.ledger.clear", {});
    await renderVaultPanel();
  });

  byId("vault-quotas-reset")?.addEventListener("click", async () => {
    const res = await vaultSend("vault.ledger.setQuotas", { quotas: {} });
    if (!res?.ok) {
      setQuotaStatus(`Reset failed: ${res?.error || res?.code || "unknown"}`, true);
      return;
    }
    lastConfiguredQuotas = {};
    setQuotaStatus("All quotas reset to built-in defaults.", false);
    await renderVaultPanel();
  });

  byId("vault-quota-add-save")?.addEventListener("click", async () => {
    const serviceInput = byId("vault-quota-add-service");
    const limitInput = byId("vault-quota-add-limit");
    const windowSelect = byId("vault-quota-add-window");
    const serviceId = serviceInput?.value?.trim()?.toLowerCase() ?? "";
    const rawLimit = limitInput?.value?.trim() ?? "";
    const numLimit = Number(rawLimit);
    const numWindow = Number(windowSelect?.value ?? "86400000");

    if (!serviceId) {
      setQuotaStatus("Service ID is required.", true);
      return;
    }
    if (rawLimit === "" || !Number.isInteger(numLimit) || numLimit < 0) {
      setQuotaStatus(`Limit for ${serviceId} must be a non-negative integer (0 to disable).`, true);
      return;
    }
    if (!Number.isInteger(numWindow) || numWindow <= 0) {
      setQuotaStatus(`Window for ${serviceId} must be a positive integer.`, true);
      return;
    }
    let stored;
    try {
      stored = await getStoredQuotas();
    } catch (err) {
      // Visible failure, and NO write attempted from an unreadable config.
      setQuotaStatus(`Could not read your saved quota settings: ${String(err?.message ?? err)}`, true);
      return;
    }
    const updated = {
      ...stored,
      [serviceId]: { limit: numLimit, windowMs: numWindow },
    };
    const writeRes = await vaultSend("vault.ledger.setQuotas", { quotas: updated });
    if (!writeRes?.ok) {
      setQuotaStatus(`Failed to set quota for ${serviceId}: ${writeRes?.error || writeRes?.code || "invalid_quota_config"}`, true);
      return;
    }
    if (serviceInput) serviceInput.value = "";
    if (limitInput) limitInput.value = "";
    lastConfiguredQuotas = { ...(writeRes.quotas ?? updated) };
    setQuotaStatus(`Quota set for ${serviceId}: limit ${numLimit}, window ${formatWindowDuration(numWindow)}.`, false);
    await renderVaultPanel();
  });

  const enclaveToggle = byId("enclave-enabled-toggle");
  const enclaveExposeStatus = byId("enclave-expose-status");
  enclaveToggle?.addEventListener("change", async () => {
    try {
      await globalThis.chrome?.storage?.local?.set?.({ "cap:enclave-enabled": enclaveToggle.checked });
      if (enclaveExposeStatus) {
        enclaveExposeStatus.textContent = enclaveToggle.checked ? "Service tools exposed to agents." : "Service tools hidden from agents.";
      }
    } catch (e) {
      setVaultStatus(`Toggle failed: ${e?.message ?? e}`, true);
    }
  });
  syncEnclaveToggle();
  if (runInitialRender) {
    renderVaultPanel();
  }
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  initVaultStatic(panelCtx, { runInitialRender: false });
  await syncEnclaveToggle();
  await renderVaultPanel();
  return {
    refresh: async () => {
      await syncEnclaveToggle();
      await renderVaultPanel();
    },
    unmount: makeUnmount(panelCtx),
  };
}
