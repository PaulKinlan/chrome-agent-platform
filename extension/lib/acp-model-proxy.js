// The SW keeps CAP execution authority; the offscreen document owns ACP I/O.
export function createAcpModelProxy(config, connect = (name) => chrome.runtime.connect({ name })) {
  const children = new Set();
  let port, controller, ended = false, abortCleanup = () => {};
  function close() {
    if (ended) return;
    ended = true; abortCleanup();
    for (const child of children) child.close();
    controller?.error(new Error("CAP harness connection closed")); controller = null;
    port?.disconnect();
  }
  const model = {
    specificationVersion: "v2", provider: "acp", modelId: config.harnessId, supportedUrls: {},
    async doStream(options) {
      if (ended) throw new Error("CAP harness connection closed");
      if (!port) {
        port = connect(`cap-acp-model:${crypto.randomUUID()}`);
        port.onDisconnect.addListener(close);
        port.onMessage.addListener((message) => {
          if (message.type === "permission") {
            Promise.resolve(config.permissionHandler(message.request)).then((optionId) => {
              if (!ended) port.postMessage({ type: "permission-result", id: message.id, optionId });
            }).catch(() => { if (!ended) port.postMessage({type:"permission-result",id:message.id,optionId:null}); });
          } else if (message.type === "error") {
            controller?.error(new Error(message.error)); controller = null; close();
          } else if (message.type === "part") {
            controller?.enqueue(message.part);
            if (message.part.type === "finish") { controller?.close(); controller = null; }
          }
        });
        port.postMessage({ type: "open", config: { url: config.url, cwd: config.cwd, harnessId: config.harnessId } });
      }
      abortCleanup();
      options.abortSignal?.addEventListener("abort", close, {once:true});
      abortCleanup = () => options.abortSignal?.removeEventListener("abort", close);
      if (options.abortSignal?.aborted) { close(); throw new DOMException("CAP run cancelled", "AbortError"); }
      const stream = new ReadableStream({ start(c) { controller = c; } });
      port.postMessage({type:"step", options:{prompt:options.prompt,tools:options.tools}});
      return {stream};
    },
  };
  return { model, modelId:config.harnessId, providerName:"acp", providerLane:"acp", close,
    fork() { const child=createAcpModelProxy(config,connect); children.add(child); return child; } };
}

/** An isolated, non-tool discovery backend. Always closes; no prompt is sent. */
export async function discoverAcpCommands(config, connect = (name) => chrome.runtime.connect({ name })) {
  const port = connect(`cap-acp-model:${crypto.randomUUID()}`);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Harness command discovery timed out. Check the bridge and try again.")), 20000);
      port.onDisconnect.addListener(() => reject(new Error("Harness command discovery disconnected. Check the bridge and try again.")));
      port.onMessage.addListener((message) => {
        if (message.type === "catalogue") resolve(message.catalogue);
        else if (message.type === "error") reject(new Error("Harness command discovery failed. Check the bridge working directory and authentication, then try again."));
        else if (message.type === "permission") port.postMessage({ type: "permission-result", id: message.id, optionId: null });
      });
      port.postMessage({ type: "open", config: { url: config.url, cwd: config.cwd, harnessId: config.harnessId } });
      port.postMessage({ type: "catalogue" });
    });
  } finally { clearTimeout(timer); port.disconnect(); }
}
