// Unit test for the artifacts (asset) system — lib/artifacts.js.
// Assets are origin-keyed; each is a bounded OPFS value under `asset:<id>` with
// a lightweight reserved `assets` index. Verifies create/list/get/update/delete,
// the type + name + content bounds, and the per-origin count cap.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ASSET_BOUNDS,
  ASSET_TYPES,
  createAsset,
  createAssetKeyed,
  deleteAsset,
  getAsset,
  listAssets,
  listAssetVersions,
  patchAsset,
  resolveAssetPatch,
  updateAsset,
} from "../extension/lib/artifacts.js";

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- minimal in-memory OPFS fake (same shape as tests/memory.test.ts) ----
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}
class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    const node = this.node;
    return {
      size: (node.content ?? "").length,
      async text() {
        return node.content ?? "";
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "directory";
  }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: {
    storage: { async getDirectory() { return new FakeDirHandle(root); } },
  },
  configurable: true,
  writable: true,
});

Deno.test("createAsset → list → get round-trips a hub artifact", async () => {
  const created = await createAsset("master", {
    type: "html",
    name: "generated report",
    content: "<h1>hi</h1>",
  });
  assert(created.ok, `create must succeed: ${created.error}`);
  const id = created.asset.id;
  assert(typeof id === "string" && id.startsWith("a_"), "id must be generated");

  const list = await listAssets("master");
  assert(list.ok, "list must succeed");
  assert(list.assets.some((a) => a.id === id), "index must contain the new asset");
  assert(!("content" in (list.assets[0] ?? {})), "index entries must not carry content");

  const got = await getAsset("master", id);
  assert(got.ok, "get must succeed");
  assertEquals(got.asset.content, "<h1>hi</h1>", "content must round-trip");
  assertEquals(got.asset.type, "html");
  assertEquals(got.asset.name, "generated report");

  // The existing UNKEYED contract is unchanged: the same body is a new create,
  // not an implicit digest dedup.
  const unkeyedAgain = await createAsset("master", {
    type: "html",
    name: "generated report",
    content: "<h1>hi</h1>",
  });
  assert(unkeyedAgain.ok);
  assert(unkeyedAgain.asset.id !== id, "unkeyed create still allocates a fresh id");

  // createAssetKeyed deliberately trusts its CALLER-OWNED operation key. A
  // same-key retry returns the prior asset even when the caller supplies new
  // content, so every caller MUST include the bounded content digest in its key.
  const keyedOrigin = "https://keyed-contract.example";
  const keyedFirst = await createAssetKeyed(keyedOrigin, {
    key: "caller-must-bind-content-digest",
    type: "text",
    name: "keyed",
    content: "first",
  });
  const keyedRetry = await createAssetKeyed(keyedOrigin, {
    key: "caller-must-bind-content-digest",
    type: "text",
    name: "keyed",
    content: "different-content",
  });
  assert(keyedFirst.ok && keyedRetry.ok && keyedRetry.deduped === true);
  assertEquals(keyedRetry.id, keyedFirst.asset.id, "same caller key dedupes to the same id");
  const keyedBody = await getAsset(keyedOrigin, keyedRetry.id);
  assertEquals(keyedBody.asset.content, "first", "same-key retry never replaces prior content");
});

Deno.test("updateAsset patches name/type/content", async () => {
  const created = await createAsset("master", {
    type: "text",
    name: "draft",
    content: "v1",
  });
  const id = created.asset.id;
  const updated = await updateAsset("master", id, {
    name: "final",
    type: "html",
    content: "<p>v2</p>",
  });
  assert(updated.ok, `update must succeed: ${updated.error}`);
  const got = await getAsset("master", id);
  assertEquals(got.asset.name, "final");
  assertEquals(got.asset.type, "html");
  assertEquals(got.asset.content, "<p>v2</p>");
});

Deno.test("deleteAsset removes the index entry + the asset body", async () => {
  const created = await createAsset("master", { type: "text", name: "x", content: "y" });
  const id = created.asset.id;
  const del = await deleteAsset("master", id);
  assert(del.ok, "delete must succeed");
  const got = await getAsset("master", id);
  assert(!got.ok, "get after delete must fail");
  const list = await listAssets("master");
  assert(!list.assets.some((a) => a.id === id), "index must drop the deleted asset");
});

Deno.test("updateAsset with an unknown/empty id fails with a store error (CAP-FB-20260830-ARTIFACT-QUICK-FIXES-01)", async () => {
  // The route layer maps these to the readable "use list_assets" sentence; the
  // lib seam must FAIL with the store error, never a success or an approval.
  const missing = await updateAsset("master", "a_never_created", { name: "x" });
  assert(!missing.ok, "unknown-id update must fail");
  assertEquals(missing.error, "asset not found");
  const empty = await updateAsset("master", "", { name: "x" });
  assert(!empty.ok, "empty-id update must fail");
  assert(
    String(empty.error ?? "").includes("needs an id") || String(empty.error ?? "").includes("use list_assets"),
    `empty-id error should name the missing id: ${empty.error}`,
  );
});

