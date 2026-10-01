// @ts-nocheck
// tests/transcript-narrative-716s3.test.ts — behavioral tests for transcript narrative
// (chrome-agent-platform-716s.3):
// 1. humanToolLabel helper in permission-language.js + components.js
// 2. Single quiet narrative line for declined tool calls
// 3. Suppression of duplicate declined tool card when denied approval is present
// 4. Model-addressed text stripped from owner-facing rendering
// 5. Agent identity resolves to "Assistant" instead of literal "A Agent"
// 6. Genuinely failed tools still render as error

import { assertEquals, assertStringIncludes, assert, assertNotMatch } from "jsr:@std/assert";
import { humanToolLabel } from "../extension/lib/permission-language.js";
import { stripModelAddressedText, projectThreadMessages } from "../extension/shared/thread-view.js";

const registry = new Map();

class ShadowRootStub {
  constructor() { this._html = ""; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
  get textContent() {
    return this._html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

class HTMLElementStub {
  constructor() {
    this._attrs = new Map();
    this._shadow = new ShadowRootStub();
  }
  attachShadow(_init) { return this._shadow; }
  get shadowRoot() { return this._shadow; }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) {
    const old = this.getAttribute(n);
    this._attrs.set(n, String(v));
    if (this.attributeChangedCallback && old !== String(v)) {
      this.attributeChangedCallback(n, old, String(v));
    }
  }
  removeAttribute(n) {
    const old = this.getAttribute(n);
    this._attrs.delete(n);
    if (this.attributeChangedCallback && old !== null) {
      this.attributeChangedCallback(n, old, null);
    }
  }
  dispatchEvent(_e) { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

if (!globalThis.HTMLElement) {
  globalThis.HTMLElement = HTMLElementStub;
  globalThis.customElements = {
    define(name, cls) { registry.set(name, cls); },
    get(name) { return registry.get(name); },
  };
  globalThis.window = globalThis;
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
  };
  globalThis.matchMedia = () => ({ matches: false });
}

Deno.test("humanToolLabel: maps internal camelCase/snake_case tool names to human labels", () => {
  assertEquals(humanToolLabel("browser_list_tabs"), "List open tabs");
  assertEquals(humanToolLabel("listTabs"), "List open tabs");
  assertEquals(humanToolLabel("list_tabs"), "List open tabs");
  assertEquals(humanToolLabel("capture_region"), "Capture page region");
  assertEquals(humanToolLabel("captureRegion"), "Capture page region");
  assertEquals(humanToolLabel("capture_screenshot"), "Capture page screenshot");
  assertEquals(humanToolLabel("screenshot"), "Capture page screenshot");
  assertEquals(humanToolLabel("read_page"), "Read current page");
  assertEquals(humanToolLabel("get_page_text"), "Read current page");
  assertEquals(humanToolLabel("click"), "Click on page");
  assertEquals(humanToolLabel("browser_click"), "Click on page");
  assertEquals(humanToolLabel("fill"), "Fill form field");
  assertEquals(humanToolLabel("type_text"), "Fill form field");
  assertEquals(humanToolLabel("navigate"), "Open web page");
  assertEquals(humanToolLabel("open_tab"), "Open web page");
  assertEquals(humanToolLabel("memory_read"), "Read saved memory");
  assertEquals(humanToolLabel("recall_memory"), "Read saved memory");
  assertEquals(humanToolLabel("memory_write"), "Save to memory");
  assertEquals(humanToolLabel("save_memory"), "Save to memory");

  // Clean fallback converting camelCase / snake_case to sentence case
  assertEquals(humanToolLabel("custom_batch_action"), "Custom batch action");
  assertEquals(humanToolLabel("customBatchAction"), "Custom batch action");
});

Deno.test("stripModelAddressedText: removes model instructions from owner-facing text", () => {
  const modelInstruction = "Owner denied the requested capability. list_tabs was not performed; do not retry it.";
  const stripped = stripModelAddressedText(modelInstruction);
  assertEquals(stripped, "");

  const mixed = "The user declined this tool call. Do not retry the same call. Proceeding without tabs.";
  const strippedMixed = stripModelAddressedText(mixed);
  assertEquals(strippedMixed, "Proceeding without tabs.");
});

Deno.test("projectThreadMessages: suppresses duplicate tool card when denied approval is present", () => {
  const thread = {
    messages: [
      { role: "user", content: "group my tabs", ts: 100 },
      {
        role: "approval",
        state: "denied",
        requirement: { permissions: ["tabs"], tool: "list_tabs", key: "req-tabs" },
        ts: 101,
      },
      {
        role: "tool",
        toolName: "list_tabs",
        toolStatus: "error",
        toolResult: "Owner denied the requested capability. list_tabs was not performed; do not retry it.",
        toolOk: false,
        ts: 102,
      },
      { role: "assistant", content: "I could not list tabs.", ts: 103 },
    ],
  };

  const projected = projectThreadMessages(thread);
  const toolRows = projected.filter((m: any) => m.role === "tool");
  assertEquals(toolRows.length, 0, "duplicate declined tool card must be suppressed when approval is denied");

  const approvalRows = projected.filter((m: any) => m.role === "approval");
  assertEquals(approvalRows.length, 1, "denied approval row is retained");
  assertEquals(approvalRows[0].state, "denied");
});

Deno.test("projectThreadMessages: renders declined tool as quiet line when no approval card is present", () => {
  const thread = {
    messages: [
      { role: "user", content: "list tabs", ts: 100 },
      {
        role: "tool",
        toolName: "list_tabs",
        toolStatus: "error",
        toolResult: "Owner denied the requested capability. list_tabs was not performed; do not retry it.",
        toolOk: false,
        ts: 101,
      },
      { role: "assistant", content: "Understood.", ts: 102 },
    ],
  };

  const projected = projectThreadMessages(thread);
  const toolRows = projected.filter((m: any) => m.role === "tool");
  assertEquals(toolRows.length, 1);
  assertEquals(toolRows[0].skipped, true);
  assertStringIncludes(toolRows[0].content, "You skipped list open tabs");
});

Deno.test("projectThreadMessages: genuinely failed tool still renders as error (negative test)", () => {
  const thread = {
    messages: [
      { role: "user", content: "fetch page", ts: 100 },
      {
        role: "tool",
        toolName: "fetch_url",
        toolStatus: "error",
        toolResult: "Failed to connect to host: connection refused",
        toolOk: false,
        ts: 101,
      },
      { role: "assistant", content: "Network error occurred.", ts: 102 },
    ],
  };

  const projected = projectThreadMessages(thread);
  const toolRows = projected.filter((m: any) => m.role === "tool");
  assertEquals(toolRows.length, 1);
  assertEquals(toolRows[0].status, "error");
  assertEquals(toolRows[0].skipped, undefined);
});

Deno.test("components: PermissionApprovalCard state='denied' renders single quiet inline narrative line", async () => {
  await import("../extension/shared/components.js");
  const CardClass = globalThis.customElements.get("permission-approval-card");
  assert(CardClass, "permission-approval-card must be registered");
  const el = new CardClass();
  el.setAttribute("state", "denied");
  el.setAttribute("tool", "list_tabs");
  el.setAttribute("permissions", '["tabs"]');
  el.connectedCallback();

  const text = el.shadowRoot.textContent;
  assertStringIncludes(text, "You skipped list open tabs");
  assertNotMatch(text, /denied/i);
  assertNotMatch(text, /do not retry/i);
});

Deno.test("components: AgentIdentity resolves missing or literal 'Agent' to 'Assistant'", async () => {
  await import("../extension/shared/components.js");
  const IdentityClass = globalThis.customElements.get("agent-identity");
  assert(IdentityClass, "agent-identity must be registered");

  const el1 = new IdentityClass();
  el1.setAttribute("name", "Agent");
  el1.connectedCallback();
  const text1 = el1.shadowRoot.textContent;
  assertStringIncludes(text1, "Assistant");
  assertNotMatch(text1, /\bAgent\b/);

  const el2 = new IdentityClass();
  el2.connectedCallback();
  const text2 = el2.shadowRoot.textContent;
  assertStringIncludes(text2, "Assistant");

  const el3 = new IdentityClass();
  el3.setAttribute("name", "Researcher");
  el3.connectedCallback();
  const text3 = el3.shadowRoot.textContent;
  assertStringIncludes(text3, "Researcher");
});

Deno.test("components: ToolReceipt renders skipped line when tool call is declined", async () => {
  await import("../extension/shared/components.js");
  const ToolReceiptClass = globalThis.customElements.get("tool-receipt");
  assert(ToolReceiptClass, "tool-receipt must be registered");

  const el = new ToolReceiptClass();
  el.setAttribute("tool", "list_tabs");
  el.setAttribute("status", "error");
  el.setAttribute("result", "Owner denied the requested capability. list_tabs was not performed; do not retry it.");
  el.connectedCallback();

  const text = el.shadowRoot.textContent;
  assertStringIncludes(text, "You skipped list open tabs");
  assertNotMatch(text, /Owner denied/i);
  assertNotMatch(text, /do not retry/i);
});
