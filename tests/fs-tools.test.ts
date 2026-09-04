// tests/fs-tools.test.ts — model-facing local-file tools over a granted
// DirectoryHandle (CAP-FB-20260831-FS-GRANT-TASK-USE-01).
//
// The owner report: a folder granted through /folder is not picked up by the
// run, the file tools fail with no error message, and the errors are opaque.
// These tests pin the fix:
//   - grepFsGrant walks a DirectoryHandle recursively and returns matches with
//     { path, line, text } — real grep, not a silent empty result.
//   - the run-facing tools (grep_files / read_file / list_files / find_files /
//     list_folders) resolve the folder attached to the run and NEVER fail
//     silently: every failure is a bounded JSON object
//     { ok:false, error:<human>, code:<machine>, path? }.
//
// Falsification: revert grepFsGrant's `{ ok:false, error:"grant_not_found" }`
// to a bare `null`/`undefined` (a silent failure) and the "never a silent
// failure" assertions below go RED.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { grepFsGrant, saveFsGrant, deleteFsGrant } from "../extension/lib/fs-grants.js";
import { browserToolset } from "../extension/lib/browser-tools.js";
import { setRunContext, clearRunContext } from "../extension/lib/run-context.js";

// ── an in-memory functional DirectoryHandle (native FSA subset) ────────────
function fileHandle(name: string, content: string | Uint8Array) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
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
  };
}

function dirHandle(name: string, children: Record<string, any>) {
  const entries = Object.entries(children);
  return {
    kind: "directory",
    name,
    queryPermission: async () => "granted",
    async *values() {
      for (const [, h] of entries) yield h;
    },
    getDirectoryHandle: async (childName: string) => {
      const found = children[childName];
      if (!found || found.kind !== "directory") throw new Error("NotFoundError");
      return found;
    },
    getFileHandle: async (childName: string) => {
      const found = children[childName];
      if (!found || found.kind !== "file") throw new Error("NotFoundError");
      return found;
    },
  };
}

function sampleTree() {
  return dirHandle("project", {
    "readme.md": fileHandle("readme.md", "hello world\nthe needle is here\nlast line"),
    "src": dirHandle("src", {
      "app.js": fileHandle("app.js", "const x = 1;\n// TODO needle in code\nexport default x;"),
      "data.bin": fileHandle("data.bin", new Uint8Array([0x00, 0x01, 0x80, 0x00])),
    }),
  });
}