Deno.test("createAsset rejects bad types and empty names; the artifact content cap is gone (dptw)", async () => {
  assert(ASSET_TYPES.has("html"), "ASSET_TYPES must include html");
  const badType = await createAsset("master", { type: "exe", name: "a", content: "b" });
  assert(!badType.ok, "bad type must be rejected");
  const noName = await createAsset("master", { type: "text", name: "  ", content: "b" });
  assert(!noName.ok, "empty name must be rejected");
  // dptw: no artifact-level content refusal. Content past the removed 256 KiB
  // artifact cap is no longer rejected by the artifact library — the remaining
  // per-value refusal, if any, is the memory store's own bound (the dptw
  // STORAGE area), never "asset content exceeds".
  let outcome;
  try {
    outcome = await createAsset("master", {
      type: "text",
      name: "big",
      content: "x".repeat(256 * 1024 + 1),
    });
  } catch (error) {
    outcome = { ok: false, error: String(error?.message ?? error) };
  }
  if (!outcome.ok) {
    assert(!/asset content exceeds/.test(outcome.error ?? ""), `no artifact-level content cap: ${outcome.error}`);
    assert(/262144-byte bound|memory/.test(outcome.error ?? ""), `the remaining refusal is the memory store's per-value bound (dptw storage area): ${outcome.error}`);
  } else {
    assert(outcome.ok, "stored whole");
  }
});

Deno.test("createAsset enforces the per-origin count cap", async () => {
  // Use a dedicated origin so the cap test doesn't depend on prior tests' state.
  for (let i = 0; i < ASSET_BOUNDS.maxAssetsPerOrigin + 1; i++) {
    const r = await createAsset("https://cap.example", {
      type: "text",
      name: `asset ${i}`,
      content: `${i}`,
    });
    if (i < ASSET_BOUNDS.maxAssetsPerOrigin) {
      assert(r.ok, `asset ${i} must succeed`);
    } else {
      assert(!r.ok, "the 201st asset must be rejected");
      assert(/limit/.test(r.error), "the rejection must explain the limit");
    }
  }
});

Deno.test("assets are origin-scoped (master vs site don't mix)", async () => {
  const m = await createAsset("master", { type: "text", name: "hub", content: "m" });
  const s = await createAsset("https://scope.example", {
    type: "text",
    name: "site",
    content: "s",
  });
  const masterList = await listAssets("master");
  const siteList = await listAssets("https://scope.example");
  assert(masterList.assets.some((a) => a.id === m.asset.id), "master lists the hub asset");
  assert(siteList.assets.some((a) => a.id === s.asset.id), "site lists its asset");
  assert(!masterList.assets.some((a) => a.id === s.asset.id), "master must NOT see the site asset");
  assert(!siteList.assets.some((a) => a.id === m.asset.id), "site must NOT see the master asset");
});

Deno.test("assets: same-tick same-name ids disambiguate by the UNIQUE random tail (AX suffix)", async () => {
  // createAsset calls newId() synchronously before its first await, so two
  // un-awaited calls share the same Date.now() tick — the old slice(0,8) prefix
  // collides, the fixed slice(-8) tail does not.
  const p1 = createAsset("master", { type: "text", name: "dup", content: "1" });
  const p2 = createAsset("master", { type: "text", name: "dup", content: "2" });
  const [a, b] = await Promise.all([p1, p2]);
  assert(a.ok && b.ok, "both same-name creates succeed");
  const id1 = a.asset.id;
  const id2 = b.asset.id;
  assert(id1 !== id2, "distinct ids");
  // The AX disambiguator (index.js distinct) uses slice(-8): the random tail is
  // unique even when the timestamp prefix (slice(0,8)) is shared.
  assert(id1.slice(-8) !== id2.slice(-8), "the id tail (AX suffix) is unique in the same tick");
});

Deno.test("assets: concurrent same-tick creates both persist in the index (no RMW loss)", async () => {
  // Two un-awaited creates read the index before either writes; the per-origin
  // mutex must serialize the read-modify-write so neither row is dropped.
  const p1 = createAsset("master", { type: "text", name: "concurrent", content: "1" });
  const p2 = createAsset("master", { type: "text", name: "concurrent", content: "2" });
  const [a, b] = await Promise.all([p1, p2]);
  assert(a.ok && b.ok, "both creates succeed");
  const list = await listAssets("master");
  const ids = new Set(list.assets.map((x) => x.id));
  assert(ids.has(a.asset.id), "the first id persists in the index");
  assert(ids.has(b.asset.id), "the second id persists in the index");
});

// ---- patch_asset: exact search/replace editing (CAP-FB-20260830-PATCH-ASSET-TOOL-01) ----

