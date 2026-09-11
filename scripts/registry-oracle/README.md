# Registry oracle — S1 development mechanics only

`capture.mjs` is a native-Node external host. `oracle.mjs` is a self-contained,
read-only Node/Deno stdin ES module. Neither implements registry checks.
Candidate, manifest, design, baseline, mutation, recipe and check arguments are
refused. There is **zero baseline/mutation credit** and no reconciliation.
Independent approval of these exact objects is still required.

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
terminal records are accepted. Only a validated `MECHANICS_PASS`, interpreter
exit zero, and successful evidence writes/readbacks produce host success.
Failures retain a host envelope where possible; failed writes cannot claim
retention. Host output contains no raw child diagnostics.

Limits are 10 seconds per child and 64 KiB per captured stream. Exceeding a
stream limit kills the child, retains its bounded prefix marked `truncated`,
and fails. These are mechanics capture limits, not product/archive budgets.
Retention means completed writes plus byte readback, **not crash/power-loss
durability**. The host and its native executable are trusted, not adversarially
confined. Node is **not sandboxed**. Children receive an empty environment;
Deno additionally has no permission grants, prompting, config or lockfile.

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
