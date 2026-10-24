// lf9xe / im9q8 / 7jv95 / 4c3mp: npm's installed lock is NOT the Deno store
// bundled into the extension. Pin the security-sensitive resolutions in both
// lockfiles, and pin the ADVISORY FLOOR against an expectation table written
// independently of the module that derives it.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  FAST_URI_ADVISORIES,
  fastUriAdvisoryRequirement,
  fastUriFloors,
  isPatchedFastUriVersion,
  securityDependencyDrift,
} from "../scripts/bundle-budget.mjs";

const npmLock = JSON.parse(await Deno.readTextFile(new URL("../package-lock.json", import.meta.url)));
const denoLock = JSON.parse(await Deno.readTextFile(new URL("../deno.lock", import.meta.url)));

Deno.test("lf9xe / 7jv95 / vb4c4 / 4c3mp: Deno and npm agree on an advisory-patched fast-uri tarball", () => {
  const npm = npmLock.packages["node_modules/fast-uri"];
  assert(npm?.version && npm?.integrity, "npm must lock fast-uri with an integrity hash");
  assert(isPatchedFastUriVersion(npm.version),
    `fast-uri ${npm.version} is not verified patched against every advisory in the ledger ` +
      `(require ${fastUriAdvisoryRequirement()})`);
  // The floor itself is asserted against the independent expectation table below
  // (4c3mp): re-typing the arithmetic here is what let 7jv95's guard and test
  // share one stale constant.
  const entries = Object.entries(denoLock.npm).filter(([name]) => name.startsWith("fast-uri@"));
  assertEquals(entries, [[`fast-uri@${npm.version}`, { integrity: npm.integrity }]],
    "Deno ships the npm-locked patched version and the same verified tarball, not an older .deno copy");
});

Deno.test("4c3mp: the advisory ledger derives the floor from its rows, and the rows match the published feed", () => {
  // DUAL CONTROL (this is the 4c3mp fix, not decoration): the floors below are
  // transcribed from the GitHub advisory feed
  // (https://api.github.com/advisories/<id>, read 2026-10-24) and are asserted
  // EQUAL to the ledger in scripts/bundle-budget.mjs. A hand-raised constant in
  // either place now reds the suite; 7jv95 raised the guard, its message and its
  // test together and nothing noticed when the next four advisories shipped.
  const EXPECTED: Array<{ id: string; fixed: Record<string, string> }> = [
    { id: "GHSA-qw65-cvwx-89v3", fixed: { "2": "2.4.6", "3": "3.1.7", "4": "4.1.4" } },
    { id: "GHSA-58mr-gqgx-xq4g", fixed: { "2": "2.4.6", "3": "3.1.7", "4": "4.1.4" } },
    { id: "GHSA-hrr3-gc8f-f4qj", fixed: { "2": "2.4.7", "3": "3.1.8", "4": "4.1.5" } },
    { id: "GHSA-w74x-v6f9-j3xg", fixed: { "2": "2.4.8", "3": "3.1.9", "4": "4.2.3" } },
    { id: "GHSA-xhq7-xmqj-769h", fixed: { "2": "2.4.8", "3": "3.1.9", "4": "4.2.3" } },
    { id: "GHSA-wjr9-j795-jxcr", fixed: { "2": "2.4.8", "3": "3.1.9", "4": "4.2.3" } },
    { id: "GHSA-333x-w4r6-6crp", fixed: { "2": "2.4.8", "3": "3.1.9", "4": "4.2.3" } },
  ];
  assertEquals(
    FAST_URI_ADVISORIES.map((advisory) => ({ id: advisory.id, fixed: { ...advisory.fixed } })),
    EXPECTED,
    "the ledger must carry every published fast-uri advisory, with the feed's per-line fix");
  assertEquals(fastUriFloors(), { "2": "2.4.8", "3": "3.1.9", "4": "4.2.3" },
    "the floor is the NEWEST published fix per line, recomputed from the rows");
  assertEquals(fastUriAdvisoryRequirement(), ">=2.4.8 on 2.x, >=3.1.9 on 3.x, >=4.2.3 on 4.x",
    "the drift message's requirement is derived from the same rows");

  // The floor is what the predicate answers: it passes AT the floor and the
  // version one patch below it is refused, on every line. This is the mutant
  // 7jv95 could not catch -- its test asserted the constant it also declared.
  const FLOORS: Record<string, string> = { "2": "2.4.8", "3": "3.1.9", "4": "4.2.3" };
  for (const [major, floor] of Object.entries(FLOORS)) {
    assert(isPatchedFastUriVersion(floor), `${major}.x floor ${floor} must pass the predicate`);
    const [maj, min, patch] = floor.split(".").map(Number);
    const below = `${maj}.${min}.${patch - 1}`;
    assertEquals(isPatchedFastUriVersion(below), false,
      `${major}.x: ${below} is the version immediately below the floor and must be refused`);
  }

  // Every row is internally coherent: its fix sits at or above every boundary of
  // the range it closes (no row is a no-op, and none closes shy of its range).
  for (const { id, fixed } of EXPECTED) {
    const row = FAST_URI_ADVISORIES.find((advisory) => advisory.id === id);
    assert(row, `ledger row ${id} must exist`);
    for (const [major, fix] of Object.entries(fixed)) {
      const range = (row!.affects as Record<string, string>)[major];
      assert(range, `${id} must state the ${major}.x range it affects`);
      const bounds = range.match(/\d+\.\d+\.\d+/g) ?? [];
      assert(bounds.length > 0, `${id} ${major}.x range must name a version boundary`);
      const [fmaj, fmin, fpatch] = fix.split(".").map(Number);
      for (const bound of bounds) {
        const [bmaj, bmin, bpatch] = bound.split(".").map(Number);
        const fixIsAtOrAbove = fmaj !== bmaj ? fmaj > bmaj : fmin !== bmin ? fmin > bmin : fpatch >= bpatch;
        assert(fixIsAtOrAbove, `${id}: fix ${fix} must be at or above its ${major}.x range boundary ${bound}`);
      }
    }
  }
});

