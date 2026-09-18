# Registry oracle — S1 mechanics, S2 fixtures, S3 execution mechanisms

`capture.mjs` is a native-Node external host. `oracle.mjs` is a self-contained,
read-only Node/Deno stdin ES module. `reconcile.mjs` supplies the external exact
Node+Deno reconciliation/controller. S1 mechanics and S2 definitions survive.

**Candidate execution requires independently approved exact O/C/M and the
accepted design D; the external host also requires independent review.**
Locally computed hashes do not supply approval. Candidate-free mechanism
vectors and structural/parse-only checks are not registry substitutes or
product observations. Product acceptance requires actual authorized native
jobs and exact dual-runtime reconciliation, not mechanism PASS output.

## Capture

Supply every argument once, with absolute paths. The evidence parent must
already exist on durable storage. `--runtime` names the explicit native binary
(basename `node` or `deno`); there is no runtime/path/environment default.

```sh
node scripts/registry-oracle/capture.mjs \
  --mode mechanics \
  --runtime /absolute/path/to/node \
  --oracle /absolute/path/to/oracle.mjs \
  --oracle-sha256 "$EXTERNALLY_APPROVED_O" \
  --evidence-parent /absolute/durable/evidence-parent
```

Repeat with an explicit native Deno executable. Development hashing of one's
own oracle is useful for testing, **not independent approval**. Direct oracle
invocation does not authenticate its bytes and is not official evidence.

The host reads the oracle path once, checks O before any spawn, verifies its
exclusive `R/O/oracle.mjs` copy, and feeds that same buffer to interpreter stdin.
R is an exclusively allocated full UUID. A separate native identity probe and
the interpreter each have raw stdout/stderr plus byte hashes, exact executable
and argument lists, exit/signal and failure metadata in `host-envelope.json`.
No last-line selection, duplicate JSON keys, extra fields, banners or fabricated
terminal records are accepted. Only a mode-correct validated success, interpreter
exit zero, and successful evidence writes/readbacks produce host success.
Failures retain a host envelope where possible; failed writes cannot claim
retention. Host output contains no raw child diagnostics.

Limits are 10 seconds per child and 64 KiB per captured stream. Exceeding a
stream limit kills the child, retains its bounded prefix marked `truncated`,
and fails. These are mechanics capture limits, not product/archive budgets.
Retention means completed writes plus byte readback, **not crash/power-loss
durability**. The host and its native executable are trusted, not adversarially
confined. Node is **not sandboxed**. Children receive an empty environment;
Deno mechanics has no permission grants, prompting, config or lockfile. Candidate
jobs grant read only to the exact retained C/M capsules; no other grants. A
comma in a candidate evidence-parent path is refused rather than ambiguously
splitting Deno's permission list.

## Focused checks

```sh
ORACLE_S1_EVIDENCE_PARENT=/absolute/durable/development-parent \
ORACLE_S1_DENO=/absolute/path/to/deno \
node --test scripts/registry-oracle/mechanics.test.mjs
```

Tests allocate new UUID development paths. Tiny mock entries are explicitly
host-protocol adversaries, never registry substitutes. Expected failures include
crash, timeout, forged product outcome and evidence-file collision. The suite
also captures the actual oracle in both native runtimes. No Chrome, product
modules, dependencies, build or full repository suite are invoked.

The oracle calibrates SHA/base64/whole decoded import bytes (including BOM,
CRLF and non-ASCII), private assertion identity, genuine URL/encoder brands,
extracted methods and exact descriptor restoration. Observation is active only
around tiny exported controls. A 32-code-unit calibration ceiling distinguishes
whole encoding from bounded chunks/destinations; it is **not a registry byte
budget or pre-native-order proof**. Parser returns mean normal native returns,
including null/false; nested genuine parser delegation is counted. Every job
requires a fresh process: cached data-URL modules are not reused across jobs.

