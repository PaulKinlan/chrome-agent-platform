// artifact-body-capacity.test.ts — chrome-agent-platform-p45y (r4 review).
// Falsification tests named by the independent review (gpt-5.6-sol:high):
//
//   P1-a  The advertised 256 KiB create limit must actually STORE: a create at
//         the exact 262,144-UTF-8-byte cap round-trips through the real store
//         (the legacy code accepted it in boundAssetMeta and then failed the
//         memory store's serialized-value bound by the JSON quotes). Both an
//         ASCII exact-cap body and a multibyte/escaping boundary body must
//         store byte-for-byte.
//   P1-b  The mandatory append write path: appending across calls grows ONE
//         artifact past the 256 KiB single-call cap; each call is bounded;
//         edit/restore still work on the grown body.
//   P2    The artifact inspector must not synchronously tokenize/render an
//         oversized or corrupt body: highlighting is disabled above the valid
//         artifact limit and multi-MB bodies are refused from DOM mount.
//
// RED on the pre-fix code: the exact-cap creates throw the memory store's
// "exceeds the 262144-byte bound"; appendAsset does not exist.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  APPEND_MAX_BYTES,
  appendAsset,
  createAsset,
  getAsset,
  getAssetVersion,
  listAssetVersions,
  patchAsset,
  restoreAssetVersion,
} from "../extension/lib/artifacts.js";

// ---- minimal OPFS fake over the REAL memory store (same harness as
// artifact-tx.test.ts — the value cap under test lives in memory.js). ----
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(c) { return { kind: "file", content: c }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; this.name = null; }
  get kind() { return "file"; }
  async getFile() { const n = this.node; return { size: (n?.content ?? "").length, async text() { return n?.content ?? ""; } }; }
  async createWritable() { const w = new FakeWritable(this.node); w.node.name = this.name; return w; }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) { if (!opts.create) throw new Error(`not found: ${name}`); this.node.children.set(name, dirNode()); }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) { if (!opts.create) throw new Error(`not found: ${name}`); this.node.children.set(name, fileNode("")); }
    const fh = new FakeFileHandle(this.node.children.get(name));
    fh.name = name;
    return fh;
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [n, node] of this.node.children) yield [n, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true, writable: true,
});
function resetStore() { root.children.clear(); }
resetStore();

const utf8 = (s) => new TextEncoder().encode(s).byteLength;
const EXACT_CAP = 256 * 1024; // the advertised maxAssetContentUtf8Bytes

/** An EXACTLY-262144-UTF-8-byte ASCII body (no chars JSON escapes). */
function asciiExactCap() {
  return "x".repeat(EXACT_CAP); // 1 byte per char
}

/** An EXACTLY-262144-UTF-8-byte body mixing multibyte chars (kept verbatim by
 * JSON) with quotes/backslashes/control chars (each doubled by JSON escaping):
 * the boundary must STORE byte-for-byte regardless of escaping. */
function escapingExactCap() {
  // é=2B, "=1B, \\=1B, 中=3B, \n=1B (JSON escapes it) → 8 UTF-8 bytes per repeat.
  const piece = 'é"\\中\n';
  const per = utf8(piece); // 8
  const s = piece.repeat(Math.floor((EXACT_CAP - 64) / per));
  return s + "x".repeat(EXACT_CAP - utf8(s)); // pad with ASCII to the EXACT byte cap
}

Deno.test("artifact body: a create at the exact 262144-byte advertised cap STORES and round-trips (ASCII)", async () => {
  resetStore();
  const content = asciiExactCap();
  assertEquals(utf8(content), EXACT_CAP, "the sample is exactly at the advertised cap");
  const r = await createAsset("master", { type: "text", name: "exact-cap", content });
  assert(r.ok === true, `exact-cap create must succeed, got ${JSON.stringify(r).slice(0, 300)}`);
  const got = await getAsset("master", r.asset?.id ?? r.id);
  assert(got.ok === true && got.asset?.content === content, "the exact-cap body round-trips byte-for-byte");
  assertEquals(utf8(got.asset.content), EXACT_CAP, "the stored body is still exactly at the cap");
});

Deno.test("artifact body: a multibyte + JSON-escaping boundary body at the exact cap STORES byte-for-byte", async () => {
  resetStore();
  const content = escapingExactCap();
  assertEquals(utf8(content), EXACT_CAP, "the sample is exactly at the advertised cap in UTF-8 bytes");
  assert(content.includes('中') && content.includes('"') && content.includes("\\"), "the sample mixes multibyte + escaping chars");
  const r = await createAsset("master", { type: "html", name: "escaping-cap", content });
  assert(r.ok === true, `escaping exact-cap create must succeed, got ${JSON.stringify(r).slice(0, 300)}`);
  const got = await getAsset("master", r.asset?.id ?? r.id);
  assert(got.ok === true && got.asset?.content === content, "the escaping boundary body round-trips byte-for-byte");
});

