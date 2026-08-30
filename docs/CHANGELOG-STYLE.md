# Changelog style

- An entry states the user-visible change, in plain language a non-engineer can read.
- No git SHAs, commit subjects, or "merge:" lines.
- No gate names or internal vocabularies: journeys, KAT, CDP, harness, worktree, lane, tracker, splice, RED/GREEN.
- Internal bookkeeping ("Tracker: … recorded as landed") belongs nowhere in the user-facing recent entries — fold it into the plain statement or drop it.
- The last ten versions are enforced user-facing by `scripts/check-changelog.mjs` and `tests/changelog.test.ts`; the renderer filters the same way (options.js `isUserFacingEntry`).
