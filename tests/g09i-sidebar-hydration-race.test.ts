// rkrn: drive the REAL sidebar state/restore/click functions with an in-memory
// DOM and a held kv.get. The real-Chrome counterpart lives in
// scripts/kat-sidebar-hydration-race.ts, outside the parallel unit phase.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runInNewContext } from "node:vm";
import { SIDEBAR_NARROW_QUERY, sidebarWidthPolicy } from "../extension/ntp/view-policy.js";

// Optional source-path override is ONLY for the external falsification command:
// feed a temporary copy with the restore guard removed and watch the wide arm
// RED on the flipped DOM + saved value; normal gates always read product source.
const source = await Deno.readTextFile(Deno.env.get("CAP_RKRN_HYDRATION_SOURCE") ||
  new URL("../extension/ntp/ntp.js", import.meta.url));

function between(start: string, end: string, from = 0): string {
  const first = source.indexOf(start, from);
  assert(first >= 0 && source.indexOf(start, first + 1) < 0, `unique source start: ${start}`);
  const last = source.indexOf(end, first);
  assert(last > first, `source end after start: ${end}`);
  return source.slice(first, last);
}

// Extract these actual functions, not a reimplementation of the tested guard.
// A source layout change must fail this harness visibly instead of going green
// by testing a stale copy. The separate browser KAT exercises the whole page.
const behavior = between("let sidebarCollapsed = false;", "const SIDE_DISCLOSURES_KEY");
const restore = between("async function restoreSidebar()", '// The "+" new-task button');

type Fixture = { narrow?: boolean; stored?: boolean; restoreOverride?: string };
function fixture({ narrow = false, stored = false, restoreOverride }: Fixture = {}) {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const side = {
    classList: {
      toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    },
    querySelectorAll() { return []; },
    after() {},
    dataset: {} as Record<string, string>,
  };
  const sideToggle = {
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    getAttribute(name: string) { return attributes.get(name); },
    addEventListener(name: string, fn: () => void) { listeners.set(name, fn); },
    click() { const fn = listeners.get("click"); assert(fn, "real click handler must be installed"); fn(); },
  };
  const media = { matches: narrow, addEventListener() {} };
  const saved = { value: stored, writes: [] as boolean[], getStarted: 0 };
  let releaseRead: ((value: Record<string, boolean>) => void) | undefined;
  const heldRead = new Promise<Record<string, boolean>>((resolve) => { releaseRead = resolve; });
  const send = (type: string, payload: { values?: Record<string, boolean> }) => {
    if (type === "kv.get") { saved.getStarted++; return heldRead; }
    if (type === "kv.set") {
      const value = payload.values?.["hub.sidebarCollapsed"];
      assertEquals(typeof value, "boolean", "real setter must persist a boolean");
      saved.value = value!;
      saved.writes.push(value!);
      return Promise.resolve({ ok: true, mode: "durable" });
    }
    throw new Error(`unexpected route ${type}`);
  };
  const document = {
    addEventListener() {},
    createElement() { return { setAttribute() {}, addEventListener() {}, hidden: false }; },
  };
  const api = runInNewContext(`${behavior}\n${restoreOverride ?? restore}\n({
    restoreSidebar, applySidebarForWidth, writes: () => sidebarWriteQueue,
    snapshot: () => ({ collapsed: sidebarCollapsed, savedChoice: persistedSidebarCollapsed,
      userToggled: sidebarUserToggled, overlay: sidebarOverlayOpen })
  })`, {
    side, sideToggle, window: { matchMedia: () => media }, document,
    send, sidebarWidthPolicy, SIDEBAR_NARROW_QUERY,
    renderDurabilityState: ({ side: target }: { side: { dataset: Record<string, string> } }, durability: string) => { target.dataset.durability = durability; },
    durabilityHint: null, ntpLog: { warn() {} }, runRouteUpdate: (fn: () => void) => fn(),
    initSideDisclosures() {}, initSideRailNav() {},
  });
  return {
    api: api as {
      restoreSidebar(): Promise<void>;
      applySidebarForWidth(): void;
      writes(): Promise<void>;
      snapshot(): { collapsed: boolean; savedChoice: boolean; userToggled: boolean; overlay: boolean };
    },
    side, sideToggle, media, saved,
    releaseRead: (value: boolean) => { assert(releaseRead); releaseRead({ "hub.sidebarCollapsed": value }); },
  };
}

Deno.test("rkrn: held old boot reply cannot undo a later wide collapse or its durable value", async () => {
  const f = fixture();
  const restoring = f.api.restoreSidebar();
  assertEquals(f.saved.getStarted, 1, "boot read must genuinely be pending");
  f.sideToggle.click();
  await f.api.writes();
  assertEquals(f.api.snapshot().collapsed, true);
  assertEquals(f.saved.value, true);
  assertEquals(f.saved.writes, [true]);
  assertEquals(f.sideToggle.getAttribute("aria-expanded"), "false");
  f.releaseRead(false);
  await restoring;
  await f.api.writes();
  assertEquals(f.api.snapshot().collapsed, true, "stale reply cannot reverse visible collapse");
  assertEquals(f.api.snapshot().savedChoice, true, "stale reply cannot reverse saved choice");
  assertEquals(f.saved.value, true, "stale reply cannot write false to storage");
  assertEquals(f.saved.writes, [true], "no extra persist from stale hydration");
  assertEquals(f.sideToggle.getAttribute("aria-expanded"), "false");
  assertEquals(f.side.dataset.durability, "durable");
});

Deno.test("rkrn: narrow overlay click does not displace held saved-true choice when returning wide", async () => {
  const f = fixture({ narrow: true, stored: true });
  f.api.applySidebarForWidth();
  const restoring = f.api.restoreSidebar();
  f.sideToggle.click();
  assertEquals(f.api.snapshot().overlay, true);
  assertEquals(f.api.snapshot().userToggled, false, "transient overlay is not a persisted-choice click");
  f.releaseRead(true);
  await restoring;
  f.media.matches = false;
  f.api.applySidebarForWidth();
  await f.api.writes();
  assertEquals(f.api.snapshot().collapsed, true);
  assertEquals(f.api.snapshot().savedChoice, true);
  assertEquals(f.saved.value, true);
  assert(!f.api.snapshot().overlay, "overlay closes on wide resize");
});

Deno.test("rkrn harness honesty: removing the wide restore guard reproduces the old visible and stored flip", async () => {
  const oldRestore = restore.replaceAll("if (!sidebarUserToggled) persistedSidebarCollapsed =", "persistedSidebarCollapsed =");
  assert(oldRestore !== restore && !oldRestore.includes("if (!sidebarUserToggled) persistedSidebarCollapsed ="));
  const f = fixture({ restoreOverride: oldRestore });
  const restoring = f.api.restoreSidebar();
  f.sideToggle.click();
  await f.api.writes();
  f.releaseRead(false);
  await restoring;
  await f.api.writes();
  assertEquals(f.api.snapshot().collapsed, false, "legacy stale reply flips the visible rail open");
  assertEquals(f.saved.value, false, "legacy path wrongly persists false");
});
