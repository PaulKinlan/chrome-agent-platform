// @ts-nocheck — hostile proxy/getter and byte fixtures are intentionally dynamic.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  CODE_DIFF_LIMITS,
  MAX_RETAINED_BLOB_BYTES,
  MAX_RETAINED_BLOBS,
  MAX_RETAINED_CAS_BYTES,
  applyPending,
  buildPatchIdentity,
  deriveSideBySide,
  deriveUnified,
  normalizeUserPath,
  rejectPending,
  retainPatch,
  undoApplied,
  validateChangeDocument,
} from "../extension/lib/code-diff-artifacts.js";

const enc = new TextEncoder();
async function digest(bytes) {
  const value = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function bytes(value) { return enc.encode(value); }
async function blob(value) {
  const body = value instanceof Uint8Array ? value : bytes(value);
  return { sha256: await digest(body), bytes: body };
}
function codeOf(fn, code) {
  const error = assertThrows(fn);
  assertEquals(error.code, code, error.message);
}
async function rejectCode(fn, code) {
  const error = await assertRejects(fn);
  assertEquals(error.code, code, error.message);
}
function expected(doc) {
  const base = [];
  const result = [];
  for (const change of doc.changes) {
    if (change.op === "add") result.push({ path: change.path, sha256: change.contentSha256 });
    if (change.op === "update") {
      base.push({ path: change.path, sha256: change.baseSha256 });
      result.push({ path: change.path, sha256: change.resultSha256 });
    }
    if (change.op === "delete") base.push({ path: change.path, sha256: change.baseSha256 });
    if (change.op === "rename") {
      base.push({ path: change.from, sha256: change.baseSha256 });
      result.push({ path: change.to, sha256: change.baseSha256 });
    }
    if (change.op === "binary") {
      if (change.baseSha256) base.push({ path: change.path, sha256: change.baseSha256 });
      result.push({ path: change.path, sha256: change.resultSha256 });
    }
  }
  base.sort((a, b) => a.path.localeCompare(b.path));
  result.sort((a, b) => a.path.localeCompare(b.path));
  return { base, result };
}
function producer(overrides = {}) {
  return {
    sourceKind: "package",
    packageId: "reviewed.tools",
    toolId: "edit_code",
    version: "1.2.3",
    sourceDigest: "1".repeat(64),
    executableSha256: "2".repeat(64),
    capabilityDigest: "3".repeat(64),
    replayClass: "mutating",
    ...overrides,
  };
}
function context(overrides = {}) {
  return {
    workspace: "tool-jobs/ex_1/1",
    executionId: "ex_1",
    callIndex: 1,
    runId: "run_1",
    agentId: "agent_1",
    origin: "https://example.test",
    documentId: "doc_1",
    ...overrides,
  };
}
async function fixture() {
  const add = await blob("new file\n");
  const updateBase = await blob("old line\n");
  const updateResult = await blob("new line\n");
  const deleted = await blob("delete me\n");
  const renamed = await blob("same bytes\n");
  const binaryBase = await blob(new Uint8Array([0, 1, 2]));
  const binaryResult = await blob(new Uint8Array([0, 1, 2, 3]));
  const doc = {
    schemaVersion: 1,
    canonicalPathSet: ["assets/logo.bin", "delete.txt", "new.ts", "renamed-new.ts", "renamed-old.ts", "update.ts"],
    displayPaths: null,
    changes: [
      { op: "add", path: "new.ts", contentSha256: add.sha256, size: add.bytes.byteLength, encoding: "utf8" },
      { op: "update", path: "update.ts", baseSha256: updateBase.sha256, resultSha256: updateResult.sha256, resultSize: updateResult.bytes.byteLength, encoding: "utf8" },
      { op: "delete", path: "delete.txt", baseSha256: deleted.sha256 },
      { op: "rename", from: "renamed-old.ts", to: "renamed-new.ts", baseSha256: renamed.sha256 },
      { op: "binary", path: "assets/logo.bin", baseSha256: binaryBase.sha256, resultSha256: binaryResult.sha256, resultSize: binaryResult.bytes.byteLength, mediaType: "image/png", encoding: "bytes" },
    ],
  };
  const lists = expected(doc);
  const identity = await buildPatchIdentity({ producer: producer(), context: context(), inputs: [{ sha256: "0".repeat(64) }], base: lists.base, result: lists.result, changeDoc: doc });
  return { doc, identity, blobs: [add, updateBase, updateResult, deleted, renamed, binaryBase, binaryResult] };
}

class FakeArtifacts {
  records = new Map();
  ids = new Map();
  calls = [];
  failAt = null;
  failAfterAt = null;
  corruptRead = false;
  next = 1;
  async createAssetKeyed(origin, input) {
    this.calls.push({ origin, ...input });
    const prior = this.records.get(input.key);
    if (prior) return { ok: true, id: prior.id, asset: prior, deduped: true };
    if (this.failAt === this.calls.length) throw new Error("simulated artifact WAL interruption");
    const id = `a_${this.next++}`;
    const record = { id, ...input };
    this.records.set(input.key, record);
    this.ids.set(id, record);
    if (this.failAfterAt === this.calls.length) throw new Error("simulated artifact WAL commit-close interruption");
    return { ok: true, id, asset: { ...record, content: undefined } };
  }
  async getAsset(_origin, id) {
    const record = this.ids.get(id);
    if (!record) return { ok: false, error: "missing" };
    return { ok: true, asset: { ...record, content: this.corruptRead ? `${record.content}x` : record.content } };
  }
  api() { return { createAssetKeyed: this.createAssetKeyed.bind(this), getAsset: this.getAsset.bind(this) }; }
}

Deno.test("code diff identity binds producer/package/context/input/base/result/change/media and is deterministic", async () => {
  const f = await fixture();
  const again = await buildPatchIdentity({ producer: producer(), context: context(), inputs: [{ sha256: "0".repeat(64) }], ...expected(f.doc), changeDoc: f.doc });
  assertEquals(again.identity, f.identity.identity);
  assertEquals(again.artifactKey, `opfs:code-diff:${again.identity}`);
  for (const sourceKind of ["extension-builtin", "chrome-api", "management", "webmcp-declared", "webmcp-inferred"]) {
    const sourceProducer = { sourceKind, toolId: "edit_code", version: "generation-7", sourceDigest: "6".repeat(64), replayClass: "unknown" };
    const value = await buildPatchIdentity({ producer: sourceProducer, context: context(), inputs: [{ sha256: "0".repeat(64) }], ...expected(f.doc), changeDoc: f.doc });
    assert(value.identity !== f.identity.identity);
  }
  for (const changed of [
    { producer: producer({ executableSha256: "4".repeat(64) }), context: context(), inputs: [{ sha256: "0".repeat(64) }] },
    { producer: producer({ capabilityDigest: "5".repeat(64) }), context: context(), inputs: [{ sha256: "0".repeat(64) }] },
    { producer: producer(), context: context({ runId: "run_2" }), inputs: [{ sha256: "0".repeat(64) }] },
    { producer: producer(), context: context(), inputs: [{ sha256: "9".repeat(64) }] },
  ]) {
    const value = await buildPatchIdentity({ ...changed, ...expected(f.doc), changeDoc: f.doc });
    assert(value.identity !== f.identity.identity);
  }
  const changedResult = structuredClone(f.doc);
  changedResult.changes[1].resultSha256 = "7".repeat(64);
  const changedResultIdentity = await buildPatchIdentity({ producer: producer(), context: context(), inputs: [{ sha256: "0".repeat(64) }], ...expected(changedResult), changeDoc: changedResult });
  assert(changedResultIdentity.identity !== f.identity.identity);
});

Deno.test("owner-visible paths accept valid Unicode/NFC/UTF-8 and explicit reversible display mapping", () => {
  assertEquals(normalizeUserPath("src/ütils.ts"), "src/ütils.ts");
  assertEquals(normalizeUserPath(bytes("資料/工具.ts")), "資料/工具.ts");
  assertEquals(normalizeUserPath("src/u\u0308tils.ts"), "src/ütils.ts");
  const sha = "a".repeat(64);
  const doc = validateChangeDocument({
    schemaVersion: 1,
    canonicalPathSet: ["src/ütils.ts"],
    displayPaths: { "src/ütils.ts": "src/u\u0308tils.ts" },
    changes: [{ op: "add", path: "src/ütils.ts", contentSha256: sha, size: 1, encoding: "utf8" }],
  });
  assertEquals(doc.displayPaths["src/ütils.ts"], "src/u\u0308tils.ts");
});

Deno.test("path grammar rejects malformed Unicode, controls, separator/traversal aliases and byte bounds", () => {
  for (const value of [new Uint8Array([0xc3, 0x28]), "x/\ud800", "x/\0", "x/\u0080", "x/\u202e", "x\\y"]) {
    const expectedCode = value === "x\\y" ? "path_backslash" : "path_bad_unicode";
    codeOf(() => normalizeUserPath(value), expectedCode);
  }
  for (const value of ["", "/x", "C:/x", "//host/x", "x//y", "x/.", "x/..", "x/%2e%2e/y", "x/%2f/y"]) codeOf(() => normalizeUserPath(value), "path_traversal");
  codeOf(() => normalizeUserPath("a".repeat(256)), "path_over_budget");
  codeOf(() => normalizeUserPath(Array(5).fill("a".repeat(255)).join("/")), "path_over_budget");
});

Deno.test("canonical, case-fold, count, sorted-set and display-path collisions fail closed", () => {
  const sha = "a".repeat(64);
  const make = (paths, displayPaths, changes) => ({ schemaVersion: 1, canonicalPathSet: paths, displayPaths, changes });
  codeOf(() => validateChangeDocument(make(["x/é.ts", "x/e\u0301.ts"], null, [])), "path_canonical_collision");
  codeOf(() => validateChangeDocument(make(["A.ts", "a.ts"], null, [])), "path_casefold_collision");
  codeOf(() => validateChangeDocument(make(["z.ts", "a.ts"], null, [])), "path_set_not_sorted");
  codeOf(() => validateChangeDocument(make(["a.ts"], { "a.ts": "b.ts" }, [{ op: "add", path: "a.ts", contentSha256: sha, size: 1, encoding: "utf8" }])), "display_path_mismatch");
  const paths = Array.from({ length: 257 }, (_, i) => `p${String(i).padStart(3, "0")}.ts`);
  codeOf(() => validateChangeDocument(make(paths, null, [])), "path_count_exceeded");
});

Deno.test("strict add/update/delete/rename/binary shapes reject unknowns, invalid digests, no-ops and duplicate endpoints", async () => {
  const f = await fixture();
  assertEquals(validateChangeDocument(f.doc).changes.map((change) => change.op), ["add", "update", "delete", "rename", "binary"]);
  const mutate = (fn) => { const value = structuredClone(f.doc); fn(value); return value; };
  codeOf(() => validateChangeDocument(mutate((doc) => { doc.changes[0].extra = true; })), "unknown_field");
  codeOf(() => validateChangeDocument(mutate((doc) => { doc.changes[0].op = "patch"; })), "unknown_operation");
  codeOf(() => validateChangeDocument(mutate((doc) => { doc.changes[0].contentSha256 = "no"; })), "invalid_digest");
  codeOf(() => validateChangeDocument(mutate((doc) => { doc.changes[1].resultSha256 = doc.changes[1].baseSha256; })), "no_op_change");
  codeOf(() => validateChangeDocument(mutate((doc) => { doc.changes[4].mediaType = "\u202etext"; })), "invalid_media_type");
  codeOf(() => validateChangeDocument(mutate((doc) => { doc.changes[1].path = doc.changes[0].path; })), "duplicate_change_path");
});

Deno.test("identity refuses unsorted/mismatched base/result and incomplete package provenance", async () => {
  const f = await fixture();
  const lists = expected(f.doc);
  await rejectCode(() => buildPatchIdentity({ producer: producer(), context: context(), inputs: [], base: [...lists.base].reverse(), result: lists.result, changeDoc: f.doc }), "identity_not_sorted");
  await rejectCode(() => buildPatchIdentity({ producer: producer(), context: context(), inputs: [], base: lists.base, result: lists.result.slice(1), changeDoc: f.doc }), "identity_change_mismatch");
  const incomplete = producer(); delete incomplete.executableSha256;
  await rejectCode(() => buildPatchIdentity({ producer: incomplete, context: context(), inputs: [], base: lists.base, result: lists.result, changeDoc: f.doc }), "missing_field");
});

Deno.test("getter/proxy hostile inputs fail before artifact side effects", async () => {
  const getter = { schemaVersion: 1, canonicalPathSet: [], displayPaths: null, changes: [] };
  Object.defineProperty(getter, "changes", { enumerable: true, get() { throw new Error("owned"); } });
  codeOf(() => validateChangeDocument(getter), "hostile_input");
  const proxy = new Proxy({}, { ownKeys() { throw new Error("owned"); } });
  codeOf(() => validateChangeDocument(proxy), "hostile_input");
  const f = await fixture();
  const fake = new FakeArtifacts();
  const cas = [...f.blobs];
  Object.defineProperty(cas[0], "bytes", { enumerable: true, get() { throw new Error("owned"); } });
  await rejectCode(() => retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs: cas }, fake.api()), "hostile_input");
  assertEquals(fake.calls.length, 0);
});

