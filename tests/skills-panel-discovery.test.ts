// tests/skills-panel-discovery.test.ts — chrome-agent-platform-kozg.4.
// @ts-nocheck — browser globals are stubbed (the components.test.ts pattern).
// The multi-skill discovery + batch import + installed-commands panel:
// the pure decision functions AND the mount wiring are executed against a
// fake DOM + a fake send (the uodl rule: assertions that execute, not text).
import { assert, assertEquals } from "jsr:@std/assert@1";

// ── minimal DOM stub ────────────────────────────────────────────────────────
class El {
  tag: string;
  children: any[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, any[]>();
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  dataset: Record<string, string> = {};
  className = "";
  constructor(tag: string) { this.tag = tag; }
  append(...kids: any[]) { for (const k of kids) this.children.push(k); }
  addEventListener(type: string, fn: any) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  async dispatch(type: string, ev: any = {}) {
    for (const fn of this.listeners.get(type) ?? []) await fn(ev);
  }
  setAttribute(name: string, v: string) { this.attrs.set(name, String(v)); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(_n: string) {}
  attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} }; }
  querySelector(sel: string) { return this.querySelectorDeep(sel); }
  querySelectorDeep(sel: string): any {
    for (const c of this.children) {
      if ((c as any).__sel === sel) return c;
      const hit = (c as any).querySelectorDeep?.(sel);
      if (hit) return hit;
    }
    return null;
  }
  querySelectorAll(sel: string): any[] {
    const out: any[] = [];
    const walk = (nodes: any[]) => {
      for (const c of nodes) {
        if ((c as any).checked === true && sel.includes("checkbox")) out.push(c);
        if ((c as any).children) walk(c.children);
      }
    };
    walk(this.children);
    return out;
  }
  replaceChildren(...kids: any[]) { this.children = kids; }
  dispatchEvent() { return true; }
  click() { this.dispatch?.("click"); }
}

const doc = {
  createElement(tag: string) {
    const el = new El(tag);
    if (tag === "input") { el.__checked = false; }
    return el;
  },
};
globalThis.document = doc as any;

// checkbox semantics: `checked` prop backed by __checked for the stub walker
Object.defineProperty(El.prototype, "__checked", {
  get(this: any) { return this._checked === true; },
  set(this: any, v: boolean) { this._checked = v === true; },
  configurable: true,
});

const ROOT = new URL("..", import.meta.url).pathname;
const { mountSkillsSection } = await import(`${ROOT}extension/skills/skills-panel.js`);

function makeSection() {
  const section = new El("section");
  const mk = (sel: string, tag = "div") => {
    const el = new El(tag);
    (el as any).__sel = sel;
    return el;
  };
  const list = mk(".skills-list");
  const status = mk(".import-status", "span");
  const urlInput = mk(".import-url", "input");
  const importBtn = mk(".import-btn", "button");
  const discoverBtn = mk(".discover-btn", "button");
  const discoveryCard = mk(".discovery-card");
  const discoverySummary = mk(".discovery-summary", "div");
  const discoveryList = mk(".discovery-list", "div");
  const discoveryActions = mk(".discovery-actions", "div");
  const importAllBtn = mk(".import-all-btn", "button");
  const importSelectedBtn = mk(".import-selected-btn", "button");
  const batchProgress = mk(".batch-progress", "div");
  const commandsList = mk(".commands-list", "div");
  section.children.push(list, status, urlInput, importBtn, discoverBtn, discoveryCard, discoverySummary, discoveryList, discoveryActions, importAllBtn, importSelectedBtn, batchProgress, commandsList);
  return { section, list, status, urlInput, importBtn, discoverBtn, discoveryCard, discoverySummary, discoveryList, discoveryActions, importAllBtn, importSelectedBtn, batchProgress, commandsList };
}

// ── pure decision functions ─────────────────────────────────────────────────
const { summarizeDiscovery, discoveryLine, selectAllEntries, selectEntriesByIds, chunkBatchSelection, commandView } =
  await import(`${ROOT}extension/skills/skills-panel.js`);

