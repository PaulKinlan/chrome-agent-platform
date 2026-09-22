# Constrained-width layout — the measurements behind the fix

Owner report, in his words: *"when the sidepanel is collapsed it compresses the
harness buttons and makes it look weird"* and *"The Jobs board has padding issues
for the content inside it. Also it overflows and pushes the Agents box off the
side too."*

`cap-evidence/constrained-width-layout.ts` drives the built extension in headless
Chrome and reads **geometry**, never appearance — the operator cannot see images,
so nothing here is judged by eye. Run it with:

```
deno run -A cap-evidence/constrained-width-layout.ts
```

## Before → after, **re-measured on one driver revision**

Both columns below were produced by **this** revision of the driver, back to back
on the same box, so they are like-for-like. Earlier revisions of this file quoted
`24 / 11` over 35 checks against `42 / 0` over 42 checks, which were **different
driver revisions and not a comparison at all**. Run each side with:

```
CAP_ACCEPTANCE_EXT=<the base extension build> deno run -A cap-evidence/constrained-width-layout.ts
```

| Observable | base `3091eaba` | fixed `e72ca133` |
|---|---|---|
| hub grid at 1440px | `198.156px 689.844px` | `444px 444px` |
| hub grid at 1280px | `198.156px 689.844px` | `444px 444px` |
| hub grid at 1100px | `116.359px 689.844px` | `389px 389px` |
| hub grid at 900px | `602px` (single column) | `602px` (single column) |
| Jobs / Agents column widths at 1100px | 690px / 116px | 389px / 389px |
| `.main-wrap` overflow at 1100px | 4px | 0px |
| deepest min-content inside the Jobs column | 684px (`span.jb-excerpt`) | 684px (`span.jb-excerpt`) |
| Jobs board padding | `4px 0px` | `12px 14px` |
| panel-head padding (the inset to match) | `12px 14px` | `12px 14px` |
| harness chips at a 260px panel (width / label clipped) | 32, 95, 58 / no, no, no | 34, 34, 34 / yes, yes, yes |
| harness chips at a 400px panel | 32, 95, 58 / no, no, no | 54, 117, 80 / no, no, no |
| checks passed / failed | **34 / 12** | **46 / 0** |

**The figures are environment-sensitive to about ±4px and the direction is not.**
The base 1440px split is `198.156 / 689.844` here — reproducing the original
author's figure exactly — while the independent reviewer measured
`202.156 / 685.844` on its own box. Both total 888px and the 4px is redistributed
between the tracks. Likewise the 1100px overflow is 4px here (again matching the
author) and was 0px for the reviewer. So the sub-pixel split above is one box's
rounding, not a stable property; **the load-bearing quantities are the ones that
move by hundreds of pixels** — the 690 → 389 column, the 198 → 444 Agents box,
and the 4px → 0px overflow which is the reported defect itself.

**A hypothesis for the 4px, recorded as a hypothesis and not as established.** The
arithmetic closes on a single quantity. Both box totals are exactly 888px, and the
Jobs track is the deepest min-content plus 5.844px: this box's `689.844` implies a
`684.000px` min-content, and the reviewer's `685.844` implies `680.000px` — one 4px
difference in a text measurement, redistributed to the other track. The reviewer's
suggested cause is that `span.jb-excerpt` **declares no `font-family`**: its rule
(`extension/shared/components.js:11685`) sets `font-size:12px` and nothing else
about the face, and no `font-family` appears anywhere in `<jobs-board>`'s own
styles, so the computed face is inherited and the advance width of the same string
can differ between boxes by exactly this order. **That is consistent with the
measurements and is NOT proven by them** — it was measured on one box, and
confirming it would take the same page on two boxes with the face pinned versus
inherited. It does not need resolving to land the fix: the direction and the
hundreds-of-pixels quantities are stable, and this is a 4px ambiguity inside a
defect that was 300px wide.

**The culprit, named by measurement.** A grid child's automatic minimum size is
its content, so one long single-line element in a board row — `span.jb-excerpt`,
684px of min-content — held the Jobs track at 690px no matter how little room was
left. The wide-layout override used plain `1fr 1fr` while the base rule beside it
already used `minmax(0, 1fr)`; the override now matches the base rule.

Note what the fix does **not** do: `span.jb-excerpt` still has a 684px min-content
on the fixed tree, byte for byte the same element. The column simply stops growing
to accommodate it. That distinction is the difference between a check that means
something and one that does not — see fault 5 below.

## The three instrument faults found while measuring

Each of these made a check report something that was not true, and each was
found by disbelieving a green result:

1. **A hidden tabpanel measures 0×0.** The first side-panel probe read every
   harness chip as `w=0 h=0` because the Agents tabpanel starts `hidden`, so
   every "does not overflow" check passed on geometry that did not exist. The
   driver now switches to the Agents tab and asserts the geometry is non-zero
   before judging it.
2. **An empty board cannot reproduce an overflow.** The hub probe reported zero
   overflow at every width until the board was seeded with realistically long
   content. A fresh profile's board is empty, so the defect is invisible there.
   The seed goes through the component's own public `jobs` setter.
3. **`Range.getClientRects()` counts a clipped line twice.** It reported two line
   boxes for an ellipsised single-line chip. The real observable is the chip's
   height against a computed single-line height — which is what the check uses.

