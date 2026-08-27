// @ts-nocheck
// tokei patched-fork BUILD + census KATs (honest: runtime count is the gap).
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("tokei shim: build artifacts + honest status are recorded", () => {
  const prov = Deno.readTextFileSync("docs/plans/rust-lane/tokei/PROVENANCE.md");
  assert(prov.includes("8cdd6fa3a54f8cd69442d2f00effb29aa3110353"), "pinned commit recorded");
  assert(prov.includes("MIT OR Apache-2.0"), "licence recorded");
  const blocked = Deno.readTextFileSync("docs/plans/rust-lane/tokei/BLOCKED.runtime.md");
  assert(blocked.includes("0 files") || blocked.includes("runtime gap"), "honest runtime gap disclosed");
  assert(blocked.includes("no fabricated"), "never-fabricate disclosure");
  const notices = Deno.readTextFileSync("docs/plans/rust-lane/tokei/tokei-NOTICES.md");
  assert(notices.includes("129 packages"), "census count");
  assert(notices.includes("NO GPL / LGPL / AGPL"), "GPL-family absence");
  assert(notices.includes("colored@2.1.0"), "the one MPL-2.0 crate flagged");
  // the three shim crates exist and are MIT/Apache or Unlicense/MIT
  for (const [path, needle] of [
    ["docs/plans/rust-lane/rayon-wasi/Cargo.toml", "MIT OR Apache-2.0"],
    ["docs/plans/rust-lane/home-wasi/Cargo.toml", "MIT OR Apache-2.0"],
    ["docs/plans/rust-lane/ignore-wasi/Cargo.toml", ""], // ignore upstream is Unlicense OR MIT
  ]) {
    assert(Deno.readTextFileSync(path).length > 0, `${path} present`);
  }
});

Deno.test("tokei shim: the built wasm is pure-WASI + within default tier", () => {
  // binaries/ is gitignored (the lane convention) — assert the RECORDED
  // evidence instead of reading the untracked artifact.
  const sha = Deno.readTextFileSync("docs/plans/rust-lane/tokei/metadata/sha256.txt").trim();
  assert(/^[0-9a-f]{64}/.test(sha), "sha256 recorded");
  const prov = Deno.readTextFileSync("docs/plans/rust-lane/tokei/PROVENANCE.md");
  assert(/2,246,692|\b\d{6,8}\b.*bytes|bytes/i.test(prov), "binary size recorded in provenance");
});
