// tests/journey-focus-fail-closed.test.ts — chrome-agent-platform-j1zcb
//
// Verifies that pre-input Page.bringToFront focus calls in scripts/chrome-journeys.ts
// (:2272 openCreateDialog and :4838 keyless composer) fail closed on CDP transport/session
// errors rather than silently swallowing rejections with .catch(() => {}) and executing
// blind input events against an unfocused or detached tab.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const journeySource = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));

Deno.test("j1zcb / 0ucue: scripts/chrome-journeys.ts does not swallow Page.bringToFront rejections at :2272, :4838, and :5302", () => {
  // Line 2272: openCreateDialog pre-Create click
  const openCreateDialogIdx = journeySource.indexOf("const openCreateDialog = async () => {");
  assert(openCreateDialogIdx > 0, "openCreateDialog must be found in scripts/chrome-journeys.ts");
  const openCreateDialogBlock = journeySource.slice(openCreateDialogIdx, openCreateDialogIdx + 500);
  assert(
    openCreateDialogBlock.includes('await cdp.send("Page.bringToFront", {}, ntpSession);'),
    "openCreateDialog must await Page.bringToFront without .catch()",
  );
  assert(
    !openCreateDialogBlock.includes('await cdp.send("Page.bringToFront", {}, ntpSession).catch('),
    "openCreateDialog must not swallow Page.bringToFront errors with .catch()",
  );

  // Line 4838: keyless composer pre-input
  const keylessIdx = journeySource.indexOf('const keylessBefore = await msgValue({ type: "thread.list" });');
  assert(keylessIdx > 0, "keyless target activation must be found in scripts/chrome-journeys.ts");
  const keylessBlock = journeySource.slice(keylessIdx, keylessIdx + 400);
  assert(
    keylessBlock.includes('await cdp.send("Page.bringToFront", {}, ntpSession);\n    await clickSel('),
    "keyless pre-input must await Page.bringToFront without .catch() before clickSel",
  );
  assert(
    !keylessBlock.includes('await cdp.send("Page.bringToFront", {}, ntpSession).catch('),
    "keyless pre-input must not swallow Page.bringToFront errors with .catch()",
  );

  // Line 5302: driveHubTask pre-input
  const driveHubTaskIdx = journeySource.indexOf("const driveHubTask = async (text) => {");
  assert(driveHubTaskIdx > 0, "driveHubTask must be found in scripts/chrome-journeys.ts");
  const driveHubTaskBlock = journeySource.slice(driveHubTaskIdx, driveHubTaskIdx + 400);
  assert(
    driveHubTaskBlock.includes('await cdp.send("Page.bringToFront", {}, ntpSession);\n      await evalIn('),
    "driveHubTask must await Page.bringToFront without .catch() before evalIn",
  );
  assert(
    !driveHubTaskBlock.includes('await cdp.send("Page.bringToFront", {}, ntpSession).catch('),
    "driveHubTask must not swallow Page.bringToFront errors with .catch()",
  );
});

