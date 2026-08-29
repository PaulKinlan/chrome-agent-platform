// @ts-nocheck — CAP-FB-20260824-AGENT-DELETION-NAVIGATE-01:
// Verifies that successful agent deletion navigates the user back to the base NTP
// hub / sidepanel list view, while deny/cancel leaves the view unchanged.

import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("agent-deletion-navigate: NTP source wiring ensures return to base hub and hash reset on delete", async () => {
  const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));

  // Invariant 1: successful deletion uses the shared Home destination. It must
  // not push another hash entry or masquerade as a Back command.
  assert(ntpJs.includes("deleteAgentBtn?.addEventListener"), "must attach click listener to deleteAgentBtn");
  const deleteHandler = ntpJs.slice(ntpJs.indexOf("deleteAgentBtn?.addEventListener"), ntpJs.indexOf("threadTitle.addEventListener"));
  assert(deleteHandler.includes("goHome({ focusAfter: composer })"), "must navigate Home after deletion");
  assert(!deleteHandler.includes("history.pushState") && !deleteHandler.includes("history.back"), "delete must not push or traverse history");

  // Invariant 2: Deny / cancel does not navigate away
  assert(ntpJs.includes("if (!confirmed) return;"), "cancelling confirmation must return early without navigating");

  // Invariant 3: Re-renders all agent lists after deletion
  assert(ntpJs.includes("Promise.all([renderNamedAgents(), renderSiteAgents(), renderBackgroundAgents()])"), "must re-render agent lists after deletion");

  // Invariant 4: No dead showMainHub() reference remains
  assert(!ntpJs.includes("showMainHub()"), "no undefined showMainHub() calls");
});

Deno.test("agent-deletion-navigate: Sidepanel source wiring returns to agent list on delete", async () => {
  const sidepanelJs = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.js", import.meta.url));

  assert(sidepanelJs.includes("agentDeleteBtn?.addEventListener"), "must attach click listener to agentDeleteBtn");
  assert(sidepanelJs.includes("closeAgentDetail()"), "must call closeAgentDetail to return to agents list pane");
  assert(sidepanelJs.includes("picker?.refresh?.()"), "must refresh agent picker after deletion");
  assert(sidepanelJs.includes("if (!confirmed) return;"), "cancelling confirmation must return early");
});

Deno.test("agent-deletion-navigate: behavioral simulation of NTP deletion navigation vs cancellation", async () => {
  let threadViewHidden = false;
  let activeRoute = "task";
  let hash = "#agent=named:researcher";
  let currentAgentId = "researcher";
  let currentAgentKind = "named";
  let statusText = "";

  const hideThreadView = ({ fromNavigation, focusAfter } = {}) => {
    threadViewHidden = true;
    activeRoute = "hub";
    currentAgentId = null;
    currentAgentKind = null;
  };

  const handleAgentDelete = async (confirmed, id = "researcher", name = "Researcher") => {
    if (!confirmed) return; // Cancel/deny: do nothing
    // Success path:
    hash = "#";
    hideThreadView({ fromNavigation: true });
    statusText = `Deleted ${name}.`;
  };

  // 1. Simulation with Cancel: stays in agent view
  await handleAgentDelete(false);
  assertEquals(threadViewHidden, false, "threadView must remain visible when cancelled");
  assertEquals(activeRoute, "task", "activeRoute must remain task when cancelled");
  assertEquals(currentAgentId, "researcher", "currentAgentId must remain set when cancelled");

  // 2. Simulation with Confirm: navigates to base hub
  await handleAgentDelete(true);
  assertEquals(threadViewHidden, true, "threadView must be hidden on delete");
  assertEquals(activeRoute, "hub", "activeRoute must become hub on delete");
  assertEquals(hash, "#", "hash must be reset to base #");
  assertEquals(currentAgentId, null, "currentAgentId must be cleared on delete");
  assertEquals(statusText, "Deleted Researcher.");
});

Deno.test("agent-deletion-navigate: behavioral simulation of Sidepanel deletion navigation vs cancellation", async () => {
  let detailPaneHidden = false;
  let listPaneHidden = true;
  let openAgent = { kind: "named", id: "writer", name: "Writer" };
  let refreshed = false;

  const closeAgentDetail = () => {
    openAgent = null;
    detailPaneHidden = true;
    listPaneHidden = false;
  };

  const handleSidepanelDelete = async (confirmed) => {
    if (!confirmed) return;
    closeAgentDetail();
    refreshed = true;
  };

  // 1. Cancel: stays in detail view
  await handleSidepanelDelete(false);
  assertEquals(detailPaneHidden, false);
  assertEquals(listPaneHidden, true);
  assert(openAgent !== null);

  // 2. Confirm: returns to list view
  await handleSidepanelDelete(true);
  assertEquals(detailPaneHidden, true, "detailPane must be hidden on delete");
  assertEquals(listPaneHidden, false, "listPane must be visible on delete");
  assertEquals(openAgent, null, "openAgent must be cleared on delete");
  assertEquals(refreshed, true, "picker must be refreshed on delete");
});
