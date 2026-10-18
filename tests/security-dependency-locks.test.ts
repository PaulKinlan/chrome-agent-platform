// lf9xe / im9q8 / 7jv95: npm's installed lock is NOT the Deno store bundled into
// the extension. Pin the security-sensitive resolutions in both lockfiles.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isPatchedFastUriVersion } from "../scripts/bundle-budget.mjs";

const npmLock = JSON.parse(await Deno.readTextFile(new URL("../package-lock.json", import.meta.url)));
const denoLock = JSON.parse(await Deno.readTextFile(new URL("../deno.lock", import.meta.url)));

Deno.test("lf9xe / 7jv95 / vb4c4: Deno and npm agree on an advisory-patched fast-uri tarball (>= 2.4.7, >= 3.1.8, or >= 4.1.5)", () => {
  // GHSA-qw65-cvwx-89v3 affects 3.0.0–3.1.6; GHSA-58mr-gqgx-xq4g affects 3.1.6;
  // GHSA-hrr3-gc8f-f4qj affects < 2.4.7, 3.0.0–3.1.7, and 4.0.0–4.1.4.
  // Patched versions are >= 2.4.7 on 2.x, >= 3.1.8 on 3.x, or >= 4.1.5 on 4.x.
  const npm = npmLock.packages["node_modules/fast-uri"];
  assert(npm?.version && npm?.integrity, "npm must lock fast-uri with an integrity hash");
  assert(isPatchedFastUriVersion(npm.version),
    `fast-uri ${npm.version} is not verified patched against advisories (require >= 2.4.7 on 2.x, >= 3.1.8 on 3.x, or >= 4.1.5 on 4.x)`);
  const parts = npm.version.split(".").map(Number);
  const isPatchedLine = (parts[0] === 2 && (parts[1] > 4 || (parts[1] === 4 && parts[2] >= 7))) ||
    (parts[0] === 3 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 8))) ||
    (parts[0] === 4 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 5)));
  assert(parts.length === 3 && parts.every(Number.isInteger) && isPatchedLine,
    `fast-uri ${npm.version} is not verified patched against advisories (require >= 2.4.7 on 2.x, >= 3.1.8 on 3.x, or >= 4.1.5 on 4.x)`);
  const entries = Object.entries(denoLock.npm).filter(([name]) => name.startsWith("fast-uri@"));
  assertEquals(entries, [[`fast-uri@${npm.version}`, { integrity: npm.integrity }]],
    "Deno ships the npm-locked patched version and the same verified tarball, not an older .deno copy");
});

Deno.test("7jv95 / vb4c4 falsification: isPatchedFastUriVersion accepts advisory-patched lines and rejects vulnerable/unsupported versions", () => {
  // Advisory GHSA-hrr3-gc8f-f4qj (CVE-2026-86472) fixed lines:
  // 1. Accepted: patched versions on supported lines (2.x, 3.x, 4.x)
  assertEquals(isPatchedFastUriVersion("2.4.7"), true, "2.4.7 is patched under GHSA-hrr3-gc8f-f4qj");
  assertEquals(isPatchedFastUriVersion("2.4.8"), true, "2.4.8+ is patched");
  assertEquals(isPatchedFastUriVersion("2.5.0"), true, "2.5.0+ is patched");
  assertEquals(isPatchedFastUriVersion("3.1.8"), true, "3.1.8 is patched");
  assertEquals(isPatchedFastUriVersion("3.1.9"), true, "3.1.9+ is patched");
  assertEquals(isPatchedFastUriVersion("3.2.0"), true, "3.2.0+ is patched");
  assertEquals(isPatchedFastUriVersion("4.1.5"), true, "4.1.5 is patched under GHSA-hrr3-gc8f-f4qj");
  assertEquals(isPatchedFastUriVersion("4.1.6"), true, "4.1.6+ is patched");
  assertEquals(isPatchedFastUriVersion("4.2.0"), true, "4.2.0+ is patched");

  // 2. Refused: vulnerable versions immediately prior to patches and earlier
  assertEquals(isPatchedFastUriVersion("2.4.6"), false, "2.4.6 must be rejected (< 2.4.7 affected)");
  assertEquals(isPatchedFastUriVersion("2.3.9"), false, "2.3.9 must be rejected (< 2.4.7 affected)");
  assertEquals(isPatchedFastUriVersion("3.1.7"), false, "3.1.7 must be rejected under GHSA-hrr3-gc8f-f4qj");
  assertEquals(isPatchedFastUriVersion("3.1.6"), false, "3.1.6 must be rejected under GHSA-58mr-gqgx-xq4g");
  assertEquals(isPatchedFastUriVersion("3.1.5"), false, "3.1.5 must be rejected under GHSA-qw65-cvwx-89v3");
  assertEquals(isPatchedFastUriVersion("3.0.0"), false, "3.0.0 must be rejected");
  assertEquals(isPatchedFastUriVersion("4.1.4"), false, "4.1.4 must be rejected (>=4.0.0 <4.1.5 affected)");
  assertEquals(isPatchedFastUriVersion("4.0.0"), false, "4.0.0 must be rejected");

  // 3. Fail-closed: prereleases, non-semver, unknown majors
  assertEquals(isPatchedFastUriVersion("1.0.0"), false, "1.x must be rejected (fail-closed)");
  assertEquals(isPatchedFastUriVersion("5.0.0"), false, "unknown major 5.x must fail closed");
  assertEquals(isPatchedFastUriVersion("3.1.8-alpha.1"), false, "prereleases must fail closed");
  assertEquals(isPatchedFastUriVersion("4.1.5-beta"), false, "prereleases must fail closed");
  assertEquals(isPatchedFastUriVersion(""), false, "empty string must fail closed");
  assertEquals(isPatchedFastUriVersion(null), false, "null must fail closed");
  assertEquals(isPatchedFastUriVersion(undefined), false, "undefined must fail closed");
});

