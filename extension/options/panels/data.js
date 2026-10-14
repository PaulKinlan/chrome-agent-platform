// panels/data.js — Data, memory explorer, run-log retention, backup/restore & factory reset Settings panel module.

import { sleep } from "../../lib/pure.js";
import { createOpfsAdapter, createChromeAlarmsAdapter } from "../../lib/data-archive.js";
import { executeOptionsExport } from "../../lib/backup-export.js";
import { streamRestoreArchive, createOptionsQuiesce } from "../../lib/backup-restore.js";
import { confirmActionDialog } from "../../shared/components-core.js";
import { createPanelContext, bindPanelCtx } from "../panel-context.js";

const RUN_RETENTION_KEY = "cap:runRetention";

const retentionWired = new WeakSet();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("data");

function describeRetentionBound(policy) {
  if (!policy || policy.mode === "retain-all") {
    return "Every run keeps its full step-by-step detail until you clear it. Storage grows with use.";
  }
  const mib = Math.round((policy.globalBytes ?? 32 * 1024 * 1024) / (1024 * 1024));
  return `Full detail for the newest ${policy.perThread ?? 50} runs per task and the newest ${policy.globalExecutions ?? 500} runs overall (up to ${mib} MiB); older runs keep a summary line.`;
}

export async function wireRunRetentionSettings(ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const toggle = byId("run-retention-keep-all");
  const bound = byId("run-retention-bound");
  if (!toggle || !bound) return;
  let policy = null;
  try {
    const snapshot = await send({ type: "run.list" });
    policy = snapshot?.retentionPolicy ?? null;
  } catch { policy = null; }
  toggle.checked = policy?.mode === "retain-all";
  bound.textContent = describeRetentionBound(policy);
  const key = panelCtx.root ?? panelCtx;
  if (!retentionWired.has(key)) {
    retentionWired.add(key);
    panelCtx.registerCleanup(() => retentionWired.delete(key));
    toggle.addEventListener("toggle", async (event) => {
      const keepAll = event.detail?.checked === true;
      await globalThis.chrome?.storage?.local?.set?.({ [RUN_RETENTION_KEY]: { mode: keepAll ? "retain-all" : "bounded" } });
      let next = null;
      try { next = (await send({ type: "run.list" }))?.retentionPolicy ?? null; } catch { next = null; }
      bound.textContent = describeRetentionBound(next ?? { mode: keepAll ? "retain-all" : "bounded" });
      saveFlash(keepAll ? "Every run log is kept in full." : "Older run logs are folded into a summary line.");
    });
  }
}

