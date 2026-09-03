// @ts-nocheck
// tests/dptw-tools-past-bound.test.ts — dptw area 1 (Tools): every operation
// below succeeds PAST the self-imposed bound the audit named. Before the
// removal each of these was RED (refused/truncated at the cap); after, GREEN.
//
// Falsification: restore any removed bound (TOOL_ARGUMENT_LIMITS,
// TOOL_SEARCH_BOUNDS clamps, MAX_FS_WRITE_BYTES, MAX_FS_GREP_FILE_BYTES,
// MAX_FS_LIST_ENTRIES, MAX_FS_PATH_DEPTH, the model-catalog 120-char id drop
// or the single-page fetch) and the matching test goes RED again.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { sanitizeLazyToolArguments } from "../extension/lib/lazy-tool-protocol.js";
import {
  buildToolSearchIndex,
  projectToolSearchResult,
  searchToolIndex,
} from "../extension/lib/tool-search.js";
import { canonicalToolDescriptor } from "../extension/lib/tool-catalog.js";
import { fetchLiveModels } from "../extension/lib/model-catalog.js";
import {
  deleteFsGrant,
  grepFsGrant,
  listFsGrantEntries,
  readFsGrantFile,
  saveFsGrant,
  writeFsGrantFile,
} from "../extension/lib/fs-grants.js";

// chrome.storage stub so provider.js (imported by model-catalog.js) loads.
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of Array.isArray(key) ? key : [key]) {
          if (store.has(k)) out[k] = structuredClone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
      },
      remove: async (key) => {
        for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
      },
    },
  },
};

// ── T1/T5: tool arguments carry any size and shape of plain JSON ───────────

Deno.test("T1: a 64 KiB string argument passes sanitization whole (was: 16 KiB string cap / 32 KiB payload cap)", () => {
  const big = "x".repeat(64 * 1024);
  const out = sanitizeLazyToolArguments({ value: big }, { sourceKind: "extension-builtin", toolId: "echo" });
  assertEquals(out.value.length, big.length, "the string arrives whole");
});

Deno.test("T5: depth-12 nested arguments pass (was: depth cap 8)", () => {
  let value: any = { leaf: "deep" };
  for (let i = 0; i < 12; i++) value = { ["level" + i]: value };
  const out = sanitizeLazyToolArguments(value, { sourceKind: "extension-builtin", toolId: "echo" });
  assertEquals(typeof out, "object");
});

Deno.test("T5: a 512-key object and a 128-item array pass (was: 64 keys / 64 items)", () => {
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 512; i++) wide["k" + i] = i;
  const out: any = sanitizeLazyToolArguments({ wide, list: Array.from({ length: 128 }, (_, i) => i) }, { sourceKind: "extension-builtin", toolId: "echo" });
  assertEquals(Object.keys(out.wide).length, 512);
  assertEquals(out.list.length, 128);
});

Deno.test("T2/T3: a 512 KiB content field passes whole (was: 288 KiB envelope / 256 KiB content)", () => {
  const content = "ab".repeat(256 * 1024); // 512 KiB
  const out = sanitizeLazyToolArguments({ path: "big.txt", content }, { sourceKind: "chrome-api", toolId: "write_file" });
  assertEquals(out.content.length, content.length, "the complete file body arrives");
});

// ── T6: search_tools returns every match and complete summaries ────────────

function fakeDescriptor(i: number, description = "") {
  return canonicalToolDescriptor({
    sourceKind: "extension-builtin",
    packageId: "pkg",
    toolId: "tool_" + i,
    version: "1.0.0",
    name: "needle tool " + i,
    description: description || "a needle tool for finding things, number " + i,
    capabilities: [],
    scope: { hub: true },
    sourceGeneration: "gen-1",
    availability: "ready",
    trustedReplaySafety: "safe",
    dispatcherKind: "direct",
    inputSchema: { type: "object" },
  });
}