// The in-memory handles carry live functions (values/getFile/queryPermission)
// that structuredClone cannot serialize, so — like the searchFsGrantFiles KAT —
// these use the DEFAULT store (memory fallback in Deno), not a fake IndexedDB.
Deno.test("grepFsGrant: recursively returns matches with path + line + text", async () => {
  const grantId = `fsg_grep_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: sampleTree(), name: "project" });
  try {
    const res: any = await grepFsGrant(grantId, { query: "needle" });
    assertEquals(res.ok, true);
    const paths = res.matches.map((m: any) => `${m.path}:${m.line}`);
    assert(paths.includes("readme.md:2"), `expected readme.md:2 in ${JSON.stringify(paths)}`);
    assert(paths.includes("src/app.js:2"), `expected src/app.js:2 in ${JSON.stringify(paths)}`);
    for (const m of res.matches) {
      assert(typeof m.path === "string" && m.path.length > 0, "match carries a path");
      assert(typeof m.line === "number" && m.line >= 1, "match carries a 1-based line number");
      assert(typeof m.text === "string" && m.text.includes("needle"), "match carries the matching line text");
    }
    // The mislabelled binary file is skipped, not decoded as garbage.
    assert(!res.matches.some((m: any) => m.path.endsWith("data.bin")), "binary content is skipped");
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("grepFsGrant: case-insensitive and regex modes", async () => {
  const grantId = `fsg_grep_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: sampleTree(), name: "project" });
  try {
    const ci: any = await grepFsGrant(grantId, { query: "NEEDLE", ignoreCase: true });
    assertEquals(ci.ok, true);
    assert(ci.matches.length >= 2, "case-insensitive finds both needles");

    const rx: any = await grepFsGrant(grantId, { query: "TO\\w+", regex: true });
    assertEquals(rx.ok, true);
    assert(rx.matches.some((m: any) => m.text.includes("TODO")), "regex matches the TODO line");
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("grepFsGrant: structured errors — missing grant, empty query, invalid regex (never silent)", async () => {
  const missing: any = await grepFsGrant(`fsg_absent_${crypto.randomUUID()}`, { query: "x" });
  assert(missing && missing.ok === false, "a missing grant returns a bounded object, never null/undefined");
  assertEquals(missing.error, "grant_not_found");

  const grantId = `fsg_grep_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: sampleTree(), name: "project" });
  try {
    const empty: any = await grepFsGrant(grantId, { query: "   " });
    assert(empty.ok === false, "empty query is not a silent no-op");
    assertEquals(empty.error, "fs_grep_empty_query");

    const badRe: any = await grepFsGrant(grantId, { query: "(", regex: true });
    assert(badRe.ok === false, "invalid regex is not a silent no-op");
    assertEquals(badRe.error, "fs_grep_invalid_regex");
  } finally {
    await deleteFsGrant(grantId);
  }
});

// ── the run-facing tools ────────────────────────────────────────────────────
// The tools call the fs-grants store WITHOUT a customIdb, so they resolve
// against the default store (memory fallback in Deno). Unique grant ids keep
// the tests independent of any other file sharing the process.

Deno.test("grep_files tool: resolves the run's attached folder and returns matches", async () => {
  const grantId = `fsg_tool_grep_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: sampleTree(), name: "project" });
  setRunContext({ threadId: "t1", folderGrants: [{ grantId, name: "project" }] });
  try {
    const tools = browserToolset(false);
    assert(tools.grep_files, "grep_files tool is exposed");
    // No grantId argument — the tool must pick up the folder attached to the run.
    const res = await tools.grep_files.execute({ query: "needle" });
    assertEquals(res.ok, true, `expected matches, got ${JSON.stringify(res)}`);
    assert(res.matches.length >= 2, "grep over the attached folder returns matches");
    assert(res.matches.every((m: any) => typeof m.path === "string" && typeof m.line === "number"));
  } finally {
    clearRunContext();
    await deleteFsGrant(grantId);
  }
});

