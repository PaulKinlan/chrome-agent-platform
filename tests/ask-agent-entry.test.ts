// tests/ask-agent-entry.test.ts — chrome-agent-platform-3p3e.2
//
// The product-owned "Ask agent about this page / selection / link / image"
// entry points: the right-click menu that exists only under the contextMenus
// grant, the click → composer-prefill projection (page text tagged untrusted
// and FENCED in the run's attachment context), the storage.session hand-off
// (never a URL carrying page text), the fourth keyboard command, and the
// service-worker wiring. Every assertion here was observed RED against
// origin/main before the change (the falsification record is in the bead).
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  ASK_AGENT_COMMAND,
  ASK_AGENT_MENU_IDS,
  ASK_AGENT_MENU_ITEMS,
  ASK_AGENT_MENU_PARENT_ID,
  ASK_AGENT_PREFILL_PREFIX,
  ASK_AGENT_PREFILL_TTL_MS,
  applyAskAgentPrefill,
  askAgentHubUrl,
  askAgentPrefillForTab,
  askAgentPrefillFromClick,
  askAgentPrefillKey,
  askAgentPrefillTabId,
  hydrateAskAgentImage,
  registerProductContextMenus,
  removeProductContextMenus,
  storeAskAgentPrefill,
  takeAskAgentPrefill,
} from "../extension/lib/ask-agent-entry.js";
import { attachmentContext as attachmentContextImpl, sanitizeAttachments, validateRunAttachments } from "../extension/lib/attachments.js";
// deno-lint-ignore no-explicit-any
const attachmentContext = attachmentContextImpl as (attachments: any[], opts?: { untrustedToken?: string | null }) => string;
import { KEYBOARD_COMMANDS, hubUrlForCommand } from "../extension/lib/pure.js";
import { parseNtpHash as parseNtpHashImpl } from "../extension/lib/navigation-controller.js";
// deno-lint-ignore no-explicit-any
const parseNtpHash = parseNtpHashImpl as (hash: string) => any;
import { CAPABILITIES } from "../extension/lib/capabilities.js";
import { classifyKvKey } from "../extension/lib/archive-target-registry.js";

const ROOT = new URL("..", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, ROOT));

// ── a fake chrome: optional-permission semantics + callback-style menus ─────
function fakeChrome({ granted = false }: { granted?: boolean } = {}) {
  const state = {
    granted,
    menus: new Map<string, any>(),
    addedListeners: [] as Array<(p: any) => void>,
    removedListeners: [] as Array<(p: any) => void>,
    session: new Map<string, any>(),
    lastError: null as null | { message: string },
  };
  const contextMenus = {
    create(props: any, cb?: () => void) {
      state.lastError = null;
      if (state.menus.has(props.id)) state.lastError = { message: `Cannot create item with duplicate id ${props.id}` };
      else state.menus.set(props.id, { ...props });
      cb?.();
      state.lastError = null;
      return props.id;
    },
    remove(id: string, cb?: () => void) {
      state.lastError = null;
      if (!state.menus.has(id)) state.lastError = { message: `Cannot find menu item with id ${id}` };
      else {
        state.menus.delete(id);
        for (const [k, v] of [...state.menus]) if (v.parentId === id) state.menus.delete(k);
      }
      cb?.();
      state.lastError = null;
    },
  };
  const chrome: any = {
    runtime: { get lastError() { return state.lastError; }, getURL: (p: string) => `chrome-extension://cap/${p}` },
    permissions: {
      contains: ({ permissions }: { permissions: string[] }) =>
        Promise.resolve(permissions.every((p) => p !== "contextMenus" || state.granted)),
      onAdded: { addListener: (fn: (p: any) => void) => state.addedListeners.push(fn) },
      onRemoved: { addListener: (fn: (p: any) => void) => state.removedListeners.push(fn) },
    },
    storage: {
      session: {
        get: (key: string) => Promise.resolve(state.session.has(key) ? { [key]: state.session.get(key) } : {}),
        set: (obj: Record<string, unknown>) => { for (const [k, v] of Object.entries(obj)) state.session.set(k, v); return Promise.resolve(); },
        remove: (key: string) => { state.session.delete(key); return Promise.resolve(); },
      },
    },
  };
  // Chrome injects the API object only while the permission is held.
  Object.defineProperty(chrome, "contextMenus", { get: () => (state.granted ? contextMenus : undefined), enumerable: true });
  const grant = async () => {
    state.granted = true;
    for (const fn of state.addedListeners) await fn({ permissions: ["contextMenus"], origins: [] });
  };
  const revoke = async () => {
    for (const fn of state.removedListeners) await fn({ permissions: ["contextMenus"], origins: [] });
    state.granted = false;
  };
  return { chrome, state, grant, revoke };
}

