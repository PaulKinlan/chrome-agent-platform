// tests/agent-workspace.test.ts — CAP-FB-20260831-AGENT-PRIVATE-FS-01
//
// Every named/background agent gets a persistent PRIVATE OPFS workspace
// (agent-workspaces/<key>/) — lazily created, isolated per agent, bounded by a
// per-agent quota, reachable by the file tools as the default when no fs-grant
// is in scope, and clearable only by an owner gesture. @ts-nocheck — the OPFS
// shim is intentionally dynamic.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  workspaceKeyFromSurfaceRef,
  workspaceKeyFromAgentId,
  backgroundWorkspaceKeyFromAgentId,
  resolveAgentWorkspace,
  listWorkspaceEntries,
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceFile,
  searchWorkspaceFiles,
  clearAgentWorkspace,
  getWorkspaceUsageByKey,
  DEFAULT_WORKSPACE_BYTES,
  DEFAULT_WORKSPACE_FILES,
} from "../extension/lib/agent-workspace.js";
import * as ws from "../extension/lib/agent-workspace.js";

// ── OPFS shim (values() + getFile() + createWritable) ──────────────────────
class ShimFile {
  constructor(name) {
    this.name = name;
    this.kind = "file";
    this.bytes = new Uint8Array(0);
  }
  async getFile() {
    return { name: this.name, size: this.bytes.byteLength, arrayBuffer: async () => this.bytes.slice().buffer };
  }
  createWritable() {
    const self = this;
    const parts = [];
    return {
      async write(data) { parts.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)); },
      async close() { self.bytes = new Uint8Array(parts.flatMap((c) => [...c])); },
    };
  }
}
class ShimDir {
  constructor(name) {
    this.name = name;
    this.kind = "directory";
    this.kids = new Map();
  }
  async getDirectoryHandle(n, { create } = {}) {
    const k = String(n);
    const kid = this.kids.get(k);
    if (kid) return kid;
    if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
    const d = new ShimDir(k);
    this.kids.set(k, d);
    return d;
  }
  async getFileHandle(n, { create } = {}) {
    const k = String(n);
    const kid = this.kids.get(k);
    if (kid) return kid;
    if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
    const f = new ShimFile(k);
    this.kids.set(k, f);
    return f;
  }
  async removeEntry(n, opts = {}) {
    this.kids.delete(String(n));
  }
  async *values() {
    for (const kid of this.kids.values()) yield kid;
  }
  async *entries() {
    for (const [name, kid] of this.kids) yield [name, kid];
  }
}

const root = new ShimDir("root");
const navigatorOverride = {
  storage: {
    async getDirectory() { return root; },
    async estimate() { return { quota: Number.MAX_SAFE_INTEGER, usage: 0 }; },
  },
};
Object.defineProperty(globalThis, "navigator", { value: navigatorOverride, configurable: true, writable: true });
function resetStore() { root.kids.clear(); }
resetStore();

// A fake run-context: the workspace resolver reads agentSurfaceRef only.
const namedCtxA = () => ({ agentSurfaceRef: "named:agent-a" });
const namedCtxB = () => ({ agentSurfaceRef: "named:agent-b" });
const backgroundCtx = () => ({ agentSurfaceRef: "background:recipe-sort" });
const hubCtx = () => ({ agentSurfaceRef: null });

// ── key derivation ──────────────────────────────────────────────────────────
Deno.test("workspace keys derive from the agent identity", () => {
  assertEquals(workspaceKeyFromSurfaceRef("named:agent-a"), "named-agent-a");
  assertEquals(workspaceKeyFromSurfaceRef("background:recipe-sort"), "background-recipe-sort");
  assertEquals(workspaceKeyFromSurfaceRef(null), null);
  assertEquals(workspaceKeyFromSurfaceRef(""), null);
  assertEquals(workspaceKeyFromSurfaceRef("hub"), null); // hub/site runs have NO workspace
  assertEquals(workspaceKeyFromSurfaceRef("named:upper-1"), "named-upper-1");
  assertEquals(workspaceKeyFromAgentId("Agent A!"), "named-agent-a");
  assertEquals(backgroundWorkspaceKeyFromAgentId("Recipe: Sort"), "background-recipe-sort");
});

