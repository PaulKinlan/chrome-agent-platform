// l42d: execute the REAL delegated rail click and restore functions against a
// held old kv.get. A width-policy change exposes the icon rail while boot waits.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runInNewContext } from "node:vm";
import { SIDEBAR_NARROW_QUERY, sidebarWidthPolicy } from "../extension/ntp/view-policy.js";

const source = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
function between(start: string, end: string): string {
  const from = source.indexOf(start);
  assert(from >= 0 && source.indexOf(start, from + 1) < 0, `unique source start: ${start}`);
  const to = source.indexOf(end, from);
  assert(to > from, `source end after start: ${end}`);
  return source.slice(from, to);
}
const behavior = between("let sidebarCollapsed = false;", "const SIDE_DISCLOSURES_KEY");
const railAndRestore = between("const SIDE_DISCLOSURES_KEY", '// The "+" new-task button')
  .replace("export const SIDE_COLLAPSED_KEY =", "const SIDE_COLLAPSED_KEY =");
assert(railAndRestore.includes("function initSideRailNav()") && railAndRestore.includes("async function restoreSidebar()"),
  "the fixture must execute the actual rail click and restore, not copies");

Deno.test("l42d: rail click during held boot read survives stale saved-true reply", async () => {
  const trace: string[] = [];
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const railHandlers: Array<(event: unknown) => void> = [];
  const target = {
    tagName: "DETAILS", hidden: false, open: false,
    addEventListener() {},
    querySelector() { return null; },
    focus() { trace.push("target focused"); },
    scrollIntoView() { trace.push("target scrolled"); },
  };
  const side = {
    classList: {
      toggle(name: string, active: boolean) { if (active) classes.add(name); else classes.delete(name); },
      remove(name: string) { classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    },
    querySelector(selector: string) { return selector === "#tasks-section" ? target : null; },
    querySelectorAll() { return []; },
    after() {},
    dataset: {} as Record<string, string>,
  };
  const railNav = {
    addEventListener(name: string, listener: (event: unknown) => void) {
      assertEquals(name, "click");
      railHandlers.push(listener);
    },
    click() {
      assert(railHandlers.length > 0, "eager delegated rail handler must be installed");
      trace.push("rail button click");
      const button = { dataset: { railTarget: "tasks-section" } };
      for (const listener of railHandlers) listener({ target: { closest(selector: string) {
        assertEquals(selector, ".rail-sec-btn");
        return button;
      } } });
    },
  };
  const sideToggle = {
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    addEventListener() {},
  };
  const media = { matches: false, addEventListener() {} };
  const saved = { value: true, writes: [] as boolean[] };
  let releaseRead: ((value: Record<string, boolean>) => void) | undefined;
  const heldRead = new Promise<Record<string, boolean>>((resolve) => { releaseRead = resolve; });
  const send = (type: string, payload: { values?: Record<string, boolean> }) => {
    if (type === "kv.get") { trace.push("kv.get held (saved true)"); return heldRead; }
    if (type === "kv.set") {
      const value = payload.values?.["hub.sidebarCollapsed"];
      assertEquals(typeof value, "boolean", "the real persistence path must write a boolean");
      saved.value = value!;
      saved.writes.push(value!);
      trace.push(`kv.set ${value}`);
      return Promise.resolve({ ok: true, mode: "durable" });
    }
    throw new Error(`unexpected route ${type}`);
  };
  const memory = new Map<string, string>();
  const localStorage = {
    getItem(key: string) { return memory.get(key) ?? null; },
    setItem(key: string, value: string) { memory.set(key, value); },
  };
  const document = {
    addEventListener() {},
    getElementById(id: string) { return id === "side-rail-nav" ? railNav : id === "tasks-section" ? target : null; },
    createElement() { return { setAttribute() {}, addEventListener() {}, hidden: false }; },
  };
  const api = runInNewContext(`${behavior}\n${railAndRestore}\n({
    initSideRailNav, restoreSidebar, applySidebarForWidth, writes: () => sidebarWriteQueue,
    snapshot: () => ({ collapsed: sidebarCollapsed, savedChoice: persistedSidebarCollapsed,
      userToggled: sidebarUserToggled, visibleCollapsed: side.classList.contains("collapsed") })
  })`, {
    side, sideToggle, window: { matchMedia: () => media }, document, localStorage, send,
    sidebarWidthPolicy, SIDEBAR_NARROW_QUERY,
    runRouteUpdate: (fn: () => void) => fn(),
    renderDurabilityState() {}, durabilityHint: null, ntpLog: { warn() {} },
  }) as {
    initSideRailNav(): void;
    restoreSidebar(): Promise<void>;
    applySidebarForWidth(): void;
    writes(): Promise<void>;
    snapshot(): { collapsed: boolean; savedChoice: boolean; userToggled: boolean; visibleCollapsed: boolean };
  };
  api.initSideRailNav(); // real page also binds eagerly before the boot reply
  const restoring = api.restoreSidebar();
  media.matches = true;
  api.applySidebarForWidth(); // real matchMedia change auto-exposes icon rail
  assertEquals(api.snapshot().visibleCollapsed, true, "narrow policy must first expose the rail");
  railNav.click();
  await api.writes();
  assertEquals(target.open, true, "delegated click must reach its target section");
  assertEquals(saved.writes, [false], "rail expansion must persist the user's expanded choice");
  media.matches = false;
  api.applySidebarForWidth(); // return wide before the held old read settles
  trace.push(`before reply ${JSON.stringify(api.snapshot())}`);
  assert(releaseRead, "boot read must still be held");
  trace.push("kv.get released true");
  releaseRead({ "hub.sidebarCollapsed": true });
  await restoring;
  await api.writes();
  trace.push(`after reply ${JSON.stringify(api.snapshot())}, durable=${saved.value}`);
  console.log(`L42D_EVENT_TRACE ${JSON.stringify(trace)}`);
  assertEquals(api.snapshot().userToggled, true, "rail click must establish explicit user intent");
  assertEquals(api.snapshot().visibleCollapsed, false, "stale boot reply must not re-collapse the visible rail");
  assertEquals(api.snapshot().savedChoice, false, "stale boot reply must not overwrite the new choice");
  assertEquals(saved.writes, [false], "stale boot reply must not persist the old choice again");
  assertEquals(saved.value, false);
  assertEquals(attributes.get("aria-expanded"), "true");
});