// The service worker's own wiring shape, replicated against the fake: register
// on grant, remove on revoke (the SW does the same with the real `chrome`).
function wireLikeTheServiceWorker(chrome: any) {
  chrome.permissions.onAdded.addListener(async (perms: any) => {
    if (perms?.permissions?.includes("contextMenus")) await registerProductContextMenus(chrome);
  });
  chrome.permissions.onRemoved.addListener(async (perms: any) => {
    if (perms?.permissions?.includes("contextMenus")) await removeProductContextMenus(chrome);
  });
}

Deno.test("ask-agent menu: without the permission nothing is created and nothing throws", async () => {
  const { chrome, state } = fakeChrome({ granted: false });
  const r = await registerProductContextMenus(chrome);
  assertEquals(r.ok, false);
  assertEquals(r.ids, []);
  assertEquals(state.menus.size, 0);
});

Deno.test("ask-agent menu: after permissions.onAdded exactly 1 parent + 4 children exist with the expected contexts", async () => {
  const { chrome, state, grant } = fakeChrome();
  wireLikeTheServiceWorker(chrome);
  await grant();
  assertEquals(state.menus.size, 5);
  const parent = state.menus.get(ASK_AGENT_MENU_PARENT_ID);
  assert(parent, "the Agent parent exists");
  assertEquals(parent.title, "Agent");
  assertEquals([...parent.contexts].sort(), ["image", "link", "page", "selection"]);
  const children = [...state.menus.values()].filter((m) => m.parentId === ASK_AGENT_MENU_PARENT_ID);
  assertEquals(children.length, 4);
  const byVariant = Object.fromEntries(ASK_AGENT_MENU_ITEMS.map((i) => [i.variant, state.menus.get(i.id)]));
  assertEquals(byVariant.page.contexts, ["page"]);
  assertEquals(byVariant.selection.contexts, ["selection"]);
  assertEquals(byVariant.link.contexts, ["link"]);
  assertEquals(byVariant.image.contexts, ["image"]);
  assertEquals(byVariant.page.title, "Ask agent about this page");
  assertEquals(byVariant.selection.title, "Ask agent about selection");
  assertEquals(byVariant.link.title, "Ask agent about this link");
  assertEquals(byVariant.image.title, "Ask agent about this image");
});

Deno.test("ask-agent menu: after permissions.onRemoved none remain", async () => {
  const { chrome, state, grant, revoke } = fakeChrome();
  wireLikeTheServiceWorker(chrome);
  await grant();
  assertEquals(state.menus.size, 5);
  await revoke();
  assertEquals(state.menus.size, 0);
});

Deno.test("ask-agent menu: registering twice is idempotent — the same 5 ids, no duplicate-id error", async () => {
  const { chrome, state } = fakeChrome({ granted: true });
  const first = await registerProductContextMenus(chrome);
  const second = await registerProductContextMenus(chrome);
  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
  assertEquals(first.ids, second.ids);
  assertEquals(first.ids, [...ASK_AGENT_MENU_IDS]);
  assertEquals(state.menus.size, 5);
});

