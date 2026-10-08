// lf9xe / im9q8: npm's installed lock is NOT the Deno store bundled into
// the extension. Pin the security-sensitive resolutions in both lockfiles.
import { assert, assertEquals } from "jsr:@std/assert@1";

const npmLock = JSON.parse(await Deno.readTextFile(new URL("../package-lock.json", import.meta.url)));
const denoLock = JSON.parse(await Deno.readTextFile(new URL("../deno.lock", import.meta.url)));

Deno.test("lf9xe: Deno and npm agree on an advisory-patched fast-uri tarball", () => {
  // GHSA-qw65-cvwx-89v3 and GHSA-58mr-gqgx-xq4g affect 3.0.0–3.1.6;
  // 3.1.7 is the first patched release on the 3.x line.
  const npm = npmLock.packages["node_modules/fast-uri"];
  assert(npm?.version && npm?.integrity, "npm must lock fast-uri with an integrity hash");
  const parts = npm.version.split(".").map(Number);
  assert(parts.length === 3 && parts.every(Number.isInteger) && parts[0] === 3 &&
    (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 7)),
  `fast-uri ${npm.version} is not verified patched on the 3.x advisory line`);
  const entries = Object.entries(denoLock.npm).filter(([name]) => name.startsWith("fast-uri@"));
  assertEquals(entries, [[`fast-uri@${npm.version}`, { integrity: npm.integrity }]],
    "Deno ships the npm-locked patched version and the same verified tarball, not an older .deno copy");
});

Deno.test("im9q8: MCP SDK resolution matches the npm runtime lock in every Deno peer context", () => {
  const npm = npmLock.packages["node_modules/@modelcontextprotocol/sdk"];
  assert(npm?.version, "npm must lock the runtime MCP SDK");
  const versions = [...new Set(Object.keys(denoLock.npm)
    .filter((name) => name.startsWith("@modelcontextprotocol/sdk@"))
    .map((name) => name.slice("@modelcontextprotocol/sdk@".length).split("_")[0]))];
  assertEquals(versions, [npm.version], "both zod-peer SDK instances must resolve the npm-locked version");
});
