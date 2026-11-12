// @ts-nocheck
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
// HOW IT COMPARES (rev-4iyck finding x1u6d): the first cut normalised the two bodies as TEXT with
// `[\s{};]` stripped, so a mutant that replaced a conditional's body with `{} return false;`
// still compared equal — the braces carrying the control flow were erased with the formatting
// ones. The comparison is now STRUCTURAL (acorn): the two functions are parsed and normalised as
// SYNTAX TREES, with exactly the two spellings the classic-script constraint forces reconciled —
// the canonical `runtime` default parameter, which the port must spell as a binding, and the
// canonical module-level constant, which the port must spell as its literal. A one-statement
// block is unwrapped on BOTH sides (the port may brace a single statement, the canonical may not);
// blocks with zero or several statements are kept, which is exactly what distinguishes the
// x1u6d mutant. A behavioural table then runs both functions against the same senders and
// requires identical verdicts.
//
// WHAT THIS FENCES, and why each leg is load-bearing:
//   1. The fence's canonical import is the ONLY module under extension/ that exports the predicate
//      (a second exporter is a second seam the port could mirror). The port's KEEP-IN-SYNC comment
//      currently cites extension/lib/pure.js, which no longer holds the predicate; correcting that
//      is a PRODUCT-path edit owing a release note, filed as chrome-agent-platform-y2uw8.
//   2. The port's bundle-path literal IS SERVICE_WORKER_BUNDLE_PATH, imported from that module.
//   3. The two bodies are the same predicate (structural comparison, above).
//   4. They agree behaviourally on a table of senders that exercises every refusal.
//
// FALSIFICATION (measured against the pinned source, no checkout edit): change
// SERVICE_WORKER_BUNDLE_PATH in the canonical module -> legs 2 and 3 red; replace the port's first
// conditional with `{} return false;` (x1u6d's mutant) -> legs 3 and 4 red; add or drop any check
// on the canonical side -> leg 3 reds.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_WORKER_BUNDLE_PATH } from "../extension/lib/pure-trust.js";

// e273: never derive a filesystem root from a URL pathname (percent-encoding) — decode it.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const CANONICAL_MODULE = "extension/lib/pure-trust.js";
const CANONICAL_NAME = "isTrustedServiceWorkerSender";
const PORT_MODULE = "extension/content/content-script.js";
const PORT_NAME = "isTrustedServiceWorkerSenderPort";

/** The FunctionDeclaration node for `name`, found by walking the parsed module. content-script.js is
 *  a classic script wrapped in an IIFE, so the port is NOT a top-level node; a top-level-only search
 *  would silently find nothing and a fence that cannot find its subject is not a fence. Never keyed
 *  by line number (khwi9 moved a policed listener 14 lines and rotted a line pin). */
function parseFunctionDecl(src: string, name: string, label: string) {
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const found = findFunctionDecl(ast as any, name);
  assert(found, `must find function ${name} (${label})`);
  return found;
}

function findFunctionDecl(node: any, name: string): any {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findFunctionDecl(child, name);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === "FunctionDeclaration" && node.id?.name === name) return node;
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const hit = findFunctionDecl((node as any)[key], name);
    if (hit) return hit;
  }
  return null;
}

/** Source text of a node's body, for the behavioural leg. */
function bodyText(src: string, node: any): string {
  return src.slice(node.body.start + 1, node.body.end - 1);
}

/** Structural normalisation: drop formatting (positions), reconcile the two forced spellings, and
 *  unwrap one-statement blocks on BOTH sides so a formatter disagreeing about braces is not read
 *  as a behavioural difference. A block with zero or many statements is preserved — that is the
 *  control flow, and erasing it is exactly the x1u6d false parity. */