Deno.test("ask-agent menu: removal only touches the product's own ids (a model-created item survives)", async () => {
  const { chrome, state } = fakeChrome({ granted: true });
  chrome.contextMenus.create({ id: "model-made", title: "Save quote", contexts: ["selection"] });
  await registerProductContextMenus(chrome);
  assertEquals(state.menus.size, 6);
  const removed = await removeProductContextMenus(chrome);
  assertEquals(removed.length, 5);
  assertEquals([...state.menus.keys()], ["model-made"]);
});

// ── the click → prefill projection ─────────────────────────────────────────
const TAB = { id: 42, title: "Example Domain", url: "https://example.com/a?b=1" };

Deno.test("ask-agent click: selection → a text attachment tagged untrusted (5 bytes) plus the page as a tab attachment", () => {
  const p = askAgentPrefillFromClick(
    { menuItemId: "cap-ask-agent-selection", selectionText: "hello", pageUrl: TAB.url },
    TAB,
    { now: 1000 },
  );
  assert(p, "a product item projects a prefill");
  assertEquals(p.variant, "selection");
  assertEquals(p.tabId, 42);
  assertEquals(p.createdAt, 1000);
  assertEquals(p.attachments.length, 2);
  const [sel, page] = p.attachments;
  assertEquals(sel.kind, "text");
  assertEquals(sel.untrusted, true);
  assertEquals(sel.size, 5);
  assertEquals(sel.type, "text/plain");
  assertEquals(sel.name, "Selection (5 chars)");
  assert(sel.dataURL.startsWith("data:text/plain;charset=utf-8;base64,"));
  assertEquals(atob(sel.dataURL.split(",")[1]), "hello");
  assertEquals(page.kind, "tab");
  assertEquals(page.url, TAB.url);
  assertEquals(page.tabId, 42);
  assertEquals(page.untrusted, true);
  assertEquals(page.name, "Example Domain");
  // The attachments pass the run's dataURL validator unchanged.
  assertEquals(validateRunAttachments(p.attachments).dropped, []);
  // The text is page-controlled: it is never in the prefill text itself.
  assertEquals(p.text.includes("hello"), false);
});

Deno.test("ask-agent click: link and image variants produce their own attachment kinds, each with the page", () => {
  const link = askAgentPrefillFromClick(
    { menuItemId: "cap-ask-agent-link", linkUrl: "https://docs.example.org/x", pageUrl: TAB.url },
    TAB,
  )!;
  assertEquals(link.variant, "link");
  assertEquals(link.attachments.map((a: any) => a.kind), ["link", "tab"]);
  assertEquals(link.attachments[0].url, "https://docs.example.org/x");
  assertEquals(link.attachments[0].untrusted, true);
  assertEquals(link.attachments[0].name, "Link: docs.example.org");

  const image = askAgentPrefillFromClick(
    { menuItemId: "cap-ask-agent-image", srcUrl: "https://cdn.example.org/pic.png", pageUrl: TAB.url },
    TAB,
  )!;
  assertEquals(image.variant, "image");
  assertEquals(image.attachments.map((a: any) => a.kind), ["image", "tab"]);
  assertEquals(image.attachments[0].srcUrl, "https://cdn.example.org/pic.png");
  assertEquals("url" in image.attachments[0], false, "an image reference is never mistaken for a tab");
  assertEquals(image.attachments[0].dataURL, undefined, "bytes are hydrated separately, bounded");

  const page = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-page", pageUrl: TAB.url }, TAB)!;
  assertEquals(page.variant, "page");
  assertEquals(page.attachments.map((a: any) => a.kind), ["tab"]);
});

Deno.test("ask-agent click: an unknown menu id is not ours (null), an empty selection degrades to the page", () => {
  assertEquals(askAgentPrefillFromClick({ menuItemId: "model-made", selectionText: "x" }, TAB), null);
  const p = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-selection", selectionText: "   ", pageUrl: TAB.url }, TAB)!;
  assertEquals(p.variant, "page");
  assertEquals(p.attachments.length, 1);
});

