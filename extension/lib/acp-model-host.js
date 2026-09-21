import { createAcpModel } from "./acp-model.js";

export function registerAcpModelHost(runtime = chrome.runtime, createModel = createAcpModel) {
  runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith("cap-acp-model:")) return;
    // Only the extension's service worker may mint a backend, not a page or
    // content script. A page cannot turn this offscreen host into a shell proxy.
    const sender = port.sender;
    if (sender?.id !== runtime.id || sender.tab || sender.url !== runtime.getURL("dist/background/service-worker.js")) {
      port.disconnect(); return;
    }
    let model, closed = false;
    const permissions = new Map();
    const close = () => {
      closed = true;
      model?.close();
      for (const resolve of permissions.values()) resolve(null);
      permissions.clear();
    };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(async (message) => {
      if (closed) return;
      try {
        if (message.type === "open" && !model) {
          model = createModel({ ...message.config, permissionHandler: (request) => new Promise((resolve) => {
            const id = crypto.randomUUID(); permissions.set(id, resolve);
            port.postMessage({type:"permission",id,request});
          }) });
        } else if (message.type === "permission-result") {
          permissions.get(message.id)?.(message.optionId); permissions.delete(message.id);
        } else if (message.type === "step" && model) {
          const response = await model.model.doStream(message.options);
          for await (const part of response.stream) {
            if (closed) break;
            port.postMessage({type:"part",part});
          }
        } else throw new Error("Invalid CAP backend message");
      } catch (error) {
        if (!closed) port.postMessage({type:"error",error:String(error?.message ?? error)});
        close();
      }
    });
  });
}