Deno.test("4c3mp: the previously-certified fast-uri 3.1.8 turns the drift gate RED and names the new advisories", () => {
  // The mutant this bead exists to kill: the gate and its test both said 3.1.8
  // was patched. A lock/fixture still on 3.1.8 must be rejected, and the reason
  // must name the advisories that were missing from the stale message.
  const mutantNpmLock = { packages: { "node_modules/fast-uri": { version: "3.1.8", integrity: "sha512-old" } } };
  const mutantDenoLock = { npm: { "fast-uri@3.1.8": { integrity: "sha512-old" } } };
  const metafile = {
    inputs: { "node_modules/.deno/fast-uri@3.1.8/node_modules/fast-uri/index.js": { bytes: 11 } },
  };
  assertEquals(isPatchedFastUriVersion("3.1.8"), false, "3.1.8 is the vulnerable version, not the floor");
  const drift = securityDependencyDrift(metafile, mutantNpmLock, mutantDenoLock);
  assertEquals(drift.length, 1, `exactly one finding expected, got ${JSON.stringify(drift)}`);
  for (const id of ["GHSA-w74x-v6f9-j3xg", "GHSA-xhq7-xmqj-769h", "GHSA-wjr9-j795-jxcr", "GHSA-333x-w4r6-6crp"]) {
    assertStringIncludes(drift[0], id, `the drift message must cite ${id}`);
  }
  assertStringIncludes(drift[0], ">=3.1.9 on 3.x", "the message states the derived floor");
});

Deno.test("7jv95 / vb4c4 / 4c3mp falsification: isPatchedFastUriVersion accepts advisory-patched lines and rejects vulnerable/unsupported versions", () => {
  // 1. Accepted: at or above the newest published fix on a supported line.
  assertEquals(isPatchedFastUriVersion("2.4.8"), true, "2.4.8 is the newest 2.x fix (GHSA-w74x-v6f9-j3xg)");
  assertEquals(isPatchedFastUriVersion("2.4.9"), true, "2.4.9+ is patched");
  assertEquals(isPatchedFastUriVersion("2.5.0"), true, "2.5.0+ is patched");
  assertEquals(isPatchedFastUriVersion("3.1.9"), true, "3.1.9 is the newest 3.x fix");
  assertEquals(isPatchedFastUriVersion("3.1.10"), true, "3.1.10+ is patched");
  assertEquals(isPatchedFastUriVersion("3.2.0"), true, "3.2.0+ is patched");
  assertEquals(isPatchedFastUriVersion("4.2.3"), true, "4.2.3 is the newest 4.x fix");
  assertEquals(isPatchedFastUriVersion("4.2.4"), true, "4.2.4+ is patched");
  assertEquals(isPatchedFastUriVersion("4.3.0"), true, "4.3.0+ is patched");

  // 2. Refused: every line of every advisory in the ledger, including the two
  //    versions this project previously certified (3.1.8 from 7jv95, and the
  //    2.x/4.x floors that message also named).
  assertEquals(isPatchedFastUriVersion("2.4.7"), false, "2.4.7 was the old 2.x floor and is <2.4.8 affected");
  assertEquals(isPatchedFastUriVersion("2.4.6"), false, "2.4.6 must be rejected (< 2.4.8 affected)");
  assertEquals(isPatchedFastUriVersion("2.3.9"), false, "2.3.9 must be rejected (< 2.4.8 affected)");
  assertEquals(isPatchedFastUriVersion("3.1.8"), false, "3.1.8 was the 7jv95 floor and is >=3.0.0 <3.1.9 affected");
  assertEquals(isPatchedFastUriVersion("3.1.7"), false, "3.1.7 must be rejected under GHSA-hrr3-gc8f-f4qj");
  assertEquals(isPatchedFastUriVersion("3.1.6"), false, "3.1.6 must be rejected under GHSA-58mr-gqgx-xq4g");
  assertEquals(isPatchedFastUriVersion("3.1.5"), false, "3.1.5 must be rejected under GHSA-qw65-cvwx-89v3");
  assertEquals(isPatchedFastUriVersion("3.0.0"), false, "3.0.0 must be rejected");
  assertEquals(isPatchedFastUriVersion("4.2.2"), false, "4.2.2 was the old 4.x line and is <4.2.3 affected");
  assertEquals(isPatchedFastUriVersion("4.1.5"), false, "4.1.5 was the 7jv95 4.x floor and is >=4.0.0 <4.2.3 affected");
  assertEquals(isPatchedFastUriVersion("4.0.0"), false, "4.0.0 must be rejected");

  // 3. Fail-closed: prereleases, non-semver, unknown majors
  assertEquals(isPatchedFastUriVersion("1.0.0"), false, "1.x must be rejected (no ledger row, fail-closed)");
  assertEquals(isPatchedFastUriVersion("5.0.0"), false, "unknown major 5.x must fail closed");
  assertEquals(isPatchedFastUriVersion("3.1.9-alpha.1"), false, "prereleases must fail closed");
  assertEquals(isPatchedFastUriVersion("4.2.3-beta"), false, "prereleases must fail closed");
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
