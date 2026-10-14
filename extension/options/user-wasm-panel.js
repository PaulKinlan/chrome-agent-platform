import { confirmActionDialog } from "../shared/components-core.js";

// Keep the reviewed Worker constructor in its canonical packaged source file,
// not duplicated inside the options bundle (same pattern as the runtime hosts).
async function runUserWasmStore(...args) {
  const client = await import(chrome.runtime.getURL("dist/user-wasm-store-client.bundle.js"));
  return await client.runOwnerBlobStore(...args);
}

const mounted = new WeakMap();

export async function mountUserWasmPanel(panel) {
  if (!panel) return null;
  if (mounted.has(panel)) {
    const existing = mounted.get(panel);
    await existing.refresh();
    return existing;
  }
  function failure(error) {
    panel.setStatus?.(`${error.name}: ${error.message}. Refresh the list to check what is saved, then try again.`, true);
  }
  async function refresh() {
    panel.busy = true;
    panel.setStatus?.("Loading saved files…");
    try {
      panel.records = await runUserWasmStore("list");
      panel.setStatus?.("");
    } catch (error) { failure(error); }
    finally { panel.busy = false; }
  }
  const onUpload = async ({ detail }) => {
    panel.busy = true;
    panel.setStatus?.("Writing your file locally. Keep Settings open until it is saved.");
    try {
      const saved = await runUserWasmStore("put", detail, ({ bytes, total }) => {
        panel.setStatus?.(`Writing ${bytes.toLocaleString()} of ${total.toLocaleString()} bytes… Keep Settings open.`);
      });
      panel.records = await runUserWasmStore("list");
      panel.clearForm?.();
      panel.setStatus?.(`Saved “${saved.name}” locally${saved.replaced ? ` — replaced “${saved.previousName}”` : ""}. Saving does not run it.`);
    } catch (error) { failure(error); }
    finally { panel.busy = false; }
  };
  const onRemove = async ({ detail }) => {
    const confirmed = await confirmActionDialog({
      title: `Remove “${detail.name}”?`,
      body: "This deletes the saved file and its name and description from this browser. Your original file is not changed.",
      confirmLabel: "Remove file", destructive: true, returnFocusTo: panel,
    });
    if (!confirmed) return;
    panel.busy = true;
    panel.setStatus?.("Removing saved file…");
    try {
      await runUserWasmStore("remove", { digest: detail.digest });
      panel.records = await runUserWasmStore("list");
      panel.setStatus?.(`Removed “${detail.name}”.`);
    } catch (error) { failure(error); }
    finally { panel.busy = false; panel.focusAfterRemove?.(); }
  };
  panel.addEventListener("user-wasm-refresh", refresh);
  panel.addEventListener("user-wasm-upload", onUpload);
  panel.addEventListener("user-wasm-remove", onRemove);
  const unmount = () => {
    panel.removeEventListener("user-wasm-refresh", refresh);
    panel.removeEventListener("user-wasm-upload", onUpload);
    panel.removeEventListener("user-wasm-remove", onRemove);
    mounted.delete(panel);
  };
  const handle = { refresh, unmount };
  mounted.set(panel, handle);
  await refresh();
  return handle;
}