Deno.test("T6: search honors a requested limit of 50 (was: clamped to maxTopK 12)", () => {
  const index = buildToolSearchIndex({
    generation: "g1",
    descriptors: Array.from({ length: 30 }, (_, i) => fakeDescriptor(i)),
  });
  const res = searchToolIndex(index, "needle", { limit: 50 });
  assertEquals(res.results.length, 30, "every matching tool is returned");
});

Deno.test("T6: a search result carries the complete 2 KiB description (was: 512-byte summary truncation)", () => {
  const description = "d".repeat(2048);
  const descriptor = fakeDescriptor(0, description);
  const projected = projectToolSearchResult(descriptor);
  assertEquals(projected.summary.length, description.length, "the description is complete, not clipped");
});

// ── model catalog: complete listings (verified-claims rows) ────────────────

Deno.test("catalog: Gemini listing follows nextPageToken (was: first page of 200 only)", async () => {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (url: any) => {
    seen.push(String(url));
    if (seen.length === 1) {
      return new Response(JSON.stringify({
        models: [{ name: "models/gemini-3.7-flash" }],
        nextPageToken: "page2",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      models: [{ name: "models/gemini-3.8-flash" }],
    }), { status: 200 });
  };
  try {
    const ids = await fetchLiveModels("gemini", { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "gk" });
    assertEquals(seen.length, 2, "the second page was fetched");
    assert(String(seen[1]).includes("pageToken=page2"), "the page token travels");
    assert(ids.includes("gemini-3.7-flash") && ids.includes("gemini-3.8-flash"), `both pages' models listed: ${ids}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("catalog: Anthropic listing follows its pagination cursor (was: first page of 100 only)", async () => {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (url: any) => {
    seen.push(String(url));
    if (seen.length === 1) {
      return new Response(JSON.stringify({
        data: [{ id: "claude-sonnet-5", type: "model" }],
        has_more: true,
        last_id: "claude-sonnet-5",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [{ id: "claude-fable-5-1", type: "model" }],
      has_more: false,
    }), { status: 200 });
  };
  try {
    const ids = await fetchLiveModels("anthropic", { baseURL: "https://api.anthropic.com/v1", apiKey: "ak" });
    assertEquals(seen.length, 2, "the second page was fetched");
    assert(String(seen[1]).includes("after_id=claude-sonnet-5"), "the cursor travels");
    assert(ids.includes("claude-sonnet-5") && ids.includes("claude-fable-5-1"), `both pages' models listed: ${ids}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("catalog: a >120-character model id is kept, not silently dropped", async () => {
  const realFetch = globalThis.fetch;
  const longId = "provider/" + "m".repeat(140);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: longId }, { id: "gpt-5.5" }] }), { status: 200 });
  try {
    const ids = await fetchLiveModels("openai", { baseURL: "https://api.openai.com/v1", apiKey: "sk-test" });
    assert(ids.includes(longId), "the long id survives");
    assert(ids.includes("gpt-5.5"), "ordinary ids still listed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── T18-T23: fs-grants carry complete data at any size ─────────────────────

function writableFileHandle(name: string) {
  let bytes = new Uint8Array(0);
  return {
    handle: {
      kind: "file",
      name,
      getFile: async () => ({
        name,
        size: bytes.byteLength,
        lastModified: 1700000000000,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        slice: (start: number, end: number) => ({
          arrayBuffer: async () => bytes.subarray(start, end).slice().buffer,
        }),
      }),
      createWritable: async () => ({
        write: async (chunk: any) => {
          const next = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk ?? ""));
          const merged = new Uint8Array(bytes.byteLength + next.byteLength);
          merged.set(bytes, 0);
          merged.set(next, bytes.byteLength);
          bytes = merged;
        },
        close: async () => {},
      }),
    },
    size: () => bytes.byteLength,
  };
}

function dirOf(name: string, children: Record<string, any>) {
  const entries = Object.entries(children);
  return {
    kind: "directory",
    name,
    queryPermission: async () => "granted",
    async *values() {
      for (const [, h] of entries) yield h;
    },
    getDirectoryHandle: async (childName: string, opts?: any) => {
      const found = children[childName];
      if (!found || found.kind !== "directory") throw new Error("NotFoundError");
      return found;
    },
    getFileHandle: async (childName: string, opts?: any) => {
      const found = children[childName];
      if (!found) {
        if (opts?.create) {
          const created = writableFileHandle(childName);
          children[childName] = created.handle;
          return created.handle;
        }
        throw new Error("NotFoundError");
      }
      if (found.kind !== "file") throw new Error("TypeMismatchError");
      return found;
    },
  };
}