Deno.test("ask-agent click: a javascript:/chrome: page or link never becomes an attachment", () => {
  const p = askAgentPrefillFromClick(
    { menuItemId: "cap-ask-agent-link", linkUrl: "javascript:alert(1)", pageUrl: "chrome://settings" },
    { id: 7, url: "chrome://settings" },
  )!;
  assertEquals(p.variant, "page");
  assertEquals(p.attachments, []);
});

Deno.test("ask-agent command: the page variant for the active tab", () => {
  const p = askAgentPrefillForTab(TAB, { now: 5 });
  assertEquals(p.variant, "page");
  assertEquals(p.tabId, 42);
  assertEquals(p.attachments[0].kind, "tab");
  assertEquals(p.attachments[0].untrusted, true);
});

// ── the run: the selection reaches the model INSIDE the fence ──────────────
Deno.test("attachmentContext: an untrusted text attachment is fenced with the run's token; a trusted one is not", () => {
  const sel = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-selection", selectionText: "hello", pageUrl: TAB.url }, TAB)!.attachments[0];
  const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const fenced = attachmentContext([sel], { untrustedToken: token });
  assertStringIncludes(fenced, `<<<UNTRUSTED run:${token}>>>\nhello\n<<<END run:${token}>>>`);
  // The same bytes without the untrusted tag (an owner's own file) stay unfenced.
  const trusted = attachmentContext([{ ...sel, untrusted: false }], { untrustedToken: token });
  assertEquals(trusted.includes("<<<UNTRUSTED"), false);
  assertStringIncludes(trusted, "hello");
});

Deno.test("attachmentContext: untrusted tab/link lines are fenced too, and an image reference names its source", () => {
  const token = "ffeeddccbbaa99887766554433221100";
  const click = askAgentPrefillFromClick(
    { menuItemId: "cap-ask-agent-link", linkUrl: "https://docs.example.org/x", pageUrl: TAB.url },
    TAB,
  )!;
  const ctx = attachmentContext(click.attachments, { untrustedToken: token });
  const opens = ctx.split(`<<<UNTRUSTED run:${token}>>>`).length - 1;
  assertEquals(opens, 2, "the link line and the page line are each fenced");
  assertStringIncludes(ctx, "[link: ");
  assertStringIncludes(ctx, "https://docs.example.org/x");
  const image = askAgentPrefillFromClick(
    { menuItemId: "cap-ask-agent-image", srcUrl: "https://cdn.example.org/pic.png", pageUrl: TAB.url },
    TAB,
  )!;
  const imgCtx = attachmentContext([image.attachments[0]], { untrustedToken: token });
  assertStringIncludes(imgCtx, "[image: https://cdn.example.org/pic.png");
  assertEquals(imgCtx.includes("[tab:"), false, "srcUrl never reads as a tab");
});

Deno.test("attachmentContext: without a token an untrusted attachment is still labelled as data, never raw", () => {
  const sel = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-selection", selectionText: "hello", pageUrl: TAB.url }, TAB)!.attachments[0];
  const ctx = attachmentContext([sel]);
  assertStringIncludes(ctx, "hello");
  assertStringIncludes(ctx, "<<<UNTRUSTED run:");
});

Deno.test("sanitizeAttachments: the untrusted tag survives persistence (a continuation re-fences it)", () => {
  const sel = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-selection", selectionText: "hello", pageUrl: TAB.url }, TAB)!.attachments[0];
  const kept = sanitizeAttachments([sel, { name: "mine.txt", type: "text/plain", size: 1, kind: "file", dataURL: "" }])!;
  // deno-lint-ignore no-explicit-any
  assertEquals((kept[0] as any).untrusted, true);
  assertEquals("untrusted" in kept[1], false, "a trusted attachment gains no tag");
});

