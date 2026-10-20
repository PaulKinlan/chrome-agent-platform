// panels/web-services.js — Web services & vault Settings panel module.

import { vaultPanelRows, resolveSaveAction } from "../../lib/secret-vault.js";
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

// The quota UI is its own chunk (panels/vault-quotas.js): it was the largest optional block in this panel,
// and options.bundle.js has a hard 450 KB budget. The promise is memoised so every entry point shares one
// fetch, and renderVaultQuotas is awaited during the initial render, so the chunk is loaded before any
// control it owns can be clicked.
let quotaUiPromise = null;
const loadQuotaUi = () =>
  (quotaUiPromise ??= import("./vault-quotas.js").catch((err) => {
    quotaUiPromise = null;
    throw err;
  }));
const quotaDeps = () => ({ byId, mk, send: vaultSend, rerender: renderVaultPanel });

export async function renderVaultQuotas(ctx) {
  try {
    const mod = await loadQuotaUi();
    return await mod.renderVaultQuotas(ctx, quotaDeps());
  } catch (err) {
    const host = byId("vault-quotas") || byId("vault-summary");
    if (host && !host.querySelector(".quota-load-error")) {
      const errBox = mk("div", "quota-load-error", "Failed to load quota view. Reload page to retry.");
      errBox.style.cssText = "color:var(--text-muted, #888);padding:8px 0;font-size:12px;";
      host.append(errBox);
    }
    throw err;
  }
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
    const mod = await loadQuotaUi();
    await mod.resetQuotas(ctx, quotaDeps());
  });

  byId("vault-quota-add-save")?.addEventListener("click", async () => {
    const mod = await loadQuotaUi();
    await mod.addQuotaFromRow(ctx, quotaDeps());
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
