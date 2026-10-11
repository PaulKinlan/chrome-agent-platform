// @ts-nocheck
// tests/skill-import-ssrf.test.ts — SSRF and private-address refusal tests for skill-import (chrome-agent-platform-u73qn).
// Verifies that owner-supplied skill import URLs and downloaded file URLs enforce the shared SSRF/private-address
// predicate from lib/fetch-policy.js (matching the brokered-fetch policy used elsewhere in the platform).
//
// Invariants tested:
// 1. fetchSkillFromUrl refuses every loopback, RFC 1918 private, link-local, cloud metadata, and non-http(s) address.
// 2. discoverRepoSkillsAndCommands refuses private/loopback URLs and refuses enrichment from private download URLs.
// 3. GitHub repository multi-file walk refuses supporting file download URLs that target private/loopback addresses.
// 4. installBatchSkillsAndCommands refuses batch items whose downloadUrl targets private/loopback addresses.
// 5. Valid public URLs pass URL validation and proceed to fetch.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  fetchSkillFromUrl,
  discoverRepoSkillsAndCommands,
  installBatchSkillsAndCommands,
  fetchWithSafeRedirects,
  normalizeDirectSkillUrl,
  MAX_REDIRECT_HOPS,
} from "../extension/lib/skill-import.js";

const PRIVATE_URLS = [
  // IPv4 loopback
  "http://127.0.0.1/SKILL.md",
  "http://127.0.0.1:8080/SKILL.md",
  "http://127.1/SKILL.md",
  "http://2130706433/SKILL.md", // decimal 127.0.0.1
  "http://0x7f000001/SKILL.md", // hex 127.0.0.1
  "http://017700000001/SKILL.md", // octal 127.0.0.1
  "http://127.0.0.1../SKILL.md", // multiple trailing dots
  // Localhost names
  "http://localhost/SKILL.md",
  "http://localhost:3000/SKILL.md",
  "http://sub.localhost/SKILL.md",
  "http://LOCALHOST:8000/SKILL.md",
  "http://localhost../SKILL.md", // multiple trailing dots
  "http://sub.localhost../SKILL.md",
  // Cloud metadata / link-local (AWS, GCP, Azure, OpenStack)
  "http://169.254.169.254/latest/meta-data/",
  "http://169.254.169.254/computeMetadata/v1/",
  "http://169.254.1.1/SKILL.md",
  // RFC 1918 private ranges
  "http://10.0.0.1/SKILL.md",
  "http://10.0.0.1../SKILL.md",
  "http://10.255.255.254/SKILL.md",
  "http://172.16.0.1/SKILL.md",
  "http://172.31.255.254/SKILL.md",
  "http://192.168.1.1/SKILL.md",
  "http://192.168.0.100:8080/SKILL.md",
  // CGNAT / Unspecified
  "http://0.0.0.0/SKILL.md",
  "http://100.64.0.1/SKILL.md",
  // IPv6 loopback, link-local, unique-local
  "http://[::1]/SKILL.md",
  "http://[fe80::1]/SKILL.md",
  "http://[fc00::1]/SKILL.md",
  "http://[fd12:3456::1]/SKILL.md",
  "http://[::ffff:127.0.0.1]/SKILL.md",
  "http://[::ffff:10.0.0.1]/SKILL.md",
];

const NON_HTTP_URLS = [
  "file:///etc/passwd",
  "file:///proc/self/environ",
  "javascript:alert(1)",
  "ftp://example.com/SKILL.md",
  "data:text/plain,hello",
];

Deno.test("u73qn falsification: fetchSkillFromUrl refuses every private, loopback, and link-local address", async () => {
  for (const url of PRIVATE_URLS) {
    const err = await assertRejects(
      () => fetchSkillFromUrl(url),
      Error,
    );
    assert(
      err.message.includes("private or loopback address"),
      `Expected private address refusal for ${url}, got: ${err.message}`,
    );
  }
});

