// tests/webmcp-dispatch-fallthrough.test.ts — chrome-agent-platform-922q
//
// The ROOT CAUSE of the owner's beads.gascity.com search_docs failure:
// Chrome's NATIVE WebMCP dispatch (modelContext.executeTool) throws
// DOMException: UnknownError while the page's own handler is healthy, and the
// dispatcher tried executeTool FIRST and gave up when it threw. The fix: the
// declared-tool dispatch is a CHAIN — executeTool → the descriptor's own
// execute/_execute (identity-preserved from getTools()) → callTool/invoke —
// a throwing path falls through to the next, and only when EVERY path fails
// does the honest error name each path and its cause.
//
// main-world.js is a non-importable injected IIFE: these are the structural
// invariants (house pattern, per tests/webmcp-honest-errors.test.ts); the
// BEHAVIORAL proof is scripts/kat-webmcp-honest-errors.ts driving the
// dispatch_broken_* fixture tools in a real browser.
// @ts-nocheck — source-text assertions, house style.
import { assert } from "jsr:@std/assert@1";

const MAIN = await Deno.readTextFile(new URL("../extension/content/main-world.js", import.meta.url));
const SW = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
const FIXTURE = await Deno.readTextFile(new URL("../fixtures/webmcp-errors.html", import.meta.url));

// The dispatch block: from `if (source === "declared")` to the unknown-source
// guard — the whole chain lives inside it.
const blockStart = MAIN.indexOf('if (source === "declared")');
const blockEnd = MAIN.indexOf("unknown tool source", blockStart);
const BLOCK = blockStart > 0 && blockEnd > blockStart ? MAIN.slice(blockStart, blockEnd) : "";

Deno.test("fall-through: the declared dispatch is a chain of paths, tried in order", () => {
  assert(BLOCK.includes("dispatchPaths"), "the dispatch paths are collected before dispatch");
  assert(BLOCK.includes("modelContext.executeTool"), "the native/polyfill dispatcher is path one");
  assert(BLOCK.includes("tool.execute"), "the descriptor's own execute is a fall-through path");
  assert(BLOCK.includes("tool._execute"), "the legacy _execute shape is a fall-through path");
  const forOf = BLOCK.indexOf("for (const [dispatchLabel, runDispatch] of dispatchPaths)");
  assert(forOf > 0, "the chain is iterated, not first-match-wins");
  const catchIdx = BLOCK.indexOf("catch", forOf);
  assert(catchIdx > forOf, "a throwing path is caught…");
  assert(BLOCK.indexOf("continue", catchIdx) > catchIdx || BLOCK.indexOf("dispatchFailures.push", catchIdx) > catchIdx,
    "…and the chain falls through to the next path");
});

Deno.test("fall-through: success returns immediately; only ALL paths failing produces the chain-noted honest error", () => {
  assert(BLOCK.includes("return await runDispatch()"), "a succeeding path returns its result");
  assert(BLOCK.includes("dispatchFailures"), "each path's failure is recorded");
  assert(BLOCK.includes("lastFailure"), "the LAST failure's real error is what gets reported");
  assert(BLOCK.includes("__capDispatchChain"), "the chain note rides the page error to describePageError");
  // The chain note lives in describePageError (outside the dispatch block):
  // it appends what was tried to the LAST failure's honest description — so
  // the real error name/stack survive (the ajcc invariants) and the redaction
  // stays single-pass (NFKC would fold the redaction marker on a second pass).
  assert(MAIN.includes("every dispatch path failed (tried "), "the chain note says what was tried");
  assert(MAIN.includes("detail.dispatchChain"), "errorDetail carries the chain");
});

Deno.test("fall-through: cancellation is still checked between paths", () => {
  const forOf = BLOCK.indexOf("for (const [dispatchLabel, runDispatch] of dispatchPaths)");
  assert(forOf > 0);
  assert(BLOCK.indexOf("isStale()", forOf) > forOf, "each attempt re-checks the cancel epoch");
});

Deno.test("fall-through: page-path failure names are redacted at capture; the message is redacted once by describePageError", () => {
  // The composite embeds page-thrown NAMES — redacted when captured. The page
  // MESSAGE flows through describePageError's single redaction pass (a second
  // pass NFKC-folds the "…[query redacted]" marker — the 922q KAT caught it).
  const forOf = BLOCK.indexOf("for (const [dispatchLabel, runDispatch] of dispatchPaths)");
  assert(BLOCK.indexOf("redactBridgeText(", forOf) > forOf, "failure names are redacted at capture");
  assert(!BLOCK.includes("safeField(dispatchError, \"message\")"), "the message is NOT pre-redacted (single-pass rule)");
  assert(MAIN.includes("describePageError(e, tool, phase, dispatchChain = null)"), "describePageError takes the chain note");
});

Deno.test("fall-through: no callable path at all is an honest internal error, distinct from 'no such tool'", () => {
  assert(BLOCK.includes("no callable dispatch path"), "a descriptor with no usable path says so");
  assert(BLOCK.includes("no such declared tool"), "the unknown-tool error is preserved");
});

Deno.test("docs fallback: the live site-tool dispatch (readSiteLazySources) routes failures through withSiteDocsFallback", () => {
  const fnIdx = SW.indexOf("async function readSiteLazySources(");
  assert(fnIdx > 0, "readSiteLazySources is the live model-facing site-tool source");
  const endIdx = SW.indexOf("// The orchestrator build", fnIdx);
  const block = SW.slice(fnIdx, endIdx > fnIdx ? endIdx : fnIdx + 14000);
  assert(block.includes("withSiteDocsFallback"), "the catalog dispatch routes failures through the docs fallback");
  assert(SW.includes('from "../lib/site-docs-fallback.js"'), "the fallback module is imported");
});

Deno.test("docs fallback: the fixture declares the broken-dispatch tools and the docs pages exist", () => {
  for (const name of ["dispatch_broken_handler_ok", "dispatch_broken_handler_throws"]) {
    assert(FIXTURE.includes(`"${name}"`), `fixture declares ${name}`);
  }
  assert(FIXTURE.includes('tool.name.startsWith("dispatch_broken")'), "the fixture's executeTool simulates the broken native dispatch");
  assert(FIXTURE.includes('"UnknownError"'), "the simulated native failure is the owner-observed shape");
});
