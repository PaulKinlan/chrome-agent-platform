/**
 * Chrome site access as Settings must show it — chrome-agent-platform-4dg.
 *
 * The ACTUAL grants Chrome holds, read live from `chrome.permissions.getAll()`.
 * Never the manifest's promise and never the agent/task policy layer: this is
 * the Chrome-state half of the acceptance ("Settings reflects actual Chrome
 * optional permissions and site access separately from agent/task policy").
 *
 * Two kinds of row, and the difference is what the owner can do about it:
 *
 * - an INSTALL grant (a pattern in the manifest's `host_permissions`) cannot be
 *   revoked from inside the extension — `chrome.permissions.remove` refuses a
 *   required permission — so its row is state only and names chrome://extensions,
 *   the surface Chrome owns.
 * - a RUNTIME grant (an approval prompt's exact origin, under an
 *   optional-host model) is revocable here, from the owner's genuine click:
 *   `chrome.permissions.remove` with exactly that pattern, nothing broader.
 */

/** A match pattern is not a URL and is never parsed as one: it is parsed by
 *  its own grammar here (`scheme://host/path`, wildcard host allowed). The
 *  URL constructor is the wrong tool — a wildcard host throws InvalidURL —
 *  so the pattern grammar is the contract. */
function parsePattern(raw) {
  const m = /^([a-z*]+):\/\/(\*|[^\/*" ]*)\/\*$/i.exec(String(raw).trim());
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), host: m[2] };
}

/** Truthful scope labels — chrome-agent-platform-4dg.1. A scheme-wide grant
 *  (one of the scheme-wildcard patterns) is not one address, so it never reads
 *  as one: "All HTTPS sites" / "All HTTP sites". The host-wildcard generic
 *  stays distinct from the fixed install row's "All sites" by NAME alone
 *  ("All sites (any scheme)"), because both rows can be on screen under some
 *  manifest. `<all_urls>` keeps the manifest's own idiom, "All sites"; an
 *  exact origin keeps its origin. */
export function siteAccessLabel(pattern) {
  const raw = String(pattern);
  if (raw === "<all_urls>") return "All sites";
  const p = parsePattern(raw);
  if (!p) return raw;
  if (p.host === "*") {
    if (p.scheme === "https") return "All HTTPS sites";
    if (p.scheme === "http") return "All HTTP sites";
    if (p.scheme === "*") return "All HTTP and HTTPS sites";
    if (p.scheme === "file") return "All local files";
    return `All ${p.scheme.toUpperCase()} sites`;
  }
  if (p.scheme === "file") return "All local files";
  return raw.replace(/\/\*$/, "") || raw;
}

/** The scope PHRASE for the row copy: what the grant covers, honestly, with no
 *  claim about who granted it or what revoking will do — Chrome does not
 *  attribute provenance and its removal answer is Chrome's (4dg.1). */
export function siteAccessScope(pattern) {
  const raw = String(pattern);
  if (raw === "<all_urls>") return "every site";
  const p = parsePattern(raw);
  if (!p) return "this entry";
  if (p.host !== "*") {
    if (p.scheme === "file") return "local files";
    return "one site";
  }
  if (p.scheme === "https") return "every HTTPS site";
  if (p.scheme === "http") return "every HTTP site";
  if (p.scheme === "*") return "every HTTP and HTTPS site";
  if (p.scheme === "file") return "local files";
  return "every site";
}

/**
 * The verified site-access view. `ok: false` means the read itself failed —
 * the caller shows honest words rather than a silently absent group.
 */
export async function siteAccessState(chromeApi, manifestPatterns) {
  let origins;
  try {
    origins = (await chromeApi.permissions.getAll())?.origins ?? [];
  } catch {
    return { ok: false, fixed: [], revocable: [] };
  }
  const declared = new Set(manifestPatterns ?? []);
  const fixed = [];
  const revocable = [];
  for (const pattern of origins) {
    (declared.has(pattern) ? fixed : revocable).push(pattern);
  }
  // Deterministic order: the same list every render, so a re-render never
  // reshuffles rows under the pointer.
  fixed.sort();
  revocable.sort();
  return { ok: true, fixed, revocable };
}

/** Revoke exactly one pattern from the owner's genuine click. Never broader:
 *  the request carries one origin and nothing else. */
export async function revokeSiteOrigin(chromeApi, pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  try {
    return (await chromeApi.permissions.remove({ origins: [pattern] })) === true;
  } catch {
    return false;
  }
}
