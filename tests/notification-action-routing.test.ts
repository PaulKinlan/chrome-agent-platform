// tests/notification-action-routing.test.ts — Unit and contract tests for
// notification click routing and bounded action contracts (CAP-FB-20260823-NOTIFICATION-CLICK-ACTION-01).
// @ts-nocheck

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  NotificationRegistry,
  NOTIFICATION_STATES,
  NOTIFICATION_ACTION_TYPES,
  ALLOWED_NAVIGATE_PREFIXES,
  isAllowedNavigatePath,
  validateNotificationAction,
  buildNotificationTargetUrl,
  openOrFocusExtensionUrl,
  handleNotificationClick,
  handleNotificationClosed,
} from "../extension/lib/notification-action-routing.js";

Deno.test("validateNotificationAction: defaults to default action on missing/empty input", () => {
  assertEquals(validateNotificationAction(null), { type: "default" });
  assertEquals(validateNotificationAction(undefined), { type: "default" });
  assertEquals(validateNotificationAction({}), { type: "default" });
  assertEquals(validateNotificationAction("not-an-object"), { type: "default" });
});

Deno.test("validateNotificationAction: allows valid open-thread action", () => {
  const action = validateNotificationAction({
    type: "open-thread",
    threadId: "thread_123.abc-456",
  });
  assertEquals(action, {
    type: "open-thread",
    threadId: "thread_123.abc-456",
  });
});

Deno.test("validateNotificationAction: rejects open-thread with invalid/missing threadId", () => {
  const action = validateNotificationAction({
    type: "open-thread",
    threadId: "../escape/thread",
  });
  assertEquals(action, { type: "default" });
});

Deno.test("isAllowedNavigatePath: positive allowlist permits valid extension pages and hash queries", () => {
  assert(isAllowedNavigatePath("ntp/ntp.html"));
  assert(isAllowedNavigatePath("ntp/ntp.html#omnibox=thread:123"));
  assert(isAllowedNavigatePath("options/options.html#tasks"));
  assert(isAllowedNavigatePath("sidepanel/sidepanel.html?scope=agent"));
  assert(!isAllowedNavigatePath("evil.html"));
  assert(!isAllowedNavigatePath("https://evil.com"));
  assert(!isAllowedNavigatePath("../escape.html"));
  assert(!isAllowedNavigatePath("/ntp/ntp.html"));
});

Deno.test("validateNotificationAction: allows valid internal relative navigate path", () => {
  const action = validateNotificationAction({
    type: "navigate",
    path: "options/options.html#tasks",
  });
  assertEquals(action, {
    type: "navigate",
    path: "options/options.html#tasks",
  });
});

Deno.test("validateNotificationAction: rejects external protocols and directory traversals", () => {
  const hostile = [
    "https://evil.com",
    "http://insecure.com",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "file:///etc/passwd",
    "//evil.com/path",
    "\\evil.com\\path",
    "../options/options.html",
    "ntp/../../secret",
  ];
  for (const h of hostile) {
    const action = validateNotificationAction({ type: "navigate", path: h });
    assertEquals(action, { type: "default" }, `Hostile path ${h} must fail closed to default`);
  }
});

Deno.test("validateNotificationAction: bounds resume prompt length and validates executionId", () => {
  const action = validateNotificationAction({
    type: "resume",
    executionId: "exec_123",
    prompt: "Continue".repeat(500),
  });
  assertEquals(action.type, "resume");
  assertEquals(action.executionId, "exec_123");
  assert(action.prompt.length <= 2048);
});

