// ISOLATED-world relay for the detection-only MAIN probe. The page controls
// its own capabilities; Chrome's MessageSender remains the origin authority.
(() => {
  const CHANNEL = "__cap_webmcp_detect";
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || !data || data[CHANNEL] !== 1 || data.type !== "snapshot") return;
    const toolCount = Math.min(200, Math.max(0, Math.floor(Number(data.toolCount) || 0)));
    chrome.runtime.sendMessage({
      type: "webmcp.detected",
      origin: location.origin,
      url: location.href,
      toolCount,
    }).catch(() => {});
  });
})();
