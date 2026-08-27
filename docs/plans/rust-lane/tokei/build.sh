#!/usr/bin/env bash
# tokei patched-fork BUILD + census proof — serial WASI (rayon shim) + home stub
# + ignore fork (wasi from_path/from_entry_os + serial walk). RUNNABLE: the
# wasm counts lines of code (verified via node:wasi). Reproducible (byte-identical
# rebuild); the rayon shim must be resolved via `cargo update -p rayon` (a stale
# Cargo.lock otherwise pins the REAL rayon, whose thread spawn hangs on wasi).
set -euo pipefail
TOOLCHAIN="stable-x86_64-unknown-linux-gnu"
export RUSTC="$(rustup which --toolchain "$TOOLCHAIN" rustc)"
export CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
export CARGO_PROFILE_RELEASE_STRIP=true
export CARGO_PROFILE_RELEASE_LTO=true
export CARGO_PROFILE_RELEASE_OPT_LEVEL=s
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
TOKEI_VERSION="v14.0.0"
TOKEI_SHA="8cdd6fa3a54f8cd69442d2f00effb29aa3110353"
ROOT=$(cd "$(dirname "$0")" && pwd)
RAYON="$ROOT/../rayon-wasi"
HOME_STUB="$ROOT/../home-wasi"
IGNORE="$ROOT/../ignore-wasi"
PATCH="$ROOT/wasi-serial.patch"
WORK="${CARGO_BUILD_DIR:-$ROOT/../../../.build/tokei}"
SRC="$WORK/src"
mkdir -p "$WORK"
[ -d "$SRC/.git" ] || git clone --depth 1 --branch "$TOKEI_VERSION" https://github.com/XAMPPRocky/tokei.git "$SRC"
test "$(git -C "$SRC" rev-parse HEAD)" = "$TOKEI_SHA" || { echo "pin mismatch" >&2; exit 1; }

# 1. [patch.crates-io] → the three WASI shims (rayon serial, home stub, ignore fork).
python3 - <<PYEOF
s = open("$SRC/Cargo.toml").read()
if "[patch.crates-io]" not in s:
    s += '\n[patch.crates-io]\nrayon = { path = "' + "$RAYON" + '" }\nhome = { path = "' + "$HOME_STUB" + '" }\nignore = { path = "' + "$IGNORE" + '" }\n'
    open("$SRC/Cargo.toml","w").write(s)
PYEOF

# 2. Apply the committed serial-walk + reduce→fold source patch (git apply,
#    idempotent: skip if already applied).
if ! git -C "$SRC" apply --check "$PATCH" 2>/dev/null; then
  echo "wasi-serial.patch already applied (or not clean) — continuing" >&2
else
  git -C "$SRC" apply "$PATCH"
fi

# 3. Force the shims to take over (a stale Cargo.lock pins the REAL rayon, whose
#    par_bridge thread spawn hangs on wasi — the runtime-gap root cause).
( cd "$SRC" && $CARGO update -p rayon -p home -p ignore )

# 4. Build.
( cd "$SRC" && $CARGO build --release --target wasm32-wasip1 )

OUT="$ROOT/binaries"
mkdir -p "$OUT"
cp "$SRC/target/wasm32-wasip1/release/tokei.wasm" "$OUT/tokei.wasm"
sha256sum "$OUT/tokei.wasm" > "$OUT/tokei.wasm.sha256"
echo "tokei.wasm:"; sha256sum "$OUT/tokei.wasm"
