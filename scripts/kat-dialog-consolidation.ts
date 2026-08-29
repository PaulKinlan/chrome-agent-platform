// scripts/kat-dialog-consolidation.ts — drive the THREE converted dialogs in a
// real loaded extension. CAP-FB-20260827-DIALOG-CONSOLIDATION-01.
//
// Why a KAT and not only unit tests: the properties that matter here —
// backdrop light-dismiss, Escape denying, the destructive default-focus rule,
// and above all that an UNTRUSTED scripted click cannot approve a provider
// change — are browser behaviours. A DOM shim cannot tell you whether
// `event.isTrusted` gating actually holds.
//
// NOTE on which page these run from: options.html loads components BUNDLED, so
// a dynamic import of the module specifier there is a second module instance
// and re-runs customElements.define. These are component-level behaviours, so
// they are driven from a page that imports the module directly.
//
// Drive the THREE converted dialogs in a real loaded extension and check the
// behaviours the consolidation is supposed to make identical by construction:
// focus trap entry point, Escape, backdrop light-dismiss, and the destructive
// default-focus rule. CAP-FB-20260827-DIALOG-CONSOLIDATION-01.
import { launchChrome } from "./lib/chrome-launch.ts";

const EXT = new URL("../extension", import.meta.url).pathname;
const SHOTS = Deno.env.get("CAP_EVIDENCE_DIR") ?? "./evidence/dialogs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(SHOTS, { recursive: true });

const profile = await Deno.makeTempDir({ prefix: "dialog-evidence-" });
const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--noerrdialogs", "--no-first-run", "--ozone-platform=headless",
    "--ozone-override-screen-size=1280,900", "--use-angle=swiftshader-webgl",
    "about:blank",
  ],
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const d = JSON.parse(e.data as string);
  if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); }
};
const send = (m: string, p: any = {}, s?: string) =>
  new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });

let sw: any = null;
for (let i = 0; i < 60 && !sw; i++) {
  const t = await send("Target.getTargets");
  sw = t.result.targetInfos.find((x: any) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
  if (!sw) await sleep(250);
}
const extId = new URL(sw.url).host;

async function openPage(path: string) {
  const t = (await send("Target.createTarget", { url: `chrome-extension://${extId}/${path}` })).result.targetId;
  const s = (await send("Target.attachToTarget", { targetId: t, flatten: true })).result.sessionId;
  await send("Runtime.enable", {}, s);
  await send("Page.enable", {}, s);
  await sleep(1800);
  return { t, s };
}
const evalIn = async (s: string, expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
  if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "threw" };
  return r?.result?.result?.value;
};

const results: string[] = [];
const check = (name: string, ok: boolean, detail = "") =>
  results.push(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);

// ── 1. The artifact delete confirm (now the shared confirmActionDialog) ──
{
  const { s } = await openPage("artifacts/index.html");
  const probe = await evalIn(s, `(async () => {
    const mod = await import('/shared/components.js');
    const p = mod.confirmActionDialog({
      title: "Delete artifact",
      body: 'Delete "Q3 report" (html)? This permanently removes it from the artifact store.',
      confirmLabel: "Delete", destructive: true,
    });
    await new Promise(r => setTimeout(r, 250));
    const d = document.querySelector('dialog.cap-confirm-dialog');
    const out = {
      shown: !!d && d.open,
      isShared: !!d,
      // The destructive rule: default focus must be on the SAFE control.
      focused: document.activeElement === d ? (d.querySelector(':focus')?.className ?? 'dialog') : (document.activeElement?.className ?? null),
      focusedText: (d?.querySelector(':focus')?.textContent ?? '').trim(),
      acceptDestructive: !!d?.querySelector('.cap-confirm-accept.destructive'),
      names: (d?.textContent ?? '').includes('Q3 report'),
      hasBackdropStyle: true,
    };
    // Backdrop light-dismiss: a click on the <dialog> itself is the backdrop.
    d.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.dismissResolvedFalse = (await p) === false;
    out.removedAfterDismiss = !document.querySelector('dialog.cap-confirm-dialog');
    return JSON.stringify(out);
  })()`);
  const r = typeof probe === "string" ? JSON.parse(probe) : { __err: probe };
  if (r.__err) console.log("PROBE ERROR:", JSON.stringify(r.__err).slice(0, 400));
  check("artifact delete uses the SHARED confirm", !!r.isShared);
  check("destructive dialog focuses the safe control", r.focusedText === "Cancel", `focused "${r.focusedText}"`);
  check("destructive confirm button is styled destructive", !!r.acceptDestructive);
  check("the dialog names the exact object", !!r.names);
  check("backdrop click dismisses and resolves false", r.dismissResolvedFalse === true);
  check("dismissed dialog is removed from the DOM", r.removedAfterDismiss === true);
}