const DISCOVERY = {
  ok: true, owner: "phuryn", repo: "pm-skills", branch: "main",
  plugins: [{ name: "pm" }, { name: "dev" }],
  skills: [
    { id: "pm-triage", name: "triage", description: "Triage inbox", plugin: "pm" },
    { id: "pm-standup", name: "standup", description: "Run standup", plugin: "pm" },
    { id: "dev-review", name: "review", description: "Review a PR", plugin: "dev" },
  ],
  commands: [
    { id: "pm-standup-cmd", name: "standup", description: "Run the standup command", argumentHint: "[date]" },
  ],
  stats: { pluginCount: 2, skillCount: 3, commandCount: 1, treeCount: 42, usedTreesApi: true },
};

Deno.test("kozg.4: the discovery summary line names plugins/skills/commands and the repo", () => {
  assertEquals(discoveryLine(DISCOVERY), "Found 2 plugins, 3 skills, 1 command in phuryn/pm-skills");
  const s = summarizeDiscovery(DISCOVERY);
  assertEquals(s, { pluginCount: 2, skillCount: 3, commandCount: 1, repo: "phuryn/pm-skills" });
});

Deno.test("kozg.4: selections — import all vs checked-only, and chunking stays type-pure", () => {
  const all = selectAllEntries(DISCOVERY);
  assertEquals(all.skills.length, 3);
  assertEquals(all.commands.length, 1);
  const picked = selectEntriesByIds(DISCOVERY, ["pm-triage", "pm-standup-cmd"]);
  assertEquals(picked.skills.map((s: any) => s.id), ["pm-triage"]);
  assertEquals(picked.commands.map((c: any) => c.id), ["pm-standup-cmd"]);
  const { chunks, total } = chunkBatchSelection(all, 4);
  assertEquals(total, 4);
  assertEquals(chunks.length, 1, "a 4-item selection fits one chunk of 4");
  const { chunks: many, total: manyTotal } = chunkBatchSelection(all, 2);
  assertEquals(manyTotal, 4);
  assertEquals(many.length, 2);
  for (const c of many) {
    for (const s of c.skills) assertEquals(typeof s.id, "string");
    for (const cmd of c.commands) assertEquals(typeof cmd.id, "string");
  }
});

Deno.test("kozg.4: commandView carries the reference with the argument hint", () => {
  const view = commandView({ id: "pm-standup-cmd", name: "standup", argumentHint: "[date]", description: "Run standup" });
  assertEquals(view.ref, "/standup [date]");
  assertEquals(commandView({ id: "x", name: "x" }).ref, "/x");
});

// ── the mounted wiring, driven end to end against a fake send ───────────────

