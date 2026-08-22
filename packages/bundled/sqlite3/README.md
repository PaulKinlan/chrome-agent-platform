# sqlite3-query-bounded (bundled package 26, DISABLED)

SQLite 3.46.0 amalgamation (upstream Blessing) + CAP-authored wrapper/host
(Apache-2.0); licence expression "blessing AND Apache-2.0". Physically bundled
and inventory-admissible; NOT executable in this release: the binary imports 24
WASI functions, eight of which the CAP runtime does not yet implement (see
PROVENANCE.json binary.capRuntimeGap; fd_fdstat_set_flags is linkage-only
callable but UNAUTHORIZED — its change semantics are unsupported). No route,
grant, or catalog entry
consumes this package. Node host sources under host/ are public Apache-2.0
provenance only — they are not shipped runtime code.
