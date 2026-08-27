#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Rust → wasm32-wasip1 lane. Admitted tool #1: htmlq (MIT).
# The lane will carry numbat, bttf, tokei, xan, qsv serially (drop-in: add a
# pinned crate + licence NOTICE + spec contract, re-run this recipe).
set -euo pipefail

# CRITICAL (env block on this host): /usr/bin/cargo + /usr/bin/rustc are the Arch
# system Rust, whose wasm32-wasip1 std is EMPTY (0 rlibs) and shadow the rustup
# toolchain in PATH. cargo spawns `rustc` from PATH unless RUSTC is set, so we pin
# BOTH to the EXPLICIT rustup toolchain. The `export RUSTC=` line is load-bearing
# (it overrides cargo's child-rustc resolution). CARGO is the rustup SHIM
# (~/.cargo/bin/cargo), NOT the toolchain's direct cargo binary (the direct
# binary drops the rustup env context and re-resolves the system rustc).
TOOLCHAIN="stable-x86_64-unknown-linux-gnu"   # explicit, never "default"
export RUSTC="$(rustup which --toolchain "$TOOLCHAIN" rustc)"
export CARGO="$HOME/.cargo/bin/cargo"

# htmlq: v0.4.0 (MIT) — https://github.com/mgdm/htmlq
HTMLQ_VERSION="v0.4.0"
HTMLQ_SHA="1361c8c46811dd7b961c3fe9c6b04f9318a345e8"  # git commit of v0.4.0

ROOT=$(cd "$(dirname "$0")" && pwd)
# Build artifacts live OUTSIDE the bundled tree (the bundled tree is a
# drift-verified generated output; stray cargo artifacts there fail verify).
WORK="${CARGO_BUILD_DIR:-$ROOT/../../../.build/rust-lane}"  # repo-root/.build/rust-lane (gitignored)
SRC="$WORK/source/htmlq"
OUT="$ROOT/binaries/${1:?usage: build.sh PASS_NAME}"
mkdir -p "$WORK" "$OUT"

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$HTMLQ_VERSION" https://github.com/mgdm/htmlq.git "$SRC"
fi
test "$(git -C "$SRC" rev-parse HEAD)" = "$HTMLQ_SHA" || {
  echo "pinned commit mismatch: got $(git -C "$SRC" rev-parse HEAD) want $HTMLQ_SHA" >&2; exit 1; }

"$CARGO" build --release --target wasm32-wasip1 --manifest-path "$SRC/Cargo.toml" \
  --target-dir "$WORK/target"

cp "$WORK/target/wasm32-wasip1/release/htmlq.wasm" "$OUT/htmlq.wasm"
echo "built: $OUT/htmlq.wasm"
sha256sum "$OUT/htmlq.wasm"
