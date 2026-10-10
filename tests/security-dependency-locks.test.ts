// lf9xe / im9q8 / 7jv95: npm's installed lock is NOT the Deno store bundled into
// the extension. Pin the security-sensitive resolutions in both lockfiles.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isPatchedFastUriVersion } from "../scripts/bundle-budget.mjs";

const npmLock = JSON.parse(await Deno.readTextFile(new URL("../package-lock.json", import.meta.url)));
const denoLock = JSON.parse(await Deno.readTextFile(new URL("../deno.lock", import.meta.url)));

Deno.test("lf9xe / 7jv95: Deno and npm agree on an advisory-patched fast-uri tarball (>= 3.1.8)", () => {
  // GHSA-qw65-cvwx-89v3 affects 3.0.0–3.1.6; GHSA-58mr-gqgx-xq4g
  // affects only 3.1.6 on the 3.x line; GHSA-hrr3-gc8f-f4qj affects 3.0.0–3.1.7.
  // All three are patched in 3.1.8.
  const npm = npmLock.packages["node_modules/fast-uri"];
  assert(npm?.version && npm?.integrity, "npm must lock fast-uri with an integrity hash");
  assert(isPatchedFastUriVersion(npm.version),
    `fast-uri ${npm.version} is not verified patched on the 3.x advisory line (require >= 3.1.8)`);
  const parts = npm.version.split(".").map(Number);
  assert(parts.length === 3 && parts.every(Number.isInteger) && parts[0] === 3 &&
    (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 8)),
  `fast-uri ${npm.version} is not verified patched on the 3.x advisory line (require >= 3.1.8)`);
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