Local dependency: read-only `../lib/durable-root.mjs` (`isRamBacked`), checked on
the realpath of the explicitly supplied evidence parent. Its exact hash and
native runtime identities belong in each development delivery report.

## S2 catalogue (r5 §§4–6 only)

`CATALOGUE`, `BASELINE_LEAF_IDS`, `REQUIRED_EDGES`, `FAULT_IDS`, `BASE_RECORDS`,
`URL_DATA` and `GROUNDING` are deeply immutable definitions. The graph is pairs
of exact fault/check IDs, not mutation recipes or an equivalent-PASS policy.
`validateCatalogue`, `validateLeafIds` and `validateRequiredEdges` require exact
sets and relationships; duplicate, missing, sparse and unknown IDs refuse.

`buildFixture(checkId)` returns a fresh descriptor: actual helper, S/V/P/API
mode, complete input, independent raw expectation, input precondition facts,
and basis/pinned F citation where applicable. The closed data notation uses
literal bases with set/omit/own-proto/inherit edits and lazy URL expressions.
It never reads a subject result. Every materialization checks own data
construction, special prototypes and raw URL arithmetic; facts retain types,
own keys, prototype kind, UTF-16 length and raw UTF-8 length. `validateFixture`
checks a development descriptor against its definition, including undefined,
descriptors and inherited fields; it is **not** the future subject EQ predicate.
API58's null input means no argument fixture: its expectation describes only
the future namespace's own function export, with `subjectCall:false`.

Large strings allocate per requested leaf, not at import. EQ carries complete
shape/prototype obligations; TE describes a future genuine subject TypeError,
not a construction throw. Global MCP35 preserves own `__proto__` data; named55
strips it at all five depths (`55.map` plants the concrete B.reader). No global
marker-value filter, identity repair or normalization of subject output exists.

Standalone candidate-free development checks (no runtime grants or product I/O):

```sh
node scripts/registry-oracle/fixtures.test.mjs
deno run --no-prompt --no-config --no-lock --cached-only scripts/registry-oracle/fixtures.test.mjs
```

The test independently spells out every leaf and edge and constructs complete
literal input/expectation references. It checks freshness, descriptor/ownness,
identities/order, Unicode units, byte formulas, invalid sets and damaged data.
Its summary counts are derived: **238 leaves, 239 required edges, 59 fault IDs**.
This is author development evidence, not an official candidate job or review.
Rerun the unchanged S1 focused checks above after changing oracle bytes.

Pinned F is classification grounding only; no writer/HMAC population, full
structured-value, owning-graph admission or Chrome authority is claimed.
Scalar provider 10 MiB bytes and named 512 UTF-16 units remain distinct.

## S3 admission and execution (independent exact-object approval required)

Baseline capture adds these explicit arguments to the common host arguments:
`--mode baseline --design <absolute-D-path> --design-sha256 <D>
--candidate <absolute-C-path> --candidate-sha256 <C>
--manifest <absolute-M-path> --manifest-sha256 <M> --check-id <declared-leaf>`.
Mutation uses `--mode mutation` and additionally `--recipe-id <declared-recipe>`.
All arguments are required, unique and mode-specific. There are no ambient
paths, approval flags, count floors or equivalent-PASS outcomes.

D/O/C/M buffers are read once and authenticated before parsing/importing; exact
copies are verified under full-hash object directories. O alone is imported by
the host after authentication (never C). The child hashes the retained C/M
buffers before parsing M, applies patches to the original C bytes, checks UTF-8,
unique needle/offset, canonical base64 and pinned mutant digest, and imports
the verified same-buffer data URL. The host independently reconstructs patches
with Buffer search/concat and node:crypto. No candidate dependency or ambient
I/O approval is inferred from a token scan: independent exact-source/manifest
review remains a mandatory external prerequisite. A structurally valid manifest
is not proof that a comment patch introduces a semantic fault.