Deno.test("retention preflights missing/extra/digest/size and per-blob caps with zero partial writes", async () => {
  const f = await fixture();
  for (const [casBlobs, code] of [
    [f.blobs.slice(1), "cas_missing"],
    [[...f.blobs, await blob("not referenced")], "cas_unreferenced"],
    [[{ ...f.blobs[0], bytes: bytes("wrong") }, ...f.blobs.slice(1)], "cas_digest_mismatch"],
  ]) {
    const fake = new FakeArtifacts();
    await rejectCode(() => retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs }, fake.api()), code);
    assertEquals(fake.calls.length, 0);
  }
  const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
  const invalidBlob = { sha256: await digest(invalidUtf8), bytes: invalidUtf8 };
  const invalidDoc = { schemaVersion: 1, canonicalPathSet: ["bad.ts"], displayPaths: null, changes: [{ op: "add", path: "bad.ts", contentSha256: invalidBlob.sha256, size: invalidUtf8.byteLength, encoding: "utf8" }] };
  const invalidIdentity = await buildPatchIdentity({ producer: producer(), context: context(), inputs: [], ...expected(invalidDoc), changeDoc: invalidDoc });
  let encodingFake = new FakeArtifacts();
  await rejectCode(() => retainPatch({ identity: invalidIdentity, changeDoc: invalidDoc, casBlobs: [invalidBlob] }, encodingFake.api()), "cas_encoding_mismatch");
  assertEquals(encodingFake.calls.length, 0);
  const huge = new Uint8Array(MAX_RETAINED_BLOB_BYTES + 1);
  const hugeBlob = { sha256: await digest(huge), bytes: huge };
  const doc = { schemaVersion: 1, canonicalPathSet: ["huge.bin"], displayPaths: null, changes: [{ op: "binary", path: "huge.bin", baseSha256: null, resultSha256: hugeBlob.sha256, resultSize: huge.byteLength, mediaType: "application/octet-stream", encoding: "bytes" }] };
  const identity = await buildPatchIdentity({ producer: producer(), context: context(), inputs: [], ...expected(doc), changeDoc: doc });
  const fake = new FakeArtifacts();
  await rejectCode(() => retainPatch({ identity, changeDoc: doc, casBlobs: [hugeBlob] }, fake.api()), "cas_budget_exceeded");
  assertEquals(fake.calls.length, 0);
});