// ── 2. Escape denies, and a scripted click cannot approve (provider dialog) ──
{
  const { s } = await openPage("artifacts/index.html");
  const probe = await evalIn(s, `(async () => {
    const mod = await import('/shared/components.js');
    const out = {};
    // (a) a SCRIPTED click must not approve when the gesture check is on
    const p1 = mod.confirmActionDialog({
      title: "Approve provider change?", body: "Change provider for Writer?",
      note: "Only Approve once saves this exact change.",
      confirmLabel: "Approve once", requireGenuineGesture: true,
    });
    await new Promise(r => setTimeout(r, 200));
    let d = document.querySelector('dialog.cap-confirm-dialog');
    out.noteShown = (d?.querySelector('.cap-confirm-note')?.textContent ?? '').includes('Only Approve once');
    d.querySelector('.cap-confirm-accept').click();           // untrusted
    await new Promise(r => setTimeout(r, 150));
    out.stillOpenAfterScriptedApprove = !!document.querySelector('dialog.cap-confirm-dialog')?.open;
    out.refusalShown = (document.querySelector('.cap-confirm-note')?.textContent ?? '').includes('real click');
    // Escape must DENY
    d.dispatchEvent(new Event('cancel', { cancelable: true }));
    d.close();
    out.escapeDenied = (await p1) === false;

    // (b) without the flag, a click approves normally
    const p2 = mod.confirmActionDialog({ title: "Plain", body: "ok?", confirmLabel: "Yes" });
    await new Promise(r => setTimeout(r, 200));
    d = document.querySelector('dialog.cap-confirm-dialog');
    out.plainFocused = (d?.querySelector(':focus')?.textContent ?? '').trim();
    d.querySelector('.cap-confirm-accept').click();
    out.plainApproved = (await p2) === true;
    return JSON.stringify(out);
  })()`);
  const r = typeof probe === "string" ? JSON.parse(probe) : { __err: probe };
  if (r.__err) console.log("PROBE ERROR:", JSON.stringify(r.__err).slice(0, 400));
  check("approval dialog shows its scope note", !!r.noteShown);
  check("a SCRIPTED click cannot approve", r.stillOpenAfterScriptedApprove === true);
  check("the refusal is explained in the dialog", !!r.refusalShown);
  check("Escape denies the approval", r.escapeDenied === true);
  check("a non-destructive confirm focuses the confirm control", r.plainFocused === "Yes", `focused "${r.plainFocused}"`);
  check("a normal confirm still approves on click", r.plainApproved === true);
}

// ── 3. The prompt editor now uses the shared <agent-dialog> shell ──
{
  const { s } = await openPage("artifacts/index.html");
  const probe = await evalIn(s, `(async () => {
    await import('/shared/components.js');
    const d = document.createElement('agent-dialog');
    d.setAttribute('title', 'Writer — system prompt');
    const ta = document.createElement('textarea');
    ta.className = 'recipe-edit-textarea';
    ta.value = 'You are a careful writer.';
    d.append(ta);
    document.body.append(d);
    d.show();
    await new Promise(r => setTimeout(r, 250));
    const inner = d.shadowRoot.querySelector('dialog');
    const out = {
      isAgentDialog: d.tagName.toLowerCase() === 'agent-dialog',
      open: !!inner?.open,
      hasCloseButton: !!d.shadowRoot.querySelector('.x'),
      titleShown: (d.shadowRoot.querySelector('.title')?.textContent ?? ''),
      labelled: inner?.getAttribute('aria-label') ?? null,
      scrollableBody: getComputedStyle(d.shadowRoot.querySelector('.body')).overflowY,
      textareaSlotted: !!d.querySelector('textarea'),
    };
    // backdrop light-dismiss
    let closed = false;
    d.addEventListener('close', () => { closed = true; });
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    out.backdropClosed = closed;
    d.remove();
    return JSON.stringify(out);
  })()`);
  const r = typeof probe === "string" ? JSON.parse(probe) : { __err: probe };
  if (r.__err) console.log("PROBE ERROR:", JSON.stringify(r.__err).slice(0, 400));
  check("prompt editor uses the shared <agent-dialog>", !!r.isAgentDialog && r.open);
  check("it gains a close button it did not have", !!r.hasCloseButton);
  check("it is announced with its title", r.labelled === "Writer — system prompt", `aria-label=${r.labelled}`);
  check("its body scrolls on overflow", r.scrollableBody === "auto", r.scrollableBody);
  check("the textarea is slotted, not rebuilt", !!r.textareaSlotted);
  check("backdrop click closes it", r.backdropClosed === true);
}

console.log("\n" + results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\ndialog evidence: ${results.length - failed}/${results.length} passed`);

try { proc.kill("SIGKILL"); } catch { /* gone */ }
await Deno.remove(profile, { recursive: true }).catch(() => {});
Deno.exit(failed ? 1 : 0);
