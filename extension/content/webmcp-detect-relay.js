// ISOLATED-world relay for the detection-only MAIN probe. The per-document
// key arrives through chrome.runtime and never crosses the page-visible channel.
(() => {
  const CHANNEL = "__cap_webmcp_detect";
  const auth = globalThis.CapBridgeAuth;
  let nonce = null;
  let lastSequence = -1;

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || !data || data[CHANNEL] !== 1) return;
    const opened = auth ? auth.open(nonce, "detect", lastSequence, data) : { ok: false };
    if (!opened.ok || opened.msg.type !== "snapshot") return;
    lastSequence = opened.seq;
    const toolCount = Math.min(200, Math.max(0, Math.floor(Number(opened.msg.toolCount) || 0)));
    chrome.runtime.sendMessage({
      type: "webmcp.detected",
      origin: location.origin,
      url: location.href,
      toolCount,
    }).catch(() => {});
  });

  function bootstrap() {
    chrome.runtime.sendMessage({
      type: "webmcp.detect.bootstrap",
      origin: location.origin,
    }).then((result) => {
      if (typeof result?.nonce !== "string" || result.nonce.length < 16) return;
      nonce = result.nonce;
      lastSequence = -1;
      return chrome.runtime.sendMessage({
        type: "webmcp.detect.arm",
        origin: location.origin,
      });
    }).catch(() => {});
  }
  bootstrap();
  for (const delay of [50, 250, 1000]) setTimeout(() => {
    if (!nonce) bootstrap();
  }, delay);
})();
