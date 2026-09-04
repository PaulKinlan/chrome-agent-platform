// @ts-nocheck — source-contract tests intentionally read shipped source bytes.
// tests/settings-diagnostics-relocation.test.ts — Settings IA: diagnostics
// relocation (docs/SETTINGS-CLEANLINESS.md deferred rows).
//
// (a) the install-grant permission matrix lives behind Advanced → Diagnostics;
//     Permissions keeps ONE compact access-health summary;
// (b) the WebMCP script-lifecycle block lives in Advanced, collapsed by
//     default — the Agents section no longer carries it;
// (c) raw chrome.* event ids + subscribers live in Advanced diagnostics
//     (read-only); the grouped deny/allowed policy with its switches lives in
//     Permissions; the Hooks section is a pointer to both homes;
// (d) tool library — decision A: the explicit Preview stays, the copy stops
//     claiming "Nothing here runs"; the section stays developer-gated;
// (e) the local-folder browser rows use SVG line icons, never emoji.
//
// Falsification: revert any moved block to its old section → RED.

import { assert, assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";

const read = (path: string) => Deno.readTextFile(new URL(path, import.meta.url));

/** The flat <section id="…"> body for a Settings panel (sections do not nest). */
function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  assert(start >= 0, `section #${id} must exist`);
  const end = html.indexOf("<section", start + 1);
  return html.slice(start, end === -1 ? html.length : end);
}

// ── (b) WebMCP script-lifecycle block: Agents → Advanced ───────────────────

Deno.test("IA move: the WebMCP lifecycle block renders in Advanced, collapsed — not in Agents", async () => {
  const html = await read("../extension/options/options.html");
  const agents = sectionOf(html, "agents");
  const prompts = sectionOf(html, "prompts");

  for (const marker of ["webmcp-status-body", "webmcp-diagnostics", "webmcp-status"]) {
    assert(!agents.includes(marker), `the Agents section still carries the moved WebMCP block (${marker})`);
  }
  assert(agents.includes('id="enrolled-sites"'), "the enrollment list stays in Agents");

  assertMatch(prompts, /id="webmcp-status-body"/, "the status body renders in Advanced");
  assertMatch(prompts, /id="webmcp-diagnostics"/, "the DevTools logging toggle moves with the block");
  // Collapsed by default: the disclosure carrying the block has no `open` attr.
  const detailsOpen = prompts.indexOf('<details class="diag-block" id="diag-webmcp">');
  assert(detailsOpen >= 0, "the block lives in a named diagnostics disclosure");
  const detailsTag = prompts.slice(detailsOpen, prompts.indexOf(">", detailsOpen) + 1);
  assertNotMatch(detailsTag, /\bopen\b/, "the WebMCP disclosure is collapsed by default");
  // It sits under the Diagnostics heading, after the captured-errors console.
  assert(prompts.indexOf('id="diagnostics-console"') < detailsOpen, "the disclosure sits in the Diagnostics zone");
});

// ── (a) permission matrix: Permissions → Advanced disclosure ────────────────

