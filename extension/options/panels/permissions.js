// panels/permissions.js — Optional capabilities, Chrome site access & Python network grants Settings panel module.

import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  capabilityState,
  requestCapability,
} from "../../lib/capabilities.js";
import {
  declaredManifestOrigins,
  revokeSiteOrigin,
  siteAccessLabel,
  siteAccessScope,
  siteAccessState,
} from "../../lib/site-access.js";
import { runOwnerApprovedMutation } from "../../lib/owner-approved-mutation.js";
import { confirmActionDialog } from "../../shared/components-core.js";
import { createPanelContext, bindPanelCtx } from "../panel-context.js";

const pythonNetWiredSet = new WeakSet();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("permissions");

const PERMISSION_STATE_ICONS = {
  on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true" style="color:var(--accent)"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>',
  fixed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unavailable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
};

function permissionGroupShell(id, label, hint, on, total, open) {
  const details = document.createElement("details");
  details.className = "perm-group";
  details.dataset.group = id;
  details.open = open;
  const summary = document.createElement("summary");
  const h3 = document.createElement("h3");
  h3.textContent = label;
  const count = document.createElement("span");
  count.className = "perm-group-count";
  count.textContent = id === "required"
    ? `${total} · always on`
    : on === 0 ? `none of ${total} on` : `${on} of ${total} on`;
  const sub = document.createElement("span");
  sub.className = "perm-group-hint muted";
  sub.textContent = hint;
  summary.append(h3, count, sub);
  const rows = document.createElement("div");
  rows.className = "perm-group-rows";
  details.append(summary, rows);
  return { details, rows };
}

