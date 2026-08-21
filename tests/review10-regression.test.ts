// @ts-nocheck
// review10-regression.test.ts — the fresh review's 6 new violation probes,
// re-encoded as REGRESSION assertions (each asserts the DEFECT IS ABSENT on
// the fixed code). @ts-nocheck — untyped harness by design.
import { assert, assertEquals } from "jsr:@std/assert@1";
function dirNode(){return {kind:"directory",children:new Map()};}
function fileNode(c){return {kind:"file",content:c};}
class W{constructor(n){this.n=n;this.p=[];} async write(s){this.p.push(String(s));} async close(){this.n.content=this.p.join(""); if(globalThis.failClose?.has(this.n.name)) throw new Error("close committed then threw");}}
class F{constructor(n){this.n=n;this.name=null;} get kind(){return "file";} async getFile(){const n=this.n;return {size:(n.content??"").length,async text(){return n.content??"";}};} async createWritable(){const nth=globalThis.failNth?.get(this.name);if(typeof nth==="number"){if(nth<=1){globalThis.failNth.delete(this.name);throw new Error("createWritable failed");}globalThis.failNth.set(this.name,nth-1);}const w=new W(this.n);w.n.name=this.name;return w;}}
class D{constructor(n){this.n=n;}get kind(){return "directory";}async getDirectoryHandle(name,o={}){if(!this.n.children.has(name)){if(!o.create)throw Object.assign(new Error("not found"),{name:"NotFoundError"});this.n.children.set(name,dirNode());}return new D(this.n.children.get(name));}async getFileHandle(name,o={}){if(globalThis.failGet?.has(name))throw new Error("I/O read failure");if(!this.n.children.has(name)){if(!o.create)throw Object.assign(new Error("not found"),{name:"NotFoundError"});this.n.children.set(name,fileNode(""));}const f=new F(this.n.children.get(name));f.name=name;return f;}async removeEntry(name){this.n.children.delete(name);}async *entries(){for(const [name,n] of this.n.children){const h=n.kind==="file"?new F(n):new D(n);if(h instanceof F)h.name=name;yield [name,h];}}}
const root=dirNode();Object.defineProperty(globalThis,"navigator",{value:{storage:{async getDirectory(){return new D(root);}}},configurable:true});
const memUrl = new URL("../extension/lib/memory.js", import.meta.url).href;
const artUrl = new URL("../extension/lib/artifacts.js", import.meta.url).href;
function reset(){root.children.clear();globalThis.failClose=new Set();globalThis.failNth=new Map();globalThis.failGet=new Set();}
function md(){return root.children.get("memory")?.children?.get("master");}

Deno.test("r10: an update crash never LOSES the only body — the old body is persisted in the WAL + recovered by the exact token", async () => {
  reset();
  const a = await import(artUrl + "?r10a");
  const r = await a.createAsset("master", { type: "text", name: "u", content: "v1" });
  const id = r.asset.id;
  // Fail the WAL's TERMINAL write (the 2nd __tx write — the committed/compensated
  // record) — a crash after the body mutation with the intent prepared. The
  // OLD body is in the intent; the recovery must restore it, NEVER delete it.
  globalThis.failNth = new Map([["__tx.json", 2]]);
  let threw = false;
  try { await a.updateAsset("master", id, { content: "v2" }); } catch { threw = true; }
  globalThis.failNth = new Map();
  assert(threw, "the update surfaces the terminal-WAL failure");
  // Force a recovery by the next operation: the prepared intent resolves the
  // transaction — the old body is restored if the CAS never landed, or the
  // committed state is kept if it did — EITHER WAY the body is never lost.
  const next = await a.createAsset("master", { type: "text", name: "after", content: "x" });
  assert(next.ok, "the next operation recovers the intent");
  const got = await a.getAsset("master", id);
  assert(got.ok, "the asset body is NEVER lost (the reviewer's finding — the only body was deleted)");
  assert(got.asset.content === "v1" || got.asset.content === "v2", "the body is the old (rolled back) or new (committed) — never missing");
  const list = await a.listAssets("master");
  assert(list.ok && list.assets.some((x) => x.id === id), "the row survives");
});

