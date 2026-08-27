# tokei (patched fork) — spec contract (PROPOSED, not yet admitted)

NOT ADMITTED — the runnable count is unproven (see BLOCKED.runtime.md). When
proven, the retained admission will pin:
- toolId/argv0/route: a bounded `tokei` count surface (path arg → language table)
- request: stdin ≤2KiB (config), one path argument
- response: stdout ≤64KiB (bounded table)
- memory/imports/timeout: default tier ≤16MiB; 21 pure-WASI imports; bounded wall-time
- error contract: raw stderr never forwarded; bounded diagnostics
