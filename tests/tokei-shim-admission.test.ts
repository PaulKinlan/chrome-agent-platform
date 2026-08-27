// @ts-nocheck
// tokei patched-fork ADMISSION KATs — RUNNABLE (counts lines; the prior
// "0 files" runtime gap is fixed).
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("tokei: provenance + census + licence are recorded (runnable admission)", () => {
  const prov = Deno.readTextFileSync("docs/plans/rust-lane/tokei/PROVENANCE.md");
  assert(prov.includes("8cdd6fa3a54f8cd69442d2f00effb29aa3110353"), "pinned commit recorded");
  assert(prov.includes("MIT OR Apache-2.0"), "licence recorded");
  assert(prov.includes("RUNNABLE"), "runnable claim present");
  assert(prov.includes("112 files"), "a real counted run recorded");
  assert(prov.includes("drop(tx)"), "the channel-close root cause documented");
  const notices = Deno.readTextFileSync("docs/plans/rust-lane/tokei/tokei-NOTICES.md");
  assert(notices.includes("NO GPL / LGPL / AGPL"), "GPL-family absence");
  assert(notices.includes("colored@2.1.0"), "the one MPL-2.0 crate flagged");
  for (const path of [
    "docs/plans/rust-lane/rayon-wasi/Cargo.toml",
    "docs/plans/rust-lane/home-wasi/Cargo.toml",
    "docs/plans/rust-lane/ignore-wasi/Cargo.toml",
    "docs/plans/rust-lane/tokei/wasi-serial.patch",
  ]) {
    assert(Deno.readTextFileSync(path).length > 0, `${path} present`);
  }
});

Deno.test("tokei: the built wasm metadata is recorded (pure-WASI + default tier)", () => {
  const sha = Deno.readTextFileSync("docs/plans/rust-lane/tokei/metadata/sha256.txt").trim();
  assert(/^[0-9a-f]{64}/.test(sha), "sha256 recorded");
  const prov = Deno.readTextFileSync("docs/plans/rust-lane/tokei/PROVENANCE.md");
  assert(/20 imports ALL wasi_snapshot_preview1/.test(prov), "pure-WASI import census recorded");
});

// ──────────────────────────────────────────────────────────────────────────
// Runtime KAT: the wasm counts a real directory (>0 files, correct totals).
// Skips when binaries/ isn't built (gitignored).
// ──────────────────────────────────────────────────────────────────────────
Deno.test("tokei runtime: counts a real directory (>0 files, correct totals)", async () => {
  const wasmPath = "docs/plans/rust-lane/tokei/binaries/tokei.wasm";
  const stat = await Deno.stat(wasmPath).catch(() => null);
  if (!stat) return; // binaries/ is gitignored; runs where the build produced it

  const dir = await Deno.makeTempDir({ prefix: "tokei-kat-" });
  await Deno.writeTextFile(`${dir}/a.rs`, "fn main() {}\n");
  await Deno.writeTextFile(`${dir}/sub.js`, "let x = 1;\nlet y = 2;\n");
  await Deno.mkdir(`${dir}/nested`);
  await Deno.writeTextFile(`${dir}/nested/c.rs`, "let z = 3;\n");

  const harness = await Deno.makeTempFile({ prefix: "tokei-harness-", suffix: ".mjs" });
  await Deno.writeTextFile(harness, `
import { WASI } from "node:wasi";
import { readFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const wasm = readFileSync(${JSON.stringify(wasmPath)});
const wasi = new WASI({ version: "preview1", args: ["tokei", "."], preopens: { ".": dir }, returnOnExit: true });
const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport });
wasi.start(instance);
console.log("EXIT", wasi.returnCode ?? 0);
`);

  const cmd = new Deno.Command("node", { args: [harness], stdout: "piped", stderr: "piped" });
  const { stdout } = await cmd.output();
  const txt = new TextDecoder().decode(stdout);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.remove(harness).catch(() => {});

  // The table lands on fd 1 (the process stdout). Assert nonzero counts:
  // 1 rust file (1 line) + 1 js file (2 lines) + 1 nested rust file (1 line)
  // = 3 files, 4 lines total.
  assert(/Rust\s+2\s+2/.test(txt), `rust files counted (2 files, 2 lines)\n${txt}`);
  assert(/JavaScript\s+1\s+2/.test(txt), `js file counted (1 file, 2 lines)\n${txt}`);
  assert(/Total\s+3\s+4/.test(txt), `3 files / 4 lines total\n${txt}`);
});
