// lib/fetch-policy.js — the pure policy behind the service worker's
// "cap:fetch" route (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01).
//
// A sandboxed script's `fetch` is bridged to the service worker, which fetches
// with the extension's host permission from the USER'S network position. Two
// things must therefore never happen without the owner seeing them:
//   1. a request to loopback / private / link-local addresses (SSRF into
//      localhost services, the intranet, router admin pages, cloud metadata);
//   2. a request to a host the owner did not see on the approval card (the
//      URL itself is an exfiltration channel: `?d=<memory>`).
// `isPrivateOrLoopbackHost` covers (1) for hostnames and IPv4/IPv6 literals
// (including the decimal/hex/octal single-number IPv4 forms the URL parser
// canonicalises, and IPv4-mapped IPv6). `checkFetchPolicy` applies (1) and the
// per-run host allow-list (2); with no registered run it allows nothing.
// `extractFetchHosts` derives that allow-list from the script source: every
// http(s) URL literal contributes its host; a `fetch(` whose target is not a
// plain string literal marks the script `dynamic` (the card shows that in
// red — only the listed hosts are ever permitted, so a computed target that
// resolves elsewhere is refused at run time).
//
// DNS rebinding of a listed public hostname is NOT covered here: the deny list
// works on the URL's host, not on the resolved address. The allow-list bounds
// the damage to hosts the owner explicitly approved.

const MAX_HOSTS = 64;

function ipv4Octets(host) {
  // The WHATWG URL parser already canonicalises "127.1", "2130706433" and
  // "0x7f000001" to dotted-quad form for http(s) URLs, so a plain dotted
  // quad is the common case; the other forms are accepted here so the
  // predicate is also safe on raw hostnames.
  if (!/^[0-9a-fA-Fx.]+$/.test(host) || host.length > 32) return null;
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  // The last part fills the remaining octets (the classic inet_aton forms).
  const last = nums.pop();
  const remaining = 4 - nums.length;
  if (last >= 256 ** remaining || nums.some((n) => n > 255)) return null;
  const tail = [];
  let v = last;
  for (let i = 0; i < remaining; i++) { tail.unshift(v % 256); v = Math.floor(v / 256); }
  return [...nums, ...tail];
}

function ipv4IsPrivate([a, b]) {
  if (a === 0) return true; // 0.0.0.0/8 ("this" network)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (+ cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function ipv6IsPrivate(literal) {
  const h = literal.toLowerCase().replace(/%.*$/, "");
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1" || h === "0:0:0:0:0:0:0:0") return true;
  // IPv4-mapped / -compatible: ::ffff:a.b.c.d or ::a.b.c.d
  const mapped = h.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const o = ipv4Octets(mapped[1]);
    return o ? ipv4IsPrivate(o) : true;
  }
  // ::ffff:7f00:1 hex-form mapped addresses
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    return ipv4IsPrivate([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  const first = h.split(":")[0];
  if (first === "") return true; // any other ::-prefixed compat form: refuse
  const n = parseInt(first, 16);
  if (!Number.isFinite(n)) return true;
  if ((n & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((n & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** True when `host` (a URL hostname, no port) is loopback / private /
 * link-local / unspecified — or malformed (fail closed). */
export function isPrivateOrLoopbackHost(host) {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.startsWith("[") && h.endsWith("]")) return ipv6IsPrivate(h.slice(1, -1));
  if (h.includes(":")) return ipv6IsPrivate(h);
  const octets = ipv4Octets(h);
  if (octets) return ipv4IsPrivate(octets);
  return false;
}

function hostKey(u) {
  // hostname + explicit port (a default port is dropped by the URL parser).
  return u.port ? `${u.hostname}:${u.port}` : u.hostname;
}

/** Decide whether a sandboxed script's fetch may proceed. `policy` is the
 * run's registered allow-list ({ hosts, dynamic }); absent → refuse. */
export function checkFetchPolicy(url, policy) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return { ok: false, error: "invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `protocol ${u.protocol} is not allowed` };
  }
  if (isPrivateOrLoopbackHost(u.hostname)) {
    return { ok: false, error: `fetch to ${u.hostname} refused: private or loopback address` };
  }
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.hosts)) {
    return { ok: false, error: "fetch refused: no approved script run is active" };
  }
  const key = hostKey(u).toLowerCase();
  const allowed = policy.hosts.some((h) => String(h).toLowerCase() === key);
  if (!allowed) {
    return { ok: false, error: `fetch to ${key} refused: not on this run's approved host list` };
  }
  return { ok: true, url: u.href };
}

const URL_LITERAL = /["'`](https?:\/\/[^\s"'`<>\\${}]+)["'`]/g;
const FETCH_CALL = /\bfetch\s*\(\s*([^)]*)/g;

/** The hosts a script source can reach (every http(s) URL literal) and
 * whether any fetch target is computed rather than a plain literal. */
export function extractFetchHosts(source) {
  const src = String(source ?? "");
  const hosts = [];
  const seen = new Set();
  for (const m of src.matchAll(URL_LITERAL)) {
    let u;
    try { u = new URL(m[1]); } catch { continue; }
    const key = hostKey(u).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (hosts.length < MAX_HOSTS) hosts.push(key);
  }
  let dynamic = false;
  for (const m of src.matchAll(FETCH_CALL)) {
    const arg = m[1].trim();
    // A plain single-token string literal with no interpolation is static;
    // anything else (an identifier, concatenation, a template with ${…}) is
    // a computed target.
    const literal = arg.match(/^(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*(?:,|$)/) ||
      arg.match(/^`((?:[^`\\$]|\\.|\$(?!\{))*)`\s*(?:,|$)/);
    if (!literal) { dynamic = true; break; }
  }
  return { hosts, dynamic };
}