function normaliseNode(node: any): any {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(normaliseNode);
  // The canonical module names the bundle path; the port must carry its value.
  if (node.type === "Identifier" && node.name === "SERVICE_WORKER_BUNDLE_PATH") {
    return { type: "Literal", value: SERVICE_WORKER_BUNDLE_PATH };
  }
  // `globalThis.chrome` and `chrome` are the same object in a content script.
  if (
    node.type === "MemberExpression" && !node.computed &&
    node.object?.type === "Identifier" && node.object.name === "globalThis" &&
    node.property?.type === "Identifier" && node.property.name === "chrome"
  ) {
    return { type: "Identifier", name: "chrome" };
  }
  const out: any = {};
  for (const [key, value] of Object.entries(node)) {
    // `raw` is the literal's SOURCE TEXT: the canonical names the constant, the port writes the
    // value, so their raw spellings differ while the value and type agree.
    if (key === "start" || key === "end" || key === "loc" || key === "range" || key === "raw") continue;
    out[key] = normaliseNode(value);
  }
  if (out.type === "BlockStatement" && Array.isArray(out.body) && out.body.length === 1) {
    return out.body[0];
  }
  return out;
}

/** Stable, key-order-insensitive serialisation: acorn emits node keys in source order, so a
 *  comparison that trusts JSON.stringify would call two identical trees different purely because a
 *  hand-built node listed `kind` before `declarations`. */
function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function normaliseBody(body: any[]): string {
  return stableStringify(body.map(normaliseNode));
}