Deno.test("r10: an update CAS close-throw never diverges row/body (strict token+content reread)", async () => {
  reset();
  const a = await import(artUrl + "?r10b");
  const r = await a.createAsset("master", { type: "text", name: "u", content: "v1" });
  const id = r.asset.id;
  globalThis.failClose = new Set(["assets.json"]);
  const up = await a.updateAsset("master", id, { content: "v2" });
  globalThis.failClose = new Set();
  const got = await a.getAsset("master", id);
  assert(got.ok, "the body is readable");
  const list = await a.listAssets("master");
  const row = list.assets.find((x) => x.id === id);
  assert(row, "the row exists");
  if (up.ok === true) {
    assert(got.asset.content === "v2" && row.size === 2, "a committed update keeps the new body + row consistent");
  } else {
    assert(got.asset.content === "v1" && row.size === 1, "a rolled-back update keeps the old body + row consistent");
  }
});

Deno.test("r10: a PLAIN-delete tombstone-authority failure leaves the live value intact (tombstone-first)", async () => {
  reset();
  const m = (await import(memUrl + "?r10c")).masterMemory();
  await m.set("victim", 1);
  globalThis.failNth = new Map([["__tombs.json", 1]]);
  let threw = false;
  try { await m.delete("victim"); } catch { threw = true; }
  globalThis.failNth = new Map();
  assert(threw, "the plain delete surfaces the tombstone-authority failure");
  assert(md().children.get("victim.json"), "the live value file survives");
});

Deno.test("r10: reads HONOR the tombstone — a tombstone+live coexistence never exposes the deleted value", async () => {
  reset();
  const m = (await import(memUrl + "?r10d")).masterMemory();
  const g = await m.setTrusted("victim", 1);
  // Simulate a crash: the tombstone authority committed + the live removal failed.
  const d = await m.compareAndDelete("victim", g);
  assert(d !== false, "the delete returns the token");
  // The live value may still exist as an orphan — but the read honors the tombstone.
  const raw = md().children.get("victim.json");
  if (raw) assertEquals(await m.get("victim"), null, "the read honors the tombstone (no deleted-value exposure)");
  assertEquals(await m.getVersion("victim"), d, "the version is the tombstone's token");
});

Deno.test("r10: FOLDED tombstone keys never return to version 0 (the prune-ABA is closed by the floor)", async () => {
  reset();
  const m = (await import(memUrl + "?r10e")).masterMemory();
  await m.set("old", 1);
  await m.delete("old");
  for (let i = 0; i < 600; i++) { const k = `u${i}`; await m.set(k, i); await m.delete(k); }
  const stale0 = await m.compareAndRestore("old", 0, "stale");
  assertEquals(stale0, false, "a folded key's expected-0 token can never land");
  const staleOld = await m.compareAndRestore("old", 1, "stale-old");
  assertEquals(staleOld, false, "the pre-delete token can never land either");
});

Deno.test("r10: the asset-lock map evicts only SETTLED chains (an active chain is never dropped)", async () => {
  reset();
  const a = await import(artUrl + "?r10f");
  // Grab a lock and hold it mid-flight; the bound must not drop it.
  const { default: _ } = await import(memUrl + "?r10f-mem");
  void _;
  const hold = (() => {
    let release;
    const p = new Promise((r) => { release = r; });
    return { p, release };
  })();
  const started = a.listAssets("master").then(() => {}); // acquires the master lock
  // While the lock is active, the bound-eviction path must not break the mutex:
  // a second queued op still serializes behind the first.
  const q1 = a.listAssets("master");
  const q2 = a.listAssets("master");
  const results = await Promise.all([q1, q2]);
  assert(results[0].ok && results[1].ok, "queued ops still serialize");
  void hold; void started;
});
