// tests/thread-view.test.ts — unit tests for pure thread-view rules
import { assertEquals, assert } from "jsr:@std/assert";
import {
  composeWorkingLabel,
  isScrolledToBottom,
  artifactCardTitle,
  artifactIdentityFromPayloads,
  turnTime,
  projectThreadMessages,
  stripModelAddressedText,
} from "../extension/shared/thread-view.js";

Deno.test("thread-view: composeWorkingLabel formats working banner text", () => {
  assertEquals(composeWorkingLabel("Reading page…"), "Working — reading page…");
  assertEquals(composeWorkingLabel(""), "Working…");
  assertEquals(composeWorkingLabel("Thinking · step 2"), "Working — thinking · step 2…");
});

Deno.test("thread-view: isScrolledToBottom detects scroll threshold", () => {
  assertEquals(isScrolledToBottom({ scrollTop: 100, clientHeight: 200, scrollHeight: 300 }), true);
  assertEquals(isScrolledToBottom({ scrollTop: 0, clientHeight: 200, scrollHeight: 500 }), false);
});

Deno.test("thread-view: stripModelAddressedText removes model directives", () => {
  assertEquals(stripModelAddressedText("Owner denied the requested capability. list_tabs was not performed; do not retry it."), "");
});
