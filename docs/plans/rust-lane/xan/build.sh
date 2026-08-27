#!/usr/bin/env bash
# xan patched-fork build (BUILD proof; runtime blocked on rayon — see PROVENANCE.md)
set -euo pipefail
TOOLCHAIN="stable-x86_64-unknown-linux-gnu"
export RUSTC="$(rustup which --toolchain "$TOOLCHAIN" rustc)"
export CARGO="$HOME/.cargo/bin/cargo"
XAN_VERSION="0.60.0"
XAN_SHA="ae02022bf700b5b414c7481ebf69f207f38314ad"
ROOT=$(cd "$(dirname "$0")" && pwd)
WORK="${CARGO_BUILD_DIR:-$ROOT/../../../.build/rust-lane-xan}"
SRC="$WORK/src"
mkdir -p "$WORK"
[ -d "$SRC/.git" ] || git clone --depth 1 --branch "$XAN_VERSION" https://github.com/medialab/xan.git "$SRC"
test "$(git -C "$SRC" rev-parse HEAD)" = "$XAN_SHA" || { echo "pin mismatch" >&2; exit 1; }
# PATCH: drop pager for wasi (see PROVENANCE.md)
python3 - <<'PATCH'
import re
p = "$SRC/Cargo.toml"; s = open(p).read()
s = s.replace("[target.'cfg(not(windows))'.dependencies]\npager = \"0.16.1\"",
  "[target.'cfg(all(not(windows), not(target_os = \"wasi\")))'.dependencies]\npager = \"0.16.1\"")
open(p,"w").write(s)
for f in ["$SRC/src/cmd/help.rs", "$SRC/src/cmd/view.rs"]:
    s = open(f).read().replace("#[cfg(not(windows))]", '#[cfg(all(not(windows), not(target_os = "wasi")))]')
    open(f,"w").write(s)
PATCH
python3 - <<'PATCH2'
s = open("$SRC/src/cmd/help.rs").read()
old = '''        #[cfg(windows)]
        {
            Err("The -p/--pager flag does not work on windows, sorry :'(".to_string())?
        }
    }'''
new = '''        #[cfg(windows)]
        {
            Err("The -p/--pager flag does not work on windows, sorry :'(".to_string())?
        }
        #[cfg(target_os = "wasi")]
        { let _ = &self.flag_pager; Ok(()) }
    }'''
open("$SRC/src/cmd/help.rs","w").write(s.replace(old, new, 1))
PATCH2
"$CARGO" build --release --target wasm32-wasip1 --manifest-path "$SRC/Cargo.toml" --target-dir "$WORK/target"
mkdir -p "$ROOT/binaries"
cp "$WORK/target/wasm32-wasip1/release/xan.wasm" "$ROOT/binaries/xan.wasm"
sha256sum "$ROOT/binaries/xan.wasm"
