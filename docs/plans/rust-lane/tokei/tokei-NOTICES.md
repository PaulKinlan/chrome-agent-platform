# tokei (patched fork) — licence census (lock-faithful)

Method: `cargo tree --locked -e normal,build --target wasm32-wasip1` against the
pinned commit + the [patch.crates-io] shims. 129 packages in the ACTUALLY-BUILT
tree.

Distribution (by SPDX expression):
- MIT OR Apache-2.0: 81
- MIT/Apache-2.0: 16
- MIT: 11
- Unlicense OR MIT: 7
- Apache-2.0 OR MIT: 4
- Unlicense/MIT: 2
- BSD-2-Clause OR Apache-2.0 OR MIT: 2
- Apache-2.0 OR BSL-1.0: 1 (ryu)
- ISC: 1
- BSD-3-Clause: 1
- (MIT OR Apache-2.0) AND Unicode-DFS-2016: 1 (unicode-ident)
- (Apache-2.0 OR MIT) AND BSD-3-Clause: 1 (zerocopy)
- MPL-2.0: 1 — **FLAGGED** `colored@2.1.0` (file-level weak copyleft; terminal
  colouring, no GPL-family)

NO GPL / LGPL / AGPL anywhere in the built tree (verified via cargo tree AND
rlib absence in target/wasm32-wasip1/release/deps/). The three patched local
crates are all MIT OR Apache-2.0 (rayon-wasi, home-wasi) / Unlicense OR MIT
(ignore-wasi fork of ignore).

Upstream licence texts: tokei MIT OR Apache-2.0; the NOTICES source text is
vendored from the pinned upstream at the retained-admission build step.
