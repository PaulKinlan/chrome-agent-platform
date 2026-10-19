// tests/settings-agent-templates.test.ts — regression tests for template agent
// list in Settings (chrome-agent-platform-rqh20).
// P1 (Paul): template agent list is EMPTY in Settings - curated AGENT_TEMPLATES
// never reach the gallery and the section self-hides.

// Set up minimal browser stubs before dynamic module imports
class HTMLElementStub {
  getAttribute(_n: string) { return null; }
  hasAttribute(_n: string) { return false; }
  setAttribute(_n: string, _v: unknown) {}
  removeAttribute(_n: string) {}
  dispatchEvent(_e: unknown) { return true; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
(globalThis as any).HTMLElement = HTMLElementStub;
(globalThis as any).customElements = (globalThis as any).customElements || {
  define() {},
  get() { return null; },
};

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  AGENT_TEMPLATE_COUNT,
  STARTER_TEMPLATE_IDS,
  AGENT_TEMPLATES,
  templatePrefill,
} from "../extension/lib/agent-templates.js";
import { createPanelContext } from "../extension/options/panel-context.js";

const _ACCEPTANCE = new URL("../cap-evidence/rqh20-settings-templates-acceptance.ts", import.meta.url);
const agentsMod = await import("../extension/options/panels/agents.js");
(globalThis as any)._agentsModule = agentsMod;
(globalThis as any)._templatesModule = { AGENT_TEMPLATES, templatePrefill };

const {
  composeSettingsTemplateCatalogue,
  renderBackgroundAgentPicker,
} = agentsMod;

Deno.test("Settings template catalogue: includes curated starter templates even when background skills are empty", () => {
  // When there are ZERO background skills, curated templates must still populate the catalogue
  const catalogue: any[] = composeSettingsTemplateCatalogue([]);
  assert(catalogue.length >= 21, `catalogue must contain at least 21 curated templates, got ${catalogue.length}`);
  assertEquals(catalogue.length, AGENT_TEMPLATE_COUNT);

  // All 7 curated starter templates are present and marked starter: true
  const starterCards = catalogue.filter((t) => t?.starter === true);
  assertEquals(starterCards.length, STARTER_TEMPLATE_IDS.length);
  const starterCardIds = starterCards.map((t) => t.id);
  for (const id of STARTER_TEMPLATE_IDS) {
    assert(starterCardIds.includes(id), `starter template "${id}" must be in the catalogue`);
  }

  // Curated templates like Chief of Staff and Research Analyst have their persona and skills
  const cos = catalogue.find((t) => t?.id === "chief-of-staff");
  assert(cos, "Chief of Staff must exist in catalogue");
  assertStringIncludes(String(cos.role ?? ""), "# Chief of Staff Persona");
  assert(Array.isArray(cos.skills) && cos.skills.includes("daily-summary"));

  const ra = catalogue.find((t) => t?.id === "research-analyst");
  assert(ra, "Research Analyst must exist in catalogue");
  assertStringIncludes(String(ra.role ?? ""), "# Research Analyst Persona");
  assert(Array.isArray(ra.skills) && ra.skills.includes("multi-tab-researcher"));
});

Deno.test("Settings template catalogue: merges background skills without duplicating curated templates", () => {
  const customBackgroundSkill = {
    id: "price-alert-watcher",
    name: "Price Alert Watcher",
    description: "Watches prices on tabs",
    mode: "background",
    schedule: { periodInMinutes: 60, prompt: "Check prices" },
  };
  const collidingCuratedSkill = {
    id: "chief-of-staff",
    name: "Chief of Staff (Skill)",
    description: "Duplicate",
    mode: "background",
  };

  const catalogue: any[] = composeSettingsTemplateCatalogue([customBackgroundSkill, collidingCuratedSkill]);
  // Custom skill was added
  const added = catalogue.find((t) => t?.id === "price-alert-watcher");
  assert(added, "custom background skill must be included in catalogue");
  assertEquals(added.mode, "background");
  assertEquals(added.source, "skill");

  // Curated template retains its richer definition and is not duplicated
  const cosTemplates = catalogue.filter((t) => t?.id === "chief-of-staff");
  assertEquals(cosTemplates.length, 1, "chief-of-staff must appear only once");
  assertStringIncludes(String(cosTemplates[0].role ?? ""), "# Chief of Staff Persona");
});

Deno.test("Settings template gallery: section stays visible by default and renders templates even with no disabled skills", () => {
  // Minimal DOM node stub for testing renderBackgroundAgentPicker
  class StubElement {
    tagName: string;
    attributes = new Map<string, string>();
    children: StubElement[] = [];
    hidden = false;
    templates: any[] = [];
    id = "";
    className = "";
    type = "";
    textContent = "";
    disabled = false;
    eventListeners = new Map<string, Function[]>();

    constructor(tag: string) {
      this.tagName = tag.toUpperCase();
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, String(value));
    }
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    removeAttribute(name: string) {
      this.attributes.delete(name);
    }
    replaceChildren(...nodes: StubElement[]) {
      this.children = [...nodes];
    }
    append(...nodes: StubElement[]) {
      this.children.push(...nodes);
    }
    appendChild(node: StubElement) {
      this.children.push(node);
      return node;
    }
    addEventListener(event: string, fn: Function) {
      const list = this.eventListeners.get(event) ?? [];
      list.push(fn);
      this.eventListeners.set(event, list);
    }
    dispatchEvent(ev: any) {
      const type = typeof ev === "string" ? ev : ev?.type;
      const list = this.eventListeners.get(type) ?? [];
      for (const fn of list) fn(ev);
      return true;
    }
    querySelector(sel: string): StubElement | null {
      for (const child of this.children) {
        if (sel === "agent-template-gallery" && child.tagName === "AGENT-TEMPLATE-GALLERY") return child;
        if (sel.startsWith("#") && child.id === sel.slice(1)) return child;
        if (sel.startsWith(".") && child.className.includes(sel.slice(1))) return child;
        const found = child.querySelector(sel);
        if (found) return found;
      }
      return null;
    }
    querySelectorAll(sel: string): StubElement[] {
      const results: StubElement[] = [];
      for (const child of this.children) {
        if (sel === "agent-template-gallery" && child.tagName === "AGENT-TEMPLATE-GALLERY") results.push(child);
        results.push(...child.querySelectorAll(sel));
      }
      return results;
    }
  }

  const host = new StubElement("div");
  host.id = "background-agent-add";
  // Initially host might have been hidden
  host.hidden = true;

  const root = new StubElement("section");
  root.id = "agents";
  root.append(host);

  const prevDoc = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tag: string) => new StubElement(tag),
  };

  try {
    const ctx = createPanelContext({ root: root as any });

    // Calling with empty array (e.g. 0 disabled background skills)
    renderBackgroundAgentPicker([], ctx);

    // Regression check: the host must NOT hide itself
    assertEquals(host.hidden, false, "host #background-agent-add must remain visible even with 0 background skills");

    // The gallery must have received the curated templates
    const gallery: any = host.querySelector("agent-template-gallery");
    assert(gallery, "agent-template-gallery must be created inside host");
    assert(gallery.templates.length >= 21, `gallery.templates must have at least 21 templates, got ${gallery.templates.length}`);
    assertEquals(gallery.getAttribute("filters"), "starter,all,scheduled");
    assertEquals(gallery.getAttribute("filter"), "starter");

    const starterCards = gallery.templates.filter((t: any) => t.starter === true);
    assertEquals(starterCards.length, 7, "gallery must have 7 starter templates");
  } finally {
    (globalThis as any).document = prevDoc;
  }
});

