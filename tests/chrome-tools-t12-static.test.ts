// tests/chrome-tools-t12-static.test.ts — chrome-agent-platform-p1lp.
//
// The STATIC half of the lease guard, split out of tests/chrome-tools-t12.test.ts for the same reason
// tests/quiet-window-static.test.ts and tests/chrome-profile-static.test.ts were split: this is the
// part that WALKS the extension tree to read tracked source as data, so it has no import edges and a
// subset gate cannot see it — which is exactly what the kz27 audit exists to fix. The other 23 tests in
// that file are functional tool-capability KATs; promoting the whole file would run all of them in
// every subset gate for this one invariant.
//
// It walks the extension root through a LOWERCASE alias (`const root = new URL("../extension/", ...)`)
// and `walk(root)`, which the kz27 detector's `/walk\(\s*[A-Z][A-Z0-9_]*\b/` could not see because it
// demanded an uppercase identifier. That is the under-match this bead (p1lp) closes; the detector now
// matches a walk rooted at a top-level source root by its DEFINITION, and this file is adjudicated into
// SOURCE_INSPECTING_GUARDS so the audit keeps failing closed on it.
//
// Precondition, as with the other build-reading guards: it reads extension sources, and its sibling
// tests import built bundles, so it needs a dist build in a worktree that has never built.
import { assert, assertEquals } from "jsr:@std/assert@1";

const LEASE_KEY = "cap:browser-command-lease";
const LEASE_REFUSAL = "another surface is driving the browser";

Deno.test("LEASE GUARD: the browser-command lease module and its refusal string are gone from the extension", async () => {
  const root = new URL("../extension/", import.meta.url);
  let moduleExists = true;
  try {
    await Deno.stat(new URL("lib/browser-command-lease.js", root));
  } catch {
    moduleExists = false;
  }
  assert(!moduleExists, "extension/lib/browser-command-lease.js must not exist");
  const offenders: string[] = [];
  async function walk(dir: URL) {
    for await (const e of Deno.readDir(dir)) {
      const url = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) {
        if (e.name.startsWith("dist") || e.name === "node_modules" || e.name === "vendor") continue;
        await walk(url);
      } else if (e.name.endsWith(".js")) {
        const text = await Deno.readTextFile(url);
        if (text.includes(LEASE_REFUSAL) || text.includes(LEASE_KEY) || text.includes("browser-command-lease")) {
          offenders.push(url.pathname.slice(url.pathname.indexOf("/extension/")));
        }
      }
    }
  }
  await walk(root);
  assertEquals(offenders, [], "no extension source references the single-driver lease");
});
