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
  // The composer chip BEFORE the one-time scripting grant: pages cannot report
  // their tools until the extension may look, so the chip names that click.
  checkOpenPages: "Check open pages for site tools",
  checkOpenPagesName:
    "Check open pages for site tools — lets the extension look for tools on pages you have open",
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
      return "The tabs permission is optional — enable it in Settings → Permissions if the tab list is hidden and try again.";
    case "scripting-denied":
      return "Finding site tools needs the scripting permission to verify open pages — allow it when prompted, then try again.";
    case "list-failed":
      return "Open tabs aren't available right now. Try again.";
    case "no-tabs":
      return "No pages with site tools are open. Open a page that exposes site tools, then try again.";
    case "permission-error":
      return `Site access couldn't be verified for ${site}. Reload the page, then try again.`;
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

// ── The composer chip: "<host> offers N tools — use them?" ───────────────────
// (CAP-FB-20260825-SITE-AGENT-SHOWCASE-01.) The hub reads the SW's
// permission-free `agent.tool-offers` rows (open tabs whose passive detector
// reported tools, intersected with the browser's current tab list) and offers
// ONE of them above the composer. The projection is pure so the enrolled
// filter can be falsified: an origin that is already a Site Agent must never
// be offered again.

/** The host a person recognises: scheme and path stripped. Untrusted — render
 * it with textContent / escaping only. */
export function siteOfferHost(origin) {
  return String(origin ?? "").replace(/^https?:\/\//, "").replace(/\/.*/, "");
}

/** Pick the chip's offer from the `agent.tool-offers` rows: the most-recently
 * used open tab that reports at least one tool and whose origin is NOT
 * enrolled (neither by the SW's `enrolled` flag nor by the hub's own
 * directory listing). Returns null when there is nothing honest to offer. */
export function selectSiteOffer(rows, enrolledOrigins = []) {
  const enrolled = new Set(
    Array.from(enrolledOrigins ?? [], (o) => String(o ?? "")).filter(Boolean),
  );
  const candidates = (Array.isArray(rows) ? rows : []).filter((row) =>
    row && typeof row.origin === "string" && row.origin &&
    Number.isFinite(row.toolCount) && row.toolCount > 0 &&
    row.enrolled !== true && !enrolled.has(row.origin)
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return candidates[0];
}

function toolCountPhrase(count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `${n} ${n === 1 ? "tool" : "tools"}`;
}

/** "<host> offers N tools — use them?" — the chip's visible text. */
export function siteOfferLabel(offer) {
  const n = Number.isFinite(offer?.toolCount) ? Math.floor(offer.toolCount) : 0;
  return `${siteOfferHost(offer?.origin)} offers ${toolCountPhrase(n)} — use ${n === 1 ? "it" : "them"}?`;
}

/** "Using <host> · N tools" — the chip after the owner's one click enrolled
 * that exact tab. */
export function siteUsingLabel(offer) {
  return `Using ${siteOfferHost(offer?.origin)} · ${toolCountPhrase(offer?.toolCount)}`;
}

/** The chip's state from the SW's `agent.tool-offers` response:
 *   { kind: "offer", offer }   — a detected, unenrolled page (the one click
 *                                grants that origin and enrolls that tab);
 *   { kind: "check", tabs }    — nothing can be detected yet because the
 *                                one-time `scripting` grant is missing, and
 *                                there are open http(s) pages to check (the
 *                                one click grants scripting, nothing else);
 *   null                       — nothing honest to offer.
 * An offer always wins over a check. */
export function selectSiteOfferState(response, enrolledOrigins = []) {
  if (!response || response.ok !== true) return null;
  const offer = selectSiteOffer(response.offers, enrolledOrigins);
  if (offer) return { kind: "offer", offer };
  const tabs = Number.isFinite(response.candidateTabs) ? Math.max(0, Math.floor(response.candidateTabs)) : 0;
  if (response.needScripting === true && tabs > 0) return { kind: "check", tabs };
  return null;
}

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

/** Structured view-model for the hub's WebMCP discovery status card
 * (CAP-FB-20260824-SITE-AGENTS-STATUS-01). Pure: maps the SW status record to
 * labeled rows so the renderer NEVER flattens them into a run-on " · " string.
 * `state` classifies the SW-ATTESTED script lifecycle: an in-flight refresh
 * ("refreshing": registered/injection-partial) is DISTINCT from a live
 * injection ("active": injected), a failure ("failed"), and the not-run
 * states ("none"). `reportStale` is an INDEPENDENT marker: the page-reported
 * counts PREDATE the latest script lifecycle event (the page may have changed
 * since) — the two signals are rendered distinctly, never merged. */
export function formatWebmcpHubStatus(s) {
  if (!s || typeof s !== "object") return null;
  const origin = typeof s.origin === "string" && s.origin.trim() ? s.origin.trim() : "this site";
  const scriptStatus = typeof s.scriptStatus === "string" ? s.scriptStatus : "none";
  const state =
    scriptStatus === "registered" || scriptStatus === "injection-partial"
      ? "refreshing"
      : scriptStatus === "injected"
        ? "active"
        : scriptStatus === "injection-failed" || scriptStatus === "injection-error"
          ? "failed"
          : "none";
  const stateLabel = {
    refreshing: "Scripts refreshing…",
    active: "Scripts injected",
    failed: "Script problem",
    none:
      scriptStatus === "no-open-tabs"
        ? "No open tabs"
        : scriptStatus === "no-scripting-permission"
          ? "No scripting permission"
          : "Scripts not run",
  }[state];
  const scriptAt =
    Number.isFinite(s.scriptStatusAt) && s.scriptStatusAt > 0 ? s.scriptStatusAt : null;
  const r = s.lastReport && typeof s.lastReport === "object" ? s.lastReport : null;
  const report = r
    ? {
        toolCount: Number.isFinite(r.toolCount) ? r.toolCount : 0,
        declaredCount: Number.isFinite(r.declaredCount) ? r.declaredCount : 0,
        inferredCount: Number.isFinite(r.inferredCount) ? r.inferredCount : 0,
        at: Number.isFinite(r.at) && r.at > 0 ? r.at : null,
      }
    : null;
  const reportStale =
    report !== null && report.at !== null && scriptAt !== null && report.at < scriptAt;
  return Object.freeze({
    origin,
    state,
    stateLabel,
    scriptStatus,
    scriptAt,
    report: report ? Object.freeze(report) : null,
    reportStale,
  });
}
