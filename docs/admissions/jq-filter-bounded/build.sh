#!/usr/bin/env bash
# jq 1.8.2 — deterministic single-threaded WASI Preview 1 build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSROOT="${WASI_SYSROOT:?set WASI_SYSROOT to a wasi-sysroot-22.0 tree}"
RT="${WASI_RT:?set WASI_RT to a resource-dir with lib/wasm32-unknown-wasip1/libclang_rt.builtins.a}"
ARCHIVE="$ROOT/source/jq-1.8.2.tar.gz"
ARCHIVE_URL="https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-1.8.2.tar.gz"
ARCHIVE_SHA="71b8d6e8f5fe81f6c6d0d110e3892251f6ce76ed095abd315e26e6e1193af3af"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
mkdir -p "$ROOT/source" "$ROOT/binaries" "$ROOT/metadata"
if [ ! -f "$ARCHIVE" ]; then curl --fail --location --silent --show-error -o "$ARCHIVE" "$ARCHIVE_URL"; fi
echo "$ARCHIVE_SHA  $ARCHIVE" | sha256sum --check
: > "$ROOT/metadata/build.log"
clang --version | head -1 >> "$ROOT/metadata/build.log"
for pass in a b; do
  BUILD="$ROOT/source/build-$pass"
  rm -rf "$BUILD"; mkdir -p "$BUILD"
  tar xzf "$ARCHIVE" -C "$BUILD"
  cp "$ROOT/source/pthread-shim.h" "$BUILD/pthread.h"
  SRC="$BUILD/jq-1.8.2"
  (
    cd "$SRC"
    CC="clang --target=wasm32-wasip1 --sysroot=$SYSROOT -resource-dir=$RT" \
    CFLAGS="-O2 -g0 -ffile-prefix-map=$SRC=/src -DNDEBUG -femulated-tls" \
    CPPFLAGS="-I$BUILD -I$ROOT/source -D_WASI_EMULATED_SIGNAL" \
    LDFLAGS="-Wl,--strip-all -Wl,--initial-memory=4194304 -Wl,--max-memory=33554432 -lwasi-emulated-signal" \
    ./configure --without-oniguruma --disable-maintainer-mode --disable-docs --host=wasm32-wasip1 \
      >> "$ROOT/metadata/build.log" 2>&1
    make -j1 src/builtin.inc src/config_opts.inc src/version.h >> "$ROOT/metadata/build.log" 2>&1
    sed -i -e "s|$BUILD|/build|g" -e "s|$ROOT|/source-tree|g" \
      -e "s|$SYSROOT|/wasi-sysroot|g" -e "s|$RT|/clang-resource|g" src/config_opts.inc
    make -j1 libjq.la src/main.o >> "$ROOT/metadata/build.log" 2>&1
    clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RT" -O2 -femulated-tls \
      -I"$BUILD" -I"$ROOT/source" -c "$ROOT/source/pthread-shim.c" -o "$BUILD/pthread-shim.o"
    clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RT" -O2 -femulated-tls \
      src/main.o ./.libs/libjq.a "$BUILD/pthread-shim.o" -lwasi-emulated-signal \
      -Wl,--strip-all -Wl,--initial-memory=4194304 -Wl,--max-memory=33554432 -o "$ROOT/binaries/jq-$pass.wasm"
  )
done
cmp "$ROOT/binaries/jq-a.wasm" "$ROOT/binaries/jq-b.wasm"
mv "$ROOT/binaries/jq-a.wasm" "$ROOT/binaries/jq.wasm"
mv "$ROOT/binaries/jq-b.wasm" "$ROOT/metadata/rebuild-jq.wasm"
sha256sum "$ROOT/binaries/jq.wasm" > "$ROOT/metadata/binary-sha256.txt"
printf 'source_archive_sha256=%s\nreproducible=byte-identical\n' "$ARCHIVE_SHA" >> "$ROOT/metadata/build.log"