Every job has a fresh process. Native observers are installed and calibrated
before verified candidate import, so import-time cached bindings are observed.
After import, the fresh actual fixture and independent expectation are built
and validated with observation inactive; its policy is populated from that
actual fixture. Counters activate only around the one exported helper call
(API58 checks only its own function export). Raw EQ uses complete
data descriptors/keys, ordinary-or-null record prototypes, exact array
indices/order and scalars; it never invokes `validateFixture` on a result,
normalizes it, invokes getters or JSON-stringifies it for equality.

Private-origin attribution is independent of mutable exception names/messages.
A genuine subject `Error.isError` + captured `TypeError` is outcome data: a TE
leaf may accept it; an EQ over-rejection may generate a NEW private assertion
RED. Even a TypeError renamed `OracleAssertion` is not itself that assertion.
Ordinary Error/non-Error impostors crash, observer errors block setup, and a
wrong/unmarked predicate exception cannot earn credit. Counters are active
only around the subject; all changed native descriptors restore in finally.

P policy (coord seq108 / supervisor adjudication): whole encode violates when
its input code-unit length is at least the oversized raw fixture's length
(including the exact raw scalar); encodeInto violates when its destination
exceeds the owning raw-byte bound. For named provider baseURL, the whole-input
trigger is length >512 **UTF-16 units**, not >512 bytes. Its encodeInto destination
budget is the provider-derived **10 MiB bytes** (coord seq151), not512 bytes;
MCP retains65536 bytes and other provider contexts retain10 MiB bytes. Whole
encoding of the named-over input still violates even below10 MiB raw bytes.
Smaller chunks/bounded destinations are allowed, without a universal chunk
constant. Malformed URL/transport identity,
String and JSON serialization forms are prepared outside observation and
matched at encoder consumption; all covered parser calls already violate P.
These are observed surfaces, not a claim about every possible heap allocation.
S1's calibration ceiling remains 32 only in mechanics mode; actual Node/Deno
nested URL delegation counters are retained, not forced equal.

`reconcile(authority, receipts)` in `reconcile.mjs` takes explicit objects:
`authority = {design, oracle, candidate, manifest}`, each `{path, sha256}`;
`receipts = [{path, sha256}]` pins the capturer's retained host-envelope bytes.
References must come from the trusted capturer, not an evidence-directory scan.
It verifies capsule/raw-capture bytes, process exits/signals/truncation, exact
launch arguments, host/terminal identities, unique run IDs, stable actual
runtime identities and the exact baseline/job/required-edge sets in BOTH Node
and Deno. Shared mutant/check observations explicitly substantiate their
multiple edges. It reports baseline observations, unique mutant hashes and
caught edges separately. It never fabricates a child terminal after a crash.

`runMatrix(authority, {node, deno}, evidenceParent)` performs candidate-free
mechanics first, then sequential fresh processes for the derived jobs, and
writes/read-verifies an exclusive reconciliation result. It is not authorized
to run until independent D/O/C/M approval exists. Captures are preserved on
failure. Authentication of receipt references is external; a party that can
fabricate trusted reference hashes is outside this host's trust boundary.

Additional candidate-free development checks:

```sh
node scripts/registry-oracle/execution.test.mjs
deno run --no-prompt --no-config --no-lock --cached-only scripts/registry-oracle/execution.test.mjs
ORACLE_S1_EVIDENCE_PARENT=/absolute/durable/development-parent \
node --test scripts/registry-oracle/reconcile.test.mjs
```

`execution.test.mjs` tests literal byte patches, closed manifest structure,
actual negative predicate calls, TypeError/private-origin separation, named
unit/raw-byte bounds and malformed coercion. Its setup-order guard is source-only
conformance, not runtime product proof. Its comment patches are explicitly invalid
semantic recipes, not candidate-specific manifests. `reconcile.test.mjs`
tests synthetic terminal sets and retained-capture tampering, plus real host
refusal before child launch for missing/invalid authority. Synthetic terminal
vectors never constitute product evidence. Full candidate import/recipes require
independent exact-object approval; end-to-end acceptance requires their actual
authorized observations, not these development checks.

