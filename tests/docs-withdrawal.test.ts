// CAP-FB-20260821-DEAD-SURFACE-REMOVAL-01 — the docs mock withdrawal: the
// static link/redirect/AX semantics of the new docs root + the proof that no
// dangling link to a deleted mock remains.
import { assertEquals, assert } from "jsr:@std/assert@1";

const ROOT = new URL("../", import.meta.url).pathname;

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(`${ROOT}${rel}`);
}

Deno.test("docs root: the CSP-safe redirect (meta refresh, NO inline script) + the visible fallback link", async () => {
  const index = await read("docs/index.html");
  assert(/<meta http-equiv="refresh" content="0; url=components\.html">/.test(index),
    "the redirect must be a meta refresh to the gallery");
  assert(!/<script/.test(index), "no inline script (CSP-safe)");
  assert(/<a href="components\.html">component gallery<\/a>/.test(index),
    "the visible fallback link to the gallery must exist");
  assert(index.includes("mocks are withdrawn"), "the withdrawal wording must be honest");
  assert(index.includes("No screenshot claim is made here"), "the root explicitly disclaims any screenshot claim");
});

Deno.test("docs root: the gallery + the real product docs are preserved; the deleted mocks have ZERO inbound links", async () => {
  for (const f of ["docs/components.html", "docs/components.js", "docs/review-2026-08-21.html", "docs/DESIGN.md"]) {
    try { await read(f); } catch { throw new Error(`preserved file missing: ${f}`); }
  }
  const html = await read("docs/index.html");
  const review = await read("docs/review-2026-08-21.html");
  const all = html + review;
  for (const mock of ["moodboard", "ntp-hub.html", "chat.html", "directory.html", "memory.html"]) {
    assert(!all.includes(mock), `a dangling link to ${mock} remains`);
  }
  assert(!html.includes("UI mocks"), "the new root never claims UI mocks");
  const deleted = ["docs/moodboard/style-a-midnight.html", "docs/ntp-hub.html", "docs/chat.html", "docs/memory.html"];
  for (const f of deleted) {
    let exists = true;
    try { await read(f); } catch { exists = false; }
    assert(!exists, `the closed mock ${f} must be deleted`);
  }
});

Deno.test("docs root: the index is accessible (lang + a status role for the withdrawal)", async () => {
  const index = await read("docs/index.html");
  assert(/<html lang="en">/.test(index), "the root declares a language");
  assert(/role="status"/.test(index), "the withdrawal notice is announced via role=status");
  assertEquals(index.includes("viewport"), true);
});
