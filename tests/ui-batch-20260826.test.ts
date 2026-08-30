// @ts-nocheck
// Owner UI batch (2026-08-26) KATs — CAP-FB-20260826-NTP-ADD-AGENT-01,
// -TOOL-LIBRARY-COUNT-01, -LOCAL-MODELS-HIDE-01, -APPROVALS-REMOVE-01,
// -SYSTEM-PROMPT-01. Small, static, surface-level assertions so an independent
// acceptance review can verify each fix landed without loading a browser.
import { assert, assertMatch, assertNotMatch } from "jsr:@std/assert@1";
import { MASTER_SKILL } from "../extension/lib/master-skill.js";

const read = (rel) =>
  Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test("NTP add-agent: the named-agent empty state carries the owner's requested affordance text", () => {
  const ntp = read("../extension/ntp/ntp.js");
  // The unified-agent empty state (owner directive 2026-08-28, revised
  // 2026-08-30 by CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01): create
  // with + OR browse the curated starter templates — never automatic.
  assertMatch(ntp, /No agents yet\. Choose a template or start from scratch\./, "empty-state text present");
  assertMatch(ntp, /add-starter-agents/, "the empty state offers the starter set");
  // the '+' button (new-agent) must open the NAMED-agent create dialog
  assertMatch(ntp, /openQuickCreateAgent/, "the + button routes to the named-agent quick-create");
  assertMatch(ntp, /named-agent\.create/, "quick-create persists via named-agent.create (not a site agent)");
});

Deno.test("Tool library: per-source row bound covers the full browser registry (count matches rows)", () => {
  const shadow = read("../extension/lib/tool-catalog-shadow.js");
  const m = shadow.match(/maxRowsPerSource:\s*(\d+)/);
  assert(m, "maxRowsPerSource bound present");
  const bound = Number(m[1]);
  assert(bound >= 130, `bound ${bound} must be >= the 130 browser tools so count == rendered rows`);
  // the component renders up to the same bound (no hidden 64-cap mismatch)
  const comp = read("../extension/shared/components.js");
  assertMatch(comp, /slice\(0, 256\)/, "component row slice aligned to the 256 bound");
});

Deno.test("Local models hidden: Settings no longer hosts the local-model catalog, Providers intact", () => {
  const html = read("../extension/options/options.html");
  assertNotMatch(html, /data-section="local-models"/, "Local models nav item removed");
  assertNotMatch(html, /<local-model-catalog/, "Local models section removed");
  assertMatch(html, /data-section="providers"/, "Providers section still present (cloud provider selection intact)");
  const js = read("../extension/options/options.js");
  assertNotMatch(js, /renderLocalModels/, "dead renderLocalModels wiring removed");
});

Deno.test("Approvals: the orphaned settings section is gone; revoke confirmation is now in-context", () => {
  const html = read("../extension/options/options.html");
  assertNotMatch(html, /id="approvals"/, "Approvals section removed");
  assertNotMatch(html, /data-section="approvals"/, "Approvals nav removed");
  const js = read("../extension/options/options.js");
  assertNotMatch(js, /renderApprovals/, "approvals settings-panel wiring removed");
  assertMatch(js, /runOwnerApprovedMutation/, "revoke confirmation routes through the in-context owner-approved mutation");
});

Deno.test("System prompt: search-once-then-execute guidance present and context-bounded", () => {
  assertMatch(MASTER_SKILL, /SEARCH ONCE, THEN ACT/, "one-search directive present");
  assertMatch(MASTER_SKILL, /search_tools/, "search_tools referenced");
  assertMatch(MASTER_SKILL, /list_tools/, "list_tools referenced");
  const bytes = new TextEncoder().encode(MASTER_SKILL).length;
  assert(bytes <= 32 * 1024, `MASTER_SKILL must stay context-bounded (${bytes} bytes <= 32 KiB)`);
});
