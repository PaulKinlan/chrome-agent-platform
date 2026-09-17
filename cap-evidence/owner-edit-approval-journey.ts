// cap-evidence/owner-edit-approval-journey.ts — REAL-BROWSER reproduction and
// proof for chrome-agent-platform-9mz1.
//
// The owner's report: editing an artifact through the extension's own UI raised
// "Permission request — The agent wants to asset.update: <id>. approvals are
// available only in Settings" — for his own edit, with no way to answer it in
// the surface that raised it.
//
// This drives the OWNER path exactly as the product does: an extension document
// (the NTP page) sends asset.update, which the service worker binds to
// `ui:<documentId>`. Before the fix that demand could only be resolved by the
// Settings document, so the surface that raised it was a dead end. After the
// fix the owner's own edit IS the approval.
//
//   deno run -A cap-evidence/owner-edit-approval-journey.ts
//
// Asserts:
//   1. the owner's own asset.update SUCCEEDS with no approval demanded;
//   2. the stored content really changed (the write happened, not a no-op);
//   3. no permission/approval card is left in the surface;
//   4. a second edit also succeeds (no once-per-asset accident).
import { launchChrome, openCdp } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const EVIDENCE_DIR = durableDir(`cap-owner-edit-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${JSON.stringify(detail).slice(0, 400)}`); }
}

await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
const chrome = await launchChrome({
  extension: EXT,
  profile: durableDir(`cap-owner-edit-profile-${Date.now()}`),
  windowSize: "1280,900",
  clearEnv: true,
});

// The repo's own CDP client (bounded calls, protocol errors reject).
const cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30000 });

try {
  // Boot: wait for the extension's service worker, then open the hub page — a
  // real EXTENSION DOCUMENT, which is the principal that hit the owner's bug.
  const sw = await cdp.serviceWorker({ timeoutMs: 30000 }).catch(() => null);
  check("extension loaded (service worker registered)", !!sw);
  const extId = String(sw?.url ?? "").split("/")[2];
  const page = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
  const sid = page.sessionId;
  await sleep(2500);

  const evl = (expr) => cdp.eval(sid, expr);
  const msg = (payload) => evl(`chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({ v }), e => ({ err: String(e && e.message || e) }))`);

  // 1. Seed an artifact to edit.
  const created = await msg({ type: "asset.create", origin: "master", assetType: "html", key: "owner-edit-proof", name: "owner-edit-proof.html", content: "<p>v1</p>" });
  const assetId = created?.v?.asset?.id ?? created?.v?.id ?? null;
  check("seed: an artifact exists to edit", created?.v?.ok === true && !!assetId, created);

  // 2. THE OWNER'S OWN EDIT — the reported flow.
  const edited = await msg({ type: "asset.update", origin: "master", id: assetId, content: "<p>v2 owner edit</p>" });
  check("owner's own artifact edit SUCCEEDS with no approval demanded", edited?.v?.ok === true, edited);
  check(
    "the result is not an approval demand",
    edited?.v?.waitingForPermission !== true && !/only in Settings/i.test(String(edited?.v?.error ?? "")),
    edited,
  );

  // 3. The write really happened (not a silent no-op).
  const read = await msg({ type: "asset.get", origin: "master", id: assetId });
  const content = read?.v?.asset?.content ?? "";
  check("the stored content really changed", content.includes("v2 owner edit"), { content: String(content).slice(0, 120) });

  // 4. A SECOND edit also succeeds (no once-per-asset accident).
  const again = await msg({ type: "asset.update", origin: "master", id: assetId, content: "<p>v3 second edit</p>" });
  check("a second owner edit also succeeds", again?.v?.ok === true, again);

  // 5. Nothing left waiting in the surface.
  const cards = await evl(`document.querySelectorAll('permission-approval-card, approval-card').length`);
  check("no approval card is left in the surface", cards === 0, { cards });
  const shot = await cdp.screenshot(sid).catch(() => null);
  if (shot) await Deno.writeFile(`${EVIDENCE_DIR}/owner-edit.png`, shot instanceof Uint8Array ? shot : Uint8Array.from(atob(shot), (c) => c.charCodeAt(0)));

  const errs = [];
  cdp.on("Runtime.exceptionThrown", (params, sessionId) => {
    if (sessionId === sid) errs.push(String(params?.exceptionDetails?.exception?.description ?? "?").slice(0, 200));
  });
  await sleep(300);
  check("no uncaught page errors", errs.length === 0, errs);

  await Deno.writeFile(`${EVIDENCE_DIR}/journey.json`, new TextEncoder().encode(JSON.stringify({
    at: new Date().toISOString(), extensionId: extId, pass, fail, failures,
  }, null, 2)));
} catch (err) {
  fail++;
  failures.push(`driver error: ${String(err)}`);
  console.log(`  FAIL  driver error: ${String(err)}`);
} finally {
  try { cdp.close(); } catch { /* closing */ }
  try { chrome.proc.kill("SIGTERM"); } catch { /* gone */ }
}

console.log(`\nowner-edit approval journey: ${pass} passed, ${fail} failed`);
console.log(`evidence: ${EVIDENCE_DIR}`);
if (fail > 0) { console.log(`failures: ${failures.join("; ")}`); Deno.exit(1); }
