// tests/hub-first-run-layout.test.ts — pins for bead chrome-agent-platform-716s.5
// Hub first run: single primary, single status, full-width/hidden Jobs column, unclipped brand, harnesses below Tasks.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (p: string) =>
  Deno.readTextFile(new URL(p, new URL("../", import.meta.url)));

Deno.test("716s.5: sidebar DOM reorders harnesses below tasks, with sidebar-threads-head and auto-collapse", async () => {
  const html = await read("./extension/ntp/ntp.html");

  const tasksIndex = html.indexOf('class="side-section side-tasks"');
  const threadListIndex = html.indexOf('id="thread-list"');
  const harnessIndex = html.indexOf('id="sidebar-harnesses-section"');

  assert(tasksIndex !== -1, "side-tasks section not found");
  assert(threadListIndex !== -1, "thread-list not found");
  assert(harnessIndex !== -1, "sidebar-harnesses-section not found");
  assert(threadListIndex < harnessIndex, "Tasks (#thread-list) must appear BEFORE harnesses (#sidebar-harnesses-section) in DOM order");
  assert(html.includes("sidebar-threads-head"), "sidebar-threads-head class must be present on thread header row");
});

Deno.test("716s.5: brand text in sidebar is unclipped at 240px sidebar width", async () => {
  const html = await read("./extension/ntp/ntp.html");

  // .brand-row .brand must allow wrapping or unclipped display (not clipped nowrap with ellipsis)
  assert(!html.includes(".brand-row .brand { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }"),
    "brand must not be forced to single-line nowrap ellipsis in brand-row");
  assert(html.includes(".brand .brand-text"), ".brand .brand-text styling should exist");
});

Deno.test("716s.5: jobs / work-col expands to full width or collapses when empty", async () => {
  const html = await read("./extension/ntp/ntp.html");

  // .main-wrap / .hub-columns expands when sibling is hidden or work-col is empty
  assert(html.includes("hub-columns"), "hub-columns class must be present on main-wrap");
  assert(html.includes("work-col"), "work-col must be present on jobs section");
  assert(html.includes("feed-col"), "feed-col must be present on activity / agents section");
  assert(html.includes('data-empty="true"'), 'data-empty attribute support required');
  assert(html.includes("grid-template-columns: minmax(0, 1fr)"), "1fr full-width grid expansion rule must exist");
});

Deno.test("716s.5: single primary CTA on first run — composer send button demoted when disabled/empty", async () => {
  const componentsJs = [
    await read("./extension/shared/components-hub.js"),
    await read("./extension/shared/components-conversation.js"),
  ].join("\n");

  // FirstRunGuide must have onboarding card and onboarding-cta / onboarding-settings identifiers
  assert(componentsJs.includes("onboarding-card"), "first-run-guide must include onboarding-card");
  assert(componentsJs.includes("onboarding-cta"), "first-run-guide CTA button must have onboarding-cta");
  assert(componentsJs.includes("onboarding-settings"), "first-run-guide CTA must have onboarding-settings id");

  // AgentComposer send button must have composer-send class and disabled styling
  assert(componentsJs.includes("composer-send"), "AgentComposer send button must include composer-send class");
  assert(componentsJs.includes(".composer-send:disabled") || componentsJs.includes(".send:disabled"),
    "disabled styling for send button must be defined");
  assert(componentsJs.includes("var(--surface-hover"), "disabled send button should use --surface-hover");
});

Deno.test("716s.5: single provider status statement — provider-pill hidden when onboarding is shown", async () => {
  const html = await read("./extension/ntp/ntp.html");
  const ntpJs = await read("./extension/ntp/ntp.js");

  assert(html.includes("provider-pill"), "provider-pill identifier/class must be present in top-actions");
  assert(html.includes("timeline-empty"), "timeline-empty container must be present");
  assert(ntpJs.includes("isFirstRunVisible") || ntpJs.includes("firstRunGuide") && ntpJs.includes("slot.hidden = true"),
    "renderProviderStatus must hide status pill when onboarding banner is visible");
});