Deno.test("retained-CAS count and total-byte amplification caps reject before the first write", async () => {
  const makeMany = async (count, size) => {
    const paths = [];
    const changes = [];
    const blobs = [];
    for (let i = 0; i < count; i++) {
      const path = `f${String(i).padStart(3, "0")}.bin`;
      const body = new Uint8Array(size); body[0] = i; body[body.length - 1] = i + 1;
      const row = { sha256: await digest(body), bytes: body };
      paths.push(path); blobs.push(row);
      changes.push({ op: "binary", path, baseSha256: null, resultSha256: row.sha256, resultSize: body.byteLength, mediaType: "application/octet-stream", encoding: "bytes" });
    }
    const doc = { schemaVersion: 1, canonicalPathSet: paths, displayPaths: null, changes };
    const identity = await buildPatchIdentity({ producer: producer(), context: context(), inputs: [], ...expected(doc), changeDoc: doc });
    return { doc, identity, blobs };
  };
  const tooMany = await makeMany(MAX_RETAINED_BLOBS + 1, 2);
  let fake = new FakeArtifacts();
  await rejectCode(() => retainPatch({ identity: tooMany.identity, changeDoc: tooMany.doc, casBlobs: tooMany.blobs }, fake.api()), "cas_budget_exceeded");
  assertEquals(fake.calls.length, 0);
  const overTotal = await makeMany(Math.ceil(MAX_RETAINED_CAS_BYTES / MAX_RETAINED_BLOB_BYTES) + 1, MAX_RETAINED_BLOB_BYTES);
  fake = new FakeArtifacts();
  await rejectCode(() => retainPatch({ identity: overTotal.identity, changeDoc: overTotal.doc, casBlobs: overTotal.blobs }, fake.api()), "cas_budget_exceeded");
  assertEquals(fake.calls.length, 0);
});

