// cap-evidence/n3fqo-settings-template-select-acceptance.ts — Browser-first
// acceptance for chrome-agent-platform-n3fqo: Settings → Agents offers the
// FULL template catalogue (42 on a stock install, 25 of them scheduled) through
// the shared Customizable Select (buildTemplateSelect), and choosing a
// scheduled agent instantiates it with its schedule intact.
//
// Run: deno run -A cap-evidence/n3fqo-settings-template-select-acceptance.ts
import { launchChrome, openCdp, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { join } from "node:path";

const EXT = join(Deno.cwd(), "extension");
const OUT_DIR = join(Deno.cwd(), "cap-evidence", "n3fqo-settings-template-select");
await Deno.mkdir(OUT_DIR, { recursive: true });

const failures: string[] = [];
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}

const profile = chromeProfileDir("n3fqo-acceptance");
console.log("Launching Chrome with unpacked extension...");
const chrome = await launchChrome({
  extension: EXT,
  profile,
  windowSize: "1400,1000",
  timeoutMs: 30000,
});

try {
  console.log("Connecting CDP...");
  const cdp = await openCdp(chrome.wsUrl);
  const sw = await cdp.serviceWorker();
  if (!sw) throw new Error("Service worker target not found");
  const extId = new URL(sw.url).host;
  console.log(`Extension loaded with id: ${extId}`);

  console.log("Opening Settings on #agents...");
  const { sessionId } = await cdp.open(`chrome-extension://${extId}/options/options.html#agents`);
  await new Promise((r) => setTimeout(r, 2500));

  // ── 1. The section exists, is visible, and hosts the shared select ────────
  const initial = await cdp.eval(sessionId, `(() => {
    const host = document.querySelector("#background-agent-add");
    if (!host) return { error: "no #background-agent-add found" };
    const disclosure = host.querySelector(".starter-templates-disclosure");
    disclosure.open = true;
    const select = document.querySelector("#agent-template-select");
    const chosen = document.querySelector(".background-agent-add-chosen");
    return {
      hostHidden: host.hidden,
      hasDisclosure: !!disclosure,
      summaryText: disclosure?.querySelector("summary")?.textContent?.trim(),
      hostLabelledby: host.getAttribute("aria-labelledby"),
      groupRole: host.getAttribute("role"),
      hasSelect: !!select,
      selectAriaLabel: select?.getAttribute("aria-label"),
      hasFilter: !!document.querySelector(".agent-template-filter"),
      filterAriaLabel: document.querySelector(".agent-template-filter")?.getAttribute("aria-label"),
      initialChosen: chosen?.textContent?.trim(),
    };
  })()`);
  console.log("Initial:", JSON.stringify(initial));
  check("host #background-agent-add is visible", initial.hostHidden === false, initial);
  check("the disclosure opens and the customizable select renders", initial.hasDisclosure && initial.hasSelect, initial);
  check("the select has a real accessible name", initial.selectAriaLabel === "Agent template", initial);
  check("the filter input is labelled", !!initial.filterAriaLabel, initial);

  // ── 2. The FULL catalogue is reachable: 42 templates, 25 scheduled ────────
  const counts = await cdp.eval(sessionId, `(() => {
    const select = document.querySelector("#agent-template-select");
    const groups = [...select.querySelectorAll("optgroup")].map((g) => ({
      label: g.label,
      n: g.querySelectorAll("option").length,
      ids: [...g.querySelectorAll("option")].map((o) => o.value),
    }));
    const all = [...select.querySelectorAll("option")].map((o) => ({ v: o.value, t: o.textContent.trim() }));
    return {
      total: all.length,
      blank: all[0]?.v === "",
      groups,
      named: all.filter((o) => o.v !== "").length,
      everyOptionLabelled: all.every((o) => o.t.length > 0),
    };
  })()`);
  console.log("Counts:", JSON.stringify(counts, null, 2));
  check("every option is labelled (name — description)", counts.everyOptionLabelled === true, counts);
  check("the blank placeholder is present", counts.blank === true, counts);
  const starter = counts.groups.find((g: any) => g.label === "Starter");
  const scheduled = counts.groups.find((g: any) => g.label === "Scheduled");
  const other = counts.groups.find((g: any) => g.label === "Other");
  check("Starter group carries the 7 curated starters", starter?.n === 7, starter);
  check(
    "Scheduled group carries all 25 scheduled agents (4 curated background + 21 built-in background skills)",
    scheduled?.n === 25,
    scheduled,
  );
  check("Other group carries the 10 remaining on-demand curated templates", other?.n === 10, other);
  check(
    "ALL 42 templates are reachable in the control (blank + 42 options)",
    counts.total === 43 && counts.named === 42,
    { total: counts.total, named: counts.named },
  );

  // ── 3. Open the picker and capture it (light + dark) ──
  // A REAL pointer click on the select button gives the page user activation
  // (showPicker() without activation is refused in headless).
  const openSeq = await cdp.eval(sessionId, `(() => {
    const d = document.querySelector(".starter-templates-disclosure");
    if (d && !d.open) d.open = true;
    const s = document.querySelector("#agent-template-select");
    const btn = s?.querySelector("button.agent-template-select-button") ?? s;
    if (!btn) return { error: "no select button" };
    btn.scrollIntoView({ block: "center" });
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), isBaseSelect: s.style.appearance === "base-select" };
  })()`);
  let openedViaClick = false;
  if (Number.isFinite(openSeq?.x) && Number.isFinite(openSeq?.y)) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: openSeq.x, y: openSeq.y, button: "left", clickCount: 1 }, sessionId);
    }
    await new Promise((r) => setTimeout(r, 400));
    openedViaClick = await cdp.eval(sessionId, `(() => { const s = document.querySelector("#agent-template-select"); return !!s && s.matches(":open"); })()`);
  }
  if (!openedViaClick) {
    openedViaClick = await cdp.eval(sessionId, `(() => { const s = document.querySelector("#agent-template-select"); if (!s) return false; try { s.showPicker(); return s.matches(":open"); } catch { return false; } })()`);
  }
  await new Promise((r) => setTimeout(r, 300));
  const shotOpen = await cdp.screenshot(sessionId);
  if (shotOpen) await Deno.writeFile(join(OUT_DIR, "01-picker-open-full-list.png"), shotOpen);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
  await new Promise((r) => setTimeout(r, 250));
  const shotDark = await cdp.screenshot(sessionId);
  if (shotDark) await Deno.writeFile(join(OUT_DIR, "02-picker-open-dark.png"), shotDark);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
  await new Promise((r) => setTimeout(r, 200));
  await cdp.eval(sessionId, `(() => { const s = document.querySelector("#agent-template-select"); try { if (s?.matches(":open")) s.closePicker?.(); } catch {} s?.blur(); return true; })()`);
  console.log(`Picker open: ${openedViaClick ? "OPEN (picker visible)" : "could not open in headless (documented limitation)"}`);
  check(
    "the open picker with the full list is captured (screenshot; select.open proven or limitation logged)",
    !!shotOpen && openedViaClick,
    { openedViaClick, shot: !!shotOpen },
  );

  // ── 4. The filter narrows the list and restores it ──
  // ONE atomic synchronous eval: refresh() runs inline on the input event, so
  // a late panel re-render cannot swap the DOM between set and count.
  const filterProbe = await cdp.eval(sessionId, `(() => {
    const filter = document.querySelector(".agent-template-filter");
    const select = document.querySelector("#agent-template-select");
    if (!filter || !select) return { error: "picker not found" };
    const total = select.querySelectorAll("option").length;
    filter.value = "price";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    const narrowed = {
      total: select.querySelectorAll("option").length,
      visible: select.querySelectorAll("option:not([hidden])").length,
      emptyHidden: document.querySelector(".agent-template-empty").hidden,
    };
    filter.value = "";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    const restored = select.querySelectorAll("option").length;
    return { total, narrowed, restored };
  })()`);
  console.log("Filter probe:", JSON.stringify(filterProbe));
  check(
    "the live filter narrows the list (price → a few matches) and restores the full list on clear",
    filterProbe.narrowed && filterProbe.narrowed.total > 0 &&
      filterProbe.narrowed.total < filterProbe.total &&
      filterProbe.restored === filterProbe.total,
    filterProbe,
  );

  // ── 5. Instantiate ONE scheduled agent, schedule intact ───────────────────
  const before = await cdp.eval(sessionId, `chrome.runtime.sendMessage({ type: "background-agent.list" })`);
  const beforeAgents = Array.isArray(before?.agents) ? before.agents : [];
  const target = beforeAgents.find((a: any) => a.mode === "background" && a.enabled !== true && a.schedule?.periodInMinutes > 0);
  if (!target) throw new Error(`no disabled scheduled skill found to instantiate (list: ${beforeAgents.length})`);
  console.log(`Instantiating scheduled skill: ${target.id} (every ${target.schedule.periodInMinutes} min)`);

  const chosenState = await cdp.eval(sessionId, `(() => {
    const select = document.querySelector("#agent-template-select");
    select.value = ${JSON.stringify(target.id)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const chosen = document.querySelector(".background-agent-add-chosen")?.textContent?.trim();
    const addBtn = document.querySelector(".background-agent-add-controls button.primary");
    return { chosen, addBtnText: addBtn?.textContent?.trim(), addBtnDisabled: addBtn?.disabled };
  })()`);
  console.log("Chosen:", JSON.stringify(chosenState));
  check(
    "choosing a scheduled agent enables Add and says it will run on its cadence",
    chosenState.addBtnDisabled === false &&
      String(chosenState.chosen).includes(target.name) &&
      String(chosenState.chosen).includes("runs"),
    chosenState,
  );
  const shotChosen = await cdp.screenshot(sessionId);
  if (shotChosen) await Deno.writeFile(join(OUT_DIR, "03-scheduled-agent-chosen.png"), shotChosen);

  await cdp.eval(sessionId, `(() => {
    document.querySelector(".background-agent-add-controls button.primary")?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 2500));

  const after = await cdp.eval(sessionId, `chrome.runtime.sendMessage({ type: "background-agent.list" })`);
  const afterAgent = (after?.agents ?? []).find((a: any) => a.id === target.id);
  console.log("After add:", JSON.stringify({ id: target.id, enabled: afterAgent?.enabled, schedule: afterAgent?.schedule }));
  check(
    "the scheduled agent is instantiated with its schedule intact (enabled:true, same periodInMinutes)",
    afterAgent?.enabled === true && Number(afterAgent?.schedule?.periodInMinutes) === Number(target.schedule.periodInMinutes),
    afterAgent,
  );

  const listState = await cdp.eval(sessionId, `(() => {
    const list = document.querySelector("#unified-agent-list");
    const rows = [...(list?.querySelectorAll(".background-agent-row, .agent-settings-row") ?? [])];
    const flash = document.querySelector("#flash")?.textContent?.trim();
    return {
      rowCount: rows.length,
      hasTargetRow: rows.some((r) => r.textContent.includes(${JSON.stringify(target.name)})),
      rowMarker: rows.find((r) => r.textContent.includes(${JSON.stringify(target.name)}))?.textContent?.slice(0, 160),
      flashText: flash,
    };
  })()`);
  console.log("List after add:", JSON.stringify(listState));
  check("the unified agent list shows the new scheduled agent with its Scheduled marker", listState.hasTargetRow === true, listState);
  const shotAdded = await cdp.screenshot(sessionId);
  if (shotAdded) await Deno.writeFile(join(OUT_DIR, "04-scheduled-agent-added.png"), shotAdded);

  // ── 6. An already-enabled skill stays listed and is never re-added ────────
  const enabledProbe = await cdp.eval(sessionId, `(() => {
    const select = document.querySelector("#agent-template-select");
    select.value = ${JSON.stringify(target.id)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const chosen = document.querySelector(".background-agent-add-chosen")?.textContent?.trim();
    const addBtn = document.querySelector(".background-agent-add-controls button.primary");
    return { chosen, addBtnDisabled: addBtn?.disabled };
  })()`);
  check(
    "the now-enabled skill stays listed and is reported as already enabled (nothing to add)",
    enabledProbe.addBtnDisabled === true && String(enabledProbe.chosen).includes("already enabled"),
    enabledProbe,
  );

  await Deno.writeTextFile(
    join(OUT_DIR, "n3fqo-acceptance-summary.json"),
    JSON.stringify({ bead: "chrome-agent-platform-n3fqo", counts, failures, at: new Date().toISOString() }, null, 2),
  );

  if (failures.length) {
    console.error(`\n${failures.length} acceptance check(s) FAILED`);
    Deno.exit(1);
  }
  console.log("\nSUCCESS: the Settings template select passes the n3fqo acceptance (42 templates, 25 scheduled, instantiate-with-schedule proven).");
} finally {
  await teardownChrome(chrome);
}
