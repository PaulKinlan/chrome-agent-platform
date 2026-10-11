// tests/journey-focus-fail-closed.test.ts — chrome-agent-platform-j1zcb
//
// Verifies that pre-input Page.bringToFront focus calls in scripts/chrome-journeys.ts
// (:2272 openCreateDialog and :4838 keyless composer) fail closed on CDP transport/session
// errors rather than silently swallowing rejections with .catch(() => {}) and executing
// blind input events against an unfocused or detached tab.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const journeySource = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));

Deno.test("j1zcb / 0ucue / u0qo0 / 25enf: scripts/chrome-journeys.ts does not swallow Page.bringToFront rejections at :2272, :4838, :5302, :9505, and :9931", () => {
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

  // Line 9505: testTaskLifecycle step 1 pre-input
  const step1Idx = journeySource.indexOf("// ── step 1 ──");
  assert(step1Idx > 0, "testTaskLifecycle step 1 must be found in scripts/chrome-journeys.ts");
  const step1Block = journeySource.slice(step1Idx, step1Idx + 400);
  assert(
    step1Block.includes('await cdp.send("Page.bringToFront", {}, ntp);\n    await clickSel(cdp, ntp, "#home")'),
    "testTaskLifecycle step 1 must await Page.bringToFront without .catch() before clickSel",
  );
  assert(
    !step1Block.includes('await cdp.send("Page.bringToFront", {}, ntp).catch('),
    "testTaskLifecycle step 1 must not swallow Page.bringToFront errors with .catch()",
  );

  // Line 9931: testDataManagement factory reset pre-input
  const resetAnchor = journeySource.indexOf("// ── the reset: a second Settings document watches the stores ──");
  assert(resetAnchor > 0, "testDataManagement factory reset must be found in scripts/chrome-journeys.ts");
  const resetIdx = journeySource.indexOf('await cdp.send("Target.activateTarget", { targetId: optsPage.id })', resetAnchor);
  assert(resetIdx > 0, "factory reset focus anchor must be found");
  const resetBlock = journeySource.slice(resetIdx, resetIdx + 300);
  assert(
    resetBlock.includes('await cdp.send("Page.bringToFront", {}, opts);\n    await clickSel(cdp, opts, \'a.nav-item[data-section="data"]\')'),
    "testDataManagement factory reset must await Page.bringToFront without .catch() before Data nav click",
  );
  assert(
    !resetBlock.includes('await cdp.send("Page.bringToFront", {}, opts).catch('),
    "testDataManagement factory reset must not swallow Page.bringToFront errors with .catch()",
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

Deno.test("u0qo0: testTaskLifecycle step 1 fails closed on Page.bringToFront rejection, preventing clickSel and typeInto", async () => {
  // Extract testTaskLifecycle step 1 pre-input block from scripts/chrome-journeys.ts
  const start = journeySource.indexOf("// ── step 1 ──");
  assert(start > 0, "step 1 start must be found");
  const end = journeySource.indexOf("const STATE = `", start);
  assert(end > start, "step 1 end must be found");
  const step1Body = journeySource.slice(start, end).trim();

  let clickSelCount = 0;
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
    "ntp",
    "clickSel",
    "sleep",
    "typeInto",
    "composerInput",
    "composerSend",
    "DEMO_STEP1",
    `
    return (async () => {
      ${step1Body}
    })();
    `,
  );

  let thrownError: Error | undefined;
  try {
    await runner(
      mockCdp,
      { id: "test-ntp-page" },
      "test-ntp-session",
      async () => { clickSelCount++; return true; },
      async () => {},
      async () => { typeIntoCalled = true; return true; },
      () => "#composer-input-hub",
      () => "#composer-send-hub",
      "demo step 1 prompt",
    );
  } catch (err: any) {
    thrownError = err;
  }

  assert(thrownError !== undefined, "step 1 must throw when Page.bringToFront fails");
  assert(
    thrownError.message.includes("Session with given id not found"),
    `thrown error must preserve root cause: ${thrownError.message}`,
  );
  assertEquals(clickSelCount, 0, "clickSel must NOT be called when focus fails (0 calls)");
  assertEquals(typeIntoCalled, false, "typeInto must NOT be called when focus fails");

  // Mutant check: restoring .catch(() => {}) swallows focus error and invokes downstream clickSel and typeInto
  const mutantStep1Body = step1Body.replace(
    'await cdp.send("Page.bringToFront", {}, ntp);',
    'await cdp.send("Page.bringToFront", {}, ntp).catch(() => {});',
  );
  assert(mutantStep1Body.includes(".catch("), "mutant must contain catch()");

  const mutantRunner = new Function(
    "cdp",
    "ntpPage",
    "ntp",
    "clickSel",
    "sleep",
    "typeInto",
    "composerInput",
    "composerSend",
    "DEMO_STEP1",
    `
    return (async () => {
      ${mutantStep1Body}
    })();
    `,
  );

  let mutantClickCount = 0;
  let mutantTypeCalled = false;

  await mutantRunner(
    mockCdp,
    { id: "test-ntp-page" },
    "test-ntp-session",
    async () => { mutantClickCount++; return true; },
    async () => {},
    async () => { mutantTypeCalled = true; return true; },
    () => "#composer-input-hub",
    () => "#composer-send-hub",
    "demo step 1 prompt",
  );

  // The mutant survived by swallowing rejection and dispatched both clickSel (#home and #send) and typeInto!
  assertEquals(mutantClickCount, 2, "mutant with .catch() swallows error and calls clickSel twice (#home and #send)");
  assertEquals(mutantTypeCalled, true, "mutant with .catch() swallows error and calls typeInto");
});

Deno.test("25enf: testDataManagement factory reset fails closed on Page.bringToFront rejection, preventing DOM clickSel and mutation", async () => {
  // Extract testDataManagement factory reset block from scripts/chrome-journeys.ts
  const start = journeySource.indexOf("await cdp.send(\"Target.activateTarget\", { targetId: optsPage.id })", journeySource.indexOf("// ── the reset: a second Settings document watches the stores ──"));
  assert(start > 0, "factory reset focus block start must be found");
  const end = journeySource.indexOf("report(DIALOG,", start);
  assert(end > start, "factory reset focus block end must be found");
  const resetBody = journeySource.slice(start, end).trim();

  let clickSelCount = 0;
  let boxOfCalled = false;
  let evalInCalled = false;

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
    "optsPage",
    "opts",
    "clickSel",
    "sleep",
    "boxOf",
    "evalIn",
    "captureShot",
    "writeEvidence",
    `
    return (async () => {
      ${resetBody}
    })();
    `,
  );

  let thrownError: Error | undefined;
  try {
    await runner(
      mockCdp,
      { id: "test-opts-page" },
      "test-opts-session",
      async () => { clickSelCount++; return true; },
      async () => {},
      async () => { boxOfCalled = true; return { x: 10, y: 10 }; },
      async () => { evalInCalled = true; return "Delete everything permanent"; },
      async () => null,
      async () => {},
    );
  } catch (err: any) {
    thrownError = err;
  }

  assert(thrownError !== undefined, "factory reset sequence must throw when Page.bringToFront fails");
  assert(
    thrownError.message.includes("Session with given id not found"),
    `thrown error must preserve root cause: ${thrownError.message}`,
  );
  assertEquals(clickSelCount, 0, "clickSel must NOT be called when focus fails (0 clicks)");
  assertEquals(boxOfCalled, false, "boxOf must NOT be called when focus fails");
  assertEquals(evalInCalled, false, "evalIn must NOT be called when focus fails");

  // Mutant check: restoring .catch(() => {}) swallows focus error and invokes clickSel and boxOf
  const mutantResetBody = resetBody.replace(
    'await cdp.send("Page.bringToFront", {}, opts);',
    'await cdp.send("Page.bringToFront", {}, opts).catch(() => {});',
  );
  assert(mutantResetBody.includes(".catch("), "mutant must contain catch()");

  const mutantRunner = new Function(
    "cdp",
    "optsPage",
    "opts",
    "clickSel",
    "sleep",
    "boxOf",
    "evalIn",
    "captureShot",
    "writeEvidence",
    `
    return (async () => {
      ${mutantResetBody}
    })();
    `,
  );

  let mutantClickCount = 0;
  let mutantBoxOfCalled = false;

  await mutantRunner(
    mockCdp,
    { id: "test-opts-page" },
    "test-opts-session",
    async () => { mutantClickCount++; return true; },
    async () => {},
    async () => { mutantBoxOfCalled = true; return { x: 10, y: 10 }; },
    async () => "Delete everything permanent",
    async () => null,
    async () => {},
  );

  // The mutant survived by swallowing rejection and dispatched clicks to Data nav and Reset button!
  assertEquals(mutantClickCount, 2, "mutant with .catch() swallows error and calls clickSel twice (Data nav and Reset button)");
  assertEquals(mutantBoxOfCalled, true, "mutant with .catch() swallows error and calls boxOf to poll dialog");
});
