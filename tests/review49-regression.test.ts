// @ts-nocheck
// review49-regression.test.ts — the reviewer's 10 violation probes, re-encoded
// as REGRESSION assertions: each asserts the DEFECT IS ABSENT on the fixed
// code (the external harness reproduced the defects; this suite proves they
// are closed). @ts-nocheck — untyped harness by design.
import { assert, assertEquals } from "jsr:@std/assert@1";
function dirNode(){return {kind:"directory",children:new Map()};}
function fileNode(c){return {kind:"file",content:c};}
class W{constructor(n){this.n=n;this.p=[];} async write(s){this.p.push(String(s));} async close(){this.n.content=this.p.join(""); if(globalThis.failClose?.has(this.n.name)) throw new Error("close committed then threw");}}
class F{constructor(n){this.n=n;this.name=null;} get kind(){return "file";} async getFile(){const n=this.n;return {size:(n.content??"").length,async text(){return n.content??"";}};} async createWritable(){const nth=globalThis.failNth?.get(this.name);if(typeof nth==="number"){if(nth<=1){globalThis.failNth.delete(this.name);throw new Error("createWritable failed");}globalThis.failNth.set(this.name,nth-1);}const w=new W(this.n);w.n.name=this.name;return w;}}
class D{constructor(n){this.n=n;}get kind(){return "directory";}async getDirectoryHandle(name,o={}){if(!this.n.children.has(name)){if(!o.create)throw Object.assign(new Error("not found"),{name:"NotFoundError"});this.n.children.set(name,dirNode());}return new D(this.n.children.get(name));}async getFileHandle(name,o={}){if(globalThis.failGet?.has(name))throw new Error("I/O read failure");if(!this.n.children.has(name)){if(!o.create)throw Object.assign(new Error("not found"),{name:"NotFoundError"});this.n.children.set(name,fileNode(""));}const f=new F(this.n.children.get(name));f.name=name;return f;}async removeEntry(name){this.n.children.delete(name);}async *entries(){for(const [name,n] of this.n.children){const h=n.kind==="file"?new F(n):new D(n);if(h instanceof F)h.name=name;yield [name,h];}}}
const root=dirNode();Object.defineProperty(globalThis,"navigator",{value:{storage:{async getDirectory(){return new D(root);}}},configurable:true});
const memUrl="file:///tmp/cap-artifact-tx-current-main/extension/lib/memory.js";
const artUrl="file:///tmp/cap-artifact-tx-current-main/extension/lib/artifacts.js";
function reset(){root.children.clear();globalThis.failClose=new Set();globalThis.failNth=new Map();globalThis.failGet=new Set();}
function md(){return root.children.get("memory")?.children?.get("master");}
function bodies(){return [...(md()?.children.keys()??[])].filter(n=>n.startsWith("asset:")&&n.endsWith(".json")).length;}

Deno.test("regress: no orphan survives a WAL-token gap crash (the body→token gap is closed)", async () => {
  reset();
  const a = await import(artUrl + "?reg1");
  globalThis.failNth = new Map([["__tx.json", 2]]); // the exact-token WAL write fails
  let threw = false;
  try { await a.createAsset("master", { type: "text", name: "first", content: "x" }); } catch { threw = true; }
  assert(threw, "the create surfaces the WAL failure");
  assertEquals(bodies(), 0, "the orphan body was compensated by its exact token");
  globalThis.failNth = new Map();
  const next = await a.createAsset("master", { type: "text", name: "next", content: "y" });
  assert(next.ok);
  assertEquals(bodies(), 1, "no orphan survives recovery");
});

Deno.test("regress: a CAS commit-then-close-throw keeps the row WITH its body (no split)", async () => {
  reset();
  const a = await import(artUrl + "?reg2");
  globalThis.failClose = new Set(["assets.json"]);
  let threw = false;
  try { await a.createAsset("master", { type: "text", name: "dead-row", content: "x" }); } catch { threw = true; }
  assert(threw, "the create surfaces the close failure");
  globalThis.failClose = new Set();
  const next = await a.createAsset("master", { type: "text", name: "next", content: "y" });
  assert(next.ok);
  const list = await a.listAssets("master");
  const dead = list.assets.find((x) => x.name === "dead-row");
  assert(dead, "the committed row survives");
  assertEquals((await a.getAsset("master", dead.id)).ok, true, "the row HAS its body (no split)");
});

