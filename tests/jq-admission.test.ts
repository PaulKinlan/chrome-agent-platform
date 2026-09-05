// @ts-nocheck
// jq_filter_bounded admission KAT — the PATCHED single-threaded WASI binary.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crypto } from "jsr:@std/crypto";
import { auditWasmBinary } from "../extension/lib/wasm-package-authority.js";

Deno.test("jq: the patched wasm is pure-WASI preview-1, single-threaded, and memory-bounded", async () => {
  const bytes = await Deno.readFile("docs/admissions/jq-filter-bounded/binaries/jq.wasm");
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  const fns = imports.filter((i) => i.kind === "function");
  const mems = imports.filter((i) => i.kind === "memory");
  assertEquals([...new Set(fns.map((f) => f.module))], ["wasi_snapshot_preview1"], "only WASI preview-1");
  assertEquals(fns.length, 19, "19 imports");
  assertEquals(mems.length, 0, "memory is internal, not imported");
  // no threads/atomics: the thread-proposal imports are absent
  assert(!fns.some((f) => /atomic|memory\.atomic/.test(f.name)), "no atomics");
  assert(bytes.length <= 16 * 1024 * 1024, "tiny/default tier bound");
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "tiny", maxPages: 512 },
  });
  assertEquals(audit.measured.memoryInitial, 64);
  assertEquals(audit.measured.memoryMax, 512);
});

Deno.test("jq: the pinned sha256 is the real committed artifact", async () => {
  const bytes = await Deno.readFile("docs/admissions/jq-filter-bounded/binaries/jq.wasm");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(digest, "e884973be3742724a5bdf4637644dfd7f9630d54132835d3849b44da9e4e4234", "pinned sha256 matches");
});

Deno.test("jq: the spec contract separates stream size from finite execution resources", async () => {
  const spec = await Deno.readTextFile("docs/admissions/jq-filter-bounded/spec-contract.md");
  assert(/no input, output, line, or document byte ceiling/i.test(spec));
  assert(/64 initial and 512 maximum/i.test(spec), "memory pages documented");
  assert(/180-second wall cancellation/i.test(spec), "finite cancellation documented");
  assert(!/input.*(?:2|64)\s*KiB/i.test(spec), "no legacy input cap");
});
