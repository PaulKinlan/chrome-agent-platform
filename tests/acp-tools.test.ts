// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createAcpTools, acpToolChannel } from "../scripts/lib/acp-tools.ts";

Deno.test("CAP tool transport authenticates, preserves schemas/results, and revokes on close", async () => {
  const calls = [];
  const endpoint = await createAcpTools(async (method, params) => {
    calls.push({method,params});
    if (method === "_cap/tools/list") return {tools:[{name:"search_tools",description:"Search existing CAP tools",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]};
    return {content:[{type:"text",text:'{"ok":false,"error":"Owner denied"}'}]};
  });
  const config = endpoint.config("http://localhost/cap-tools/test");
  const headers = {"content-type":"application/json",accept:"application/json, text/event-stream",authorization:config.headers[0].value};
  let session;
  const send = (body, extra = {}) => endpoint.handle(new Request(config.url,{method:"POST",headers:{...headers,...(session?{"mcp-session-id":session}:{}),...extra},body:JSON.stringify(body)}));
  try {
    const init = {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"harness",version:"1"}}};
    assertEquals((await send(init,{authorization:"Bearer wrong"})).status,403);
    assertEquals((await send(init,{origin:"https://attacker.example"})).status,403);
    assertEquals(calls.length,0);
    const response = await send(init); assertEquals(response.status,200); session=response.headers.get("mcp-session-id"); assert(session); await response.json();
    const listed = await (await send({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})).json();
    assertEquals(listed.result.tools[0].name,"search_tools");
    assertEquals(listed.result.tools[0].inputSchema.required,["query"]);
    const result=await (await send({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"search_tools",arguments:{query:"tabs"}}})).json();
    assertEquals(JSON.parse(result.result.content[0].text).error,"Owner denied");
    assertEquals(calls[1].params.arguments,{query:"tabs"});
  } finally { await endpoint.close(); }
  assertEquals((await send({jsonrpc:"2.0",id:4,method:"tools/list"})).status,403);
});

Deno.test("CAP reverse requests correlate only on their connection and reject on disconnect", async () => {
  const sent = [];
  const channel = acpToolChannel(raw => sent.push(JSON.parse(raw)));
  const other = acpToolChannel(() => {});
  const result = channel.call("_cap/tools/list",{});
  other.receive({id:sent[0].id,result:{tools:["foreign"]}});
  channel.receive({id:sent[0].id,result:{tools:["ours"]}});
  assertEquals(await result,{tools:["ours"]});
  assertEquals(channel.receive({id:1,result:{}}),false);
  const waiting = channel.call("_cap/tools/call",{});
  channel.close();
  await assertRejects(() => waiting,Error,"disconnected");
  await assertRejects(() => channel.call("_cap/tools/list",{}),Error,"disconnected");
  other.close();
});