A fourth, subtler one: `scrollWidth` at `width: 0` is **not** an element's
min-content contribution for the *conclusion*, and the first pass drew the wrong
one from it. The instrument was right — `span.jb-excerpt` **is** the element with
the largest min-content in the Jobs column (684px, and it is 684px on both trees,
unchanged by the fix, because the fix changes the track rule and not the element).
What was wrong was inferring that the element therefore needed changing. The
defect was in the grid track rule, and the element was only its victim.

A fifth, and the one that mattered most: **a check that could not fail.** The
check `"hub: nothing inside the Jobs column holds the grid track open"` was
`(pad1440.shrinkHolders || []).every((o) => o.minContent <= 320)`, written on
`shrinkHolders`, a plain `jobs.querySelectorAll('*')` walk. `<jobs-board>` renders
its rows into a **shadow root**, so that walk never saw the rows. It passed on the
base tree, where the defect is real and reproduced by twelve other checks.

**It failed to fail for two different reasons, and the distinction is worth
keeping because the wrong version gets reused.** An earlier draft of this file
said the list was "empty in every state". That is wrong, and this branch's own
artifact contradicts it: in `before-baseline.json`, taken on the base at all four
hub widths, `shrinkHolders` holds **2 entries, both at 178px** — `div#jobs-board-host`
and `<jobs-board>`, neither of them a row. So:

- on the **base**, the list was *not* empty: 2 entries, and `178 <= 320` satisfied
  the assertion, so the check passed with the defect reproducing in twelve others;
- on the **fixed tree**, the list is `[]`, and `.every()` on an empty list is `true`.

A non-emptiness guard alone would **not** have fixed this check. Such a guard is
satisfied by those 2 entries, and the assertion is satisfied by their 178px. The
emptiness is a *symptom* of the same root cause: the walk cannot cross the shadow
root, so the 684px element that actually holds the track open was never in the
list at all. The guard is still worth having — it names the failure loudly instead
of silently — but the property had to move to an instrument that can see the rows.

The instrument that *does* cross the shadow root (`deepMinContent`) was already in
the file, computed and printed, and **asserted on by nothing**. Both halves of that
are now fixed and pinned: the check asserts containment through the shadow-crossing
instrument, and a non-vacuity guard fails loudly if the probe finds nothing.

## What the two new checks assert, and why they are not vacuous

**The Jobs column is not sized by its content's min-content.** Measured as the
deepest min-content found *inside* the column (crossing the shadow root) exceeding
the column's own width — which is only reachable through `minmax(0, 1fr)`.

| Tree | deepest min-content | Jobs column | verdict |
|---|---|---|---|
| base `3091eaba` | 684px | 690px — sized **by** it | **RED** |
| M7 (override reverted to `1fr 1fr`) | 684px | 714px — sized **by** it | **RED** |
| fixed `e72ca133` | 684px | 444px — constrains it | green |

A probe that finds nothing measures 0, and `0 > width` is false, so this fails
**closed** rather than passing on an empty list. The separate non-vacuity guard
names *why* when that happens.

**The collapsed rule fires.** Asserted in both directions: the label is clipped at
260px and 300px (the `@container` rule fires) and **not** clipped at 400px (there is
room, so it must not). This is the half that only the container query can produce —
every other chip check is satisfied by `white-space: nowrap` alone, which is why
they were green with the rule dead.

| Tree | chip at 260px | old chip checks | new collapsed-rule check |
|---|---|---|---|
| base `3091eaba` | 32px, label visible, no mark | — | **RED** at 260 and 300 |
| M4 (`container-type` removed from `#agents-view`) | 54px, label visible | **all PASS** | **RED** at 260 and 300 |
| fixed `e72ca133` | 34px, label clipped | green | green |

M4 is the whole point: the chip visibly grows 34px → 54px and **every** pre-existing
chip check stays green. `#page-view` carries `container-type` but is a *sibling* of
`#agents-view`, not an ancestor of the chips, so removing it from `#agents-view`
leaves the chips with no container context at all and the rule can never match.

## Mutations — proving the checks can fail

| Mutant | Result |
|---|---|
| **M7** — both `minmax(0, 1fr)` forms removed from the wide override | **RED**: grid `[174.156px 713.844px]`, and the new containment check red (684px min-content vs a 714px column) |
| **M4** — `container-type` removed from `#agents-view` | **RED** on the new collapsed-rule check at 260/300px, **green on every pre-existing chip check** with the chip 34px → 54px |
| **M3** — `white-space:nowrap` removed from the harness chip | **RED**: chip wraps to 2 lines, 51px vs a 31px single-line height |
| **M1** — the grid-child `min-width: 0` removed | **SURVIVED** → that line was dropped as redundant rather than kept and credited |

M1 is recorded because it is the useful result: the fix the guidance predicted
(`min-width: 0` on the grid child) turned out not to be load-bearing here, and
shipping a redundant line as though it were the fix would have been a claim the
evidence does not support.

## Not covered

- **Only three agents are registered** in this environment (pi, Claude Code,
  Codex), so the chip layout is measured for three. More chips wrap onto further
  rows — untested.
- **The real side-panel width** is a user drag; the driver emulates viewports of
  260/300/400px, which is the range a dragged-in panel reaches, not the panel
  itself.
- **No vendor logo is redistributed** — see `docs/HARNESS-MARKS-PROVENANCE.md`
  for why the badges are our own and where to swap in a licensed mark.
