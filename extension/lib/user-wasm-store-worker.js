// Dedicated storage Worker, NOT a Wasm executor. File uses structured clone;
// bytes never pass through Chrome runtime messaging or a whole-file buffer.
import { createOwnerBlobStore } from "./user-wasm-store.js";

const store = createOwnerBlobStore();
self.onmessage = async ({ data }) => {
  try {
    let result;
    if (data?.operation === "put") {
      let lastProgress = -Infinity;
      result = await store.put(data.payload, { onProgress(bytes, total) {
        const now = performance.now();
        if (now - lastProgress >= 100 || bytes === total) {
          lastProgress = now;
          self.postMessage({ progress: { bytes, total } });
        }
      } });
    } else if (data?.operation === "list") {
      result = await store.list();
    } else if (data?.operation === "remove") {
      await store.remove(data.payload?.digest);
      result = null;
    } else {
      throw new Error("Unknown storage operation");
    }
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } });
  }
};
