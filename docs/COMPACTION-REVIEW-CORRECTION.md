# Compaction review correction (r48z)

The 2026-09-07 budget review did not establish 23,786 bytes of whole-module
savings, runtime equivalence of its example, or a passing unit suite with that
example installed. Those claims are withdrawn. This correction measures complete
historical exports in a separate experiment; it changes no generated module,
production generator, build option, dependency, or 3,000,000-byte Store budget.

## What the old number measured

Original review SHA-256:
`f7ce8cde5e2910e0529c3224b41f32d830049a7e180d0769aeaf8c21f6705e05`.
Its later, previously corrected version was 19,931 bytes, SHA-256
`3eb2ee3c5ff2596e5f328816d5f44ed6211a40be7a24ecf43c4bcb870aaaaa36`.
Both originals are preserved; the live review receives an append-only correction.

The author acknowledged that **3,847 bytes covered manifests only**, whereas
20,686 described the whole inventory module. The example omitted `files`,
`evidence`, and `revocations`, invented `path`/`file` manifest columns, and froze
nested arrays/rows that were previously mutable. Its subtraction of 16,839 bytes
therefore did not measure an equivalent whole-module replacement. Adding the
claimed 6,947 package bytes to obtain 23,786 did not repair that mismatch.

The actual inventory input has seven ordered root keys:
`schemaVersion`, `release`, `signer`, `manifests`, `files`, `evidence`,
`revocations`. Its 36 manifest rows have only `pkg`, `version`, `digest`; its
103 file rows have `rel`, `sha256`, `size`. Both empty root arrays are present
and distinct. Only the root object is frozen.

## Why the earlier errata still need limits

The retained exploratory directory contains three summary JSON files and a scope
README, but no original executable encoder, transformed outputs, exact minifier
options/argv, or native output/exit record. Equality booleans in those summaries
are not a replayable whole-object comparison.

The surviving records disagree:

| Claim | Earlier errata | Later JSON summary |
|---|---:|---:|
| Compact package module, minified | 34,719 | 34,736 |
| Package saving | 6,771 | 6,754 |
| Combined data saving | 9,002 | 8,985 |
| Arithmetic shortfall against the old 9,495 deficit | 493 | 510 |
| Standalone syntax baseline | 2,993,779 | 2,993,802 |
| Standalone syntax result | 2,972,597 | 2,972,620 |

**The retained evidence cannot settle these differences.** The syntax pairs both
subtract to 21,182, but matching differences do not establish identical inputs or
invocations. No more favourable number is adopted. The 21,182 syntax claim and
30,184 combined forecast are not canonical Store measurements. Finding two
`new Function` spellings also cannot prove complete evaluator scrubbing.

The old input sizes 24,650 and 49,358 were UTF-16 string lengths, not UTF-8 bytes:
the retained files contain **24,652** and **49,362 bytes**, respectively. The
package input's sole `callexport` property occurs at **zero-based index 28**
(`hash_blake3`), not index 17 as the earlier errata said.

The statement that all existing unit tests passed with compaction installed was
an unexecuted projection, already admitted by the review author. Neither the old
summary files nor this correction establishes such a run.

## New bounded measurement, 2026-09-11

This is a **new experiment**, not a reconstruction of the missing historical
encoder. Its exact input modules are:

| Module | SHA-256 | UTF-8 bytes |
|---|---|---:|
| Inventory | `cca007b044218cb00652bb5678bf73a8e5d0d53c64b8c00f4f14ecb01c7361ca` | 24,652 |
| Package rows | `91c5b1e9c1cfc83e7a232c1876c4cf917a1f130517be35982067e6fb56168d06` | 49,362 |

The package bytes also match the committed module at
`50c37850fdf4ae0cb4286476e4feee5887ecf7cc`.

Native Node 26.2.0 and esbuild **0.25.12** were used, with these exact standalone
`transform` options for both original and compacted whole modules:

```js
{ loader: 'js', target: 'chrome120', format: 'esm', minify: true,
  legalComments: 'none' }
```

| Complete module | Original minified bytes | Compact minified bytes | Standalone saving |
|---|---:|---:|---:|
| Inventory | 20,694 | 18,449 | 2,245 |
| Package rows | 41,498 | 34,523 | 6,975 |
| Sum of these separate outputs | 62,192 | 52,972 | **9,220** |

Every number is a UTF-8 byte length of a retained output. The old original sizes
20,686/41,490 do not match this invocation's 20,694/41,498; the historical options
were not retained, so these are labelled separately rather than presented as the
same run. This experiment is one concrete encoding, not an optimality claim.

