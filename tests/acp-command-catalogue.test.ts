// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { AcpClient } from "../extension/lib/acp-client.js";
import { createAcpModel } from "../extension/lib/acp-model.js";
import { acpRunConfig } from "../extension/lib/acp-run-config.js";
import { harnessCommandItems } from "../extension/shared/composer-commands.js";

Deno.test("ACP catalogue receives startup frames before a prompt and fences session replacement", async () => {
  const seen = [];
  let session = "first";
  const commands = [{ name: "skill:probe" }];
  const notify = (id, list) => client.handleMessage({method:"session/update",params:{sessionId:id,update:{sessionUpdate:"available_commands_update",availableCommands:list}}});
  const client = new AcpClient({ onCommands: list => seen.push(list), transport: {send(raw) {
    const request = JSON.parse(raw);
    assertEquals(request.method, "session/new");
    notify(session, commands);
    client.handleMessage({id:request.id,result:{sessionId:session}});
  }}});
  await client.connect();
  await client.newSession();
  assertEquals(client.commandsReceived, true);
  assertEquals(seen, [commands]);
  notify("foreign", [{name:"wrong"}]);
  assertEquals(client.availableCommands, commands);
  notify("first", []);
  assertEquals(client.availableCommands, []);
  assert(client.commandsReceived);
  session = "replacement";
  await client.newSession();
  notify("first", [{name:"stale"}]);
  assertEquals(client.availableCommands, commands);
  client.close();
  assertEquals(client.availableCommands, []);
  assertEquals(client.commandsReceived, false);
});

Deno.test("ACP discovery reuses initialization without prompt, tool mount or permission grant", async () => {
  const calls = [];
  let options, closed = false;
  const client = {commandsReceived:true,availableCommands:[{name:"$probe"}],
    connect:async()=>{calls.push("connect");}, initialize:async cap=>{calls.push(cap);},
    newSession:async()=>({sessionId:"discovery"}), prompt:()=>{throw Error("must not prompt");}, close:()=>{closed=true;}};
  const backend = createAcpModel({harnessId:"codex",clientFactory:o=>{options=o;return client;}});
  assertEquals(await backend.discoverCommands(), {sessionId:"discovery",received:true,commands:[{name:"$probe"}]});
  assertEquals(calls, ["connect", {}]);
  assertEquals(options.toolHandler, null);
  assertEquals(await options.permissionHandler({options:[{optionId:"allow"}]}), null);
  backend.close(); assert(closed);
});

Deno.test("ACP discovery distinguishes a missing catalogue from an advertised empty one", async () => {
  const client = {commandsReceived:false,availableCommands:[],connect:async()=>{},initialize:async()=>{},newSession:async()=>({sessionId:"s"}),close:()=>{}};
  const backend = createAcpModel({clientFactory:()=>client});
  const missing = await backend.discoverCommands(1);
  assertEquals(missing.received, false);
  backend.close();
});

Deno.test("ACP picker preserves harness sigils, argument hints, and refuses command actions", () => {
  const commands = [{name:"skill:probe",description:"Pi"},{name:"probe",input:{hint:"argument"}},{name:"$probe"},{name:"/ready"},{name:"bad\nname"},{name:"plan",_meta:{commandAction:{kind:"setConfigOption"}}}];
  const items = harnessCommandItems(commands);
  assertEquals(items.map(i=>i.id), ["/skill:probe","/probe","$probe","/ready","/plan"]);
  assertEquals(items[1].description, "argument");
  assertEquals(items[4].disabled, true);
  assertEquals(harnessCommandItems(commands, "$p").map(i=>i.id), ["$probe"]);
  assertEquals(harnessCommandItems(commands, "/sk").map(i=>i.id), ["/skill:probe"]);
  assertEquals(harnessCommandItems(commands, "/absent"), []);
});

Deno.test("Pi command discovery does not weaken the CAP tools execution refusal", async () => {
  const read = async()=>"";
  assertEquals((await acpRunConfig("pi",read,{discovery:true})).harnessId,"pi");
  await assertRejects(()=>acpRunConfig("pi",read),Error,"does not mount CAP tools");
});