Deno.test("j1zcb: openCreateDialog fails closed on Page.bringToFront rejection, dispatching zero mouse events", async () => {
  // Extract openCreateDialog definition from scripts/chrome-journeys.ts
  const start = journeySource.indexOf("const openCreateDialog = async () => {");
  assert(start > 0, "openCreateDialog start must be found");
  const end = journeySource.indexOf("await openCreateDialog();", start);
  assert(end > start, "openCreateDialog end must be found");
  const fnBody = journeySource.slice(start, end).trim();

  // 1. When Page.bringToFront rejects with dead session, openCreateDialog throws and dispatches zero mouse clicks
  const mouseEventsDispatched: Array<{ type: string; x: number; y: number }> = [];
  let clickAgentCalled = false;

  const mockCdp = {
    send: async (method: string, params: any) => {
      if (method === "Page.bringToFront") {
        throw new Error("Page.bringToFront: Session with given id not found.");
      }
      if (method === "Input.dispatchMouseEvent") {
        mouseEventsDispatched.push(params);
      }
      return {};
    },
  };

  const collaborators = {
    waitForAppReady: async (_evaluator: any, _opts: any) => true,
    evalIn: async (_cdp: any, _session: any, _expr: string) => true,
    clickVisibleCreateAgent: async (_cdp: any, _session: any, _evaluator: any, _opts: any) => {
      clickAgentCalled = true;
      mockCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 28, y: 80 });
      mockCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 28, y: 80 });
    },
    pickerState: async () => ({ open: false }),
    sleep: async (_ms: number) => {},
    cdp: mockCdp,
    ntpSession: "test-ntp-session-id",
  };

  // Compile and run the real extracted openCreateDialog
  const runner = new Function(
    "waitForAppReady",
    "evalIn",
    "clickVisibleCreateAgent",
    "pickerState",
    "sleep",
    "cdp",
    "ntpSession",
    `
    ${fnBody}
    return openCreateDialog();
    `,
  );

  let thrownError: Error | undefined;
  try {
    await runner(
      collaborators.waitForAppReady,
      collaborators.evalIn,
      collaborators.clickVisibleCreateAgent,
      collaborators.pickerState,
      collaborators.sleep,
      collaborators.cdp,
      collaborators.ntpSession,
    );
  } catch (err: any) {
    thrownError = err;
  }

  assert(thrownError !== undefined, "openCreateDialog must throw when Page.bringToFront fails");
  assert(
    thrownError.message.includes("Session with given id not found"),
    `thrown error must preserve root cause: ${thrownError.message}`,
  );
  assertEquals(clickAgentCalled, false, "clickVisibleCreateAgent must NOT be called after focus rejection");
  assertEquals(mouseEventsDispatched, [], "zero mouse events must be dispatched after focus rejection");

  // 2. Mutant check: restoring .catch(() => {}) would have called clickVisibleCreateAgent and dispatched mouse events
  const mutantFnBody = fnBody.replace(
    'await cdp.send("Page.bringToFront", {}, ntpSession);',
    'await cdp.send("Page.bringToFront", {}, ntpSession).catch(() => {});',
  );
  assert(mutantFnBody.includes(".catch("), "mutant must contain catch()");

  const mutantRunner = new Function(
    "waitForAppReady",
    "evalIn",
    "clickVisibleCreateAgent",
    "pickerState",
    "sleep",
    "cdp",
    "ntpSession",
    `
    ${mutantFnBody}
    return openCreateDialog();
    `,
  );

  let mutantCalled = false;
  const mutantMouseEvents: any[] = [];
  const mutantCollaborators = {
    ...collaborators,
    clickVisibleCreateAgent: async () => {
      mutantCalled = true;
      mutantMouseEvents.push({ type: "mousePressed" });
    },
    pickerState: async () => ({ open: true }), // settles loop immediately
  };

  await mutantRunner(
    mutantCollaborators.waitForAppReady,
    mutantCollaborators.evalIn,
    mutantCollaborators.clickVisibleCreateAgent,
    mutantCollaborators.pickerState,
    mutantCollaborators.sleep,
    mutantCollaborators.cdp,
    mutantCollaborators.ntpSession,
  );

  // The mutant SURVIVED the failure by swallowing it and dispatching input!
  assertEquals(mutantCalled, true, "mutant with .catch() silently swallows rejection and calls input handler");
  assertEquals(mutantMouseEvents.length, 1, "mutant with .catch() dispatches mouse events on dead session");
});

Deno.test("j1zcb: keyless composer pre-input fails closed on Page.bringToFront rejection, preventing typing and clicking", async () => {
  // Extract keyless pre-input block
  const anchor = 'const keylessBefore = await msgValue({ type: "thread.list" });';
  const anchorIdx = journeySource.indexOf(anchor);
  assert(anchorIdx > 0, "keyless pre-input anchor must be found");
  const start = journeySource.indexOf('await cdp.send("Target.activateTarget", { targetId: ntpPage.id })', anchorIdx);
  assert(start > 0, "keyless pre-input start must be found");
  const end = journeySource.indexOf("const KEYLESS_CARD_SEL = ", start);
  assert(end > start, "keyless pre-input end must be found");
  const blockBody = journeySource.slice(start, end).trim();

  let clickSelCalled = false;
  let typeIntoCalled = false;

  const mockCdp = {
    send: async (method: string, _params: any) => {
      if (method === "Page.bringToFront") {
        throw new Error("Page.bringToFront: Session with given id not found.");
      }
      return {};
    },
  };

  const runner = new Function(
    "cdp",
    "ntpPage",
    "ntpSession",
    "clickSel",
    "sleep",
    "check",
    "typeInto",
    "composerInput",
    "composerSend",
    `
    return (async () => {
      ${blockBody}
    })();
    `,
  );

  let thrownError: Error | undefined;
  try {
    await runner(
      mockCdp,
      { id: "test-page-id" },
      "test-session-id",
      async () => { clickSelCalled = true; return true; },
      async () => {},
      () => {},
      async () => { typeIntoCalled = true; return true; },
      () => "#input",
      () => "#send",
    );
  } catch (err: any) {
    thrownError = err;
  }

  assert(thrownError !== undefined, "keyless flow must throw when Page.bringToFront fails");
  assert(
    thrownError.message.includes("Session with given id not found"),
    `thrown error must preserve root cause: ${thrownError.message}`,
  );
  assertEquals(clickSelCalled, false, "clickSel must NOT be called when focus fails");
  assertEquals(typeIntoCalled, false, "typeInto must NOT be called when focus fails");

  // 2. Mutant check: restoring .catch(() => {}) silently swallows focus failure and continues to click & type
  const mutantBlockBody = blockBody.replace(
    'await cdp.send("Page.bringToFront", {}, ntpSession);',
    'await cdp.send("Page.bringToFront", {}, ntpSession).catch(() => {});',
  );
  assert(mutantBlockBody.includes(".catch("), "mutant must contain catch()");

  const mutantRunner = new Function(
    "cdp",
    "ntpPage",
    "ntpSession",
    "clickSel",
    "sleep",
    "check",
    "typeInto",
    "composerInput",
    "composerSend",
    `
    return (async () => {
      ${mutantBlockBody}
    })();
    `,
  );

  let mutantClickCalled = false;
  let mutantTypeCalled = false;
  await mutantRunner(
    mockCdp,
    { id: "test-page-id" },
    "test-session-id",
    async () => { mutantClickCalled = true; return true; },
    async () => {},
    () => {},
    async () => { mutantTypeCalled = true; return true; },
    () => "#input",
    () => "#send",
  );

  assertEquals(mutantClickCalled, true, "mutant with .catch() swallows error and calls clickSel");
  assertEquals(mutantTypeCalled, true, "mutant with .catch() swallows error and calls typeInto");
});