Deno.test("read_file tool: a bad path returns { ok:false, error, code, path } — never silent", async () => {
  const grantId = `fsg_tool_read_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: sampleTree(), name: "project" });
  setRunContext({ threadId: "t1", folderGrants: [{ grantId, name: "project" }] });
  try {
    const tools = browserToolset(false);
    const ok = await tools.read_file.execute({ path: "readme.md" });
    assertEquals(ok.ok, true, `expected a read, got ${JSON.stringify(ok)}`);
    assert(String(ok.content).includes("needle"), "read_file returns the file text");

    const bad = await tools.read_file.execute({ path: "nope.txt" });
    assert(bad && bad.ok === false, "a missing file is a structured error, never silent");
    assert(typeof bad.error === "string" && bad.error.length > 0, "human-readable message present");
    assertEquals(bad.code, "file_not_found");
    assertEquals(bad.path, "nope.txt");
  } finally {
    clearRunContext();
    await deleteFsGrant(grantId);
  }
});

Deno.test("read_file tool: the owner repro — a 9080-byte file reads completely past maxBytes 2000; offset/length window the rest", async () => {
  // chrome-agent-platform-jb0a: read_file on cairn-gateway/README.md (9080
  // bytes) was refused with fs_file_too_large at the 2000-byte maxBytes bound.
  // Reads are local and must never be refused on size: the COMPLETE content
  // comes back, and offset/length page a file in chunks. Falsification: revert
  // the read-bound removal and this test goes RED (fs_file_too_large instead
  // of content).
  const grantId = `fsg_tool_read_big_${crypto.randomUUID()}`;
  const head = "cairn-gateway/README.md\n";
  const text = head + "z".repeat(9080 - head.length);
  assertEquals(new TextEncoder().encode(text).byteLength, 9080);
  const tree = dirHandle("project", {
    "cairn-gateway": dirHandle("cairn-gateway", {
      "README.md": fileHandle("README.md", text),
    }),
  });
  await saveFsGrant({ grantId, handle: tree, name: "project" });
  setRunContext({ threadId: "t1", folderGrants: [{ grantId, name: "project" }] });
  try {
    const tools = browserToolset(false);
    const rel = "cairn-gateway/README.md";

    // The legacy maxBytes transport knob is passed at its old 2000-byte value:
    // the read must still return the COMPLETE 9080 bytes.
    const whole: any = await tools.read_file.execute({ path: rel, maxBytes: 2000 });
    assertEquals(whole.ok, true, `the 9080-byte README must read: ${JSON.stringify(whole)}`);
    assertEquals(whole.size, 9080);
    assertEquals(whole.content, text, "complete content — no size refusal, no truncation");
    assert(typeof whole.sha256 === "string" && whole.sha256.length === 64);

    // Chunked reads: offset/length return exactly the requested byte window
    // with { start, end, size } so the caller can page to EOF.
    const first: any = await tools.read_file.execute({ path: rel, offset: 0, length: 4000 });
    assertEquals(first.ok, true, `windowed read must succeed: ${JSON.stringify(first)}`);
    assertEquals(first.start, 0);
    assertEquals(first.end, 4000);
    assertEquals(first.size, 9080);
    assertEquals(first.content, text.slice(0, 4000));

    const rest: any = await tools.read_file.execute({ path: rel, offset: 4000 });
    assertEquals(rest.ok, true, `tail read must succeed: ${JSON.stringify(rest)}`);
    assertEquals(rest.start, 4000);
    assertEquals(rest.end, 9080);
    assertEquals(rest.content, text.slice(4000));
    assertEquals(first.content + rest.content, text, "windows reassemble the complete file");
  } finally {
    clearRunContext();
    await deleteFsGrant(grantId);
  }
});

Deno.test("file tools: no folder attached returns a clear no_folder_granted error", async () => {
  clearRunContext();
  const tools = browserToolset(false);
  // Guard against a leftover global grant from another test file: name a grant
  // that certainly does not exist so the resolver reports the absence cleanly.
  const res = await tools.grep_files.execute({ query: "x", grantId: "fsg_definitely_absent_xyz" });
  assert(res && res.ok === false, "an absent grant never fails silently");
  assert(typeof res.error === "string" && res.error.length > 0, "the error is human-readable");
  assert(typeof res.code === "string" && res.code.length > 0, "the error carries a machine code");
});

Deno.test("list_folders tool: surfaces the folder attached to the run", async () => {
  const grantId = `fsg_tool_list_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: sampleTree(), name: "project" });
  setRunContext({ threadId: "t1", folderGrants: [{ grantId, name: "project" }] });
  try {
    const tools = browserToolset(false);
    const res = await tools.list_folders.execute({});
    assertEquals(res.ok, true);
    assert(res.folders.some((f: any) => f.grantId === grantId && f.name === "project"), `attached folder listed: ${JSON.stringify(res.folders)}`);
  } finally {
    clearRunContext();
    await deleteFsGrant(grantId);
  }
});

// ── write_file (CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01) ───────────────────
// The write tool never writes on its own: it resolves the run's grant, then
// hands { grantId, relativePath, content } to the run-bound fileWriteGate
// (the SW's fs-grant.write-file-approved route, which stages the diff card and
// writes only after Approve). With no gate bound it fails CLOSED.

function writableTree() {
  const written: Array<{ name: string; bytes: Uint8Array }> = [];
  const notes = {
    ...fileHandle("notes.txt", "hello\n"),
    createWritable: async () => ({
      write: async (b: Uint8Array) => { written.push({ name: "notes.txt", bytes: b }); },
      close: async () => {},
    }),
  };
  const dir = dirHandle("project", { "notes.txt": notes });
  return { dir, written };
}

