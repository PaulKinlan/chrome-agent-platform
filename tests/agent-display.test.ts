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

Deno.test("Settings lists only enabled background agents; task navigation still includes stopped schedules", async () => {
  const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assertEquals(options.includes("const existingBackground = background.filter((agent) => agent.enabled === true)"), true);
  assertEquals(options.includes("renderBackgroundAgentPicker(background.filter((agent) => agent.enabled !== true))"), true);
  assertEquals(ntp.includes("backgroundAgentsForDisplay(background, { activeOnly: true })"), true);
  assertEquals(ntp.includes("const navigation = projectUnifiedAgents(agents, background)"), true);
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