Deno.test("im9q8: MCP SDK resolution matches the npm runtime lock in every Deno peer context", () => {
  const npm = npmLock.packages["node_modules/@modelcontextprotocol/sdk"];
  assert(npm?.version, "npm must lock the runtime MCP SDK");
  const versions = [...new Set(Object.keys(denoLock.npm)
    .filter((name) => name.startsWith("@modelcontextprotocol/sdk@"))
    .map((name) => name.slice("@modelcontextprotocol/sdk@".length).split("_")[0]))];
  assertEquals(versions, [npm.version], "both zod-peer SDK instances must resolve the npm-locked version");
});

/** TRUE when `version` is at or above `floor` on the same major line (the advisory ranges are per-major). */
function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  if (a.length < 3 || b.length < 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] >= b[2];
}

Deno.test("behrd: every advisory-patched dependency is patched in BOTH lockfiles", () => {
  // Four findings from the 2026-10-18 nightly (chrome-agent-platform-behrd), each bumped rather than waved
  // through, and each pinned here so a later lockfile regeneration cannot quietly walk back under the fix.
  //
  // Reachability, recorded rather than assumed (all four are transitive and NONE of the advisory paths is on
  // our executed path today - that is why this is P3 and why the fix is still worth taking):
  //   hono        GHSA-hxh3-vqpv-xpqv  hono/jsx SSR string escaping (XSS). We import server.js and
  //                                    webStandardStreamableHttp.js only, never the jsx renderer.
  //   ip-address  GHSA-j6r3-76f7-8jcv  isInSubnet/isHostInSubnet family confusion. Reached only through
  //                                    express-rate-limit, which the MCP express subpath pulls in; our
  //                                    transport is the Web Standard one.
  //   proxy-addr  GHSA-jqcg-44mw-7w3h  X-Forwarded-For spoofing via IPv4-mapped IPv6 trust subnets. Needs a
  //                                    configured `trust proxy`; we configure none.
  //   undici      GHSA-3wwx-pv8p-q78v  WebSocket permessage-deflate zlib DoS. Reached through the AI SDK's
  //                                    provider-utils, whose requests are plain fetch; no WebSocket path.
  const patched: Array<{ name: string; floor: string; advisory: string; denoName?: string }> = [
    { name: "hono", floor: "4.13.7", advisory: "GHSA-hxh3-vqpv-xpqv", denoName: "hono" },
    { name: "ip-address", floor: "10.7.1", advisory: "GHSA-j6r3-76f7-8jcv", denoName: "ip-address" },
    { name: "proxy-addr", floor: "2.0.8", advisory: "GHSA-jqcg-44mw-7w3h", denoName: "proxy-addr" },
    { name: "undici", floor: "7.29.1", advisory: "GHSA-3wwx-pv8p-q78v", denoName: "undici" },
  ];
  for (const { name, floor, advisory, denoName } of patched) {
    const npm = npmLock.packages[`node_modules/${name}`];
    assert(npm?.version && npm?.integrity, `npm must lock ${name} with an integrity hash`);
    assert(atLeast(npm.version, floor),
      `npm locks ${name} ${npm.version}, which is under the ${advisory} fix (need >= ${floor}) - ` +
        `bump it deliberately rather than accepting the advisory`);

    const denoVersions = [...new Set(Object.keys(denoLock.npm)
      .filter((entry) => entry.startsWith(`${denoName}@`))
      .map((entry) => entry.slice(denoName!.length + 1).split("_")[0]))];
    assert(denoVersions.length > 0, `deno.lock must pin ${denoName} - a missing entry means the Deno graph lost it`);
    for (const version of denoVersions) {
      assert(atLeast(version, floor),
        `deno.lock pins ${denoName} ${version}, under the ${advisory} fix (need >= ${floor}); the Deno store is ` +
          `what the bundled extension ships, so this is not a dev-only file`);
    }
  }
});

Deno.test("behrd falsification: atLeast refuses the versions this bead bumped AWAY from", () => {
  assertEquals(atLeast("4.13.5", "4.13.7"), false, "hono 4.13.5 is the version that was vulnerable");
  assertEquals(atLeast("10.7.0", "10.7.1"), false, "ip-address 10.7.0 is the version that was vulnerable");
  assertEquals(atLeast("2.0.7", "2.0.8"), false, "proxy-addr 2.0.7 is the version that was vulnerable");
  assertEquals(atLeast("7.29.0", "7.29.1"), false, "undici 7.29.0 is the version that was vulnerable");
  assertEquals(atLeast("not-a-version", "1.0.0"), false, "fail closed on nonsense");
  assertEquals(atLeast("4.13.7", "4.13.7"), true, "the fix itself satisfies the floor");
  assertEquals(atLeast("5.0.0", "4.13.7"), true, "and a later major does too");
});