Deno.test("IA move: the install-grant matrix is behind Advanced → Diagnostics; Permissions keeps one health summary", async () => {
  const html = await read("../extension/options/options.html");
  const js = await read("../extension/options/options.js");
  const permissions = sectionOf(html, "permissions");
  const prompts = sectionOf(html, "prompts");

  // Permissions: one compact health line + the live capability controls.
  assertMatch(permissions, /id="permission-health"/, "the compact access-health summary renders in Permissions");
  assertMatch(permissions, /id="permission-list"/, "the capability controls stay in Permissions");
  assertNotMatch(permissions, /Always on/, "the fixed install-grant group no longer renders in Permissions");

  // Advanced: the per-permission matrix host inside a diagnostics disclosure.
  assertMatch(prompts, /id="permission-matrix"/, "the matrix host renders in Advanced");
  assert(prompts.indexOf('id="diag-permissions"') >= 0, "the matrix lives in a named diagnostics disclosure");

  // The renderer moved: renderPermissions no longer builds the required group;
  // renderPermissionDiagnostics builds the verified matrix; the health line
  // names the only remediation (reload, then reinstall).
  const renderPermissionsFn = js.slice(
    js.indexOf("async function renderPermissions()"),
    js.indexOf("async function renderHookPolicy()"),
  );
  assert(renderPermissionsFn.length > 0, "renderPermissions exists");
  assertNotMatch(renderPermissionsFn, /permissionGroupShell\(\s*"required"/, "renderPermissions no longer renders the install-grant group");
  assertMatch(js, /async function renderPermissionDiagnostics\(\)/, "the diagnostics renderer exists");
  const diagFn = js.slice(js.indexOf("async function renderPermissionDiagnostics()"), js.indexOf("async function renderPermissionHealth()"));
  assertMatch(diagFn, /permission-matrix/, "the diagnostics renderer fills the Advanced host");
  assertMatch(diagFn, /optional_permissions/, "the matrix covers the whole manifest, not just the boot set");
  assertMatch(js, /async function renderPermissionHealth\(\)/, "the health renderer exists");
  assertMatch(js, /Reload the extension; if it is still missing, reinstall the extension/, "a missing install grant names its only remediation");
});

// ── (c) hooks: raw ids/subscribers → Advanced, policy → Permissions ────────

Deno.test("IA move: raw hook event ids + subscribers are Advanced-only diagnostics", async () => {
  const html = await read("../extension/options/options.html");
  const js = await read("../extension/options/options.js");
  const hooksSection = sectionOf(html, "hooks");
  const prompts = sectionOf(html, "prompts");

  // The Hooks section keeps its nav-visible panel but no longer carries the
  // raw table — it points at the two new homes.
  assertNotMatch(hooksSection, /id="hook-list"/, "the raw table is gone from the Hooks section");
  assertNotMatch(hooksSection, /hooks-deny-all/, "the deny-all control is gone from the Hooks section");
  assertMatch(hooksSection, /Permissions/, "the Hooks section points at the policy home");
  assertMatch(hooksSection, /Diagnostics/, "the Hooks section points at the raw home");

  // The raw list renders in Advanced diagnostics (read-only: no switches).
  assertMatch(prompts, /id="hook-list"/, "the raw table renders in Advanced");
  assertMatch(prompts, /Subscribers/, "the raw table keeps the subscriber column");
  const hooksFn = js.slice(js.indexOf("async function renderHooks()"), js.indexOf("// vocab:advanced:end"));
  assertNotMatch(hooksFn, /createElement\("switch-toggle"\)/, "the raw diagnostics render no switches");
  assertNotMatch(hooksFn, /hooks\.deny/, "the raw diagnostics change no policy");
  assertMatch(hooksFn, /subscribers/, "the raw renderer still names subscribers");
});

Deno.test("IA move: the grouped deny/allowed hook policy renders in Permissions with real controls", async () => {
  const js = await read("../extension/options/options.js");

  // The policy renderer lives OUTSIDE the vocab:advanced region — it is
  // user-facing copy — and writes through the same hooks.deny authority.
  const policyStart = js.indexOf("async function renderHookPolicy()");
  const advancedStart = js.indexOf("vocab:advanced:start");
  const advancedEnd = js.lastIndexOf("vocab:advanced:end");
  assert(policyStart >= 0, "renderHookPolicy exists");
  assert(!(policyStart > advancedStart && policyStart < advancedEnd), "renderHookPolicy is not inside the developer-vocabulary region");
  // Slice only the user-facing renderer: it ends where the developer-vocabulary
  // region begins (the raw HOOK_API_LABELS map with its system words lives there).
  const policyFn = js.slice(policyStart, js.indexOf("vocab:advanced:start"));
  assert(policyFn.length > 0, "the policy slice is non-empty");
  assertMatch(policyFn, /permissionGroupShell\(/, "the policy renders as a Permissions group");
  assertMatch(policyFn, /createElement\("switch-toggle"\)/, "each event keeps its deny/allowed switch");
  assertMatch(policyFn, /hooks\.deny/, "the switches write through the authoritative route");
  assertMatch(policyFn, /Deny all/, "the confirmed deny-all control lives with the policy");
  // The user-facing labels never speak the system words banned outside
  // developer surfaces (two of the chrome.* group labels would otherwise).
  assertMatch(js, /HOOK_POLICY_LABELS/, "the policy renames the system-word API groups");
  assertNotMatch(policyFn, /"Runtime"|"Alarms"/, "no banned system word in the policy renderer");
});

// ── (d) tool library: decision A — explicit Preview, honest copy ───────────

Deno.test("tool library decision A: the Preview stays, the copy stops claiming nothing runs, the section stays developer-gated", async () => {
  const html = await read("../extension/options/options.html");
  const components = await read("../extension/shared/components.js");

  const sectionStart = html.indexOf('<section id="tool-library"');
  const sectionTag = html.slice(sectionStart, html.indexOf(">", sectionStart) + 1);
  assertMatch(sectionTag, /data-developer="true"/, "the section keeps its developer gating");

  const section = sectionOf(html, "tool-library");
  assertNotMatch(section, /Nothing here runs/, "the false nothing-runs claim is gone");
  assertNotMatch(section, /Read-only diagnostics/, "the section no longer calls itself read-only diagnostics");
  assertMatch(section, /explicit click/, "the section states the explicit-preview truth");

  // The component framing agrees: the preview runs on an explicit click, and
  // the absent actions are still named (install/grant/update/remove).
  const blockStart = components.indexOf("<tool-library> — the owner's tool catalog");
  const blockEnd = components.indexOf('customElements.define("tool-library"');
  assert(blockStart > 0 && blockEnd > blockStart, "the tool-library component block exists");
  const block = components.slice(blockStart, blockEnd);
  assertNotMatch(block, /read-only diagnostic view/i, "the old read-only framing is gone");
  assertNotMatch(block, /It cannot run, install, grant, update, or remove anything/, "the false cannot-run claim is gone");
  assertMatch(block, /explicit click/, "the framing names the explicit-click preview");
  assertMatch(block, /installs, grants,\s*updates, or removes/, "the absent actions stay named");
  assertEquals((block.match(/<button/g) ?? []).length, 1, "exactly one button (the preview Run)");
  assertMatch(block, /class="preview-run"/, "the preview Run button survives");
});

// ── (e) local-folder rows: SVG line icons replace the emoji ────────────────

Deno.test("IA move: the folder browser source carries SVG line icons, never the emoji", async () => {
  const js = await read("../extension/lib/folder-browser.js");
  assert(!js.includes("📁") && !js.includes("📄"), "the emoji are gone from the folder browser");
  assertMatch(js, /createElementNS\(/, "icons are built through the SVG DOM API");
  assertMatch(js, /"http:\/\/www\.w3\.org\/2000\/svg"/, "icons use the SVG namespace");
  assertMatch(js, /createElementNS\([A-Za-z_$][\w$]*,\s*"svg"\)/, "a real <svg> element is created");
  assertMatch(js, /stroke.*currentColor|currentColor.*stroke/s, "the icons stroke with currentColor (both schemes legible)");
});

Deno.test("IA move: mounted folder rows render the SVG icon + the bare name (no emoji anywhere)", async () => {
  // Minimal DOM stub (folder-browser.test.ts precedent) + createElementNS.
  function makeEl(tag: string) {
    const el: any = {
      tag,
      children: [] as any[],
      style: {},
      attrs: {} as Record<string, string>,
      listeners: {} as Record<string, any[]>,
      _text: "",
      className: "",
      disabled: false,
      type: "",
      append(...nodes: any[]) { this._text = ""; for (const n of nodes) { this.children.push(n); n.parent = this; } return this; },
      appendChild(n: any) { this.append(n); return n; },
      replaceChildren(...nodes: any[]) { this.children = []; this._text = ""; for (const n of nodes) { this.children.push(n); n.parent = this; } },
      remove() {
        if (this.parent) {
          const i = this.parent.children.indexOf(this);
          if (i >= 0) this.parent.children.splice(i, 1);
        }
      },
      addEventListener(t: string, fn: any) { (this.listeners[t] ??= []).push(fn); },
      setAttribute(k: string, v: string) { this.attrs[k] = String(v); },
      getAttribute(k: string) { return this.attrs[k]; },
      emit(t: string, ev = {}) { for (const fn of this.listeners[t] ?? []) fn(ev); },
    };
    Object.defineProperty(el, "textContent", {
      get() { return el.children.length === 0 ? el._text : el.children.map((c: any) => c.textContent).join(""); },
      set(v: string) { el._text = String(v); el.children = []; },
    });
    return el;
  }
  globalThis.document = {
    createElement: (tag: string) => makeEl(tag),
    createElementNS: (_ns: string, tag: string) => makeEl(tag),
  } as any;

  const { mountGrantBrowser } = await import("../extension/lib/folder-browser.js?svg-icons");
  const host = makeEl("div");
  const tree: any = {
    "": { ok: true, grantId: "g1", kind: "directory", path: "", entries: [{ name: "docs", kind: "directory" }, { name: "notes.txt", kind: "file" }], truncated: false, total: 2 },
  };
  const send = async (type: string, payload: any) => {
    if (type === "fs-grant.list-entries") return tree[payload.relativePath ?? ""] ?? { ok: false, error: "directory_not_found" };
    return { ok: false, error: `unexpected ${type}` };
  };
  mountGrantBrowser({ host, grant: { grantId: "g1", name: "MyFolder" }, send });
  await new Promise((r) => setTimeout(r, 0));

  const walk = (node: any, out: any[] = []) => { for (const c of node?.children ?? []) { out.push(c); walk(c, out); } return out; };
  const all = walk(host);

  // No emoji survives anywhere in the rendered drawer.
  const everyText = all.map((n) => n._text ?? "").join("\n");
  assert(!everyText.includes("📁") && !everyText.includes("📄"), "no emoji in the rendered rows");

  // The directory row is a button carrying an svg child + the bare name.
  const dirBtn = all.find((n) => String(n.className).split(/\s+/).includes("fs-dir"));
  assert(dirBtn, "the directory row exists");
  assertEquals(dirBtn.textContent, "docs", "the directory row text is the bare name");
  assert(dirBtn.children.some((c: any) => c.tag === "svg"), "the directory row carries the SVG icon");

  // The file row carries the svg icon + the bare name.
  const fileLeft = all.find((n) => String(n.className).split(/\s+/).includes("fs-file"));
  assert(fileLeft, "the file row exists");
  assert(fileLeft.children.some((c: any) => c.tag === "svg"), "the file row carries the SVG icon");
  assertEquals(fileLeft.textContent, "notes.txt", "the file row text is the bare name");

  // The icons stroke with currentColor so both color schemes stay legible.
  const svg = dirBtn.children.find((c: any) => c.tag === "svg");
  assertEquals(svg.attrs.stroke, "currentColor", "the icon strokes currentColor");
  assertEquals(svg.attrs["aria-hidden"], "true", "the icon is decorative");
});

// ── the moved blocks keep their wiring contracts ───────────────────────────

Deno.test("IA move: SETTINGS_SECTIONS and the developer gating are untouched by the relocation", async () => {
  const { SETTINGS_SECTIONS, DEVELOPER_SECTIONS } = await import("../extension/lib/pure.js?ia-move");
  // No section was added or dropped — the blocks moved WITHIN sections.
  assertEquals([...SETTINGS_SECTIONS].length, 14, "the section inventory is unchanged");
  assertEquals([...DEVELOPER_SECTIONS], ["tool-library", "board-permissions", "hooks", "prompts"], "the developer lanes are unchanged");
  const html = await read("../extension/options/options.html");
  const navOrder = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const sectionOrder = [...html.matchAll(/<section\s+id="([^"]+)"/g)].map((m) => m[1]);
  assertEquals(navOrder, sectionOrder, "nav order still matches section order");
});
