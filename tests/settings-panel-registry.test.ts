// tests/settings-panel-registry.test.ts — Stage 3a Settings panel registry, authority boundary, and mount/unmount lifecycle contract (chrome-agent-platform-8v5l.1).

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  SETTINGS_SECTIONS,
  DEVELOPER_SECTIONS,
  DEVELOPER_SECTIONS_SET,
} from "../extension/lib/pure.js";
import {
  PANEL_REGISTRY,
  PANEL_BY_ID,
  getPanelEntry,
} from "../extension/options/panel-registry.js";
import {
  createPanelContext,
  escapeAttr,
  withUnmount,
} from "../extension/options/panel-context.js";

(globalThis as any).HTMLElement ??= class HTMLElement {};
(globalThis as any).customElements ??= {
  get() { return undefined; },
  define() {},
};

const PANEL_MODULES: Record<string, { mount: (root: any, ctx: any) => any }> = {
  providers: await import("../extension/options/panels/providers.js"),
  "mcp-servers": await import("../extension/options/panels/mcp-servers.js"),
  "local-folders": await import("../extension/options/panels/local-folders.js"),
  "user-wasm": await import("../extension/options/panels/user-wasm.js"),
  "tool-library": await import("../extension/options/panels/tool-library.js"),
  skills: await import("../extension/options/panels/skills.js"),
  agents: await import("../extension/options/panels/agents.js"),
  browser: await import("../extension/options/panels/browser.js"),
  "board-permissions": await import("../extension/options/panels/board-permissions.js"),
  permissions: await import("../extension/options/panels/permissions.js"),
  "web-services": await import("../extension/options/panels/web-services.js"),
  hooks: await import("../extension/options/panels/hooks.js"),
  prompts: await import("../extension/options/panels/prompts.js"),
  usage: await import("../extension/options/panels/usage.js"),
  data: await import("../extension/options/panels/data.js"),
  about: await import("../extension/options/panels/about.js"),
};

function stripJsComments(source: string): string {
  return source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g,
    (m, comment) => (comment ? "" : m),
  );
}

