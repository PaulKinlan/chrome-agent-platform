// Alarm scheduler (agent-do pattern): the agent registers future tasks.
// Stub — chrome.alarms wiring + resume hook.

export function registerAlarm(task) {
  const { name, when, periodInMinutes } = task;
  const info = { when: Date.now() + (when ?? 0) };
  if (periodInMinutes) info.periodInMinutes = periodInMinutes;
  chrome.alarms.create(name, info);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // TODO(agent-core): load the agent's memory, resume context, run the task,
  // and respond via a notification / side-panel update.
  console.log("alarm fired", alarm.name);
});
