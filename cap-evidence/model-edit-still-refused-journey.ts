// cap-evidence/model-edit-still-refused-journey.ts — chrome-agent-platform-9mz1,
// the OTHER direction of the same fix.
//
// The widening (the owner's own edit IS the approval) must NOT let an agent edit
// artifacts unattended. This drives a REAL run whose model calls update_asset
// through the real lazy tool protocol (a scripted provider, no key) against the
// BUILT extension and proves:
//   1. the run PAUSES on the approval card — the agent's edit is refused;
//   2. the artifact is untouched while the card waits;
//   3. the owner's Allow on that card resolves it INLINE and the edit lands
//      (the surface hosting a card is why the refusal text must not claim
//      approvals live only in Settings).
//
//   deno run -A cap-evidence/model-edit-still-refused-journey.ts
import { launchChrome, openCdp } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { SCRIPTED_DUMMY_KEY, selectionRefOf, startScriptedProvider } from "../scripts/lib/scripted-provider.ts";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const EVIDENCE_DIR = durableDir(`cap-model-edit-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
let hub = null;
const failures = [];
const results = [];
const observations = { during: null, after: null, card: null, stateAfter: null };
function check(name, cond, detail = "") {
  results.push({ name, passed: !!cond, detail });
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${JSON.stringify(detail).slice(0, 400)}`); }
}

await Deno.mkdir(EVIDENCE_DIR, { recursive: true });

// The scripted model: find the update_asset tool, call it, then narrate. The
// asset id is only known after seeding, so the args function reads it at CALL
// time (the provider evaluates a step's args per request).
let assetId = null;
const provider = await startScriptedProvider({
  steps: [
    { tool: "search_tools", args: { query: "update_asset", limit: 1 } },
    {
      tool: "execute_tool",
      args: (req) => ({
        selectionRef: selectionRefOf(req),
        arguments: { origin: "master", id: assetId, content: "<p>after — agent edit</p>" },
      }),
    },
    { text: "The edit needs your approval." },
  ],
});

const chrome = await launchChrome({
  extension: EXT,
  profile: durableDir(`cap-model-edit-profile-${Date.now()}`),
  windowSize: "1400,1000",
  clearEnv: true,
});
const cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30000 });

