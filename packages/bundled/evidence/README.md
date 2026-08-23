# packages/bundled/evidence — pinned generation evidence (durable, in-repo)

These trees are the MINIMUM file set consumed by
`scripts/build-bundled-tool-packages.mjs` to regenerate (or fully verify) the
26 bundled Wasm tool packages. They were migrated into the repository
(owner directive: builds must never depend on paths outside the source tree)
from the original frozen provenance hosts' evidence directories (host paths
scrubbed per the owner directive).
Only generator-consumed files were migrated (52 files, ~5.9 MiB), not the
full 56 MB original trees.

Layout mirrors the generator's PATHS map: `a2/`, `b2/`, `c2/`, `csvtool/`,
`d3/`, `sqlite3/`, `catalog/inventory.json`. Every consumed byte is
hash-pinned by the generator (per-binary sha256/bytes via the catalog,
sqlite sources/archive/wasm/receipt pins, d3 inventory pin, catalog pin
`8e9e3a68…`); tampering fails generation/verify closed.

Scrub note: build-receipt scripts (a2/b2/c2/sqlite3 build.sh) had original
build-host paths (a scratch dir and a developer-home wasi-sdk path) replaced with
`$WASI_SDK`-style environment requirements on migration; no other byte of
those files changed, and the sqlite3 pin for `scripts/build-one.sh` was
re-pinned to the scrubbed bytes. Pinned `.wasm` evidence binaries are
immutable (their embedded build-host path strings are inert).
