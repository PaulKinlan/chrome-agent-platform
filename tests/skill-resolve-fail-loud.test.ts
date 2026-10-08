// @ts-nocheck
// tests/skill-resolve-fail-loud.test.ts — chrome-agent-platform-5xo59.
//
// A fatal skill-store READ failure (corrupt DB, permission, quota) must
// PROPAGATE out of the resolver instead of being swallowed into an empty/partial
// skill set that lets the run continue without a skill the user believes is
// installed. The propagated error must NAME THE STORE AND THE CAUSE, and a
// genuinely ABSENT optional skill must stay a normal empty result — not a crash.
//
// RED→GREEN: restore any of the `.catch(() => [])` swallows (or the file-read
// `catch { return { ...base, prompt: "" } }`) in extension/lib/skill-resolve.js
// and the matching test below fails, because the rejection is converted back to
// an empty set and resolveSkillRef resolves (or returns prompt:"") instead of
// rejecting with the named store/cause.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { resolveSkillRef, createMemoizedSkillStores } from "../extension/lib/skill-resolve.js";

/** A DOMException-shaped rejection — what OPFS actually throws for quota /
 * permission / not-found, so the fixture drives a REAL failure shape (a `name`
 * and `message`) rather than a bare `new Error()`. */
function domException(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

/**
 * Build resolver stores whose reads REJECT like a corrupt / permission-blocked
 * store. Absence is modelled by the stores RESOLVING to an empty array (no
 * `fail*`); a READ failure is modelled by the store REJECTING (`fail*` set).
 */
function failingStore({ failCustom = null, failImported = null, failFile = null, custom = [], imported = [] } = {}) {
  return {
    getSkill: () => undefined,
    getCustomSkills: async () => {
      if (failCustom) throw failCustom;
      return custom;
    },
    loadAllImported: async () => {
      if (failImported) throw failImported;
      return imported;
    },
    readSkillFile: async (id, path) => {
      if (failFile) throw failFile;
      return `body of ${id}`;
    },
  };
}

/** Assert a resolver promise rejects with a named store + named cause. */
async function expectStoreReadFailure(promise, store, causeMessage, causeCode) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert(err, `expected the ${store} read to REJECT (fail loud), but it resolved`);
  assertEquals(err.store, store, `error.store must name the store`);
  assert(String(err.message).includes(store), `message must name the store: ${err.message}`);
  assert(String(err.message).includes(causeMessage), `message must carry the cause message: ${err.message}`);
  assert(String(err.message).includes(causeCode), `message must carry the cause code: ${err.message}`);
  return err;
}

Deno.test("5xo59: a custom store read failure propagates and names the store + cause", async () => {
  const stores = failingStore({ failCustom: domException("QuotaExceededError", "storage quota exceeded") });
  await expectStoreReadFailure(
    resolveSkillRef({ ref: "custom:auto-group-by-domain", stores }),
    "custom skills store",
    "storage quota exceeded",
    "QuotaExceededError",
  );
});

Deno.test("5xo59: an imported store read failure propagates and names the store + cause", async () => {
  const stores = failingStore({ failImported: domException("NotAllowedError", "permission denied") });
  await expectStoreReadFailure(
    resolveSkillRef({ ref: "imported:reader-mode", stores }),
    "imported skills store",
    "permission denied",
    "NotAllowedError",
  );
});

Deno.test("5xo59: an imported skill FILE read failure propagates and names the file + cause", async () => {
  // The index row EXISTS (promptBytes > 0: body is store-backed), but the OPFS
  // body read fails — the store is corrupt, not empty.
  const stores = failingStore({
    failFile: domException("NotFoundError", "the body file is gone"),
    imported: [{ id: "reader-mode", name: "Reader", source: "imported", mode: "on-demand", promptBytes: 40, prompt: "" }],
  });
  await expectStoreReadFailure(
    resolveSkillRef({ ref: "imported:reader-mode", stores }),
    `imported skill file "reader-mode/SKILL.md"`,
    "the body file is gone",
    "NotFoundError",
  );
});

Deno.test("5xo59: a genuinely ABSENT skill stays an empty result — not a read failure", async () => {
  // Both stores RESOLVE to empty arrays (no skills installed): that is absence,
  // and must NOT be promoted to a crash.
  const stores = failingStore({ custom: [], imported: [] });
  assertEquals(await resolveSkillRef({ ref: "custom:mystery", stores }), null, "absent custom skill → null");
  assertEquals(await resolveSkillRef({ ref: "imported:mystery", stores }), null, "absent imported skill → null");
});

Deno.test("5xo59: the memoized store wrapper does NOT swallow a read failure before the resolver names it", async () => {
  // skillStores() in the service worker returns createMemoizedSkillStores(...);
  // its .catch(() => []) used to swallow the fault BEFORE resolveSkillRef saw it.
  // Drive the real wrapper + resolver together so the rejection is proven loud
  // end-to-end.
  const memoized = createMemoizedSkillStores(
    failingStore({ failImported: domException("DataError", "index is corrupt") }),
  );
  await expectStoreReadFailure(
    resolveSkillRef({ ref: "imported:reader-mode", stores: memoized }),
    "imported skills store",
    "index is corrupt",
    "DataError",
  );
});
