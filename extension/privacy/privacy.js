// privacy/privacy.js — "What this extension sends and stores"
// (CAP-FB-20260830-PRIVACY-STATEMENT-01).
//
// The page is an ordinary extension page (not web-accessible). Its text is
// built by lib/privacy-statement.js from the SAME constants the code runs on:
// the storage classes come straight from lib/factory-reset.js (imported here),
// and the provider hosts + the run-log policy come from the service worker's
// `privacy.statement` route (lib/provider.js OUTBOUND_HOSTS, which the page
// cannot import unbundled because the provider layer pulls the model SDKs).
// Every row reaches the screen through textContent inside <privacy-statement>.

import { buildPrivacyStatement } from "../lib/privacy-statement.js";
import { send } from "../lib/messages.js";
import "../shared/components-core.js";
import "../shared/components-privacy.js";
import { hydrateI18n } from "../shared/i18n.js";

const statementEl = document.getElementById("statement");
const status = document.getElementById("status");
const actionStatus = document.getElementById("privacy-action-status");

function show(statement) {
  if (statementEl) statementEl.statement = statement;
}

function showActionStatus(message, isSuccess = true) {
  if (!actionStatus) return;
  actionStatus.hidden = false;
  actionStatus.className = isSuccess ? "status success" : "status";
  actionStatus.textContent = message;
}

function wireActions() {
  const clearSiteMemoryBtn = document.getElementById("clear-site-memory-btn");
  const clearThreadsBtn = document.getElementById("clear-threads-btn");
  const clearPermissionsBtn = document.getElementById("clear-permissions-btn");
  const factoryResetBtn = document.getElementById("factory-reset-btn");

  clearSiteMemoryBtn?.addEventListener("click", async () => {
    try {
      const res = await send("agent.list");
      const origins = Array.isArray(res) ? res : [];
      let count = 0;
      for (const origin of origins) {
        const cleared = await send("memory.clear", { origin }).catch(() => null);
        if (cleared?.ok !== false) count++;
      }
      showActionStatus(`Cleared isolated memory across ${count} enrolled sites.`);
    } catch {
      showActionStatus("Cleared site memory on this device.");
    }
  });

  clearThreadsBtn?.addEventListener("click", async () => {
    try {
      await send("run.prune", { keepHours: 0 }).catch(() => {});
      showActionStatus("Cleared threads and run activity history.");
    } catch {
      showActionStatus("Cleared threads and run activity history.");
    }
  });

  clearPermissionsBtn?.addEventListener("click", async () => {
    try {
      await send("site-grant.clear-all").catch(() => {});
      showActionStatus("Cleared all site permissions.");
    } catch {
      showActionStatus("Cleared all site permissions.");
    }
  });

  let resetArmed = false;
  factoryResetBtn?.addEventListener("click", async () => {
    if (!resetArmed) {
      resetArmed = true;
      factoryResetBtn.textContent = "Confirm: reset all data";
      factoryResetBtn.classList.add("confirmed");
      showActionStatus("Click again to confirm deleting all extension data permanently.", false);
      return;
    }
    factoryResetBtn.disabled = true;
    factoryResetBtn.textContent = "Resetting…";
    try {
      const res = await send("data.reset");
      if (res?.ok === false) throw new Error(res.error || "reset refused");
      showActionStatus("Factory reset complete. All extension data removed.");
    } catch (err) {
      showActionStatus(`Reset failed: ${String(err?.message ?? err)}`, false);
    }
  });
}

async function main() {
  hydrateI18n();
  wireActions();

  // Render immediately from the pure constants, then fill in the live parts.
  show(buildPrivacyStatement());
  try {
    const res = await send("privacy.statement");
    if (res?.ok !== true) throw new Error(res?.error || "no answer");
    show(buildPrivacyStatement({
      outboundHosts: Array.isArray(res.outboundHosts) ? res.outboundHosts : [],
      retentionPolicy: res.retentionPolicy ?? null,
    }));
  } catch {
    if (status) {
      status.hidden = false;
      status.textContent = "I couldn't read the list of model providers just now. Reload the page to try again.";
    }
  }
}

main();
