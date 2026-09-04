// tests/tool-pipeline-wire.test.ts — run_pipeline, the fourth lazy-protocol
// meta-tool (chrome-agent-platform-qsm4, slice 2): the declarative pipeline
// core (extension/lib/tool-pipeline.js) wired LIVE so a model can chain a few
// existing tools with { $ref } bindings. Every step dispatches through the
// run's normal tool seam (search → execute), so owner-approval cards, the
// untrusted fence and fail-closed halting apply per step exactly as they do
// for a direct execute_tool call.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { tool } from "ai";
import { z } from "zod";
import {
  createLazyProviderToolset,
  executableBuiltinToolRecords,
  LAZY_PROTOCOL_TOOL_WIRE,
} from "../extension/lib/lazy-tool-protocol.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";

const HUB_SCOPE = { hub: true, agentId: "hub", origin: "", documentId: "" };

function refFactory() {
  let value = 0;
  return () => `sel_${(++value).toString(16).padStart(36, "0")}`;
}

function runContext(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    taskId: "task-1",
    runGeneration: "generation-1",
    agentId: "hub",
    origin: "",
    documentId: "hub-doc",
    ...overrides,
  };
}

/** A two-tool stub catalog: pipe_write stores, pipe_read reads. The store is
 * shared per records() call so the pipe is observable end to end. */
function pipeRecords(store: Map<string, unknown>, calls: Array<{ name: string; args: unknown }>) {
  const tools = {
    pipe_write: tool({
      description: "Write a value into the pipe store",
      inputSchema: z.object({ key: z.string(), value: z.string() }),
      execute: async ({ key, value }: { key: string; value: string }) => {
        calls.push({ name: "pipe_write", args: { key, value } });
        store.set(key, value);
        return { ok: true, key };
      },
    }),
    pipe_read: tool({
      description: "Read a value from the pipe store",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }: { key: string }) => {
        calls.push({ name: "pipe_read", args: { key } });
        return { key, value: store.get(key) ?? null };
      },
    }),
  };
  return executableBuiltinToolRecords(tools, {
    version: "1.0.0",
    sourceGeneration: "extension:1",
    scope: HUB_SCOPE,
    capabilities: ["test.invoke"],
  });
}

function boundToolset(records: unknown, { onPermissionRequest = null, context = runContext() }: Record<string, unknown> = {}): any {
  return createLazyProviderToolset({
    readSources: () => records,
    contextReader: () => context,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
    onPermissionRequest: onPermissionRequest as never,
  }) as any;
}

Deno.test("run_pipeline is the fourth fixed lazy-protocol meta-tool, wired with a schema", () => {
  const bound = boundToolset([]);
  assertEquals(Object.keys(bound.tools), ["search_tools", "list_tools", "execute_tool", "run_pipeline"]);
  assertEquals(bound.diagnostics().exposedToolCount, 4);
  const wire = LAZY_PROTOCOL_TOOL_WIRE.map((row) => row.name);
  assertEquals(wire, ["search_tools", "list_tools", "execute_tool", "run_pipeline"]);
  const descriptor = LAZY_PROTOCOL_TOOL_WIRE[3] as any;
  assertEquals(descriptor.inputSchema.required, ["steps"]);
  assert(descriptor.outputSchema && typeof descriptor.outputSchema === "object", "an output schema is wired");
});

Deno.test("run_pipeline executes a two-step pipeline through the real protocol seam and pipes the result", async () => {
  const store = new Map<string, unknown>();
  const calls: Array<{ name: string; args: unknown }> = [];
  const bound = boundToolset(pipeRecords(store, calls));
  const result = await bound.tools.run_pipeline.execute({
    name: "set-then-read",
    steps: [
      { id: "set", tool: "pipe_write", args: { key: "colour", value: "blue" } },
      // The read's key comes ONLY from the binding — the literal "colour"
      // appears nowhere in this step's declared args.
      { id: "get", tool: "pipe_read", args: { key: { $ref: "set", path: "key" } } },
    ],
  });
  assertEquals(result.ok, true);
  assertEquals(result.final, { key: "colour", value: "blue" });
  assertEquals(calls.map((c) => c.name), ["pipe_write", "pipe_read"]);
  assertEquals(calls[1].args, { key: "colour" }, "the second step received the BOUND value, resolved by the pure path lookup");
  assertEquals(store.get("colour"), "blue");
});

