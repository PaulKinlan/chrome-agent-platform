#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Rust → wasm32-wasip1 lane. Tool #3: bttf (MIT OR Apache-2.0 — BurntSushi).
# bttf is a CLI (has its own [[bin]]), so this builds the UPSTREAM crate directly
# (no wrapper needed, unlike numbat whose core was a library).
set -euo pipefail

TOOLCHAIN="stable-x86_64-unknown-linux-gnu"   # explicit, never "default"
export RUSTC="$(rustup which --toolchain "$TOOLCHAIN" rustc)"
export CARGO="$HOME/.cargo/bin/cargo"

# The house release profile (strip + LTO + opt-level=s): the DEFAULT release build
# carries ~31MB of DWARF debug info; this profile produces the ~2.3MB shipped binary.
export CARGO_PROFILE_RELEASE_OPT_LEVEL=s
export CARGO_PROFILE_RELEASE_LTO=true
export CARGO_PROFILE_RELEASE_STRIP=true
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1

# bttf v0.1.4 — https://github.com/BurntSushi/bttf (MIT OR Apache-2.0)
BTTF_VERSION="0.1.4"
BTTF_SHA="b839c69d12a93cff278cc38e47838ac9246d6105"  # git commit of tag 0.1.4 (^{commit})

ROOT=$(cd "$(dirname "$0")" && pwd)
WORK="${CARGO_BUILD_DIR:-$ROOT/../../../.build/rust-lane}"
SRC="$WORK/source/bttf"
OUT="$ROOT/binaries"
mkdir -p "$WORK" "$OUT"

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$BTTF_VERSION" https://github.com/BurntSushi/bttf.git "$SRC"
fi
test "$(git -C "$SRC" rev-parse HEAD)" = "$BTTF_SHA" || {
  echo "pinned commit mismatch: got $(git -C "$SRC" rev-parse HEAD) want $BTTF_SHA" >&2; exit 1; }

"$CARGO" build --release --target wasm32-wasip1 --manifest-path "$SRC/Cargo.toml" \
  --target-dir "$WORK/target"

cp "$WORK/target/wasm32-wasip1/release/bttf.wasm" "$OUT/bttf.wasm"
echo "built: $OUT/bttf.wasm"
sha256sum "$OUT/bttf.wasm"
