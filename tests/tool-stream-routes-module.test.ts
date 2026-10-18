// tests/tool-stream-routes-module.test.ts — chrome-agent-platform-atxc6 (second slice of the
// service-worker split by domain: the file-backed bundled-tool transport routes moved from TWO inline
// maps in the 5,010-line route map into extension/background/routes/tool-stream.js).
//
// The extraction is a MOVE, so what is worth asserting is the seam and the authority rule it carries,
// not the handler bodies (tests/wasm-streaming.test.ts covers the runtime, tests/bundled-tool-packages
// .test.ts covers the package posture):
//   1. the module owns exactly the twelve transport routes, and the map is frozen like every other
//      routes/*.js map — moving a route out of the monolith must not change the population;
//   2. every route derives its owner from the ROUTE CONTEXT and never from the message, which is the
//      security property the inline comment beside the old block existed to record: a bridge must not
//      shadow the owner-derived lifecycle routes with a caller-supplied owner string;
//   3. the two injected helpers are genuinely injected — the streaming engine travels as a parameter,
//      so the module has no hidden dependency on the worker's scope.
// @ts-nocheck — unit tests run under Deno.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createToolStreamRoutes } from "../extension/background/routes/tool-stream.js";

const TRANSPORT_ROUTES = [
  "tool-stream.discard",
  "tool-stream.input.append",
  "tool-stream.input.create",
  "tool-stream.input.seal",
  "tool-stream.output.read",
  "tool-stream.output.receipt",
  "tool-stream.promote-output",
  "tool-stream.run",
  "tool-stream.stage-asset",
  "tool-stream.stage-attachment",
  "tool-stream.tabular-transform",
  "tool-stream.remove",
].sort();

function harness() {
  const owners = [];
  const runs = [];
  const routes = createToolStreamRoutes({
    wasmStreamOwner: (context) => {
      owners.push(context);
      return `owner-for-${context?.documentId ?? "unknown"}`;
    },
    runWasmStreamTool: async (args) => {
      runs.push(args);
      return { ok: true, args };
    },
  });
  return { routes, owners, runs };
}

Deno.test("tool-stream routes: the module owns exactly the twelve transport routes and freezes its map", () => {
  const { routes } = harness();
  assertEquals(Object.keys(routes).sort(), TRANSPORT_ROUTES);
  assert(Object.isFrozen(routes), "the route map must be frozen, like every other routes/*.js map");
  for (const [name, handler] of Object.entries(routes)) {
    assertEquals(typeof handler, "function", `${name} must be a handler`);
  }
});

Deno.test("tool-stream routes: the owner comes from the ROUTE CONTEXT, never from the message", async () => {
  // Run-bound execution is the one route whose result we can observe without storage: the injected
  // engine receives whatever owner the route derived. A caller-supplied `owner` in the MESSAGE must be
  // ignored — that shadowing is exactly what the inline comment warned about.
  const { routes, owners, runs } = harness();
  const context = { documentId: "settings-options", principal: "owner-options" };
  await routes["tool-stream.run"]({ toolId: "t", args: [], owner: "attacker", inputRef: "r1" }, context);
  assertEquals(owners, [context], "the route must derive the owner from the exact route context object");
  assertEquals(runs.length, 1, "the injected engine must receive the run");
  assertEquals(runs[0].owner, "owner-for-settings-options", "the caller must not be able to select the owner");
  assert(runs[0].documentId === "settings-options", "the document id travels from the route context");
});

Deno.test("tool-stream routes: the streaming engine is INJECTED, so no route reaches across module scope", async () => {
  // A module that referenced `runWasmStreamTool` lexically would still pass a wiring test on the worker
  // and fail only when the module was loaded on its own — the shape that makes an extraction unprovable.
  const { routes, runs } = harness();
  const result = await routes["tool-stream.run"]({ toolId: "t", args: [1], inputRef: "r2" }, { documentId: "preview" });
  assertEquals(result.ok, true);
  assertEquals(runs[0].toolId, "t");
  assertEquals(runs[0].args, [1]);
  const source = await Deno.readTextFile("extension/background/routes/tool-stream.js");
  assert(!/^\s*function runWasmStreamTool\s*\(/m.test(source), "the engine must not be re-implemented in the module");
  assert(source.includes("runWasmStreamTool })") || source.includes("runWasmStreamTool }) {"),
    "the engine must arrive as an injected dependency");
});
