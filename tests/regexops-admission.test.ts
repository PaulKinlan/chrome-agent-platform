// @ts-nocheck
// regexops admission KAT (chrome-agent-platform-nmc2):
// the CAP-authored WASI regex tool — pure-WASI, single-threaded, default-tier
// memory-bounded, reproducible, LINEAR-TIME (regex crate — no backtracking to
// blow up), and runnable through the REAL stream worker. The ReDoS-safety
// claims are behaviourally falsified here: a pathological nested-quantifier
// pattern compiles (the crate accepts the SYNTAX) and matching completes in
// bounded time with correct results, where a backtracking engine would hang.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crypto } from "jsr:@std/crypto";
import { auditWasmBinary } from "../extension/lib/wasm-package-authority.js";
import {
  appendWasmStreamInput,
  createWasmStreamInput,
  createWasmStreamOutput,
  readWasmStreamWindow,
  sealWasmStreamInput,
  sealWasmStreamOutput,
} from "../extension/lib/wasm-stream-files.js";
import { buildPreviewAuthority, buildPreviewJob, validatePreviewInput } from "../extension/lib/tool-exec-preview.js";
import { executeWasmStreamJob } from "../extension/lib/wasm-stream-worker.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";

// In-memory OPFS stand-in
const fileNode = () => ({ kind: "file", bytes: new Uint8Array(), syncOpen: false });
const directoryNode = () => ({ kind: "directory", children: new Map() });
class MemorySyncAccess {
  constructor(node) { this.node = node; }
  read(target, { at = 0 } = 0) {
    const count = Math.max(0, Math.min(target.byteLength, this.node.bytes.byteLength - at));
    target.set(this.node.bytes.subarray(at, at + count));
    return count;
  }
  write(bytes, { at = 0 } = 0) {
    const end = at + bytes.byteLength;
    if (end > this.node.bytes.byteLength) {
      const next = new Uint8Array(end); next.set(this.node.bytes); this.node.bytes = next;
    }
    this.node.bytes.set(bytes, at);
    return bytes.byteLength;
  }
  truncate(size) { const next = new Uint8Array(size); next.set(this.node.bytes.subarray(0, size)); this.node.bytes = next; }
  getSize() { return this.node.bytes.byteLength; }
  flush() {}
  close() {}
}
class MemoryFile {
  constructor(node) { this.node = node; this.kind = "file"; }
  async getFile() { return new Blob([this.node.bytes]); }
  async createWritable() {
    const node = this.node;
    return {
      bytes: new Uint8Array(), position: 0,
      async seek(p) { this.position = p; },
      async write(value) {
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
        const length = Math.max(this.bytes.byteLength, this.position + bytes.byteLength);
        const next = new Uint8Array(length);
        next.set(this.bytes); next.set(bytes, this.position); this.bytes = next; this.position += bytes.byteLength;
      },
      async close() { node.bytes = this.bytes; },
    };
  }
  async createSyncAccessHandle() { return new MemorySyncAccess(this.node); }
}
class MemoryDirectory {
  constructor(node) { this.node = node; this.kind = "directory"; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, directoryNode());
    }
    return new MemoryDirectory(this.node.children.get(name));
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, fileNode());
    }
    return new MemoryFile(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new MemoryFile(node) : new MemoryDirectory(node)];
    }
  }
}
function memoryStorage() {
  const root = directoryNode();
  return { storage: { async getDirectory() { return new MemoryDirectory(root); } } };
}

const REGEXOPS_SHA256 = "307b5b5bf05c3d83108e3551f05e89f2b9bfc480ee789650dae28e15eb503d9a";
const REGEXOPS_BYTES = 893555;

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("regexops: the shipped wasm is pure-WASI preview-1, single-threaded, default-tier bounded", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${REGEXOPS_SHA256}.wasm`);
  assertEquals(bytes.length, REGEXOPS_BYTES, "pinned size");
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  const fns = imports.filter((i) => i.kind === "function");
  assertEquals([...new Set(fns.map((f) => f.module))], ["wasi_snapshot_preview1"], "only WASI preview-1");
  assert(!fns.some((f) => /atomic|memory\.atomic/.test(f.name)), "no atomics/threads");
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "default", maxPages: 2048 },
  });
  assertEquals(audit.measured.memoryMax, 2048, "declared max memory is the default tier ceiling");
});

Deno.test("regexops: the pinned sha256 is the real committed CAS artifact", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${REGEXOPS_SHA256}.wasm`);
  assertEquals(await sha256Hex(bytes), REGEXOPS_SHA256, "CAS address IS the content hash");
});

Deno.test("regexops: the evidence tree proves byte-for-byte reproducibility (build-a == build-b)", async () => {
  const a = await Deno.readFile("packages/bundled/evidence/regexops/build-a/regexops.wasm");
  const b = await Deno.readFile("packages/bundled/evidence/regexops/build-b/regexops.wasm");
  assertEquals(await sha256Hex(a), REGEXOPS_SHA256, "build-a is the shipped artifact");
  assertEquals(await sha256Hex(b), REGEXOPS_SHA256, "build-b reproduces it exactly");
});

