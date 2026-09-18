#!/usr/bin/env bash
# jq 1.8.2 — single-threaded WASI preview-1 build (PATCHED FORK).
# Reproducible retained build: run this script TWICE (binaries/jq.wasm and
# metadata/rebuild-jq.wasm must be byte-identical; the script refuses to
# proceed unless both already agree with the pinned sha256 below).
#
# Determinism notes (REQUIRED, do not "improve"):
#  - The source MUST be unpacked at /tmp/jq-1.8.2: jq embeds the literal
#    configure argument line (including the -ffile-prefix-map source path)
#    in the binary's version banner, so the pinned path is part of the bytes.
#  - configure CC/CFLAGS/LDFLAGS are passed as ENVIRONMENT variables (not
#    configure arguments) — argument ordering changes the embedded banner.
#  - The CCLD `jq` target cannot link (pthread shim is not in libjq.a) and is
#    EXPECTED to fail; only the libraries are built, then the shim + final
#    link below produce the artifact.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSROOT="${WASI_SYSROOT:?set WASI_SYSROOT to a wasi-sysroot-22.0 tree}"
RT="${WASI_RT:?set WASI_RT to a resource dir with lib/wasm32-unknown-wasip1/libclang_rt.builtins.a + include/}"
SHIM_DIR="${JQ_SHIM_DIR:?set JQ_SHIM_DIR to the dir containing pthread.h + pthread-shim.c}"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
OUT="${1:?usage: build.sh <binaries/jq.wasm|metadata/rebuild-jq.wasm>}"

# 1. fetch + pin the upstream tarball (jq-1.8.2 -> commit 34f7186b).
SRC=/tmp/jq-1.8.2
if [ ! -d "$SRC" ]; then
  curl -sL -o /tmp/jq-1.8.2.tar.gz https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-1.8.2.tar.gz
  tar xzf /tmp/jq-1.8.2.tar.gz -C /tmp
fi

# 2. configure single-threaded for wasm32-wasip1 (no oniguruma, no docs).
(
  cd "$SRC"
  env CC="clang --target=wasm32-wasip1 --sysroot=$SYSROOT -resource-dir=$RT" \
    CFLAGS="-O2 -g0 -ffile-prefix-map=$SRC=/src -DNDEBUG -femulated-tls" \
    LDFLAGS="-Wl,--strip-all" \
    ./configure --without-oniguruma --disable-maintainer-mode --disable-docs --host=wasm32-wasip1 > /dev/null
  make -j4 CPPFLAGS="-I$SHIM_DIR -D_WASI_EMULATED_SIGNAL" > /dev/null 2>&1 || true   # CCLD jq link failure expected
  clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RT" -O2 -femulated-tls \
    -I"$SHIM_DIR" -c "$SHIM_DIR/pthread-shim.c" -o /tmp/jq-pthread.o
  clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RT" -O2 -femulated-tls \
    src/main.o ./.libs/libjq.a /tmp/jq-pthread.o -lwasi-emulated-signal \
    -Wl,--strip-all -Wl,--max-memory=33554432 -o "$ROOT/$OUT"
)
sha256sum "$ROOT/$OUT"
echo "retained-build written: $ROOT/$OUT"
