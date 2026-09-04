// tests/create-agent-dialog.test.ts — Verification of create-agent dialog structure,
// unclipped focus, sticky footer, collapsible skills, and overscroll containment
// (CAP-FB-20260823-CREATE-AGENT-DIALOG-01).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("AgentDialog: components.js enforces overscroll containment and non-clipped flex column layout", async () => {
  const componentsJs = await Deno.readTextFile(
    new URL("../extension/shared/components.js", import.meta.url),
  );

  // .dialog must have overscroll-behavior: contain and overflow: hidden
  assert(
    componentsJs.includes("overscroll-behavior:contain;") || componentsJs.includes("overscroll-behavior: contain;"),
    "AgentDialog must enforce overscroll-behavior: contain to prevent background scroll chaining",
  );
  assert(
    componentsJs.includes("display:flex; flex-direction:column;") || componentsJs.includes("display: flex; flex-direction: column;"),
    "AgentDialog must use flex column layout",
  );
});

Deno.test("create-agent dialog: sticky footer sits outside scrollable body with Create and Cancel controls", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  // Checks .agent-config-footer with sticky bottom
  assert(
    /footer\.className = "agent-config-footer";[\s\S]*?footer\.style\.position = "sticky";[\s\S]*?footer\.style\.bottom = "0";/
      .test(ntpJs),
    "dialog footer must be sticky at bottom",
  );

  // Footer contains cancelBtn and saveBtn
  assert(
    /footer\.append\(cancelBtn, saveBtn\);/.test(ntpJs),
    "footer must contain Cancel and Save/Create buttons",
  );

  // Container appends scrollBody then footer
  assert(
    /container\.append\(scrollBody, footer\);/.test(ntpJs),
    "container must place footer outside the scrollable body",
  );
});

Deno.test("create-agent dialog: primary hierarchy keeps voice, template and schedule visible before Advanced", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  assert(
    // The template gallery is the FIRST step of the create flow
    // (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01), then name + purpose.
    /configField\("What it does", "textarea"[\s\S]*?roleField\.wrap\.append\(roleTools\);[\s\S]*?if \(templateSection\) scrollBody\.append\(templateSection\);\s*scrollBody\.append\(nameField\.wrap, roleField\.wrap\);/.test(ntpJs),
    "template gallery, then name and purpose with voice tools, must remain on the direct primary path",
  );
  assert(
    /scrollBody\.insertBefore\(scheduleField\.wrap, advancedDetails\);/.test(ntpJs),
    "the English schedule must remain visible immediately before Advanced",
  );
  assert(
    /advancedDetails\.className = "agent-config-advanced";[\s\S]*?advancedSummary\.textContent = "Advanced";/.test(ntpJs),
    "less-common controls must remain behind one clearly labelled disclosure",
  );
  for (const control of ["avatarRow", "skillsDetails", "delegDetails", "assetsBox"]) {
    assert(
      ntpJs.includes(`advancedBody.append(${control})`),
      `${control} must remain reachable inside Advanced`,
    );
  }
});

Deno.test("create-agent dialog: schedule input confirms supported English and blocks invalid text", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  assert(ntpJs.includes('configField("Run on a schedule", "input"'), "schedule must be free text");
  assert(ntpJs.includes('placeholder = "every couple of minutes"'), "schedule needs a natural-language example");
  assert(ntpJs.includes('scheduleFeedback.setAttribute("aria-live", "polite")'), "interpretation must be announced without stealing focus");
  assert(ntpJs.includes("Try: every 10 minutes / every hour"), "parse feedback must suggest only supported schedules");
  assert(!ntpJs.includes("Try: every 10 minutes / every hour / weekdays at 9am"), "parse feedback must not recommend rejected calendar timing");
  assert(
    /if \(parsedSchedule\.error\) \{[\s\S]*?scheduleField\.el\.focus\(\);[\s\S]*?return;/.test(ntpJs),
    "unparseable text must stop save rather than create a guessed schedule",
  );
});

Deno.test("create-agent dialog: partial schedule failure is reported without hiding the saved agent", async () => {
  const [ntpJs, serviceWorkerJs] = await Promise.all([
    Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url)),
    Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url)),
  ]);

  assert(serviceWorkerJs.includes('return { ...r, scheduleError: s?.error ?? "schedule failed" };'), "create route must expose partial schedule failure");
  assert(/const id = r\.agent\?\.id \?\? v\.name;/.test(ntpJs), "the created agent id is derived from the create response");
  assert(/return \{ ok: true, id, firstTask: v\.firstTask, scheduleError: r\.scheduleError/.test(ntpJs), "dialog adapter must preserve scheduleError from an otherwise successful create");
  assert(/r\.scheduleError\s*\? `Agent “\$\{name\}” saved, but its schedule was not created: \$\{r\.scheduleError\}`/.test(ntpJs), "{ ok: true, scheduleError } must render an explicit partial-success warning");
  assert(/await opts\.onSaved\?\.\(r\);/.test(ntpJs), "partial success must still open the agent that was created");
});