async function renderPermissions() {
  const panelCtx = ensureCtx(null, arguments[0]);
  const list = $("#permission-list");
  if (!list) {
    await renderPythonNetworkGrants();
    return;
  }
  const openBefore = new Map(
    [...list.querySelectorAll("details.perm-group")].map((d) => [d.dataset.group, d.open]),
  );
  list.replaceChildren();
  const manifest = globalThis.chrome?.runtime?.getManifest?.() ?? {};
  const mandatory = new Set(manifest.permissions ?? []);
  const groups = new Map(CAPABILITY_GROUPS.map((g) => [g.id, { ...g, rows: [], on: 0 }]));
  for (const cap of CAPABILITIES) {
    if ((cap.permissions ?? []).every((p) => mandatory.has(p))) continue;
    const st = await capabilityState(cap.id);
    const group = groups.get(cap.group) ?? groups.get("system");
    const row = document.createElement("capability-row");
    row.dataset.capability = cap.id;
    row.setAttribute("name", cap.label);
    row.setAttribute("description", cap.hint);
    row.setAttribute("detail", cap.gates ?? `Gates: ${cap.label.toLowerCase()}.`);
    row.setAttribute("detail-label", "What it allows");

    if (st.state === "granted") {
      group.on += 1;
      row.dataset.state = "granted";
      row.setAttribute("icon", PERMISSION_STATE_ICONS.on);
      row.setAttribute("action-state", "on");
      row.addEventListener("toggle", async (e) => {
        if (e.detail?.checked) return;
        const res = await runOwnerApprovedMutation({
          message: { type: "capability.revoke", id: cap.id },
          action: "capability.revoke",
          sendMessage: (value) => send(value),
          requestConfirmation: () => confirmActionDialog({
            title: `Turn off ${cap.label}?`,
            body: cap.id === "scripting"
              ? `${cap.label} will stop for every site you added: their agents are removed and Chrome's access to those sites is released.`
              : `${cap.label} will be turned off and the agent can no longer use it until you turn it on again.`,
            confirmLabel: "Turn off",
            destructive: true,
            requireGenuineGesture: true,
            returnFocusTo: row,
          }),
        });
        if (!res.ok) {
          saveFlash(res.cancelled
            ? `${cap.label} stays on; nothing was changed.`
            : `Could not turn off ${cap.label}: ${res.error ?? "unknown error"}`);
        }
        renderPermissions();
      });
    } else if (st.state === "platform-unavailable" || st.state === "partial-platform-unavailable") {
      row.dataset.state = "unavailable";
      row.setAttribute("icon", PERMISSION_STATE_ICONS.unavailable);
      row.setAttribute("action", "state");
      row.setAttribute("action-label", "Not available on this platform");
      row.setAttribute("description", st.state === "partial-platform-unavailable"
        ? `${cap.hint} The ${st.unavailablePermissions.join(" / ")} API exists only on ChromeOS; the rest works here.`
        : `${cap.hint} This API exists only on ChromeOS.`);
    } else {
      row.dataset.state = "requestable";
      row.setAttribute("icon", PERMISSION_STATE_ICONS.off);
      row.setAttribute("action", "run");
      row.setAttribute("action-label", "Turn on");
      row.addEventListener("run", async () => {
        const res = await requestCapability(cap.id).catch(() => ({ granted: false }));
        if (res?.granted) renderPermissions();
        else {
          row.setAttribute("action-label", "Try again");
          saveFlash(`${cap.label} was not turned on. Click Try again to ask Chrome once more.`);
        }
      });
    }
    group.rows.push(row);
  }
  for (const group of groups.values()) {
    if (group.rows.length === 0) continue;
    const { details, rows } = permissionGroupShell(
      group.id, group.label, group.hint, group.on, group.rows.length,
      openBefore.get(group.id) ?? group.on > 0,
    );
    rows.append(...group.rows);
    list.appendChild(details);
  }
  const mandatoryLabels = {
    storage: "Memory & settings (core)",
    alarms: "Scheduled tasks (core)",
    sidePanel: "Side panel (core)",
    offscreen: "Background execution host (internal)",
  };
  const manifestPerms = (chrome.runtime.getManifest().permissions ?? []).filter((p) => mandatoryLabels[p]);
  if (manifestPerms.length > 0) {
    const { details, rows } = permissionGroupShell(
      "required", "Always on", "The hub cannot start without these; they are granted when the extension is installed.",
      manifestPerms.length, manifestPerms.length, openBefore.get("required") ?? false,
    );
    for (const p of manifestPerms) {
      const row = document.createElement("capability-row");
      row.dataset.capability = p;
      row.dataset.state = "required";
      row.setAttribute("icon", PERMISSION_STATE_ICONS.fixed);
      row.setAttribute("name", mandatoryLabels[p]);
      row.setAttribute("description", "Granted at install. The hub cannot start without it.");
      row.setAttribute("action", "state");
      row.setAttribute("action-label", "Always on");
      rows.appendChild(row);
    }
    list.appendChild(details);
  }
  // ── Chrome site access: what Chrome ACTUALLY holds ──
  const access = await siteAccessState(chrome, declaredManifestOrigins(chrome.runtime.getManifest()));
  const accessCount = access.fixed.length + access.revocable.length;
  const { details: accessDetails, rows: accessRows } = permissionGroupShell(
    "site-access", "Chrome site access",
    "What Chrome grants this extension — separate from the capability switches above.",
    access.ok ? accessCount : 0, access.ok ? accessCount : 1,
    openBefore.get("site-access") ?? true,
  );
  if (!access.ok) {
    const failed = document.createElement("p");
    failed.className = "muted";
    failed.textContent = "Chrome's site access could not be read.";
    accessRows.appendChild(failed);
  } else if (accessCount === 0) {
    const none = document.createElement("p");
    none.className = "muted";
    none.textContent = "No site access granted.";
    accessRows.appendChild(none);
  } else {
    for (const pattern of access.fixed) {
      const row = document.createElement("capability-row");
      row.dataset.capability = "site-access";
      row.dataset.state = "required";
      row.setAttribute("icon", PERMISSION_STATE_ICONS.fixed);
      row.setAttribute("name", siteAccessLabel(pattern));
      row.setAttribute("description", "Granted when the extension was installed. Chrome only takes this back from chrome://extensions.");
      row.setAttribute("action", "state");
      row.setAttribute("action-label", "Granted at install");
      accessRows.appendChild(row);
    }
    for (const pattern of access.revocable) {
      const row = document.createElement("capability-row");
      row.dataset.capability = "site-access";
      row.dataset.state = "granted";
      row.setAttribute("icon", PERMISSION_STATE_ICONS.on);
      row.setAttribute("name", siteAccessLabel(pattern));
      row.setAttribute("description", `Chrome grants access to ${siteAccessScope(pattern)}. Revoke asks Chrome to take it back.`);
      row.setAttribute("action", "run");
      row.setAttribute("action-label", "Revoke");
      row.addEventListener("run", async () => {
        const removed = await revokeSiteOrigin(chrome, pattern);
        saveFlash(removed
          ? `Site access to ${siteAccessLabel(pattern)} was removed.`
          : `Could not revoke site access to ${siteAccessLabel(pattern)}.`);
        renderPermissions();
      });
      accessRows.appendChild(row);
    }
  }
  list.appendChild(accessDetails);
  await renderPythonNetworkGrants();
}

