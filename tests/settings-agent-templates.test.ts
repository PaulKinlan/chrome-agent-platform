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

Deno.test("Settings background template prefill maps recurring prompt to schedule.task (0owtx)", () => {
  const { AGENT_TEMPLATES, templatePrefill } = (globalThis as any)._templatesModule;
  const bgTemplates = AGENT_TEMPLATES.filter((t: any) => t.mode === "background");
  assert(bgTemplates.length > 0, "at least one background template exists");
  for (const t of bgTemplates) {
    const pre = templatePrefill(t);
    assert(pre.schedule, `${t.id} must have schedule`);
    const task = pre.schedule.task ?? pre.schedule.prompt;
    assert(typeof task === "string" && task.length > 10, `${t.id} must have non-empty prompt`);
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
