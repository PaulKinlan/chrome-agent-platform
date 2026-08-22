#!/usr/bin/env bash
# sqlite3-query-bounded — SQLite 3.46.0 amalgamation + CAP-authored wrapper.
# Adapted from the pinned evidence build scripts (digests in PROVENANCE.json):
# the absolute local compiler path is replaced by an explicit WASI_SDK_PATH
# input; flags, archive digest, negative assertions, and two-build equality are
# preserved. NEVER fetches the archive implicitly: fail clearly until the
# hash-pinned archive is supplied at ./sources/archives/.
set -euo pipefail
SDK="${WASI_SDK_PATH:?set WASI_SDK_PATH to a wasi-sdk 18.1.2 root}"
ARCHIVE="sources/archives/sqlite-amalgamation-3460000.zip"
[ -f "$ARCHIVE" ] || { echo "supply the pinned archive at $ARCHIVE (sha256 712a7d09d2a22652fb06a49af516e051979a3984adb067da86760e60ed51a7f5)" >&2; exit 1; }
echo "$ARCHIVE" | sha256sum --check <(echo "712a7d09d2a22652fb06a49af516e051979a3984adb067da86760e60ed51a7f5  $ARCHIVE")
# Negative assertions preserved: SQLITE_OMIT_ATTACH must be ABSENT;
# SQLITE_OMIT_LOAD_EXTENSION=1 must clean-link. Exact flags: see the pinned
# evidence scripts/build-one.sh (sha256 94e03f61169907757373ca22c6d4632256fb2dcc5ff1d8f43074e1364fbf0665).
# Two builds must be byte-identical:
# sha256 ba468c6eec9c4743167c807b4781d2ca7b5e28b48850e394bf292d13f9c9559d (1125792 bytes)
echo "adapt with the pinned evidence script; do not improvise flags" >&2; exit 1