// ── lazy creation + persistence + isolation ─────────────────────────────────
Deno.test("workspace is created lazily per agent and persists across runs", async () => {
  resetStore();
  // Run 1: agent A writes a file (no workspace existed before).
  const w1 = await writeWorkspaceFile("notes.md", "hello from A", { currentRunContext: namedCtxA });
  assert(w1.ok === true, `write failed: ${w1.error ?? ""}`);
  assertEquals(w1.workspace, "named-agent-a");
  // The directory was created under agent-workspaces/named-agent-a.
  const wsRoot = await root.getDirectoryHandle("agent-workspaces");
  await wsRoot.getDirectoryHandle("named-agent-a"); // exists now
  // Run 2 (a SEPARATE stamp of the same agent — a later task): the directory
  // persists, so the read resolves the same content.
  const run2Ctx = () => ({ agentSurfaceRef: "named:agent-a" });
  const r = await readWorkspaceFile("notes.md", { currentRunContext: run2Ctx });
  assert(r.ok === true, `read failed: ${r.error ?? ""}`);
  assertEquals(r.content, "hello from A");
  assertEquals(r.size, 12);
  // SHA-256("hello from A") — deterministic value.
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hello from A"));
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(r.sha256, hex);
});

Deno.test("isolation: agent B cannot read agent A's workspace files", async () => {
  resetStore();
  await writeWorkspaceFile("secret.txt", "A's secret", { currentRunContext: namedCtxA });
  // B reads the same relative path — its OWN (empty) workspace → file_not_found.
  const rb = await readWorkspaceFile("secret.txt", { currentRunContext: namedCtxB });
  assert(rb.ok === false, "B must not read A's file");
  assertEquals(rb.error, "file_not_found");
  // B's directory is a DIFFERENT key: list B → empty, list A → 1 file.
  const la = await listWorkspaceEntries("", { currentRunContext: namedCtxA });
  assert(la.ok === true);
  const names = la.entries.map((e) => e.name);
  assert(names.includes("secret.txt"), "A sees its own file");
  const lb = await listWorkspaceEntries("", { currentRunContext: namedCtxB });
  assert(lb.ok === true);
  assertEquals(lb.entries.filter((e) => e.name !== ".quota.json").length, 0, "B sees nothing of A's");
});

Deno.test("hub/site runs have NO workspace (no_agent_workspace)", async () => {
  resetStore();
  const w = await writeWorkspaceFile("x.txt", "x", { currentRunContext: hubCtx });
  assert(w.ok === false);
  assertEquals(w.error, "no_agent_workspace");
  const l = await listWorkspaceEntries("", { currentRunContext: hubCtx });
  assert(l.ok === false);
  assertEquals(l.error, "no_agent_workspace");
});

Deno.test("background agents get their own workspace, separate from named", async () => {
  resetStore();
  await writeWorkspaceFile("run.log", "bg", { currentRunContext: backgroundCtx });
  const r = await readWorkspaceFile("run.log", { currentRunContext: backgroundCtx });
  assert(r.ok === true);
  assertEquals(r.content, "bg");
  // A named agent of a similar slug still has its own empty dir.
  const ln = await listWorkspaceEntries("", { currentRunContext: namedCtxA });
  assert(ln.ok === true);
  assertEquals(ln.entries.filter((e) => e.name !== ".quota.json").length, 0);
});

// ── bounds ──────────────────────────────────────────────────────────────────
Deno.test("quota: writes over the byte cap fail closed with an honest error", async () => {
  resetStore();
  // Pre-fill near the 20 MiB cap: write MAX bytes into a big file first? The
  // cap is 20 MiB; writing 21 MiB in one shot trips MAX_FS_WRITE_BYTES (5 MiB)
  // first. To exercise the workspace quota we pad with several 5 MiB files.
  const big = "x".repeat(4 * 1024 * 1024);
  for (let i = 0; i < 5; i++) {
    const w = await writeWorkspaceFile(`big${i}.bin`, big, { currentRunContext: namedCtxA });
    assert(w.ok === true, `seed ${i} failed: ${w.error ?? ""}`);
  }
  // 5 × 4 MiB = 20 MiB; one more 1-byte write must exceed the cap.
  const over = await writeWorkspaceFile("tiny.txt", "y", { currentRunContext: namedCtxA });
  assert(over.ok === false, "write past the quota must fail");
  assertEquals(over.error, "workspace_quota_exceeded");
});

