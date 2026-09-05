# sed — immutable file-backed execution contract

- **toolId / argv0:** `sed`.
- **implementation:** minised 1.16 (BSD-3-Clause), built from the retained source and verified by an independent byte-identical rebuild.
- **input/output:** owner-bound OPFS stdin and stdout streams. Input and output size are not capped by CAP. Small complete UTF-8 output may additionally be copied inline; larger or binary output remains an opaque reference with complete byte-count and SHA-256 receipts.
- **arguments:** standard minised script operands, including `-e SCRIPT` and `-n`. File operands and in-place editing are unavailable because the profile intentionally exposes only standard streams.
- **resources:** 64 initial and 512 maximum Wasm memory pages; finite 180-second wall cancellation per worker invocation. These are execution-resource limits, not content-size ceilings.
- **authority:** exact package-manifest, inventory, CAS, imports, memory, and capability checks occur at each run. References are owner-bound and sealed before use.
- **failure:** nonzero exits return bounded diagnostics and discard unsealed partial output. Output is never silently truncated.
