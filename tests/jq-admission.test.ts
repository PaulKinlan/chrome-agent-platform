// @ts-nocheck
// jq_filter_bounded admission KAT — the PATCHED single-threaded WASI binary.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crypto } from "jsr:@std/crypto";

Deno.test("jq: the patched wasm is pure-WASI preview-1, single-threaded, bounded", async () => {
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
});

Deno.test("jq: the pinned sha256 is the real committed artifact", async () => {
  const bytes = await Deno.readFile("docs/admissions/jq-filter-bounded/binaries/jq.wasm");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(digest, "b428286b49c45ea6d494defd16e46083cd04fc7a5541a3a35d756853ee7e613d", "pinned sha256 matches");
});

Deno.test("jq: the spec contract file is present + bounded", async () => {
  const spec = await Deno.readTextFile("docs/admissions/jq-filter-bounded/spec-contract.md");
  assert(/2 *KiB/i.test(spec), "input bound documented");
  assert(/64 *KiB/i.test(spec), "output bound documented");
  assert(/33554432/i.test(spec), "memory bound documented (32 MiB)");
});
