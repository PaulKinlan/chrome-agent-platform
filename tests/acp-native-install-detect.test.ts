// tests/acp-native-install-detect.test.ts — chrome-agent-platform-6lvbx.
//
// detectExtensionId matched the loaded unpacked extension's profile path with
// a RAW STRING PREFIX (`ROOT.startsWith(p)`, no separator boundary), so a
// hostile unpacked extension whose source dir is a string prefix of the repo
// (`/repo/bu` for `/repo/build`), an ANCESTOR of it (`/repo`), the root
// itself, or a `..` traversal all matched — and the FIRST such match's id
// became the ONLY allowed_origin of the native-messaging manifest for
// com.chrome_agent_platform.acp, whose host is a shell-capable process Chrome
// launches on demand.
//
// The containment rule (coord ruling on the bead): path.relative(root, p)
// must be a genuine child — empty, `..`-prefixed and absolute results refuse.
// The fixtures below put the HOSTILE entries FIRST: if the check reverts to
// bare startsWith, the hostile id wins and these tests fail. The mutation
// falsifier (revert to `ROOT.startsWith(p)`) is the RED/GREEN proof.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { detectExtensionIdInSettings } from "../scripts/acp-native-install.mjs";

const CHILD = "/repo/build/extension";
const ROOT_DIR = "/repo/build";
const ID_OK = "a".repeat(32);        // [a-p]{32} — the genuine extension
const ID_ANCESTOR = "b".repeat(32);  // hostile: an ancestor of the repo root
const ID_SIBLING = "c".repeat(32);   // hostile: a string-prefix sibling dir
const ID_TRAVERSAL = "d".repeat(32); // hostile: .. traversal spelling
const ID_ROOT = "e".repeat(32);      // hostile: the repo root itself

// Hostile entries FIRST — the first match wins, so a bare startsWith reverts
// to granting a hostile id and every assertion below goes red.
const HOSTILE_FIRST_SETTINGS = [
  {
    [ID_ANCESTOR]: { path: "/repo" },
    [ID_SIBLING]: { path: "/repo/bu" },
    [ID_TRAVERSAL]: { path: "/repo/build/../elsewhere" },
    [ID_ROOT]: { path: ROOT_DIR },
    [ID_OK]: { path: CHILD },
  },
];

Deno.test("acp-native-install: a genuine child of the repo root is detected", () => {
  assertEquals(detectExtensionIdInSettings([{ [ID_OK]: { path: CHILD } }], ROOT_DIR), ID_OK);
});

Deno.test("acp-native-install: sibling, ancestor, traversal and root-as-path are all refused (6lvbx)", () => {
  // Every hostile id is present and first; only the genuine child may win.
  assertEquals(detectExtensionIdInSettings(HOSTILE_FIRST_SETTINGS, ROOT_DIR), ID_OK);
  // Each hostile alone must yield NOTHING — not "the next entry wins". The
  // hostile id here is a well-formed 32-char [a-p] id, so ONLY the containment
  // rule stands between it and a grant.
  const hostileId = "f".repeat(32);
  for (const path of ["/repo", "/repo/bu", "/repo/build/../elsewhere", ROOT_DIR, ""]) {
    assertEquals(detectExtensionIdInSettings([{ [hostileId]: { path } }], ROOT_DIR), "",
      `a hostile/meaningless path must not detect an id: ${JSON.stringify(path)}`);
  }
});

Deno.test("acp-native-install: later profiles are still consulted after refusals", () => {
  const settings = [
    { [ID_SIBLING]: { path: "/repo/bu" } },                    // refused: prefix sibling
    { [ID_OK]: { path: CHILD } },                              // genuine, in a later profile
  ];
  assertEquals(detectExtensionIdInSettings(settings, ROOT_DIR), ID_OK);
});

Deno.test("acp-native-install: malformed ids and relative paths never match", () => {
  const settings = [
    { "zzzz": { path: CHILD } },                                // wrong id shape
    { [ID_OK]: { path: "extension" } },                         // relative path: not a child proof
  ];
  assertEquals(detectExtensionIdInSettings(settings, ROOT_DIR), "");
});
