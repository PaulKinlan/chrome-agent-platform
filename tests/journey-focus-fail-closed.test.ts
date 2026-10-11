// tests/journey-focus-fail-closed.test.ts — chrome-agent-platform-j1zcb
//
// Verifies that pre-input Page.bringToFront focus calls in scripts/chrome-journeys.ts
// (:2272 openCreateDialog and :4838 keyless composer) fail closed on CDP transport/session
// errors rather than silently swallowing rejections with .catch(() => {}) and executing
// blind input events against an unfocused or detached tab.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const journeySource = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));

Deno.test("j1zcb / 0ucue / u0qo0 / 25enf / 5ui2q / hpm8f / fk9pq: scripts/chrome-journeys.ts does not swallow tab activation/focus rejections", () => {
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

  // Line 3573: testActionLedgerJourney Target.activateTarget pre-input
  const ledgerIdx = journeySource.indexOf("const ledgerBeforeIds = await listRunIds(cdp, ledgerOptsSession);");
  assert(ledgerIdx > 0, "testActionLedgerJourney must be found in scripts/chrome-journeys.ts");
  const ledgerBlock = journeySource.slice(ledgerIdx - 500, ledgerIdx);
  assert(
    ledgerBlock.includes('await cdp.send("Target.activateTarget", { targetId: ntpPage.id });\n      await clickSel(cdp, ntpSession, "#home")'),
    "testActionLedgerJourney must await Target.activateTarget without .catch() before #home click",
  );
  assert(
    !ledgerBlock.includes('await cdp.send("Target.activateTarget", { targetId: ntpPage.id }).catch('),
    "testActionLedgerJourney must not swallow Target.activateTarget errors with .catch()",
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

  // Line 8115: captureApprovalEvidence pre-screenshot focus
  const approvalIdx = journeySource.indexOf("const captureApprovalEvidence = async (name) => {");
  assert(approvalIdx > 0, "captureApprovalEvidence must be found in scripts/chrome-journeys.ts");
  const approvalBlock = journeySource.slice(approvalIdx, approvalIdx + 300);
  assert(
    approvalBlock.includes('await cdp.send("Page.bringToFront", {}, optsSession);\n      let shot = null;'),
    "captureApprovalEvidence must await Page.bringToFront without .catch() before screenshot retries",
  );
  assert(
    !approvalBlock.includes('await cdp.send("Page.bringToFront", {}, optsSession).catch('),
    "captureApprovalEvidence must not swallow Page.bringToFront errors with .catch()",
  );

  // Line 557: activateNtpSession pre-input focus
  const activateIdx = journeySource.indexOf("async function activateNtpSession(cdp, session) {");
  assert(activateIdx > 0, "activateNtpSession must be found in scripts/chrome-journeys.ts");
  const activateBlock = journeySource.slice(activateIdx, activateIdx + 400);
  assert(
    activateBlock.includes('await cdp.send("Page.bringToFront", {}, session);'),
    "activateNtpSession must await Page.bringToFront without .catch()",
  );
  assert(
    !activateBlock.includes('await cdp.send("Page.bringToFront", {}, session).catch('),
    "activateNtpSession must not swallow Page.bringToFront errors with .catch()",
  );

  // mu9oa / j9zyi: runScriptedToolProbe provider cleanup on rejection
  const probeIdx = journeySource.indexOf("async function runScriptedToolProbe(cdp, ntpSession, optsSession, steps, task, expectRequests, onPause = null) {");
  assert(probeIdx > 0, "runScriptedToolProbe must be found in scripts/chrome-journeys.ts");
  const probeBlock = journeySource.slice(probeIdx, probeIdx + 6000);
  assert(
    probeBlock.includes("await provider.close();"),
    "runScriptedToolProbe must await provider.close() on failure",
  );
  assert(
    probeBlock.includes('console.warn("[runScriptedToolProbe] scripted provider cleanup failed");'),
    "runScriptedToolProbe must emit fixed nonsecret diagnostic warning without interpolating error details",
  );
  assert(
    !probeBlock.includes("cleanupError"),
    "runScriptedToolProbe must not capture or interpolate cleanupError",
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

Deno.test("8u6x2 / 5ui2q: testActionLedgerJourney fails closed on Target.activateTarget rejection with wire-accurate Cdp.send mechanics, preventing clickSel and typeInto", async () => {
  // Extract the real Cdp class from scripts/chrome-journeys.ts
  const cdpStart = journeySource.indexOf("class Cdp {");
  const cdpEnd = journeySource.indexOf("\n/** Open a tab", cdpStart);
  assert(cdpStart >= 0 && cdpEnd > cdpStart, "the real Cdp class must be found in scripts/chrome-journeys.ts");
  const cdpSource = journeySource.slice(cdpStart, cdpEnd).replace("sessionId?", "sessionId");

  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const RealCdp = new Function("setTimeout", "clearTimeout", `${cdpSource}\nreturn Cdp;`)(
    (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    (id: number) => timers.delete(id),
  );

  // Extract testActionLedgerJourney activation and setup block from scripts/chrome-journeys.ts
  const start = journeySource.indexOf("const ledgerOptsPage = await openPage(port, `chrome-extension://${extId}/options/options.html`);");
  assert(start > 0, "testActionLedgerJourney start must be found");
  const end = journeySource.indexOf("const ledgerApprovalStart = Date.now();", start);
  assert(end > start, "testActionLedgerJourney end must be found");
  const blockBody = journeySource.slice(start, end).trim();

  // ── Scenario 1: Dead Transport (CLOSED socket + 15s timer rejection) ──
  {
    const frames: string[] = [];
    const ws: any = {
      readyState: 3, // CLOSED
      send: (frame: string) => frames.push(frame),
    };
    const cdp = new RealCdp(ws);
    // ws.onclose fires fatalEvents but does NOT settle pending
    ws.onclose();
    assertEquals(cdp.fatalEvents, ["websocket closed unexpectedly"]);

    let clickSelCount = 0;
    let typeIntoCount = 0;
    let listRunIdsCount = 0;
    let providerClosed = false;
    let providerRestored = false;

    const runner = new Function(
      "cdp",
      "openPage",
      "port",
      "extId",
      "attachRuntime",
      "sleep",
      "evalIn",
      "ledgerProvider",
      "SCRIPTED_DUMMY_KEY",
      "ntpPage",
      "ntpSession",
      "clickSel",
      "listRunIds",
      "composerInput",
      "typeInto",
      "composerSend",
      "onCleanup",
      `
      return (async () => {
        let ledgerOptsSession = null;
        try {
          ${blockBody}
        } finally {
          await ledgerProvider.close();
          onCleanup(Boolean(ledgerOptsSession));
        }
      })();
      `,
    );

    const runPromise = runner(
      cdp,
      async () => ({ id: "fake-opts-id" }),
      9222,
      "fake-ext-id",
      async () => "fake-opts-session",
      async () => {},
      async () => ({}),
      { close: async () => { providerClosed = true; } },
      "fake-key",
      { id: "fake-ntp-id" },
      "fake-ntp-session",
      async () => { clickSelCount++; return true; },
      async () => { listRunIdsCount++; return []; },
      () => "#composer [data-composer-input]",
      async () => { typeIntoCount++; return true; },
      () => "#composer [data-composer-send]",
      (restored: boolean) => { providerRestored = restored; },
    );

    let runErr: any = null;
    runPromise.catch((e: any) => { runErr = e; });

    // Yield to allow runner to reach await Target.activateTarget
    await new Promise((r) => setTimeout(r, 10));

    // Assert that while promise is pending in the timer, zero clicks/typing have occurred
    assertEquals(runErr, null, "Must remain pending while awaiting 15s timer");
    assertEquals(cdp.pending.size, 1, "Cdp.pending must hold Target.activateTarget request");
    assertEquals(timers.size, 1, "Timer must be active");
    const [timerId, timerEntry] = [...timers.entries()][0];
    assertEquals(timerEntry.delay, 15000, "Cdp.send timer must be 15000ms");
    assertEquals(clickSelCount, 0, "No clickSel while pending");
    assertEquals(typeIntoCount, 0, "No typeInto while pending");

    // Fire the 15s timer callback
    timers.delete(timerId);
    timerEntry.callback();

    // Now the run promise rejects
    await runPromise.catch(() => {});
    assert(runErr !== null, "Must reject after timer fires");
    assert(
      runErr.message.includes("cdp timeout: Target.activateTarget (requestId=1, targetId=unavailable, sessionId=unavailable)"),
      `Unexpected timeout error: ${runErr.message}`,
    );
    assertEquals(cdp.pending.size, 0, "Pending entry must be cleaned up on timeout");
    assertEquals(clickSelCount, 0, "clickSel must NOT be called on dead transport (0 clicks)");
    assertEquals(typeIntoCount, 0, "typeInto must NOT be called on dead transport (0 typing)");
    assertEquals(listRunIdsCount, 0, "listRunIds must NOT be called on dead transport");
    assertEquals(providerClosed, true, "ledgerProvider.close() must execute in finally");
    assertEquals(providerRestored, true, "provider restore must execute in finally");
  }

  // ── Scenario 2: Closed Target (-32602 Wire Protocol Error) ──
  {
    const frames: string[] = [];
    const ws: any = {
      readyState: 1, // OPEN
      send: (frame: string) => {
        frames.push(frame);
        const parsed = JSON.parse(frame);
        if (parsed.method === "Target.activateTarget") {
          // Send wire protocol error frame
          queueMicrotask(() => {
            ws.onmessage({
              data: JSON.stringify({
                id: parsed.id,
                error: { code: -32602, message: "No target with given id found" },
              }),
            });
          });
        }
      },
    };
    const cdp = new RealCdp(ws);

    let clickSelCount = 0;
    let typeIntoCount = 0;
    let listRunIdsCount = 0;
    let providerClosed = false;
    let providerRestored = false;

    const runner = new Function(
      "cdp",
      "openPage",
      "port",
      "extId",
      "attachRuntime",
      "sleep",
      "evalIn",
      "ledgerProvider",
      "SCRIPTED_DUMMY_KEY",
      "ntpPage",
      "ntpSession",
      "clickSel",
      "listRunIds",
      "composerInput",
      "typeInto",
      "composerSend",
      "onCleanup",
      `
      return (async () => {
        let ledgerOptsSession = null;
        try {
          ${blockBody}
        } finally {
          await ledgerProvider.close();
          onCleanup(Boolean(ledgerOptsSession));
        }
      })();
      `,
    );

    let runErr: any = null;
    try {
      await runner(
        cdp,
        async () => ({ id: "fake-opts-id" }),
        9222,
        "fake-ext-id",
        async () => "fake-opts-session",
        async () => {},
        async () => ({}),
        { close: async () => { providerClosed = true; } },
        "fake-key",
        { id: "fake-ntp-id" },
        "fake-ntp-session",
        async () => { clickSelCount++; return true; },
        async () => { listRunIdsCount++; return []; },
        () => "#composer [data-composer-input]",
        async () => { typeIntoCount++; return true; },
        () => "#composer [data-composer-send]",
        (restored: boolean) => { providerRestored = restored; },
      );
    } catch (e: any) {
      runErr = e;
    }

    assert(runErr !== null, "Must reject on closed target protocol error");
    assert(
      runErr.message.includes("cdp error 1 (-32602): No target with given id found"),
      `Unexpected protocol error: ${runErr.message}`,
    );
    assertEquals(cdp.pending.size, 0, "Pending entry must be cleaned up on reply");
    assertEquals(clickSelCount, 0, "clickSel must NOT be called on closed target (0 clicks)");
    assertEquals(typeIntoCount, 0, "typeInto must NOT be called on closed target (0 typing)");
    assertEquals(listRunIdsCount, 0, "listRunIds must NOT be called on closed target");
    assertEquals(providerClosed, true, "ledgerProvider.close() must execute in finally");
    assertEquals(providerRestored, true, "provider restore must execute in finally");
  }

  // Mutant check: restoring .catch(() => {}) swallows Target.activateTarget rejection
  const mutantBlockBody = blockBody.replace(
    'await cdp.send("Target.activateTarget", { targetId: ntpPage.id });',
    'await cdp.send("Target.activateTarget", { targetId: ntpPage.id }).catch(() => {});',
  );
  assert(mutantBlockBody.includes(".catch("), "mutant must contain catch()");

  const mutantRunner = new Function(
    "cdp",
    "openPage",
    "port",
    "extId",
    "attachRuntime",
    "sleep",
    "evalIn",
    "ledgerProvider",
    "SCRIPTED_DUMMY_KEY",
    "ntpPage",
    "ntpSession",
    "clickSel",
    "listRunIds",
    "composerInput",
    "typeInto",
    "composerSend",
    `
    return (async () => {
      let ledgerOptsSession = null;
      try {
        ${mutantBlockBody}
      } finally {
        await ledgerProvider.close();
      }
    })();
    `,
  );

  let mutantClickCount = 0;
  let mutantTypeCount = 0;

  await mutantRunner(
    {
      pageSessions: new Set(),
      send: async (method: string) => {
        if (method === "Target.activateTarget") {
          throw new Error("cdp error 2 (-32602): No target with given id found");
        }
        return {};
      },
    },
    async () => ({ id: "fake-opts-id" }),
    9222,
    "fake-ext-id",
    async () => "fake-opts-session",
    async () => {},
    async () => ({}),
    { close: async () => {} },
    "fake-key",
    { id: "fake-ntp-id" },
    "fake-ntp-session",
    async () => { mutantClickCount++; return true; },
    async () => [],
    () => "#composer [data-composer-input]",
    async () => { mutantTypeCount++; return true; },
    () => "#composer [data-composer-send]",
  );

  // The mutant survived by swallowing rejection and called clickSel twice (#home and composerSend) and typeInto!
  assertEquals(mutantClickCount, 2, "mutant with .catch() swallows error and calls clickSel twice (#home and composerSend)");
  assertEquals(mutantTypeCount, 1, "mutant with .catch() swallows error and calls typeInto");
});

Deno.test("hpm8f: captureApprovalEvidence fails closed on Page.bringToFront rejection, preventing captureShot retry loop", async () => {
  // Extract captureApprovalEvidence helper definition from scripts/chrome-journeys.ts
  const start = journeySource.indexOf("const captureApprovalEvidence = async (name) => {");
  assert(start > 0, "captureApprovalEvidence start must be found");
  const end = journeySource.indexOf("await captureApprovalEvidence(\"approval-deny-pending.png\");", start);
  assert(end > start, "captureApprovalEvidence end must be found");
  const fnBody = journeySource.slice(start, end).trim();

  // Extract the real Cdp class from scripts/chrome-journeys.ts
  const cdpStart = journeySource.indexOf("class Cdp {");
  const cdpEnd = journeySource.indexOf("\n/** Open a tab", cdpStart);
  assert(cdpStart >= 0 && cdpEnd > cdpStart, "the real Cdp class must be found in scripts/chrome-journeys.ts");
  const cdpSource = journeySource.slice(cdpStart, cdpEnd).replace("sessionId?", "sessionId");

  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const RealCdp = new Function("setTimeout", "clearTimeout", `${cdpSource}\nreturn Cdp;`)(
    (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    (id: number) => timers.delete(id),
  );

  // ── Scenario 1: Closed Session Wire Error (-32001) ──
  {
    const frames: string[] = [];
    const ws: any = {
      readyState: 1, // OPEN
      send: (frame: string) => {
        frames.push(frame);
        const parsed = JSON.parse(frame);
        if (parsed.method === "Page.bringToFront") {
          queueMicrotask(() => {
            ws.onmessage({
              data: JSON.stringify({
                id: parsed.id,
                error: { code: -32001, message: "Session with given id not found." },
              }),
            });
          });
        }
      },
    };
    const cdp = new RealCdp(ws);

    let captureShotCalls = 0;
    let sleepCalls = 0;
    let writeEvidenceCalls = 0;

    const runner = new Function(
      "cdp",
      "optsSession",
      "captureShot",
      "sleep",
      "writeEvidence",
      `
      return (async () => {
        ${fnBody}
        return await captureApprovalEvidence("test.png");
      })();
      `,
    );

    let thrownError: any = null;
    try {
      await runner(
        cdp,
        "fake-opts-session",
        async () => { captureShotCalls++; return new Uint8Array([1, 2, 3]); },
        async (ms: number) => { sleepCalls++; },
        async (name: string, shot: any) => { writeEvidenceCalls++; },
      );
    } catch (err: any) {
      thrownError = err;
    }

    assert(thrownError !== null, "captureApprovalEvidence must throw on closed session");
    assert(
      thrownError.message.includes("cdp error 1 (-32001): Session with given id not found."),
      `Must preserve exact CDP protocol error: ${thrownError.message}`,
    );
    assertEquals(captureShotCalls, 0, "Zero captureShot calls must be made on closed session error");
    assertEquals(sleepCalls, 0, "Zero sleep calls must be made on closed session error");
    assertEquals(writeEvidenceCalls, 0, "Zero writeEvidence calls must be made on closed session error");
  }

  // ── Scenario 2: Dead Transport (CLOSED socket + 15s timer rejection) ──
  {
    const frames: string[] = [];
    const ws: any = {
      readyState: 3, // CLOSED
      send: (frame: string) => frames.push(frame),
    };
    const cdp = new RealCdp(ws);
    ws.onclose();
    assertEquals(cdp.fatalEvents, ["websocket closed unexpectedly"]);

    let captureShotCalls = 0;
    let sleepCalls = 0;
    let writeEvidenceCalls = 0;

    const runner = new Function(
      "cdp",
      "optsSession",
      "captureShot",
      "sleep",
      "writeEvidence",
      `
      return (async () => {
        ${fnBody}
        return await captureApprovalEvidence("test.png");
      })();
      `,
    );

    const runPromise = runner(
      cdp,
      "fake-opts-session",
      async () => { captureShotCalls++; return new Uint8Array([1, 2, 3]); },
      async () => { sleepCalls++; },
      async () => { writeEvidenceCalls++; },
    );

    let runErr: any = null;
    runPromise.catch((e: any) => { runErr = e; });

    // Yield macro-task turns to allow runner to reach await Page.bringToFront
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(runErr, null, "Must remain pending while awaiting 15s timer");
    assertEquals(cdp.pending.size, 1, "Cdp.pending must hold Page.bringToFront request");
    assertEquals(timers.size, 1, "Timer must be active");
    const [timerId, timerEntry] = [...timers.entries()][0];
    assertEquals(timerEntry.delay, 15000, "Cdp.send timer must be 15000ms");
    assertEquals(captureShotCalls, 0, "Zero captureShot calls while pending");

    // Fire the 15s timer callback
    timers.delete(timerId);
    timerEntry.callback();

    await runPromise.catch(() => {});
    assert(runErr !== null, "Must reject after timer fires");
    assert(
      runErr.message.includes("cdp timeout: Page.bringToFront"),
      `Unexpected timeout error: ${runErr.message}`,
    );
    assertEquals(captureShotCalls, 0, "Zero captureShot calls on dead transport");
    assertEquals(sleepCalls, 0, "Zero sleep calls on dead transport");
    assertEquals(writeEvidenceCalls, 0, "Zero writeEvidence calls on dead transport");
  }

  // ── Mutant check: restoring .catch(() => {}) swallows rejection and calls captureShot 3 times ──
  const mutantFnBody = fnBody.replace(
    'await cdp.send("Page.bringToFront", {}, optsSession);',
    'await cdp.send("Page.bringToFront", {}, optsSession).catch(() => {});',
  );
  assert(mutantFnBody.includes(".catch("), "mutant must contain catch()");

  const mutantRunner = new Function(
    "cdp",
    "optsSession",
    "captureShot",
    "sleep",
    "writeEvidence",
    `
    return (async () => {
      ${mutantFnBody}
      return await captureApprovalEvidence("test.png");
    })();
    `,
  );

  let mutantCaptureCalls = 0;
  let mutantSleepCalls = 0;

  let mutantErr: any = null;
  try {
    await mutantRunner(
      {
        pageSessions: new Set(),
        send: async () => {
          throw new Error("cdp error 1 (-32001): Session with given id not found.");
        },
      },
      "fake-opts-session",
      async () => {
        mutantCaptureCalls++;
        return null; // fails so loop retries
      },
      async () => { mutantSleepCalls++; },
      async () => {},
    );
  } catch (err: any) {
    mutantErr = err;
  }

  // With .catch(() => {}), the rejection is swallowed and captureShot is called 3 times!
  assertEquals(mutantCaptureCalls, 3, "mutant with .catch() swallows error and calls captureShot 3 times");
  assertEquals(mutantSleepCalls, 3, "mutant with .catch() sleeps 3 times");
  assert(mutantErr?.message.includes("approval evidence capture failed"), "mutant throws evidence capture failed instead of CDP root cause");
});

Deno.test("fk9pq / mu9oa: activateNtpSession fails closed on Page.bringToFront rejection, cleans up provider exactly once, and prevents input", async () => {
  // Extract activateNtpSession and runScriptedToolProbe from scripts/chrome-journeys.ts
  const helperStart = journeySource.indexOf("async function activateNtpSession(cdp, session) {");
  assert(helperStart > 0, "activateNtpSession start must be found");
  const helperEnd = journeySource.indexOf("\nasync function runScriptedToolProbe", helperStart);
  assert(helperEnd > helperStart, "activateNtpSession end must be found");
  const helperBody = journeySource.slice(helperStart, helperEnd).trim();

  const probeStart = journeySource.indexOf("async function runScriptedToolProbe(cdp, ntpSession, optsSession, steps, task, expectRequests, onPause = null) {");
  assert(probeStart > 0, "runScriptedToolProbe start must be found");
  const probeEnd = journeySource.indexOf("\n/** Capture a PNG screenshot", probeStart);
  assert(probeEnd > probeStart, "runScriptedToolProbe end must be found");
  const probeFnSource = journeySource.slice(probeStart, probeEnd).trim();

  // Extract the real Cdp class from scripts/chrome-journeys.ts
  const cdpStart = journeySource.indexOf("class Cdp {");
  const cdpEnd = journeySource.indexOf("\n/** Open a tab", cdpStart);
  assert(cdpStart >= 0 && cdpEnd > cdpStart, "the real Cdp class must be found in scripts/chrome-journeys.ts");
  const cdpSource = journeySource.slice(cdpStart, cdpEnd).replace("sessionId?", "sessionId");

  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const RealCdp = new Function("setTimeout", "clearTimeout", `${cdpSource}\nreturn Cdp;`)(
    (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    (id: number) => timers.delete(id),
  );

  const createTestProvider = () => {
    const ac = new AbortController();
    let isListening = true;
    let closeCallCount = 0;
    const server = Deno.serve({
      port: 0,
      hostname: "127.0.0.1",
      signal: ac.signal,
      onListen: () => {},
    }, () => new Response(JSON.stringify({ ok: true })));
    const port = (server.addr as Deno.NetAddr).port;
    const provider = {
      baseURL: `http://127.0.0.1:${port}/v1`,
      port,
      requests: [] as any[],
      closeCallCount: () => closeCallCount,
      isListening: () => isListening,
      close: async () => {
        closeCallCount++;
        ac.abort();
        try { await server.shutdown(); } catch {}
        isListening = false;
      },
    };
    return {
      provider,
      cleanup: async () => {
        ac.abort();
        try { await server.shutdown(); } catch {}
        isListening = false;
      },
    };
  };

  const compileRunner = (probeSource: string) => {
    return new Function(
      "startScriptedProvider",
      "evalIn",
      "listRunIds",
      "sleep",
      "clickSel",
      "typeInto",
      "composerInput",
      "composerSend",
      "awaitNewRunTerminal",
      "isCdpEvaluateTimeout",
      "SCRIPTED_DUMMY_KEY",
      `
      ${helperBody}
      ${probeSource}
      return runScriptedToolProbe;
      `,
    );
  };

  // ── Scenario 1: Closed Session Wire Error (-32001) ──
  {
    const ws: any = {
      readyState: 1, // OPEN
      send: (frame: string) => {
        const parsed = JSON.parse(frame);
        if (parsed.method === "Target.getTargetInfo") {
          queueMicrotask(() => {
            ws.onmessage({
              data: JSON.stringify({
                id: parsed.id,
                result: { targetInfo: { targetId: "fake-ntp-target-id" } },
              }),
            });
          });
        } else if (parsed.method === "Target.activateTarget") {
          queueMicrotask(() => {
            ws.onmessage({ data: JSON.stringify({ id: parsed.id, result: {} }) });
          });
        } else if (parsed.method === "Page.bringToFront") {
          queueMicrotask(() => {
            ws.onmessage({
              data: JSON.stringify({
                id: parsed.id,
                error: { code: -32001, message: "Session with given id not found." },
              }),
            });
          });
        }
      },
    };
    const cdp = new RealCdp(ws);

    let clickSelCount = 0;
    let typeIntoCount = 0;
    const testProv = createTestProvider();

    try {
      const runnerFactory = compileRunner(probeFnSource);
      const runner = runnerFactory(
        async () => testProv.provider,
        async () => {},
        async () => new Set(),
        async () => {},
        async () => { clickSelCount++; return true; },
        async () => { typeIntoCount++; return true; },
        () => "#composer [data-composer-input]",
        () => "#composer [data-composer-send]",
        async () => ({ phase: "done" }),
        () => false,
        "test-dummy-key",
      );

      let thrownError: any = null;
      try {
        await runner(
          cdp,
          "fake-ntp-session",
          "fake-opts-session",
          [],
          "test task",
          1,
        );
      } catch (err: any) {
        thrownError = err;
      }

      assert(thrownError !== null, "activateNtpSession must throw on closed session");
      assert(
        thrownError.message.includes("(-32001): Session with given id not found."),
        `Must preserve exact CDP protocol error: ${thrownError.message}`,
      );
      assertEquals(testProv.provider.closeCallCount(), 1, "provider.close() must be called exactly once on focus rejection");
      assertEquals(testProv.provider.isListening(), false, "listener must be stopped on focus rejection");
      assertEquals(clickSelCount, 0, "clickSel must NOT be called on closed session (0 clicks)");
      assertEquals(typeIntoCount, 0, "typeInto must NOT be called on closed session (0 typing)");

      // Assert server is down and does not respond
      const serverDown = await fetch(testProv.provider.baseURL).then(() => false, () => true);
      assert(serverDown, "server must not accept requests after cleanup");
    } finally {
      await testProv.cleanup();
    }
  }

  // ── Scenario 2: Synchronous throw and rejection in provider.close() preserve primary CDP error and avoid leaking error payloads ──
  {
    const ws: any = {
      readyState: 1, // OPEN
      send: (frame: string) => {
        const parsed = JSON.parse(frame);
        if (parsed.method === "Target.getTargetInfo") {
          queueMicrotask(() => {
            ws.onmessage({
              data: JSON.stringify({
                id: parsed.id,
                result: { targetInfo: { targetId: "fake-ntp-target-id" } },
              }),
            });
          });
        } else if (parsed.method === "Target.activateTarget") {
          queueMicrotask(() => {
            ws.onmessage({ data: JSON.stringify({ id: parsed.id, result: {} }) });
          });
        } else if (parsed.method === "Page.bringToFront") {
          queueMicrotask(() => {
            ws.onmessage({
              data: JSON.stringify({
                id: parsed.id,
                error: { code: -32001, message: "Session with given id not found." },
              }),
            });
          });
        }
      },
    };
    const cdp = new RealCdp(ws);

    const INERT_SENTINEL = "INERT_SENTINEL_BEARER_NOT_A_REAL_KEY_12345";
    const warnLogs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnLogs.push(args.map(String).join(" "));
    };

    try {
      // 2a. Sync throw in close() with sensitive-looking error payload
      const syncThrowProvider = {
        baseURL: "http://127.0.0.1:0/v1",
        requests: [] as any[],
        close: () => {
          throw new Error(`provider close failure: Authorization: Bearer ${INERT_SENTINEL}`);
        },
      };

      const runnerFactory = compileRunner(probeFnSource);
      const runnerSync = runnerFactory(
        async () => syncThrowProvider,
        async () => {},
        async () => new Set(),
        async () => {},
        async () => true,
        async () => true,
        () => "#composer [data-composer-input]",
        () => "#composer [data-composer-send]",
        async () => ({ phase: "done" }),
        () => false,
        "test-dummy-key",
      );

      let syncErr: any = null;
      try {
        await runnerSync(cdp, "fake-ntp-session", "fake-opts-session", [], "test task", 1);
      } catch (e: any) {
        syncErr = e;
      }
      assert(syncErr !== null, "must throw primary error");
      assert(
        syncErr.message.includes("(-32001): Session with given id not found."),
        `Must preserve primary CDP error when provider.close throws synchronously: ${syncErr.message}`,
      );
      assert(!syncErr.message.includes(INERT_SENTINEL), "Primary error must not contain cleanup sentinel");
      assertEquals(
        warnLogs.includes("[runScriptedToolProbe] scripted provider cleanup failed"),
        true,
        "Must emit constant nonsecret cleanup warning",
      );
      assert(
        !warnLogs.some((l) => l.includes(INERT_SENTINEL)),
        "Warning logs must NOT leak arbitrary error payload or sentinel",
      );

      // 2b. Async rejection in close() with sensitive-looking error payload
      const asyncRejectProvider = {
        baseURL: "http://127.0.0.1:0/v1",
        requests: [] as any[],
        close: async () => {
          throw new Error(`async close rejection: token=${INERT_SENTINEL}`);
        },
      };

      const runnerAsync = runnerFactory(
        async () => asyncRejectProvider,
        async () => {},
        async () => new Set(),
        async () => {},
        async () => true,
        async () => true,
        () => "#composer [data-composer-input]",
        () => "#composer [data-composer-send]",
        async () => ({ phase: "done" }),
        () => false,
        "test-dummy-key",
      );

      let asyncErr: any = null;
      try {
        await runnerAsync(cdp, "fake-ntp-session", "fake-opts-session", [], "test task", 1);
      } catch (e: any) {
        asyncErr = e;
      }
      assert(asyncErr !== null, "must throw primary error");
      assert(
        asyncErr.message.includes("(-32001): Session with given id not found."),
        `Must preserve primary CDP error when provider.close rejects: ${asyncErr.message}`,
      );
      assert(!asyncErr.message.includes(INERT_SENTINEL), "Primary error must not contain cleanup sentinel");
      assert(
        !warnLogs.some((l) => l.includes(INERT_SENTINEL)),
        "Warning logs must NOT leak arbitrary error payload or sentinel",
      );
    } finally {
      console.warn = origWarn;
    }
  }

  // ── Scenario 3: Dead Transport (CLOSED socket + 15s timer rejection) ──
  {
    const ws: any = {
      readyState: 3, // CLOSED
      send: (frame: string) => {
        const parsed = JSON.parse(frame);
        if (parsed.method === "Target.getTargetInfo") {
          queueMicrotask(() => {
            ws.onmessage({
              data: JSON.stringify({
                id: parsed.id,
                result: { targetInfo: { targetId: "fake-ntp-target-id" } },
              }),
            });
          });
        } else if (parsed.method === "Target.activateTarget") {
          queueMicrotask(() => {
            ws.onmessage({ data: JSON.stringify({ id: parsed.id, result: {} }) });
          });
        }
        // Page.bringToFront on dead socket: ws.send returns normally, no reply frame, pending timer
      },
    };
    const cdp = new RealCdp(ws);
    ws.onclose();
    assertEquals(cdp.fatalEvents, ["websocket closed unexpectedly"]);

    let clickSelCount = 0;
    let typeIntoCount = 0;
    const testProv = createTestProvider();

    try {
      const runnerFactory = compileRunner(probeFnSource);
      const runner = runnerFactory(
        async () => testProv.provider,
        async () => {},
        async () => new Set(),
        async () => {},
        async () => { clickSelCount++; return true; },
        async () => { typeIntoCount++; return true; },
        () => "#composer [data-composer-input]",
        () => "#composer [data-composer-send]",
        async () => ({ phase: "done" }),
        () => false,
        "test-dummy-key",
      );

      const runPromise = runner(
        cdp,
        "fake-ntp-session",
        "fake-opts-session",
        [],
        "test task",
        1,
      );

      let runErr: any = null;
      runPromise.catch((e: any) => { runErr = e; });

      // Yield macro-task turns to allow runner to reach await Page.bringToFront
      await new Promise((r) => setTimeout(r, 10));

      assertEquals(runErr, null, "Must remain pending while awaiting 15s timer");
      assertEquals(cdp.pending.size, 1, "Cdp.pending must hold Page.bringToFront request");
      assertEquals(timers.size, 1, "Timer must be active");
      const [timerId, timerEntry] = [...timers.entries()][0];
      assertEquals(timerEntry.delay, 15000, "Cdp.send timer must be 15000ms");
      assertEquals(testProv.provider.closeCallCount(), 0, "provider must not be closed while pending");
      assertEquals(clickSelCount, 0, "Zero clickSel while pending");
      assertEquals(typeIntoCount, 0, "Zero typeInto while pending");

      // Fire the 15s timer callback
      timers.delete(timerId);
      timerEntry.callback();

      await runPromise.catch(() => {});
      assert(runErr !== null, "Must reject after timer fires");
      assert(
        runErr.message.includes("cdp timeout: Page.bringToFront"),
        `Unexpected timeout error: ${runErr.message}`,
      );
      assertEquals(testProv.provider.closeCallCount(), 1, "provider.close() must be called after timeout rejection");
      assertEquals(testProv.provider.isListening(), false, "listener must be stopped after timeout rejection");
      assertEquals(clickSelCount, 0, "Zero clickSel on dead transport");
      assertEquals(typeIntoCount, 0, "Zero typeInto on dead transport");
    } finally {
      await testProv.cleanup();
    }
  }

  // ── Scenario 4: Successful execution transfers ownership, no helper close ──
  {
    const testProv = createTestProvider();
    try {
      const mockSuccessCdp: any = {
        send: async () => ({ result: {} }),
      };
      const runnerFactory = compileRunner(probeFnSource);
      const runner = runnerFactory(
        async () => testProv.provider,
        async () => {},
        async () => new Set(),
        async () => {},
        async () => true,
        async () => true,
        () => "#composer [data-composer-input]",
        () => "#composer [data-composer-send]",
        async () => ({ id: "run-1", phase: "done" }),
        () => false,
        "test-dummy-key",
      );

      const res: any = await runner(
        mockSuccessCdp,
        "fake-ntp-session",
        "fake-opts-session",
        [],
        "test task",
        0, // expectRequests 0 -> while loop immediately finishes
      );

      assertEquals(res.provider, testProv.provider, "transfers ownership of provider to caller");
      assertEquals(testProv.provider.closeCallCount(), 0, "helper must NOT close provider on successful return");

      // Caller closes provider
      await res.provider.close();
      assertEquals(testProv.provider.closeCallCount(), 1, "caller closes provider");
    } finally {
      await testProv.cleanup();
    }
  }

  // ── Scenario 5: Missing cleanup mutant check (missing provider.close() on failure leaves server listening) ──
  {
    const cleanupBlock = `    try {
      await provider.close();
    } catch {
      console.warn("[runScriptedToolProbe] scripted provider cleanup failed");
    }`;
    const mutantSource = probeFnSource.replace(cleanupBlock, "");
    assert(mutantSource !== probeFnSource, "mutant must remove provider cleanup");

    const testProv = createTestProvider();
    try {
      const ws: any = {
        readyState: 1,
        send: (frame: string) => {
          const parsed = JSON.parse(frame);
          if (parsed.method === "Target.getTargetInfo") {
            queueMicrotask(() => {
              ws.onmessage({
                data: JSON.stringify({
                  id: parsed.id,
                  result: { targetInfo: { targetId: "fake-ntp-target-id" } },
                }),
              });
            });
          } else if (parsed.method === "Target.activateTarget") {
            queueMicrotask(() => {
              ws.onmessage({ data: JSON.stringify({ id: parsed.id, result: {} }) });
            });
          } else if (parsed.method === "Page.bringToFront") {
            queueMicrotask(() => {
              ws.onmessage({
                data: JSON.stringify({
                  id: parsed.id,
                  error: { code: -32001, message: "Session with given id not found." },
                }),
              });
            });
          }
        },
      };
      const cdp = new RealCdp(ws);

      const mutantRunnerFactory = compileRunner(mutantSource);
      const mutantRunner = mutantRunnerFactory(
        async () => testProv.provider,
        async () => {},
        async () => new Set(),
        async () => {},
        async () => true,
        async () => true,
        () => "#composer [data-composer-input]",
        () => "#composer [data-composer-send]",
        async () => ({ phase: "done" }),
        () => false,
        "test-dummy-key",
      );

      let mutantErr: any = null;
      try {
        await mutantRunner(cdp, "fake-ntp-session", "fake-opts-session", [], "test task", 1);
      } catch (e: any) {
        mutantErr = e;
      }
      assert(mutantErr !== null, "mutant must throw error");
      // The mutant failed to clean up the provider:
      assertEquals(testProv.provider.closeCallCount(), 0, "mutant fails to close provider on error (RED)");
      assertEquals(testProv.provider.isListening(), true, "mutant leaves server listening (RED)");
    } finally {
      await testProv.cleanup();
    }
  }
});
