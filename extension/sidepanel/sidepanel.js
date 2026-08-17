// sidepanel/sidepanel.js — the driven-page surface.
//
// Cross-origin iframes cannot be driven (they're isolated + many sites block
// framing), so the real driven-page mechanism is: open the target page in a
// real tab (where the MAIN-world bridge + content script can discover and
// invoke its WebMCP tools), and drive it from there. The side panel shows a
// control + status surface AND the live WebMCP tool list for the driven origin;
// the iframe is retained only as a non-driving preview when the site permits
// framing.
//
// The AGENT can open this surface with the `open_side_panel` tool: it stores a
// target URL (sidepanel.getTarget) and this panel loads it on startup + shows
// the origin's discovered tools (sidepanel.getTools).

import { send } from "../lib/messages.js";

const frame = document.getElementById("frame");
const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");
const goBtn = document.getElementById("go");
const toolsEl = document.getElementById("tools");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

async function renderTools(origin) {
  if (!toolsEl) return;
  const res = await send("sidepanel.getTools", { origin });
  if (!res?.ok) {
    toolsEl.innerHTML = "";
    toolsEl.textContent = res?.error ?? "not enrolled";
    return;
  }
  const names = res.tools ?? [];
  toolsEl.innerHTML = "";
  if (!res.enrolled) {
    const row = document.createElement("div");
    row.className = "tool-row empty";
    row.textContent = "Not enrolled — the agent can enroll this origin to discover its tools.";
    toolsEl.append(row);
    return;
  }
  if (names.length === 0) {
    const row = document.createElement("div");
    row.className = "tool-row empty";
    row.textContent = "Enrolled · 0 WebMCP tools discovered yet.";
    toolsEl.append(row);
    return;
  }
  for (const name of names) {
    const row = document.createElement("div");
    row.className = "tool-row";
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.textContent = name;
    row.append(chip);
    toolsEl.append(row);
  }
}

async function go() {
  let url = urlInput.value.trim();
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  let parsed;
  try { parsed = new URL(url); } catch { setStatus("Invalid URL", true); return; }

  // Open the page in a real tab so the content-script bridge can drive it.
  let tab;
  try {
    tab = await chrome.tabs.create({ url });
  } catch (e) {
    setStatus("Could not open tab: " + String(e?.message ?? e), true);
    return;
  }

  // Preview in the panel only if the site permits framing; never claim the
  // panel drives it — driving happens in the tab via the MAIN-world bridge.
  frame.src = url;
  setStatus(`Opened ${parsed.origin} in a tab (tab ${tab.id}). The agent drives it there via WebMCP.`);

  // Record the origin so the hub can enroll it.
  send("tools.allOrigins").catch(() => {});
  // Show the origin's discovered WebMCP tools.
  renderTools(parsed.origin);
}

goBtn.addEventListener("click", go);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

document.getElementById("morph").addEventListener("click", () => {
  setStatus("Morph (double-iframe meld) is a documented seam — not wired yet.");
});

// On load: if the AGENT opened this panel (open_side_panel stored a target),
// load that target + show its tools.
(async function boot() {
  try {
    const res = await send("sidepanel.getTarget");
    if (res?.url) {
      urlInput.value = res.url;
      await go();
    }
  } catch { /* the panel also works standalone */ }
})();

// A page-origin navigate message (the agent re-targeting an open panel): load
// the URL + refresh the tool list. This is a READ of a URL the agent chose; it
// does NOT create a tab outside the browser-tool grant path — the real tab open
// still goes through go() → chrome.tabs.create only after the user/agent grants
// browser control via the authoritative open_tab/navigate_tab routes.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "sidepanel.navigate" && typeof message.url === "string") {
    urlInput.value = message.url;
    go();
    return;
  }
});

// NOTE: there is deliberately NO runtime.onMessage "navigate" listener that
// blindly calls chrome.tabs.create on a {type:"navigate",url} message. The wider-
// goal review found that earlier path let a content script open tabs outside the
// authoritative browser-tool path. Agent-driven navigation must go through the
// service worker's `open_tab` route (sender-authenticated + grant/origin/run-
// fenced). The side panel's own `go` button + URL input (a user gesture on THIS
// surface) + the agent's open_side_panel/`sidepanel.navigate` target-load remain
// the only local open paths.

// Set the side panel for the active tab so it can be opened from the hub.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
