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
  assertEquals(rb, bin, "rebuild bytes and digest match exactly");
  const hashRecord = await Deno.readTextFile("docs/admissions/t3-trio/awk/metadata/binary-sha256.txt");
  assertEquals(hashRecord, `${hex}  binaries/awk.wasm\n`, "hash record is relative and exact");
  assert(!(await Deno.readTextFile("docs/admissions/t3-trio/awk/metadata/build-receipt.txt")).includes("/home/"), "receipt has no private path");

  const mod = new WebAssembly.Module(bin);
  const imports = WebAssembly.Module.imports(mod);
  const modules = [...new Set(imports.map((i) => i.module))];
  assertEquals(modules, ["wasi_snapshot_preview1"], "only WASI preview-1 imports");
  assertEquals(imports.filter((i) => i.kind === "memory").length, 0, "no imported memory");
  assert(bin.length <= 16 * 1024 * 1024, "default tier bound (≤16MiB)");
});

Deno.test("t3-trio: awk runtime KAT (field splitting, delimiter, pattern matching, BEGIN/END)", async () => {
  const wasmPath = "docs/admissions/t3-trio/awk/binaries/awk.wasm";
  await Deno.stat(wasmPath); // absence is a hard failure, never a skip

  async function runWasi(args, input) {
    const code = `
      import { WASI } from "node:wasi";
      import { readFileSync } from "node:fs";
      const wasm = readFileSync(${JSON.stringify(wasmPath)});
      const wasi = new WASI({ version: "preview1", args: ["awk", ...${JSON.stringify(args)}], returnOnExit: true });
      const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport });
      process.exitCode = wasi.start(instance);
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
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  }

  // 1. Basic field extraction
  const out1 = await runWasi(["{ print $1, $3 }"], "alice 30 engineer\nbob 25 designer\n");
  assertEquals(out1.code, 0);
  assert(out1.stdout.includes("alice engineer") && out1.stdout.includes("bob designer"), "field extraction: " + out1.stdout);

  // 2. Custom delimiter -F,
  const out2 = await runWasi(["-F,", "{ print $2 }"], "one,two,three\nfour,five,six\n");
  assert(out2.stdout.includes("two") && out2.stdout.includes("five"), "-F delimiter: " + out2.stdout);

  // 3. Literal pattern subset, including start/end anchors.
  const out3 = await runWasi(["/^alice/ { print $1 }"], "alice 1\nbob 2\n");
  assertEquals(out3.stdout, "alice\n", "start anchor is implemented, not stripped into a literal caret");
  const out3b = await runWasi(["/done$/ { print $1 }"], "first done\nsecond other\n");
  assertEquals(out3b.stdout, "first\n", "end anchor matches only the line end");

  // 4. BEGIN and END blocks
  const out4 = await runWasi(["BEGIN { print \"HEADER\" } { print $1 } END { print \"TOTAL\", NR }"], "foo\nbar\n");
  assert(out4.stdout.includes("HEADER") && out4.stdout.includes("TOTAL 2"), "BEGIN/END: " + out4.stdout);
});

Deno.test("t3-trio: date wasm is reproducible + pure-WASI + real provenance", async () => {
  const bin = await Deno.readFile("docs/admissions/t3-trio/date/binaries/date.wasm");
  const d = await crypto.subtle.digest("SHA-256", bin);
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const prov = await Deno.readTextFile("docs/admissions/t3-trio/date/PROVENANCE.md");
  assert(prov.includes(hex), "binary sha256 must match PROVENANCE.md");

  const rb = await Deno.readFile("docs/admissions/t3-trio/date/metadata/rebuild-date.wasm");
  assertEquals(rb, bin, "rebuild bytes and digest match exactly");
  const hashRecord = await Deno.readTextFile("docs/admissions/t3-trio/date/metadata/binary-sha256.txt");
  assertEquals(hashRecord, `${hex}  binaries/date.wasm\n`, "hash record is relative and exact");
  assert(!(await Deno.readTextFile("docs/admissions/t3-trio/date/metadata/build-receipt.txt")).includes("/home/"), "receipt has no private path");

  const mod = new WebAssembly.Module(bin);
  const imports = WebAssembly.Module.imports(mod);
  const modules = [...new Set(imports.map((i) => i.module))];
  assertEquals(modules, ["wasi_snapshot_preview1"], "only WASI preview-1 imports");
  assertEquals(imports.filter((i) => i.kind === "memory").length, 0, "no imported memory");
  assert(bin.length <= 16 * 1024 * 1024, "default tier bound (≤16MiB)");
});

Deno.test("t3-trio: date runtime KAT (custom formatting, UTC, ISO 8601, epoch parsing)", async () => {
  const wasmPath = "docs/admissions/t3-trio/date/binaries/date.wasm";
  await Deno.stat(wasmPath); // absence is a hard failure, never a skip

  async function runDate(args) {
    const code = `
      import { WASI } from "node:wasi";
      import { readFileSync } from "node:fs";
      const wasm = readFileSync(${JSON.stringify(wasmPath)});
      const wasi = new WASI({ version: "preview1", args: ["date", ...${JSON.stringify(args)}], returnOnExit: true });
      const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport });
      process.exitCode = wasi.start(instance);
    `;
    const cmd = new Deno.Command("node", {
      args: ["--input-type=module", "-e", code],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout).trim(),
      stderr: new TextDecoder().decode(output.stderr).replace(/\(node:.*?\n|\(Use .*?\n/g, "").trim(),
    };
  }

  // 1. Epoch date format: 1724000000 = 2024-08-18T16:53:20Z
  const out1 = await runDate(["-u", "-d", "@1724000000", "+%Y-%m-%d"]);
  assertEquals(out1.code, 0);
  assertEquals(out1.stdout, "2024-08-18");

  // 2. Custom time format
  const out2 = await runDate(["-u", "-d", "@1724000000", "+%H:%M:%S"]);
  assertEquals(out2.stdout, "16:53:20");

  // 3. ISO 8601 flag -I
  const out3 = await runDate(["-u", "-d", "@1724000000", "-I"]);
  assertEquals(out3.stdout, "2024-08-18");

  // 4. Default execution (current year in output)
  const out4 = await runDate([]);
  assert(out4.stdout.includes("2026") || out4.stdout.includes("2025") || out4.stdout.includes("2024"));

  // Invalid or incomplete date requests fail loudly; they never become now.
  const invalid = await runDate(["-u", "-d", "not-a-date", "+%s"]);
  assertEquals(invalid.code, 1);
  assertEquals(invalid.stdout, "");
  assert(invalid.stderr.includes("invalid date 'not-a-date'"), invalid.stderr);
  const missing = await runDate(["-d"]);
  assertEquals(missing.code, 1);
  assertEquals(missing.stdout, "");
  assert(missing.stderr.includes("requires an argument"), missing.stderr);
});
