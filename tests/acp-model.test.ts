// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createAcpModel } from "../extension/lib/acp-model.js";
import { createAcpRunPermissions } from "../extension/lib/acp-run-permissions.js";

Deno.test("ACP model routes harness calls through the real AI SDK execution and returns its result", async () => {
  let view, returned, executed = 0, clientClosed = false;
  const backend = createAcpModel({ harnessId: "claude-code", clientFactory: ({toolHandler}) => ({
    connect: async () => {}, initialize: async () => {}, newSession: async () => ({sessionId: "one"}),
    async prompt(_id, prompt, emit) {
      assert(prompt.includes("CAP policy"));
      view = await toolHandler("_cap/tools/list", {});
      await assertRejects(() => toolHandler("_cap/tools/call", {name: "not-a-run-tool"}), Error, "not available");
      returned = await toolHandler("_cap/tools/call", { name: "search_tools", arguments: { query: "tabs" } });
      emit({kind: "chunk", text: "harness received " + returned.content[0].text});
    },
    close() { clientClosed = true; },
  }) });
  try {
    const result = streamText({ model: backend.model, system: "CAP policy", prompt: "list tabs",
      stopWhen: stepCountIs(3), tools: {
        search_tools: tool({description: "Find CAP tools", inputSchema: z.object({query: z.string()}),
          execute({query}) { executed++; assertEquals(query, "tabs"); return {name: "list_tabs"}; }}),
      },
    });
    assert((await result.text).includes("list_tabs"));
    assertEquals(executed, 1);
    assertEquals(view.tools[0].name, "search_tools");
    assertEquals(view.tools[0].description, "Find CAP tools");
    assertEquals(view.tools[0].inputSchema.properties.query.type, "string");
    assert(returned.content[0].text.includes("list_tabs"));
  } finally { backend.close(); }
  assert(clientClosed);
});

Deno.test("ACP model cancellation closes harness and rejects its outstanding call", async () => {
  let invoke, callError, clientClosed = false;
  const ready = Promise.withResolvers();
  const backend = createAcpModel({ harnessId: "codex", clientFactory: ({toolHandler}) => ({
    connect: async () => {}, initialize: async () => {}, newSession: async () => ({sessionId: "one"}),
    async prompt() { invoke = toolHandler; ready.resolve(); await new Promise(() => {}); },
    close() { clientClosed = true; },
  }) });
  const controller = new AbortController();
  const response = await backend.model.doStream({ abortSignal: controller.signal, prompt: [], tools: [{type:"function",name:"search_tools",inputSchema:{type:"object"}}] });
  await ready.promise;
  const call = invoke("_cap/tools/call", {name:"search_tools",arguments:{}}).catch(e => { callError = e; });
  controller.abort(); await call;
  assert(clientClosed); assertEquals(callError.name, "AbortError");
  await assertRejects(() => invoke("_cap/tools/list", {}), Error, "no longer active");
  await response.stream.cancel();
});

Deno.test("ACP native permissions bind the live run and document, deny on timeout/cancel", async () => {
  const active = new Set(["run"]);
  const permissions = createAcpRunPermissions({ isActive: id => active.has(id), timeoutMs: 5 });
  let event;
  const request = { title:"write a file", options:[{optionId:"allow",kind:"allow_once"},{optionId:"deny",kind:"reject_once"}] };
  const args = { executionId:"run", documentId:"doc", harnessId:"Claude Code", request, emit:e => {event=e;} };
  const answer = permissions.ask(args); await Promise.resolve(); await Promise.resolve();
  assertEquals(event.request.title,"Claude Code: write a file");
  assertEquals(permissions.resolve(event.requestId,"allow",{principal:"extension",documentId:"other"}).ok,false);
  assertEquals(permissions.resolve(event.requestId,"deny",{principal:"extension",documentId:"doc"}).ok,true);
  assertEquals(await answer,"deny");
  assertEquals(await permissions.ask(args),"deny");
  const cancelled = permissions.ask(args); permissions.cancel("run"); assertEquals(await cancelled,"deny");
  active.clear(); assertEquals(await permissions.ask({...args,auto:true}),"deny");
});
