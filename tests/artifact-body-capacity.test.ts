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
//   P2    The artifact inspector must never size-refuse a body and must never
//         synchronously tokenize an oversized one: highlighting is disabled
//         above the single-call artifact limit, and any larger body — whatever
//         its raw or serialized size (an escaping-heavy body the store could
//         not even admit is foreign data only on the write path, never a
//         render refusal) — mounts as the exact plain text (p45y r5, owner
//         2026-09-03: no self-imposed size caps on rendering).
//
// RED on the pre-fix code: the exact-cap creates throw the memory store's
// "exceeds the 262144-byte bound"; appendAsset does not exist.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
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

Deno.test("artifact append: appends carry any size — no per-call cap (owner no-limits directive)", async () => {
  resetStore();
  const r0 = await createAsset("master", { type: "text", name: "unbounded-append", content: "head" });
  assert(r0.ok === true);
  const big = "z".repeat(200 * 1024);
  const result = await appendAsset("master", r0.asset?.id ?? r0.id, big);
  assert(result.ok === true, "a large append succeeds without size refusal");
  const after = await getAsset("master", r0.asset?.id ?? r0.id);
  assertEquals(after.asset.content.length, "head".length + big.length, "the append landed whole");
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

// ---- P2: the artifact inspector never size-refuses; only tokenizing is bounded ----
Deno.test("artifact inspector: bodies render complete at any size (no mount refusal), with highlighting bounded to the sync-tokenize budget", () => {
  const raw = Deno.readTextFileSync(new URL("../extension/shared/components.js", import.meta.url));
  const docs = Deno.readTextFileSync(new URL("../docs/components.js", import.meta.url));
  const inspector = raw.slice(raw.indexOf("/* <artifact-inspector>"), raw.indexOf('customElements.define("artifact-inspector"'));
  const docInspector = docs.slice(docs.indexOf("/* <artifact-inspector>"), docs.indexOf('customElements.define("artifact-inspector"'));
  for (const [label, text] of [["components.js", inspector], ["docs/components.js", docInspector]]) {
    // r5: no size-based mount refusal may return — a body of ANY size (raw or
    // serialized) renders complete; the old 4 MiB guard refused append-grown
    // and escaping-heavy bodies outright.
    assert(
      !/larger than any valid artifact/.test(text) &&
      !/MAX_ARTIFACT_BODY_BYTES/.test(text) &&
      !/refused from DOM mount/.test(text),
      `${label}: the size-based mount refusal must not return (no self-imposed size caps)`,
    );
    // The complete body is mounted (whole-content text path), never a slice.
    assert(
      /code\.textContent = content/.test(text),
      `${label}: the complete body must render as the text path`,
    );
    // Highlighting stays bounded to the synchronous-tokenize budget (a
    // performance bound, not a render cap: larger bodies take the text path).
    assert(
      /MAX_ARTIFACT_HIGHLIGHT_BYTES/.test(text) && /highlightSource\(content, lang, document\)/.test(text),
      `${label}: highlighting must be size-guarded (never an unconditional whole-body tokenize)`,
    );
  }
});
