# bttf — build/census proof (Rust lane, tool #3)

bttf (MIT OR Apache-2.0) is a command-line utility for datetime arithmetic,
parsing and formatting — pure datetime math, no network. Upstream
https://github.com/BurntSushi/bttf, pinned tag 0.1.4 (commit
b839c69d12a93cff278cc38e47838ac9246d6105).

bttf ships a [[bin]] target, so it builds DIRECTLY to a runnable .wasm (no
wrapper crate, unlike numbat whose core was a library).

## Build proof (REAL)
`cargo build --release --target wasm32-wasip1` with the house release profile
(strip + LTO + opt-level=s — the DEFAULT build is ~31MB of DWARF debug info;
the house profile yields the shipped size). Pins via the lane env (`rustup which
--toolchain stable-x86_64-unknown-linux-gnu`), PATH-independent.

- bttf.wasm: 2,447,964 bytes (~2.33 MiB) → default tier (≤16 MiB)
- sha256: 928dee85962393546f2e3a361585289300d65e5bfafbc615b4b05f414b53e7a9
- imports: 19, ALL wasi_snapshot_preview1 (no JS/bindgen); 1 linear memory
- licence: MIT OR Apache-2.0; built tree census = 24 permissive crates
  (14 MIT-OR-Apache-2.0, 5 Unlicense-OR-MIT, 4 MIT, 1 Apache-2.0/MIT), no GPL/MPL.
  Aggregate: MIT AND Apache-2.0 AND Unlicense. See bttf-NOTICES.txt.

## Note on the binary CLI contract
bttf reads CLI args (not stdin) — `bttf 1d + 2d`, `bttf now`, timezone math.
The WASI host supplies argv via args_get/args_sizes_get (present in the import
census). A bounded spec contract (argv size / output cap / timeout) is authored
at the admission step, same as htmlq/numbat.

## Reproducibility (honest caveat)
Config-level, not byte-level: rustc embeds build paths, so the sha differs
across build dirs. Byte-identical retained build is the admission step.

## Remaining (the separate reviewed admission — NOT done this pass)
1. Register the lane in build-bundled-tool-packages.mjs + frozen evidence tree.
2. Bounded spec contract + the five never-fabricate inputs.
3. Manifest + SBOM + vendored Unlicense texts from pinned upstreams.
4. Inventory metadata + admission KATs.
5. Byte-level reproducibility (path-remap) before the retained build.
