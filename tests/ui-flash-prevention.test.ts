// tests/ui-flash-prevention.test.ts — Prevention of UI flash and relayout during settings navigation (CAP-FB-20260819-UI-FLASH-RELAYOUT-01 / fw8).
//
// Falsification & regression verification:
// 1. handleSettingsHashNavigation guards scrollIntoView and heading focus against redundant executions when the section is already active.
// 2. Acorn AST pins ensure the conditional execution of scrollIntoView inside handleSettingsHashNavigation.

import { assert } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";

const JS = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

Deno.test("ui-flash: handleSettingsHashNavigation avoids redundant scroll/focus when section is already active (fw8)", () => {
  const navFn = JS.slice(
    JS.indexOf("export async function handleSettingsHashNavigation"),
    JS.indexOf("export const navigationController"),
  );

  assert(
    navFn.includes('const wasActive = section.classList.contains("active");'),
    "handleSettingsHashNavigation must record prior active state",
  );
  assert(
    navFn.includes("if (!wasActive || isTraverse) {"),
    "scrollIntoView and focus must only trigger on section transition or history traversal",
  );
});

Deno.test("ui-flash: AST verification that scrollIntoView is inside (!wasActive || isTraverse) branch", () => {
  const ast = parse(JS, { ecmaVersion: "latest", sourceType: "module" }) as any;
  const navFn = ast.body.find(
    (n: any) => n.type === "ExportNamedDeclaration" && n.declaration?.id?.name === "handleSettingsHashNavigation",
  )?.declaration;
  assert(navFn, "handleSettingsHashNavigation export must exist");

  let foundGuardedScroll = false;
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "IfStatement" &&
      node.test &&
      node.consequent
    ) {
      let hasScroll = false;
      const walkInner = (inner: any) => {
        if (!inner || typeof inner !== "object") return;
        if (
          inner.type === "CallExpression" &&
          inner.callee?.property?.name === "scrollIntoView"
        ) {
          hasScroll = true;
          return;
        }
        for (const k of Object.keys(inner)) {
          const v = inner[k];
          if (Array.isArray(v)) v.forEach(walkInner);
          else if (v && typeof v === "object") walkInner(v);
        }
      };
      walkInner(node.consequent);
      if (hasScroll) {
        const testSource = JS.slice(node.test.start, node.test.end);
        if (testSource.includes("wasActive")) {
          foundGuardedScroll = true;
        }
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(navFn);

  assert(foundGuardedScroll, "section.scrollIntoView must be guarded by wasActive in AST");
});
