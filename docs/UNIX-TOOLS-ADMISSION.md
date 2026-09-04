# Unix tools: large-input execution and admission profile

Status: design authority for the `grep`, `sed`, `awk`, `sort`, `uniq`, `wc`,
`tr`, `base64`, and `jq` admissions.

## Contract

These are command-compatible WebAssembly tools available through the ordinary
`search_tools` → `execute_tool` path. CAP does not reject an input because it
crosses a product-defined byte or line threshold. Input, output, and sort spill
are streamed or file-backed; complete output is retained. A run may still fail
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
result  = outputRef + media type + byte count + digest + exit status + counters
```

The service worker keeps manifest/CAS/capability/run-fence revalidation. It
ensures the existing offscreen document, which stages inline, attachment, or
artifact input under `tool-jobs/<execution>/<call>/`. A fresh dedicated Worker
opens file handles with `FileSystemSyncAccessHandle` before `_start`, so WASI
`fd_read`, `fd_write`, seek, and scratch calls remain synchronous without
serializing the payload as JavaScript number arrays. Wasm bytes travel as a
`Uint8Array`/transferable buffer.

The Worker never concatenates large stdout or stderr. Completion atomically
publishes the files and returns references plus incremental SHA-256, counts,
and timings. Small results may also be inlined for convenience, but crossing an
inline representation threshold never rejects or truncates the retained
result. Cancellation or failure terminates the Worker and removes unpublished
input/output/scratch. Storage exhaustion is reported as `storage_exhausted`.
Content-scaled host-call and path-call quotas are replaced by cancellation,
strict syscall shapes, finite concurrent descriptors, and a conservative hang
watchdog.

## Tool profiles

- `wc`, `tr`, and `base64` use fixed-size buffers and true stream I/O;
  `base64 -d` has an explicit binary output type.
- `uniq` retains only adjacent-record state and spills an exceptionally long
  record rather than imposing a line limit.
- `grep` uses a real regular-expression parser/engine, assembles records across
  chunks, and preserves normal exits 0 (match), 1 (no match), and 2 (error).
- `sed` uses pinned minised 1.16 (BSD-3-Clause), its real program parser, and
  dynamically sized pattern space.
- `awk` is a canonical grammar-based implementation, not the historical
  `awk_filter_bounded` literal-pattern subset. Subprocess and network operations
  remain unavailable at the sandbox boundary.
- `jq` uses pinned jq 1.8.2 with permissively licensed regex support, normal jq
  argv, JSON sequences, and `--stream`; arbitrary filters are not claimed to
  use constant memory.
- `sort` performs C-locale external merge sort: bounded-memory sorted runs are
  written sequentially, then fixed-fan-in merge passes alternate between two
  scratch files. Data volume is limited only by available browser storage.

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

The deterministic 100 MiB corpus contains fixed-width records and sentinels on
both sides of former 2 KiB, 64 KiB, 8 MiB, 10 MiB, 32 MiB, and 64 MiB boundaries,
plus a final-record sentinel. Acceptance records input/output byte counts and
digests, bytes actually read, cold and warm wall time, MiB/s, peak Wasm pages,
and peak scratch bytes. Correctness is exact: counts/formulas for `wc`/`awk`,
digests for full-output transforms, boundary matches for `grep`, encode/decode
round-trip for `base64`, JSON tail queries for `jq`, and ordered record count,
first/last records, digest, and observed spill/merge for `sort`.

KATs drive the loaded production extension and admitted Worker; host-native
commands and imported test doubles are not execution evidence. Gates are the
focused test while iterating, `npm run test:changed` for each increment, then a
production build, the browser KAT, and one final `npm test` on the reviewed
commit before push.
