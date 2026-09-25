// Behavior + falsification tests for scripts/lib/cdp-eval.ts (kwrx P1).
//
// These drive the REAL helper functions with payloads shaped exactly like
// each transport's live wire shape — per the cap-astra requirement, the
// proof is behavioral, not regex-on-source. The falsification property
// these tests hold: delete the exceptionDetails inspection from either
// transport in cdp-eval.ts and this file goes red (each transport's
// exception payload is asserted through ITS OWN spelling, so no shared
// shortcut can cover both).
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert";
import {
  EvalSurfaceError,
  isEvalDiagnostic,
  methodValue,
  wireValue,
  type EvalDiagnostic,
} from "../scripts/lib/cdp-eval.ts";

// ---- chrome-journeys-family transport: resolve(d) gives the FULL message --
const wireOk = { id: 7, result: { result: { value: "chrome" } } };
const wireThrew = {
  id: 8,
  result: {
    result: {},
    exceptionDetails: {
      text: "Uncaught",
      exception: { description: "TypeError: cannot read 'x' of undefined" },
      url: "chrome-extension://abc/options.js",
      lineNumber: 41,
    },
  },
};

// ---- a11y-audit / capability-lifecycle family: resolve(m.result) ----------
const methodOk = { result: { value: 42 } };
const methodThrew = {
  result: {},
  exceptionDetails: { exception: { description: "ReferenceError: ghost is not defined" } },
};

Deno.test("cdp-eval transports read values through their own spelling", () => {
  assertEquals(wireValue(wireOk, "site"), "chrome");
  assertEquals(methodValue(methodOk, "site"), 42);
});

Deno.test("a page-side throw FAILS LOUD on both transports (kwrx core)", () => {
  for (const [name, run] of [
    ["wire", () => wireValue(wireThrew, "sender-authority")],
    ["method", () => methodValue(methodThrew, "combobox-parity")],
  ] as const) {
    let threw = false;
    try {
      run();
    } catch (err) {
      threw = true;
      assert(err instanceof EvalSurfaceError, `${name}: wrong error type`);
      assertStringIncludes((err as Error).message, `${name === "wire" ? "TypeError" : "ReferenceError"}`, `${name}: page text must be quoted`);
      assertStringIncludes((err as Error).message, name === "wire" ? "sender-authority" : "combobox-parity", `${name}: site must be named`);
      if (name === "wire") assertStringIncludes((err as Error).message, "options.js:41", "wire: origin location surfaces");
    }
    assert(threw, `${name}: a surfaced exception MUST throw — this is the 4vfj/cwy2/0lb4 landmine`);
  }
});

Deno.test("cross-transport misuse trips LOUD, it cannot silently read undefined", () => {
  // cap-astra requirement: the trap is a guard reading the WRONG transport
  // path while a pin still passes. Shape-trips make that a named error.
  assertThrows(
    () => methodValue(wireThrew as never, "journey-x"),
    EvalSurfaceError,
    "transport mismatch",
  );
  assertThrows(
    () => wireValue(methodThrew as never, "axe-y"),
    EvalSurfaceError,
    "transport mismatch",
  );
  // A dead/missing envelope in tolerant mode is a NAMED diagnostic, never a
  // silent success; strict mode throws.
  assertEquals(wireValue(undefined, "dead-session", { tolerant: true, why: "probe may race session teardown" }), {
    __cdpEvalError: "no-response-envelope",
    site: "dead-session",
  } satisfies EvalDiagnostic);
  assertThrows(() => methodValue(null, "gone"), EvalSurfaceError, "no-response-envelope");
  assertThrows(
    () => wireValue({ error: { code: -32000, message: "Not allowed" } }, "cmd-rejected"),
    EvalSurfaceError,
    "cdp-protocol-error",
  );
});

Deno.test("tolerance is opt-in, evidenced, and returns a NAMED diagnostic", () => {
  const d = methodValue(methodThrew, "axe-3", { tolerant: true, why: "audit continues past one bad combobox" });
  assert(isEvalDiagnostic(d), "tolerant result must be a named diagnostic");
  assertStringIncludes((d as EvalDiagnostic).__cdpEvalError, "ReferenceError");
  assertEquals((d as EvalDiagnostic).site, "axe-3");
  // A tolerant call WITHOUT a reason is itself a defect — it throws.
  assertThrows(
    // @ts-expect-error exercising the runtime guard from JS
    () => methodValue(methodThrew, "lazy", { tolerant: true }),
    EvalSurfaceError,
    "requires a non-empty `why`",
  );
  assertThrows(
    () => methodValue(methodThrew, "lazy", { tolerant: true, why: "   " }),
    EvalSurfaceError,
  );
});

Deno.test("no-exception undefined stays undefined (the helper does not invent failures)", () => {
  assertEquals(methodValue({ result: {} }, "side-effect-run"), undefined);
  assertEquals(wireValue({ result: { result: { value: undefined } } }, "noop"), undefined);
});

Deno.test("unparseable exceptionDetails are serialized, never swallowed", () => {
  const weird = { exceptionDetails: { weird: true, no: ["text"] } };
  let msg = "";
  try {
    methodValue(weird, "weird-site");
  } catch (err) {
    msg = (err as Error).message;
  }
  assertStringIncludes(msg, "weird", "the raw shape must reach the error text");
});
