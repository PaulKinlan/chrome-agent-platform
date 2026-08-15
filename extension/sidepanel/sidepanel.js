// sidepanel/sidepanel.js — the driven-page surface.
//
// Cross-origin iframes cannot be driven (they're isolated + many sites block
// framing), so the real driven-page mechanism is: open the target page in a
// real tab (where the MAIN-world bridge + content script can discover and
// invoke its WebMCP tools), and drive it from there. The side panel shows a
// control + status; the iframe is retained only as a non-driving preview when
// the site permits framing.

import { send } from "../lib/messages.js";

const frame = document.getElementById("frame");
const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");
const goBtn = document.getElementById("go");

async function go() {
  let url = urlInput.value.trim();
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  let parsed;
  try { parsed = new URL(url); } catch { statusEl.textContent = "Invalid URL"; return; }

  // Open the page in a real tab so the content-script bridge can drive it.
  let tab;
  try {
    tab = await chrome.tabs.create({ url });
  } catch (e) {
    statusEl.textContent = "Could not open tab: " + String(e?.message ?? e);
    return;
  }

  // Preview in the panel only if the site permits framing; never claim the
  // panel drives it — driving happens in the tab via the MAIN-world bridge.
  frame.src = url;
  statusEl.textContent = `Opened ${parsed.origin} in a tab (tab ${tab.id}). The agent drives it there via WebMCP.`;

  // Record the origin so the hub can enroll it.
  send("tools.allOrigins").catch(() => {});
}

goBtn.addEventListener("click", go);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

document.getElementById("morph").addEventListener("click", () => {
  statusEl.textContent = "Morph (double-iframe meld) is a documented seam — not wired yet.";
});

// Respond to a "navigate" instruction from the agent (background → sidepanel).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "navigate") {
    urlInput.value = message.url;
    go();
  }
});

// Set the side panel for the active tab so it can be opened from the hub.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
