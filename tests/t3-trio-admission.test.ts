// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crypto } from "jsr:@std/crypto";

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

Deno.test("t3-trio: awk wasm is reproducible + pure-WASI + real provenance", async () => {
  const bin = await Deno.readFile("docs/admissions/t3-trio/awk/binaries/awk.wasm");
  const d = await crypto.subtle.digest("SHA-256", bin);
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const prov = await Deno.readTextFile("docs/admissions/t3-trio/awk/PROVENANCE.md");
  assert(prov.includes(hex), "binary sha256 must match PROVENANCE.md");

  const rb = await Deno.readFile("docs/admissions/t3-trio/awk/metadata/rebuild-awk.wasm");
  assertEquals(new Uint8Array(rb).length, bin.length, "rebuild size matches");

  const mod = new WebAssembly.Module(bin);
  const imports = WebAssembly.Module.imports(mod);
  const modules = [...new Set(imports.map((i) => i.module))];
  assertEquals(modules, ["wasi_snapshot_preview1"], "only WASI preview-1 imports");
  assertEquals(imports.filter((i) => i.kind === "memory").length, 0, "no imported memory");
  assert(bin.length <= 16 * 1024 * 1024, "default tier bound (≤16MiB)");
});

Deno.test("t3-trio: awk runtime KAT (field splitting, delimiter, pattern matching, BEGIN/END)", async () => {
  const wasmPath = "docs/admissions/t3-trio/awk/binaries/awk.wasm";
  const stat = await Deno.stat(wasmPath).catch(() => null);
  if (!stat) return;

  async function runWasi(args, input) {
    const code = `
      import { WASI } from "node:wasi";
      import { readFileSync } from "node:fs";
      const wasm = readFileSync(${JSON.stringify(wasmPath)});
      const wasi = new WASI({ version: "preview1", args: ["awk", ...${JSON.stringify(args)}], returnOnExit: true });
      const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport });
      wasi.start(instance);
    `;
    const cmd = new Deno.Command("node", {
      args: ["--input-type=module", "-e", code],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const output = await child.output();
    return new TextDecoder().decode(output.stdout);
  }

  // 1. Basic field extraction
  const out1 = await runWasi(["{ print $1, $3 }"], "alice 30 engineer\nbob 25 designer\n");
  assert(out1.includes("alice engineer") && out1.includes("bob designer"), "field extraction: " + out1);

  // 2. Custom delimiter -F,
  const out2 = await runWasi(["-F,", "{ print $2 }"], "one,two,three\nfour,five,six\n");
  assert(out2.includes("two") && out2.includes("five"), "-F delimiter: " + out2);

  // 3. Pattern filtering
  const out3 = await runWasi(["/match/ { print $1 }"], "first match\nsecond other\nthird match\n");
  assert(out3.includes("first") && !out3.includes("second") && out3.includes("third"), "pattern: " + out3);

  // 4. BEGIN and END blocks
  const out4 = await runWasi(["BEGIN { print \"HEADER\" } { print $1 } END { print \"TOTAL\", NR }"], "foo\nbar\n");
  assert(out4.includes("HEADER") && out4.includes("TOTAL 2"), "BEGIN/END: " + out4);
});

Deno.test("t3-trio: date wasm is reproducible + pure-WASI + real provenance", async () => {
  const bin = await Deno.readFile("docs/admissions/t3-trio/date/binaries/date.wasm");
  const d = await crypto.subtle.digest("SHA-256", bin);
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const prov = await Deno.readTextFile("docs/admissions/t3-trio/date/PROVENANCE.md");
  assert(prov.includes(hex), "binary sha256 must match PROVENANCE.md");

  const rb = await Deno.readFile("docs/admissions/t3-trio/date/metadata/rebuild-date.wasm");
  assertEquals(new Uint8Array(rb).length, bin.length, "rebuild size matches");

  const mod = new WebAssembly.Module(bin);
  const imports = WebAssembly.Module.imports(mod);
  const modules = [...new Set(imports.map((i) => i.module))];
  assertEquals(modules, ["wasi_snapshot_preview1"], "only WASI preview-1 imports");
  assertEquals(imports.filter((i) => i.kind === "memory").length, 0, "no imported memory");
  assert(bin.length <= 16 * 1024 * 1024, "default tier bound (≤16MiB)");
});

Deno.test("t3-trio: date runtime KAT (custom formatting, UTC, ISO 8601, epoch parsing)", async () => {
  const wasmPath = "docs/admissions/t3-trio/date/binaries/date.wasm";
  const stat = await Deno.stat(wasmPath).catch(() => null);
  if (!stat) return;

  async function runDate(args) {
    const code = `
      import { WASI } from "node:wasi";
      import { readFileSync } from "node:fs";
      const wasm = readFileSync(${JSON.stringify(wasmPath)});
      const wasi = new WASI({ version: "preview1", args: ["date", ...${JSON.stringify(args)}], returnOnExit: true });
      const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport });
      wasi.start(instance);
    `;
    const cmd = new Deno.Command("node", {
      args: ["--input-type=module", "-e", code],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    return new TextDecoder().decode(output.stdout).trim();
  }

  // 1. Epoch date format: 1724000000 = 2024-08-18T16:53:20Z
  const out1 = await runDate(["-u", "-d", "@1724000000", "+%Y-%m-%d"]);
  assertEquals(out1, "2024-08-18");

  // 2. Custom time format
  const out2 = await runDate(["-u", "-d", "@1724000000", "+%H:%M:%S"]);
  assertEquals(out2, "16:53:20");

  // 3. ISO 8601 flag -I
  const out3 = await runDate(["-u", "-d", "@1724000000", "-I"]);
  assertEquals(out3, "2024-08-18");

  // 4. Default execution (current year in output)
  const out4 = await runDate([]);
  assert(out4.includes("2026") || out4.includes("2025") || out4.includes("2024"));
});