Deno.test("quota: file-count cap fails closed", async () => {
  resetStore();
  // DEFAULT_WORKSPACE_FILES = 200; writing 200 small files then one more fails.
  for (let i = 0; i < DEFAULT_WORKSPACE_FILES; i++) {
    const w = await writeWorkspaceFile(`f${i}.txt`, "x", { currentRunContext: namedCtxA });
    assert(w.ok === true, `seed ${i} failed: ${w.error ?? ""}`);
  }
  const over = await writeWorkspaceFile("one-more.txt", "x", { currentRunContext: namedCtxA });
  assert(over.ok === false);
  assertEquals(over.error, "workspace_quota_exceeded");
});

Deno.test("path grammar is bounded (traversal + depth refused)", async () => {
  resetStore();
  const w = await writeWorkspaceFile("../escape.txt", "x", { currentRunContext: namedCtxA });
  assert(w.ok === false, "parent traversal must be refused");
  let deep = "a";
  for (let i = 0; i < 12; i++) deep += "/b";
  const d = await writeWorkspaceFile(`${deep}.txt`, "x", { currentRunContext: namedCtxA });
  assert(d.ok === false);
  assertEquals(d.error, "max_depth_exceeded");
});

// ── owner Clear ─────────────────────────────────────────────────────────────
Deno.test("owner Clear empties the workspace and usage reports it", async () => {
  resetStore();
  await writeWorkspaceFile("a.txt", "hello", { currentRunContext: namedCtxA });
  await writeWorkspaceFile("sub/b.txt", "world", { currentRunContext: namedCtxA });
  const before = await getWorkspaceUsageByKey("named-agent-a");
  assert(before.ok === true);
  assert(before.filesUsed >= 2, `expected ≥2 files, got ${before.filesUsed}`);
  assertEquals(before.maxBytes, DEFAULT_WORKSPACE_BYTES);
  assertEquals(before.maxFiles, DEFAULT_WORKSPACE_FILES);

  const c = await clearAgentWorkspace({ key: "named-agent-a" });
  assert(c.ok === true, `clear failed: ${c.error ?? ""}`);
  const after = await getWorkspaceUsageByKey("named-agent-a");
  assert(after.ok === true);
  assertEquals(after.filesUsed, 0);
  assertEquals(after.bytesUsed, 0);
  const l = await listWorkspaceEntries("", { currentRunContext: namedCtxA });
  assert(l.ok === true);
  assertEquals(l.entries.filter((e) => e.name !== ".quota.json").length, 0);
});

// ── delete + search ─────────────────────────────────────────────────────────
Deno.test("delete + name search work inside the workspace", async () => {
  resetStore();
  await writeWorkspaceFile("report-final.md", "r", { currentRunContext: namedCtxA });
  await writeWorkspaceFile("draft.md", "d", { currentRunContext: namedCtxA });
  const found = await searchWorkspaceFiles("final", { currentRunContext: namedCtxA });
  assert(found.ok === true);
  assertEquals(found.files.length, 1);
  assertEquals(found.files[0].name, "report-final.md");
  const del = await deleteWorkspaceFile("draft.md", { currentRunContext: namedCtxA });
  assert(del.ok === true, `delete failed: ${del.error ?? ""}`);
  const rd = await readWorkspaceFile("draft.md", { currentRunContext: namedCtxA });
  assert(rd.ok === false);
  assertEquals(rd.error, "file_not_found");
});

// ── nested subdirectories ───────────────────────────────────────────────────
Deno.test("subdirectories are created on write and listed", async () => {
  resetStore();
  await writeWorkspaceFile("data/raw/input.csv", "1,2\n", { currentRunContext: namedCtxA });
  const l = await listWorkspaceEntries("data", { currentRunContext: namedCtxA });
  assert(l.ok === true);
  const names = l.entries.map((e) => e.name);
  assert(names.includes("raw"), "subdir listed");
  const r = await readWorkspaceFile("data/raw/input.csv", { currentRunContext: namedCtxA });
  assert(r.ok === true);
  assertEquals(r.content, "1,2\n");
});
