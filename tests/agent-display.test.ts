import {
  agentScheduleMarker,
  backgroundAgentsForDisplay,
} from "../extension/shared/agent-display.js";
import { projectUnifiedAgents } from "../extension/lib/named-agents.js";
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("agent display lists include disabled background agents unless explicitly active-only", () => {
  const agents = [
    { id: "running", enabled: true },
    { id: "stopped", enabled: false },
  ];
  assertEquals(backgroundAgentsForDisplay(agents).map((agent) => agent.id), ["running", "stopped"]);
  assertEquals(backgroundAgentsForDisplay(agents, { activeOnly: true }).map((agent) => agent.id), ["running"]);
});

Deno.test("agent schedule markers distinguish on-demand, running, and disabled schedules", () => {
  assertEquals(agentScheduleMarker({ kind: "named" }), "On demand");
  assertEquals(
    agentScheduleMarker({ kind: "named", schedule: { periodInMinutes: 30 } }),
    "Scheduled · every 30 min",
  );
  assertEquals(
    agentScheduleMarker({ kind: "background", enabled: false, schedule: { periodInMinutes: 60 } }),
    "Schedule off · every 60 min",
  );
});

Deno.test("sidebar projection: disabled background agents are excluded, enabled ones and named agents are kept", () => {
  // CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01: the hub sidebar, the hub
  // Agents panel, the side panel and Settings all show the SAME set — created
  // named agents plus ENABLED background agents. A disabled recipe is a
  // template, not an agent, and never appears as an agent row.
  const named = [{ id: "reader", name: "Reader", role: "reads articles" }];
  const background = [
    { id: "sorting-hat", name: "Sorting Hat", enabled: false, schedule: { periodInMinutes: 30 } },
    { id: "daily-summary", name: "Daily summary", enabled: true, schedule: { periodInMinutes: 1440 } },
  ];
  const rows = projectUnifiedAgents(named, backgroundAgentsForDisplay(background, { activeOnly: true }));
  assertEquals(rows.map((r) => r.id), ["reader", "daily-summary"]);
  assertEquals(rows.some((r) => r.id === "sorting-hat"), false);
});

Deno.test("every agent display surface uses the active-only projection (Settings, hub panel, hub sidebar, side panel)", async () => {
  const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const sidepanel = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.html", import.meta.url));
  assertEquals(options.includes("const existingBackground = background.filter((agent) => agent.enabled === true)"), true);
  // The disabled recipes stay reachable as templates through Settings' picker.
  assertEquals(options.includes("renderBackgroundAgentPicker(background.filter((agent) => agent.enabled !== true))"), true);
  assertEquals(ntp.includes("backgroundAgentsForDisplay(background, { activeOnly: true })"), true);
  // The sidebar receives the SAME active projection as the panel — no second
  // "navigation" projection that re-admits disabled templates.
  assertEquals(ntp.includes("const navigation = projectUnifiedAgents(agents, background)"), false);
  assertEquals(ntp.includes("renderSidebarAgents(active)"), true);
  // The side panel's Agents tab lists only callable agents (enabled background).
  assertEquals(/<agent-picker[^>]*\bcallable-only\b/.test(sidepanel), true);
});

Deno.test("Settings projects a same-id named/enabled-background collision as one management row", async () => {
  const named = { id: "sorting-hat", name: "Sorting Hat", role: "Named persona" };
  const background = { id: "sorting-hat", name: "Sorting Hat", enabled: true, schedule: { periodInMinutes: 30 } };
  const rows = projectUnifiedAgents([named], [background]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].namedAgent, named);
  assertEquals(rows[0].backgroundAgent, background);

  const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  assertEquals(options.includes("const unified = projectUnifiedAgents(named, existingBackground)"), true);
  assertEquals(options.includes("backgroundAgentRow(projected.backgroundAgent, row)"), true);
  assertEquals(options.includes("for (const agent of background) list.appendChild(backgroundAgentRow(agent))"), false);
});