async function readRepoText(relPath: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../${relPath}`, import.meta.url));
}

/**
 * Extract the live `SETTINGS_ONLY_DIRECT` set from `tests/sw-dispatch-authority-census.test.ts:46`.
 */
async function loadSettingsOnlyDirectSet(): Promise<Set<string>> {
  const censusSrc = await readRepoText("tests/sw-dispatch-authority-census.test.ts");
  const match = censusSrc.match(/SETTINGS_ONLY_DIRECT:\s*new Set\(\[([\s\S]*?)\]\)/);
  assert(match, "tests/sw-dispatch-authority-census.test.ts must define SETTINGS_ONLY_DIRECT");
  const body = stripJsComments(match[1]);
  const routes = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert(routes.length >= 40, `expected >= 40 SETTINGS_ONLY_DIRECT routes, got ${routes.length}`);
  return new Set(routes);
}

/**
 * Extract literal SW message types and raw-send message types from a panel source file.
 */
function extractPanelRoutesFromSource(code: string): { allRoutes: Set<string>; rawRoutes: Set<string> } {
  const clean = stripJsComments(code);
  const allRoutes = new Set<string>();
  const rawRoutes = new Set<string>();

  // 1. Direct boundedSend("type", ...)
  for (const m of clean.matchAll(/\bboundedSend\(\s*"([^"]+)"/g)) {
    allRoutes.add(m[1]);
  }
  // 2. Direct send("type", ...), sendFn("type", ...), or vaultSend("type", ...)
  for (const m of clean.matchAll(/\b(?:panelCtx\.|ctx\.|c\.)?send(?:Fn)?\(\s*"([^"]+)"/g)) {
    allRoutes.add(m[1]);
    rawRoutes.add(m[1]);
  }
  for (const m of clean.matchAll(/\bvaultSend\(\s*"([^"]+)"/g)) {
    allRoutes.add(m[1]);
    rawRoutes.add(m[1]);
  }
  // 3. Object-literal send({ type: "..." })
  for (const m of clean.matchAll(/\b(?:panelCtx\.|ctx\.|c\.)?send\(\s*\{\s*type:\s*"([^"]+)"/g)) {
    allRoutes.add(m[1]);
    rawRoutes.add(m[1]);
  }
  // 4. Owner-approved mutation helper action: "..." or message: { type: "..." }
  for (const m of clean.matchAll(/\baction:\s*"([a-z0-9-]+\.[a-zA-Z0-9.-]+)"/g)) {
    allRoutes.add(m[1]);
    rawRoutes.add(m[1]);
  }
  for (const m of clean.matchAll(/\btype:\s*"((?:named-agent|background-agent|agent|provider|mcp|fs-grant|tool|skill|command|browser-control|board|capability|python|vault|hooks|prompt|usage|run|memory|system|webmcp|tools|site-skills|management|invalidate-agent)[^"]*)"/g)) {
    allRoutes.add(m[1]);
  }
  // 5. Prompts mutate("prompt.set" | "prompt.reset" | "prompt.keep")
  for (const m of clean.matchAll(/\bmutate\(\s*"(prompt\.[^"]+)"/g)) {
    allRoutes.add(m[1]);
    rawRoutes.add(m[1]);
  }
  // 6. storage.get / storage.set / storage.remove -> kv.get / kv.set / kv.remove
  if (/\bstorage\.get\s*\(/.test(clean)) allRoutes.add("kv.get");
  if (/\bstorage\.set\s*\(/.test(clean)) allRoutes.add("kv.set");
  if (/\bstorage\.remove\s*\(/.test(clean)) allRoutes.add("kv.remove");

  return { allRoutes, rawRoutes };
}

Deno.test("8v5l.1 Acceptance 4(iii): PANEL_REGISTRY ids, developerOnly flags, and options.html sections/nav-items stay in 1:1 lockstep", async () => {
  const html = await readRepoText("extension/options/options.html");

  const registryIds = PANEL_REGISTRY.map((p: any) => p.id);
  assertEquals(registryIds.length, 16, "PANEL_REGISTRY must contain all 16 settings panels");
  assertEquals(registryIds, [...SETTINGS_SECTIONS], "PANEL_REGISTRY order and ids must equal SETTINGS_SECTIONS");

  const devIds = PANEL_REGISTRY.filter((p: any) => p.developerOnly).map((p: any) => p.id);
  assertEquals(devIds, [...DEVELOPER_SECTIONS], "PANEL_REGISTRY developerOnly flags must equal DEVELOPER_SECTIONS");

  for (const id of SETTINGS_SECTIONS) {
    const entry = getPanelEntry(id);
    assert(entry !== null, `getPanelEntry("${id}") must return an entry`);
    assertEquals(PANEL_BY_ID.get(id), entry);
    assertEquals(entry.developerOnly, DEVELOPER_SECTIONS_SET.has(id));
    assertEquals(entry.modulePath, `./panels/${id}.js`);
  }
  assertEquals(getPanelEntry("non-existent-panel"), null);

  // HTML <section id="..."> in options.html
  const htmlSectionIds = [...html.matchAll(/<section\s+id="([^"]+)"\s+class="panel/g)].map((m) => m[1]);
  assertEquals(htmlSectionIds.length, 16, "options.html must have 16 <section class='panel'> elements");
  assertEquals(
    new Set(htmlSectionIds),
    new Set(registryIds),
    "Every <section class='panel'> in options.html must match PANEL_REGISTRY 1:1",
  );

  // HTML a.nav-item[data-section="..."] in options.html
  const htmlNavIds = [...html.matchAll(/<a\s+[^>]*class="nav-item"[^>]*data-section="([^"]+)"/g)].map((m) => m[1]);
  assertEquals(htmlNavIds.length, 16, "options.html must have 16 a.nav-item[data-section] elements");
  assertEquals(
    new Set(htmlNavIds),
    new Set(registryIds),
    "Every a.nav-item[data-section] in options.html must match PANEL_REGISTRY 1:1",
  );

  // Developer-flagged <section> elements in options.html
  const htmlDevSections = [...html.matchAll(/<section\s+id="([^"]+)"[^>]*data-developer="true"/g)].map((m) => m[1]);
  assertEquals(
    new Set(htmlDevSections),
    new Set(devIds),
    "options.html section[data-developer='true'] set must match PANEL_REGISTRY developerOnly set",
  );
});

Deno.test("8v5l.1 Acceptance 4(i): every literal SW message type a panel module sends appears in its PANEL_REGISTRY routes", async () => {
  for (const entry of PANEL_REGISTRY) {
    const panelPath = `extension/options/panels/${entry.id}.js`;
    let combinedSource = await readRepoText(panelPath);
    if (entry.id === "skills") {
      combinedSource += "\n" + (await readRepoText("extension/skills/skills-panel.js"));
    } else if (entry.id === "providers") {
      combinedSource += "\n" + (await readRepoText("extension/lib/provider-options-save.js"));
    } else if (entry.id === "agents" || entry.id === "permissions") {
      combinedSource += "\n" + (await readRepoText("extension/lib/owner-approved-mutation.js"));
    } else if (entry.id === "web-services") {
      // The quota UI is this panel's own chunk module (it is dynamically imported so the options bundle stays
      // inside its 450 KB budget), and its two SW routes are sent from there - so the panel's send sites span
      // both files, exactly as the skills/providers/agents cases above do.
      combinedSource += "\n" + (await readRepoText("extension/options/panels/vault-quotas.js"));
    }

    const { allRoutes, rawRoutes } = extractPanelRoutesFromSource(combinedSource);
    const declaredRoutes = new Set<string>(entry.routes);
    const declaredRaw = new Set<string>(entry.rawSendSites);

    for (const r of allRoutes) {
      assert(
        declaredRoutes.has(r),
        `Panel "${entry.id}" (${panelPath}) sends SW route "${r}" which is missing from PANEL_REGISTRY.routes`,
      );
    }
    for (const r of declaredRoutes) {
      assert(
        allRoutes.has(r),
        `Panel "${entry.id}" declares route "${r}" in PANEL_REGISTRY.routes, but no send site for "${r}" exists in ${panelPath}`,
      );
    }
    for (const r of declaredRaw) {
      assert(
        declaredRoutes.has(r),
        `Panel "${entry.id}" rawSendSites entry "${r}" must also be listed in routes`,
      );
      assert(
        rawRoutes.has(r) || allRoutes.has(r),
        `Panel "${entry.id}" rawSendSites entry "${r}" must correspond to a real send site in ${panelPath}`,
      );
    }
  }
});

Deno.test("8v5l.1 Acceptance 4(ii): hub-ok panels match l354r decision and never intersect SETTINGS_ONLY_DIRECT or approval-resolution routes", async () => {
  const settingsOnlyDirect = await loadSettingsOnlyDirectSet();
  const approvalResolutionRoutes = new Set([
    "management.pending-approvals",
    "management.resolve-approval",
    "capability.revoke",
    "named-agent.set-provider",
  ]);
  const expectedHubOk = new Set(["skills", "usage", "about"]);

  for (const entry of PANEL_REGISTRY) {
    assert(
      entry.host === "hub-ok" || entry.host === "exact-document",
      `Panel "${entry.id}" has invalid host classification "${entry.host}"`,
    );

    if (entry.host === "hub-ok") {
      for (const route of entry.routes) {
        assert(
          !settingsOnlyDirect.has(route),
          `hub-ok panel "${entry.id}" must not send SETTINGS_ONLY_DIRECT route "${route}"`,
        );
        assert(
          !approvalResolutionRoutes.has(route),
          `hub-ok panel "${entry.id}" must not send approval-resolution route "${route}"`,
        );
      }
      assert(
        expectedHubOk.has(entry.id),
        `Panel "${entry.id}" is marked hub-ok but owner decision l354r only admits skills, usage, and about`,
      );
    } else {
      assert(
        !expectedHubOk.has(entry.id),
        `Panel "${entry.id}" must be marked hub-ok per owner decision l354r`,
      );
    }
  }
});

Deno.test("8v5l.1 Acceptance 5 (static boundary): no panel module reads window.top, window.parent, location, or calls chrome.runtime.sendMessage directly", async () => {
  for (const entry of PANEL_REGISTRY) {
    const relPath = `extension/options/panels/${entry.id}.js`;
    const clean = stripJsComments(await readRepoText(relPath));

    assert(
      !/\bwindow\.(?:top|parent)\b/.test(clean),
      `${relPath} must not read window.top or window.parent directly (use ctx.embedded / ctx.callbacks)`,
    );
    assert(
      !/\b(?:window\.)?location\b/.test(clean),
      `${relPath} must not read or write location directly (use ctx.navigateSection / ctx.callbacks)`,
    );
    assert(
      !/\bchrome\.runtime\.sendMessage\b/.test(clean),
      `${relPath} must not call chrome.runtime.sendMessage directly (use ctx.send / ctx.boundedSend)`,
    );
    assert(
      !/\bdocument\.(?:getElementById|querySelector|querySelectorAll)\b/.test(clean),
      `${relPath} must not query document directly (use ctx.byId / ctx.$ / ctx.$$ scoped to root)`,
    );
    assert(
      !/\bdocument\.body\b/.test(clean),
      `${relPath} must not touch document.body outside root (append modals/nodes to ctx.root and remove on unmount)`,
    );
  }
});

// ── Detached DOM fixture + counting harness for Acceptance 5 ─────────────────

class FakeClassList {
  #set = new Set<string>();
  constructor(initial = "") {
    for (const c of initial.split(/\s+/).filter(Boolean)) this.#set.add(c);
  }
  add(...tokens: string[]) { for (const t of tokens) if (t) this.#set.add(t); }
  remove(...tokens: string[]) { for (const t of tokens) this.#set.delete(t); }
  toggle(token: string, force?: boolean) {
    const on = force !== undefined ? Boolean(force) : !this.#set.has(token);
    if (on) this.#set.add(token); else this.#set.delete(token);
    return on;
  }
  contains(token: string) { return this.#set.has(token); }
  toString() { return [...this.#set].join(" "); }
}

class FakeElement {
  tagName: string;
  id = "";
  #classList = new FakeClassList();
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  textContent = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  tabIndex = 0;
  title = "";
  type = "";
  href = "";
  open = false;
  style: Record<string, string> = {};
  options: FakeElement[] = [];
  files: any[] = [];
  #innerHTML = "";
  #listeners = new Map<string, Set<Function>>();
  #tracker: { onAdd: () => void; onRemove: () => void };

  constructor(tagName: string, tracker: { onAdd: () => void; onRemove: () => void }) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.#tracker = tracker;
  }

  get className() { return this.#classList.toString(); }
  set className(v: string) { this.#classList = new FakeClassList(String(v ?? "")); }
  get classList() { return this.#classList; }

  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0] ?? null; }

  get innerHTML() { return this.#innerHTML; }
  set innerHTML(html: string) {
    this.#innerHTML = String(html ?? "");
    this.children = parseHtmlFragment(this.#innerHTML, { onAdd() {}, onRemove() {} }, this);
  }

  setAttribute(name: string, val: string) {
    const s = String(val ?? "");
    this.attributes.set(name, s);
    if (name === "id") this.id = s;
    else if (name === "class") this.className = s;
    else if (name.startsWith("data-")) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = s;
    }
  }
  getAttribute(name: string) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  append(...nodes: any[]) {
    for (const n of nodes) {
      if (n instanceof FakeElement) {
        n.parentElement = this;
        this.children.push(n);
        if (this.tagName === "SELECT" && n.tagName === "OPTION") {
          this.options.push(n);
        }
      } else if (n !== null && n !== undefined) {
        this.textContent += String(n);
      }
    }
  }
  appendChild(node: any) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes: any[]) {
    this.children = [];
    if (this.tagName === "SELECT") this.options = [];
    this.textContent = "";
    this.#innerHTML = "";
    this.append(...nodes);
  }
  remove(idx?: number) {
    if (typeof idx === "number" && this.tagName === "SELECT") {
      this.options.splice(idx, 1);
      this.children.splice(idx, 1);
      return;
    }
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i !== -1) this.parentElement.children.splice(i, 1);
    }
  }
  focus() {}
  click() {}
  scrollIntoView() {}

  addEventListener(type: string, fn: Function) {
    if (typeof fn !== "function") return;
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    if (!set.has(fn)) {
      set.add(fn);
      this.#tracker.onAdd();
    }
  }

  removeEventListener(type: string, fn: Function) {
    const set = this.#listeners.get(type);
    if (set && set.delete(fn)) {
      this.#tracker.onRemove();
    }
  }

  matches(selector: string): boolean {
    const sel = selector.trim();
    if (!sel) return false;
    if (sel.includes(",")) {
      return sel.split(",").some((part) => this.matches(part));
    }
    if (sel.startsWith("#") && !/[\s.>~+\[:]/.test(sel.slice(1))) {
      return this.id === sel.slice(1);
    }
    if (sel.startsWith(".") && !/[\s.>~+\[#:]/.test(sel.slice(1))) {
      return this.#classList.contains(sel.slice(1));
    }
    const tagAttr = sel.match(/^([a-z0-9-]+)?(?:\.([a-zA-Z0-9_-]+))?(?:\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\])?$/i);
    if (tagAttr && (tagAttr[1] || tagAttr[2] || tagAttr[3])) {
      if (tagAttr[1] && this.tagName !== tagAttr[1].toUpperCase()) return false;
      if (tagAttr[2] && !this.#classList.contains(tagAttr[2])) return false;
      if (tagAttr[3]) {
        const attrName = tagAttr[3];
        const actual = attrName.startsWith("data-")
          ? (this.dataset[attrName.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? this.getAttribute(attrName))
          : this.getAttribute(attrName);
        if (tagAttr[4] !== undefined ? actual !== tagAttr[4] : actual === null) return false;
      }
      return true;
    }
    return false;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  closest(selector: string): FakeElement | null {
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  snapshot(): string {
    const attrs = [...this.attributes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    const kids = this.children.map((c) => c.snapshot()).join("");
    return `<${this.tagName.toLowerCase()} id="${this.id}" class="${this.className}" hidden="${this.hidden}" checked="${this.checked}" value="${this.value}" ${attrs}>${this.textContent}${kids}</${this.tagName.toLowerCase()}>`;
  }
}

function parseHtmlFragment(
  html: string,
  tracker: { onAdd: () => void; onRemove: () => void },
  parent: FakeElement | null = null,
): FakeElement[] {
  const roots: FakeElement[] = [];
  const stack: FakeElement[] = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "path", "circle", "rect", "line", "polyline", "polygon"]);
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    const textBefore = html.slice(lastIdx, m.index).trim();
    if (textBefore && stack.length > 0) {
      stack[stack.length - 1].textContent += (stack[stack.length - 1].textContent ? " " : "") + textBefore;
    }
    lastIdx = tagRe.lastIndex;
    const rawTag = m[0];
    const tagName = m[1].toLowerCase();
    const attrStr = m[2] ?? "";

    if (rawTag.startsWith("</")) {
      if (stack.length > 0 && stack[stack.length - 1].tagName.toLowerCase() === tagName) {
        stack.pop();
      }
      continue;
    }

    const el = new FakeElement(tagName, tracker);
    for (const attr of attrStr.matchAll(/([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g)) {
      const k = attr[1];
      const v = attr[2] ?? "";
      el.setAttribute(k, v);
      if (k === "hidden") el.hidden = true;
      if (k === "checked") el.checked = true;
      if (k === "disabled") el.disabled = true;
      if (k === "value") el.value = v;
    }

    if (stack.length > 0) {
      stack[stack.length - 1].append(el);
    } else {
      el.parentElement = parent;
      roots.push(el);
    }

    if (!rawTag.endsWith("/>") && !voidTags.has(tagName)) {
      stack.push(el);
    }
  }
  return roots;
}

function extractSectionHtml(fullHtml: string, sectionId: string): string {
  const startRe = new RegExp(`<section\\s+id="${sectionId}"[^>]*>`, "i");
  const startMatch = startRe.exec(fullHtml);
  assert(startMatch, `options.html must contain <section id="${sectionId}">`);
  const startIdx = startMatch.index;
  const endIdx = fullHtml.indexOf("</section>", startIdx);
  assert(endIdx > startIdx, `<section id="${sectionId}"> must have a closing </section>`);
  return fullHtml.slice(startIdx, endIdx + "</section>".length);
}

function cannedSwResponse(type: string): any {
  switch (type) {
    case "provider.get":
      return { ok: true, provider: "openai", model: "gpt-5.6-luna", hasKey: true, configs: { openai: { hasKey: true, model: "gpt-5.6-luna" } } };
    case "provider.status":
      return { ok: true, granted: true };
    case "kv.get":
      return {};
    case "kv.set":
    case "kv.remove":
      return { ok: true };
    case "mcp.servers.get":
      return { ok: true, servers: [] };
    case "fs-grant.list":
      return { ok: true, grants: [] };
    case "tool.package.validation-list":
      return { ok: true, packages: [] };
    case "tool-catalog.shadow":
      return { ok: true, totalTools: 0, perSource: [] };
    case "skill.list":
      return { ok: true, skills: [] };
    case "command.list":
      return { ok: true, commands: [] };
    case "named-agent.list":
      return { ok: true, agents: [{ id: "writer", name: "Writer", provider: { provider: "openai", model: "gpt-5.6-luna" } }] };
    case "background-agent.list":
      return { ok: true, agents: [] };
    case "agent.list":
      return [];
    case "agent.discoverable-tabs":
      return { ok: true, tabs: [] };
    case "agent.pending-cleanup":
      return { ok: true, origins: [] };
    case "webmcp.consent.snapshot":
      return { ok: true, sites: [] };
    case "webmcp.audit.list":
      return { ok: true, entries: [], nextCursor: null };
    case "webmcp.diagnostics.get":
      return { ok: true, enabled: false };
    case "webmcp.status":
      return { ok: true, records: [] };
    case "browser-control.get":
      return { ok: true, active: false, scope: "origins", grants: [] };
    case "board.deny.list":
      return { ok: true, rules: [] };
    case "python.network.grants":
      return { ok: true, grants: [] };
    case "vault.status":
      return { ok: true, services: [], proxyRules: [], ledger: [] };
    case "hooks.status":
      return { ok: true, hooks: [{ id: "tabs.onUpdated", denied: false }] };
    case "prompt.describe":
      return { ok: true, revision: 1, mode: "default", text: "", defaultText: "Default prompt" };
    case "usage.get":
      return { ok: true, totals: { calls: 2, inputTokens: 100, outputTokens: 50, estimatedCost: 0 }, rows: [] };
    case "run.list":
      return { ok: true, runs: [], retentionPolicy: { mode: "bounded", perThread: 50, globalExecutions: 500, globalBytes: 33554432 } };
    case "memory.stores":
      return { ok: true, stores: [] };
    default:
      return { ok: true };
  }
}

Deno.test("8v5l.1 Acceptance 5 (lifecycle & remount): every panel mounts on a detached root with fake ctx, unmounts with zero residual listeners/timers, and remounts identically", async () => {
  const html = await readRepoText("extension/options/options.html");

  for (const entry of PANEL_REGISTRY) {
    const mod = PANEL_MODULES[entry.id];
    assert(typeof mod?.mount === "function", `Panel "${entry.id}" must export mount(root, ctx)`);

    const sectionMarkup = extractSectionHtml(html, entry.id);
    let liveDomListeners = 0;
    let liveChromeListeners = 0;
    let liveDiagSubs = 0;
    let livePorts = 0;
    const activeTimerIds = new Set<number>();
    let nextTimerId = 1;
    let outsideRootQueries = 0;
    let directSendMessageCalls = 0;

    const tracker = {
      onAdd: () => { liveDomListeners++; },
      onRemove: () => { liveDomListeners--; },
    };

    const makeDetachedRoot = () => {
      liveDomListeners = 0;
      const parsed = parseHtmlFragment(sectionMarkup, tracker, null);
      assert(parsed.length === 1, `Expected 1 root <section> for ${entry.id}`);
      return parsed[0];
    };

    const swCalls1: string[] = [];
    const swCalls2: string[] = [];
    let currentSwLog = swCalls1;

    const fakeChromeEvent = () => {
      const set = new Set<Function>();
      return {
        addListener(fn: Function) {
          if (!set.has(fn)) { set.add(fn); liveChromeListeners++; }
        },
        removeListener(fn: Function) {
          if (set.delete(fn)) { liveChromeListeners--; }
        },
      };
    };

    const storageOnChanged = fakeChromeEvent();
    const runtimeOnMessage = fakeChromeEvent();

    const prevDoc = (globalThis as any).document;
    const prevChrome = (globalThis as any).chrome;
    const prevFetch = globalThis.fetch;

    let currentRoot: FakeElement = makeDetachedRoot();

    const buildFakeCtx = (root: FakeElement) =>
      createPanelContext({
        root,
        developerFeatures: () => true,
        storageGranted: () => true,
        send: async (type: string) => {
          currentSwLog.push(type);
          return cannedSwResponse(type);
        },
        setTimeout: (_fn: Function, _ms?: number) => {
          const id = nextTimerId++;
          activeTimerIds.add(id);
          return id;
        },
        clearTimeout: (id: number) => {
          activeTimerIds.delete(id);
        },
        subscribeDiagnosticsRevision: (_cb: Function) => {
          liveDiagSubs++;
          return () => { liveDiagSubs--; };
        },
        connectPort: () => {
          livePorts++;
          const portEvent = fakeChromeEvent();
          return {
            onMessage: portEvent,
            disconnect() { livePorts--; },
          };
        },
      });

    try {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: {
          createElement: (tag: string) => new FakeElement(tag, { onAdd() {}, onRemove() {} }),
          createDocumentFragment: () => new FakeElement("fragment", { onAdd() {}, onRemove() {} }),
          getElementById: (id: string) => {
            const found = currentRoot.id === id ? currentRoot : currentRoot.querySelector(`#${id}`);
            if (!found) outsideRootQueries++;
            return found;
          },
          querySelector: (sel: string) => {
            outsideRootQueries++;
            return currentRoot.querySelector(sel);
          },
          querySelectorAll: (sel: string) => {
            outsideRootQueries++;
            return currentRoot.querySelectorAll(sel);
          },
          addEventListener: (t: string, fn: Function) => currentRoot.addEventListener(t, fn),
          removeEventListener: (t: string, fn: Function) => currentRoot.removeEventListener(t, fn),
        },
      });

      Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        writable: true,
        value: {
          runtime: {
            getManifest: () => ({ version: "0.3.678" }),
            getURL: (p: string) => `chrome-extension://test-id/${p}`,
            sendMessage: () => {
              directSendMessageCalls++;
              throw new Error("Direct chrome.runtime.sendMessage forbidden in panel mount");
            },
            onMessage: runtimeOnMessage,
          },
          storage: {
            onChanged: storageOnChanged,
            local: {
              get: async () => ({}),
              set: async () => {},
            },
          },
          permissions: {
            getAll: async () => ({ permissions: ["storage", "alarms", "scripting"], origins: [] }),
            contains: async () => true,
          },
          commands: {
            getAll: async () => [{ name: "open-hub", description: "Open Hub", shortcut: "Alt+C" }],
          },
        },
      });

      globalThis.fetch = (async () => ({
        ok: true,
        text: async () => "# Changelog\n\n## [0.3.678] — 2026-10-14\n- User-facing update.\n",
      })) as any;

      // Mount #1
      const ctx1 = buildFakeCtx(currentRoot);
      // Exercise tracked timer & listener registration so every panel tests cleanup
      ctx1.setTimeout(() => {}, 5000);
      ctx1.subscribeDiagnosticsRevision(() => {});
      const handle1 = await mod.mount(currentRoot, ctx1);
      assert(typeof handle1?.unmount === "function", `Panel "${entry.id}" mount() must return { unmount() }`);
      assertEquals(directSendMessageCalls, 0, `Panel "${entry.id}" must not call chrome.runtime.sendMessage directly`);
      assertEquals(outsideRootQueries, 0, `Panel "${entry.id}" must not query document outside root`);

      const snap1 = currentRoot.snapshot();
      handle1.unmount();

      assertEquals(
        liveDomListeners,
        0,
        `Panel "${entry.id}" unmount() left ${liveDomListeners} residual DOM listener(s)`,
      );
      assertEquals(
        liveChromeListeners,
        0,
        `Panel "${entry.id}" unmount() left ${liveChromeListeners} residual chrome listener(s)`,
      );
      assertEquals(
        liveDiagSubs,
        0,
        `Panel "${entry.id}" unmount() left ${liveDiagSubs} residual diagnostics subscription(s)`,
      );
      assertEquals(
        livePorts,
        0,
        `Panel "${entry.id}" unmount() left ${livePorts} open runtime port(s)`,
      );
      assertEquals(
        activeTimerIds.size,
        0,
        `Panel "${entry.id}" unmount() left ${activeTimerIds.size} active timer(s)`,
      );

      // Mount #2 after unmount() — must produce identical DOM and identical SW calls
      currentRoot = makeDetachedRoot();
      currentSwLog = swCalls2;
      const ctx2 = buildFakeCtx(currentRoot);
      const handle2 = await mod.mount(currentRoot, ctx2);
      const snap2 = currentRoot.snapshot();

      assertEquals(
        swCalls2,
        swCalls1,
        `Panel "${entry.id}" second mount() after unmount() must send the exact same SW message sequence`,
      );
      assertEquals(
        snap2,
        snap1,
        `Panel "${entry.id}" second mount() after unmount() must produce the exact same DOM`,
      );

      handle2.unmount();
      assertEquals(liveDomListeners, 0);
      assertEquals(liveChromeListeners, 0);
      assertEquals(activeTimerIds.size, 0);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: prevDoc });
      Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: prevChrome });
      globalThis.fetch = prevFetch;
    }
  }
});

