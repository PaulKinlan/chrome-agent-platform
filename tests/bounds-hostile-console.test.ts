// CAP-FB-20260819-BOUNDS-CURRENT-MAIN-01: the diagnostics console capture
// wrappers must NEVER throw, even for hostile console arguments (a throwing
// toString, a Symbol, a getPrototypeOf-trapping Proxy) or a hostile original
// sink. Reconciled onto current main: the coercion is `scrubPrimitive` (objects/
// symbols fail closed to `<redacted:structured>`), the buffer is bounded, and
// the whole wrapper body is inside one try so no path can surface a throw.
// @ts-nocheck — the harness drives the exported production functions directly.
import { assertEquals } from "jsr:@std/assert@1";

const diag = await import("../extension/lib/diagnostics.js");

const throwingString = {
  toString() {
    throw new Error("hostile toString");
  },
};
const throwingPrototype = new Proxy(
  {},
  {
    getPrototypeOf() {
      throw new Error("hostile getPrototypeOf");
    },
  },
);

Deno.test("diagnostics bounds: scrubEventDetail fails closed for hostile structures (no throw)", () => {
  for (const value of [Symbol("hostile"), throwingString, throwingPrototype]) {
    let out;
    let thrown = "";
    try {
      out = diag.scrubEventDetail(value);
    } catch (error) {
      thrown = error.message;
    }
    assertEquals(thrown, "", "scrubEventDetail must never throw");
    assertEquals(
      out,
      "<redacted:structured>",
      "structured/object/symbol values fail closed",
    );
  }
});

Deno.test("diagnostics bounds: console capture wrappers never throw for hostile args or sinks", () => {
  const savedError = console.error;
  const savedWarn = console.warn;
  // Hostile sinks: the ORIGINAL console.error/warn now throw, so the wrapper's
  // try must contain both the safe coercion and the original sink.
  console.error = () => {
    throw new Error("hostile error sink");
  };
  console.warn = () => {
    throw new Error("hostile warning sink");
  };
  try {
    diag.installDiagnosticCapture();
    for (const logger of [console.error, console.warn]) {
      for (const value of [Symbol("hostile"), throwingString, throwingPrototype]) {
        let thrown = "";
        try {
          logger(value);
        } catch (error) {
          thrown = error.message;
        }
        assertEquals(
          thrown,
          "",
          "capture + original sink are fully contained (never throw)",
        );
      }
    }
  } finally {
    console.error = savedError;
    console.warn = savedWarn;
  }
});