Deno.test("buildNotificationTargetUrl: builds exact canonical URLs for threads and tasks", () => {
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test-id/${p}`,
    },
  };

  const u1 = buildNotificationTargetUrl({ threadId: "thread-abc" });
  assertEquals(u1, "chrome-extension://test-id/ntp/ntp.html#omnibox=thread:thread-abc");

  const u2 = buildNotificationTargetUrl({ taskId: "task-123" });
  assertEquals(u2, "chrome-extension://test-id/ntp/ntp.html#omnibox=thread:task-123");

  const u3 = buildNotificationTargetUrl({ path: "options/options.html#tool-library" });
  assertEquals(u3, "chrome-extension://test-id/options/options.html#tool-library");
});

Deno.test("NotificationRegistry: registers, retrieves, and updates state", async () => {
  const mockStorage = new Map();
  const storage = {
    local: {
      get: async (k) => {
        const out = {};
        const keys = Array.isArray(k) ? k : [k];
        for (const key of keys) {
          if (mockStorage.has(key)) out[key] = mockStorage.get(key);
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) mockStorage.set(k, v);
      },
    },
  };

  const registry = new NotificationRegistry({ storage });

  const record = await registry.registerNotification({
    notificationId: "cap:task:123",
    taskId: "task-123",
    executionId: "exec-456",
    agentId: "agent-789",
    threadId: "thread-123",
    title: "Task Done",
    message: "Finished calculation.",
  });

  assertEquals(record.notificationId, "cap:task:123");
  assertEquals(record.state, NOTIFICATION_STATES.CREATED);
  assertEquals(record.taskId, "task-123");

  const fetched = await registry.getNotification("cap:task:123");
  assertEquals(fetched.title, "Task Done");

  const updated = await registry.updateState("cap:task:123", NOTIFICATION_STATES.CLICKED);
  assertEquals(updated.state, NOTIFICATION_STATES.CLICKED);

  const list = await registry.listNotifications({ state: NOTIFICATION_STATES.CLICKED });
  assertEquals(list.length, 1);
  assertEquals(list[0].notificationId, "cap:task:123");
});

Deno.test("NotificationRegistry: dismissed notifications remain discoverable", async () => {
  const registry = new NotificationRegistry();
  await registry.registerNotification({
    notificationId: "cap:notif:1",
    taskId: "t1",
    title: "N1",
  });
  await registry.registerNotification({
    notificationId: "cap:notif:2",
    taskId: "t2",
    title: "N2",
  });

  await handleNotificationClosed("cap:notif:1", true, { registry });

  const active = await registry.listNotifications({ state: NOTIFICATION_STATES.CREATED });
  assertEquals(active.length, 1);
  assertEquals(active[0].notificationId, "cap:notif:2");

  const dismissed = await registry.listNotifications({ state: NOTIFICATION_STATES.DISMISSED });
  assertEquals(dismissed.length, 1);
  assertEquals(dismissed[0].notificationId, "cap:notif:1");
  assertEquals(dismissed[0].dismissedByUser, true);
});

Deno.test("handleNotificationClick: routes to default task thread and focuses/creates tab", async () => {
  const registry = new NotificationRegistry();
  await registry.registerNotification({
    notificationId: "cap:task:t99",
    taskId: "t99",
    executionId: "exec-99",
    title: "Task T99",
  });

  let clearedNotificationId = null;
  const notificationsApi = {
    clear: async (id) => { clearedNotificationId = id; return true; },
  };

  let createdUrl = null;
  const tabsApi = {
    query: async () => [],
    create: async ({ url }) => { createdUrl = url; return { id: 101, url }; },
  };

  const res = await handleNotificationClick("cap:task:t99", {
    registry,
    notificationsApi,
    tabsApi,
  });

  assert(res.ok);
  assertEquals(clearedNotificationId, "cap:task:t99");
  assertEquals(res.state, NOTIFICATION_STATES.CLICKED);
  assertStringIncludes(res.targetUrl, "thread:t99");
  assertEquals(res.navigation.action, "created");
  assertEquals(res.navigation.tabId, 101);
});

Deno.test("handleNotificationClick: focuses existing extension tab when available", async () => {
  const registry = new NotificationRegistry();
  await registry.registerNotification({
    notificationId: "cap:task:t100",
    taskId: "t100",
  });

  let updatedTab = null;
  let focusedWindow = null;

  globalThis.chrome = {
    runtime: {
      getURL: (p = "") => `chrome-extension://test-ext/${p}`,
    },
  };

  const tabsApi = {
    query: async () => [
      { id: 42, windowId: 7, url: "chrome-extension://test-ext/ntp/ntp.html" },
      { id: 43, windowId: 7, url: "https://google.com" },
    ],
    update: async (id, opts) => { updatedTab = { id, ...opts }; return updatedTab; },
  };
  const windowsApi = {
    update: async (windowId, opts) => { focusedWindow = { windowId, ...opts }; return focusedWindow; },
  };
  const notificationsApi = {
    clear: async () => true,
  };

  const res = await handleNotificationClick("cap:task:t100", {
    registry,
    tabsApi,
    windowsApi,
    notificationsApi,
  });

  assert(res.ok);
  assertEquals(res.navigation.action, "focused");
  assertEquals(updatedTab.id, 42);
  assertEquals(focusedWindow.windowId, 7);
  assertEquals(focusedWindow.focused, true);
});