Deno.test("8v5l.1 Acceptance 6: ensureSectionRendered claims before render and releases the claim on throw so retry succeeds", async () => {
  const optionsJs = stripJsComments(await readRepoText("extension/options/options.js"));
  const fnMatch = optionsJs.match(/async function ensureSectionRendered\s*\(\s*sectionId\s*\)\s*\{([\s\S]*?)\n\}/);
  assert(fnMatch, "options.js must define async function ensureSectionRendered(sectionId)");
  const body = fnMatch[1];

  const hasIdx = body.indexOf("renderedSections.has(sectionId)");
  const addIdx = body.indexOf("renderedSections.add(sectionId)");
  const renderIdx = body.indexOf("await renderSection(sectionId)");
  const delIdx = body.indexOf("renderedSections.delete(sectionId)");
  const throwIdx = body.indexOf("throw e");

  assert(hasIdx >= 0 && addIdx > hasIdx, "ensureSectionRendered must check renderedSections.has before adding claim");
  assert(renderIdx > addIdx, "ensureSectionRendered must claim sectionId BEFORE awaiting renderSection");
  assert(delIdx > renderIdx, "ensureSectionRendered must release claim (renderedSections.delete(sectionId)) when renderSection throws");
  assert(throwIdx > delIdx, "ensureSectionRendered must rethrow after releasing claim");

  // Behavioral verification of the exact ensureSectionRendered function extracted from options.js
  const renderedSections = new Set<string>();
  let attempts = 0;
  let shouldFail = true;
  const renderSection = async (id: string) => {
    attempts++;
    if (shouldFail) throw new Error(`transient failure rendering ${id}`);
  };
  const ensureSectionRendered = await new AsyncFunction(
    "renderedSections",
    "renderSection",
    `return (async function ensureSectionRendered(sectionId) {${body}});`,
  )(renderedSections, renderSection);

  await assertRejects(() => ensureSectionRendered("providers"), Error, "transient failure rendering providers");
  assertEquals(renderedSections.has("providers"), false, "failed render must release the renderedSections claim");

  shouldFail = false;
  await ensureSectionRendered("providers");
  assertEquals(renderedSections.has("providers"), true, "retry after failure must succeed and hold the claim");
  await ensureSectionRendered("providers");
  assertEquals(attempts, 2, "subsequent call while claimed must be a no-op");
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

Deno.test("8v5l.1 panel-context helpers: escapeAttr and withUnmount preserve synchronous .unmount and resolved value", async () => {
  assertEquals(escapeAttr('a"b&c'), "a&quot;b&amp;c");
  let unmounted = 0;
  const h: any = withUnmount(Promise.resolve("done"), () => { unmounted++; });
  assert(typeof h.unmount === "function");
  const resolved = await h;
  assertEquals( typeof resolved.unmount, "function");
  resolved.unmount();
  assertEquals(unmounted, 1);
});
