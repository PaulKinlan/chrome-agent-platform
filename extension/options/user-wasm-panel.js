import { confirmActionDialog } from "../shared/components.js";

// Keep the reviewed Worker constructor in its canonical packaged source file,
// not duplicated inside the options bundle (same pattern as the runtime hosts).
async function runUserWasmStore(...args) {
  const client = await import(chrome.runtime.getURL("lib/user-wasm-store-client.js"));
  return await client.runUserWasmStore(...args);
}

const mounted = new WeakMap();

export async function mountUserWasmPanel(panel) {
  if (!panel) return;
  if (mounted.has(panel)) return await mounted.get(panel)();
  function failure(error) {
    panel.setStatus(`${error.name}: ${error.message}. Refresh the list to check what is saved, then try again.`, true);
  }
  async function refresh() {
    panel.busy = true;
    panel.setStatus("Loading saved files…");
    try {
      panel.records = await runUserWasmStore("list");
      panel.setStatus("");
    } catch (error) { failure(error); }
    finally { panel.busy = false; }
  }
  mounted.set(panel, refresh);
  panel.addEventListener("user-wasm-refresh", refresh);
  panel.addEventListener("user-wasm-upload", async ({ detail }) => {
    panel.busy = true;
    panel.setStatus("Writing your file locally. Keep Settings open until it is saved.");
    try {
      const saved = await runUserWasmStore("put", detail, ({ bytes, total }) => {
        panel.setStatus(`Writing ${bytes.toLocaleString()} of ${total.toLocaleString()} bytes… Keep Settings open.`);
      });
      panel.records = await runUserWasmStore("list");
      panel.clearForm();
      panel.setStatus(`Saved “${saved.name}” locally. Uploading does not run it.`);
    } catch (error) { failure(error); }
    finally { panel.busy = false; }
  });
  panel.addEventListener("user-wasm-remove", async ({ detail }) => {
    const confirmed = await confirmActionDialog({
      title: `Remove “${detail.name}”?`,
      body: "This deletes the saved file and its name and description from this browser. Your original file is not changed.",
      confirmLabel: "Remove file", destructive: true, returnFocusTo: panel,
    });
    if (!confirmed) return;
    panel.busy = true;
    panel.setStatus("Removing saved file…");
    try {
      await runUserWasmStore("remove", { digest: detail.digest });
      panel.records = await runUserWasmStore("list");
      panel.setStatus(`Removed “${detail.name}”.`);
    } catch (error) { failure(error); }
    finally { panel.busy = false; panel.focusAfterRemove(); }
  });
  await refresh();
}
