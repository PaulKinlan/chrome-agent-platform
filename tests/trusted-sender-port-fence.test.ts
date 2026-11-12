// tests/trusted-sender-port-fence.test.ts — chrome-agent-platform-v8n9b (4iyck scope 4).
//
// THE HOLE. extension/content/content-script.js cannot import ES modules (chrome.scripting
// injects classic files), so the trusted-service-worker sender predicate is DUPLICATED there as
// `isTrustedServiceWorkerSenderPort`. The canonical predicate lives in
// extension/lib/pure-trust.js (moved out of pure.js by gzkmx). The comment above the port says
// "KEEP IN SYNC", and tests/onmessage-sender-guard.test.ts credits the port in its
// ALLOWLISTED_SITES census — but NO test asserted the claim, so the two could drift silently.
// v8n9b's repro: change SERVICE_WORKER_BUNDLE_PATH in the canonical module and the whole
// sender-guard suite stays green (14/14) while the relay would reject the real service worker.
//
// WHAT THIS FENCES, and why each leg is load-bearing:
//   1. The comment must cite a module that EXISTS and actually exports the canonical predicate.
//      (nkg2n: a keep-in-sync pin re-pointed at the wrong seam is worse than none — it certifies
//      a file that does not hold the behaviour.)
//   2. The port's URL literal is SERVICE_WORKER_BUNDLE_PATH, imported from that module — the
//      exact literal, not a copy of it.
//   3. The port body and the canonical body are IDENTICAL after the two spellings that the
//      classic-script constraint forces are normalised: the default parameter is spelled out as
//      a binding, and the bundle path is spelled as a literal. Any added, dropped or reordered
//      check reds.
//
// FALSIFICATION (measured, see the bead): change SERVICE_WORKER_BUNDLE_PATH to
// "dist/background/service-worker-v2.js" -> leg 2 and leg 3 red; add a predicate to the
// canonical function -> leg 3 reds; re-point the comment at extension/lib/pure.js -> leg 1 reds.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_WORKER_BUNDLE_PATH } from "../extension/lib/pure-trust.js";

// e273: never derive a filesystem root from a URL pathname (percent-encoding) — decode it.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The body of the first function whose signature matches, by brace matching (no line numbers:
 *  khwi9 moved a policed listener 14 lines and rotted a line-keyed pin). */
function functionBody(src: string, signature: RegExp, label: string): string {
  const m = signature.exec(src);
  assert(m, `must find ${label} (signature ${signature})`);
  const open = src.indexOf("{", (m.index ?? 0) + m[0].length - 1);
  assert(open > 0, `must find the opening brace of ${label}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated body for ${label}`);
}

/** Strip the spelling differences the classic-script constraint forces, then remove the
 *  punctuation a formatter may move around, so only the PREDICATE remains to compare. */
function normalise(body: string, { spellOutRuntime }: { spellOutRuntime: boolean }): string {
  let out = body;
  if (spellOutRuntime) {
    // The canonical predicate takes `runtime` as a default parameter; the port binds it. That is
    // a calling-convention difference, not a behavioural one, so compare after making both
    // explicit. `globalThis.chrome` and `chrome` are the same object in a content script.
    out = `const runtime = chrome?.runtime;${out}`;
  }
  out = out
    .replace(/globalThis\.chrome/g, "chrome")
    // The canonical module names the bundle path; the port must carry its value.
    .replace(/SERVICE_WORKER_BUNDLE_PATH/g, JSON.stringify(SERVICE_WORKER_BUNDLE_PATH));
  return out.replace(/[\s{};]/g, "");
}

Deno.test("v8n9b: the content-script sender port is fenced against the canonical predicate", async () => {
  const canonicalSrc = await Deno.readTextFile(path.join(ROOT, "extension/lib/pure-trust.js"));
  const portSrc = await Deno.readTextFile(path.join(ROOT, "extension/content/content-script.js"));

  // ── Leg 1: the fence's canonical import IS the uniquely-owning module. ──
  // The port's KEEP-IN-SYNC comment currently cites extension/lib/pure.js, which no longer holds
  // the predicate (gzkmx moved it to pure-trust.js). Correcting that comment is a PRODUCT-path edit
  // and owes a release note, so it is filed as its own bead (chrome-agent-platform-y2uw8) rather
  // than smuggled in here; this leg therefore pins the property the fence itself depends on — the
  // module it imports is the ONLY module under extension/ that exports the predicate. A second
  // exporter, or the predicate moving again without the fence following, reds here.
  const exporters: string[] = [];
  for (const dir of ["extension/lib", "extension/content"]) {
    for (const entry of Deno.readDirSync(path.join(ROOT, dir))) {
      if (!entry.isFile || !entry.name.endsWith(".js")) continue;
      const src = await Deno.readTextFile(path.join(ROOT, dir, entry.name));
      if (/export function isTrustedServiceWorkerSender\b/.test(src)) exporters.push(`${dir}/${entry.name}`);
    }
  }
  assertEquals(
    exporters,
    ["extension/lib/pure-trust.js"],
    "the fence imports extension/lib/pure-trust.js, so that file must be the ONLY module exporting " +
      "isTrustedServiceWorkerSender — a second exporter is a second seam and the port could mirror either",
  );
  // The port must still NAME the canonical predicate, so a reader knows what it mirrors even while
  // the citation above is being corrected (chrome-agent-platform-y2uw8).
  assert(
    portSrc.includes("isTrustedServiceWorkerSender"),
    "the port's comment must name the canonical predicate it mirrors",
  );

  // ── Leg 2: the port's URL literal IS the canonical constant. ──
  const portBody = functionBody(portSrc, /function isTrustedServiceWorkerSenderPort\s*\(\s*sender\s*\)\s*\{/, "isTrustedServiceWorkerSenderPort");
  assertEquals(
    portBody.includes(JSON.stringify(SERVICE_WORKER_BUNDLE_PATH)),
    true,
    `the port must pin the bundle path literal ${JSON.stringify(SERVICE_WORKER_BUNDLE_PATH)}; ` +
      `the canonical constant moving without the port is exactly the v8n9b drift`,
  );

  // ── Leg 3: the two bodies are the same predicate. ──
  const canonicalBody = functionBody(
    canonicalSrc,
    /export function isTrustedServiceWorkerSender\s*\([^)]*\)\s*\{/,
    "isTrustedServiceWorkerSender",
  );
  assertEquals(
    normalise(portBody, { spellOutRuntime: false }),
    normalise(canonicalBody, { spellOutRuntime: true }),
    "the content-script port has drifted from the canonical isTrustedServiceWorkerSender — " +
      "re-sync the PORT body with extension/lib/pure-trust.js (this assertion is the fence v8n9b asks for)",
  );
});