Deno.test("run_pipeline: a step needing owner approval surfaces the card mid-pipeline and Allow re-runs the step", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const approvals: unknown[] = [];
  let gatedCalls = 0;
  const tools = {
    gated_thing: tool({
      description: "A thing that needs an owner capability",
      inputSchema: z.object({ label: z.string() }),
      execute: async ({ label }: { label: string }) => {
        gatedCalls++;
        calls.push({ name: "gated_thing", args: { label } });
        if (gatedCalls === 1) {
          return {
            waitingForPermission: true,
            permissionRequirement: { reason: "gated capability", permissions: ["test.gated"] },
          };
        }
        return { ok: true, did: label };
      },
    }),
    pipe_read: tool({
      description: "Read a value from the pipe store",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }: { key: string }) => {
        calls.push({ name: "pipe_read", args: { key } });
        return { key, value: `saw:${key}` };
      },
    }),
  };
  const records = executableBuiltinToolRecords(tools, {
    version: "1.0.0",
    sourceGeneration: "extension:1",
    scope: HUB_SCOPE,
    capabilities: ["test.invoke"],
  });
  const bound = boundToolset(records, {
    onPermissionRequest: (denial: unknown) => {
      approvals.push(denial);
      return "approved";
    },
  });
  const result = await bound.tools.run_pipeline.execute({
    steps: [
      { id: "act", tool: "gated_thing", args: { label: "the-deed" } },
      // Step 2 pipes the APPROVED step's result onward — proof the pipeline
      // continued past the card with the real outcome, not the denial.
      { id: "read", tool: "pipe_read", args: { key: { $ref: "act", path: "did" } } },
    ],
  });
  assertEquals(result.ok, true);
  assertEquals(approvals.length, 1, "exactly one owner card surfaced, mid-pipeline");
  const denial = approvals[0] as { waitingForPermission?: boolean; permissionRequirement?: { reason?: string } };
  assertEquals(denial.waitingForPermission, true);
  assertEquals(denial.permissionRequirement?.reason, "gated capability");
  assertEquals(gatedCalls, 2, "Allow re-ran the step (the runtime resume path), it was not skipped");
  // The resume re-executed with the ORIGINAL validated arguments.
  assertEquals(calls[1], { name: "gated_thing", args: { label: "the-deed" } });
  assertEquals(result.final, { key: "the-deed", value: "saw:the-deed" });
});

Deno.test("run_pipeline: an owner denial halts the pipeline fail-closed, naming the tool and the requirement", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const tools = {
    gated_thing: tool({
      description: "A thing that needs an owner capability",
      inputSchema: z.object({ label: z.string() }),
      execute: async ({ label }: { label: string }) => {
        calls.push({ name: "gated_thing", args: { label } });
        return {
          waitingForPermission: true,
          permissionRequirement: { reason: "gated capability", permissions: ["test.gated"] },
        };
      },
    }),
    pipe_read: tool({
      description: "Read a value from the pipe store",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }: { key: string }) => {
        calls.push({ name: "pipe_read", args: { key } });
        return { key, value: null };
      },
    }),
  };
  const records = executableBuiltinToolRecords(tools, {
    version: "1.0.0",
    sourceGeneration: "extension:1",
    scope: HUB_SCOPE,
    capabilities: ["test.invoke"],
  });
  const bound = boundToolset(records, { onPermissionRequest: () => "denied" });
  const result = await bound.tools.run_pipeline.execute({
    steps: [
      { id: "act", tool: "gated_thing", args: { label: "the-deed" } },
      { id: "read", tool: "pipe_read", args: { key: "never" } },
    ],
  });
  assertEquals(result.ok, false);
  assertStringIncludes(String(result.error), "gated_thing");
  assertStringIncludes(String(result.error), "gated capability");
  assertStringIncludes(String(result.error), "denied");
  assertEquals(calls.length, 1, "the denied step ran once (the pausing dispatch); the later step never dispatched");
});

Deno.test("run_pipeline: a $ref to a LATER step still fails closed before anything dispatches", async () => {
  const store = new Map<string, unknown>();
  const calls: Array<{ name: string; args: unknown }> = [];
  const bound = boundToolset(pipeRecords(store, calls));
  const result = await bound.tools.run_pipeline.execute({
    steps: [
      { id: "get", tool: "pipe_read", args: { key: { $ref: "set", path: "key" } } },
      { id: "set", tool: "pipe_write", args: { key: "colour", value: "blue" } },
    ],
  });
  assertEquals(result.ok, false);
  assertStringIncludes(String(result.error), "not an earlier step");
  assertEquals(calls.length, 0, "validation refused the whole pipeline before any dispatch");
});