function pythonNetStatus(message, isError = false, ctx) {
  const el = $("#python-net-status");
  if (!el) return;
  el.textContent = message ?? "";
  el.classList.toggle("error", Boolean(isError));
}

async function renderPythonNetworkGrants(ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const list = $("#python-net-list");
  if (!list) return;
  const key = panelCtx.root ?? panelCtx;
  if (!pythonNetWiredSet.has(key)) {
    pythonNetWiredSet.add(key);
    panelCtx.registerCleanup(() => pythonNetWiredSet.delete(key));
    const input = $("#python-net-origin");
    const add = async () => {
      const origin = String(input?.value ?? "").trim();
      if (!origin) {
        pythonNetStatus("Type an origin first, for example https://api.example.com.", true);
        return;
      }
      pythonNetStatus("Adding…", false);
      const res = await send({ type: "python.network.grant", origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (!res?.ok) {
        pythonNetStatus(res?.error ?? "That origin could not be added.", true);
        return;
      }
      if (input) input.value = "";
      pythonNetStatus(res.added ? `${res.origin} can now be reached.` : `${res.origin} was already on the list.`, false);
      await renderPythonNetworkGrants();
    };
    $("#python-net-add")?.addEventListener("click", add);
    input?.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") { e.preventDefault(); add(); }
    });
  }

  const res = await send({ type: "python.network.grants" })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  list.replaceChildren();
  if (!res?.ok) {
    const err = document.createElement("p");
    err.className = "muted error";
    err.textContent = res?.error ?? "The list could not be read.";
    list.appendChild(err);
    return;
  }
  const grants = Array.isArray(res.grants) ? res.grants : [];
  if (grants.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No origins allowed. Python cannot reach anything on the network.";
    list.appendChild(empty);
    return;
  }
  for (const grant of grants) {
    const row = document.createElement("div");
    row.className = "python-net-row";
    row.dataset.origin = grant.origin;

    const origin = document.createElement("span");
    origin.className = "python-net-origin";
    origin.textContent = grant.origin;
    row.appendChild(origin);

    const meta = document.createElement("span");
    meta.className = "muted python-net-meta";
    const when = Number.isFinite(grant.grantedAt) && grant.grantedAt > 0
      ? new Date(grant.grantedAt).toLocaleString()
      : "an earlier session";
    meta.textContent = grant.gesture === "first-use-prompt"
      ? `Allowed when a task asked, ${when}`
      : `Allowed here, ${when}`;
    row.appendChild(meta);

    const remove = document.createElement("button");
    remove.className = "btn small ghost";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${grant.origin}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      pythonNetStatus(`Removing ${grant.origin}…`, false);
      const out = await send({ type: "python.network.revoke", origin: grant.origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (!out?.ok) {
        remove.disabled = false;
        pythonNetStatus(out?.error ?? "That origin could not be removed.", true);
        return;
      }
      pythonNetStatus(`${grant.origin} can no longer be reached.`, false);
      await renderPythonNetworkGrants();
    });
    row.appendChild(remove);
    list.appendChild(row);
  }
}
// async function renderHooks() (moved to panels/hooks.js)

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  await renderPermissions();
  return {
    refresh: () => renderPermissions(),
    unmount: makeUnmount(panelCtx),
  };
}
