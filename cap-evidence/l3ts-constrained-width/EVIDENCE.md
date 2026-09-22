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

## Before → after, same harness, same seeded content

| Observable | `before-baseline.json` | `after-fixed.json` |
|---|---|---|
| hub grid at 1440px | `[198.156px 689.844px]` | `[444px 444px]` |
| hub grid at 1100px | `[116.359px 689.844px]` | `[389px 389px]` |
| Agents box width at 1100px | 116px | 389px |
| `.main-wrap` overflow at 1100px | 4px | 0px |
| Jobs board padding | `4px 0px` | `12px 14px` |
| Jobs board vs its own header inset | 4px vs 12px 14px | 12px 14px vs 12px 14px |
| harness chips at a 260px panel | no mark; long name wraps | mark present; label clipped |
| checks passed / failed | 24 / 11 | 42 / 0 |

**The culprit, named by measurement.** A grid child's automatic minimum size is
its content, so one long unbreakable token in a board row held the Jobs track at
690px no matter how little room was left. The wide-layout override used plain
`1fr 1fr` while the base rule beside it already used `minmax(0, 1fr)`; the
override now matches the base rule.

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
min-content contribution. Conflating the two named the wrong culprit
(`.jb-excerpt`) on the first pass.

## Mutations — proving the checks can fail

| Mutant | Result |
|---|---|
| **M7** — both `minmax(0, 1fr)` forms removed from the wide override | **RED**: grid `[116.359px 717.844px]`, overflow 32px |
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
