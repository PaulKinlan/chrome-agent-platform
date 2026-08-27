# xan (patched fork) — spec contract (BUILD-level; runtime blocked)

NOT ADMITTED. This is a build/census proof only. When the rayon serial-fallback
patch lands and the tool is proven runnable, the retained admission will pin:
- toolId/argv0/route (a bounded `xan` CSV/JSON subcommand surface)
- request/response bounds (stdin ≤2KiB in, stdout ≤64KiB out, matching the a2/b2 lanes)
- memory/imports/timeout caps (default tier ≤16MB; 25 pure-WASI imports; bounded wall-time)
- error contract (raw stderr never forwarded; bounded diagnostics)
Currently: no runnable wasm, so no spec contract is claimed.
