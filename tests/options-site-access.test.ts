// tests/options-site-access.test.ts — chrome-agent-platform-4dg increment:
// Settings → Permissions reflects ACTUAL Chrome site access (read live from
// chrome.permissions.getAll()), separate from the agent/task policy rows.
//
// Falsification: the unit tests execute the real extension/lib/site-access.js
// module against a stubbed chrome — delete the module or break the split /
// exact-scope revoke and they go RED. The wiring pins sit on the exact call
// expressions in options.js (live code, not comments): deleting the construct
// deletes the pin's occurrence.

import { assert, assertArrayIncludes, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { revokeSiteOrigin, siteAccessLabel, siteAccessScope, siteAccessState } from "../extension/lib/site-access.js";

function chromeWith(origins: unknown, fail = false) {
  return {
    permissions: {
      getAll: async () => {
        if (fail) throw new Error("getAll exploded");
        return { permissions: [], origins };
      },
    },
  };
}

Deno.test("site access: the install grant reads as a fixed row, not revocable", async () => {
  const st = await siteAccessState(chromeWith(["<all_urls>"]), ["<all_urls>"]);
  assertEquals(st, { ok: true, fixed: ["<all_urls>"], revocable: [] });
});

Deno.test("site access: a runtime origin grant is revocable and never mistaken for install", async () => {
  const st = await siteAccessState(
    chromeWith(["https://api.example.com/*", "https://z.dev/*"]),
    ["<all_urls>"],
  );
  assertEquals(st.ok, true);
  assertEquals(st.fixed, []);
  // Deterministic order: the same list every render.
  assertEquals(st.revocable, ["https://api.example.com/*", "https://z.dev/*"]);
});

Deno.test("site access: a failed read says so instead of a silent absence", async () => {
  const st = await siteAccessState(chromeWith([], true), ["<all_urls>"]);
  assertEquals(st.ok, false);
  assertEquals(st.fixed, []);
  assertEquals(st.revocable, []);
});

Deno.test("site access: revoke carries EXACTLY one pattern, nothing broader", async () => {
  const calls: unknown[] = [];
  const chromeApi = {
    permissions: {
      remove: async (query: unknown) => {
        calls.push(query);
        return true;
      },
    },
  };
  assertEquals(await revokeSiteOrigin(chromeApi as any, "https://api.example.com/*"), true);
  assertEquals(calls, [{ origins: ["https://api.example.com/*"] }]);
});

Deno.test("site access: revoke refuses an empty or non-string pattern", async () => {
  assertEquals(await revokeSiteOrigin({ permissions: { remove: async () => true } } as any, ""), false);
  assertEquals(await revokeSiteOrigin({ permissions: { remove: async () => true } } as any, null as any), false);
});

Deno.test("site access: a Chrome refusal or throw is an honest false, never a thrown page error", async () => {
  assertEquals(
    await revokeSiteOrigin({ permissions: { remove: async () => false } } as any, "https://x.dev/*"),
    false,
  );
  assertEquals(
    await revokeSiteOrigin({ permissions: { remove: async () => { throw new Error("no"); } } } as any, "https://x.dev/*"),
    false,
  );
});

Deno.test("site access: labels read as people read them", () => {
  assertEquals(siteAccessLabel("<all_urls>"), "All sites");
  assertEquals(siteAccessLabel("https://api.example.com/*"), "https://api.example.com");
  assertEquals(siteAccessLabel("weird"), "weird");
});

Deno.test("site access: scheme-wide wildcards are named as scope, never as one address (4dg.1)", () => {
  // These EXECUTE the real module: the reviewed candidate rendered these rows
  // as "http://*" / "https://*" next to a description saying "this exact
  // address" — a scheme-wide grant is not one address.
  assertEquals(siteAccessLabel("http://*/*"), "All HTTP sites");
  assertEquals(siteAccessLabel("https://*/*"), "All HTTPS sites");
  // Chrome's `*` scheme is HTTP or HTTPS only (shared/match-patterns.js:
  // https?|*), so the any-scheme wording was too broad (4dg.2).
  assertEquals(siteAccessLabel("*://*/*"), "All HTTP and HTTPS sites");
  // file patterns grant local files, not sites (4dg.2) — both host shapes.
  assertEquals(siteAccessLabel("file://*/*"), "All local files");
  assertEquals(siteAccessLabel("file:///*"), "All local files");
  // An exact origin keeps its origin label.
  assertEquals(siteAccessLabel("http://intranet.example/*"), "http://intranet.example");
});

Deno.test("site access: scope copy is true for wildcards without claiming provenance or outcome", () => {
  assertEquals(siteAccessScope("https://api.example.com/*"), "one site");
  assertEquals(siteAccessScope("http://*/*"), "every HTTP site");
  assertEquals(siteAccessScope("https://*/*"), "every HTTPS site");
  assertEquals(siteAccessScope("<all_urls>"), "every site");
  // Chrome's `*` scheme is HTTP or HTTPS only (4dg.2) — never "every site".
  assertEquals(siteAccessScope("*://*/*"), "every HTTP and HTTPS site");
  // file patterns are local files, never "one site" (4dg.2) — both host shapes.
  assertEquals(siteAccessScope("file:///*"), "local files");
  assertEquals(siteAccessScope("file://*/*"), "local files");
  assertEquals(siteAccessScope("weird"), "this entry");
});

// ── Wiring pins (exact call expressions — live occurrences in options.js) ──

const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

Deno.test("options.js renders the verified site-access group from the real Chrome state", () => {
  // The CALL — deleting the construct deletes this occurrence (import is not a call site).
  assertStringIncludes(options, 'await siteAccessState(chrome, chrome.runtime.getManifest().host_permissions ?? [])');
  // It renders as its own group, separate from the capability groups.
  assertStringIncludes(options, '"site-access", "Chrome site access"');
});

Deno.test("options.js: the install grant is state-only and names the Chrome-owned surface", () => {
  assertStringIncludes(options, '"Granted when the extension was installed. Chrome only takes this back from chrome://extensions."');
  assertStringIncludes(options, '"Granted at install"');
});

Deno.test("options.js: a runtime grant carries a genuine-click Revoke that re-verifies after", () => {
  assertStringIncludes(options, "await revokeSiteOrigin(chrome, pattern)");
  assertStringIncludes(options, '"Revoke"');
  // Scope-true copy wired from the helper — the reviewed defect was a literal
  // "exact address" string shown for scheme-wide rows.
  assertStringIncludes(options, "siteAccessScope(pattern)");
  assert(!options.includes("Granted for this exact address"), "the false one-address copy is gone");
  // After revoke (or its failure) the group re-renders from Chrome, never a stale list.
  assertStringIncludes(options, "renderPermissions();");
});

Deno.test("options.js: unreadable and empty Chrome states say so in words", () => {
  assertStringIncludes(options, "Chrome's site access could not be read.");
  assertStringIncludes(options, "No site access granted.");
});