Deno.test("artifact append: repeated appends grow ONE artifact past the 256 KiB single-call cap and stay byte-exact", async () => {
  resetStore();
  const base = "a".repeat(200 * 1024);
  const r0 = await createAsset("master", { type: "text", name: "grow", content: base });
  assert(r0.ok === true, "the base create succeeds");
  const id = r0.asset?.id ?? r0.id;

  const a1 = await appendAsset("master", id, "b".repeat(30 * 1024));
  assert(a1.ok === true, `first append succeeds, got ${JSON.stringify(a1).slice(0, 300)}`);
  const a2 = await appendAsset("master", id, "c".repeat(40 * 1024));
  assert(a2.ok === true, `second append succeeds, got ${JSON.stringify(a2).slice(0, 300)}`);

  const total = 200 * 1024 + 30 * 1024 + 40 * 1024;
  assert(total > EXACT_CAP, "the grown body exceeds the single-call cap");
  const got = await getAsset("master", id);
  assert(got.ok === true, "the grown artifact reads back");
  assertEquals(utf8(got.asset.content), total, "the grown body is complete");
  assert(got.asset.content.startsWith(base), "the original body is intact at the head");
  assert(got.asset.content.endsWith("c".repeat(40 * 1024)), "the last append is intact at the tail");

  const versions = await listAssetVersions("master", id);
  assert(versions.ok === true && versions.head >= 3, "each append is an immutable version");
});

Deno.test("artifact append: a per-call append over the 64 KiB bound is refused without mutating", async () => {
  resetStore();
  const r0 = await createAsset("master", { type: "text", name: "bounded-append", content: "head" });
  assert(r0.ok === true);
  const before = await getAsset("master", r0.asset?.id ?? r0.id);
  const big = "z".repeat(APPEND_MAX_BYTES + 1);
  const denied = await appendAsset("master", r0.asset?.id ?? r0.id, big);
  assert(denied.ok === false, "an over-bound append is refused");
  assert(String(denied.error).includes(String(APPEND_MAX_BYTES)), `the refusal names the per-call cap: ${denied.error}`);
  const after = await getAsset("master", r0.asset?.id ?? r0.id);
  assertEquals(after.asset.content, "head", "the refused append mutated nothing");
});

Deno.test("artifact body: edits and version restore still work on an append-grown (>cap) body", async () => {
  resetStore();
  const base = "m".repeat(200 * 1024) + "MARKER-END";
  const r0 = await createAsset("master", { type: "text", name: "grown-edit", content: base });
  assert(r0.ok === true);
  const id0 = r0.asset?.id ?? r0.id;
  const a1 = await appendAsset("master", id0, "n".repeat(32 * 1024));
  assert(a1.ok === true, `the first append succeeds, got ${JSON.stringify(a1).slice(0, 300)}`);
  const a2 = await appendAsset("master", id0, "o".repeat(32 * 1024));
  assert(a2.ok === true, `the second append succeeds, got ${JSON.stringify(a2).slice(0, 300)}`);

  // patch (search/replace) on the >cap body: edit a marker without resending it.
  const patched = await patchAsset("master", id0, [{ search: "MARKER-END", replace: "MARKER-PATCHED" }]);
  assert(patched.ok === true, `patch on a grown body succeeds, got ${JSON.stringify(patched).slice(0, 300)}`);
  const got = await getAsset("master", id0);
  assert(got.asset.content.startsWith("m".repeat(200 * 1024)), "the large prefix is intact after the patch");
  assert(got.asset.content.includes("MARKER-PATCHED"), "the patch landed");
  assert(got.asset.content.endsWith("o".repeat(32 * 1024)), "the appended tail is intact after the patch");

  // version bodies at >cap read back whole, and a restore makes a NEW head.
  const versions = await listAssetVersions("master", id0);
  assert(versions.ok === true && versions.head >= 3);
  const v1 = await getAssetVersion("master", id0, 1);
  assert(v1.ok === true && v1.content === base, "the original >cap version body reads back whole");
  const restored = await restoreAssetVersion("master", id0, 1);
  assert(restored.ok === true, `restore of the original version succeeds, got ${JSON.stringify(restored).slice(0, 300)}`);
  const afterRestore = await getAsset("master", id0);
  assertEquals(afterRestore.asset.content, base, "the restored head is the original body byte-for-byte");
});

// ---- P2: the artifact inspector must guard oversized/corrupt bodies ----
Deno.test("artifact inspector: highlighting is disabled above the valid artifact limit and corrupt multi-MB bodies are refused from DOM mount", () => {
  const raw = Deno.readTextFileSync(new URL("../extension/shared/components.js", import.meta.url));
  const docs = Deno.readTextFileSync(new URL("../docs/components.js", import.meta.url));
  const inspector = raw.slice(raw.indexOf("/* <artifact-inspector>"), raw.indexOf('customElements.define("artifact-inspector"'));
  const docInspector = docs.slice(docs.indexOf("/* <artifact-inspector>"), docs.indexOf('customElements.define("artifact-inspector"'));
  for (const [label, text] of [["components.js", inspector], ["docs/components.js", docInspector]]) {
    assert(
      /byteLength\s*>\s*4\s*\*\s*1024\s*\*\s*1024/.test(text) || /byteLength\s*>\s*4 \* 1024 \* 1024/.test(text) ||
        /MAX_ARTIFACT_BODY_BYTES/.test(text),
      `${label}: the inspector must refuse to mount a corrupt multi-MB body (> 4 MiB valid-artifact ceiling)`,
    );
    assert(
      /highlightSource\(content,\s*lang,\s*document\)/.test(text) === false || /byteLength/.test(text),
      `${label}: highlighting must be size-guarded (never an unconditional whole-body tokenize)`,
    );
  }
});