Deno.test("regress: an unreadable WAL FAILS the operation (never swallowed as absent)", async () => {
  reset();
  const m = (await import(memUrl + "?reg3")).masterMemory();
  await m.setTrusted("asset:old", { content: "orphan" });
  await m.setTrusted("__tx", { op: "create", id: "old", bodyGen: await m.getVersion("asset:old"), state: "prepared" });
  globalThis.failGet = new Set(["__tx.json"]);
  const a = await import(artUrl + "?reg3-art");
  let failed = false;
  try { await a.createAsset("master", { type: "text", name: "new", content: "n" }); } catch { failed = true; }
  globalThis.failGet = new Set();
  assert(failed, "an unreadable WAL refuses the operation");
});

Deno.test("regress: a tombstone failure does NOT remove the live value or reset authority", async () => {
  reset();
  const m = (await import(memUrl + "?reg4")).masterMemory();
  const g = await m.setTrusted("victim", 1);
  globalThis.failNth = new Map([["__tombs.json", 1]]); // the bounded tombstone authority write fails
  let threw = false;
  try { await m.compareAndDelete("victim", g); } catch { threw = true; }
  assert(threw, "the delete surfaces the tombstone-authority failure");
  // The live VALUE file survives (the tombstone authority is written FIRST —
  // a failure leaves the value intact).
  const rawValue = md()?.children.get("victim.json")?.content;
  assert(rawValue, "the live value file survives the tombstone-authority failure");
  // The partially-written (empty) tombstone authority is DETECTED as corrupt —
  // the authority fails closed (never a reset to 0).
  let corrupt = false;
  try { await m.getVersion("victim"); } catch { corrupt = true; }
  assert(corrupt, "the corrupt tombstone authority fails closed (never version 0)");
});

Deno.test("regress: corrupt generation FAILS CLOSED + unsafe max is refused", async () => {
  reset();
  const m = (await import(memUrl + "?reg5")).masterMemory();
  const g1 = await m.setTrusted("a", 1);
  assertEquals(g1, 1);
  md().children.get("__gen.json").content = "{";
  let corruptFailed = false;
  try { await m.setTrusted("b", 2); } catch { corruptFailed = true; }
  assert(corruptFailed, "a corrupt authority fails closed (never resets)");
  md().children.get("__gen.json").content = JSON.stringify({ gen: Number.MAX_SAFE_INTEGER });
  let unsafeFailed = false;
  try { await m.setTrusted("c", 3); } catch { unsafeFailed = true; }
  assert(unsafeFailed, "the exhausted authority is refused (never issues an unsafe token)");
});

Deno.test("regress: internal records are NOT model-readable/listed + __epoch is reserved", async () => {
  reset();
  const m = (await import(memUrl + "?reg6")).masterMemory();
  await m.setTrusted("__tx", { state: "prepared", secret: "wal" });
  await m.setTrusted("assetRepair", { pendingDeletes: [], pendingRestores: [] });
  await m.setTrusted("asset:x", { content: "body" });
  let epochRefused = false;
  try { await m.set("__epoch", { gen: -1 }); } catch { epochRefused = true; }
  assert(epochRefused, "__epoch is reserved");
  const keys = await m.keys();
  for (const k of ["__tx", "assetRepair", "asset:x", "__epoch"]) {
    assert(!keys.includes(k), `${k} is hidden from listing`);
  }
  let getRefused = false;
  try { await m.get("__tx"); } catch { getRefused = true; }
  assert(getRefused, "the internal authority is not readable");
});

Deno.test("regress: a corrupt WAL schema FAILS the operation (never silently finalized)", async () => {
  reset();
  const m = (await import(memUrl + "?reg7")).masterMemory();
  await m.setTrusted("__tx", { op: "future-or-corrupt", state: "prepared", id: { not: "string" } });
  const a = await import(artUrl + "?reg7-art");
  let failed = false;
  try { await a.createAsset("master", { type: "text", name: "next", content: "x" }); } catch { failed = true; }
  assert(failed, "a corrupt WAL intent fails the operation");
});

Deno.test("regress: tombstones are BOUNDED (pruned beyond the retention cap)", async () => {
  reset();
  const m = (await import(memUrl + "?reg8")).masterMemory();
  for (let i = 0; i < 600; i++) { const k = `u${i}`; await m.set(k, i); await m.delete(k); }
  const tombs = [...md().children.keys()].filter((n) => n.endsWith(".json.tomb"));
  assert(tombs.length <= 512, `tombstones are bounded (${tombs.length})`);
});

Deno.test("regress: clear does NOT reopen stale expected-0 per-key ABA (removed keys are tombstoned)", async () => {
  reset();
  const m = (await import(memUrl + "?reg9")).masterMemory();
  const stale0 = await m.getVersion("k");
  assertEquals(stale0, 0);
  await m.set("k", "live");
  await m.clear();
  const restored = await m.compareAndRestore("k", stale0, "stale");
  assertEquals(restored, false, "a stale never-created authority cannot land after create+clear");
});
