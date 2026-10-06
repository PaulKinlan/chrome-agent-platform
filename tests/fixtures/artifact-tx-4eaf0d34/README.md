# FROZEN fixture: artifact-tx @ 4eaf0d34

These three modules are **frozen witnesses** pinned to commit
`4eaf0d348decccf0eb89bc96b1c7a2cf88b3a6b6` ("fix(artifact-tx): REJECT-4 —
per-key absence authority + update-recovery + bounded repair") of
chrome-agent-platform, vendored byte-for-byte from `extension/lib/`:

- `memory.js` — OPFS master/site memory (WAL authority, CAS, tombstones)
- `artifacts.js` — artifact transaction layer (imports `./memory.js`)
- `kv.js` — kv helper imported by `memory.js`

They exist here so `tests/review49-regression.test.ts` does not import from a
worktree path outside this repo. Deleting or renaming that worktree used to
break the whole suite (it happened once with a /tmp predecessor); with the
fixtures in-repo the regression suite has no external dependency.

**Rules — do not violate:**

1. **Never update these files in place.** They are frozen at the pinned
   commit's exact bytes; the regression tests assert against THIS vintage's
   shapes and behaviors. The single documented exception is the rewritten
   comment line below, which landed with the vendoring and changes no code.
2. If the pinned behaviors need re-witnessing at a newer commit, make a NEW
   fixture directory named for that commit (e.g.
   `artifact-tx-<short-sha>/`) and repoint the test explicitly — never edit
   this one.
3. Import specifiers inside the files (`./kv.js`, `./memory.js`) are
   relative within this directory exactly as they were in `extension/lib/`.

## The one non-byte-identical line: a comment, scrubbed by the repo's own hard rule

`memory.js` carries one re-worded **comment** line. The pinned commit predates
the scrub of the owner's earlier project name from code comments, and that
scrub is a hard rule in AGENTS.md, enforced across every tracked
`.js`/`.mjs`/`.ts` file by `tests/docs-process-truth.test.ts` ("i6n6: no tracked
code files name the owner's other project"). Vendoring the line verbatim
reddens that guard on every machine, so the frozen copy carries the rewording
the repo already landed on the live file — byte-for-byte the change in commit
`08679472` (`git show 08679472 -- extension/lib/memory.js` prints the two lines,
exact, for anyone who wants to compare):

```
- * (the <earlier-project>-style per-agent sandbox). `id` is the agent's slug; the
+ * (the per-agent sandbox pattern). `id` is the agent's slug; the
```

Comment-only: no statement, identifier, or literal differs, and
`tests/review49-regression.test.ts` is the proof that the behaviour is the
pinned behaviour (all nine probes, plus the mutants that kill them).

Digests at vendoring (`4eaf0d34` bytes, before the comment scrub) and in-tree
today:

```
                   pinned 4eaf0d34 bytes                     in-tree today
memory.js    52a6601c91282087e61d1db166fa26a9312598a6a3e1856bdc6a61b05d2b0e17  46146e695f705e5df6f28580e4cb75490af95628d44f460af494f67461d9ac87
artifacts.js 78d18bf07f3d03ec36d16ac5dd5c7c72b07be8e7615a4dff7f606db48637dfe3  78d18bf07f3d03ec36d16ac5dd5c7c72b07be8e7615a4dff7f606db48637dfe3
kv.js        3042f3b358e111265835146d99b3725f254fe1c564a567959c553494a9c1cc7e  3042f3b358e111265835146d99b3725f254fe1c564a567959c553494a9c1cc7e
```