The inventory encoder reconstructs both tables and retains every other root
field. The package encoder iterates each tuple's actual length, preserving
absence of `callexport` on the other 35 rows instead of adding an undefined key.
Neither encoder freezes rows or shares previously distinct nested objects.

### What equivalence was checked

The original module namespaces were compared with the compact namespaces and
with **both actual minified outputs**: six complete graph comparisons. At every
object/array they assert ordered `Reflect.ownKeys`, all primitive values,
data-property descriptor kind/flags, exact native prototype identity,
frozen/sealed/extensible state, and bidirectional reference correspondence.
The inventory comparison therefore includes every file path/hash/size and both
empty arrays, not just the manifest table. Namespace export names are also
checked. Detailed node records and the executable checker are retained.

Ten deliberate mismatches were rejected by their named assertions: missing files,
a changed file hash, an invented manifest column, reordered root keys, added
nested freezing, changed writability, changed prototype, collapsed empty-array
identities, optional-key pollution, and loss of a shared reference in a checker
control. These establish that the compared axes can fail, rather than relying on
JSON equality or a test name.

This establishes export-graph equivalence for **these exact static modules in
this native runtime**, including their mutability and aliasing structure. It does
not establish universal runtime equivalence, unchanged module-initialization
cost, behavior under patched built-ins, or compatibility of an unimplemented
production generator. No product unit suite was run with compacted modules
installed.

## Replay and evidence

Durable evidence directory: `$HOME/cap-evidence/astra/r48z-correction-20260911/`.
It contains `measure.mjs`, both pinned inputs, `measure.stdout`, `measure.stderr`,
`measure.exit`, and `measurement/` with `invocation.json`, eight source/output
files, six detailed graph comparisons, `checker-controls.json`,
`input-shapes.json`, and `summary.json`. Original review versions and the initial
bead record are preserved beside them. The latter records the prior coordinator
approval; it is not presented as a recovered raw transcript of that approval.

Run the retained script with an explicit esbuild 0.25.12 entry, the input
directory, and a **new, nonexistent output directory**:

```sh
node measure.mjs /absolute/path/to/esbuild/lib/main.js \
  /absolute/path/to/r48z-correction-20260911 /absolute/path/to/new-output
```

The script verifies input hashes, refuses to overwrite a run, writes actual
outputs, compares their exports, runs the ten negative controls, and exits
nonzero on a failed assertion. The exact invocation used is in `invocation.json`.

## Integrated savings remain unmeasured

Do not subtract 9,220 from a Store bundle or add it to the historical syntax
number. Separate module transforms do not establish their contribution after
bundling, tree shaking, evaluator removal and final minification. No production
compaction, regeneration, Store build comparison, or shared-checkout gate was
performed for this correction; **ycez is not cleared by it**.

Establishing actual Store savings requires a separately authorized production
change on an exact source baseline, reproducible before/after canonical Store
outputs with unchanged evaluator checks and budget, whole-export comparisons of
the generated modules, and the repository's full tests and relevant behavior
gates. Until then, 9,220 is only the measured saving in these two standalone
experimental outputs.

## Independent review reference

Independent review of this correction was completed on 2026-09-11 by `glm-flash-1`
(`glm-5.3-flash`), discharging the pending review marker from §8 of the historical
review addendum:

1. **Measurement review (PASS)**: Verified by independent byte-identical replay
   (`measure.mjs` against pinned esbuild 0.25.12 and exact historical inputs
   `cca007b0` and `91c5b1e9`), reproducing all output hashes, counts, 6
   object-graph records, and `checker-controls.json`. Confirmed 20,694 and 41,498
   bytes on plain esbuild, establishing non-reproducibility of the old 20,686 and
   41,490 numbers. Object-graph axes verified at code level across prototype
   equality, `Reflect.ownKeys` ordering, descriptor flags, and bidirectional
   reference correspondence.
2. **Prose review (PASS)**: Verified prefix preservation of the historical review
   in evidence (first 19,931 bytes hash to `3eb2ee3c…`; corrected file 23,623
   bytes / `edf415dd`). Confirmed all numerical citations, errata discrepancies
   (2,231 vs 2,245; 6,754 vs 6,975; 8,985 vs 9,220; callexport index 28 vs 17),
   and scope disclaimers (standalone-only, `ycez` not cleared, no production
   code/generator/budget changes).