// ── image bytes: bounded, typed, never fatal ───────────────────────────────
function fakeResponse({ ok = true, status = 200, type = "image/png", bytes = new Uint8Array([137, 80, 78, 71]), length = null as number | null } = {}) {
  const headers = new Map<string, string>([["content-type", type]]);
  // deno-lint-ignore no-explicit-any
  const asFetch = (r: unknown) => r as any;
  if (length != null) headers.set("content-length", String(length));
  return asFetch({ ok, status, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null }, arrayBuffer: () => Promise.resolve(bytes.buffer) });
}

Deno.test("hydrateAskAgentImage: fills a typed dataURL within the bound; refuses non-images and oversize bodies", async () => {
  const att = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-image", srcUrl: "https://cdn.example.org/p.png", pageUrl: TAB.url }, TAB)!.attachments[0];
  const okRes = await hydrateAskAgentImage(att, { fetchImpl: () => Promise.resolve(fakeResponse()) });
  assertEquals(okRes.ok, true);
  assertEquals(att.type, "image/png");
  assertEquals(att.size, 4);
  assert(att.dataURL.startsWith("data:image/png;base64,"));
  assertEquals(validateRunAttachments([att]).dropped, []);

  const html = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-image", srcUrl: "https://cdn.example.org/p.png", pageUrl: TAB.url }, TAB)!.attachments[0];
  const notImage = await hydrateAskAgentImage(html, { fetchImpl: () => Promise.resolve(fakeResponse({ type: "text/html" })) });
  assertEquals(notImage.ok, false);
  assertEquals(html.dataURL, undefined);

  const big = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-image", srcUrl: "https://cdn.example.org/p.png", pageUrl: TAB.url }, TAB)!.attachments[0];
  const tooBig = await hydrateAskAgentImage(big, { fetchImpl: () => Promise.resolve(fakeResponse({ bytes: new Uint8Array(10) })), maxBytes: 4 });
  assertEquals(tooBig.ok, false);
  assertEquals(big.dataURL, undefined);

  const dead = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-image", srcUrl: "https://cdn.example.org/p.png", pageUrl: TAB.url }, TAB)!.attachments[0];
  const threw = await hydrateAskAgentImage(dead, { fetchImpl: () => Promise.reject(new Error("offline")) });
  assertEquals(threw.ok, false);
  assertStringIncludes(threw.reason!, "offline");
});

// ── the hand-off: storage.session keyed by tab, consumed once, expiring ────
Deno.test("prefill hand-off: stored under the tab's key, taken exactly once, expired after the TTL", async () => {
  const { chrome, state } = fakeChrome();
  const p = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-selection", selectionText: "hello", pageUrl: TAB.url }, TAB, { now: 10_000 });
  const stored = await storeAskAgentPrefill(chrome, p);
  assertEquals(stored.ok, true);
  assertEquals(stored.key, `${ASK_AGENT_PREFILL_PREFIX}42`);
  assertEquals(askAgentPrefillKey(42), stored.key);
  assertEquals(askAgentPrefillTabId(stored.key!), 42);
  assertEquals(askAgentPrefillTabId("cap:sidepanelTarget"), null);
  assertEquals(state.session.size, 1);

  const taken = await takeAskAgentPrefill(chrome, 42, { now: 11_000 });
  assertEquals(taken?.variant, "selection");
  assertEquals(state.session.size, 0, "take removes the record");
  assertEquals(await takeAskAgentPrefill(chrome, 42, { now: 11_000 }), null, "a second take finds nothing");

  await storeAskAgentPrefill(chrome, p);
  assertEquals(await takeAskAgentPrefill(chrome, 42, { now: 10_000 + ASK_AGENT_PREFILL_TTL_MS + 1 }), null, "a stale click never resurfaces");
  assertEquals(state.session.size, 0, "the stale record is cleared, not left behind");
  assertEquals(await takeAskAgentPrefill(chrome, 99), null, "another tab's key is empty");
});