Deno.test("patchAsset replaces a unique match and reports +1 -1 as a new version", async () => {
  const created = await createAsset("master", {
    type: "html",
    name: "crumb.html",
    content: "<h1>Crumb</h1>\n<style>--brand: #b91c1c;</style>\n<p>Fresh bread.</p>\n",
  });
  const id = created.asset.id;
  assertEquals((await listAssetVersions("master", id)).head, 1, "starts at version 1");

  const res = await patchAsset("master", id, [
    { search: "--brand: #b91c1c;", replace: "--brand: #2563eb;" },
  ]);
  assert(res.ok, `patch must succeed: ${res.error}`);
  assertEquals(res.added, 1, "one line added");
  assertEquals(res.removed, 1, "one line removed");
  assertEquals(res.version, 2, "the patch lands as a new head version");

  const got = await getAsset("master", id);
  assert(got.asset.content.includes("--brand: #2563eb;"), "the new colour is written");
  assert(!got.asset.content.includes("#b91c1c"), "the old colour is gone");
  assertEquals((await listAssetVersions("master", id)).head, 2, "head advanced to 2");
});

Deno.test("patchAsset refuses zero matches and multiple matches without all (no mutation)", async () => {
  const created = await createAsset("master", {
    type: "text",
    name: "dup",
    content: "red\nred\nblue\n",
  });
  const id = created.asset.id;
  const before = await sha256((await getAsset("master", id)).asset.content);

  const zero = await patchAsset("master", id, [{ search: "green", replace: "x" }]);
  assert(!zero.ok, "a zero-match patch must fail");
  assert(String(zero.error).includes("not found"), `readable not-found error: ${zero.error}`);

  const multi = await patchAsset("master", id, [{ search: "red", replace: "orange" }]);
  assert(!multi.ok, "an ambiguous (2-match) patch must fail without all:true");
  assert(String(multi.error).includes("matches 2 times"), `readable ambiguity error: ${multi.error}`);

  const after = await sha256((await getAsset("master", id)).asset.content);
  assertEquals(after, before, "a refused patch leaves the body byte-identical");
  assertEquals((await listAssetVersions("master", id)).head, 1, "no new version was staged");

  // all:true resolves the ambiguity by replacing EVERY occurrence.
  const all = await patchAsset("master", id, [{ search: "red", replace: "orange", all: true }]);
  assert(all.ok, `all:true must succeed: ${all.error}`);
  assertEquals((await getAsset("master", id)).asset.content, "orange\norange\nblue\n");
});

Deno.test("patchAsset with a stale expectVersion returns version_conflict and does not mutate", async () => {
  const created = await createAsset("master", { type: "text", name: "guard", content: "one\n" });
  const id = created.asset.id;
  // Advance the head to version 2 so an expectVersion of 1 is stale.
  const first = await patchAsset("master", id, [{ search: "one", replace: "two" }], { expectVersion: 1 });
  assert(first.ok, `the fresh-version patch must succeed: ${first.error}`);
  assertEquals(first.version, 2);
  const before = await sha256((await getAsset("master", id)).asset.content);

  const stale = await patchAsset("master", id, [{ search: "two", replace: "three" }], { expectVersion: 1 });
  assert(!stale.ok, "a stale expectVersion must be refused");
  assertEquals(stale.error, "version_conflict");
  assertEquals(stale.version, 2, "the conflict reports the current head");

  const after = await sha256((await getAsset("master", id)).asset.content);
  assertEquals(after, before, "a version_conflict leaves the body byte-identical");
  assertEquals((await listAssetVersions("master", id)).head, 2, "no new version was staged");
});

Deno.test("patchAsset applies multiple edits in order and refuses an unknown id", async () => {
  const created = await createAsset("master", { type: "text", name: "multi", content: "a\nb\nc\n" });
  const id = created.asset.id;
  const res = await patchAsset("master", id, [
    { search: "a", replace: "A" },
    { search: "c", replace: "C" },
  ]);
  assert(res.ok, `multi-edit patch must succeed: ${res.error}`);
  assertEquals((await getAsset("master", id)).asset.content, "A\nb\nC\n");

  const missing = await patchAsset("master", "a_never_created", [{ search: "x", replace: "y" }]);
  assert(!missing.ok, "unknown-id patch must fail");
  assertEquals(missing.error, "asset not found");

  const noEdits = await patchAsset("master", id, []);
  assert(!noEdits.ok, "an empty edits array must fail");
});

Deno.test("resolveAssetPatch is a pure fail-closed resolver (no store)", () => {
  assertEquals(resolveAssetPatch("hello world", [{ search: "world", replace: "there" }]).content, "hello there");
  assert(!resolveAssetPatch("abc", [{ search: "z", replace: "y" }]).ok, "zero match refused");
  assert(!resolveAssetPatch("a a", [{ search: "a", replace: "b" }]).ok, "ambiguous match refused");
  assertEquals(resolveAssetPatch("a a", [{ search: "a", replace: "b", all: true }]).content, "b b");
  assert(!resolveAssetPatch("x", []).ok, "no edits refused");
  assert(!resolveAssetPatch("x", Array(21).fill({ search: "x", replace: "y" })).ok, "over 20 edits refused");
});
