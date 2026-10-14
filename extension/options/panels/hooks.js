// panels/hooks.js — System hooks Settings panel module.

import { confirmActionDialog } from "../../shared/components-core.js";
import { createPanelContext, bindPanelCtx } from "../panel-context.js";

const hooksWiredSet = new WeakSet();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("hooks");

// ── System hooks (the chrome.* event surface + the deny-list) ──
// vocab:advanced:start — the Hooks section is developer-only
// (data-developer="true") and names the chrome.* APIs it lists.
const HOOK_API_LABELS = {
  tabs: "Tabs", windows: "Windows", bookmarks: "Bookmarks", history: "History",
  downloads: "Downloads", webNavigation: "Navigation", contextMenus: "Context menus",
  commands: "Keyboard commands", notifications: "Notifications", idle: "Idle",
  alarms: "Alarms", storage: "Storage", runtime: "Runtime", action: "Toolbar button",
};

export async function renderHooks() {
  const panelCtx = ensureCtx(null, arguments[0]);
  const res = await send({ type: "hooks.status" })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  const hooks = res?.hooks ?? [];
  const table = $("#hook-list");
  if (!table) return;
  // The owner's expanded/collapsed choice per API group survives a re-render.
  const openBefore = new Map(
    [...table.querySelectorAll("tbody[data-api]")].map((b) => [b.dataset.api, b.dataset.open === "true"]),
  );
  for (const body of [...table.querySelectorAll("tbody")]) body.remove();

  const byApi = new Map();
  for (const h of hooks) {
    const api = String(h.id).split(".")[0];
    if (!byApi.has(api)) byApi.set(api, []);
    byApi.get(api).push(h);
  }
  const deniedTotal = hooks.filter((h) => h.denied).length;
  const summary = $("#hooks-summary");
  if (summary) {
    summary.textContent = hooks.length === 0
      ? "No hooks to show."
      : deniedTotal === 0
        ? `${hooks.length} events, all allowed.`
        : `${hooks.length} events, ${deniedTotal} denied.`;
  }
  const denyAll = $("#hooks-deny-all");
  if (denyAll) {
    denyAll.disabled = hooks.length === 0 || deniedTotal === hooks.length;
  }

  for (const [api, group] of byApi) {
    const denied = group.filter((h) => h.denied).length;
    const subscribed = group.filter((h) => h.subscribers?.length).length;
    const open = openBefore.get(api) ?? (denied > 0 || subscribed > 0);
    const body = document.createElement("tbody");
    body.id = `hook-group-${api}`;
    body.dataset.api = api;
    body.dataset.open = String(open);

    const groupRow = document.createElement("tr");
    groupRow.className = "hook-group";
    const th = document.createElement("th");
    th.scope = "rowgroup";
    th.colSpan = 3;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "hook-group-toggle";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", `hook-group-${api}`);
    const chevron = document.createElement("span");
    chevron.className = "hook-group-chevron";
    chevron.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "hook-group-name";
    name.textContent = HOOK_API_LABELS[api] ?? api;
    const meta = document.createElement("span");
    meta.className = "hook-group-meta muted";
    const permissions = [...new Set(group.map((h) => h.permission).filter(Boolean))];
    meta.textContent = [
      `${group.length} ${group.length === 1 ? "event" : "events"}`,
      denied === 0 ? "all allowed" : denied === group.length ? "all denied" : `${denied} denied`,
      permissions.length ? `needs ${permissions.map((p) => `"${p}"`).join(", ")}` : null,
    ].filter(Boolean).join(" · ");
    toggle.append(chevron, name, meta);
    toggle.addEventListener("click", () => {
      const next = body.dataset.open !== "true";
      body.dataset.open = String(next);
      toggle.setAttribute("aria-expanded", String(next));
    });
    th.appendChild(toggle);
    groupRow.appendChild(th);
    body.appendChild(groupRow);

    for (const h of group) {
      const tr = document.createElement("tr");
      tr.className = "hook-row";
      tr.dataset.hook = h.id;

      const event = document.createElement("td");
      event.className = "hook-event";
      const label = document.createElement("span");
      label.className = "hook-label";
      label.textContent = h.label;
      event.appendChild(label);
      if (h.subscribers?.length) {
        const subs = document.createElement("span");
        subs.className = "hook-subs muted";
        subs.textContent = `subscribed: ${h.subscribers.join(", ")}`;
        event.appendChild(subs);
      }

      const apiCell = document.createElement("td");
      apiCell.className = "col-api";
      const code = document.createElement("code");
      code.textContent = `chrome.${h.id}`;
      apiCell.appendChild(code);

      const stateCell = document.createElement("td");
      stateCell.className = "col-state";
      const isDenied = Boolean(h.denied);
      const sw = document.createElement("switch-toggle");
      sw.setAttribute("label", `Allow ${h.label}`);
      if (!isDenied) sw.setAttribute("checked", "");
      sw.addEventListener("toggle", async (e) => {
        const allow = Boolean(e.detail?.checked);
        const r = await send({ type: "hooks.deny", hookId: h.id, denied: !allow })
          .catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
        saveFlash(r?.ok
          ? `${h.label} ${r.denied ? "denied" : "allowed"}.`
          : `Could not update ${h.label}: ${r?.error ?? "failed"}.`);
        await renderHooks();
      });
      stateCell.appendChild(sw);

      tr.append(event, apiCell, stateCell);
      body.appendChild(tr);
    }
    table.appendChild(body);
  }

  const key = panelCtx.root ?? panelCtx;
  if (denyAll && !hooksWiredSet.has(key)) {
    hooksWiredSet.add(key);
    panelCtx.registerCleanup(() => hooksWiredSet.delete(key));
    denyAll.addEventListener("click", async () => {
      const status = await send({ type: "hooks.status" }).catch(() => null);
      const pending = (status?.hooks ?? []).filter((h) => !h.denied);
      if (pending.length === 0) return;
      const confirmed = await confirmActionDialog({
        title: "Deny every hook?",
        body: `The agent stops listening to all ${pending.length} browser events. You can allow them again one at a time.`,
        confirmLabel: "Deny all",
        destructive: true,
        requireGenuineGesture: true,
        returnFocusTo: denyAll,
      });
      if (!confirmed) return;
      denyAll.disabled = true;
      let failed = 0;
      for (const h of pending) {
        const r = await send({ type: "hooks.deny", hookId: h.id, denied: true })
          .catch(() => ({ ok: false }));
        if (!r?.ok) failed += 1;
      }
      saveFlash(failed === 0
        ? `All ${pending.length} hooks denied.`
        : `${pending.length - failed} hooks denied; ${failed} could not be updated.`);
      await renderHooks();
    });
  }
}
// vocab:advanced:end

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  await renderHooks();
  return {
    refresh: () => renderHooks(),
    unmount: makeUnmount(panelCtx),
  };
}
