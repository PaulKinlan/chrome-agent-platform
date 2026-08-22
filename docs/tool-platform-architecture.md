# Tool Platform Architecture

Status: shadow catalog and loaded-MV3 lazy capture public; exploratory MV3 Wasm probe Gate 0 independently passed; OPFS, bundled-package and pure WASI host authorities remain in source review; provider/runtime cutover remains planned.

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
agentId
origin
documentId
catalogGeneration
stableId
sourceGeneration
expiry
```

Search results for stale/disabled/owner-action-required tools may explain
availability but do not receive a reference. A reference never represents a
Chrome permission, product grant, WebMCP approval, package install, or execution
authorization. The future `execute_tool` protocol must re-resolve the descriptor
and re-run the current source dispatcher's complete live authority checks before
invocation.

## Shadow-only lazy protocol

`CAP-FB-20260822-LAZY-TOOL-PROTOCOL-01` is public and its metadata-only capture
has loaded-MV3 evidence, but **no provider cutover**:

- `lazy-tool-wire.js` defines the fixed, always-small `search_tools` and
  `execute_tool` descriptors and is the only lazy module imported by the
  service-worker shadow route; `lazy-tool-protocol.js` holds the separately
  unreachable injectable execution core;
- search uses the existing lexical index and `ToolSelectionAuthority`, so only
  ready tools receive opaque references and every result remains explicitly
  non-authorizing;
- execute accepts only a reference and bounded accessor-safe arguments, then
  rebuilds the live catalog and re-resolves run, agent, origin, document,
  catalog, source, stable and package identity before validation, immediately
  before dispatch, and after dispatch;
- source adapters keep each current AI tool's own Zod validation and execute
  closure. Browser permissions/grants/run fences, management routes, memory
  generation guards and WebMCP enrollment/approval/replay checks therefore stay
  in their existing authorities; the lazy core owns no alternate dispatcher;
- absent replay metadata remains `unknown`; cancellation, expiry, restart,
  source removal and post-dispatch revocation fail closed; bounded outputs are
  structurally secret-redacted before crossing the lazy boundary;
- the Settings-only shadow route may capture the fixed two-tool wire plus only
  the selected descriptor summaries. It reports `providerBound:false`,
  `eagerBindingChanged:false`, `canExecute:false` and `canGrant:false`.

The reusable execution core is not reachable from a service-worker message
route or provider. It exists so dispatcher parity and every fence can be
independently reviewed before exposure. The existing eager tool map remains the
production behavior. The exact public loaded extension proved that Settings
received only the two fixed descriptors plus one bounded selected summary, the
NTP caller was denied with a matching security event, and no full/non-selected
schema, provider data, secret, execute, grant, install, package, permission or
provider message crossed this shadow boundary.

## Provider nondisclosure and cutover boundary

Neither the public catalog nor the lazy successor adds the two protocol tools
to an agent, alters protected prompts, or removes eager tool binding. Catalog
contents are not appended to system prompts or model messages. The only runtime
consumer remains the Settings-only diagnostic route, whose capture action is
metadata-only and cannot invoke the execution core.

The loaded-MV3 shadow gate proved bounded selected-only capture and absence of
an execution action. Provider exposure remains a separate successor: it must
prove selected dispatch parity across every existing source and expiry/restart/
revocation/cancellation fences through the real service-worker lifecycle before
eager binding may be removed.

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
  environment, fd 0/1/2 streams, fd 3 preopen name `.`, file read/write/seek/
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

Digest pinning, signatures, owner clicks, or local file selection do not by
themselves resolve Chrome Web Store remotely hosted code policy. Arbitrary
owner-package execution remains blocked on a written distribution-policy
decision. Co-do's licence inconsistency and per-binary provenance are also
unresolved.

## Planned authority split

1. **Lazy protocol:** public shadow capture verified; provider exposure/cutover
   remains gated. Live source reauthorization exists only in the unreachable
   injectable core.
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
8. **Chrome lazy tools:** source candidate canonicalizes exact 9+29 metadata
   and selected-only summaries while provider exposure and every execution path
   remain absent; loaded denial/revoke/race proof gates any later cutover.
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
- no provider binding or eager-binding cutover for the lazy protocol;
- no reinterpretation of legacy `(origin, toolName)` approval as package
  authority;
- no copying or executing Co-do binaries;
- no claim that arbitrary owner-selected Wasm is Store-safe.
