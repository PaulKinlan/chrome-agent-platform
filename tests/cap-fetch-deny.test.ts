// cap:fetch policy (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01): the
// host-side fetch a sandboxed script is bridged to must refuse loopback and
// private address ranges (SSRF from the user's network position) and any host
// the owner did not see on the approval card (the per-run allow-list). The
// predicate is pure so this test runs without a browser; the service worker's
// "cap:fetch" route calls exactly this function before fetching.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { checkFetchPolicy, extractFetchHosts, isPrivateOrLoopbackHost } from "../extension/lib/fetch-policy.js";

const PRIVATE = [
  "http://127.0.0.1/",
  "http://localhost/",
  "http://LOCALHOST:8080/x",
  "http://foo.localhost/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://172.31.255.254/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
  "http://[fe80::1]/",
  "http://[fc00::1]/",
  "http://[fd12:3456::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:10.0.0.1]/",
  "http://0.0.0.0/",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://017700000001/",
];

Deno.test("cap:fetch policy: every loopback / private / link-local address is refused", () => {
  for (const url of PRIVATE) {
    const res = checkFetchPolicy(url, { hosts: ["example.com", "127.0.0.1", "localhost", "10.1.2.3"], dynamic: true });
    assertEquals(res.ok, false, url);
    assert(String(res.error).includes("private or loopback address"), `${url}: ${res.error}`);
  }
});

Deno.test("cap:fetch policy: a public host is allowed on the run's allow-list and refused off it", () => {
  assertEquals(checkFetchPolicy("https://example.com/", { hosts: ["example.com"], dynamic: false }).ok, true);
  assertEquals(checkFetchPolicy("https://EXAMPLE.com:443/path", { hosts: ["example.com"], dynamic: false }).ok, true);
  const off = checkFetchPolicy("https://example.com/", { hosts: ["other.example"], dynamic: false });
  assertEquals(off.ok, false);
  assert(String(off.error).includes("not on this run's approved host list"), off.error);
  // A port is part of the approved host.
  assertEquals(checkFetchPolicy("https://example.com:8443/", { hosts: ["example.com"], dynamic: false }).ok, false);
  assertEquals(checkFetchPolicy("https://example.com:8443/", { hosts: ["example.com:8443"], dynamic: false }).ok, true);
  // No registered run → nothing is allowed (fail closed).
  assertEquals(checkFetchPolicy("https://example.com/", null).ok, false);
  assertEquals(checkFetchPolicy("https://example.com/", undefined).ok, false);
  // Only http(s).
  assertEquals(checkFetchPolicy("ftp://example.com/", { hosts: ["example.com"], dynamic: false }).ok, false);
  assertEquals(checkFetchPolicy("not a url", { hosts: ["example.com"], dynamic: false }).ok, false);
});

Deno.test("cap:fetch policy: the private predicate handles hostnames and literals directly", () => {
  for (const h of ["localhost", "a.b.localhost", "127.0.0.1", "10.0.0.0", "172.16.0.0", "172.31.1.1", "192.168.0.1", "169.254.1.1", "::1", "fe80::1", "fc00::", "fdff::1", "::ffff:192.168.0.1", "0.0.0.0", ""]) {
    assertEquals(isPrivateOrLoopbackHost(h), true, h);
  }
  for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "2606:4700::1111", "localhost.example.com"]) {
    assertEquals(isPrivateOrLoopbackHost(h), false, h);
  }
});

Deno.test("cap:fetch policy: hosts are extracted from URL literals; a computed fetch target is flagged dynamic", () => {
  const staticSrc = `const a = await fetch("https://api.example.com/v1?x=1");\nconst b = await fetch('http://feeds.example.org:8080/rss');\nreturn a.text + b.text;`;
  assertEquals(extractFetchHosts(staticSrc), { hosts: ["api.example.com", "feeds.example.org:8080"], dynamic: false });
  const dynamicSrc = "const base = 'https://api.example.com'; return (await fetch(base + '/?d=' + encodeURIComponent(secret))).text";
  assertEquals(extractFetchHosts(dynamicSrc), { hosts: ["api.example.com"], dynamic: true });
  // Template literals with interpolation are computed targets.
  assertEquals(extractFetchHosts("return await fetch(`https://${host}/x`)"), { hosts: [], dynamic: true });
  assertEquals(extractFetchHosts("return 1 + 1"), { hosts: [], dynamic: false });
  // Bounded: hosts are unique and capped.
  const many = Array.from({ length: 200 }, (_, i) => `fetch("https://h${i}.example/")`).join(";");
  assert(extractFetchHosts(many).hosts.length <= 64);
});

Deno.test("cap:fetch policy (v6ej): DNS-rebinding residual is formally registered in RISK-REGISTER and THREAT_MODEL", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const riskRegister = await Deno.readTextFile(join(root, "docs/RISK-REGISTER.md"));
  const r23 = riskRegister.split("### R23")[1]?.split("\n### ")[0];
  assert(r23 !== undefined, "RISK-REGISTER.md must define entry R23 for DNS-rebinding residual");
  assert(r23.includes("- **Risk:**"), "R23 must contain - **Risk:**");
  assert(r23.includes("- **Lives at:**"), "R23 must contain - **Lives at:**");
  assert(r23.includes("- **Mitigation:**"), "R23 must contain - **Mitigation:**");
  assert(r23.includes("- **Open question:**"), "R23 must contain - **Open question:**");
  assert(r23.includes("ADJUDICATED AND WITHHELD"), "R23 must be marked ADJUDICATED AND WITHHELD");
  assert(r23.includes("chrome-agent-platform-coord"), "R23 must name accepting decider");
  assert(r23.includes("REOPEN TRIGGER"), "R23 must specify reopen trigger");
  assert(r23.includes("extension/lib/fetch-policy.js:21"), "R23 must cite fetch-policy.js:21");
  assert(r23.includes("extension/lib/python-network.js:183"), "R23 must cite python-network.js:183");
  assert(r23.includes("extension/background/routes/enclave-proxy.js:348"), "R23 must cite enclave-proxy.js:348");
  assert(r23.includes("v6ej"), "R23 must cite bead v6ej");
  assert(r23.includes("TM-104"), "R23 must cite software factory TM-104 finding");

  const fetchPolicy = await Deno.readTextFile(join(root, "extension/lib/fetch-policy.js"));
  assert(fetchPolicy.includes("R23"), "fetch-policy.js must cite RISK-REGISTER.md R23 in header comment");

  const threatModel = await Deno.readTextFile(join(root, "THREAT_MODEL.md"));
  assert(threatModel.includes("Brokered fetch DNS rebinding (TM-104 / v6ej)"), "THREAT_MODEL.md must document DNS rebinding exclusion in §7");
  assert(threatModel.includes("chrome-agent-platform-coord"), "THREAT_MODEL.md §7 item 9 must name accepting decider");
  assert(threatModel.includes("**Register:** R23"), "THREAT_MODEL.md T6 must cross-reference register R23");
});

