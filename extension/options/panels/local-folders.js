// panels/local-folders.js — Local folders & persistent FS grants Settings panel module.

import { wireLocalFolderPickers, regrantFsGrantAccess } from "../../lib/fs-grants.js";
import { mountGrantBrowser } from "../../lib/folder-browser.js";
import { confirmActionDialog } from "../../shared/components-core.js";
import { createPanelContext, bindPanelCtx } from "../panel-context.js";

const cleanupRegistered = new WeakSet();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("local-folders");

export async function renderLocalFolders(ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const key = panelCtx.root ?? panelCtx;
  if (!cleanupRegistered.has(key)) {
    cleanupRegistered.add(key);
    panelCtx.registerCleanup(() => {
      cleanupRegistered.delete(key);
      const dirBtn = byId("fs-add-directory-btn");
      const fileBtn = byId("fs-add-file-btn");
      if (dirBtn) delete dirBtn._pickerWired;
      if (fileBtn) delete fileBtn._pickerWired;
    });
  }
  const pickerWin = typeof window !== "undefined"
    ? Object.create(window, {
        document: {
          value: {
            getElementById: (id) => byId(id),
          },
        },
      })
    : null;
  wireLocalFolderPickers({
    win: pickerWin,
    onFlash: (msg) => saveFlash(msg),
    onRender: () => renderLocalFolders(),
  });
  const host = $("#local-folders-list");
  if (!host) return;
  host.replaceChildren();

  let res;
  try {
    res = await boundedSend("fs-grant.list");
  } catch (e) {
    res = { ok: false, error: String(e?.message ?? e) };
  }

  const grants = Array.isArray(res?.grants) ? res.grants : [];
  if (grants.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty muted";
    empty.style.padding = "12px 14px";
    empty.style.fontSize = "13px";
    empty.textContent = "No local folder or file access has been granted. When you attach local directories to tasks or agents, they will be listed here.";
    host.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "folder-grants-list";
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "8px";

  for (const grant of grants) {
    const card = document.createElement("div");
    card.className = "folder-grant-card";
    card.style.display = "flex";
    card.style.alignItems = "center";
    card.style.justifyContent = "space-between";
    card.style.padding = "10px 14px";
    card.style.border = "1px solid var(--border,#e3e0d9)";
    card.style.borderRadius = "10px";
    card.style.background = "var(--panel,#ffffff)";
    card.style.gap = "12px";

    const info = document.createElement("div");
    info.style.display = "flex";
    info.style.flexDirection = "column";
    info.style.gap = "4px";
    info.style.minWidth = "0";

    const titleRow = document.createElement("div");
    titleRow.style.display = "flex";
    titleRow.style.alignItems = "center";
    titleRow.style.gap = "8px";

    const title = document.createElement("strong");
    title.textContent = grant.name || "Local folder";
    title.style.fontSize = "13.5px";

    const kindChip = document.createElement("span");
    kindChip.className = "chip";
    kindChip.style.fontSize = "var(--text-xs, 12px)";
    kindChip.style.padding = "1px 7px";
    kindChip.style.borderRadius = "999px";
    kindChip.style.border = "1px solid var(--border,#e3e0d9)";
    kindChip.textContent = grant.kind === "file" ? "file" : "directory";

    const modeChip = document.createElement("span");
    modeChip.className = "chip";
    modeChip.style.fontSize = "var(--text-xs, 12px)";
    modeChip.style.padding = "1px 7px";
    modeChip.style.borderRadius = "999px";
    modeChip.style.border = "1px solid var(--border,#e3e0d9)";
    modeChip.textContent = grant.mode === "readwrite" ? "read/write" : "read-only";

    const statusBadge = document.createElement("span");
    statusBadge.className = `chip avail-${grant.status === "granted" ? "ready" : grant.status === "prompt" ? "owner-action-required" : "disabled"}`;
    statusBadge.style.fontSize = "var(--text-xs, 12px)";
    statusBadge.style.padding = "1px 7px";
    statusBadge.style.borderRadius = "999px";
    statusBadge.textContent = grant.status === "granted" ? "active" : grant.status === "prompt" ? "needs re-grant" : grant.status;

    titleRow.append(title, kindChip, modeChip, statusBadge);

    const meta = document.createElement("div");
    meta.className = "meta muted";
    meta.style.fontSize = "12px";
    const scopeDesc = grant.scope?.taskId ? `Task: ${grant.scope.taskId}` : grant.scope?.agentId ? `Agent: ${grant.scope.agentId}` : "Global scope";
    meta.textContent = `${scopeDesc} · ID: ${grant.grantId}`;

    info.append(titleRow, meta);

    const cardControls = document.createElement("div");
    cardControls.style.display = "flex";
    cardControls.style.alignItems = "center";
    cardControls.style.gap = "8px";

    if (grant.status === "prompt") {
      const regrantBtn = document.createElement("button");
      regrantBtn.type = "button";
      regrantBtn.className = "btn small primary";
      regrantBtn.textContent = "Re-grant access";
      regrantBtn.addEventListener("click", async (event) => {
        if (!event.isTrusted) {
          saveFlash("Re-grant requires a genuine user click.");
          return;
        }
        regrantBtn.disabled = true;
        regrantBtn.textContent = "Requesting…";
        const result = await regrantFsGrantAccess(grant.grantId, {
          isTrusted: event.isTrusted,
        });
        if (result?.ok && result?.status === "granted") {
          saveFlash(`Re-granted access to "${grant.name}".`);
        } else if (result?.status === "denied") {
          saveFlash(`Access denied for "${grant.name}". You can revoke it if no longer needed.`);
        } else {
          saveFlash(`Re-grant not completed: ${result?.error || result?.status || "cancelled"}.`);
        }
        renderLocalFolders();
      });
      cardControls.append(regrantBtn);
    }

    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "btn small";
    browseBtn.textContent = "Browse";
    browseBtn.disabled = grant.status !== "granted";
    if (grant.status !== "granted") {
      browseBtn.title = "Re-grant access before browsing contents";
    }

    let drawer = null;
    browseBtn.addEventListener("click", async () => {
      if (drawer) {
        drawer.remove();
        drawer = null;
        browseBtn.textContent = "Browse";
        return;
      }
      browseBtn.textContent = "Close";
      drawer = document.createElement("div");
      drawer.className = "grant-browser-drawer";
      drawer.style.marginTop = "10px";
      drawer.style.padding = "10px 12px";
      drawer.style.borderRadius = "8px";
      drawer.style.background = "var(--bg-subtle,#f8f7f5)";
      drawer.style.border = "1px solid var(--border,#e3e0d9)";
      drawer.style.fontSize = "12px";
      drawer.style.width = "100%";
      drawer.style.boxSizing = "border-box";

      cardWrapper.append(drawer);

      mountGrantBrowser({
        host: drawer,
        grant,
        send: (type, payload) => boundedSend(type, payload),
      });
    });

    const revokeBtn = document.createElement("button");
    revokeBtn.type = "button";
    revokeBtn.className = "btn small danger";
    revokeBtn.textContent = "Revoke";
    revokeBtn.addEventListener("click", async () => {
      const confirmed = await confirmActionDialog({
        title: "Revoke folder access?",
        body: `Revoke persistent access to "${grant.name}"? The agent will no longer be able to access this local path.`,
        confirmLabel: "Revoke access",
        destructive: true,
      });
      if (!confirmed) return;
      revokeBtn.disabled = true;
      const removeRes = await send({
        type: "fs-grant.remove",
        grantId: grant.grantId,
      }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
      if (removeRes?.ok) {
        saveFlash(`Revoked access to "${grant.name}".`);
      } else {
        saveFlash(`Revocation failed: ${removeRes?.error ?? "unknown error"}.`);
      }
      renderLocalFolders();
    });

    cardControls.append(browseBtn, revokeBtn);
    card.append(info, cardControls);

    const cardWrapper = document.createElement("div");
    cardWrapper.style.display = "flex";
    cardWrapper.style.flexDirection = "column";
    cardWrapper.style.width = "100%";
    cardWrapper.append(card);

    list.append(cardWrapper);
  }

  host.append(list);
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  await renderLocalFolders();
  return {
    refresh: () => renderLocalFolders(),
    unmount: makeUnmount(panelCtx),
  };
}
