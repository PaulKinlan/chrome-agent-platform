// User-facing Site Agent and tool-discovery language.
//
// Keep runtime terms such as WebMCP, script injection, and page reports in the
// dedicated diagnostics surface. Basic rows and transient status announcements
// use this vocabulary so implementation details cannot displace the user's task.

export const SITE_AGENT_COPY = Object.freeze({
  findToolsAction: "Find site tools",
  pickerTitle: "Find tools for a Site Agent",
  pickerHint:
    "Choose a tab to find the tools that site makes available. Only the site you choose gets access.",
  diagnosticsEmpty:
    "No diagnostics yet. Add a Site Agent above, then open or reload its site to find available tools.",
});

function siteLabel(origin) {
  return typeof origin === "string" && origin.trim() ? origin.trim() : "this site";
}

/** Concise status for owner-driven Site Agent setup. Raw runtime errors are
 * intentionally not accepted here; bounded technical errors remain available
 * in Settings → Site Agent diagnostics. */
export function siteAgentSetupMessage(state, origin = "") {
  const site = siteLabel(origin);
  switch (state) {
    case "tabs-denied":
      return "Tabs permission wasn't granted. Grant it to choose a tab and find site tools.";
    case "list-failed":
      return "Open tabs aren't available right now. Try again.";
    case "no-tabs":
      return "No open web tabs are available. Open a site in a tab, then try again.";
    case "permission-error":
      return `Chrome couldn't request access for ${site}. Try again.`;
    case "permission-denied":
      return `Site access wasn't granted for ${site}. No Site Agent was added.`;
    case "checking":
      return `Site Agent added for ${site}. Finding available tools…`;
    case "reload":
      return `Site Agent added for ${site}, but its tools aren't available yet. Reload the selected tab, then try again.`;
    case "reload-tabs":
      return `Site Agent added for ${site}, but some open tabs were not fully injected. Reload those tabs, then try again.`;
    case "failed-now":
      return `Couldn't add a Site Agent for ${site}. Registration or injection failed; check Site Agent diagnostics for the bounded error.`;
    case "next-load":
      return `Site Agent added for ${site}. Available tools will appear after you open or reload the site.`;
    case "failed":
    default:
      return `Couldn't add a Site Agent for ${site}. Try again.`;
  }
}

/** Empty/error copy for a Site Agent's available-tool list. */

/** Map the SW's authoritative enroll-origin response to the setup state.
 * Branch FIRST on the attested script lifecycle: a top-level injection-error /
 * registration failure is a FAILURE even when targets is 0 (the scripts never
 * ran) — never "next-load". Then: full injection into the open tabs → checking;
 * a partial/mixed injection → reload-tabs (Settings is multi-tab — no single
 * "selected tab" wording); no open tabs with a clean registration → next-load. */
export function enrollOutcomeState(res, { selectedTab = false } = {}) {
  const inj = res?.injection;
  const scriptStatus = String(inj?.scriptStatus ?? "");
  const error = res?.error ?? inj?.error ?? "";
  // ERROR-FIRST: branch on the attested lifecycle before any injection shape.
  if (!res?.ok) return "failed";
  if (scriptStatus === "injection-error" || scriptStatus === "no-scripting-permission" || error) {
    return "failed";
  }
  const targets = inj?.targets ?? 0;
  const partial = res?.injectionPartial === true ||
    (targets > 0 && ((inj?.partial?.length ?? 0) + (inj?.failed?.length ?? 0)) > 0);
  if (targets === 0) return "next-load";
  if (partial) {
    // The NTP picker HAS a selected tab → the selected-tab recovery wording;
    // Settings is multi-tab → the reload-tabs wording.
    return selectedTab ? "reload" : "reload-tabs";
  }
  return "checking";
}

export function siteAgentToolsMessage(state) {
  switch (state) {
    case "not-added":
      return "No Site Agent for this site yet. Add a Site Agent to find the tools it makes available.";
    case "empty":
      return "No tools are available from this Site Agent yet. Reload the site, then try again.";
    case "error":
    default:
      return "Site Agent tools aren't available right now. Try again.";
  }
}
