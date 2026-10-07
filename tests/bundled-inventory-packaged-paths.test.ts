import { assert, assertEquals } from "jsr:@std/assert@1";
import { createBundledInventory } from "../extension/lib/bundled-inventory.js";

// chrome-agent-platform-ltkj.2: inventory rel paths are repo-rooted
// ("extension/wasm/…") but the packaged extension serves assets from the
// extension root — defaultReadFile must strip the repo prefix before
// chrome.runtime.getURL. The loaded acceptance harness caught the unstripped
// version as a silently-empty validation list (every manifest fetch 404'd into
// the catch bucket). This pins the packaged-path mapping with a mock runtime.

Deno.test("bundled-inventory: defaultReadFile maps repo-rooted rels onto the packaged extension root", async () => {
  const fetched: string[] = [];
  const runtime = {
    getURL: (p: string) => `chrome-extension://id/${p}`,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetched.push(String(input));
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }));
  }) as typeof fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).chrome = { runtime };
  try {
    const inv = createBundledInventory();
    const bytes = await inv.readFile("extension/wasm/manifests/cap.bundled.awk-1.0.0.manifest.json");
    assertEquals(fetched, ["chrome-extension://id/wasm/manifests/cap.bundled.awk-1.0.0.manifest.json"],
      "the extension/ repo prefix must be stripped — the packaged root serves /wasm/…");
    assert(bytes instanceof ArrayBuffer || bytes instanceof Uint8Array, "bytes come back");
  } finally {
    globalThis.fetch = originalFetch;
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).chrome;
  }
});

Deno.test("bundled-inventory: a non-fetchable packaged path still fails loud (no silent empty)", async () => {
  const runtime = { getURL: (p: string) => `chrome-extension://id/${p}` };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL) => Promise.resolve(new Response("missing", { status: 404 }))) as typeof fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).chrome = { runtime };
  try {
    const inv = createBundledInventory();
    await inv.readFile("extension/wasm/manifests/does-not-exist.manifest.json");
    throw new Error("unreachable: readFile must reject a 404");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes("fetch failed 404"), `loud failure with status: ${msg}`);
  } finally {
    globalThis.fetch = originalFetch;
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).chrome;
  }
});
