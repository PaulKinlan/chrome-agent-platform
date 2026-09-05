# jq — immutable file-backed execution contract

- **toolId / argv0:** `jq`.
- **implementation:** upstream jq 1.8.2 with a single-threaded WASI Preview 1 adaptation. The real jq parser/interpreter handles filters, expressions, object/array transforms, reductions, JSON streaming, and formatting. Oniguruma-dependent regex built-ins are unavailable and are disclosed rather than emulated.
- **input/output:** owner-bound OPFS stdin and stdout streams. CAP imposes no input, output, line, or document byte ceiling. Small complete UTF-8 output may additionally be copied inline; large or binary output remains an opaque reference with complete byte-count and SHA-256 receipts.
- **arguments:** normal jq CLI flags and filter argv accepted by the admitted binary. Shell expansion, network access, and ambient host files are unavailable.
- **resources:** 64 initial and 512 maximum Wasm memory pages; finite 180-second wall cancellation per fresh worker. These limits bound a job's resources without limiting total stream content.
- **authority:** exact package-manifest, inventory, CAS, imports, memory, and capability checks occur at each run. References are owner-bound and sealed before use.
- **failure:** jq parse/compile/evaluation errors produce a nonzero exit and bounded stderr receipt; unsealed partial output is discarded. Output is never silently truncated.