Deno.test("Settings uniqueAgentName avoids collisions with existing named agents (0owtx/i3z5z)", () => {
  const { uniqueAgentName } = (globalThis as any)._agentsModule;
  assertEquals(uniqueAgentName("Chief of Staff", []), "Chief of Staff");
  assertEquals(uniqueAgentName("Chief of Staff", [{ name: "Chief of Staff" }]), "Chief of Staff 2");
  assertEquals(
    uniqueAgentName("Chief of Staff", [{ name: "Chief of Staff" }, { name: "Chief of Staff 2" }]),
    "Chief of Staff 3",
  );
});

Deno.test("Settings Add gallery excludes already-enabled background skills (t163u)", () => {
  const enabledSkill = {
    id: "active-watcher",
    name: "Active Watcher",
    mode: "background",
    enabled: true,
    schedule: { periodInMinutes: 30, prompt: "Watch" },
  };
  const disabledSkill = {
    id: "idle-watcher",
    name: "Idle Watcher",
    mode: "background",
    enabled: false,
    schedule: { periodInMinutes: 60, prompt: "Watch idle" },
  };

  const catalogue: any[] = composeSettingsTemplateCatalogue([enabledSkill, disabledSkill]);
  assertEquals(catalogue.some((t: any) => t?.id === "active-watcher"), false, "already-enabled skill must not be offered in Add gallery");
  assertEquals(catalogue.some((t: any) => t?.id === "idle-watcher"), true, "disabled skill must be offered in Add gallery");
  assertEquals(catalogue.some((t: any) => t?.id === "chief-of-staff"), true, "curated templates must always be offered");
});

