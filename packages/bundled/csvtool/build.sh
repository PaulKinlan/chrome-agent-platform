#!/usr/bin/env bash
# Reconstructed from the EXACT command recorded in the clean-room evidence
# (packages/bundled/evidence/csvtool, REPORT.md line 24 in the original
# provenance tree; toolchain clang/LLD 22.1.8,
# SOURCE_DATE_EPOCH=0 via scripts/safe-build-env.sh). Two builds must be
# byte-identical: sha256 5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81.
set -euo pipefail
clang --target=wasm32 -std=c17 -O2 -Wall -Wextra -Werror -nostdlib -fno-builtin \
  -Wl,--no-entry,--initial-memory=131072,--max-memory=33554432,--export-memory,--stack-first,-z,stack-size=65536,--strip-all \
  -o csvtool.wasm source/csvtool.c