Deno.test("0ucue: driveHubTask fails closed on Page.bringToFront rejection, preventing DOM reset and input typing", async () => {
  // Extract driveHubTask block from scripts/chrome-journeys.ts
  const start = journeySource.indexOf("const driveHubTask = async (text) => {");
  assert(start > 0, "driveHubTask start must be found");
  const end = journeySource.indexOf("const pollThreadError = async (deadlineMs, done) => {", start);
  assert(end > start, "driveHubTask end must be found");
  const fnBody = journeySource.slice(start, end).trim();

  let evalInCalled = false;
  let clickSelCalled = false;
  let typeIntoCalled = false;

  const mockCdp = {
    send: async (method: string, _params: any) => {
      if (method === "Page.bringToFront") {
        throw new Error("Page.bringToFront: Session with given id not found.");
      }
      return {};
    },
  };

  const runner = new Function(
    "cdp",
    "ntpPage",
    "ntpSession",
    "evalIn",
    "sleep",
    "clickSel",
    "composerInput",
    "composerSend",
    "typeInto",
    `
    ${fnBody}
    return driveHubTask("summarize this page");
    `,
  );

  let thrownError: Error | undefined;
  try {
    await runner(
      mockCdp,
      { id: "test-ntp-page" },
      "test-ntp-session",
      async () => { evalInCalled = true; return true; },
      async () => {},
      async () => { clickSelCalled = true; return true; },
      () => "#composer-input-hub",
      () => "#composer-send-hub",
      async () => { typeIntoCalled = true; return true; },
    );
  } catch (err: any) {
    thrownError = err;
  }

  assert(thrownError !== undefined, "driveHubTask must throw when Page.bringToFront fails");
  assert(
    thrownError.message.includes("Session with given id not found"),
    `thrown error must preserve root cause: ${thrownError.message}`,
  );
  assertEquals(evalInCalled, false, "evalIn must NOT be called when focus fails");
  assertEquals(clickSelCalled, false, "clickSel must NOT be called when focus fails");
  assertEquals(typeIntoCalled, false, "typeInto must NOT be called when focus fails");

  // Mutant check: restoring .catch(() => {}) swallows focus error and invokes downstream handlers
  const mutantFnBody = fnBody.replace(
    'await cdp.send("Page.bringToFront", {}, ntpSession);',
    'await cdp.send("Page.bringToFront", {}, ntpSession).catch(() => {});',
  );
  assert(mutantFnBody.includes(".catch("), "mutant must contain catch()");

  const mutantRunner = new Function(
    "cdp",
    "ntpPage",
    "ntpSession",
    "evalIn",
    "sleep",
    "clickSel",
    "composerInput",
    "composerSend",
    "typeInto",
    `
    ${mutantFnBody}
    return driveHubTask("summarize this page");
    `,
  );

  let mutantEvalInCalled = false;
  let mutantClickSelCalled = false;
  let mutantTypeIntoCalled = false;

  await mutantRunner(
    mockCdp,
    { id: "test-ntp-page" },
    "test-ntp-session",
    async () => { mutantEvalInCalled = true; return true; },
    async () => {},
    async () => { mutantClickSelCalled = true; return true; },
    () => "#composer-input-hub",
    () => "#composer-send-hub",
    async () => { mutantTypeIntoCalled = true; return true; },
  );

  assertEquals(mutantEvalInCalled, true, "mutant with .catch() swallows error and calls evalIn");
  assertEquals(mutantClickSelCalled, true, "mutant with .catch() swallows error and calls clickSel");
  assertEquals(mutantTypeIntoCalled, true, "mutant with .catch() swallows error and calls typeInto");
});
