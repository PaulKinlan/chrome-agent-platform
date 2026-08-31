import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
} from "jsr:@std/assert@1";
import {
  SITE_AGENT_COPY,
  enrollOutcomeState,
  siteAgentSetupMessage,
  siteAgentToolsMessage,
} from "../extension/shared/site-agent-copy.js";
import { WEBMCP_ERROR_BOUND, applyWebmcpLifecycle, boundWebmcpError } from "../extension/lib/pure.js";

const INTERNAL_CHATTER = /webmcp|inject(?:ed|ion)?|page[- ]report|scan(?:ned|ning)?/i;

Deno.test("site-agent copy: actions describe finding tools for a Site Agent", () => {
  assertEquals(SITE_AGENT_COPY.findToolsAction, "Find site tools");
  assertEquals(SITE_AGENT_COPY.pickerTitle, "Find tools for a Site Agent");
  assertMatch(SITE_AGENT_COPY.pickerHint, /choose a tab/i);
  assertMatch(SITE_AGENT_COPY.pickerHint, /tools/i);
  assertNotMatch(Object.values(SITE_AGENT_COPY).join("\n"), INTERNAL_CHATTER);
});

Deno.test("site-agent copy: normal setup state is concise and user-facing", () => {
  const message = siteAgentSetupMessage("checking", "https://shop.example");
  assertEquals(
    message,
    "Site Agent added for https://shop.example. Finding available tools…",
  );
  assertNotMatch(message, INTERNAL_CHATTER);
});

Deno.test("site-agent copy: error setup states explain recovery without leaking internals", () => {
  const reload = siteAgentSetupMessage("reload", "https://shop.example");
  assertMatch(reload, /reload the selected tab/i);
  assertNotMatch(reload, INTERNAL_CHATTER);

  const failed = siteAgentSetupMessage("failed", "https://shop.example");
  assertMatch(failed, /try again/i);
  assertNotMatch(failed, INTERNAL_CHATTER);
});

Deno.test("site-agent copy: scripting-denied surfaces the JIT ask honestly (never a silent empty picker)", () => {
  const denied = siteAgentSetupMessage("scripting-denied");
  assertMatch(denied, /scripting permission/i);
  assertMatch(denied, /try again/i);
  assertNotMatch(denied, INTERNAL_CHATTER);
  // It must not collapse into the generic failure copy — the user is told
  // exactly what to allow.
  assert(denied !== siteAgentSetupMessage("failed"));
});

Deno.test("site-agent copy: empty states distinguish no tabs, no Site Agent, and no tools", () => {
  const noTabs = siteAgentSetupMessage("no-tabs");
  assertMatch(noTabs, /open a page that exposes site tools/i);
  assertNotMatch(noTabs, INTERNAL_CHATTER);

  const notAdded = siteAgentToolsMessage("not-added");
  assertMatch(notAdded, /add a Site Agent/i);
  assertNotMatch(notAdded, INTERNAL_CHATTER);

  const noTools = siteAgentToolsMessage("empty");
  assertMatch(noTools, /no tools/i);
  assertMatch(noTools, /reload/i);
  assertNotMatch(noTools, INTERNAL_CHATTER);
});

Deno.test("site-agent copy: unknown states fail safely with actionable public copy", () => {
  const setup = siteAgentSetupMessage("unexpected", "https://shop.example");
  const tools = siteAgentToolsMessage("unexpected");
  assertMatch(setup, /try again/i);
  assertMatch(tools, /try again/i);
  assertNotMatch(`${setup}\n${tools}`, INTERNAL_CHATTER);
});

