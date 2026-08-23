// CAP-FB-20260823-AGENT-ICON-ON-CREATE-01 — the agent's icon is generated as
// part of creation (a bounded, best-effort immediate follow-up), never
// lazy-on-click; failure keeps the deterministic initial-avatar placeholder;
// a concurrent owner edit is never clobbered; storage stays bounded.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  AGENT_AVATAR_FOLLOWUP_TIMEOUT_MS,
  generateAvatarForCreatedAgent,
} from "../extension/lib/named-agents.js";
import { initialAvatar } from "../extension/lib/avatar.js";

function harness({ key = "k", generated = "data:image/jpeg;base64,xxx", stored = null, generateImpl } = {}) {
  const calls = { generate: 0, update: 0, updates: [] };
  const api = {
    getAgent: async () => (stored === "gone" ? null : { id: "a1", name: "A", avatar: stored?.avatar ?? null }),
    updateAgent: async (id, patch) => { calls.update++; calls.updates.push({ id, patch }); return { ok: true }; },
    readGeminiKey: async () => key,
    generate: async ({ name, role, apiKey }) => {
      calls.generate++;
      calls.name = name; calls.role = role; calls.apiKey = apiKey;
      if (typeof generateImpl === "function") return generateImpl({ name, role, apiKey });
      return generated;
    },
  };
  return { api, calls };
}

const agent = { id: "a1", name: "Tab Penguin", role: "helps with tabs", avatar: null };

Deno.test("creation avatar follow-up: success attaches the generated icon", async () => {
  const { api, calls } = harness();
  const res = await generateAvatarForCreatedAgent({ agent, ...api });
  assertEquals(res, { attached: true });
  assertEquals(calls.generate, 1, "generation runs exactly once");
  assertEquals(calls.name, "Tab Penguin");
  assertEquals(calls.role, "helps with tabs");
  assertEquals(calls.apiKey, "k");
  assertEquals(calls.update, 1, "the avatar is persisted via update");
  assertEquals(calls.updates[0].id, "a1");
  assertEquals(calls.updates[0].patch.avatar, "data:image/jpeg;base64,xxx");
});

Deno.test("creation avatar follow-up: an agent created WITH an avatar never generates", async () => {
  const { api, calls } = harness();
  const res = await generateAvatarForCreatedAgent({ agent: { ...agent, avatar: "data:image/svg+xml;x" }, ...api });
  assertEquals(res, { attached: false, reason: "has-avatar" });
  assertEquals(calls.generate, 0, "no generation when the create already carried an icon");
  assertEquals(calls.update, 0);
});

Deno.test("creation avatar follow-up: no key / null result / failure never touch storage (placeholder remains)", async () => {
  for (const [label, over] of [
    ["no-key", { key: "" }],
    ["generation-returned-null", { generateImpl: async () => null }],
    ["generation-failed", { generateImpl: async () => { throw new Error("boom"); } }],
    ["agent-gone", { stored: "gone" }],
  ]) {
    const { api, calls } = harness(over);
    const res = await generateAvatarForCreatedAgent({ agent, ...api });
    assertEquals(res.attached, false, label);
    assertEquals(calls.update, 0, `${label}: no update`);
  }
  // The placeholder every surface falls back to is deterministic + an image.
  const ph = initialAvatar("Tab Penguin");
  assertEquals(ph, initialAvatar("Tab Penguin"), "deterministic");
  assert(ph.startsWith("data:image/svg+xml"), "a valid image data URL, never a broken image");
});

Deno.test("creation avatar follow-up: a concurrent owner edit is never clobbered", async () => {
  const { api, calls } = harness({ stored: { avatar: "data:image/svg+xml;owner-picked" } });
  const res = await generateAvatarForCreatedAgent({ agent, ...api });
  assertEquals(res, { attached: false, reason: "avatar-set-concurrently" });
  assertEquals(calls.update, 0, "the owner's avatar wins — no write");
});

Deno.test("creation avatar follow-up: generation is time-bounded", async () => {
  const { api, calls } = harness({ generateImpl: () => new Promise(() => {}) });
  const res = await generateAvatarForCreatedAgent({ agent, ...api, timeoutMs: 25 });
  assertEquals(res, { attached: false, reason: "generation-failed" }, "a hung generation resolves by timeout");
  assertEquals(calls.update, 0);
  assertEquals(AGENT_AVATAR_FOLLOWUP_TIMEOUT_MS, 20_000, "the production bound stays pinned");
});

Deno.test("creation avatar follow-up: the service worker wires it into named-agent.create (no click dependency)", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("generateAvatarForCreatedAgent({"), "the create route invokes the follow-up");
  assert(/named-agent\.create[\s\S]{0,900}generateAvatarForCreatedAgent/.test(sw), "it is wired inside the create handler");
  assert(sw.includes("if (r?.agent && !r.agent.avatar)"), "it only runs when the created agent has no avatar");
  assert(!/regenBtn[\s\S]{0,200}named-agent\.create/.test(sw), "creation does not depend on the dialog regenerate button");
  // Placeholder fallback stays the render default (ntp): avatar || initialAvatar.
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(ntp.includes("a.avatar || initialAvatar("), "every surface still falls back to the deterministic placeholder");
});
