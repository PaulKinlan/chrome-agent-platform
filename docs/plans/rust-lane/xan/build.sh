#!/usr/bin/env bash
# xan patched-fork RUNNABLE admission build — serial WASI (rayon shim + pager drop).
set -euo pipefail
TOOLCHAIN="stable-x86_64-unknown-linux-gnu"
export RUSTC="$(rustup which --toolchain "$TOOLCHAIN" rustc)"
export CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
XAN_VERSION="0.60.0"
XAN_SHA="ae02022bf700b5b414c7481ebf69f207f38314ad"
ROOT=$(cd "$(dirname "$0")" && pwd)
SHIM="$ROOT/../rayon-wasi"          # the serial rayon shim (committed alongside)
WORK="${CARGO_BUILD_DIR:-$ROOT/../../../.build/rust-lane-xan}"
SRC="$WORK/src"
mkdir -p "$WORK"
[ -d "$SRC/.git" ] || git clone --depth 1 --branch "$XAN_VERSION" https://github.com/medialab/xan.git "$SRC"
test "$(git -C "$SRC" rev-parse HEAD)" = "$XAN_SHA" || { echo "pin mismatch" >&2; exit 1; }

# Patch 1 — drop the pager for WASI (pager@0.16.1 → errno@0.2.8 nightly-only chain).
python3 - <<PYEOF
s = open("$SRC/Cargo.toml").read()
s = s.replace("[target.'cfg(not(windows))'.dependencies]\npager = \"0.16.1\"",
  "[target.'cfg(all(not(windows), not(target_os = \"wasi\")))'.dependencies]\npager = \"0.16.1\"")
s += '\n[patch.crates-io]\nrayon = { path = "' + "$SHIM" + '" }\n'
open("$SRC/Cargo.toml","w").write(s)
for f in ["$SRC/src/cmd/help.rs", "$SRC/src/cmd/view.rs"]:
    s = open(f).read().replace("#[cfg(not(windows))]", '#[cfg(all(not(windows), not(target_os = "wasi")))]')
    open(f,"w").write(s)
h = open("$SRC/src/cmd/help.rs").read()
old = '''        #[cfg(windows)]
        {
            Err("The -p/--pager flag does not work on windows, sorry :'(".to_string())?
        }
    }
}'''
new = '''        #[cfg(windows)]
        {
            Err("The -p/--pager flag does not work on windows, sorry :'(".to_string())?
        }

        #[cfg(target_os = "wasi")]
        {
            let _ = self.flag_pager;
            Ok(())
        }
    }
}'''
assert old in h
open("$SRC/src/cmd/help.rs","w").write(h.replace(old, new, 1))
PYEOF

# Patch 2 — serial rayon shim (wasi-preview1 has no threads; the shim is installed
# via [patch.crates-io] above). No xan source change for the par_* call sites:
# they resolve through the shim's serial traits.

( cd "$SRC" && $CARGO build --release --target wasm32-wasip1 )

# Deterministic, pinned artifact.
OUT="$ROOT/binaries"
mkdir -p "$OUT"
cp "$SRC/target/wasm32-wasip1/release/xan.wasm" "$OUT/xan.wasm"
sha256sum "$OUT/xan.wasm" > "$OUT/xan.wasm.sha256"
echo "xan.wasm:"; sha256sum "$OUT/xan.wasm"