Deno.test("write_file tool: with no approval gate bound it fails closed (fs_write_gate_unavailable) and never touches the store", async () => {
  const grantId = `fsg_tool_write_nogate_${crypto.randomUUID()}`;
  const { dir, written } = writableTree();
  await saveFsGrant({ grantId, handle: dir, name: "project", mode: "readwrite" });
  setRunContext({ threadId: "t-write", folderGrants: [{ grantId, name: "project" }] });
  try {
    const tools = browserToolset(false);
    assert(tools.write_file, "write_file tool is exposed");
    const res = await tools.write_file.execute({ path: "notes.txt", content: "changed\n" });
    assertEquals(res.ok, false);
    assertEquals(res.code, "fs_write_gate_unavailable");
    assert(typeof res.error === "string" && res.error.length > 0, "a human error, never silence");
    assertEquals(res.path, "notes.txt");
    assertEquals(written.length, 0, "nothing was written");
    // The scoped (hook) toolset never offers it at all.
    assertEquals("write_file" in browserToolset(true), false);
  } finally {
    clearRunContext();
    await deleteFsGrant(grantId);
  }
});

Deno.test("write_file tool: passes the resolved grant + path + complete content to the gate, returns its result, and projects a denial into a bounded JSON error", async () => {
  const grantId = `fsg_tool_write_gate_${crypto.randomUUID()}`;
  const { dir, written } = writableTree();
  await saveFsGrant({ grantId, handle: dir, name: "project", mode: "readwrite" });
  setRunContext({ threadId: "t-write", folderGrants: [{ grantId, name: "project" }] });
  const calls: any[] = [];
  try {
    let reply: any = { ok: true, written: true, path: "notes.txt", size: 8, sha256: "f".repeat(64), added: 1, removed: 1 };
    const tools = browserToolset(false, { fileWriteGate: async (payload: any) => { calls.push(payload); return reply; } } as any);
    // No grantId argument — the tool picks up the folder attached to the run.
    const ok = await tools.write_file.execute({ path: "notes.txt", content: "changed\n" });
    assertEquals(ok, reply);
    assertEquals(calls.length, 1);
    assertEquals(calls[0], { grantId, relativePath: "notes.txt", content: "changed\n" });
    assertEquals(written.length, 0, "the tool itself never writes — only the approved route does");

    reply = { ok: false, approvalDenied: true, error: "The owner denied fs.write; the action was not performed." };
    const denied = await tools.write_file.execute({ path: "notes.txt", content: "changed\n" });
    assertEquals(denied.ok, false);
    assertEquals(denied.code, "fs_write_denied");
    assertEquals(denied.error, "The owner denied fs.write; the action was not performed.");
    assertEquals(denied.path, "notes.txt");

    reply = { ok: false, approvalExpired: true, error: "Approval for fs.write expired after 60 seconds; the action was not performed." };
    const expired = await tools.write_file.execute({ path: "notes.txt", content: "changed\n" });
    assertEquals(expired.code, "fs_write_approval_expired");

    // A store boundary code from the route is humanized like every file tool error.
    reply = { ok: false, error: "fs_file_not_text", path: "blob.bin" };
    const binary = await tools.write_file.execute({ path: "blob.bin", content: "x" });
    assertEquals(binary.ok, false);
    assertEquals(binary.code, "fs_file_not_text");
    assert(/not UTF-8 text/.test(binary.error));

    // An unknown grant is refused BEFORE the gate is consulted.
    const before = calls.length;
    const missing = await tools.write_file.execute({ path: "notes.txt", content: "x", grantId: `fsg_absent_${crypto.randomUUID()}` });
    assertEquals(missing.ok, false);
    assertEquals(missing.code, "grant_not_found");
    assertEquals(calls.length, before, "no gate call for a grant that does not exist");
  } finally {
    clearRunContext();
    await deleteFsGrant(grantId);
  }
});

// ── agent private workspaces (CAP-FB-20260831-AGENT-PRIVATE-FS-01) ─────────
// The file tools fall back to the CURRENT AGENT's private OPFS workspace when
// no folder is attached to the run and the run belongs to a named/background
// agent. RED before the routing change: without the agent surface ref the tools
// returned no_folder_granted (they never reached a workspace).