export async function renderMemoryExplorer(ctx) {
  if (ctx) ensureCtx(null, ctx);
  const el = $("#memory-explorer");
  if (!el) return;
  const wasExpanded = new Set(
    [...el.querySelectorAll('[data-mem-id][aria-expanded="true"]')]
      .map((n) => n.getAttribute("data-mem-id")),
  );
  el.replaceChildren();
  const res = await send({ type: "memory.stores" })
    .catch(() => ({ stores: [] }));
  const stores = Array.isArray(res?.stores) ? res.stores : [];
  if (!stores.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No memory stores yet.";
    el.append(p);
    return;
  }

  const root = document.createElement("div");
  root.className = "mem-tree";
  el.append(root);

  const master = stores.find((s) => s.kind === "master");
  const named = stores.filter((s) => s.kind === "named");
  const bg = stores.filter((s) => s.kind === "background");
  const site = stores.filter((s) => s.kind === "site");

  function dirNode(label, kind, children) {
    const wrap = document.createElement("div");
    wrap.className = "mem-dir";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "mem-dir-head";
    const memId = `dir:${kind}:${label}`;
    head.setAttribute("data-mem-id", memId);
    head.setAttribute("aria-expanded", "false");
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.textContent = "▸";
    caret.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "mem-dir-icon";
    icon.innerHTML = kind === "master"
      ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12l9-8 9 8"/><path d="M5 10v9h14v-9"/></svg>`
      : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
    const name = document.createElement("span");
    name.className = "mem-dir-name";
    name.textContent = label;
    head.append(caret, icon, name);
    const body = document.createElement("div");
    body.className = "mem-dir-body" + " hidden";
    head.addEventListener("click", () => {
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", String(!open));
      caret.textContent = open ? "▸" : "▾";
      body.classList.toggle("hidden", open);
    });
    wrap.append(head, body);
    for (const c of children) body.append(c);
    if (wasExpanded.has(memId)) {
      head.setAttribute("aria-expanded", "true");
      caret.textContent = "▾";
      body.classList.remove("hidden");
    }
    return wrap;
  }

  function storeNode(store) {
    const wrap = document.createElement("div");
    wrap.className = "mem-dir mem-store";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "mem-dir-head";
    const memId = `store:${store.key}`;
    head.setAttribute("data-mem-id", memId);
    head.setAttribute("aria-expanded", "false");
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.textContent = "▸";
    caret.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "mem-dir-name";
    name.textContent = `${store.label} (${store.keyCount ?? 0})`;
    head.append(caret, name);
    const body = document.createElement("div");
    body.className = "mem-dir-body" + " hidden";
    let loaded = false;
    head.addEventListener("click", async () => {
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", String(!open));
      caret.textContent = open ? "▸" : "▾";
      body.classList.toggle("hidden", open);
      if (!open && !loaded) {
        loaded = true;
        await fillKeys(store, body);
      }
    });
    wrap.append(head, body);
    if (wasExpanded.has(memId)) {
      head.setAttribute("aria-expanded", "true");
      caret.textContent = "▾";
      body.classList.remove("hidden");
      loaded = true;
      fillKeys(store, body).catch(() => { loaded = false; });
    }
    return wrap;
  }

  async function fillKeys(store, body) {
    body.replaceChildren();
    const keyList = await send({ type: "memory.list", origin: store.key })
      .catch(() => []);
    if (!Array.isArray(keyList) || !keyList.length) {
      const p = document.createElement("p");
      p.className = "muted mem-empty";
      p.textContent = "No keys yet.";
      body.append(p);
      return;
    }
    for (const key of keyList) {
      body.append(fileNode(store, key));
    }
    const clearBtn = !store.readOnly
      ? document.createElement("button")
      : null;
    if (clearBtn) {
      clearBtn.type = "button";
      clearBtn.className = "btn small ghost mem-clear";
      clearBtn.textContent = `Clear ${store.label}'s memory`;
      clearBtn.addEventListener("click", async () => {
        const res = await send({ type: "memory.clear", origin: store.key })
          .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        if (res?.ok === false) {
          saveFlash(res.error || `Couldn't clear ${store.label}'s memory.`);
          return;
        }
        saveFlash(`Cleared ${store.label}'s memory.`);
        await renderMemoryExplorer();
        await renderData();
      });
      body.append(clearBtn);
    }
  }

  function fileNode(store, key) {
    const wrap = document.createElement("div");
    wrap.className = "mem-file";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "mem-file-head";
    head.setAttribute("aria-expanded", "false");
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.textContent = "▸";
    caret.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "mem-file-name";
    name.textContent = key;
    head.append(caret, name);
    const val = document.createElement("div");
    val.className = "mem-val hidden";
    let loaded = false;
    head.addEventListener("click", async () => {
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", String(!open));
      caret.textContent = open ? "▸" : "▾";
      val.classList.toggle("hidden", open);
      if (!open && !loaded) {
        loaded = true;
        const v = await send({ type: "memory.get", origin: store.key, key })
          .catch(() => null);
        const pre = document.createElement("pre");
        pre.className = "mem-pre";
        pre.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);
        val.append(pre);
      }
    });
    wrap.append(head, val);
    return wrap;
  }

  if (master) root.append(storeNode(master));
  if (named.length) root.append(dirNode("Named agents", "named", named.map(storeNode)));
  if (bg.length) root.append(dirNode("Background agents", "background", bg.map(storeNode)));
  if (site.length) root.append(dirNode("Site Agents", "site", site.map(storeNode)));
}