try {
  const sw = await cdp.serviceWorker({ timeoutMs: 30000 }).catch(() => null);
  check("extension loaded (service worker registered)", !!sw);
  const extId = String(sw?.url ?? "").split("/")[2];

  hub = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
  const opts = await cdp.open(`chrome-extension://${extId}/options/options.html`);
  await sleep(2500);

  // The provider is Settings-owned: set it from the options document.
  const providerSet = await cdp.eval(opts.sessionId,
    `chrome.runtime.sendMessage({ type: "provider.set", config: ${JSON.stringify({ provider: "openai-compatible", baseURL: provider.baseURL, apiKey: SCRIPTED_DUMMY_KEY, model: "scripted" })} }).then(v => ({ v }), e => ({ err: String(e?.message ?? e) }))`);
  const configured = providerSet?.v?.provider ?? providerSet?.v?.config?.provider ?? null;
  check("provider set to the scripted model", configured === "openai-compatible", providerSet);

  const msg = (payload, sessionId = hub.sessionId) =>
    cdp.eval(sessionId, `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({ v }), e => ({ err: String(e?.message ?? e) }))`);

  // Seed the artifact the agent will try to edit.
  const created = await msg({ type: "asset.create", origin: "master", assetType: "html", key: "model-edit-proof", name: "model-edit-proof.html", content: "<p>before</p>" });
  assetId = created?.v?.asset?.id ?? created?.v?.id ?? null;
  check("seed: an artifact exists to edit", created?.v?.ok === true && !!assetId, created);

  // Drive a REAL turn from the hub composer (genuine CDP input).
  const sent = await cdp.eval(hub.sessionId, `(() => {
    const c = document.getElementById("composer");
    const i = c?.querySelector("[data-composer-input]");
    if (!i) return null;
    i.focus();
    return document.activeElement === i && !i.disabled;
  })()`);
  check("hub composer is drivable", sent === true);
  await cdp.send("Input.insertText", { text: "Edit model-edit-proof.html to say after" }, hub.sessionId);
  await sleep(200);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, hub.sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, hub.sessionId);

  // The agent's edit must PAUSE on a card, not land.
  let card = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    card = await cdp.eval(hub.sessionId, `(() => {
      const c = [...document.querySelectorAll("#thread-conversation approval-card, #thread-conversation permission-approval-card")];
      const pending = c.find((x) => (x.getAttribute("state") || "pending") === "pending");
      return pending ? { title: pending.getAttribute("title") || pending.getAttribute("reason") || "", tag: pending.tagName } : null;
    })()`).catch(() => null);
    if (card) break;
  }
  observations.card = card;
  check("the AGENT's artifact edit pauses on an approval card (still gated)", !!card, card);

  const during = observations.during = await msg({ type: "asset.get", origin: "master", id: assetId });
  check("the artifact is untouched while the card waits", during?.v?.ok === true && during.v.asset?.content === "<p>before</p>", during);
  const beforeShot = await cdp.screenshot(hub.sessionId);
  await Deno.writeFile(`${EVIDENCE_DIR}/before-allow.png`, beforeShot instanceof Uint8Array ? beforeShot : Uint8Array.from(atob(beforeShot), (c) => c.charCodeAt(0)));

  if (card) {
    // The owner's Allow resolves it INLINE (the surface hosts the card).
    const allowBox = `(() => { const c = [...document.querySelectorAll("#thread-conversation approval-card, #thread-conversation permission-approval-card")].find((x) => (x.getAttribute("state") || "pending") === "pending"); const b = c?.shadowRoot?.querySelector(".allow, .approve"); if (!b) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
    const box = await cdp.eval(hub.sessionId, allowBox);
    if (box) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, hub.sessionId);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, hub.sessionId);
    }
    check("the pending card exposes a native Allow target", !!box);
    let landed = false;
    for (let i = 0; i < 45 && !landed; i++) {
      await sleep(1000);
      const after = observations.after = await msg({ type: "asset.get", origin: "master", id: assetId });
      landed = after?.v?.ok === true && after.v.asset?.content === "<p>after — agent edit</p>";
    }
    const stateAfter = await cdp.eval(hub.sessionId, `(() => {
      const c = [...document.querySelectorAll("#thread-conversation approval-card, #thread-conversation permission-approval-card")];
      const last = c[c.length - 1];
      const status = document.getElementById("status");
      return {
        state: last?.getAttribute("state") ?? null,
        detail: (last?.getAttribute("detail") || last?.shadowRoot?.querySelector(".state")?.textContent || "").slice(0, 220),
        status: (status?.textContent ?? "").slice(0, 160),
      };
    })()`).catch(() => null);
    observations.stateAfter = stateAfter;
    console.log(`  after Allow: ${JSON.stringify(stateAfter)}`);
    check("the owner's Allow resolves it INLINE and the edit lands", landed);
    const afterShot = await cdp.screenshot(hub.sessionId);
    await Deno.writeFile(`${EVIDENCE_DIR}/after-allow.png`, afterShot instanceof Uint8Array ? afterShot : Uint8Array.from(atob(afterShot), (c) => c.charCodeAt(0)));
  }
  // Zero overflow alone also passes when the composer never sent a turn.
  for (let i = 0; i < 10 && provider.cursor() < 3; i++) await sleep(1000);
  check("the scripted model's script was consumed (no overflow)", provider.requests.length === 3 && provider.cursor() === 3 && provider.overflow === 0,
    { requests: provider.requests.length, cursor: provider.cursor(), overflow: provider.overflow });
} catch (err) {
  fail++;
  failures.push(`driver error: ${String(err)}`);
  console.log(`  FAIL  driver error: ${String(err)}`);
} finally {
  await provider.close().catch(() => null);
  await Deno.writeTextFile(`${EVIDENCE_DIR}/results.json`, JSON.stringify({ pass, fail, failures, results, assetId, ...observations,
    provider: { requests: provider.requests.length, cursor: provider.cursor(), overflow: provider.overflow } }, null, 2) + "\n");
  await cdp.eval(hub?.sessionId, `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "demo", apiKey: "" } }).catch(() => null)`).catch(() => null);
  try { cdp.close(); } catch { /* closing */ }
  try { chrome.proc.kill("SIGTERM"); } catch { /* gone */ }
}

console.log(`\nmodel-edit refusal journey: ${pass} passed, ${fail} failed`);
console.log(`evidence: ${EVIDENCE_DIR}`);
if (fail > 0) { console.log(`failures: ${failures.join("; ")}`); Deno.exit(1); }