// An in-memory OPFS root for the workspace (navigator.storage.getDirectory).
class WsShimFile {
  name: string; kind: string; bytes: Uint8Array;
  constructor(name: string) { this.name = name; this.kind = "file"; this.bytes = new Uint8Array(0); }
  async getFile() { return { name: this.name, size: this.bytes.byteLength, arrayBuffer: async () => this.bytes.slice().buffer }; }
  createWritable() {
    const self = this; const parts: (Uint8Array)[] = [];
    return {
      async write(data: string | Uint8Array) { parts.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)); },
      async close() { self.bytes = new Uint8Array(parts.flatMap((c) => [...c])); },
    };
  }
}
class WsShimDir {
  kids: Map<string, any>; name: string; kind: string;
  constructor(name: string) { this.name = name; this.kind = "directory"; this.kids = new Map(); }
  async getDirectoryHandle(n: string, { create }: { create?: boolean } = {}) {
    const k = String(n); const kid = this.kids.get(k);
    if (kid) return kid;
    if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
    const d = new WsShimDir(k); this.kids.set(k, d); return d;
  }
  async getFileHandle(n: string, { create }: { create?: boolean } = {}) {
    const k = String(n); const kid = this.kids.get(k);
    if (kid) return kid;
    if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
    const f = new WsShimFile(k); this.kids.set(k, f); return f;
  }
  async removeEntry(n: string) { this.kids.delete(String(n)); }
  async *values() { for (const kid of this.kids.values()) yield kid; }
}
const wsRoot = new WsShimDir("root");
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { getDirectory: async () => wsRoot, estimate: async () => ({ quota: Number.MAX_SAFE_INTEGER, usage: 0 }) } },
  configurable: true, writable: true,
});

function resetWs() { wsRoot.kids.clear(); }

Deno.test("workspace tools: a named agent with NO folder writes into its private workspace", async () => {
  resetWs();
  setRunContext({ threadId: "t1", agentSurfaceRef: "named:writer-agent" });
  try {
    const tools = browserToolset(false);
    assert(tools.write_file, "write_file tool is exposed");
    const w = await tools.write_file.execute({ path: "notes/plan.md", content: "plan v1" });
    assertEquals(w.ok, true, `write into the private workspace failed: ${JSON.stringify(w)}`);
    assertEquals(w.workspace, "named-writer-agent");
    const r = await tools.read_file.execute({ path: "notes/plan.md" });
    assertEquals(r.ok, true, `read back failed: ${JSON.stringify(r)}`);
    assertEquals(r.content, "plan v1");
    const l = await tools.list_files.execute({ path: "notes" });
    assertEquals(l.ok, true);
    assert(l.entries.some((e: any) => e.name === "plan.md"), "the file is listed");
  } finally {
    clearRunContext();
  }
});

Deno.test("workspace tools: isolation — a second agent cannot read the first's file", async () => {
  resetWs();
  setRunContext({ threadId: "t1", agentSurfaceRef: "named:writer-agent" });
  try {
    const tools = browserToolset(false);
    await tools.write_file.execute({ path: "secret.txt", content: "only A" });
  } finally {
    clearRunContext();
  }
  setRunContext({ threadId: "t2", agentSurfaceRef: "named:reader-agent" });
  try {
    const tools = browserToolset(false);
    const r = await tools.read_file.execute({ path: "secret.txt" });
    assert(r.ok === false, "agent B must NOT read agent A's workspace file");
    assertEquals(r.code, "file_not_found");
  } finally {
    clearRunContext();
  }
});

Deno.test("workspace tools: an explicit grantId still wins over the workspace", async () => {
  const grantId = `fsg_ws_prio_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: sampleTree(), name: "project" });
  setRunContext({ agentSurfaceRef: "named:writer-agent", folderGrants: [{ grantId, name: "project" }] });
  try {
    const tools = browserToolset(false);
    // Both a grant AND an agent workspace are in scope; the attached folder wins.
    const r = await tools.read_file.execute({ path: "readme.md" });
    assertEquals(r.ok, true, `grant path must win: ${JSON.stringify(r)}`);
    assert(String(r.content).includes("needle"), "reads from the granted folder, not the workspace");
    // Explicit grantId on a missing grant never silently falls back.
    const bad = await tools.read_file.execute({ path: "x", grantId: "fsg_definitely_absent_zzz" });
    assert(bad.ok === false);
    assertEquals(bad.code, "grant_not_found");

  } finally {
    clearRunContext();
    await deleteFsGrant(grantId);
  }
});
