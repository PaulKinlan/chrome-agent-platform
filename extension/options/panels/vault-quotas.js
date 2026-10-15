// panels/vault-quotas.js — the enclave per-service call quota UI, split out of web-services.js.
//
// It loads as its own chunk: a Settings-only feature and the largest optional block in the vault panel (about
// 5.8 KB minified), while options.bundle.js carries a hard 450 KB budget. Nothing outside the vault panel used
// any of it, so the split costs one lazy fetch on first render and nothing else.
//
// The panel's helpers are injected rather than imported: web-services.js dynamically imports THIS module, so a
// static import back would make a cycle between the two.

import { ENCLAVE_QUOTAS_STORAGE_KEY } from "../../lib/enclave-ledger.js";

// Bound at the top of every exported entry point, from the caller's deps.
let ctx = null;
let byId = () => null;
let mk = () => null;
let vaultSend = async () => ({ ok: false });
let renderVaultPanel = async () => {};

function bindPanels(context, deps) {
  ctx = context;
  byId = deps.byId;
  mk = deps.mk;
  vaultSend = deps.send;
  renderVaultPanel = () => deps.rerender(context);
}

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

export async function renderVaultQuotas(context, deps) {
  // The body below reads the module-level bindings (byId, mk, vaultSend, renderVaultPanel) and any `ctx`
  // it closes over; bindPanels installs both from this call's context, so nothing is left on the stubs.
  bindPanels(context, deps);
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


/** Reset every service to the built-in defaults (the panel's reset button). */
export async function resetQuotas(context, deps) {
  bindPanels(context, deps);

    const res = await vaultSend("vault.ledger.setQuotas", { quotas: {} });
    if (!res?.ok) {
      setQuotaStatus(`Reset failed: ${res?.error || res?.code || "unknown"}`, true);
      return;
    }
    lastConfiguredQuotas = {};
    setQuotaStatus("All quotas reset to built-in defaults.", false);
    await renderVaultPanel();
}

/** Add or replace one service's quota (the panel's add row). */
export async function addQuotaFromRow(context, deps) {
  bindPanels(context, deps);

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
}