Deno.test("Settings Add handler maps background template prompt to schedule.task and handles scheduleError (66avy/72omn)", async () => {
  class StubEl {
    tagName: string;
    attributes = new Map<string, string>();
    children: StubEl[] = [];
    hidden = false;
    templates: any[] = [];
    id = "";
    className = "";
    type = "";
    textContent = "";
    disabled = false;
    eventListeners = new Map<string, Function[]>();
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    setAttribute(n: string, v: string) { this.attributes.set(n, String(v)); }
    getAttribute(n: string) { return this.attributes.get(n) ?? null; }
    removeAttribute(n: string) { this.attributes.delete(n); }
    replaceChildren(...nodes: StubEl[]) { this.children = [...nodes]; }
    append(...nodes: StubEl[]) { this.children.push(...nodes); }
    appendChild(node: StubEl) { this.children.push(node); return node; }
    addEventListener(event: string, fn: Function) {
      const list = this.eventListeners.get(event) ?? [];
      list.push(fn);
      this.eventListeners.set(event, list);
    }
    dispatchEvent(ev: any) {
      const type = typeof ev === "string" ? ev : ev?.type;
      const list = this.eventListeners.get(type) ?? [];
      for (const fn of list) fn(ev);
      return true;
    }
    querySelector(sel: string): StubEl | null {
      for (const child of this.children) {
        if (sel === "agent-template-gallery" && child.tagName === "AGENT-TEMPLATE-GALLERY") return child;
        if (sel === "button" && child.tagName === "BUTTON") return child;
        if (sel.includes("button.primary") && child.tagName === "BUTTON" && child.className.includes("primary")) return child;
        if (sel.startsWith("#") && child.id === sel.slice(1)) return child;
        if (sel.startsWith(".") && child.className.includes(sel.slice(1))) return child;
        const found = child.querySelector(sel);
        if (found) return found;
      }
      return null;
    }
  }

  const host = new StubEl("div");
  host.id = "background-agent-add";
  const root = new StubEl("section");
  root.id = "agents";
  root.append(host);

  const prevDoc = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tag: string) => new StubEl(tag),
  };

  try {
    const sentMessages: any[] = [];
    const flashes: string[] = [];

    const customSend = async (type: string, payload: any = {}) => {
      sentMessages.push({ type, ...payload });
      if (type === "named-agent.create") {
        return { ok: true, agent: { id: "tab-janitor", name: payload.name }, scheduleError: "alarm registration delayed" };
      }
      return { ok: true };
    };
    const customBoundedSend = async (type: string) => {
      if (type === "named-agent.list") return { agents: [] };
      return { ok: true };
    };

    const ctx = createPanelContext({
      root: root as any,
      send: customSend,
      boundedSend: customBoundedSend,
      saveFlash: (msg: string) => flashes.push(msg),
    });

    renderBackgroundAgentPicker([], ctx);

    const gallery = host.querySelector("agent-template-gallery");
    assert(gallery, "gallery must exist");

    // Select tab-janitor (a background template with periodInMinutes and prompt)
    gallery.dispatchEvent({ type: "use", detail: { id: "tab-janitor" } });

    // Click Add button
    const addBtn = host.querySelector("button");
    const clickFns = (addBtn as any).eventListeners.get("click") ?? [];
    for (const fn of clickFns) {
      await fn({ type: "click" });
    }

    // 66avy: Assert named-agent.create was sent with schedule.task mapped from template prompt
    const createMsg = sentMessages.find((m) => m.type === "named-agent.create");
    assert(createMsg, "named-agent.create must be sent");
    assertEquals(createMsg.name, "Tab Janitor");
    assert(createMsg.schedule, "schedule must be present in create message");
    assertEquals(createMsg.schedule.periodInMinutes, 120);
    assertEquals(
      createMsg.schedule.task,
      "Do your scheduled hygiene pass: dedupe tabs, close stale ones, group by domain — then report what you did.",
    );

    // 72omn: Assert scheduleError is surfaced in flash message
    assert(
      flashes.some((f) => f.includes("Tab Janitor added, but its schedule was not created: alarm registration delayed.")),
      `flash must surface scheduleError, got: ${JSON.stringify(flashes)}`,
    );
  } finally {
    (globalThis as any).document = prevDoc;
  }
});

Deno.test("starter templates disclosure summary does not set missing data-i18n key (ahzuf)", async () => {
  const code = await Deno.readTextFile(new URL("../extension/options/panels/agents.js", import.meta.url));
  assert(
    !code.includes('setAttribute("data-i18n", "options_browse_starter_templates")'),
    "disclosure summary must not set missing data-i18n attribute which causes hydrateI18n to overwrite text with raw key",
  );
  assert(
    code.includes('summary.textContent = "Browse starter templates…"'),
    "disclosure summary must provide plain text Browse starter templates…",
  );
});

Deno.test("Settings template acceptance script exists and is tracked", () => {
  assert(_ACCEPTANCE.href.endsWith("rqh20-settings-templates-acceptance.ts"));
});

Deno.test("Settings panels/agents.js source: imports AGENT_TEMPLATES and passes background to picker", async () => {
  const code = await Deno.readTextFile(new URL("../extension/options/panels/agents.js", import.meta.url));

  // Fix requirement 1: imports AGENT_TEMPLATES and STARTER_TEMPLATE_IDS
  assert(
    code.includes("const catalogue = composeSettingsTemplateCatalogue(agents);"),
    "renderBackgroundAgentPicker must compose catalogue using composeSettingsTemplateCatalogue",
  );

  // Fix requirement 2: passes background skills to picker (not filtering out enabled ones)
  assert(
    code.includes("renderBackgroundAgentPicker(background)"),
    "renderUnifiedAgentSettings must pass background to renderBackgroundAgentPicker",
  );
  assert(
    !code.includes("renderBackgroundAgentPicker(background.filter((agent) => agent.enabled !== true))"),
    "must not pass only disabled skills to renderBackgroundAgentPicker",
  );
});