Deno.test("u73qn: fetchSkillFromUrl refuses non-http(s) and malformed URLs", async () => {
  for (const url of NON_HTTP_URLS) {
    const err = await assertRejects(
      () => fetchSkillFromUrl(url),
      Error,
    );
    assert(
      err.message.includes("skill URL must be http(s)") || err.message.includes("protocol "),
      `Expected protocol refusal for ${url}, got: ${err.message}`,
    );
  }

  const malformedErr = await assertRejects(
    () => fetchSkillFromUrl("not a valid url"),
    Error,
  );
  assertEquals(malformedErr.message, "invalid skill URL");

  const emptyErr = await assertRejects(
    () => fetchSkillFromUrl(""),
    Error,
  );
  assertEquals(emptyErr.message, "no skill URL provided");
});

Deno.test("u73qn falsification: discoverRepoSkillsAndCommands refuses private, loopback, and metadata URLs", async () => {
  for (const url of ["http://127.0.0.1/owner/repo", "http://169.254.169.254/owner/repo", "http://localhost/owner/repo"]) {
    const err = await assertRejects(
      () => discoverRepoSkillsAndCommands(url),
      Error,
    );
    assert(
      err.message.includes("private or loopback address"),
      `Expected private address refusal for ${url}, got: ${err.message}`,
    );
  }
});