Deno.test("retainPatch writes digest-bound CAS then patch, re-reads hashes, and exact retry dedupes", async () => {
  const f = await fixture();
  const fake = new FakeArtifacts();
  const first = await retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs: f.blobs, meta: { label: "Reviewed code change" } }, fake.api());
  assert(first.ok);
  assertEquals(first.retainedCas.length, f.blobs.length);
  assert(fake.calls.slice(0, -1).every((call) => call.key === `opfs:code-diff:cas:${call.meta.sha256}`));
  assertEquals(fake.calls.at(-1).key, f.identity.artifactKey);
  const count = fake.records.size;
  const second = await retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs: [...f.blobs].reverse(), meta: { label: "Reviewed code change" } }, fake.api());
  assertEquals(second.id, first.id);
  assert(second.deduped);
  assertEquals(fake.records.size, count);
  assert(!fake.calls.some((call) => call.key === undefined));
});

Deno.test("artifact-WAL interruption leaves only digest-keyed CAS and retry recovers idempotently", async () => {
  const f = await fixture();
  const fake = new FakeArtifacts();
  fake.failAfterAt = 3;
  await assertRejects(() => retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs: f.blobs }, fake.api()), Error, "simulated artifact WAL commit-close interruption");
  assertEquals(fake.records.size, 3);
  assert([...fake.records.keys()].every((key) => key.startsWith("opfs:code-diff:cas:")));
  fake.failAfterAt = null;
  const retained = await retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs: f.blobs }, fake.api());
  assert(retained.ok);
  assertEquals(fake.records.size, f.blobs.length + 1);

  const patchClose = new FakeArtifacts();
  patchClose.failAfterAt = f.blobs.length + 1;
  await assertRejects(() => retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs: f.blobs }, patchClose.api()), Error, "simulated artifact WAL commit-close interruption");
  patchClose.failAfterAt = null;
  const recovered = await retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs: f.blobs }, patchClose.api());
  assert(recovered.ok && recovered.deduped);
  assertEquals(patchClose.records.size, f.blobs.length + 1);
});

