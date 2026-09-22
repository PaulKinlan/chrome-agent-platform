# The harness agent badges — where they came from and why they look like that

**No third-party artwork is vendored here.** Every badge in
`extension/shared/harness-marks.js` is drawn in this repository, from the
frame in that file. Nothing was copied from Anthropic, OpenAI or any other
vendor, and no licence is being relied on for anyone else's mark.

## Why not the real product logos

The three agents these badges identify are:

| Agent | Owner | Its mark |
|---|---|---|
| Claude Code | Anthropic | a trademark; no redistribution licence published |
| Codex | OpenAI | a trademark; no redistribution licence published |
| pi | this machine's own CLI | no published mark |

Both trademarks are used to refer to the vendors' products, and pointing at a
product by name is fine. **Redistributing the vendors' artwork inside a
distributed extension is a different act**, and neither vendor publishes a
licence that permits it. Drawing something visually close enough to pass for
the real mark is worse than not having one: it ships a convincing fake of
somebody else's brand into every install, and a user cannot tell it apart from
the genuine article.

So each agent gets a neutral badge of our own: the same outlined frame for all
of them, carrying a letterform taken from the product's own name. The set reads
as a set — which is the point, since these sit side by side — and each one is
distinguishable at a glance in a narrow panel.

The identity is never carried by the badge alone. Every button keeps the agent's
real name as its accessible name (`Open the Claude Code harness conversation`),
and the visible label is shown whenever the panel is wide enough for it.

## Swapping in a real mark

If a vendor grants permission to redistribute its mark, replace the entry for
that agent in `HARNESS_MARK` and keep the same frame contract: a leading
`<svg viewBox="…">`, `currentColor` rather than a hard-coded colour, and
`aria-hidden="true"` with the name supplied by the button's accessible name.
Preserve the mark's own aspect ratio and clear space, and record the licence
grant here in the same change. Do not add a second icon module — the map is the
one place these live.

## What this file is not

It is not a legal opinion about any vendor's terms, and it is not permission to
use anyone's mark. It records the decision that was made, the reason, and the
one place to change it.
