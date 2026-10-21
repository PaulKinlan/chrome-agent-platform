// tests/settings-agent-templates.test.ts — regression tests for the template
// agent picker in Settings (chrome-agent-platform-rqh20; updated by
// chrome-agent-platform-n3fqo: the card grid became the shared Customizable
// Select, the FULL catalogue — 21 curated + every background skill — stays
// reachable, and an already-enabled skill is reported honestly instead of
// being hidden or re-added).
// P1 (Paul): template agent list is EMPTY in Settings - curated AGENT_TEMPLATES
// never reach the picker and the section self-hides.

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
  style = { cssText: "" };
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

const _ACCEPTANCE = new URL("../cap-evidence/n3fqo-settings-template-select-acceptance.ts", import.meta.url);
const agentsMod = await import("../extension/options/panels/agents.js");
(globalThis as any)._agentsModule = agentsMod;
(globalThis as any)._templatesModule = { AGENT_TEMPLATES, templatePrefill };

const {
  composeSettingsTemplateCatalogue,
  renderBackgroundAgentPicker,
} = agentsMod;

/** A minimal DOM node that can absorb what buildTemplateSelect and the picker
 * wiring do: property sets, append/replaceChildren, listeners, dispatch, and
 * simple tag/#id/.class selectors. `style` must exist because the select
 * builder writes inline cssText. */
class PanelNode {
  tagName: string;
  attributes = new Map<string, string>();
  children: PanelNode[] = [];
  hidden = false;
  id = "";
  className = "";
  type = "";
  textContent = "";
  disabled = false;
  value = "";
  open = false;
  label = "";
  eventListeners = new Map<string, Function[]>();
  style = { cssText: "" };

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
  replaceChildren(...nodes: PanelNode[]) {
    this.children = [...nodes];
  }
  append(...nodes: PanelNode[]) {
    this.children.push(...nodes);
  }
  appendChild(node: PanelNode) {
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
  _matches(sel: string): boolean {
    // simple tag, #id, .class, or compound tag.class ("button.primary")
    const compound = sel.match(/^([a-z]+)((?:\.[\w-]+)+)$/);
    if (compound) {
      if (this.tagName.toLowerCase() !== compound[1]) return false;
      const classes = compound[2].slice(1).split(".");
      return classes.every((c) => this.className.split(/\s+/).includes(c));
    }
    if (sel === this.tagName.toLowerCase()) return true;
    if (sel.startsWith("#") && this.id === sel.slice(1)) return true;
    if (sel.startsWith(".") && this.className.split(/\s+/).includes(sel.slice(1))) return true;
    return false;
  }
  querySelectorAll(sel: string): PanelNode[] {
    const results: PanelNode[] = [];
    for (const child of this.children) {
      if (child._matches(sel)) results.push(child);
      results.push(...child.querySelectorAll(sel));
    }
    return results;
  }
  querySelector(sel: string): PanelNode | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

function withPanelDoc(root: PanelNode, fn: () => Promise<void> | void) {
  const prevDoc = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tag: string) => new PanelNode(tag),
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      (globalThis as any).document = prevDoc;
    });
}

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