Deno.test("regexops: manifest declares the default tier + read-only replay + text-transform capability", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.regexops-1.0.0.manifest.json"));
  assertEquals(manifest.package.id, "cap.bundled.regexops");
  assertEquals(manifest.license.spdx, "MIT AND Apache-2.0");
  const exec = manifest.executables[0];
  assertEquals(exec.memory.tier, "default");
  assertEquals(exec.memory.maxPages, 2048);
  assertEquals(exec.imports.allowed, ["wasi_snapshot_preview1"]);
  assertEquals(exec.replayClass, "read-only");
  assertEquals(exec.capabilities, ["compute", "text.transform"]);
  assertEquals(exec.sha256, REGEXOPS_SHA256);
});

Deno.test("regexops: runs through the REAL stream worker — match, captures, cap, replace, failures", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "regexops");
  assert(row, "regexops is in the bundled inventory");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);

  const { storage } = memoryStorage();
  const owner = "agent:run-regexops:hub";
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-regexops", now: () => 1 });

  async function run(args, inputText, { expectExit = 0 } = {}) {
    const inputBytes = typeof inputText === "string" ? new TextEncoder().encode(inputText) : inputText;
    const inputRef = await createWasmStreamInput({ owner, storage });
    await appendWasmStreamInput({ ref: inputRef, owner, bytes: inputBytes, storage });
    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    const outputRef = await createWasmStreamOutput({ owner, storage });
    const job = buildPreviewJob({
      input: validatePreviewInput({ toolId: "regexops", args, stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    });
    const result = await executeWasmStreamJob({
      wasmBytes, job, owner, inputRef, outputRef, toolId: "regexops",
    }, { storage, authority });
    if (expectExit === 0) {
      assert(result.ok, `run ${args.join(" ")} failed: ${result.error ?? ""}`);
      assertEquals(result.exitCode, 0);
      await sealWasmStreamOutput({ ref: outputRef, owner, bytes: result.receipt.stdoutBytes, receipt: result.receipt, storage });
      const window = await readWasmStreamWindow({ ref: outputRef, owner, offset: 0, length: result.receipt.stdoutBytes, storage });
      return new TextDecoder().decode(Uint8Array.from(atob(window.base64), (c) => c.charCodeAt(0)));
    }
    assert(result.ok === false || result.exitCode !== 0, `run ${args.join(" ")} should have failed`);
    return null;
  }

  const subject = "cap-2026 cap-2027 missing";

  // 1. match with byte spans + capture groups
  const matches = JSON.parse(await run(["match", "-p", "cap-(\\d{4})"], subject));
  assertEquals(matches.truncated, false);
  assertEquals(matches.matches.length, 2);
  const [m0] = matches.matches;
  assertEquals(subject.slice(m0.start, m0.end), "cap-2026");
  assertEquals(subject.slice(m0.groups[1].start, m0.groups[1].end), "2026");

  // 2. --max caps output with the truncated flag (default 32 not hit here; force it)
  const capped = JSON.parse(await run(["match", "-p", "\\d", "--max", "2"], "a1b2c3d4"));
  assertEquals(capped.matches.length, 2);
  assertEquals(capped.truncated, true);

  // 3. replacement expands
  const replaced = await run(["replace", "-p", "cap-(\\d{4})", "-r", "yr-$1"], subject);
  assertEquals(replaced, "yr-2026 yr-2027 missing");

  // 4. invalid pattern fails closed (exit 2), invalid UTF-8 subject too.
  //    (TextEncoder cannot emit invalid UTF-8, so the byte case feeds raw
  //    bytes with a stray 0xFF directly.)
  await run(["match", "-p", "(unclosed"], subject, { expectExit: 2 });
  await run(["match", "-p", "ok"], new Uint8Array([0x61, 0xff, 0x62]), { expectExit: 2 });

  // 5. ReDoS falsification: a classic catastrophic-backtracking pattern
  //    (nested quantifiers over overlapping classes) must COMPLETE — the
  //    linear engine cannot hang on it. A backtracking engine given this
  //    subject would effectively never return. Leftmost semantics match the
  //    TRAILING a-run exactly (60 a's, ending at the subject's end).
  const bombSubject = "a".repeat(60) + "!" + "a".repeat(60);
  const bomb = JSON.parse(await run(
    ["match", "-p", "(a+)+$", "--max", "1"],
    bombSubject,
  ));
  assertEquals(bomb.matches.length, 1);
  const [bm] = bomb.matches;
  assertEquals(bombSubject.slice(bm.start, bm.end), "a".repeat(60));
  assertEquals(bm.end, bombSubject.length);
});

Deno.test("regexops: the binary self-bounds its inputs (pattern > 256 chars exits 2)", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "regexops");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  const { storage } = memoryStorage();
  const owner = "agent:run-regexops-bounds:hub";
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-regexops-bounds", now: () => 1 });
  const inputRef = await createWasmStreamInput({ owner, storage });
  await appendWasmStreamInput({ ref: inputRef, owner, bytes: new TextEncoder().encode("subject"), storage });
  await sealWasmStreamInput({ ref: inputRef, owner, storage });
  const outputRef = await createWasmStreamOutput({ owner, storage });
  const longPattern = "a".repeat(257);
  const result = await executeWasmStreamJob({
    wasmBytes, job: buildPreviewJob({
      input: validatePreviewInput({ toolId: "regexops", args: ["match", "-p", longPattern], stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    }), owner, inputRef, outputRef, toolId: "regexops",
  }, { storage, authority });
  assert(result.ok === false || result.exitCode === 2, "pattern_too_long exits nonzero");
});

Deno.test("regexops: toolPurposeGroup resolves to text-documents", () => {
  assertEquals(toolPurposeGroup("regexops"), "text-documents");
});
