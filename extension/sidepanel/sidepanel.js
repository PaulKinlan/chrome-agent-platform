// sidepanel/sidepanel.js — the driven-page surface + morph stub.

import { send } from "../lib/messages.js";

const frame = document.getElementById("frame");
const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");

function go() {
  let url = urlInput.value.trim();
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  try {
    frame.src = url;
    statusEl.textContent = "Loaded " + url + " — agent may drive it via WebMCP.";
    // Let the agent record the origin.
    send("tools.allOrigins");
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
  }
}

document.getElementById("go").addEventListener("click", go);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

document.getElementById("morph").addEventListener("click", () => {
  // Stub: the morph melds 2-3 sites in the side panel via stacked iframes.
  // Seam documented in docs/DESIGN.md §2.6; real merge comes in a later pass.
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

go();