Deno.test("site-agent basic surfaces contain no diagnostic status row or old scan promises", async () => {
  const ntpHtml = await Deno.readTextFile("extension/ntp/ntp.html");
  const ntpJs = await Deno.readTextFile("extension/ntp/ntp.js");
  const optionsJs = await Deno.readTextFile("extension/options/options.js");
  const componentsJs = await Deno.readTextFile("extension/shared/components.js");
  const sidepanelHtml = await Deno.readTextFile("extension/sidepanel/sidepanel.html");
  const sidepanelJs = await Deno.readTextFile("extension/sidepanel/sidepanel.js");
  const basicCopy = `${ntpHtml}\n${sidepanelHtml}\n${sidepanelJs}`;

  // The hub's WebMCP discovery status line is PRESERVED on the current main
  // (the copy-cleanup candidate removed it; the WebMCP semantics stay) — it is
  // the honest SW-attested script lifecycle + page-reported counts, NOT
  // diagnostic chatter, so it remains while the basic rows carry no internals.
  assert(ntpHtml.includes('id="webmcp-hub-status"'), "the preserved WebMCP discovery status line must remain below the Site Agent rows");
  assert(ntpJs.includes("async function renderWebmcpHubStatus"), "the preserved WebMCP discovery status renderer must remain");
  assert(ntpJs.includes('row.setAttribute("action-label", "Choose")'), "tab choices need a clear action label");
  assert(
    componentsJs.includes('aria-label="${escapeHtml(actionLabel)} ${escapeHtml(name)}"'),
    "repeated action labels need the chosen tab name in their accessible name",
  );
  assert(!basicCopy.includes("Discover this page"));
  assert(!basicCopy.includes("injected JS"));
  assert(!ntpJs.includes("Pick the tab to scan"));
  assert(!optionsJs.includes("scripts registered"));
  assert(!optionsJs.includes("injected into"));
  assert(!optionsJs.includes("partially injected"));
});

Deno.test("site-agent diagnostics retain bounded technical detail off the basic rows", async () => {
  const optionsJs = await Deno.readTextFile("extension/options/options.js");
  assert(optionsJs.includes("Script status (attested):"));
  assert(optionsJs.includes("Injection:"));
  assert(optionsJs.includes("Page report:"));
  assert(optionsJs.includes("toLocaleString()"), "diagnostic observations need timestamps");
});

// The REAL SW enroll-origin response shapes (the attestable lifecycle fields).
const FULL_INJECTION = {
  ok: true,
  injection: { targets: 2, ready: ["t1", "t2"], partial: [], failed: [], scriptStatus: "registered" },
  injectionPartial: false,
};
const PARTIAL_INJECTION = {
  ok: true,
  injection: { targets: 2, ready: ["t1"], partial: ["t2"], failed: [], scriptStatus: "partial" },
  injectionPartial: true,
};
const NO_OPEN_TABS = {
  ok: true,
  injection: { targets: 0, ready: [], partial: [], failed: [], scriptStatus: "registered" },
  injectionPartial: false,
};
const INJECTION_ERROR = {
  ok: true,
  injection: { targets: 0, ready: [], partial: [], failed: [], scriptStatus: "injection-error", error: "scripting permission not granted" },
  injectionPartial: false,
};
const REGISTRATION_FAILURE = {
  ok: false,
  error: "script registration failed",
  retryable: true,
};

Deno.test("site-agent copy: the enrollment state matrix maps AUTHORITATIVE responses behaviorally", () => {
  // Branch FIRST on the attested script lifecycle / error.
  assertEquals(enrollOutcomeState(INJECTION_ERROR), "failed",
    "a top-level injection-error with targets:0 is a FAILURE, never next-load");
  assertEquals(enrollOutcomeState(REGISTRATION_FAILURE), "failed",
    "a registration failure is failed");
  assertEquals(enrollOutcomeState(FULL_INJECTION), "checking",
    "full per-tab injection into the open tabs is checking");
  assertEquals(enrollOutcomeState(PARTIAL_INJECTION), "reload-tabs",
    "a partial injection is reload-tabs (multi-tab — no selected-tab wording)");
  assertEquals(enrollOutcomeState(NO_OPEN_TABS), "next-load",
    "a clean registration with no open tabs is next-load");
  assertEquals(enrollOutcomeState({ ok: false, error: "" }), "failed",
    "an empty-error failure still fails closed");
});

