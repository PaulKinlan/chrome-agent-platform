// Global `process` shim for the service-worker bundle (agent-do / AI SDK
// reference process.env / process.browser etc.; there is no Node in a worker).
if (typeof globalThis.global === "undefined") {
  globalThis.global = globalThis;
}
if (typeof globalThis.process === "undefined") {
  globalThis.process = {
    env: {},
    browser: true,
    version: "v20.0.0",
    versions: { node: "20.0.0" },
    platform: "browser",
    nextTick: (fn, ...a) => Promise.resolve().then(() => fn(...a)),
    cwd: () => "/",
    on: () => {},
    once: () => {},
    emit: () => false,
    listeners: () => [],
    removeListener: () => {},
    removeAllListeners: () => {},
  };
}
