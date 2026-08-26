# jq_filter_bounded — bounded immutable spec contract (DRAFT, pre-admission)

This is the SPEC CONTRACT the admitted package must satisfy. It mirrors the
house description pattern (see `scripts/build-bundled-tool-packages.mjs` for
`gzip`/`sqlite3_query_bounded`). It is a contract, NOT a claim — the binary that
proves it does not yet exist (see PROVENANCE.md BLOCKERS).

## Tool

- **toolId**: `jq_filter_bounded`
- **argv0**: `jq` (the exact toolId is passed as argv0; no other program name).
- **route**: `tool.preview.run` only (Settings-only bounded preview, explicit
  owner click) — identical authority model to the 23 admitted preview tools.

## What it does

Evaluate a jq program against a single JSON document. Use to extract, transform,
and query JSON data. In/out is a two-field JSON request on stdin, not a raw
jq CLI:

```
stdin  → {"program": "...jq program...", "input": ...JSON value...}   (<= 2 KiB)
stdout → {"result": ...JSON value..., "error": null}                    (<= 64 KiB)
          {"result": null, "error": "..."} on parse/eval error
```

No flags. The request schema is validated by the runtime BEFORE the Wasm call;
the binary itself reads exactly one bounded request and emits exactly one bounded
response (no shell, no filesystem, no network).

## Bounds (immutable; revalidated at every run)

| Field | Bound |
|---|---|
| request (stdin) | <= 2 KiB (2048 bytes) |
| `program` string | <= 1 KiB, single line, no NUL |
| `input` value | must parse as a single JSON value within the request bound |
| response (stdout) | <= 64 KiB (65536 bytes); over-cap is REFUSED with an honest `error`, never silently truncated |
| runtime (execution) | bounded by the house per-call timeout; a jq program that loops is killed |
| flags | none accepted (a flag in `program` is just jq syntax, not an argv flag) |
| imports | wasm-imports allowlist identical to the a2/b2/c2 lanes (no `fd_*` filesystem, no sockets, no clock beyond the house set) |
| memory | initial 131072 / max 33554432 (the a2/b2 lane ceiling) |

## Error contract

- Malformed request → `{"result":null,"error":"request must be a JSON object with program + input"}`
- jq compile error → `{"result":null,"error":"<jq error, bounded 512 chars>"}`
- jq eval error → `{"result":null,"error":"<jq error, bounded 512 chars>"}`
- over-cap output → `{"result":null,"error":"output exceeds 64 KiB cap"}` (never truncated)
- The raw jq stderr is NEVER forwarded to the model — it is mapped to the
  bounded `error` field.

## The five never-fabricate inputs

Enumerated in PROVENANCE.md — source.repo, source.commit, binary.sha256,
build.log+toolchain, sbom. All five must be real + hash-pinned before admission.
