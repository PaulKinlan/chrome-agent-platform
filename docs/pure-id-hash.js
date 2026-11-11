// lib/pure-id-hash.js — a RE-EXPORTING FACADE over the canonical homes of the
// two ID/HASH symbols FAT importers reach (chrome-agent-platform-gzkmx hash
// half, flipped per the single-source invariant: tests/single-source-helpers
// pins fnv1a to lib/pure-hash.js and newId to lib/pure-text.js as the ONLY
// definition sites — duplicated definitions drift). memory.js imports THIS
// module, so it depends on one narrow surface instead of two seams; the file
// defines nothing.
export { fnv1a } from "./pure-hash.js";
export { newId } from "./pure-text.js";