Deno.test("T20: write_file stores a 10 MiB file whole (was: fs_file_too_large at 5 MiB)", async () => {
  const grantId = `fsg_dptw_${crypto.randomUUID()}`;
  const bigFile = writableFileHandle("big.bin");
  await saveFsGrant({ grantId, handle: dirOf("project", { "big.bin": bigFile.handle }), name: "project", mode: "readwrite" });
  try {
    const content = new Uint8Array(10 * 1024 * 1024).fill(0x61);
    const res: any = await writeFsGrantFile(grantId, { relativePath: "big.bin", content });
    assertEquals(res.ok, true, `write accepted: ${res.error ?? "ok"}`);
    assertEquals(bigFile.size(), content.byteLength, "every byte landed");
    const read: any = await readFsGrantFile(grantId, { relativePath: "big.bin", asText: false });
    assertEquals(read.ok, true);
    assertEquals(read.size, content.byteLength, "read back complete");
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("T22: grep finds a match past the 2 MiB per-file skip (was: file skipped)", async () => {
  const grantId = `fsg_dptw_${crypto.randomUUID()}`;
  const bigText = "a\n".repeat(1024 * 1024) + "the-needle-past-two-mib\n" + "b\n".repeat(128);
  const f = writableFileHandle("big.txt");
  await f.handle.createWritable().then(async (w) => { await w.write(bigText); await w.close(); });
  await saveFsGrant({ grantId, handle: dirOf("project", { "big.txt": f.handle }), name: "project" });
  try {
    const res: any = await grepFsGrant(grantId, { query: "the-needle-past-two-mib" });
    assertEquals(res.ok, true);
    assertEquals(res.matches.length, 1, `match found in the >2 MiB file: ${JSON.stringify(res.matches?.slice?.(0, 2))}`);
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("T21: a directory with 600 entries lists all of them (was: 500-entry cap)", async () => {
  const grantId = `fsg_dptw_${crypto.randomUUID()}`;
  const children: Record<string, any> = {};
  for (let i = 0; i < 600; i++) children["f" + String(i).padStart(4, "0") + ".txt"] = writableFileHandle("f" + i + ".txt").handle;
  await saveFsGrant({ grantId, handle: dirOf("project", children), name: "project" });
  try {
    const res: any = await listFsGrantEntries(grantId, {});
    assertEquals(res.ok, true);
    assertEquals(res.entries.length, 600, `all entries listed: got ${res.entries?.length}`);
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("T23: a 20-deep path reads (was: max_depth_exceeded at 16); traversal still refused", async () => {
  const grantId = `fsg_dptw_${crypto.randomUUID()}`;
  const leaf = writableFileHandle("leaf.txt");
  await leaf.handle.createWritable().then(async (w) => { await w.write("deep content"); await w.close(); });
  let tree: any = { "leaf.txt": leaf.handle };
  for (let i = 19; i >= 1; i--) tree = { ["d" + i]: dirOf("d" + i, tree) };
  await saveFsGrant({ grantId, handle: dirOf("project", tree), name: "project" });
  try {
    const deepPath = Array.from({ length: 19 }, (_, i) => "d" + (i + 1)).join("/") + "/leaf.txt";
    const res: any = await readFsGrantFile(grantId, { relativePath: deepPath });
    assertEquals(res.ok, true, `deep read ok: ${res.error ?? "ok"}`);
    assertEquals(res.content, "deep content");
    // The traversal guard is a SECURITY row and stays.
    const escape: any = await readFsGrantFile(grantId, { relativePath: "../outside.txt" });
    assertEquals(escape.ok, false, "traversal is still refused");
  } finally {
    await deleteFsGrant(grantId);
  }
});