Deno.test("retained CAS and patch write verification fail closed on corrupted readback", async () => {
  const f = await fixture();
  const fake = new FakeArtifacts();
  fake.corruptRead = true;
  await rejectCode(() => retainPatch({ identity: f.identity, changeDoc: f.doc, casBlobs: f.blobs }, fake.api()), "cas_write_verify_failed");
});

Deno.test("unified and side-by-side views hash authoritative CAS, bound lines, neutralize controls, and keep binary metadata-only", async () => {
  const f = await fixture();
  // Controls in textual source are replaced, never emitted as active controls.
  const controlled = await blob("old\tline\n");
  const updatedDoc = structuredClone(f.doc);
  updatedDoc.changes[1].baseSha256 = controlled.sha256;
  const cas = f.blobs.map((row) => row.sha256 === f.doc.changes[1].baseSha256 ? controlled : row);
  const unified = await deriveUnified({ changeDoc: updatedDoc, casBlobs: cas });
  assert(unified.text.includes("old�line"));
  assert(unified.text.includes("[binary] image/png"));
  assert(!unified.text.includes(String.fromCharCode(0)));
  assertEquals(unified.authoritative, false);
  const side = await deriveSideBySide({ changeDoc: updatedDoc, casBlobs: cas });
  assert(side.rows.some((row) => row.kind === "binary" && row.mediaType === "image/png"));
  assert(side.rows.every((row) => typeof row === "object"));
  const long = "x".repeat(CODE_DIFF_LIMITS.maxLineBytes * 2);
  const longBlob = await blob(long);
  const longDoc = { schemaVersion: 1, canonicalPathSet: ["long.ts"], displayPaths: null, changes: [{ op: "add", path: "long.ts", contentSha256: longBlob.sha256, size: longBlob.bytes.byteLength, encoding: "utf8" }] };
  const view = await deriveUnified({ changeDoc: longDoc, casBlobs: [longBlob] });
  assert(view.text.endsWith("…"));
  assert(enc.encode(view.rows.at(-1)).byteLength <= CODE_DIFF_LIMITS.maxLineBytes);
});

