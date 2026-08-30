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
  assert(/\{ ok: true, id: r\.agent\?\.id \?\? v\.name, firstTask: v\.firstTask, scheduleError: r\.scheduleError \}/.test(ntpJs), "dialog adapter must preserve scheduleError from an otherwise successful create");
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

  assert(
    /skillsList\.style\.maxHeight = "180px";[\s\S]*?skillsList\.style\.overflowY = "auto";/
      .test(ntpJs),
    "skills list must have max-height and overflow-y: auto",
  );
});

Deno.test("create-agent dialog: scroll container and inputs have unclipped focus and overscroll containment", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  // Scroll body has overscroll-behavior: contain and scroll-padding
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
