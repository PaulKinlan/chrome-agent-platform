// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { registerAcpModelHost } from "../extension/lib/acp-model-host.js";
import { createAcpModelProxy } from "../extension/lib/acp-model-proxy.js";

function event() { const listeners=[]; return {addListener:f=>listeners.push(f), emit:m=>listeners.forEach(f=>f(m))}; }
function ports(sender) {
  const a={name:"cap-acp-model:test",onMessage:event(),onDisconnect:event()};
  const b={...a,sender,onMessage:event(),onDisconnect:event()};
  a.postMessage=m=>queueMicrotask(()=>b.onMessage.emit(m));
  b.postMessage=m=>queueMicrotask(()=>a.onMessage.emit(m));
  let closed=false;
  a.disconnect=b.disconnect=()=>{if(closed)return;closed=true;a.onDisconnect.emit();b.onDisconnect.emit();};
  return [a,b];
}
Deno.test("ACP offscreen host rejects page/content senders before creating a backend", async () => {
  const runtime={id:"extension",getURL:p=>`chrome-extension://extension/${p}`,onConnect:event()};
  let made=0;
  registerAcpModelHost(runtime,()=>{made++;return {};});
  for(const sender of [{id:"other"},{id:"extension",url:runtime.getURL("ntp/ntp.html")},{id:"extension",tab:{id:1},url:runtime.getURL("dist/background/service-worker.js")}]) {
    const [a,b]=ports(sender);let disconnected=false;a.onDisconnect.addListener(()=>disconnected=true);
    runtime.onConnect.emit(b);assert(disconnected);
  }
  assertEquals(made,0);
});
Deno.test("ACP SW proxy carries model steps and scoped permission decisions, closes its host", async () => {
  const runtime={id:"extension",getURL:p=>`chrome-extension://extension/${p}`,onConnect:event()};
  let seen,choice,hostClosed=false;
  registerAcpModelHost(runtime, config => ({
    model: {
      async doStream(options) {
        seen = options;
        choice = await config.permissionHandler({title:"native write",options:[{optionId:"deny"}]});
        return {stream: new ReadableStream({start(c) {
          c.enqueue({type:"finish",finishReason:"stop",usage:{}});
          c.close();
        }})};
      },
    },
    close() { hostClosed = true; },
  }));
  const proxy=createAcpModelProxy({url:"ws://example.invalid/acp",harnessId:"codex",cwd:"",permissionHandler:async()=>"deny"},()=>{
    const [a,b]=ports({id:runtime.id,url:runtime.getURL("dist/background/service-worker.js")});runtime.onConnect.emit(b);return a;
  });
  const response=await proxy.model.doStream({prompt:[{role:"user",content:"test"}],tools:[]});
  const parts=[];for await(const part of response.stream)parts.push(part);
  assertEquals(choice,"deny");assertEquals(seen.prompt[0].content,"test");assertEquals(parts[0].finishReason,"stop");
  proxy.close();assert(hostClosed);
});
