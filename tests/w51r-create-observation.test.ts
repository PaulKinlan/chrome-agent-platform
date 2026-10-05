import {assert, assertEquals} from "jsr:@std/assert@1";
// PROMOTION (chrome-agent-platform-g725): the staged counter test imported the
// driver and a focused.ts helper by ABSOLUTE custody paths. The driver is now the
// repo copy (byte-identical to the staged candidate) and the two imports the test
// never uses — acorn's parse and focused.ts's click — are dropped. The test body
// is otherwise unchanged from initial-create-integrity-counter.test.ts.
import {createObservation, observePage, safePage, safeError, observationExitCode} from "../cap-evidence/w51r-create-observation.ts";
const SECRET = "PRIVATE_OBSERVATION_SENTINEL";
const EXT = "a".repeat(32), TARGET = "B".repeat(32);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
function safe(v: unknown) { assert(!JSON.stringify(v).includes(SECRET), "observation must never disclose the sentinel"); }
function fixture() {
  const rect = {x:10,y:20,width:30,height:20};
  const button: any = {isConnected:true,disabled:false,style:{display:"block",visibility:"visible",opacity:"1"},getBoundingClientRect:()=>rect,closest:()=>null,contains:(e:any)=>e===svg};
  const svg = {};
  const inner: any = {open:true,style:{display:"flex",visibility:"visible",opacity:"1"},matches:(s:string)=>s===":modal" && inner.open,getBoundingClientRect:()=>({x:100,y:120,width:540,height:600})};
  let hostBoxReads = 0;
  const host: any = {localName:"agent-dialog",title:"Create an agent",show(){},get open(){return inner.open;},getBoundingClientRect(){hostBoxReads++;return {x:0,y:0,width:0,height:0};},
    shadowRoot:{querySelector:()=>inner},getAttribute:()=>host.title,
    querySelectorAll:(q:string)=>q==="label" ? ["Name","What it does"].map(t=>({firstElementChild:{textContent:t},querySelector:()=>({})})) : [{textContent:"Create agent"}]};
  const listeners=new Map<string,Set<(e:any)=>void>>();
  const doc: any={readyState:"complete",visibilityState:"visible",hasFocus:()=>true,getElementById:()=>button,
    querySelectorAll:()=>hosts,elementFromPoint:()=>button,
    addEventListener:(type:string,fn:(e:any)=>void,capture:boolean)=>{assert(capture);if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(fn);},
    removeEventListener:(type:string,fn:(e:any)=>void)=>listeners.get(type)?.delete(fn)};
  const hosts:any[]=[host];
  const env:any={document:doc,location:{pathname:"/ntp/ntp.html",protocol:"chrome-extension:",hostname:EXT},customElements:{get:()=>function FakeDefinition(){}},HTMLDialogElement:function FakeNativeSupport(){},getComputedStyle:(e:any)=>e.style,performance:{getEntriesByName:(name:string,type:string)=>{assertEquals(name,"cap:ntp:boot_composer-ready");assertEquals(type,"measure");return [{}];}}};
  const emit=(type:string,values:any={})=>{for(const fn of listeners.get(type)??[])fn({type,target:host,isTrusted:false,composedPath:()=>[],...values});};
  return {env,doc,hosts,host,inner,button,svg,emit,listeners,hostBoxReads:()=>hostBoxReads};
}
function page(f=fixture()) { observePage("install",{extensionId:EXT},f.env);return f; }
function current(f:ReturnType<typeof fixture>) { const p=safePage(observePage("sample",null,f.env));assert(p);assert(p.records.length > 0,"actual sampling must retain state");safe(p);return p; }
function harness() {
  const f=fixture(), writes:{name:string;value:any}[]=[], events:string[]=[], sends:any[]=[];
  let listener:(p:any,s:any)=>void=()=>{};
  const controls={badPage:false,writeFailure:"",screenshotFailure:false,pngFailure:false};
  const client:any={on:(kind:string,fn:any)=>{assertEquals(kind,"Runtime.exceptionThrown");listener=fn;return()=>events.push("unsubscribe");},
    eval:(_session:string,expression:string)=>{
      const prefix=`(${observePage.toString()})`;
      if(expression.startsWith(prefix)){
        const args=JSON.parse(`[${expression.slice(prefix.length+1,-1)}]`);events.push(`page:${args[0]}`);
        if(controls.badPage)return {secret:SECRET};
        return structuredClone(observePage(args[0],args[1],f.env));
      }
      assert(expression.includes("scrollIntoView") && expression.includes("getBoundingClientRect"),"actual click geometry expression");
      events.push("geometry");return {x:25,y:30};
    },
    send:(method:string,params:any,session:string)=>{
      events.push(method);sends.push({method,params,session});
      if(method==="Page.captureScreenshot") {if(controls.screenshotFailure)throw new Error(SECRET);return {result:{data:PNG}};}
      assertEquals(method,"Input.dispatchMouseEvent");return {};
    }};
  const observer=createObservation(client,EXT,async(name,value)=>{events.push(`write:${name}`);safe(value);if(controls.writeFailure===name)throw new Error(SECRET);writes.push({name,value:structuredClone(value)});},async(bytes)=>{events.push("png");if(controls.pngFailure)throw new Error(SECRET);assert(bytes.length>8);});
  const original={code:1,error:{name:"Error",message:"controlled behavior failure"},rows:[]};
  const persist=async()=>{events.push("original");writes.push({name:"behavior-outcome.json",value:structuredClone(original)});};
  return {...f,client,observer,events,writes,sends,controls,original,persist,emitError:(p:any,s="session")=>listener(p,s)};
}


Deno.test("parent: clean Create plus clean later failure capture is complete",async()=>{
 const h=harness();await h.observer.bind("session",TARGET);await h.observer.endCreate();h.hosts.length=0;
 const result=await h.observer.finish(true,h.persist);assert(result.complete);
});
Deno.test("parent: initial Create overflow must survive a later clean failure capture",async()=>{
 const h=harness();await h.observer.bind("session",TARGET);
 for(let i=0;i<40;i++){h.inner.open=!h.inner.open;await h.observer.sample();}
 await h.observer.endCreate();h.hosts.length=0;
 const result=await h.observer.finish(true,h.persist);
 const state=h.writes.find(w=>w.name==="observation-state.json")!.value;
 assert(state.createPage.overflow,"fixture must retain real initial overflow");assert(!state.failurePage.overflow,"fresh capture must be clean");
 assertEquals(result.complete,false,"later clean capture must not erase initial Create overflow");
});
Deno.test("parent: initial Create unreadability must survive a later clean failure capture",async()=>{
 const h=harness();await h.observer.bind("session",TARGET);
 const descriptor=Object.getOwnPropertyDescriptor(h.host,"open")!;
 Object.defineProperty(h.host,"open",{configurable:true,get(){throw new Error(SECRET);}});
 await h.observer.sample();Object.defineProperty(h.host,"open",descriptor);
 await h.observer.endCreate();h.hosts.length=0;
 const result=await h.observer.finish(true,h.persist);
 const state=h.writes.find(w=>w.name==="observation-state.json")!.value;
 assert(state.createPage.incomplete,"fixture must retain actual initial unreadability");assert(!state.failurePage.incomplete,"fresh capture must be readable");
 assertEquals(result.complete,false,"later clean capture must not erase initial Create unreadability");
});
