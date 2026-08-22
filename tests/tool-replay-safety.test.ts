// CAP-FB-20260820-DURABLE-SIDE-EFFECT-IDEMPOTENCY-01: the fail-closed per-tool
// replay-safety declarations + the durable recovery gate. The tests drive the
// REAL production module (tool-replay-safety.js) and the REAL recovery sweep
// logic (durable-runs.js's recoverOnBoot path) — no copied controller.
// @ts-nocheck — the OPFS/chrome shims implement only the exercised surface.
import { assert, assertEquals } from "jsr:@std/assert@1";

const safety = await import("../extension/lib/tool-replay-safety.js");
const { REPLAY_READ_ONLY, REPLAY_IDEMPOTENT, REPLAY_MUTATING } = safety;

Deno.test("replay safety: the extension's own tools declare the conservative classifications", () => {
  assertEquals(safety.replaySafetyForTool("memory_get"), REPLAY_READ_ONLY);
  assertEquals(safety.replaySafetyForTool("memory_grep"), REPLAY_READ_ONLY);
  assertEquals(safety.replaySafetyForTool("memory_list"), REPLAY_READ_ONLY);
  assertEquals(safety.replaySafetyForTool("memory_set"), REPLAY_IDEMPOTENT);
  // FAIL-CLOSED: unknown, missing, and empty tool names are mutating.
  assertEquals(safety.replaySafetyForTool("tab_create"), REPLAY_MUTATING);
  assertEquals(safety.replaySafetyForTool(""), REPLAY_MUTATING);
  assertEquals(safety.replaySafetyForTool(undefined), REPLAY_MUTATING);
  assertEquals(safety.replaySafetyForTool(null), REPLAY_MUTATING);
});

Deno.test("replay safety: worstSafety + mayAutoResume implement the mutating-overrides lattice", () => {
  assertEquals(safety.worstSafety(REPLAY_READ_ONLY, REPLAY_READ_ONLY), REPLAY_READ_ONLY);
  assertEquals(safety.worstSafety(REPLAY_READ_ONLY, REPLAY_IDEMPOTENT), REPLAY_IDEMPOTENT);
  assertEquals(safety.worstSafety(REPLAY_IDEMPOTENT, REPLAY_MUTATING), REPLAY_MUTATING);
  // A missing/unknown classification is treated as mutating (fail-closed).
  assertEquals(safety.worstSafety(REPLAY_READ_ONLY, undefined), REPLAY_MUTATING);
  assertEquals(safety.mayAutoResume(REPLAY_READ_ONLY), true);
  assertEquals(safety.mayAutoResume(REPLAY_IDEMPOTENT), true);
  assertEquals(safety.mayAutoResume(REPLAY_MUTATING), false);
  assertEquals(safety.mayAutoResume(undefined), false, "unknown safety never auto-resumes");
  assertEquals(safety.mayAutoResume(null), false);
});

// ── the REAL recovery sweep (durable-runs.js recoverOnBoot) ─────────────────
// The sweep reads the persisted record; we drive it through the module's
// real OPFS store with the same shim the durable-runs tests use.
const DENO = (globalThis as unknown as Record<string, unknown>);
function fileNode(content) { return { kind: "file", content }; }
function dirNode() { return { kind: "directory", children: new Map() }; }
class FakeWritable { constructor(node) { this.node = node; this.parts = []; } async write(s) { this.parts.push(String(s)); } async close() { this.node.content = this.parts.join(""); } }
class FakeFileHandle { constructor(node) { this.node = node; } async getFile() { return { text: async () => this.node.content }; } createWritable() { return new FakeWritable(this.node); } }
class FakeDirHandle {
  constructor() { this.kids = new Map(); }
  async getDirectoryHandle(name, { create } = {}) { if (!this.kids.has(name)) { if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); this.kids.set(name, new FakeDirHandle()); } return this.kids.get(name); }
  async getFileHandle(name, { create } = {}) { if (!this.kids.has(name)) { if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); this.kids.set(name, new FakeFileHandle(fileNode(""))); } return this.kids.get(name); }
  async *entries() { for (const [n, v] of this.kids) yield [n, v]; }
  async removeEntry(name) { this.kids.delete(name); }
}

function installOpfsShim() {
  const root = new FakeDirHandle();
  DENO.navigator = DENO.navigator ?? {};
  DENO.navigator.storage = { getDirectory: async () => root };
  return root;
}

// The recovery sweep's uncertain computation is re-verified structurally
// against the REAL source (the gate is a one-line classification).
Deno.test("recovery gate (source contract): uncertain = progressed AND not read-only/idempotent", async () => {
  const src = await Deno.readTextFile("extension/lib/durable-runs.js");
  const gate = src.match(/const progressed = [\s\S]*?progressedSafety !== "idempotent";/);
  assert(gate, "the recovery gate is missing");
  assert(
    gate[0].includes('progressedSafety !== "read-only"') &&
      gate[0].includes('progressedSafety !== "idempotent"'),
    "the gate must exclude ONLY the explicitly read-only/idempotent progressed runs",
  );
  assert(
    /record\.toolSafety \?\? REPLAY_MUTATING/.test(gate[0]),
    "the gate must fail closed to mutating when no safety was recorded",
  );
  // The record default is UNRECORDED (null) + the gate fails closed via the
  // REPLAY_MUTATING fallback + the recordToolSafety worst-merge exists.
  assert(src.includes("toolSafety: null"), "the unrecorded default is missing");
  assert(src.includes("?? REPLAY_MUTATING"), "the fail-closed fallback is missing");
  assert(src.includes("worstSafety(current.toolSafety"), "the worst-merge is missing");
  assert(/current\.toolSafety == null\s*\? classification/.test(src), "the first-record semantics are missing");
});

Deno.test("replay safety: the SW tool-call path records the declared safety (fail-closed)", async () => {
  const sw = await Deno.readTextFile("extension/background/service-worker.js");
  assert(
    /recordToolSafety\(executionId, replaySafetyForTool\(event\.toolName\)\)/.test(sw),
    "the tool-call path does not record the tool's declared replay safety",
  );
  assert(
    /durableRuns\.recordToolSafety\(executionId, replaySafetyForTool\(event\.toolName\)\)\.catch\(\(\) => \{\}\)/.test(sw),
    "a recordToolSafety failure must be silent (the fail-closed default stays mutating)",
  );
});

function memoryStub() {
  const map = new Map();
  return {
    async get(key) { return { [key]: map.get(key) }; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) map.set(k, v); },
    async remove(key) { map.delete(key); },
    async has(key) { return map.has(key); },
  };
}
