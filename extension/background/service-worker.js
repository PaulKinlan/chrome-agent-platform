// Background service worker: alarm scheduler + agent-core bootstrap.
// Stub — the alarm registration + agent resume primitives (agent-do/chaos pattern).

import { registerAlarm, onAlarm } from "./alarms.js";

// The agent core is imported lazily; this stub establishes the message contract.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "register-task":
      registerAlarm(message.task);
      sendResponse({ ok: true });
      break;
    case "run-task":
      // TODO(agent-core): resume the agent context and execute.
      sendResponse({ ok: true, note: "agent-core not wired (scaffold)" });
      break;
    default:
      sendResponse({ ok: false, error: "unknown message" });
  }
  return true;
});