Deno.test("create-agent dialog: fixed inline size prevents disclosure width jitter", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  assert(
    /container\.style\.width = "min\(88vw, 540px\)";[\s\S]*?container\.style\.minWidth = "0";[\s\S]*?container\.style\.maxWidth = "100%";/.test(ntpJs),
    "dialog content must have one clamped width rather than a content-driven min-width",
  );
  for (const disclosure of ["advancedDetails", "skillsDetails"]) {
    assert(
      ntpJs.includes(`${disclosure}.style.minWidth = "0"`) && ntpJs.includes(`${disclosure}.style.maxWidth = "100%"`),
      `${disclosure} must shrink inside the fixed dialog width`,
    );
  }
});

Deno.test("create-agent dialog: skills section is collapsible to keep footer visible", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  // Uses <details class="skills-collapse"> with <summary> and <div class="skills-list">
  assert(
    /skillsDetails\.className = "skills-collapse";[\s\S]*?skillsSummary[\s\S]*?skillsList\.className = "skills-list";/
      .test(ntpJs),
    "skills must be housed inside a collapsible details component",
  );

  // The skills list is NOT its own scroll island: it flows into the dialog's
  // single scroll body so every skill and everything below it stays reachable
  // by ONE scrollbar. The previous 180px cap + overflow-y:auto +
  // overscroll-behavior:contain ate the wheel over the list and blocked
  // reaching content beneath it (owner: "nothing underneath it is
  // accessible"). These assertions are RED if anyone reintroduces the cap.
  assert(
    !/skillsList\.style\.maxHeight = "180px";/.test(ntpJs),
    "skills list must NOT cap its height (no inner scroll island — the dialog scrolls as one body)",
  );
  assert(
    !/skillsList\.style\.overflowY = "auto";/.test(ntpJs),
    "skills list must NOT be its own scroll container",
  );
});

Deno.test("create-agent dialog: scroll container and inputs have unclipped focus and overscroll containment", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  // Scroll body has min-height:0 + overscroll-behavior: contain and scroll-padding
  // (min-height:0 is what lets the body scroll past Advanced/Skills instead of
  // growing the container and clipping — RED if regressed to auto).
  assert(
    /scrollBody\.style\.minHeight = "0";[\s\S]*?scrollBody\.style\.overflowY = "auto";/.test(ntpJs),
    "scrollBody must set min-height: 0 and overflow-y: auto so the dialog scrolls as one body",
  );
  assert(
    /scrollBody\.style\.overscrollBehavior = "contain";[\s\S]*?scrollBody\.style\.scrollPadding = "12px";/
      .test(ntpJs),
    "scrollBody must set overscrollBehavior: contain and scrollPadding",
  );

  // configField sets outline-offset: 0px and width: 100%
  assert(
    /el\.style\.boxSizing = "border-box";[\s\S]*?el\.style\.outlineOffset = "0px";/
      .test(ntpJs),
    "configField inputs must set outlineOffset: 0px and boxSizing: border-box for unclipped focus",
  );
});

Deno.test("create-agent dialog: journey skills-wheel probe advances past the post-scrollIntoView position and hits the list itself", async () => {
  const journeys = await Deno.readTextFile(
    new URL("../scripts/chrome-journeys.ts", import.meta.url),
  );

  // The probe records the outer scroll position AFTER scrollIntoView moved it
  // (r2 finding: scrollIntoView can move the scroller before the wheel, so a
  // bare scrollTop > 0 final assertion false-passes — the centering did the
  // moving, not the wheel). RED if the pre-scroll capture is dropped.
  assert(
    journeys.includes("scrollTopBeforeSkillsWheel: sc?.scrollTop ?? null"),
    "skills-wheel probe must capture the outer scrollTop after scrollIntoView",
  );
  assert(
    journeys.includes("(scrollProbe.scrollTopAfterSkillsWheel ?? 0) > (scrollProbe.scrollTopBeforeSkillsWheel ?? 0)"),
    "skills-wheel gate must assert advancement from the post-scrollIntoView position, not merely scrollTop > 0",
  );
  // The wheel-coordinate hit test must land ON the skills list (the element or
  // a descendant) — a hit anywhere inside .agent-config-scroll false-passes by
  // wheeling a sibling surface.
  assert(
    journeys.includes("(sl === at || sl.contains(at))"),
    "skills-wheel hit test must require the point to be on .skills-list, not anywhere in the scroll body",
  );
  assert(
    journeys.includes("skProbe.hitSkillsList"),
    "the wheel dispatch must be gated on the skills-list-specific hit test",
  );
});

Deno.test("create-agent dialog: journey asserts below-Skills reachability via .agent-mcp-box intersection", async () => {
  const journeys = await Deno.readTextFile(
    new URL("../scripts/chrome-journeys.ts", import.meta.url),
  );

  // Below-Skills reachability was captured as a screenshot but never asserted
  // (r2 finding). The probe must measure the follower element (.agent-mcp-box,
  // appended to the Advanced body after the skills section) and the gate must
  // require its intersection with the scroll viewport.
  assert(
    journeys.includes("document.querySelector('.agent-mcp-box')"),
    "deep-scroll probe must measure the .agent-mcp-box follower below the skills section",
  );
  assert(
    journeys.includes("mcpIntersects: mr.width > 0"),
    "deep-scroll probe must record whether .agent-mcp-box intersects the scroll viewport",
  );
  assert(
    journeys.includes("scrollProbe.mcpFound === true &&"),
    "gate must require the below-Skills follower to exist",
  );
  assert(
    journeys.includes("scrollProbe.mcpIntersects === true,"),
    "gate must assert .agent-mcp-box is reachable after scrolling past skills",
  );
});
