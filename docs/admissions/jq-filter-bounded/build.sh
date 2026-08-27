#!/usr/bin/env bash
# jq 1.8.2 — single-threaded WASI preview-1 build (PATCHED FORK).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSROOT="${WASI_SYSROOT:?set WASI_SYSROOT to a wasi-sysroot-22.0 tree}"
RT="${WASI_RT:?set WASI_RT to a resource-dir with lib/wasm32-unknown-wasip1/libclang_rt.builtins.a}"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C

# 1. fetch + pin the upstream tarball (jq-1.8.2 -> commit 34f7186b).
SRC="$ROOT/source/jq-1.8.2"
if [ ! -d "$SRC" ]; then
  curl -sL -o /tmp/jq-1.8.2.tar.gz https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-1.8.2.tar.gz
  tar xzf /tmp/jq-1.8.2.tar.gz -C "$ROOT/source"
  mv "$ROOT/source/jq-1.8.2" "$SRC"
fi

# 2. configure single-threaded for wasm32-wasip1 (no oniguruma, no docs).
(
  cd "$SRC"
  CC="clang --target=wasm32-wasip1 --sysroot=$SYSROOT -resource-dir=$RT" \
  CFLAGS="-O2 -g0 -ffile-prefix-map=$SRC=/src -DNDEBUG -femulated-tls" \
  CPPFLAGS="-I$ROOT/source -D_WASI_EMULATED_SIGNAL" \
  LDFLAGS="-Wl,--strip-all -lwasi-emulated-signal" \
  ./configure --without-oniguruma --disable-maintainer-mode --disable-docs --host=wasm32-wasip1
  make -j4
  clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RT" -O2 -femulated-tls \
    -I"$ROOT/source" -c "$ROOT/source/pthread-shim.c" -o /tmp/jq-pthread.o
  clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RT" -O2 -femulated-tls \
    src/main.o ./.libs/libjq.a /tmp/jq-pthread.o -lwasi-emulated-signal \
    -Wl,--strip-all -o "$ROOT/binaries/jq.wasm"
)
sha256sum "$ROOT/binaries/jq.wasm" > "$ROOT/metadata/binary-sha256.txt"
echo "done"