Deno.test("site-agent copy: the SW-owned cap:webmcpStatus authority persists the bounded failure across reopen", () => {
  // The SW's recordWebmcpLifecycle path (applyWebmcpLifecycle) keeps the
  // bounded error in the persisted record — the renderWebmcpStatus reads it
  // back, so a failure never vanishes on reopen.
  const one = applyWebmcpLifecycle(null, {
    origin: "https://shop.example",
    scriptStatus: "injection-error",
    error: "scripting permission not granted",
  });
  const status = typeof one.scriptStatus === "string" ? one.scriptStatus : "";
  const error = typeof one.scriptError === "string" ? one.scriptError : "";
  assertEquals(status, "injection-error", "the attested failure status must persist");
  assert(error.length > 0 && error.length <= WEBMCP_ERROR_BOUND, "the bounded error must persist");
  // A "reopen" is a READ of the persisted record — the same record object
  // retains the error (it lives in the SW-owned cap:webmcpStatus KV, not a
  // page-local prepend that renderWebmcpStatus erases).
  const reopened = { ...one };
  assertEquals(typeof reopened.scriptError === "string" ? reopened.scriptError : "", error,
    "the persisted error must survive reopen");
  // A LATER write for the SAME origin (e.g. a fresh successful injection)
  // replaces the failure with the new lifecycle — that is the honest attestation.
  const two = applyWebmcpLifecycle(reopened, {
    origin: "https://shop.example",
    scriptStatus: "registered",
    injection: { targets: 1, ready: ["t1"], partial: [], failed: [] },
  });
  assertEquals(typeof two.scriptStatus === "string" ? two.scriptStatus : "", "registered");
  assertEquals(two.scriptError ?? null, null);
});

Deno.test("side panel companion: live region semantics + the Open/Enter transitions", async () => {
  const html = await Deno.readTextFile("extension/sidepanel/sidepanel.html");
  const js = await Deno.readTextFile("extension/sidepanel/sidepanel.js");
  // The companion (CAP-FB-20260830-SIDE-PANEL-COMPANION-01) announces the active
  // tab's tool state through a polite + atomic live region in the header; the
  // #status line keeps the same semantics for the Open/Enter transitions.
  assert(
    /id="status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/.test(html),
    "#status lacks role=status + aria-live=polite + aria-atomic=true",
  );
  assert(
    /id="tab-toolstate"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/.test(html),
    "#tab-toolstate lacks the polite + atomic live semantics",
  );
  // The tools chip region is still labelled for assistive tech.
  assert(
    /id="tools"[^>]*aria-label="Available tools on this page"/.test(html),
    "#tools lacks an accessible label",
  );
  // The Open/Enter success + failure transitions read honestly.
  assert(
    /Opened \$\{parsed\.origin\} in a new tab\./.test(js),
    "the Open success transition copy is missing",
  );
  assert(
    /Could not open tab:/.test(js) && /"Invalid URL"/.test(js),
    "the Open failure transitions are missing",
  );
  // The tool-state line uses honest, terse companion copy (no dead 'add a Site
  // Agent' framing on a surface that already knows the tab).
  assert(
    js.includes("function setToolState") && js.includes("No site tools added") && js.includes("Offers "),
    "the tool-state states do not use the honest companion copy",
  );
});

Deno.test("site-agent copy: the centralized vocabulary is the ACTUAL consumer authority across every visible surface", async () => {
  const surfaces = ["extension/options/options.html", "extension/options/options.js", "extension/sidepanel/sidepanel.html",
    "extension/sidepanel/sidepanel.js", "extension/chat/chat.html", "extension/chat/chat.js",
    "extension/directory/directory.js", "extension/memory/explorer.html", "extension/memory/explorer.js",
    "extension/ntp/ntp.html", "extension/ntp/ntp.js", "extension/shared/conversation.js",
    "extension/shared/components.js", "extension/shared/agent-candidates.js",
    "extension/lib/capabilities.js", "extension/lib/browser-tools.js",
    "extension/background/service-worker.js"];
  let all = "";
  for (const path of surfaces) all += await Deno.readTextFile(path) + "\n";
  // The case-insensitive inventory: no lowercase-'a' 'site agent(s)' form and
  // no 'sub-agent' visible copy anywhere.
  assert(!/site agents?/i.test(all.replace(/Site Agents?/g, "")), "a lowercase site-agent form remains visible");
  assert(!/sub-agent|subagent/i.test(all), "sub-agent copy remains visible");
  assert(!/@mention a site agent/.test(all), "the site-only mention hint remains");
  // The removal action uses the centralized label.
  assert(all.includes("Remove Site Agent"), "the removal action is not the centralized label");
  // Only VISIBLE Disenroll copy is banned — the identifier names
  // (disenroll-origin, the local const) are not user-facing.
  assert(!/textContent\s*=\s*"Disenroll"|>Disenroll<|"Disenroll \$\{|Disenroll for \$\{origin\}/.test(all),
    "visible Disenroll copy remains");
  // findToolsAction is CONSUMED at runtime (a static label alone would be a
  // dead constant — the ntp must read the authority on DOMContentLoaded).
  const ntp = await Deno.readTextFile("extension/ntp/ntp.js");
  assert(
    /discover-page[\s\S]*SITE_AGENT_COPY\.findToolsAction/.test(ntp),
    "findToolsAction is not consumed by the ntp discover action at runtime",
  );
});

