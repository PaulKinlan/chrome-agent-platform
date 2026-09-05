# Unix tools: large-input execution and admission profile

Status: implemented admission profile for the `grep`, `sed`, `awk`, `sort`,
`uniq`, `wc`, `tr`, `base64`, and `jq` packages.

## Contract

These are command-compatible WebAssembly tools available through the ordinary
`search_tools` → `execute_tool` path. CAP does not reject an input because it
crosses a product-defined byte or line threshold. Input, output, and sort spill
are streamed or file-backed; complete output remains available for chaining
throughout its run and explicit artifact promotion gives it durable lifetime. A run may still fail
for invalid syntax, cancellation, browser storage exhaustion, or genuine
wasm32 memory exhaustion. Declared Wasm memory maxima, finite open handles, and
a hang watchdog remain isolation boundaries, not content-size admission rules.
The required operating point is an exact 100 MiB (104,857,600-byte) input.

`search` in the request is not a tenth Unix executable: tool discovery is
already `search_tools`, while granted/private files already have `find_files`
and `grep_files`. A distinct fuzzy or recursive command needs its own semantic
contract; it must not be invented as an alias and counted twice.

## Data plane

Large jobs use a versioned, authority-bound file-backed envelope:

```text
input   = inline UTF-8/bytes | inputRef
stdout  = per-call OPFS file
stderr  = per-call OPFS file
scratch = isolated per-call OPFS files
result  = outputRef + byte counts + SHA-256 digests + exit status + timing
```

The service worker keeps manifest/CAS/capability/run-fence revalidation. Inline
model input is staged in finite chunks, while Settings can create, append, and
seal an input explicitly. Both paths use opaque records under
`wasm-tool-streams-v1/<id>/`; already-sealed stdout may be supplied as the next
call's input without copying. Attachment and permanent-artifact promotion are a
separate platform layer rather than authority silently claimed here. A fresh
dedicated Worker opens file handles with `FileSystemSyncAccessHandle` before
`_start`, so WASI `fd_read`, `fd_write`, seek, and scratch calls remain
synchronous without serializing the payload as JavaScript number arrays. Wasm
bytes travel as a `Uint8Array`/transferable buffer.

The Worker never concatenates large stdout or stderr. Completion atomically
publishes the files and returns references plus incremental SHA-256, counts,
and timings. Small results may also be inlined for convenience, but crossing an
inline representation threshold never rejects or truncates the retained
result. Cancellation or failure terminates the Worker and removes its unsealed
output and scratch; append/seal/publication failures remove partial directories
as one transaction. Reusable sealed caller input is retained, while input staged
only for one inline model call is removed by that caller. Successful model
outputs are run-scoped: they remain chainable until that exact run settles, then
all non-promoted references are removed. Binary `base64 -d` results remain exact
OPFS bytes and carry `type: binary` plus `application/octet-stream`; they are
never mis-decoded as preview text. Storage failures are reported as execution
failures. Content-scaled host-call and byte quotas are
replaced by cancellation, strict syscall shapes, finite concurrent descriptors,
a finite path-operation guard, and a conservative hang watchdog.

## Tool profiles

- `wc`, `tr`, and `base64` use fixed-size buffers and true stream I/O;
  `base64 -d` has an explicit binary output type.
- `uniq` retains only the current and previous adjacent records. Record storage
  may grow until genuine wasm32 memory exhaustion; there is no CAP byte/line
  admission ceiling.
- `grep` uses a real regular-expression parser/engine, assembles records across
  chunks, and preserves normal exits 0 (match), 1 (no match), and 2 (error).
- `sed` uses pinned minised 1.16 (BSD-3-Clause), its real program parser, and
  dynamically sized pattern space.
- `awk` is a canonical grammar-based implementation, not the historical
  `awk_filter_bounded` literal-pattern subset. Subprocess and network operations
  remain unavailable at the sandbox boundary.
- `jq` uses pinned jq 1.8.2 with normal jq argv, JSON sequences, and `--stream`.
  Its single-threaded WASI adaptation omits Oniguruma, so Oniguruma-dependent
  regex built-ins are explicitly unavailable; arbitrary filters are not claimed
  to use constant memory.
- `sort` performs C-locale external merge sort: bounded-memory, line-complete
  runs are written to isolated scratch files and pairwise-merged until one run
  remains. Oversized records are copied as file-backed singleton runs. Data
  volume is limited only by available browser storage.

Historical bounded package identities remain immutable; canonical replacements
receive new manifests, CAS digests, and descriptors.

## Admission sequence and evidence

Land the file-backed host first with a 100 MiB identity canary, then admit
`wc`, `tr`, `base64`, `uniq`, `grep`, `sed`, `awk`, `jq`, and finally `sort`.
Every tool independently requires pinned source/archive identity, licence and
notices, retained source, SBOM, two byte-identical deterministic builds,
import/memory census, canonical manifest/CAS identity, a small semantic and
negative KAT, a 100 MiB loaded-extension KAT, and a deliberate corruption or
truncation red proof.

The deterministic 100 MiB corpus is 819,200 fixed-width JSONL records (409,600
matching records), with an exact input digest. Loaded-extension acceptance
records input/output byte counts and digests, bytes actually read, elapsed time,
fresh Worker identities, first/last output windows, reference chaining, and
post-read cleanup. Correctness is exact: counts for `wc`/`grep`/`awk`, complete
output digests for every transform, decoded first/last windows for large
results, and ordered first/last records plus the full digest for spilled
`sort` output. Focused adversarial tests separately cover malformed programs,
receipt forgery, timeout termination, oversized sort records, and scratch/error
cleanup.

KATs drive the loaded production extension and admitted Worker; host-native
commands and imported test doubles are not execution evidence. Gates are the
focused test while iterating, `npm run test:changed` for each increment, then a
production build, the browser KAT, and one final `npm test` on the reviewed
commit before push.