Deno.test("u73qn falsification: GitHub skill walk refuses supporting file download URLs that target private addresses", async () => {
  // Mock fetch to simulate GitHub Contents API returning a supporting file with an SSRF download_url
  const origFetch = globalThis.fetch;
  let fetchedPrivateUrl = false;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);

    if (url.includes("169.254.169.254") || url.includes("127.0.0.1") || url.includes("localhost")) {
      fetchedPrivateUrl = true;
      return new Response("attacker data", { status: 200 });
    }

    // GitHub Contents API response for repository root
    if (url.includes("api.github.com/repos/owner/repo/contents/")) {
      return new Response(JSON.stringify([
        {
          type: "file",
          name: "SKILL.md",
          path: "SKILL.md",
          download_url: "https://raw.githubusercontent.com/owner/repo/main/SKILL.md",
        },
        {
          type: "file",
          name: "config.json",
          path: "config.json",
          // Malicious download_url targeting cloud metadata service
          download_url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        },
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://raw.githubusercontent.com/owner/repo/main/SKILL.md") {
      return new Response("---\nname: Test Skill\n---\nBody", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };

  try {
    const err = await assertRejects(
      () => fetchSkillFromUrl("https://github.com/owner/repo"),
      Error,
    );
    assert(
      err.message.includes("refused: private or loopback address"),
      `Expected download_url refusal, got: ${err.message}`,
    );
    assertEquals(fetchedPrivateUrl, false, "Private metadata URL must NEVER be fetched");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("u73qn falsification: installBatchSkillsAndCommands refuses batch items targeting private download URLs", async () => {
  let privateFetched = false;
  const mockFetcher = async (url: string) => {
    if (url.includes("169.254.169.254") || url.includes("127.0.0.1")) {
      privateFetched = true;
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array() };
    }
    return { ok: false, status: 404 };
  };

  const mem = {
    data: new Map(),
    async get(k: string) { return this.data.get(k); },
    async set(k: string, v: any) { this.data.set(k, v); },
  };

  const batch = {
    fetch: mockFetcher,
    skills: [
      {
        id: "ssrf-skill",
        name: "ssrf-skill",
        downloadUrl: "http://169.254.169.254/latest/meta-data/",
      },
    ],
    commands: [
      {
        id: "ssrf-cmd",
        name: "ssrf-cmd",
        downloadUrl: "http://127.0.0.1:8080/admin",
      },
    ],
  };

  const result = await installBatchSkillsAndCommands(mem as any, batch);
  assertEquals(result.ok, false, "Batch with private URLs must fail");
  assertEquals(result.errors.length, 2, "Both private URLs must be rejected");
  assert(result.errors[0].error.includes("private or loopback address"));
  assert(result.errors[1].error.includes("private or loopback address"));
  assertEquals(privateFetched, false, "Private URLs must never be fetched in batch import");
});

Deno.test("u73qn falsification: redirect to private or loopback address is refused without fetching target", async () => {
  const origFetch = globalThis.fetch;
  let targetFetched = false;

  for (const privateDest of [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/admin",
    "http://localhost:3000/api",
    "http://10.0.0.1/secret",
    "file:///etc/passwd",
  ]) {
    targetFetched = false;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
      if (url === privateDest || url.includes("169.254.169.254") || url.includes("127.0.0.1") || url.includes("localhost") || url.includes("10.0.0.1")) {
        targetFetched = true;
        return new Response("private data", { status: 200 });
      }
      if (url === "https://public.example.com/skill.md") {
        return new Response("", {
          status: 302,
          headers: new Headers({ Location: privateDest }),
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const err = await assertRejects(
        () => fetchSkillFromUrl("https://public.example.com/skill.md"),
        Error,
      );
      assert(
        err.message.includes("private or loopback address") ||
        err.message.includes("skill URL must be http(s)") ||
        err.message.includes("protocol "),
        `Expected refusal for redirect to ${privateDest}, got: ${err.message}`,
      );
      assertEquals(targetFetched, false, `Target ${privateDest} must NEVER be fetched after redirect`);
    } finally {
      globalThis.fetch = origFetch;
    }
  }
});

Deno.test("u73qn falsification: discoverRepoSkillsAndCommands refuses marketplace.json with private download_url", async () => {
  let privateMarketplaceFetched = false;

  const mockFetcher = async (url: string, init?: any) => {
    if (url.includes("169.254.169.254") || url.includes("127.0.0.1")) {
      privateMarketplaceFetched = true;
      return new Response("metadata leaked", { status: 200 });
    }
    if (url.includes("git/trees/")) {
      return new Response(JSON.stringify({
        tree: [
          {
            type: "blob",
            path: ".claude-plugin/marketplace.json",
            download_url: "http://169.254.169.254/latest/meta-data/",
          },
          {
            type: "blob",
            path: "skills/demo/SKILL.md",
            download_url: "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md",
          },
        ],
        truncated: false,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("SKILL.md")) {
      return new Response("---\nname: Demo\n---\nBody", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const err = await assertRejects(
    () => discoverRepoSkillsAndCommands("https://github.com/owner/repo", { fetch: mockFetcher }),
    Error,
  );
  assert(
    err.message.includes("private or loopback address"),
    `Expected private address refusal for marketplace download_url, got: ${err.message}`,
  );
  assertEquals(privateMarketplaceFetched, false, "Private marketplace download_url must NEVER be fetched");
});

// =============================================================================
// Redirect handling: Simulated Chrome opaqueredirect vs Inspectable-3xx Defense-in-Depth
//
// In the shipped Chrome extension runtime, all fetches are issued with redirect: 'manual'
// (extension/lib/skill-import.js:81). When a redirect occurs, Chromium's network service
// strips headers and returns type: 'opaqueredirect' (status: 0), where the Location header
// is uninspectable by extension JavaScript. The tests below model this response contract
// using a simulated opaqueredirect shape (hand-written mock, not live browser driving),
// verifying that fetchWithSafeRedirects enforces immediate fail-closed refusal.
//
// The manual Location-hop re-validation loop (MAX_REDIRECT_HOPS = 5) in fetchWithSafeRedirects
// acts as defense-in-depth for runtimes or environments where redirect: 'manual' exposes an
// inspectable 3xx response with Location headers (e.g. Node/Deno/custom fetchers).
// =============================================================================

Deno.test("klbus / u73qn (inspectable-3xx non-Chrome defense-in-depth): public redirect to another public URL succeeds when Location is inspectable", async () => {
  const origFetch = globalThis.fetch;
  let finalFetched = false;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    if (url === "https://example.com/redirect-me.md") {
      return new Response("", {
        status: 301,
        headers: new Headers({ Location: "https://cdn.example.com/actual-skill.md" }),
      });
    }
    if (url === "https://cdn.example.com/actual-skill.md") {
      finalFetched = true;
      return new Response("---\nname: Safe Redirected Skill\n---\nRedirected Content", {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  };

    try {
      const res = await fetchSkillFromUrl("https://example.com/redirect-me.md");
      assertEquals(res.meta.name, "Safe Redirected Skill");
      assertEquals(finalFetched, true, "Final public redirected URL must be fetched");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

Deno.test("klbus / u73qn (inspectable-3xx non-Chrome defense-in-depth): boundary (a) multi-hop chain with a private hop in the middle is refused without fetching it", async () => {
  const origFetch = globalThis.fetch;
  let privateHopFetched = false;
  const visitedUrls: string[] = [];

  // Chain: https://hop0.example.com -> https://hop1.example.com -> http://169.254.169.254/secret -> https://hop3.example.com
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    visitedUrls.push(url);

    if (url.includes("169.254.169.254")) {
      privateHopFetched = true;
      return new Response("private data", { status: 200 });
    }
    if (url === "https://hop0.example.com/skill.md") {
      return new Response("", {
        status: 302,
        headers: new Headers({ Location: "https://hop1.example.com/redirect2" }),
      });
    }
    if (url === "https://hop1.example.com/redirect2") {
      return new Response("", {
        status: 302,
        headers: new Headers({ Location: "http://169.254.169.254/secret" }),
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const err = await assertRejects(
      () => fetchSkillFromUrl("https://hop0.example.com/skill.md"),
      Error,
    );
    assert(
      err.message.includes("private or loopback address"),
      `Expected refusal for middle private hop, got: ${err.message}`,
    );
    assertEquals(privateHopFetched, false, "Middle private hop must NEVER be fetched");
    assertEquals(visitedUrls, ["https://hop0.example.com/skill.md", "https://hop1.example.com/redirect2"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("klbus / u73qn (inspectable-3xx non-Chrome defense-in-depth): boundary (b) chain longer than MAX_REDIRECT_HOPS (5) is refused fail-closed", async () => {
  const origFetch = globalThis.fetch;
  let hops = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    hops++;
    // Infinite loop or 6+ hops
    return new Response("", {
      status: 302,
      headers: new Headers({ Location: `https://example.com/hop${hops}.md` }),
    });
  };

  try {
    const err = await assertRejects(
      () => fetchSkillFromUrl("https://example.com/start.md"),
      Error,
    );
    assert(
      err.message.includes("redirect hop count exceeded bound"),
      `Expected hop count exceeded refusal, got: ${err.message}`,
    );
    assertEquals(hops, MAX_REDIRECT_HOPS + 1, "Must halt exactly at MAX_REDIRECT_HOPS (5)");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("klbus / u73qn (inspectable-3xx non-Chrome defense-in-depth): boundary (c) relative Location resolves and is re-checked against checkFetchTarget", async () => {
  const origFetch = globalThis.fetch;

  // 1. Safe relative redirect resolves against base URL and succeeds
  let fetchedResolvedRelative = false;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    if (url === "https://example.com/skills/subdir/start.md") {
      return new Response("", {
        status: 302,
        headers: new Headers({ Location: "../actual.md" }),
      });
    }
    if (url === "https://example.com/skills/actual.md") {
      fetchedResolvedRelative = true;
      return new Response("---\nname: Relative Skill\n---\nRelative body", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const res = await fetchSkillFromUrl("https://example.com/skills/subdir/start.md");
    assertEquals(res.meta.name, "Relative Skill");
    assertEquals(fetchedResolvedRelative, true, "Resolved relative URL must be fetched");
  } finally {
    globalThis.fetch = origFetch;
  }

  // 2. Protocol-relative or path-relative redirect to private host is re-checked and refused
  let privateTargetFetched = false;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    if (url.includes("127.0.0.1") || url.includes("169.254.169.254")) {
      privateTargetFetched = true;
      return new Response("pwned", { status: 200 });
    }
    if (url === "https://example.com/start.md") {
      // Protocol-relative redirect to private IP
      return new Response("", {
        status: 302,
        headers: new Headers({ Location: "//127.0.0.1:8080/evil.md" }),
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const err = await assertRejects(
      () => fetchSkillFromUrl("https://example.com/start.md"),
      Error,
    );
    assert(
      err.message.includes("private or loopback address"),
      `Expected refusal for protocol-relative private redirect, got: ${err.message}`,
    );
    assertEquals(privateTargetFetched, false, "Private target from protocol-relative redirect must NEVER be fetched");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("u73qn boundary (d): all fetch requests are issued with redirect: 'manual'", async () => {
  const spiedInits: any[] = [];
  const mockFetcher = async (url: string, init?: any) => {
    spiedInits.push(init);
    if (url.includes("step1")) {
      return new Response("", {
        status: 302,
        headers: new Headers({ Location: "https://example.com/step2" }),
      });
    }
    return new Response("---\nname: Spied Skill\n---\nBody", { status: 200 });
  };

  const resp = await fetchWithSafeRedirects("https://example.com/step1", {}, mockFetcher);
  assertEquals(resp.status, 200);
  assertEquals(spiedInits.length, 2, "Must have made 2 requests");
  for (let i = 0; i < spiedInits.length; i++) {
    assertEquals(
      spiedInits[i]?.redirect,
      "manual",
      `Request ${i} must be explicitly configured with redirect: 'manual'`,
    );
  }
});

Deno.test("u73qn: public URLs pass validation and are not refused by the SSRF check", async () => {
  // Validate that a public URL does not fail with "private or loopback address"
  const origFetch = globalThis.fetch;
  let fetchTarget = "";
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    fetchTarget = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    return new Response("---\nname: Public Skill\ndescription: A public skill\n---\nContent", {
      status: 200,
    });
  };

  try {
    const res = await fetchSkillFromUrl("https://example.com/skills/public.md");
    assertEquals(res.meta.name, "Public Skill");
    assertEquals(fetchTarget, "https://example.com/skills/public.md");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("klbus / u73qn (simulated Chrome redirect:manual opaqueredirect shape): opaqueredirect response is refused fail-closed without following uninspectable destination", async () => {
  // Hand-written mock of the Fetch API redirect: 'manual' response shape (type: 'opaqueredirect', status: 0)
  // to exercise fetchWithSafeRedirects fail-closed handling without driving a real browser.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<any> => {
    return {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
    };
  };

  try {
    const err = await assertRejects(
      () => fetchSkillFromUrl("https://example.com/opaque.md"),
      Error,
    );
    assert(
      err.message.includes("opaque destination") || err.message.includes("redirected"),
      `Expected opaque redirect refusal, got: ${err.message}`,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("klbus falsification: simulated Chrome redirect:manual opaqueredirect shape refuses public redirects (opaque 3xx) fail-closed rather than following them", async () => {
  // Simulates Chrome's redirect: 'manual' response shape where a 301/302 from https://example.com/redirect-me.md
  // returns type: 'opaqueredirect' (status: 0, empty headers) via hand-written mock.
  // A test or caller claiming that this redirect shape follows public redirects is falsified:
  // it MUST throw and refuse fail-closed rather than delivering the redirected skill.
  const origFetch = globalThis.fetch;
  let finalCdnFetched = false;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<any> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    if (url === "https://example.com/redirect-me.md") {
      // Hand-written mock of Chrome's exact Fetch API contract for redirect: 'manual'
      return {
        type: "opaqueredirect",
        status: 0,
        ok: false,
        headers: new Headers(),
      };
    }
    if (url.includes("actual-skill.md")) {
      finalCdnFetched = true;
      return new Response("---\nname: Safe Redirected Skill\n---\nRedirected Content", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const err = await assertRejects(
      () => fetchSkillFromUrl("https://example.com/redirect-me.md"),
      Error,
    );
    assert(
      err.message.includes("opaque destination") || err.message.includes("redirected"),
      `Expected opaque redirect refusal under simulated opaqueredirect shape, got: ${err.message}`,
    );
    assertEquals(finalCdnFetched, false, "Must NEVER follow uninspectable redirect hop under opaqueredirect shape");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("u73qn: normalizeDirectSkillUrl rewrites github.com/.../raw/... to raw.githubusercontent.com directly", () => {
  assertEquals(
    normalizeDirectSkillUrl("https://github.com/owner/repo/raw/main/skills/test/SKILL.md"),
    "https://raw.githubusercontent.com/owner/repo/main/skills/test/SKILL.md",
  );
  assertEquals(
    normalizeDirectSkillUrl("https://github.com/owner/repo/raw/v1.0.0/SKILL.md"),
    "https://raw.githubusercontent.com/owner/repo/v1.0.0/SKILL.md",
  );
  assertEquals(
    normalizeDirectSkillUrl("https://gist.github.com/user/12345/raw/SKILL.md"),
    "https://gist.githubusercontent.com/user/12345/raw/SKILL.md",
  );
  // Non-raw URLs are unchanged
  assertEquals(
    normalizeDirectSkillUrl("https://raw.githubusercontent.com/owner/repo/main/SKILL.md"),
    "https://raw.githubusercontent.com/owner/repo/main/SKILL.md",
  );
  assertEquals(
    normalizeDirectSkillUrl("https://example.com/SKILL.md"),
    "https://example.com/SKILL.md",
  );
});