Deno.test("handleNotificationClick: resumes agent loop when action is resume", async () => {
  const registry = new NotificationRegistry();
  await registry.registerNotification({
    notificationId: "cap:exec:e1",
    executionId: "e1",
    agentId: "agent-helper",
    action: {
      type: "resume",
      executionId: "e1",
      prompt: "Continue step 2",
    },
  });

  let resumedArgs = null;
  const resumeAgentExecution = async (args) => {
    resumedArgs = args;
    return { ok: true, resumed: true };
  };

  const tabsApi = {
    query: async () => [],
    create: async () => ({ id: 1 }),
  };
  const notificationsApi = { clear: async () => true };

  const res = await handleNotificationClick("cap:exec:e1", {
    registry,
    resumeAgentExecution,
    tabsApi,
    notificationsApi,
  });

  assert(res.ok);
  assertEquals(res.action, "resume");
  assert(res.resume.ok);
  assertEquals(resumedArgs.executionId, "e1");
  assertEquals(resumedArgs.agentId, "agent-helper");
  assertEquals(resumedArgs.prompt, "Continue step 2");
});

Deno.test("handleNotificationClick: un-registered / synthetic notification ID fails closed to safe fallback", async () => {
  const tabsApi = {
    query: async () => [],
    create: async ({ url }) => ({ id: 99, url }),
  };
  const notificationsApi = { clear: async () => true };

  const res = await handleNotificationClick("cap:task:synthetic-task", {
    tabsApi,
    notificationsApi,
  });

  assert(res.ok);
  assertEquals(res.state, "clicked");
  assertStringIncludes(res.targetUrl, "thread:synthetic-task");
});

// ── N-2 integrator hardening (k3, landing 0.2.187): the reviewed candidate
// PASSED expectedAgentId into run.resume but nothing consumed it — an inert
// hardening claim. The guard now lives in the run.resume handler. SW handlers
// are covered source-level throughout this suite (no executable SW dispatch
// harness exists for run.resume); this pin asserts exact placement semantics:
// after the run lookup, BEFORE any phase/resume mutation, null-skip for
// callers that carry no expectation, exact fail-closed error code.
Deno.test("N-2 enforcement: run.resume consumes expectedAgentId (agent_mismatch fails closed, in the right position)", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url).pathname);
  const guard = 'if (m?.expectedAgentId != null && run.agentId !== m.expectedAgentId) {\n      return { ok: false, error: "agent_mismatch", executionId };\n    }';
  assert(sw.includes(guard), "run.resume contains the exact expectedAgentId guard");
  const resumeHandler = sw.slice(sw.indexOf('async "run.resume"'));
  const guardIdx = resumeHandler.indexOf("agent_mismatch");
  const lookupIdx = resumeHandler.indexOf('"run_not_found"');
  const dispatchIdx = resumeHandler.indexOf("resumeAfterPermission(executionId)");
  assert(lookupIdx > 0 && guardIdx > lookupIdx, "the guard runs AFTER the run lookup (run.agentId is available)");
  assert(dispatchIdx > guardIdx, "the guard runs BEFORE resume dispatch — mismatches never reach the agent");
  // the producer side still carries the identity from the SW-authored record
  assert(sw.includes("expectedAgentId: agentId"), "the notification-click closure passes expectedAgentId");
  // no other caller passes the parameter, so existing resume flows are unconstrained
  const producerCount = sw.split("expectedAgentId").length - 1;
  assertEquals(producerCount, 3, "exactly two references on the guard line + one producer; any new consumer/producer breaks this pin");
});
