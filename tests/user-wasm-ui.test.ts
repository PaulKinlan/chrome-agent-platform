// @ts-nocheck — browser globals and Worker are injected; real UI has a CDP KAT.
import { assert, assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1";
import { runUserWasmStore } from "../extension/lib/user-wasm-store-client.js";
import { SETTINGS_SECTIONS, OPTIONS_PRODUCT_HASHES, DEVELOPER_SECTIONS_SET } from "../extension/lib/pure.js";
import { scanShippedJs } from "../scripts/scan-shipped.mjs";

const read = (path) => Deno.readTextFile(new URL(`../${path}`, import.meta.url));

Deno.test("user-wasm UI: normal Settings section uses the shared, gallery-documented component", async () => {
  assert(SETTINGS_SECTIONS.includes("user-wasm"));
  assert(OPTIONS_PRODUCT_HASHES.has("#user-wasm"));
  assert(!DEVELOPER_SECTIONS_SET.has("user-wasm"));
  const html = await read("extension/options/options.html");
  assert(html.includes('href="#user-wasm"'));
  assert(html.includes('<user-wasm-manager id="user-wasm-manager">'));
  assert((await read("docs/components.html")).includes("<user-wasm-manager"));
  assert((await read("extension/options/options.js")).includes("mountUserWasmPanel"));
});

Deno.test("user-wasm client: only exact Settings document can start the storage Worker", async () => {
  const previous = new Map(["chrome", "location", "Worker"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const messages = [];
  let workers = 0, terminated = 0;
  class WorkerFake {
    constructor(url, options) {
      workers++;
      assertEquals(url, "chrome-extension://owner/lib/user-wasm-store-worker.js");
      assertEquals(options, { type: "module" });
    }
    postMessage(message) {
      messages.push(message);
      queueMicrotask(() => this.onmessage({ data: { ok: true, result: { saved: true } } }));
    }
    terminate() { terminated++; }
  }
  try {
    for (const [key, value] of Object.entries({
      chrome: { runtime: { getURL: (path) => `chrome-extension://owner/${path}`, sendMessage() { throw new Error("No runtime JSON transport"); } } },
      Worker: WorkerFake,
    })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    for (const href of [
      "https://example.com/options/options.html", "chrome-extension://foreign/options/options.html",
      "chrome-extension://owner/ntp/ntp.html", "chrome-extension://owner/options/options.html.evil",
    ]) {
      Object.defineProperty(globalThis, "location", { value: { href }, configurable: true });
      await assertRejects(() => runUserWasmStore("list"), Error, "only be managed in Settings");
    }
    assertEquals(workers, 0);
    Object.defineProperty(globalThis, "location", { value: { href: "chrome-extension://owner/options/options.html#user-wasm" }, configurable: true });
    const file = new Blob(["opaque bytes"]);
    assertEquals(await runUserWasmStore("put", { file, name: "Owner", description: "Description" }), { saved: true });
    assertStrictEquals(messages[0].payload.file, file, "File is passed to native structured clone, not serialized");
    assertEquals(workers, 1);
    assertEquals(terminated, 1);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

Deno.test("user-wasm scanner: only the exact packaged storage Worker constructor is approved", async () => {
  const path = "extension/lib/user-wasm-store-client.js";
  const source = await read(path);
  async function scan(file, text) {
    return await scanShippedJs([file], { readText: async () => text });
  }
  assertEquals(await scan(path, source), []);
  for (const [file, text] of [
    ["extension/lib/not-user-wasm-store-client.js", source],
    [path + ".evil", source],
    [path, "// moved constructor\n" + source],
    [path, source.replace("lib/user-wasm-store-worker.js", "lib/foreign-worker.js")],
    [path, source + "\nnew Worker('lib/user-wasm-store-worker.js');"],
  ]) {
    assert((await scan(file, text)).some((v) => /Worker/.test(v)), "unreviewed host must still fail");
  }
});