export async function renderData(ctx) {
  if (ctx) ensureCtx(null, ctx);
  let origins;
  try {
    origins = await boundedSend("agent.list");
  } catch {
    origins = [];
  }
  const list = $("#origin-list");
  if (!list) return;
  list.replaceChildren();
  if (!origins.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No enrolled sites yet.";
    list.appendChild(p);
  }
  for (const origin of (origins ?? [])) {
    const row = document.createElement("div");
    row.className = "origin-row";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = origin;
    row.appendChild(label);

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn small ghost clear-origin";
    clear.textContent = "Clear";
    clear.addEventListener("click", async () => {
      const res = await send({ type: "memory.clear", origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok === false) {
        saveFlash(res.error || `Couldn't clear memory for ${origin}.`);
        return;
      }
      saveFlash(`Cleared memory for ${origin}.`);
      await renderData();
      await renderMemoryExplorer();
    });
    row.appendChild(clear);

    list.appendChild(row);
  }

  let pending;
  try {
    pending = await boundedSend("agent.pending-cleanup");
  } catch {
    pending = {};
  }
  for (const origin of (pending?.origins ?? [])) {
    const row = document.createElement("div");
    row.className = "origin-row pending";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = origin;
    row.appendChild(label);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn small retry-cleanup";
    retry.textContent = "Retry cleanup";
    retry.setAttribute("aria-label", `Retry cleanup for ${origin}`);
    retry.addEventListener("click", async () => {
      const res = await send({ type: "agent.retry-cleanup", origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok) {
        saveFlash(`Cleanup complete for ${origin}.`);
      } else {
        saveFlash(`Cleanup still incomplete: ${res?.error ?? "unknown"}.`);
      }
      await renderData();
    });
    row.appendChild(retry);
    list.appendChild(row);
  }
  for (const pendingPromotion of (pending?.promotions ?? [])) {
    const origin = pendingPromotion.origin;
    if (typeof origin !== "string") continue;
    const row = document.createElement("div");
    row.className = "origin-row pending";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = `${origin} — ${pendingPromotion.phase === "policy-pending" ? "site policy" : "Site Agent"} promotion pending (tools unavailable)`;
    row.appendChild(label);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn small retry-promotion";
    retry.textContent = "Retry promotion";
    retry.setAttribute("aria-label", `Retry promotion for ${origin}`);
    retry.addEventListener("click", async () => {
      let granted = false;
      try {
        granted = (await globalThis.chrome?.permissions?.request?.({ permissions: ["scripting"], origins: [`${origin}/*`] })) === true;
      } catch { /* owner gesture may be refused */ }
      if (!granted) {
        saveFlash(`Permission denied; ${origin} remains pending and unable to use tools.`);
        return;
      }
      const res = await send({
        type: "agent.enroll-origin", origin, ownerGesture: true,
      }).catch(() => ({ ok: false }));
      saveFlash(res?.ok ? `Promotion complete for ${origin}.` : `Promotion remains pending for ${origin}; retry from this panel.`);
      await renderData();
      await panelCtx.callbacks?.onEnrolledSitesChanged?.();
    });
    row.appendChild(retry);
    if (pendingPromotion.phase === "promotion-pending" || pendingPromotion.phase === "promotion-retry") {
      const abandon = document.createElement("button");
      abandon.type = "button";
      abandon.className = "btn small abandon-promotion";
      abandon.textContent = "Abandon promotion";
      abandon.setAttribute("aria-label", `Abandon pending promotion for ${origin}`);
      abandon.addEventListener("click", async () => {
        const res = await send({
          type: "agent.enroll-origin", origin, ownerGesture: true, abandonPending: true,
        }).catch(() => ({ ok: false }));
        saveFlash(res?.ok ? `Pending promotion abandoned for ${origin}.` : `Could not abandon pending promotion for ${origin}.`);
        await renderData();
        await panelCtx.callbacks?.onEnrolledSitesChanged?.();
      });
      row.appendChild(abandon);
    }
    list.appendChild(row);
  }
  for (const origin of (pending?.abandoned ?? [])) {
    if (typeof origin !== "string") continue;
    const row = document.createElement("div");
    row.className = "origin-row pending";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = `${origin} — abandoned promotion cleanup pending (tools unavailable)`;
    row.appendChild(label);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn small retry-cleanup";
    retry.textContent = "Retry cleanup";
    retry.setAttribute("aria-label", `Retry abandoned promotion cleanup for ${origin}`);
    retry.addEventListener("click", async () => {
      const res = await send({
        type: "agent.enroll-origin", origin, ownerGesture: true, retryAbandonedCleanup: true,
      }).catch(() => ({ ok: false }));
      saveFlash(res?.ok ? `Cleanup complete for ${origin}.` : `Cleanup remains pending for ${origin}.`);
      await renderData();
    });
    row.appendChild(retry);
    list.appendChild(row);
  }
}

// ── Factory reset / Delete all data (CAP-FB-20260823-FACTORY-RESET-01) ──

export async function refreshMaintenanceAgentOptions(ctx) {
  if (ctx) ensureCtx(null, ctx);
  const purgeJournalAgent = $("#purge-journal-agent");
  if (!purgeJournalAgent) return;
  try {
    const res = await boundedSend("named-agent.list");
    const agents = Array.isArray(res?.agents) ? res.agents : [];
    const selected = purgeJournalAgent.value;
    while (purgeJournalAgent.options.length > 1) purgeJournalAgent.remove(1);
    for (const a of agents) {
      const opt = document.createElement("option");
      opt.value = String(a.id ?? a.slug ?? "");
      opt.textContent = String(a.name ?? a.id ?? "agent");
      purgeJournalAgent.append(opt);
    }
    if (selected) purgeJournalAgent.value = selected;
  } catch { /* the select stays "All agents" — the global purge still works */ }
}

export function initDataStatic(ctx, { runInitialRefresh = true } = {}) {
  const panelCtx = wireOnce(ctx);
  if (!panelCtx) return false;
  const factoryResetBtn = $("#factory-reset-btn");
  const factoryResetStatus = $("#factory-reset-status");
  const exportAllBtn = $("#export-all-btn");
  const importAllBtn = $("#import-all-btn");
  const importAllFile = $("#import-all-file");
  const backupStatus = $("#backup-status");
  const purgeJournalsBtn = $("#purge-journals-btn");
  const sweepOrphansBtn = $("#sweep-orphans-btn");
  const purgeJournalAgent = $("#purge-journal-agent");
  const maintenanceStatus = $("#maintenance-status");

  if (runInitialRefresh) {
    refreshMaintenanceAgentOptions();
  }

  function setBackupStatus(text) {
    if (!backupStatus) return;
    backupStatus.hidden = false;
    backupStatus.textContent = text;
  }

  purgeJournalsBtn?.addEventListener("click", async () => {
    const slug = purgeJournalAgent?.value || "";
    const scopeText = slug
      ? `the journal of agent "${slug}"`
      : "ALL agent journals (named + background + Site Agents)";
    const confirmed = await confirmActionDialog({
      title: "Purge journals?",
      body: `This permanently deletes ${scopeText}. Memory content, run history, skills, and artifacts are NOT touched.\n\nContinue?`,
      confirmLabel: "Purge journals",
      destructive: true,
    });
    if (!confirmed) return;
    if (maintenanceStatus) maintenanceStatus.textContent = "Purging journals…";
    purgeJournalsBtn.disabled = true;
    try {
      const res = await boundedSend("memory.purgeJournals", { target: slug ? { agent: slug } : null });
      if (res?.ok) {
        const n = Array.isArray(res.removed) ? res.removed.length : 0;
        if (maintenanceStatus) maintenanceStatus.textContent = n > 0 ? `Purged ${n} journal${n === 1 ? "" : "s"}.` : "No journals found to purge.";
      } else if (maintenanceStatus) {
        maintenanceStatus.textContent = `Purge failed: ${res?.error ?? "unknown error"}`;
      }
    } catch (e) {
      if (maintenanceStatus) maintenanceStatus.textContent = `Purge failed: ${e?.message ?? e}`;
    } finally {
      purgeJournalsBtn.disabled = false;
    }
  });

  sweepOrphansBtn?.addEventListener("click", async () => {
    const confirmed = await confirmActionDialog({
      title: "Clean up leftover agent files?",
      body: "This removes stored data (memory folders, journals, run history) belonging to agents that no longer exist. Live agents and artifacts are never touched.\n\nContinue?",
      confirmLabel: "Clean up",
      destructive: true,
    });
    if (!confirmed) return;
    if (maintenanceStatus) maintenanceStatus.textContent = "Sweeping leftover files…";
    sweepOrphansBtn.disabled = true;
    try {
      const res = await boundedSend("memory.sweepOrphans", {}, 30000);
      if (res?.ok) {
        const s = res.swept ?? {};
        const total = (s.agentDirs ?? 0) + (s.backgroundDirs ?? 0) + (s.executionDirs ?? 0) + (s.threadDirs ?? 0);
        if (maintenanceStatus) {
          maintenanceStatus.textContent = total > 0
            ? `Cleaned up ${total} leftover item${total === 1 ? "" : "s"} (${s.agentDirs ?? 0} agent folders, ${s.backgroundDirs ?? 0} background folders, ${s.executionDirs ?? 0} run histories, ${s.threadDirs ?? 0} thread indexes).`
            : "No leftover files found — everything is already clean.";
        }
      } else if (maintenanceStatus) {
        maintenanceStatus.textContent = `Sweep failed: ${res?.error ?? "unknown error"}`;
      }
    } catch (e) {
      if (maintenanceStatus) maintenanceStatus.textContent = `Sweep failed: ${e?.message ?? e}`;
    } finally {
      sweepOrphansBtn.disabled = false;
    }
  });

  exportAllBtn?.addEventListener("click", async () => {
    setBackupStatus("Collecting your agents, memories, artifacts and settings…");
    exportAllBtn.disabled = true;
    try {
      await executeOptionsExport({
        onStatus: (msg) => setBackupStatus(msg),
        extensionVersion: String(globalThis.chrome?.runtime?.getManifest?.()?.version ?? "unknown"),
      });
    } catch (err) {
      setBackupStatus(`Export failed: ${err?.message || err}`);
    } finally {
      exportAllBtn.disabled = false;
    }
  });

  importAllBtn?.addEventListener("click", () => importAllFile?.click());
  importAllFile?.addEventListener("change", async () => {
    const file = importAllFile?.files?.[0];
    if (!file) return;
    importAllFile.value = "";
    try {
      setBackupStatus("Validating and staging the backup…");
      if (importAllBtn) importAllBtn.disabled = true;

      const root = await navigator.storage.getDirectory();
      const adapter = createOpfsAdapter(root);
      const res = await streamRestoreArchive({
        stream: file,
        opfs: adapter,
        kvSet: (items) => globalThis.chrome?.storage?.local?.set?.(items),
        kvRemove: (keys) => globalThis.chrome?.storage?.local?.remove?.(keys),
        kvGet: (k) => globalThis.chrome?.storage?.local?.get?.(k ?? null),
        alarms: createChromeAlarmsAdapter(),
        confirm: async ({ manifest, summary }) => {
          return await confirmActionDialog({
            title: "Import this backup?",
            body:
              `Importing replaces your CURRENT profile with the backup's agents, memories, artifacts and settings (${summary.opfsFiles} stored files, ${summary.kvKeys} settings keys, ${summary.alarms} schedules).\n\nData the backup does not contain will be removed.\n\nProvider API keys and MCP auth headers are never in the file — you will re-enter them in Settings afterwards.\n\nContinue?`,
            confirmLabel: "Replace my data with this backup",
            destructive: true,
          });
        },
        quiesce: createOptionsQuiesce({
          send,
          setBackupStatus,
          setStorage: (items) => globalThis.chrome?.storage?.local?.set?.(items),
        }),
        onRollback: async () => {
          const invRes = await send("invalidate-agent");
          if (invRes?.invalidated !== true) {
            throw new Error("Worker reported failure during cache invalidation on rollback");
          }
          return invRes;
        },
        onProgress: (p) => setBackupStatus(`${p.phase === "staging" ? "Staging" : "Restoring"} ${p.path || "data"}…`),
        postCommit: async () => {
          let attempts = 0;
          let lastErr = null;
          while (attempts < 3) {
            attempts++;
            try {
              const invRes = await send("invalidate-agent");
              if (invRes && invRes.invalidated === true) {
                return;
              }
              lastErr = new Error(`Worker returned unexpected response: ${JSON.stringify(invRes)}`);
            } catch (e) {
              lastErr = e;
            }
            await sleep(200);
          }
          throw new Error(`Worker cache invalidation failed: ${lastErr?.message || lastErr}`);
        },
        overwrite: true,
      });

      if (res.cancelled) {
        setBackupStatus("Import cancelled — nothing was changed.");
        return;
      }
      const r = res.report?.restored || res.restored || {};
      setBackupStatus(`Restored ${r.opfsFiles ?? 0} files, ${r.kvKeys ?? 0} settings keys and ${r.alarms ?? 0} schedules. Re-enter your provider API keys in the Providers section.`);
    } catch (err) {
      if (err?.message?.includes("Profile restore committed successfully")) {
        setBackupStatus(err.message);
      } else {
        setBackupStatus(`Import failed: ${err?.message || err}`);
      }
    } finally {
      if (importAllBtn) importAllBtn.disabled = false;
    }
  });

  factoryResetBtn?.addEventListener("click", async () => {
    const confirmed = await confirmActionDialog({
      title: "Reset all extension data?",
      body:
        "This is a permanent, destructive action. All tasks, agents, memory, artifacts, downloaded local models, and settings will be completely deleted and the first-run onboarding will be restored.\n\nAre you sure you want to delete everything?",
      confirmLabel: "Delete everything",
      destructive: true,
    });
    if (!confirmed) return;

    if (factoryResetStatus) {
      factoryResetStatus.hidden = false;
      factoryResetStatus.textContent = "Wiping all data and restoring first-run state…";
    }
    factoryResetBtn.disabled = true;

    try {
      const res = await send({ type: "system.factoryReset" });
      if (res?.ok) {
        if (factoryResetStatus) {
          factoryResetStatus.textContent = "All data wiped successfully. Reloading…";
        }
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch { /* storage can throw in restricted modes; the clear is best-effort */ }
        panelCtx.setTimeout(() => {
          panelCtx.callbacks.onFactoryReset();
        }, 500);
      } else {
        throw new Error(res?.error || "Factory reset failed");
      }
    } catch (err) {
      if (factoryResetStatus) {
        factoryResetStatus.hidden = false;
        factoryResetStatus.textContent = `Reset failed: ${err?.message || err}`;
      }
      factoryResetBtn.disabled = false;
    }
  });
  return true;
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  const key = panelCtx.root ?? panelCtx;
  const freshStatic = initDataStatic(panelCtx, { runInitialRefresh: false });
  if (!retentionWired.has(key)) {
    await wireRunRetentionSettings();
  }
  if (freshStatic) {
    await refreshMaintenanceAgentOptions();
  }
  await renderData();
  await renderMemoryExplorer();
  return {
    refresh: async () => {
      await renderData();
      await renderMemoryExplorer();
    },
    unmount: makeUnmount(panelCtx),
  };
}
