// cap-evidence/rqh20-settings-templates-acceptance.ts — Browser-first acceptance check
// for chrome-agent-platform-rqh20 (Settings template agents list populated and instantiable).
import { launchChrome, openCdp, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { join } from "node:path";

const EXT = join(Deno.cwd(), "extension");
const OUT_DIR = join(Deno.cwd(), "cap-evidence", "rqh20-settings-templates");
await Deno.mkdir(OUT_DIR, { recursive: true });

const profile = chromeProfileDir("rqh20-acceptance");
console.log("Launching Chrome with unpacked extension...");
const chrome = await launchChrome({
  extension: EXT,
  profile,
  windowSize: "1400,1000",
  timeoutMs: 25000,
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

  // Wait for the panel to settle
  await new Promise((r) => setTimeout(r, 2000));

  // Inspect the host and disclosure
  const initialInspection = await cdp.eval(sessionId, `(() => {
    const host = document.querySelector("#background-agent-add");
    if (!host) return { error: "no #background-agent-add found" };
    const disclosure = host.querySelector(".starter-templates-disclosure");
    const summary = disclosure?.querySelector("summary");
    return {
      hostHidden: host.hidden,
      hasDisclosure: !!disclosure,
      summaryText: summary?.textContent?.trim(),
      role: host.getAttribute("role"),
    };
  })()`);
  console.log("Initial host inspection:", initialInspection);
  if (initialInspection.hostHidden) throw new Error("#background-agent-add is unexpectedly hidden!");

  // Expand the disclosure
  await cdp.eval(sessionId, `(() => {
    const disclosure = document.querySelector(".starter-templates-disclosure");
    if (disclosure) disclosure.open = true;
  })()`);
  await new Promise((r) => setTimeout(r, 1000));

  // Inspect the gallery and cards
  const galleryState = await cdp.eval(sessionId, `(() => {
    const gallery = document.querySelector("#background-agent-gallery");
    if (!gallery) return { error: "no #background-agent-gallery found" };
    const filter = gallery.getAttribute("filter");
    const filters = gallery.getAttribute("filters");
    const templates = gallery.templates || [];
    const root = gallery.shadowRoot;
    const cards = [...(root?.querySelectorAll("agent-template-card") ?? [])];
    const cardSummaries = cards.map(c => {
      const cr = c.shadowRoot;
      return {
        name: cr?.querySelector(".name")?.textContent?.trim(),
        persona: cr?.querySelector(".persona")?.textContent?.trim(),
        starter: !!cr?.querySelector(".starter"),
      };
    });
    return {
      filter,
      filters,
      templateCount: templates.length,
      renderedCardCount: cards.length,
      cards: cardSummaries,
    };
  })()`);
  console.log(`Gallery state: ${galleryState.templateCount} templates, ${galleryState.renderedCardCount} cards rendered`);
  console.log("Sample cards:", galleryState.cards?.slice(0, 4));

  if (!galleryState.renderedCardCount || galleryState.renderedCardCount < 7) {
    throw new Error(`Expected at least 7 starter cards rendered, got ${galleryState.renderedCardCount}`);
  }

  // Screenshot 1: Populated templates list in Settings
  const shot1 = await cdp.screenshot(sessionId);
  if (shot1) {
    const path = join(OUT_DIR, "01-templates-populated.png");
    await Deno.writeFile(path, shot1);
    console.log(`Screenshot saved: ${path}`);
  }

  // Select "Research Analyst" template
  console.log("Clicking 'Use' on Research Analyst template card...");
  const selectResult = await cdp.eval(sessionId, `(() => {
    const gallery = document.querySelector("#background-agent-gallery");
    const cards = [...(gallery?.shadowRoot?.querySelectorAll("agent-template-card") ?? [])];
    const target = cards.find(c => c.shadowRoot?.querySelector(".name")?.textContent?.includes("Research Analyst"));
    if (!target) return { ok: false, error: "Research Analyst card not found" };
    const useBtn = target.shadowRoot?.querySelector(".use");
    if (!useBtn) return { ok: false, error: "Use button not found" };
    useBtn.click();
    return { ok: true, name: target.shadowRoot?.querySelector(".name")?.textContent?.trim() };
  })()`);
  console.log("Select result:", selectResult);
  if (!selectResult.ok) throw new Error(`Failed to select template: ${selectResult.error}`);

  await new Promise((r) => setTimeout(r, 600));

  // Inspect chosen status and Add button
  const controlsState = await cdp.eval(sessionId, `(() => {
    const chosen = document.querySelector(".background-agent-add-chosen")?.textContent?.trim();
    const addBtn = document.querySelector(".background-agent-add-controls button.primary");
    return {
      chosen,
      addBtnText: addBtn?.textContent?.trim(),
      addBtnDisabled: addBtn?.disabled,
    };
  })()`);
  console.log("Controls state after selection:", controlsState);

  // Screenshot 2: Template selected
  const shot2 = await cdp.screenshot(sessionId);
  if (shot2) {
    const path = join(OUT_DIR, "02-template-selected.png");
    await Deno.writeFile(path, shot2);
    console.log(`Screenshot saved: ${path}`);
  }

  // Click Add button
  console.log("Clicking Add button to instantiate Research Analyst...");
  await cdp.eval(sessionId, `(() => {
    const addBtn = document.querySelector(".background-agent-add-controls button.primary");
    addBtn?.click();
  })()`);

  // Wait for named-agent.create to complete and Settings to refresh
  await new Promise((r) => setTimeout(r, 2000));

  // Verify Research Analyst appears in the unified agent list
  const listState = await cdp.eval(sessionId, `(() => {
    const list = document.querySelector("#unified-agent-list");
    const rows = [...(list?.querySelectorAll(".agent-settings-row") ?? [])];
    const names = rows.map(r => r.querySelector(".agent-row-title strong, .perm-name")?.textContent?.trim()).filter(Boolean);
    const flash = document.querySelector("#flash")?.textContent?.trim();
    return {
      rowCount: rows.length,
      agentNames: names,
      flashText: flash,
    };
  })()`);
  console.log("Unified agent list after adding:", listState);

  const created = listState.agentNames?.some((n: string) => n.includes("Research Analyst"));
  if (!created) {
    throw new Error(`Research Analyst not found in unified agent list! Found: ${listState.agentNames?.join(", ")}`);
  }
  console.log("SUCCESS: Research Analyst template instantiated and present in Settings agent list!");

  // Screenshot 3: Agent instantiated in list
  const shot3 = await cdp.screenshot(sessionId);
  if (shot3) {
    const path = join(OUT_DIR, "03-agent-instantiated.png");
    await Deno.writeFile(path, shot3);
    console.log(`Screenshot saved: ${path}`);
  }

  cdp.close();
} finally {
  console.log("Tearing down Chrome...");
  await teardownChrome(chrome);
}
console.log("Browser acceptance verification finished successfully.");
