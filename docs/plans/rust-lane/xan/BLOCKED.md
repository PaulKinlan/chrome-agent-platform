# xan (patched fork) — BUILD UNBLOCKED, runnable admission BLOCKED on rayon

UPDATE (this pass): the pager→errno@0.2.8 blocker is GONE via a one-intent patch
(drop `pager` for the WASI target — see PROVENANCE.md). The wasm now BUILDS:
12.6MB, 25 pure-WASI imports, default tier, sha 668e4955….

NEW precise blocker (runnable admission): `rayon` in 5 core paths
(sort/bins/parallel/counter/numbers-aggregators) spawns std::thread at runtime,
which wasi-preview1 does not support → thread-pool init panics. Unblock =
serial-fallback patch across those 5 sites (tranche-2 depth). No fabrication:
build/census are real; the tool is NOT admitted.
