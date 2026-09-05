// Settings-only client for the packaged storage Worker. No caller-supplied
// script URL, no data-size deadline, no runtime-message/JSON binary transport.
export function runUserWasmStore(operation, payload, onProgress) {
  const expected = new URL(chrome.runtime.getURL("options/options.html"));
  const current = new URL(location.href);
  if (current.protocol !== expected.protocol || current.host !== expected.host || current.pathname !== expected.pathname) {
    return Promise.reject(new Error("Uploaded files can only be managed in Settings"));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL("lib/user-wasm-store-worker.js"), { type: "module" });
    function finish(error, value) {
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    }
    worker.onmessage = ({ data }) => {
      if (data?.progress) { onProgress?.(data.progress); return; }
      if (data?.ok === true) finish(null, data.result);
      else {
        const error = new Error(data?.error?.message ?? "Storage worker failed");
        error.name = data?.error?.name ?? "Error";
        finish(error);
      }
    };
    worker.onerror = (event) => finish(new Error(event.message || "Storage worker could not start"));
    worker.onmessageerror = () => finish(new Error("Storage worker response could not be read"));
    try { worker.postMessage({ operation, payload }); }
    catch (error) { finish(error); }
  });
}
