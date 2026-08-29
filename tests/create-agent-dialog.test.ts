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

Deno.test("create-agent dialog: optional persona controls use one collapsed progressive disclosure", async () => {
  const ntpJs = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  assert(
    /configField\("What it does", "textarea"[\s\S]*?scrollBody\.append\(nameField\.wrap, roleField\.wrap\);/.test(ntpJs),
    "name and what-it-does must remain the direct primary path",
  );
  assert(
    /advancedDetails\.className = "agent-config-advanced";[\s\S]*?advancedSummary\.textContent = "Advanced";/.test(ntpJs),
    "optional controls must live behind one clearly labelled disclosure",
  );
  for (const control of ["avatarRow", "roleTools", "skillsDetails", "scheduleField.wrap", "delegDetails", "assetsBox"]) {
    assert(
      ntpJs.includes(`advancedBody.append(${control})`),
      `${control} must remain reachable inside Advanced`,
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