Deno.test("views refuse missing/mismatched CAS, invalid UTF-8 and total line budget", async () => {
  const f = await fixture();
  await rejectCode(() => deriveUnified({ changeDoc: f.doc, casBlobs: f.blobs.slice(1) }), "view_base_missing");
  await rejectCode(() => deriveUnified({ changeDoc: f.doc, casBlobs: [{ ...f.blobs[0], bytes: bytes("wrong") }, ...f.blobs.slice(1)] }), "view_digest_mismatch");
  const bad = new Uint8Array([0xc3, 0x28]);
  const badBlob = { sha256: await digest(bad), bytes: bad };
  const badDoc = { schemaVersion: 1, canonicalPathSet: ["bad.ts"], displayPaths: null, changes: [{ op: "add", path: "bad.ts", contentSha256: badBlob.sha256, size: bad.byteLength, encoding: "utf8" }] };
  await rejectCode(() => deriveUnified({ changeDoc: badDoc, casBlobs: [badBlob] }), "view_bad_unicode");
  const many = `${"line\n".repeat(CODE_DIFF_LIMITS.maxViewLines + 1)}`;
  const manyBlob = await blob(many);
  const manyDoc = { schemaVersion: 1, canonicalPathSet: ["many.ts"], displayPaths: null, changes: [{ op: "add", path: "many.ts", contentSha256: manyBlob.sha256, size: manyBlob.bytes.byteLength, encoding: "utf8" }] };
  await rejectCode(() => deriveUnified({ changeDoc: manyDoc, casBlobs: [manyBlob] }), "view_over_budget");
});

Deno.test("apply/reject/undo synchronously fail before side effects and module has no route/index/OPFS/runtime authority", async () => {
  for (const fn of [applyPending, rejectPending, undoApplied]) codeOf(() => fn(new Proxy({}, { get() { throw new Error("must not read"); } })), "mutation_authority_required");
  const source = await Deno.readTextFile(new URL("../extension/lib/code-diff-artifacts.js", import.meta.url));
  for (const forbidden of ["addListener(", "navigator.storage", "WebAssembly.", "chrome.permissions", "updateAsset(", "deleteAsset(", "setTrusted(", "__cdTx", "innerHTML", "insertAdjacentHTML", "DOMParser", "createAsset("]) assert(!source.includes(forbidden), forbidden);
  assert(source.includes("createAssetKeyed"));
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(!sw.includes("code-diff-artifacts"));
});