Deno.test("kozg.4: mount — Discover renders the preview card; Import all batches with progress and renders commands; Delete removes", async () => {
  const calls: Array<{ type: string; body: any }> = [];
  const sendImpl = async (type: string, body: any = {}) => {
    calls.push({ type, body });
    if (type === "skill.discover") return DISCOVERY;
    if (type === "skill.importBatch") {
      return { ok: true, skills: body.skills.map((s: any) => ({ ...s, imported: true })), commands: body.commands.map((c: any) => ({ ...c, imported: true })), errors: [] };
    }
    if (type === "command.list") {
      return { commands: [
        { id: "pm-standup-cmd", name: "standup", argumentHint: "[date]", description: "Run the standup command" },
      ] };
    }
    if (type === "command.delete") return { ok: true };
    if (type === "skill.delete") return { ok: true };
    if (type === "recipe.list") {
      return { recipes: [
        { id: "r1", name: "existing", intent: "general", description: "d", refId: "r1" },
        { id: "imp1", name: "custom-imported", intent: "general", description: "imp", refId: "imp1", source: "imported" },
      ] };
    }
    if (type === "skill.list") return { skills: [], broken: [] };
    return { ok: true };
  };

  const ui = makeSection();
  mountSkillsSection(ui.section as any, { send: sendImpl });
  // The initial mount lists commands (empty state first, then the fake one).
  await new Promise((r) => setTimeout(r, 10));
  assert(ui.commandsList.children.length > 0, "the commands list renders (empty state or rows)");

  // 1. Discover renders the preview card with the summary + one checkbox per entry.
  ui.urlInput.value = "https://github.com/phuryn/pm-skills";
  await ui.discoverBtn.dispatch("click");
  assertEquals(ui.discoveryCard.hidden, false, "the preview card is visible after discovery");
  assertEquals(ui.discoverySummary.textContent, "Found 2 plugins, 3 skills, 1 command in phuryn/pm-skills");
  const boxes = ui.discoveryList.querySelectorAll('input[type="checkbox"]');
  assertEquals(boxes.length, 4, "one checkbox per discovered skill+command");
  // The rows attach .discovery-name with the entry name
  const names = (ui.discoveryList.children as any[])
    .map((lbl: any) => lbl.children.find((c: any) => c.className === "discovery-name")?.textContent)
    .filter(Boolean);
  assertEquals(names.sort(), ["review", "standup", "standup", "triage"]);

  // 2. Import all: chunked batches, progress text, commands rendered after.
  await ui.importAllBtn.dispatch("click");
  const batchCalls = calls.filter((c) => c.type === "skill.importBatch");
  assertEquals(batchCalls.length, 1, "a 4-item selection is one bounded chunk");
  assertEquals((batchCalls[0].body.skills?.length ?? 0) + (batchCalls[0].body.commands?.length ?? 0), 4);
  assert(ui.batchProgress.textContent.includes("Imported 3 skills and 1 commands"), `progress reports the outcome: ${ui.batchProgress.textContent}`);

  // 3. The commands section renders the installed command with hint + delete.
  const textOf = (el: any): string =>
    (el.children ?? []).map((k: any) => textOf(k)).join(" ") + " " + String(el.textContent ?? "");
  const text = ui.commandsList.children.map((c: any) => textOf(c)).join(" | ");
  assert(text.includes("standup"), `the installed command renders in the commands section: ${text.slice(0, 200)}`);

  // 4. Delete removes via command.delete and refreshes the list.
  const commandRow = (ui.commandsList.children as any[]).flatMap((c: any) => c.children).find((k: any) => k.tag === "capability-row");
  assert(commandRow, "each installed command row carries a capability-row");
  assertEquals(commandRow.getAttribute("action"), "use-delete", "command row uses use-delete action");
  const beforeCmd = calls.filter((c) => c.type === "command.delete").length;
  await commandRow.dispatch("delete");
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(calls.filter((c) => c.type === "command.delete").length, beforeCmd + 1, "command.delete was sent");

  // 5. Imported skills also expose use-delete and call skill.delete without ReferenceError.
  const skillRows = (ui.list.children as any[]).flatMap((g: any) => g.children).filter((c: any) => c.tag === "div" && c.className === "recipe").map((r: any) => r.children[0]);
  const builtinRow = skillRows.find((r: any) => r.getAttribute("name") === "existing");
  const importedRow = skillRows.find((r: any) => r.getAttribute("name") === "custom-imported");
  assertEquals(builtinRow?.getAttribute("action"), "use", "built-in skill uses action=use");
  assertEquals(importedRow?.getAttribute("action"), "use-delete", "imported skill uses action=use-delete");
  const beforeSkill = calls.filter((c) => c.type === "skill.delete").length;
  await importedRow.dispatch("delete");
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(calls.filter((c) => c.type === "skill.delete").length, beforeSkill + 1, "skill.delete was sent");
});

Deno.test("kozg.4: import selected sends ONLY the checked entries", async () => {
  const calls: Array<{ type: string; body: any }> = [];
  const sendImpl = async (type: string, body: any = {}) => {
    calls.push({ type, body });
    if (type === "skill.discover") return DISCOVERY;
    if (type === "skill.importBatch") return { ok: true, skills: body.skills, commands: body.commands, errors: [] };
    if (type === "command.list") return { commands: [] };
    if (type === "recipe.list") return { recipes: [] };
    if (type === "skill.list") return { skills: [], broken: [] };
    return { ok: true };
  };
  const ui = makeSection();
  mountSkillsSection(ui.section as any, { send: sendImpl });
  await new Promise((r) => setTimeout(r, 10));
  ui.urlInput.value = "https://github.com/phuryn/pm-skills";
  await ui.discoverBtn.dispatch("click");
  // Uncheck two of the four: keep pm-triage + the command only.
  const boxes = ui.discoveryList.querySelectorAll('input[type="checkbox"]');
  assertEquals(boxes.length, 4);
  boxes[1].checked = false;
  boxes[2].checked = false;
  await ui.importSelectedBtn.dispatch("click");
  const batchCalls = calls.filter((c) => c.type === "skill.importBatch");
  assertEquals(batchCalls.length, 1);
  const ids = [
    ...batchCalls[0].body.skills.map((s: any) => s.id),
    ...batchCalls[0].body.commands.map((c: any) => c.id),
  ];
  assertEquals(ids.sort(), ["pm-standup-cmd", "pm-triage"]);
});
