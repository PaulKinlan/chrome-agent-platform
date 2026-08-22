# Tool Platform Architecture

Status: shadow catalog contract implemented; execution platform remains planned.

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

## Provider nondisclosure and cutover boundary

This slice does **not** add `search_tools` or `execute_tool` to the agent, alter
protected prompts, or remove eager tool binding. Catalog contents are not
appended to system prompts or model messages. The only new consumer is a
Settings-only diagnostic route.

The provider cutover is a separate task,
`CAP-FB-20260822-LAZY-TOOL-PROTOCOL-01`, dependent on this contract and the
existing `CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01`. It must prove that
non-selected descriptors and schemas are absent from provider capture and
uncallable before eager binding is removed.

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

1. **Lazy protocol:** bounded `search_tools` / `execute_tool`, provider cutover,
   and live source reauthorization.
2. **MV3 runtime probe:** prove Wasm CSP, offscreen/nested Worker, OPFS,
   timeout/termination, import, and memory behavior in a loaded extension.
3. **Package authority:** immutable manifest/module/capability identity,
   digest/signature/SBOM/licence, revocation, and artifact-grade WAL/CAS
   install/update.
4. **OPFS workspaces:** per-job read-only inputs, bounded scratch/output, path
   normalization, quota reservation, cleanup, and cross-job isolation.
5. **Execution host:** fresh Worker per invocation; strict import objects; no
   main-thread fallback; durable job records; replay integration.
6. **Built-ins:** provenance-clean bundled tranche, starting with operating
   essentials.
7. **Code-diff artifacts:** base/output digests and owner-visible
   apply/reject/undo through artifact authority.
8. **Chrome lazy tools:** same discovery protocol without weakening optional
   permissions, grants, run fences, or route dispatch.
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

- no Wasm ABI, loader, runtime, Worker, package, install, signature, grant,
  execution, or OPFS job workspace;
- no embeddings, SQLite, Vectorize, or storage-engine decision;
- no permission additions or `chrome.permissions.request` calls;
- no provider eager-binding cutover;
- no reinterpretation of legacy `(origin, toolName)` approval as package
  authority;
- no copying or executing Co-do binaries;
- no claim that arbitrary owner-selected Wasm is Store-safe.
