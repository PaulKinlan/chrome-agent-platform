#include <emscripten.h>

// Deliberately unsafe control. The safe factories must reject this Wasm import
// before this function can execute. Only its matching test-only control glue
// implements the import, demonstrating why a Worker alone is not confinement.
EM_JS(int, cap_attempt_browser_authority, (), {
  const state = {
    network: "not-attempted",
    storage: "not-attempted",
    worker: "not-attempted",
  };
  const tasks = [];

  state.network = "attempted";
  tasks.push(fetch("https://cap-native-authority.invalid/escape", {
    credentials: "omit",
  }).then(
    () => { state.network = "unexpectedly-delivered"; },
    () => { state.network = "blocked"; },
  ));

  state.storage = "attempted";
  tasks.push(navigator.storage.getDirectory().then(
    () => { state.storage = "opened"; },
    error => { state.storage = `failed:${error?.name || "Error"}`; },
  ));

  state.worker = "attempted";
  tasks.push(new Promise(resolve => {
    try {
      const child = new Worker(new URL("authority-child.mjs", globalThis.location.href), {
        type: "module",
      });
      const finish = value => {
        state.worker = value;
        child.terminate();
        resolve();
      };
      child.onmessage = event => finish(event.data === "authority-child-ready" ? "started" : "unexpected-message");
      child.onerror = () => finish("failed:Error");
    } catch (error) {
      state.worker = `failed:${error?.name || "Error"}`;
      resolve();
    }
  }));

  globalThis.__capAuthorityProbePromise = Promise.allSettled(tasks).then(() => state);
  return 0x434150;
});

EMSCRIPTEN_KEEPALIVE
int cap_run_authority_attempt(void) {
  return cap_attempt_browser_authority();
}
