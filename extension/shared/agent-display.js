// Pure display helpers for surfaces that show agents. Every agent surface
// (Settings, the hub Agents panel, the hub sidebar, the side panel) shows the
// SAME set — named agents plus ENABLED background agents (`activeOnly`). A
// disabled recipe is a template, not an agent: it stays reachable through the
// create dialog and Settings' "Configure" picker (the un-filtered list is for
// those template pickers only). Execution pickers use agent-registry.isCallable.

/** Return the background agents a display surface should show. */
export function backgroundAgentsForDisplay(agents = [], { activeOnly = false } = {}) {
  const rows = Array.isArray(agents) ? agents.filter(Boolean) : [];
  return activeOnly ? rows.filter((agent) => agent.enabled === true) : rows;
}

/** A short, plain-language marker shared by Settings and the task sidebar. */
export function agentScheduleMarker(agent) {
  const minutes = Number(agent?.schedule?.periodInMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return "On demand";
  const cadence = `every ${minutes} min`;
  return agent?.kind === "background" && agent?.enabled !== true
    ? `Schedule off · ${cadence}`
    : `Scheduled · ${cadence}`;
}