Deno.test("prefill hand-off: a quota failure keeps the references and drops only the image bytes", async () => {
  const { chrome, state } = fakeChrome();
  let calls = 0;
  chrome.storage.session.set = (obj: Record<string, any>) => {
    calls++;
    const json = JSON.stringify(obj);
    if (json.includes("base64,")) return Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
    for (const [k, v] of Object.entries(obj)) state.session.set(k, v);
    return Promise.resolve();
  };
  const p = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-image", srcUrl: "https://cdn.example.org/p.png", pageUrl: TAB.url }, TAB);
  p!.attachments[0].dataURL = "data:image/png;base64,AAAA";
  const r = await storeAskAgentPrefill(chrome, p);
  assertEquals(r.ok, true);
  assertEquals(calls, 2);
  assert(r.degraded);
  const kept = await takeAskAgentPrefill(chrome, 42);
  assertEquals(kept!.attachments[0].kind, "image");
  assertEquals(kept!.attachments[0].dataURL, "");
  assertEquals(kept!.attachments[0].srcUrl, "https://cdn.example.org/p.png");
});

Deno.test("prefill: a missing tab id is refused rather than stored under a shared key", async () => {
  const { chrome } = fakeChrome();
  const r = await storeAskAgentPrefill(chrome, askAgentPrefillForTab({ url: TAB.url }));
  assertEquals(r.ok, false);
  assertEquals(askAgentPrefillKey(null), null);
  assertEquals(askAgentPrefillKey(-1), null);
  assertEquals(askAgentPrefillKey("x"), null);
});

Deno.test("prefill: applying to a composer sets the text, adds every attachment as a chip, focuses — and never sends", () => {
  const added: any[] = [];
  let focused = 0, sent = 0;
  const composer = { value: "", addAttachment: (a: any) => added.push(a), focusInput: () => { focused++; }, _send: () => { sent++; } };
  const p = askAgentPrefillFromClick({ menuItemId: "cap-ask-agent-selection", selectionText: "hello", pageUrl: TAB.url }, TAB)!;
  assertEquals(applyAskAgentPrefill(composer, p), true);
  assertEquals(composer.value, "Explain this selection.");
  assertEquals(added.length, 2);
  assertEquals(added[0].name, "Selection (5 chars)");
  assertEquals(focused, 1);
  assertEquals(sent, 0);
  assertEquals(applyAskAgentPrefill(composer, null), false);
});

// ── the hub fallback carries the tab id only ───────────────────────────────
Deno.test("hub fallback: #ask-agent=<tabId> is its own route and carries no text", () => {
  const getURL = (p: string) => `chrome-extension://cap/${p}`;
  assertEquals(askAgentHubUrl(getURL, 42), "chrome-extension://cap/ntp/ntp.html#ask-agent=42");
  assertEquals(askAgentHubUrl(getURL, null), "chrome-extension://cap/ntp/ntp.html");
  assertEquals(parseNtpHash("#ask-agent=42"), { route: "ask-agent", tabId: 42 });
  assertEquals(parseNtpHash("#ask-agent=hello"), { route: "hub" });
  assertEquals(parseNtpHash("#ask-agent="), { route: "hub" });
  // The keyboard command's hub URL is still the plain hub (no payload).
  assertEquals(hubUrlForCommand(ASK_AGENT_COMMAND, getURL), "chrome-extension://cap/ntp/ntp.html");
});

// ── the fourth keyboard command ────────────────────────────────────────────
Deno.test("commands: ask-about-page is the fourth declared command, with a mac + default chord and a description", async () => {
  assertEquals(KEYBOARD_COMMANDS, ["open-hub", "new-task", "open-side-panel", ASK_AGENT_COMMAND]);
  const manifest = JSON.parse(await read("extension/manifest.json"));
  const cmd = manifest.commands[ASK_AGENT_COMMAND];
  assert(cmd, "manifest declares ask-about-page");
  assertEquals(cmd.suggested_key.default, "Alt+Shift+A");
  assertEquals(cmd.suggested_key.mac, "Alt+Shift+A");
  assert(typeof cmd.description === "string" && cmd.description.length > 0);
  // A chord must not collide with an existing one.
  const chords = Object.values(manifest.commands).map((c: any) => c.suggested_key?.default);
  assertEquals(new Set(chords).size, chords.length);
});

