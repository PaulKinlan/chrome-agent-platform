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

const statementEl = document.getElementById("statement");
const status = document.getElementById("status");

function show(statement) {
  if (statementEl) statementEl.statement = statement;
}

async function main() {
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