Deno.test("site-agent copy: the shared mapper keeps the NTP selected-tab recovery + the Settings multi-tab wording", () => {
  // The NTP picker HAS a chosen tab: a partial injection keeps the exact-tab
  // reload wording; Settings (multi-tab) gets the reload-tabs wording.
  assertEquals(enrollOutcomeState(PARTIAL_INJECTION, { selectedTab: true }), "reload");
  assertEquals(enrollOutcomeState(PARTIAL_INJECTION, { selectedTab: false }), "reload-tabs");
  // The error-first branch wins over the selected-tab detail.
  assertEquals(enrollOutcomeState(INJECTION_ERROR, { selectedTab: true }), "failed");
});

Deno.test("site-agent copy: the diagnostics bound is ONE constant — a surrogate-safe UTF-16 code-unit ceiling", () => {
  // The persisted error is bounded in UTF-16 CODE UNITS (JS string length) by
  // the single constant — never bytes and never a code-point count.
  const hostileLong = "e".repeat(500);
  const bounded = boundWebmcpError(hostileLong);
  assert(typeof bounded === "string" && bounded.length === WEBMCP_ERROR_BOUND,
    `a 500-unit hostile string must be truncated exactly to ${WEBMCP_ERROR_BOUND} code units`);

  const emoji = String.fromCharCode(0xD83D, 0xDE00); // U+1F600
  assertEquals(emoji.length, 2, "the emoji is two code units");
  // Emoji at offset 0: the ceiling lands exactly on the pair boundary.
  const boundedMb = boundWebmcpError(emoji.repeat(400));
  assert(typeof boundedMb === "string" && boundedMb.length === WEBMCP_ERROR_BOUND,
    "multibyte content is truncated at the code-unit ceiling");
  assert(!/[\uD800-\uDBFF]$/.test(boundedMb), "a lone trailing high surrogate must be dropped");

  // MIXED boundary: an ASCII prefix pushes the truncation INSIDE the emoji
  // pair — the ceiling must drop the unpaired high surrogate (239 code units).
  const mixed = "a" + emoji.repeat(400);
  const rawMixed = boundWebmcpError(mixed);
  const boundedMixed = typeof rawMixed === "string" ? rawMixed : "";
  assertEquals(typeof boundedMixed === "string" ? boundedMixed.length : -1, WEBMCP_ERROR_BOUND - 1,
    "the mixed boundary must drop the unpaired high surrogate (239 units)");
  assert(!/[\uD800-\uDBFF]$/.test(boundedMixed), "no lone HIGH surrogate may be persisted at the end");
  // No unpaired high surrogate anywhere + the emoji count matches the code-unit math.
  let lone = false;
  for (let i = 0; i < boundedMixed.length; i++) {
    const code = boundedMixed.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = boundedMixed.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) lone = true;
      i += 1;
    }
  }
  assert(!lone, "no unpaired high surrogate survives");
  assertEquals([...boundedMixed].filter((c) => c === emoji).length, Math.floor((WEBMCP_ERROR_BOUND - 1) / 2),
    "the emoji count matches the code-unit math");
});

Deno.test("site-agent copy: the NTP picker + the SW final authority-loss use the shared error-first contract", async () => {
  const ntp = await Deno.readTextFile("extension/ntp/ntp.js");
  assert(ntp.includes("enrollOutcomeState(res, { selectedTab: true })"),
    "the NTP picker does not consume the shared mapper with the selected-tab recovery");
  assert(!/res\.pickedTabReady === true/.test(ntp), "the old pickedTabReady matrix remains");
  const sw = await Deno.readTextFile("extension/background/service-worker.js");
  // The final authority-loss path records the lifecycle BEFORE the ok:false.
  const i = sw.indexOf("scripting was disabled during enrollment — retry");
  assert(i >= 0, "the authority-loss error is missing");
  const before = sw.slice(Math.max(0, i - 400), i);
  assert(before.includes("recordWebmcpLifecycle"), "the authority loss is not recorded in the SW diagnostics before ok:false");
  const after = sw.slice(i, i + 200);
  assert(after.includes("ok: false"), "the authority loss does not return ok:false");
});