Deno.test("run_pipeline: an unresolved binding halts mid-run and an unknown tool is an honest error", async () => {
  const store = new Map<string, unknown>();
  const calls: Array<{ name: string; args: unknown }> = [];
  const bound = boundToolset(pipeRecords(store, calls));
  const badPath = await bound.tools.run_pipeline.execute({
    steps: [
      { id: "set", tool: "pipe_write", args: { key: "colour", value: "blue" } },
      { id: "get", tool: "pipe_read", args: { key: { $ref: "set", path: "nope.missing" } } },
    ],
  });
  assertEquals(badPath.ok, false);
  assertStringIncludes(String(badPath.error), "did not resolve");
  assertEquals(calls.map((c) => c.name), ["pipe_write"], "the failing step halted the pipeline");

  const unknown = await bound.tools.run_pipeline.execute({
    steps: [{ id: "x", tool: "no_such_tool", args: {} }],
  });
  assertEquals(unknown.ok, false);
  assertStringIncludes(String(unknown.error), "no_such_tool");
});

Deno.test("run_pipeline: a step whose tool reports failure halts the pipeline (the nested failure is not a pass)", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const tools = {
    pipe_write: tool({
      description: "Write a value into the pipe store",
      inputSchema: z.object({ key: z.string(), value: z.string() }),
      execute: async ({ key, value }: { key: string; value: string }) => {
        calls.push({ name: "pipe_write", args: { key, value } });
        return { ok: false, error: "the store is read-only right now" };
      },
    }),
    pipe_read: tool({
      description: "Read a value from the pipe store",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }: { key: string }) => {
        calls.push({ name: "pipe_read", args: { key } });
        return { key, value: null };
      },
    }),
  };
  const bound2 = boundToolset(executableBuiltinToolRecords(tools, {
    version: "1.0.0",
    sourceGeneration: "extension:1",
    scope: HUB_SCOPE,
    capabilities: ["test.invoke"],
  }));
  const result = await bound2.tools.run_pipeline.execute({
    steps: [
      { id: "set", tool: "pipe_write", args: { key: "colour", value: "blue" } },
      { id: "get", tool: "pipe_read", args: { key: { $ref: "set", path: "key" } } },
    ],
  });
  assertEquals(result.ok, false);
  assertStringIncludes(String(result.error), "read-only");
  assertEquals(result.failedStep, "set");
  assertEquals(calls.map((c) => c.name), ["pipe_write"], "the failed step halted the pipeline before step 2");
});

Deno.test("run_pipeline: workflow_run and remote MCP tools can never be dispatched from a pipeline step", async () => {
  const store = new Map<string, unknown>();
  const calls: Array<{ name: string; args: unknown }> = [];
  const bound = boundToolset(pipeRecords(store, calls));
  const result = await bound.tools.run_pipeline.execute({
    steps: [
      { id: "set", tool: "pipe_write", args: { key: "colour", value: "blue" } },
      { id: "recurse", tool: "workflow_run", args: { name: "anything" } },
    ],
  });
  assertEquals(result.ok, false);
  assertStringIncludes(String(result.error), "cannot run inside a pipeline");
  assertEquals(calls.map((c) => c.name), ["pipe_write"], "the recursion guard refused before any search/dispatch of the step");
});

Deno.test("run_pipeline emits a step-start/step-end progress event per step for the plan strip", async () => {
  const store = new Map<string, unknown>();
  const calls: Array<{ name: string; args: unknown }> = [];
  const events: Array<Record<string, unknown>> = [];
  const bound = boundToolset(pipeRecords(store, calls), {
    context: runContext({
      onProgress: (ev: Record<string, unknown>) => {
        events.push(ev);
      },
    }),
  });
  const result = await bound.tools.run_pipeline.execute({
    name: "watched",
    steps: [
      { id: "set", tool: "pipe_write", args: { key: "colour", value: "blue" } },
      { id: "get", tool: "pipe_read", args: { key: { $ref: "set", path: "key" } } },
    ],
  });
  assertEquals(result.ok, true);
  assertEquals(events, [
    { type: "pipeline-step", status: "running", tool: "pipe_write", id: "set", index: 0, pipeline: "watched" },
    { type: "pipeline-step", status: "ok", tool: "pipe_write", id: "set", index: 0, pipeline: "watched" },
    { type: "pipeline-step", status: "running", tool: "pipe_read", id: "get", index: 1, pipeline: "watched" },
    { type: "pipeline-step", status: "ok", tool: "pipe_read", id: "get", index: 1, pipeline: "watched" },
  ]);
});

Deno.test("run_pipeline fails closed without a run context", async () => {
  const bound = createLazyProviderToolset({
    readSources: () => [],
    contextReader: () => null,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  }) as any;
  const result = await bound.tools.run_pipeline.execute({
    steps: [{ id: "x", tool: "pipe_read", args: { key: "k" } }],
  });
  assertEquals(result, { ok: false, error: "lazy-run-context-unavailable" });
});