Deno.test("v8n9b: the content-script sender port is fenced against the canonical predicate", async () => {
  const canonicalSrc = await Deno.readTextFile(path.join(ROOT, CANONICAL_MODULE));
  const portSrc = await Deno.readTextFile(path.join(ROOT, PORT_MODULE));

  // ── Leg 1: the fence's canonical import IS the uniquely-owning module. ──
  const exporters: string[] = [];
  for (const dir of ["extension/lib", "extension/content"]) {
    for (const entry of Deno.readDirSync(path.join(ROOT, dir))) {
      if (!entry.isFile || !entry.name.endsWith(".js")) continue;
      const src = await Deno.readTextFile(path.join(ROOT, dir, entry.name));
      if (new RegExp(`export function ${CANONICAL_NAME}\\b`).test(src)) exporters.push(`${dir}/${entry.name}`);
    }
  }
  assertEquals(
    exporters,
    [CANONICAL_MODULE],
    `the fence imports ${CANONICAL_MODULE}, so that file must be the ONLY module exporting ` +
      `${CANONICAL_NAME} — a second exporter is a second seam and the port could mirror either`,
  );
  assert(
    portSrc.includes(CANONICAL_NAME),
    "the port's comment must name the canonical predicate it mirrors",
  );

  const canonicalFn = parseFunctionDecl(canonicalSrc, CANONICAL_NAME, CANONICAL_MODULE);
  const portFn = parseFunctionDecl(portSrc, PORT_NAME, PORT_MODULE);

  // ── Leg 2: the port's URL literal IS the canonical constant. ──
  const portBodyText = bodyText(portSrc, portFn);
  assertEquals(
    portBodyText.includes(JSON.stringify(SERVICE_WORKER_BUNDLE_PATH)),
    true,
    `the port must pin the bundle path literal ${JSON.stringify(SERVICE_WORKER_BUNDLE_PATH)}; ` +
      `the canonical constant moving without the port is exactly the v8n9b drift`,
  );
  assertEquals(
    portBodyText.includes("SERVICE_WORKER_BUNDLE_PATH"),
    false,
    "the port cannot import (classic script), so it must carry the VALUE, not the name",
  );

  // ── Leg 3: the two bodies are the same predicate, structurally. ──
  // The canonical takes `runtime` as a default parameter; the port binds it as a statement. That is
  // a calling-convention difference, so the binding is DERIVED from the canonical parameter's own
  // default (not copied from the port) and compared before the rest of the bodies.
  const runtimeParam: any = canonicalFn.params[1];
  assert(
    runtimeParam?.type === "AssignmentPattern" && runtimeParam.left?.name === "runtime",
    "the canonical predicate must take `runtime` as a defaulted second parameter",
  );
  const derivedBinding = {
    type: "VariableDeclaration", kind: "const",
    declarations: [{
      type: "VariableDeclarator",
      id: { type: "Identifier", name: "runtime" },
      init: normaliseNode(runtimeParam.right),
    }],
  };
  const canonicalStatements = [...canonicalFn.body.body];
  const portStatements = [...portFn.body.body];
  assert(portStatements.length > 0, "the port must bind runtime before using it");
  assertEquals(
    normaliseBody([portStatements[0]]),
    normaliseBody([derivedBinding]),
    "the port must bind `runtime` to exactly the canonical default (`globalThis.chrome?.runtime`)",
  );
  assertEquals(
    normaliseBody(portStatements.slice(1)),
    normaliseBody(canonicalStatements),
    `the content-script port has drifted from ${CANONICAL_NAME} in ${CANONICAL_MODULE} — re-sync the ` +
      `PORT body with the canonical predicate (this assertion is the fence v8n9b asks for)`,
  );

  // ── Leg 4: behavioural parity on a table that exercises every refusal. ──
  // Independent of the structural compare: a rewrite that is textually different but semantically
  // identical must still agree here, and a mutate-through-a-shape-the-tree-compare-misses must not.
  const runtimeFor = (declared: string | null) => ({
    id: "ext",
    getManifest: () => (declared === null ? {} : { background: { service_worker: declared } }),
    getURL: (s: string) => `chrome-extension://ext/${s}`,
  });
  const goodUrl = `chrome-extension://ext/${SERVICE_WORKER_BUNDLE_PATH}`;
  const SENDERS = [
    { name: "the real service worker", sender: { id: "ext", url: goodUrl } },
    { name: "foreign extension id", sender: { id: "other", url: goodUrl } },
    { name: "a tab sender", sender: { id: "ext", tab: { id: 3 }, url: goodUrl } },
    { name: "a documentId sender", sender: { id: "ext", documentId: "d1", url: goodUrl } },
    { name: "a same-extension page sender", sender: { id: "ext", url: "chrome-extension://ext/options/index.html" } },
    { name: "no url", sender: { id: "ext" } },
    { name: "no sender", sender: undefined },
  ];
  const MANIFESTS = [SERVICE_WORKER_BUNDLE_PATH, null, "dist/background/other.js"];
  // Both predicates read `chrome` as a GLOBAL (a content script and the module alike), so the
  // harness binds that global per row and calls each function exactly as production calls it — the
  // canonical keeps its own default parameter, the port keeps its own binding. No source rewriting.
  const asFunction = (src: string, name: string) => {
    const node = findFunctionDecl(acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" }), name);
    assert(node, `must find ${name} for the behavioural leg`);
    // Slice the DECLARATION text (drop a leading `export `) and evaluate it: the function then has
    // its own real signature, default parameter included.
    const text = src.slice(node.start, node.end);
    return (0, eval)(`(${text.replace(/^export\s+/, "")})`);
  };
  const canonicalRun = asFunction(canonicalSrc, CANONICAL_NAME);
  const portRun = asFunction(portSrc, PORT_NAME);
  const realChrome = (globalThis as any).chrome;
  try {
    for (const declared of MANIFESTS) {
      for (const { name, sender } of SENDERS) {
        (globalThis as any).chrome = runtimeFor(declared);
        let expected: unknown, actual: unknown;
        try { expected = canonicalRun(sender); } catch (e) { expected = `threw: ${e?.message}`; }
        try { actual = portRun(sender); } catch (e) { actual = `threw: ${e?.message}`; }
        assertEquals(
          actual,
          expected,
          `behavioural drift: manifest=${JSON.stringify(declared)} sender=${name}: the port answered ` +
            `${JSON.stringify(actual)}, the canonical predicate ${JSON.stringify(expected)}`,
        );
      }
    }
  } finally {
    (globalThis as any).chrome = realChrome;
  }
});
