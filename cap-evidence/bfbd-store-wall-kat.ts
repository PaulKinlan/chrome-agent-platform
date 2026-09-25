// bfbd-store-wall-kat.ts — is there really a 256 KiB per-value wall behind the
// agent board's 192 KiB byte budget?
//
//   deno run -A cap-evidence/bfbd-store-wall-kat.ts [outDir]
//
// The board justifies BOARD_MAX_LOG_BYTES = 192 KiB with "the memory store's
// 256 KiB per-value cap (memory.js MAX_VALUE_BYTES)". That constant does not
// exist in the tree, and the board writes through `memory.setTrusted` on
// `masterMemory()`, which is an OPFS-backed store — so the wall is measured
// rather than assumed: the SAME production module the board uses is imported
// into an extension page and asked to store progressively larger values with
// the same key shape the board uses.
//
// Sizes are chosen for the decisions they settle:
//   192 KiB  — the board's own budget (must be accepted)
//   256 KiB  — the cap the comments cite
//   425,627  — what the count caps alone allow once the byte cap is removed
//   1 MiB / 5 MiB — beyond any per-value claim, to find where (if anywhere) refusal starts

import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, computeUnpackedExtensionId } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const OUT = Deno.args[0] ?? durableDir("bfbd-store-wall");
await Deno.mkdir(OUT, { recursive: true });

const { proc, wsUrl } = await launchChrome({ extension: EXT, timeoutMs: 40_000 });
let result: any = null;
try {
  const cdp = await openCdp(wsUrl);
  const id = await computeUnpackedExtensionId(EXT);
  const page = await cdp.open(`chrome-extension://${id}/options/options.html`);
  await new Promise((r) => setTimeout(r, 1500));
  result = await cdp.eval(page.sessionId, `(async () => {
    const lib = await import(chrome.runtime.getURL("lib/memory.js"));
    const store = lib.masterMemory();
    const api = typeof store.setTrusted === "function" ? "setTrusted" : (typeof store.set === "function" ? "set" : null);
    if (!api) return { ok: false, error: "no set/setTrusted on masterMemory()", keys: Object.keys(store) };
    const enc = new TextEncoder();
    // the board's key shape, so nothing about the key changes the answer
    const write = async (key, totalBytes) => {
      const chunk = "x".repeat(4000);
      const n = Math.ceil(totalBytes / 4000);
      const value = Array.from({ length: n }, (_, i) => ({ i, s: chunk }));
      const measured = enc.encode(JSON.stringify(value)).byteLength;
      try {
        await store[api](key, value);
        let readBack = null;
        try { const got = await (store.getStrict ? store.getStrict(key) : store.get(key)); readBack = Array.isArray(got) ? got.length : typeof got; } catch (e) { readBack = "read-error: " + String(e).slice(0, 60); }
        return { key, requestedBytes: totalBytes, measuredBytes: measured, accepted: true, readBack };
      } catch (e) {
        return { key, requestedBytes: totalBytes, measuredBytes: measured, accepted: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
    };
    const sizes = [20 * 1024 * 1024, 100 * 1024 * 1024, 400 * 1024 * 1024];
    const out = { api, results: [] };
    for (const size of sizes) out.results.push(await write("zz-kat-wall-" + size, size));
    // cleanup: remove the probe keys so the store is left as found
    const cleaned = [];
    for (const r of out.results) {
      try { if (typeof store.remove === "function") { await store.remove(r.key); cleaned.push(r.key); } else if (typeof store.delete === "function") { await store.delete(r.key); cleaned.push(r.key); } } catch { /* leave it */ }
    }
    out.cleaned = cleaned;
    return out;
  })()`);
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
}

await Deno.writeTextFile(`${OUT}/wall.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
const refused = (result?.results ?? []).filter((r: any) => !r.accepted);
const accepted = (result?.results ?? []).filter((r: any) => r.accepted);
console.log(`\nbfbd store wall: ${accepted.length} accepted, ${refused.length} refused`);
if (refused.length) console.log(`first refusal: ${JSON.stringify(refused[0]).slice(0, 300)}`);
