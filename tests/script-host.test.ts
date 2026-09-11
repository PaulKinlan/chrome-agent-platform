// Unit test for the script-host claim protocol (the GLM H1 fix).
// The SW's runScriptSandboxed announces a runId first; the hosts claim it (the
// FIRST claim wins via the SW's sendMessage), then the SW sends the source
// addressed to the winning host ONLY. This test proves a host drops a run
// addressed to a DIFFERENT host (no double-execution) and claims the announce.
// @ts-nocheck — the handler's sendResponse is intentionally loose here.

import { assertEquals } from "jsr:@std/assert@1";
import { handleScriptRunMessage } from "../extension/lib/script-host.js";

Deno.test("script host: announce responds with a claim + the host id", () => {
  let response = null;
  const ret = handleScriptRunMessage(
    { type: "cap:script-run-announce", runId: "run_abcdefgh" },
    (r) => { response = r; },
    { createElement: () => ({}) },
    "offscreen",
  );
  assertEquals(ret, false, "the announce is answered synchronously");
  assertEquals(response?.claimed, true);
  assertEquals(response?.host, "offscreen");
  assertEquals(response?.runId, "run_abcdefgh");
});

Deno.test("script host: a run addressed to ANOTHER host is dropped (no double execution)", () => {
  let response = null;
  const ret = handleScriptRunMessage(
    { type: "cap:script-run", source: "return 1;", runId: "run_abcdefgh", for: "ntp" },
    (r) => { response = r; },
    { createElement: () => ({}) },
    "offscreen",
  );
  assertEquals(ret, false, "the offscreen host must NOT handle a run for the ntp host");
  assertEquals(response, null, "no response is sent for a foreign-host run");
});

Deno.test("script host: a run addressed to THIS host is accepted (not dropped)", () => {
  let response = null;
  // The handler accepts a matching host (returns true) then attempts the sandbox
  // run (which needs a real document). Without a document it throws, but the
  // ROUTING decision — accept, not drop — is what matters. Catch the throw.
  let threw = false;
  let ret;
  try {
    ret = handleScriptRunMessage(
      { type: "cap:script-run", source: "return 1;", runId: "run_abcdefgh", for: "offscreen" },
      (r) => { response = r; },
      { createElement: () => ({}) },
      "offscreen",
    );
  } catch {
    threw = true;
  }
  // Either it returned true (accepted + held for the async run) or it threw on
  // the sandbox bootstrap — but it must NOT have returned false (dropped).
  assertEquals(ret !== false || threw, true, "a matching-host run is accepted, not dropped");
});

Deno.test("script host: handleScriptRunMessage accepts modules array and dispatches", () => {
  let ret = handleScriptRunMessage(
    {
      type: "cap:script-run",
      source: "return 1;",
      runId: "run_abcdefgh",
      for: "offscreen",
      modules: [{ name: "my-math", digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", source: "" }],
    },
    (_r) => {},
    { createElement: () => ({ style: {}, setAttribute: () => {}, addEventListener: () => {} }), body: { appendChild: () => {} } },
    "offscreen",
  );
  assertEquals(ret, true, "host accepts run with modules");
});

Deno.test("script host: handleScriptRunMessage fails closed on invalid module name", async () => {
  let response = null;
  const ret = handleScriptRunMessage(
    {
      type: "cap:script-run",
      source: "return 1;",
      runId: "run_abcdefgh",
      for: "offscreen",
      modules: [{ name: "../escape", digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", source: "" }],
    },
    (r) => { response = r; },
    { createElement: () => ({ style: {}, setAttribute: () => {}, addEventListener: () => {} }), body: { appendChild: () => {} } },
    "offscreen",
  );
  assertEquals(ret, true);
  // Wait for async resolution
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(response?.ok, false);
  assertEquals(response?.error?.includes("Invalid module name"), true);
});

