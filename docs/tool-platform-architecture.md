# Tool Platform Architecture

Status: live bounded lazy-provider cutover is a 0.2.180 release candidate; the loaded-MV3 shadow capture remains public, bundled Wasm remains catalog-only, and fresh browser acceptance plus independent release review remain pending.

## Provenance and factual precedent

The precedent is [PaulKinlan/Co-do](https://github.com/PaulKinlan/Co-do) at
commit
[`d3ebdbd5066f16a2bb8a2b8cb8af4b57c8ae324a`](https://github.com/PaulKinlan/Co-do/commit/d3ebdbd5066f16a2bb8a2b8cb8af4b57c8ae324a).
The local checkout was inspected as the source authority; no Co-do binary or
source was copied into this extension.

At that commit Co-do defines exactly 39 built-in tools grouped by function: text
(12), crypto/encoding (6), data formats (6), file utilities (6),
code/minification (5), search (1), compression (1), database (1), and media (1).
Enabled tools are eagerly converted into AI SDK tools. Its generic Wasm path
uses a Worker only for fileless tools and can fall back to main-thread execution
for file-capable tools. Permission state is per tool name. These are facts about
the precedent, not requirements adopted by Chrome Agent Platform.

Co-do's root licence is Apache-2.0 while package metadata and generated
manifests have declared MIT. That contradiction, binary provenance, and
reproducibility must be resolved before any Co-do binary is considered as a CAP
input.

## Program objective

Build a Co-do-style browser-native tool operating layer without weakening CAP's
existing authorities:

- owner-only installs and capability grants;
- MV3 CSP and Chrome Web Store remotely hosted code constraints;
- OPFS isolation and artifact transaction authority;
- run, agent, origin, document, source-generation, and catalog-generation
  fences;
- source-specific dispatch and Chrome optional-permission checks;
- no credentials, cookies, provider configuration, or unrestricted `chrome.*`,
  network, DOM, or OPFS access in modules;
- replay safety remains `read-only | idempotent | mutating | unknown`, with
  unknown as the default and no universal exactly-once claim.

Retrieval narrows provider context. It never grants authority.

## Implemented owner-decision-free shadow slice

`CAP-FB-20260822-TOOL-CATALOG-CONTRACT-01` adds metadata-only, rebuildable
authorities:

1. `extension/lib/tool-catalog.js`
   - canonical descriptors for current extension built-ins, Chrome/browser
     tools, management tools, and declared/inferred WebMCP tools;
   - stable identity binds source kind, package ID, tool ID, version, descriptor
     digest, capability digest, scope, and source generation;
   - bounded names, aliases, descriptions, schema summaries, capabilities,
     scopes, descriptor counts, and catalog bytes;
   - malformed Unicode and bidi controls fail closed; canonical same-namespace
     collisions exclude every collider;
   - page-controlled replay claims are ignored and WebMCP tools remain
     `unknown`;
   - source adapters observe the real AI tool maps and WebMCP directory without
     calling their execute functions.
2. `extension/lib/tool-search.js`
   - an in-memory derived index rebuilt from the canonical catalog;
   - deterministic exact-name, alias, prefix, and lexical scoring;
   - bounded query, token, top-k, summary, schema, and aggregate result sizes;
   - untrusted descriptions and schemas are searchable data, never prompt
     instructions or ranking policy.
3. `extension/lib/tool-selection.js`
   - opaque, expiring diagnostic `selectionRef`s scoped to run, agent, origin,
     document, catalog generation, stable descriptor identity, and source
     generation;
   - per-search, per-run, global-count, TTL, and response-byte ceilings;
   - source removal, generation changes, expiry, or scope mismatch fail closed;
   - every result states `authorizes:false` and
     `requiresLiveAuthorization:true`.
4. `extension/lib/tool-catalog-shadow.js`
   - rebuilds from live sources for each inspection;
   - exposes bounded summary/search/resolve diagnostics only;
   - has no execute, install, permission, package, Worker, or grant path.
5. `tool-catalog.shadow`
   - Settings-principal-only service-worker diagnostics;
   - not page-callable and not model-callable;
   - does not change the existing eager browser, management, memory, or WebMCP
     provider binding.

The shadow route is for measuring catalog shape and lexical behavior before any
cutover. It is not a public execution protocol. Existing dispatch remains
unchanged:

- browser tools continue through `browserToolset()` and its live Chrome
  permission/product-grant/run-fence checks;
- management tools continue through `managementToolset()` and authoritative
  service-worker routes;
- WebMCP tools continue through `invokeSiteTool()` with enrollment, origin,
  document, generation, source, approval, and post-invocation checks;
- memory tools continue through `memoryToolset()` and its durable
  ownership/generation fences.

## Canonical descriptor

Each admitted descriptor has:

```text
schemaVersion
stableId
sourceKind
packageId / toolId / version
digest / capabilityDigest
name / normalized name / bounded aliases
bounded description / bounded schema summary
capabilities
scope { hub, agentId, origin, documentId }
sourceGeneration
availability
dispatcherKind
trustedReplaySafety
```

`stableId` is a SHA-256 identity over the
source/package/tool/version/digest/capability/scope/source-generation tuple. The
current JS adapters compute a descriptor digest over bounded metadata. A future
Wasm package authority must instead bind its separately verified executable
digest and signed capability-manifest digest; this shadow digest is not a
signature or executable provenance claim.

A catalog generation hashes the sorted admitted stable IDs and source
generations. The index is derived and disposable. Source stores, enrollment
state, current document gates, route registries, and future package records
remain authoritative.

## Selection contract

A diagnostic selection reference is valid only while all recorded fences match:

```text
runId
taskId
agentId
origin
documentId
runGeneration
catalogGeneration
stableId
sourceGeneration
closureGeneration
package/descriptor/capability/permission/grant identity
expiry + single-use replay state
```

Search results for stale/disabled/owner-action-required tools may explain
availability but do not receive a reference. A reference never represents a
Chrome permission, product grant, WebMCP approval, package install, or execution
authorization.

## Live bounded lazy protocol

`CAP-FB-20260823-LAZY-PROVIDER-CUTOVER-01` binds the reusable protocol core to
every agent run while retaining the public Settings-only shadow capture:

- the actual AI-SDK provider map contains exactly `search_tools`, `list_tools`,
  and `execute_tool`; measured provider-definition bytes remain constant for
  catalogs of 20, 100, and 1000 rows, and no dynamic descriptor/schema enters
  provider options or prompts;
- search rebuilds the live bounded lexical catalog and returns only in-scope
  metadata. Ready rows receive expiring single-use references bound to the full
  run/task/agent/origin/document/run-generation/catalog/source/closure/package/
  capability/permission/grant identity; search never executes, approves,
  installs, requests permission, or creates a grant;
- execute atomically claims only a returned reference, rejects malformed,
  invented, expired, restarted, cross-scope, concurrent, or replayed references,
  and re-resolves every immutable and live authority fence before validation,
  before dispatch, and after dispatch. A claim that fails ARGUMENT validation
  (sanitizer or Zod) never reaches dispatch, so it is released: the
  `lazy-arguments-invalid` error carries the same `selectionRef` and
  `retryable: true`, and the model's corrected call on that ref succeeds
  (CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01). A SUCCESSFUL execution
  still consumes the ref; a concurrent or later reuse stays
  `selection-replayed`;
- list and search share each tool's provider JSON Schema plus an
  `x-cap-argument-limits` contract (UTF-8 string/payload bytes, depth, nodes,
  keys, and array items). The same contract drives lazy sanitization and the
  artifact/script store ceilings, so discovery and enforcement cannot drift;
- every catalog row also carries a bounded `outputSchemaSummary`. Exact output
  schemas currently cover `search_tools`, `list_tools`, `execute_tool`, the
  create/update/delete/list/get/generate-UI artifact family, and Gemini `google_search` /
  Anthropic `web_search`; other tools use the generic JSON-value contract until
  the follow-up return-shape audit extends the tool-id registry. `execute_tool`
  transports the selected summary beside its result so the shared renderer can
  remove schema metadata and boundedly decode one JSON-string layer;
- ordinary arguments retain 16 KiB/string and 32 KiB/payload limits. Only the
  named product-owned fields (`create_asset.content`, `update_asset.content`,
  `generate_ui.html`, and script `source`) receive their backing store's larger
  bound. Those strings stay byte-exact and are never normalized or truncated;
- rejected size/shape calls return the field/path, actual size, exact limit, and
  a concrete retry instruction instead of an opaque `bad-data` detail;
- adapters retain each source's existing Zod/schema validator and exact dispatch
  closure. Browser and management permissions/grants, memory run ownership, and
  WebMCP enrollment/document/source/approval checks remain the only execution
  authorities; source or closure replacement fails closed;
- cancellation and mid-dispatch navigation/revocation discard output; bounded
  results are structurally secret-redacted before crossing the provider
  boundary; typed aborts remain AI-SDK tool errors;
- bundled Wasm rows are always projected as disabled catalog-only metadata.
  They receive no selection reference, validator, authorization callback, or
  provider dispatch closure, regardless of their separate Settings admission;
- immutable protected guidance, appended after owner customization, requires
  hub, named/direct, background/durable, scheduled, hook, and site-worker runs
  to search, inspect bounded results, execute the exact returned reference,
  never invent/reuse references, and never treat discovery as authority.

The original shadow route remains metadata-only and reports
`providerBound:false`, `canExecute:false`, and `canGrant:false`. Its prior loaded
browser evidence is historical evidence for that shadow surface only. The live
0.2.180 candidate still requires fresh loaded-MV3 browser acceptance and an
independent release review.

## Source-only OPFS workspace authority

`CAP-FB-20260822-OPFS-TOOL-WORKSPACES-01` adds an unreachable, service-worker-
owned wrapper for strict `tool-jobs/<execution>/<call>/` roots:

- path segments use a narrow ASCII grammar, reject reserved/traversal/encoded or
  malformed names, and never return directory or writable-input handles;
- `projectInput` rechecks job authority, verifies SHA-256 before write, writes
  `inputs/<digest>.bin` once, completes only an interrupted empty projection,
  re-reads/hash-verifies, and refuses conflicting or undeclared input;
- a promise-chain mutex serializes journal changes; byte/file reservations use
  bounded idempotency keys and origin-storage pressure checks;
- `.quota.current`, `.quota.next` and a trusted `.quota.anchor` recover a newer
  closed journal only when `prevSeq`/`prevDigest` continuity is proven; stale or
  corrupt next state is discarded when current is valid, while unverifiable or
  both-invalid state quarantines fail closed;
- orphan GC scans only strict job identities, requires terminal+expired metadata,
  writes a durable `.gc` marker before recursive removal, resumes interrupted
  removal, and never removes a cross-job identity mismatch;
- output promotion calls only `createAssetKeyed`. Its caller-owned key binds
  execution ID, call index, filename and SHA-256 of the bounded content. The
  keyed artifact authority deliberately treats a same key as the same operation
  without comparing retry content, so every future caller must also include the
  content digest. The existing unkeyed `createAsset` contract remains unchanged.

The wrapper exposes no runtime message, provider, package, Worker or model tool.
It does not make OPFS or a fresh Worker usable in product. The exploratory
loaded-MV3 probe passed independently, but execution remains blocked on a
separately reviewed route/offscreen/Worker successor.

## Source-only bundled Wasm package authority

`CAP-FB-20260822-WASM-PACKAGE-AUTHORITY-01` adds a record authority for the
Store-bundled lane only. It intentionally ships zero Wasm binaries:

- a bounded duplicate-key-aware pre-parser rejects repeated decoded keys before
  `JSON.parse`; canonical manifests reject unknown fields at every schema depth,
  non-ASCII/control text, loose semver/IDs, unsorted or undeclared capabilities,
  and incomplete build/source/SBOM/licence/notices provenance;
- package identity binds the canonical signature-stripped manifest, tool and
  executable digests, capability digests, runtime compatibility and replay
  class. Signer key/algorithm/signature-presence metadata is recorded with
  `verified:false`; this slice invents no key distribution or crypto trust;
- immutable release inventory reads verify every listed physical file by exact
  relative path, size and SHA-256 and reject missing/extra files. Admission
  rechecks CAS bytes, manifest identity, SBOM/licence/notices and active/revoked
  bundled signer metadata but never writes extension bytes;
- import declaration count and module-name syntax are separate bounds: at most
  eight entries per list and at most 64 printable ASCII grammar bytes per module.
  In the bundled first slice, `allowed` accepts only exact
  `wasi_snapshot_preview1`; it rejects wildcard, arbitrary `env`, typos, Unicode
  and overlong names before admission. `disallowed` may contain `*` or bounded
  valid module names, and both lists remain sorted and duplicate-free;
- the bounded raw scanner enforces magic/version, canonical u32 LEB framing,
  section caps/order/duplicates, the exact WASI allowlist plus declarative deny
  policy, and the union of imported+defined memories. It measures each import's
  exact module, field name and kind, including function imports. Exactly one
  memory with a maximum is required; memory64, shared, unknown flags,
  multi-memory and measured maxima beyond the declaration/tier fail. Other
  sections are byte-bounded and explicitly recorded as
  `not_audited_in_authority_slice`;
- `tiny` and `default` measured tiers may be recorded. `large` remains blocked
  unless the immutable release inventory contains matching loaded-MV3 memory
  evidence;
- mutable `wasmPkg` records use a reserved `__wasmTx` exact-generation WAL.
  Prepared intents recover to committed only for the exact next record/token,
  otherwise compensate only at the exact prior token. Updates/revocations are
  version-fenced, revoked state survives restart, and `grantEpoch` changes with
  version, executable or capability identity.

No service-worker route imports the authority. It has no owner admission,
install UI, model/provider binding, Worker, runtime API, network, permission,
OPFS, artifact or executable path. The build scans any newly appearing `.wasm`
and fails it as unmanifested; because this slice has no binary, the measured
fixture audit exists in tests only.

## Pure source WASI Preview 1 execution-host contract

Gate 0's exploratory loaded-MV3 probe independently passed all ten runtime,
termination, offscreen, OPFS-isolation and service-worker-rotation checks. That
evidence authorizes only Gate 1 source work; it does not ship an execution path.

`CAP-FB-20260822-WASM-EXECUTION-HOST-01` Gate 1 adds exactly two unreachable
libraries:

- `wasm-host-types.js` owns frozen WASI errno, file type, flag, right, path-class,
  hard-limit and default-quota records. Strict frozen job/context/quota/FD
  constructors reject unknown/accessor fields, invalid IDs/origins/workspace
  roots, oversized/non-well-formed argv/stdin, blocked tiers and out-of-range
  rights or offsets;
- `wasi-preview1-runtime.js` takes injected synchronous bounded byte-memory and
  workspace adapters. It never constructs an OPFS handle. Its fixed
  `wasi_snapshot_preview1` object implements bounded argv, an exactly empty
  environment, fd 0/1/2 streams, fd 3 preopen name `.` plus the same-workspace fd 4 guest alias `/job`, file read/write/seek/
  tell/close/fdstat/filestat, preopen/path stat/open, 64 KiB random, monotonic
  clock, explicit `CLOCK_REALTIME` `ENOTSUP`, and typed `proc_exit`;
- wasm32 pointers and iovec tables are snapshotted and checked as little-endian
  u32 spans before side effects. Control/data alias, wrap, OOB, aggregate iovec,
  unsafe BigInt offset and file-size overflow fail as errno. Every syscall checks
  cancellation and the host-call quota; stdin/stdout/stderr/path/dynamic-FD/
  cumulative-file-byte and file-size quotas remain bounded;
- fd rights are reduced by path class: `inputs/` is read-only, `scratch/` is
  read-write and `output/` is write-only. Output content cannot be read back and
  inputs cannot be created, truncated or written. Relative UTF-8 paths reject
  absolute/backslash/NUL/control/empty/dot/dotdot traversal, overlong segments
  and symlink-follow requests;
- the measured union from the 37 non-Emscripten rebuilt modules is recorded as
  nine WASI function imports. The host supports only its fixed initial syscall
  set (including reviewer addition `fd_tell`; realtime clock id 0 is explicit
  `ENOTSUP`) and rejects any foreign module, non-function or unknown function
  explicitly. A helper
  revalidates package-scanner readback against the exact shared tiny/default
  tiers while keeping large blocked;
- syscalls return WASI errno rather than throw. The only typed signal is a valid
  `proc_exit`. Partial IO, close/reuse, adapter failures, deny rules and every
  call shape are exercised through an in-memory adapter.

No product file imports either library. This slice has no service-worker,
offscreen, Worker, route, provider, network, package-byte fetch, OPFS
construction, `WebAssembly.compile`/`instantiate`, artifact promotion or
execution. Those belong to a separately reviewed Gate 2 successor.

## Source-only retained code-diff artifacts

`CAP-FB-20260822-CODE-DIFF-ARTIFACTS-01` adds an unreachable first slice for
retaining tool-produced changes without granting workspace mutation:

- a getter/proxy-safe snapshot rejects accessors and exotic/cyclic input before
  validation. Strict change documents cover add, update, delete, rename and
  binary replacement with exact allowed fields, SHA-256, sizes, media and
  encodings;
- owner paths accept valid Unicode/UTF-8 but reject lone surrogates, NUL,
  C0/C1/bidi controls, backslashes, absolute/drive/UNC/empty/dot/dotdot and
  percent traversal. Per-segment NFC is canonical; NFC and conservative
  Unicode-casefold collisions reject the whole document. Segment/path/path-set
  budgets are 255/1024 bytes and 256 paths, with an exact reversible
  `displayPaths` map when original spelling is retained;
- one SHA-256 identity binds producer source/package/executable/capability/replay
  identity, workspace/execution/call/run/agent/origin/document fences, inputs,
  exact sorted base/result sets, the canonical change document and fixed media;
- `retainPatch` preflights every byte, digest, declared size, UTF-8 claim,
  per-blob limit, 64-blob limit and 4 MiB total raw-CAS limit before writing.
  Each unique blob is base64-enveloped under a digest-bound
  `createAssetKeyed` key, then re-read and hash-verified. The patch is written
  last under its identity key. A write interruption is delegated to the
  existing artifact WAL and a retry uses the same keys; no unkeyed create or
  artifact-index/store handle exists here;
- unified and side-by-side row-split views re-hash supplied authoritative bytes,
  neutralize controls, truncate overlong lines, refuse total line/byte overflow,
  and show binary metadata only. They are plain-data, explicitly
  non-authoritative previews, not stored diffs or an LCS correctness claim.

`applyPending`, `rejectPending` and `undoApplied` synchronously throw
`mutation_authority_required` before inspecting caller input. There is no owner
approval, route, OPFS primitive, provider, WebAssembly or mutation dependency.
A separate reviewed slice must settle conditional workspace writes, owner UI,
stale-base rechecks, recoverable multi-file semantics and its WAL before any of
those actions can exist.

## Source-only retained tabular-diff artifacts

`CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01` is a distinct unreachable custody
slice for complete descriptive table comparisons. It does not reinterpret rows
as a code-change document:

- the import-free core fatally decodes 1..1,048,576 UTF-8 bytes, rejects BOM,
  lone surrogates, duplicate decoded JSON keys, noncanonical bytes, open schema,
  hostile counts/order/locators/columns/cells and any incomplete or truncation
  claim, then recomputes semantic, options, input and exact-content identities;
- operation identity binds the bundled package/tool/version and all source,
  manifest, inventory, executable, capability and replay digests; workspace,
  execution, call, run, agent, origin and document fences; and exact ordered
  left/right `inputs/` receipts including source generation;
- the pure planner splits canonical bytes—not strings or rows—at fixed 180 KiB,
  caps one MiB/eight chunks/nine assets, and materializes every digest-keyed
  base64 envelope before write 1. A multibyte scalar may cross a chunk boundary
  and is decoded only after exact reassembly;
- the unreachable adapter has exactly `createAssetKeyed`/`getAsset` authority.
  It writes chunks in index order with immediate readback, re-reads the complete
  chunk set, then writes and verifies a canonical read-only retention manifest
  last under the digest of its exact bytes. Reads revalidate manifest, chunks,
  body and operation identity before returning data;
- summary/schema/row/cell previews are non-authoritative, paginated plain data
  bounded to 200 rows, 2,000 cells and 512 KiB. Display cells are neutralized,
  scalar-safe truncated to 512 bytes and flag inert formula prefixes.

The current artifact API has no atomic multi-key reservation, reference count or
orphan collector. Capacity failure therefore refuses promotion and reports only
verified digest-keyed chunk receipts plus the explicit no-automatic-delete
policy; it never evicts owner artifacts or claims an atomic group. The adapter
is not imported by a route. `applyTabularDiff`, `rejectTabularDiff`,
`undoTabularDiff` and `exportPatchedCsv` synchronously throw
`mutation_authority_required` before argument access.

## Source-only Chrome lazy capability metadata

`CAP-FB-20260822-CHROME-LAZY-TOOLS-01` adds metadata—not Chrome authority:

- `chrome-tool-capabilities.js` is a frozen data-only table for the exact nine
  `browserToolset(false)` and 29 `managementToolset` names. Every row carries
  exact source kind, distinct namespaced capability token(s), backing optional
  permission names, product-grant scope kind, replay/trusted-replay class,
  owner-gesture requirement, mutation class and route family;
- the table fails closed on missing/extra inventory. Management reads, hook
  idempotents and mutations have distinct tokens; `management.route` no longer
  collapses all 29 descriptors. Replay rows are tested against the existing
  replay-safety authority;
- only the existing `capabilitiesByTool` construction in the Settings shadow
  consumes the table. Browser and management source tool maps, Zod validators,
  dispatcher wrappers, route handlers and eager provider binding are unchanged;
- selected capture rows add `capabilityDigest`, `trustedReplaySafety` and a
  bounded capability summary. Non-selected descriptors contribute only a
  bounded `nonSelectedCount`; no non-selected names, schemas, capabilities or
  tool rows cross the capture boundary;
- all 38 descriptors remain cataloged. `run_script`, scheduled scripts,
  provider changes, destructive deletes/updates, screenshots and side-panel
  opening remain explicitly flagged for later loaded denial/revoke/race gates.
  The list is policy documentation, not runtime filtering and not exposure.

The capture remains Settings-only with `providerBound:false`,
`eagerBindingChanged:false`, `canExecute:false` and `canGrant:false`. No
permission request, product grant, provider cutover, execution route or changed
dispatch exists in this slice.

## Distribution lanes and Store policy

Two lanes remain explicitly separate:

- **Chrome Web Store lane:** only executable Wasm bytes bundled and reviewed
  with the extension may run. Downloaded or uploaded Wasm is treated as remotely
  hosted code unless written policy clearance establishes otherwise.
- **Unpacked, enterprise, or developer lane:** owner-selected packages may be
  researched behind separate package, signer, capability, and grant authorities.
  This does not imply Store eligibility.

The credential-free Store target is an explicit packaging assertion, not a new
runtime lane. `--target=store` uses the unchanged exact inventory, package SHA,
fresh ZIP, verification, and atomic replacement. Canonical `dist.complete` v2
binds commit, indexed source, generated outputs, and target intent; it rejects
legacy and honest cross-target mismatches but is not independent content proof.
Before and after packaging, the Store scanner checks the actual tracked and
generated JS/HTML plus manifest CSP, declares only `bundled-reviewed-only` Wasm
authority, rejects every unmanifested `.wasm`, and keeps the Worker literal
allowlist empty. Computed/simple aliases for Worker, SharedWorker, importScripts
and remote JavaScript fetch sinks fail. The manifest sandbox evaluator alone has
an exact-path exemption; generated service-worker/options bundles do not. AST
and HTML checks are bounded defense-in-depth heuristics, not substitutes for
exact CSP, marker/output bindings, or package hashes.

Digest pinning, signatures, owner clicks, local file selection, or a clean static
scan do not by themselves resolve Chrome Web Store remotely hosted code policy.
Arbitrary owner-package execution remains blocked on a written distribution-
policy decision. Co-do's licence inconsistency and per-binary provenance are
also unresolved.

## Planned authority split

1. **Lazy protocol:** live fixed-pair provider cutover is implemented in the
   0.2.180 candidate; fresh loaded-MV3 acceptance and independent review remain
   the release gates.
2. **MV3 runtime probe:** exploratory Gate 0 independently passed Wasm CSP,
   offscreen/fresh-Worker, OPFS, timeout/termination, import, memory and
   service-worker-rotation checks; it does not authorize product execution.
3. **Package authority:** bundled-only source candidate implements immutable
   manifest/module/capability/inventory identity, measured raw audit, explicit
   unverified signer metadata, SBOM/licence provenance, revocation and exact-
   generation WAL/CAS records; owner/install/execution lanes remain absent.
4. **OPFS workspaces:** source candidate implements per-job read-only inputs,
   bounded scratch/output, journaled quota reservation, cleanup, cross-job
   isolation and keyed artifact promotion; no execution route consumes it.
5. **Execution host:** Gate 1 defines only the unreachable pure WASI table and
   injected adapter contracts. Gate 2 still requires a separately reviewed fresh
   Worker per invocation, strict cross-context fencing, no main-thread fallback,
   durable job records and replay integration.
6. **Built-ins:** provenance-clean bundled tranche, starting with operating
   essentials.
7. **Code-diff artifacts:** source candidate retains strict base/result CAS and
   derives bounded non-authoritative views; owner-visible apply/reject/undo and
   every workspace mutation remain a separate unavailable successor.
8. **Chrome lazy tools:** exact 9+29 metadata is available through the fixed
   pair; existing closures and live permission/grant checks remain authoritative,
   and loaded denial/revoke/race proof is still required for this candidate.
9. **Tool Library UI:** reusable components for provenance, versions,
   capabilities, grants, revocation, quotas, and diagnostics.
10. **Owner install lane:** only after package UI and distribution policy are
    resolved.
11. **Spreadsheet toolkit:** bounded table operations and artifact previews on
    the reviewed host.
12. **Abuse gates:** hostile metadata/packages, quotas, restarts, revocation,
    network and credential nondisclosure, Web Store/RHC scan, and loaded-browser
    evidence throughout.

## Future execution invariants

A future invocation must resolve, authorize, persist a pre-dispatch
job/idempotency record, reserve quotas, stage an isolated OPFS root, inspect
bytes/imports/memory, instantiate a fresh Worker, enforce wall/output/host-call
ceilings, terminate the Worker, validate outputs, promote through artifact
transactions, record a bounded receipt, and clean up. Interrupted `mutating` or
`unknown` work pauses for owner resolution. Browser Wasm has no portable fuel
counter; Worker termination is the CPU kill switch, and a declared Wasm memory
maximum does not cap the whole Worker heap.

## Explicit non-goals of this slice

- no product Wasm loader, compilation, instantiation, Worker, offscreen host,
  install, owner-package, signature verification, grant or execution route; the
  pure WASI ABI table, OPFS and bundled-package authorities are source-only and
  unreachable;
- no embeddings, SQLite, Vectorize, or storage-engine decision;
- no permission additions or `chrome.permissions.request` calls;
- no reinterpretation of legacy `(origin, toolName)` approval as package
  authority;
- no copying or executing Co-do binaries;
- no claim that arbitrary owner-selected Wasm is Store-safe.
