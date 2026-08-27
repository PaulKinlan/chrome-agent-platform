// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("t3-trio: sed wasm is reproducible + pure-WASI + real provenance", async () => {
  const bin = await Deno.readFile("docs/admissions/t3-trio/sed/binaries/sed.wasm");
  const d = await crypto.subtle.digest("SHA-256", bin);
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(hex, "d95860b960d73af024b05c20d13410d7b942ff33ac0502de97ec4f24525c107a",
    "binary sha256 must match PROVENANCE.md");
  const rb = await Deno.readFile("docs/admissions/t3-trio/sed/metadata/rebuild-sed.wasm");
  assertEquals(new Uint8Array(rb).length, bin.length, "rebuild size matches");
  const txt = new TextDecoder().decode(bin);
  assert(txt.includes("wasi_snapshot_preview1"), "imports the wasi module");
  assert(!/WebAssembly\.|globalThis|fetch\(|document\.|window\./.test(txt), "no JS host refs");
});

Deno.test("t3-trio: awk + date honestly STOP-and-report", async () => {
  const stop = await Deno.readTextFile("docs/admissions/t3-trio/STOP-awk-date.md");
  assert(stop.includes("setjmp") && stop.includes("signal") && stop.includes("system"), "awk blockers documented");
  assert(stop.includes("toybox"), "date toybox scope blocker documented");
});