Deno.test("Settings template picker: section stays visible and the select renders the curated catalogue even with no background skills", async () => {
  const host = new PanelNode("div");
  host.id = "background-agent-add";
  host.hidden = true; // the section must UN-hide itself

  const root = new PanelNode("section");
  root.id = "agents";
  root.append(host);

  await withPanelDoc(root, () => {
    const ctx = createPanelContext({ root: root as any });

    // Calling with empty array (e.g. 0 background skills)
    renderBackgroundAgentPicker([], ctx);

    // Regression check: the host must NOT hide itself
    assertEquals(host.hidden, false, "host #background-agent-add must remain visible even with 0 background skills");

    // The picker renders the customizable select: one blank option + every
    // curated template (21), grouped Starter / Other / Scheduled (the curated
    // background templates keep Scheduled present even with zero skills).
    const pickerHost = host.querySelector("#background-agent-gallery");
    assert(pickerHost, "the template picker host must be created inside #background-agent-add");
    const select = pickerHost.querySelector(".agent-template-select");
    assert(select, "the customizable select must be rendered");
    const options = select.querySelectorAll("option");
    assert(
      options.length >= 1 + 21,
      `the select must offer the blank + every curated template, got ${options.length}`,
    );
    assertEquals(
      (select.querySelectorAll("optgroup")).map((g: any) => g.label),
      ["Starter", "Other", "Scheduled"],
      "Starter first; the 4 curated background templates keep the Scheduled group present even with zero skills",
    );
    assertEquals(options[0].value, "", "the first option is the blank placeholder");
    assertStringIncludes(String(options[1].value), "chief-of-staff", "starters come first");
  });
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

Deno.test("Settings picker lists enabled background skills, marked — never hidden, never re-added (t163u, n3fqo)", () => {
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

  // n3fqo: the FULL catalogue stays reachable — an already-enabled skill stays
  // listed (marked enabled:true) so the picker can report it honestly; t163u's
  // intent (never a duplicate agent) is kept by the Add handler refusing it.
  const catalogue: any[] = composeSettingsTemplateCatalogue([enabledSkill, disabledSkill]);
  const enabled = catalogue.find((t: any) => t?.id === "active-watcher");
  assert(enabled, "an already-enabled skill must STAY in the catalogue");
  assertEquals(enabled.enabled, true, "and it must carry enabled:true so the picker can report it");
  const disabled = catalogue.find((t: any) => t?.id === "idle-watcher");
  assert(disabled, "a disabled skill must be offered");
  assertEquals(disabled.enabled ?? false, false, "a disabled skill is not marked enabled");
  assertEquals(catalogue.some((t: any) => t?.id === "chief-of-staff"), true, "curated templates must always be offered");
});

Deno.test("Settings Add handler maps background template prompt to schedule.task and handles scheduleError (66avy/72omn)", async () => {
  const host = new PanelNode("div");
  host.id = "background-agent-add";
  const root = new PanelNode("section");
  root.id = "agents";
  root.append(host);

  await withPanelDoc(root, async () => {
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

    const select = host.querySelector(".agent-template-select");
    assert(select, "the customizable select must exist");

    // Select tab-janitor (a background template with periodInMinutes and prompt)
    // by driving the NATIVE select the way the owner does.
    select.value = "tab-janitor";
    select.dispatchEvent({ type: "change" });

    // Click Add button
    const addBtn = host.querySelector("button.primary");
    assert(addBtn, "the Add button must exist");
    assertEquals(addBtn.disabled, false, "choosing a template enables Add");
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
  });
});

Deno.test("Settings picker: choosing an already-enabled skill disables Add and never re-sends (n3fqo)", async () => {
  const host = new PanelNode("div");
  host.id = "background-agent-add";
  const root = new PanelNode("section");
  root.id = "agents";
  root.append(host);

  await withPanelDoc(root, async () => {
    const sentMessages: any[] = [];
    const flashes: string[] = [];

    const ctx = createPanelContext({
      root: root as any,
      send: async (type: string, payload: any = {}) => {
        sentMessages.push({ type, ...payload });
        return { ok: true };
      },
      boundedSend: async () => ({ agents: [] }),
      saveFlash: (msg: string) => flashes.push(msg),
    });

    renderBackgroundAgentPicker([
      { id: "active-watcher", name: "Active Watcher", mode: "background", enabled: true, schedule: { periodInMinutes: 30, prompt: "Watch" } },
    ], ctx);

    const select = host.querySelector(".agent-template-select");
    assert(select, "the customizable select must exist");

    select.value = "active-watcher";
    select.dispatchEvent({ type: "change" });

    const addBtn = host.querySelector("button.primary");
    assert(addBtn, "the Add button must exist");
    assertEquals(addBtn.disabled, true, "Add must stay disabled for an already-enabled skill");
    const chosen = host.querySelector(".background-agent-add-chosen");
    assert(
      String(chosen?.textContent ?? "").includes("already enabled"),
      `the status must say the skill is already enabled, got: ${chosen?.textContent}`,
    );

    // Clicking is a guarded no-op: nothing is sent.
    const clickFns = (addBtn as any).eventListeners.get("click") ?? [];
    for (const fn of clickFns) {
      await fn({ type: "click" });
    }
    assertEquals(sentMessages.length, 0, "no background-agent.set may be sent for an already-enabled skill");
    assert(
      flashes.some((f) => f.includes("Active Watcher is already enabled.")),
      `flash must report the already-enabled state, got: ${JSON.stringify(flashes)}`,
    );
  });
});

Deno.test("starter templates disclosure summary does not set missing data-i18n key (ahzuf)", async () => {
  const code = await Deno.readTextFile(new URL("../extension/options/panels/agents.js", import.meta.url));
  assert(
    !code.includes('setAttribute("data-i18n", "options_browse_starter_templates")'),
    "disclosure summary must not set missing data-i18n attribute which causes hydrateI18n to overwrite text with raw key",
  );
  assert(
    code.includes('summary.textContent = "Browse agent templates…"'),
    "disclosure summary must provide plain text (n3fqo: it offers ALL templates, not just starters)",
  );
});

Deno.test("Settings template acceptance script exists and is tracked", () => {
  assert(_ACCEPTANCE.href.endsWith("n3fqo-settings-template-select-acceptance.ts"));
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
