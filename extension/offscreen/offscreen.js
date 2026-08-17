// offscreen/offscreen.js — the SINGLETON execution host for agent-generated
// scripts on SCHEDULED runs (Paul 2026-08-17). The service worker cannot create
// DOM, so it opens this offscreen document (the production host) which spins up
// an opaque sandboxed iframe per run via the shared lib/script-host.js. The
// on-demand path (the user on the NTP) uses the SAME shared host registered in
// the NTP page — whichever host is open answers the SW's runtime message.

import { handleScriptRunMessage } from "../lib/script-host.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
  handleScriptRunMessage(message, sendResponse)
);
