// Pure display helpers for surfaces that show agents. Display lists are not
// callability filters: Settings and the task sidebar include disabled scheduled
// agents, while execution pickers continue to use agent-registry.isCallable.

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
