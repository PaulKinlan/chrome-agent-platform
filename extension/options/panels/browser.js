// panels/browser.js — Browser control & destructive action policy Settings panel module.

import { createPanelContext, bindPanelCtx } from "../panel-context.js";

const DESTRUCTIVE_POLICY_KEY = "cap:destructiveActionPolicy";

const browserWired = new WeakSet();
const policyWired = new WeakSet();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("browser");

async function renderGrantRows(ctx) {
  const host = $("#grant-origin-rows");
  const summary = $("#grant-origin-summary");
  if (!host) return null;
  const live = await boundedSend("browser-control.get").catch(() => null);
  host.replaceChildren();
  const grants = Array.isArray(live?.grants) ? live.grants : [];
  if (summary) {
    summary.textContent = live?.scope === "global"
      ? "Every site is allowed until you turn the switch off. Add origins below to scope control to specific sites."
      : grants.length
      ? `${grants.length} ${grants.length === 1 ? "site is" : "sites are"} allowed. Each keeps its own grant; turn one off without touching the others.`
      : "No sites are allowed yet. Add an origin below, or allow one from an approval card in a chat.";
  }
  for (const g of grants) {
    if (typeof g?.origin !== "string") continue;
    const row = document.createElement("origin-grant-row");
    row.setAttribute("origin", g.origin);
    if (typeof g.expiresInMs === "number") row.setAttribute("expires-in-ms", String(g.expiresInMs));
    row.addEventListener("revoke", async (e) => {
      const origin = e.detail?.origin;
      row.setAttribute("disabled", "");
      const res = await send({ type: "browser-control.revoke", origin })
        .catch((err) => ({ grant: { revoked: false, error: String(err?.message ?? err) } }));
      if (res?.grant?.revoked === true) {
        saveFlash(`Browser control turned off for ${origin}.`);
      } else {
        saveFlash(`Could not turn off ${origin}: ${res?.grant?.error ?? "still allowed"}.`);
      }
      await syncBrowserGrantState();
    });
    host.appendChild(row);
  }
  return live;
}

export async function syncBrowserGrantState(ctx) {
  if (ctx) ensureCtx(null, ctx);
  const live = await renderGrantRows();
  const toggle = $("#browser-grant");
  const grantOrigins = $("#grant-origins");
  if (toggle && live) {
    toggle.checked = live.active === true;
    if (grantOrigins) grantOrigins.hidden = !toggle.checked;
  }
  return live;
}

async function renderBrowser(ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const live = await boundedSend("browser-control.get").catch(() => null);
  const granted = live?.active === true;
  const toggle = $("#browser-grant");
  if (toggle) toggle.checked = granted;

  const autoClose = await storage.get("cap:autoCloseRunTabs");
  const autoToggle = $("#auto-close-run-tabs");
  if (autoToggle) {
    autoToggle.checked = autoClose?.["cap:autoCloseRunTabs"] === true;
  }
  const grantOrigins = $("#grant-origins");
  if (grantOrigins) grantOrigins.hidden = !granted;
  await renderGrantRows();

  const key = panelCtx.root ?? panelCtx;
  if (!browserWired.has(key)) {
    browserWired.add(key);
    panelCtx.registerCleanup(() => browserWired.delete(key));

    autoToggle?.addEventListener("toggle", async (e) => {
      await storage.set({ "cap:autoCloseRunTabs": e.detail.checked === true });
      saveFlash(e.detail.checked === true ? "Auto-close run tabs on." : "Auto-close run tabs off.");
    });

    panelCtx.addChromeListener(globalThis.chrome?.storage?.onChanged, (changes, area) => {
      if (area === "local" && changes && Object.hasOwn(changes, "cap:browserControlGrant")) {
        void syncBrowserGrantState();
      }
    });

    toggle?.addEventListener("toggle", async (e) => {
      const checked = e.detail.checked;
      if (checked) {
        let storageGranted = true;
        try {
          storageGranted = (await globalThis.chrome?.permissions?.contains?.({ permissions: ["storage"] })) === true;
        } catch { storageGranted = false; }
        let captureGranted = false;
        try {
          captureGranted = (await globalThis.chrome?.permissions?.contains?.({
            permissions: ["activeTab"],
          })) === true;
        } catch { /* unreadable — activeTab treated as absent */ }
        await send({
          type: "browser-control.set",
          granted: true,
        });
        if (grantOrigins) grantOrigins.hidden = false;
        await renderGrantRows();
        saveFlash(
          captureGranted
            ? "Browser control granted (global, all origins — set origins below to scope it)." +
              (storageGranted ? "" : " (session-only — storage permission not granted)")
            : "Browser control granted (icon-click screenshots unavailable — activeTab permission not granted)." +
              (storageGranted ? "" : " (session-only — storage permission not granted)"),
        );
        panelCtx.callbacks?.onPermissionsChanged?.();
      } else {
        const res = await send({
          type: "browser-control.set",
          granted: false,
        }).catch((err) => ({ grant: { revoked: false, error: String(err?.message ?? err) } }));
        const revoked = res?.grant?.revoked === true;
        if (revoked) {
          if (grantOrigins) grantOrigins.hidden = true;
          $("#grant-origin-rows")?.replaceChildren();
          saveFlash("Browser control revoked.");
        } else {
          saveFlash(
            "Browser control revoke failed: " +
              (res?.grant?.error ?? "still granted") +
              ".",
          );
          const liveNow = await send({ type: "browser-control.get" })
            .catch(() => null);
          toggle.checked = liveNow?.active === true;
          if (grantOrigins) grantOrigins.hidden = !toggle.checked;
        }
        panelCtx.callbacks?.onPermissionsChanged?.();
      }
    });

    $("#grant-origin-list")?.addEventListener("change", async (e) => {
      const origins = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
      if (origins.length === 0) return;
      const res = await send({
        type: "browser-control.set",
        granted: true,
        origins,
      }).catch((err) => ({ error: String(err?.message ?? err) }));
      if (res?.grant && typeof res.grant === "object" && typeof res.grant.id === "string") {
        e.target.value = "";
        const total = Array.isArray(res.grant.origins) ? res.grant.origins.length : origins.length;
        saveFlash(
          `Allowed ${origins.length} origin${origins.length === 1 ? "" : "s"} (${total} allowed in total).`,
        );
      } else {
        saveFlash("Could not allow those origins: " + (res?.error ?? "no valid origin") + ".");
      }
      await syncBrowserGrantState();
    });
  }
}

export async function renderActionPolicy(ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const select = $("#destructive-policy");
  if (!select) return;
  const s = await storage.get(DESTRUCTIVE_POLICY_KEY);
  select.value = s?.[DESTRUCTIVE_POLICY_KEY] === "never" ? "never" : "ask";
  const key = panelCtx.root ?? panelCtx;
  if (!policyWired.has(key)) {
    policyWired.add(key);
    panelCtx.registerCleanup(() => policyWired.delete(key));
    select.addEventListener("change", async (e) => {
      const value = e.target.value === "never" ? "never" : "ask";
      const res = await storage.set({ [DESTRUCTIVE_POLICY_KEY]: value });
      if (res?.error) {
        saveFlash("Action policy save failed — " + res.error);
        return;
      }
      saveFlash(
        value === "never"
          ? "Destructive browser actions are now blocked."
          : "Destructive browser actions will always ask.",
      );
    });
  }
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  await renderBrowser();
  await renderActionPolicy();
  return {
    refresh: async () => {
      await renderBrowser();
      await renderActionPolicy();
    },
    unmount: makeUnmount(panelCtx),
  };
}