// ── copy + storage classification ──────────────────────────────────────────
Deno.test("Settings → Permissions: the Context menus row names the Ask agent entries", () => {
  const row = CAPABILITIES.find((c) => c.id === "contextMenus")!;
  assert(row, "the contextMenus capability row exists");
  assertStringIncludes(row.hint, "Ask agent");
  assertStringIncludes(row.gates, "Ask agent");
});

Deno.test("storage registry: the prefill key is ephemeral; the banner dismissal is a portable preference", () => {
  assertEquals(classifyKvKey(`${ASK_AGENT_PREFILL_PREFIX}42`).cls, "ephemeral");
  assertEquals(classifyKvKey("cap:ask-agent-menu-banner-dismissed").cls, "portable-user-data");
});

// ── the service-worker wiring (source-level pins on LIVE call sites) ──────
Deno.test("service worker: registers on grant/install/boot, removes on revoke, routes the click and the command, fences the context", async () => {
  const sw = await read("extension/background/service-worker.js");
  const live = sw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^\s*import\b/.test(l)).join("\n");
  const count = (needle: string) => live.split(needle).length - 1;
  // module eval + runtime.onInstalled + permissions.onAdded — three live triggers
  // through ONE idempotent registrar that calls the shared helper.
  for (const trigger of ["boot", "install", "grant"]) {
    assertStringIncludes(live, `registerAskAgentMenus("${trigger}")`);
  }
  assert(count("registerProductContextMenus(chrome)") >= 1, "the registrar calls the shared helper");
  assert(count("removeProductContextMenus(chrome)") >= 1, "removal on revoke");
  assertStringIncludes(live, 'perms?.permissions?.includes("contextMenus")');
  // The click handler is bound to contextMenus.onClicked (idempotently — the
  // API may only appear after an in-session grant) and the command routes.
  assertStringIncludes(live, "handleAskAgentClick(info, tab)");
  assertStringIncludes(live, "ensureAskAgentClickListener()");
  assertStringIncludes(live, "if (command === ASK_AGENT_COMMAND) return await askAboutPageForCommand();");
  // The side panel is opened on the gesture; the hub is the fallback.
  assertStringIncludes(live, "chrome.sidePanel.open({ tabId");
  assertStringIncludes(live, "askAgentHubUrl(");
  // The run's attachment context carries the run's boundary token.
  assertStringIncludes(live, "attachmentContext(attachments, { untrustedToken: orch?.untrustedToken ?? null })");
  // The SW never requests the permission itself.
  const askBlockStart = sw.indexOf("// ---- ask-agent entry points");
  const askBlock = sw.slice(askBlockStart, askBlockStart + 6000);
  assertNotEquals(askBlockStart, -1);
  assertEquals(askBlock.includes("permissions.request"), false, "no SW-initiated permission request");
});

Deno.test("side panel + hub: both consume the prefill through the shared helpers, never a URL payload", async () => {
  const sidepanel = await read("extension/sidepanel/sidepanel.js");
  assertStringIncludes(sidepanel, "takeAskAgentPrefill(chrome, ");
  assertStringIncludes(sidepanel, "applyAskAgentPrefill(pageComposer, ");
  assertStringIncludes(sidepanel, "askAgentPrefillTabId(key)");
  const ntp = await read("extension/ntp/ntp.js");
  assertStringIncludes(ntp, 'parsed.route === "ask-agent"');
  assertStringIncludes(ntp, "takeAskAgentPrefill(chrome, parsed.tabId)");
  assertStringIncludes(ntp, "applyAskAgentPrefill(composer, ");
  // The grant banner requests the permission ON THE CLICK, from the page.
  assertStringIncludes(ntp, 'chrome.permissions.request({ permissions: ["contextMenus"] })');
  const html = await read("extension/ntp/ntp.html");
  assertStringIncludes(html, '<first-run-guide id="ask-agent-menu-banner"');
});
