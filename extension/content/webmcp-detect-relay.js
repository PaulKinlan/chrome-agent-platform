// ISOLATED-world relay for the detection-only MAIN probe. The per-document
// key arrives through chrome.runtime and never crosses the page-visible channel.
(() => {
  const CHANNEL = "__cap_webmcp_detect";
  const encoder = new TextEncoder();
  const subtle = crypto.subtle;
  let nonce = null;
  let armed = false;
  let lastSequence = -1;
  let messages = Promise.resolve();

  async function sign(value) {
    const key = await subtle.importKey(
      "raw",
      encoder.encode(nonce),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = new Uint8Array(await subtle.sign("HMAC", key, encoder.encode(value)));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || !data || data[CHANNEL] !== 1) return;
    messages = messages.then(async () => {
      if (
        !nonce || data.type !== "snapshot" ||
        !Number.isInteger(data.seq) || data.seq <= lastSequence || data.seq > 1e9 ||
        !Number.isInteger(data.toolCount) || data.toolCount < 0 || data.toolCount > 200 ||
        typeof data.tag !== "string" ||
        data.tag !== await sign(`detect|${data.seq}|${data.toolCount}`)
      ) return;
      lastSequence = data.seq;
      chrome.runtime.sendMessage({
        type: "webmcp.detected",
        origin: location.origin,
        url: location.href,
        toolCount: data.toolCount,
      }).catch(() => {});
    }).catch(() => {});
  });

  function arm() {
    chrome.runtime.sendMessage({
      type: "webmcp.detect.arm",
      origin: location.origin,
    }).then((result) => {
      armed = result?.ok === true;
    }).catch(() => {});
  }

  function bootstrap() {
    chrome.runtime.sendMessage({
      type: "webmcp.detect.bootstrap",
      origin: location.origin,
    }).then((result) => {
      if (typeof result?.nonce !== "string" || result.nonce.length < 16) return;
      nonce = result.nonce;
      lastSequence = -1;
      arm();
    }).catch(() => {});
  }
  bootstrap();
  for (const delay of [50, 250, 1000]) setTimeout(() => {
    if (!nonce) bootstrap();
    else if (!armed) arm();
  }, delay);

  // The arm needs chrome.scripting — an OPTIONAL permission the owner grants
  // JIT from the hub's Discover gesture. When that grant lands the SW nudges
  // every open tab to retry: bootstrap if the nonce never arrived, arm if it
  // did. Without this, pages open before the grant stay undetectable until a
  // reload, and the fresh-profile picker could never list them.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "webmcp.detect.rearm") return;
    if (!nonce) bootstrap();
    else if (!armed) arm();
  });
})();
