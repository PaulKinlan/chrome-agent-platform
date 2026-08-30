// scripts/screenshot-vision-evidence.ts — CAP-FB-20260830-SCREENSHOT-TO-MODEL-01.
//
// "Take a screenshot and tell me what you see" is the acceptance sentence, and
// the only way to know it works is to ask a real vision model and read what it
// says back. This drives the WHOLE seam against the live API:
//
//   a real Chrome captures example.com  →  the capture tool's real return shape
//   →  the lazy protocol's projection + attachment side channel
//   →  createLazyProviderToolset's toModelOutput
//   →  @ai-sdk/google's native transport
//   →  gemini-3.7-flash
//
// It runs BOTH lanes on purpose. `acceptsImageToolResults: true` is the fix;
// `false` is the control that reproduces the reported defect (the model gets
// the JSON envelope alone and cannot describe the page). A pass requires the
// vision lane to name the page's actual heading and the control lane not to.
//
// Usage:  GEMINI_API_KEY=… deno run -A scripts/screenshot-vision-evidence.ts
// The key is read from the environment and never printed, logged or stored.
//
// Port discipline: Chrome is launched through launchChrome(), which asks the
// kernel for a port and reads the endpoint back from that child's own stderr.

import { generateText, stepCountIs } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createLazyProviderToolset, executableBrowserToolRecords } from "../extension/lib/lazy-tool-protocol.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { tool } from "ai";
import { z } from "zod";
import { launchChrome } from "./lib/chrome-launch.ts";

const CHROMIUM = Deno.env.get("CAP_CHROMIUM") ?? "/usr/bin/chromium";
const TARGET = Deno.env.get("CAP_VISION_URL") ?? "https://example.com/";
const MODEL_ID = Deno.env.get("CAP_VISION_MODEL") ?? "gemini-3.7-flash";
const EXPECT = Deno.env.get("CAP_VISION_EXPECT") ?? "Example Domain";
const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
if (!KEY) {
  console.error("GEMINI_API_KEY is required (read from the environment, never printed).");
  Deno.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Capture a real PNG of `TARGET` in a real browser. */
async function capturePng(): Promise<{ dataURL: string; width: number; height: number; pixelPhrase: string }> {
  const profile = await Deno.makeTempDir({ prefix: "vision-evidence-" });
  const chrome = await launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank",
    ],
  });
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data as string);
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); }
  };
  const send = (method: string, params: any = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  try {
    const { result: target } = await send("Target.createTarget", { url: TARGET });
    const { result: attached } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const session = attached.sessionId;
    await send("Page.enable", {}, session);
    await sleep(4000);
    const shot = await send("Page.captureScreenshot", { format: "png" }, session);
    const base64 = shot?.result?.data ?? "";
    if (!base64) throw new Error("Chrome returned no screenshot data");
    // The page's own body text, read from the live page. The longest sentence
    // in it is the PIXEL-ONLY evidence: a model that can genuinely see the
    // screenshot reproduces it, and a model reasoning from the URL alone (the
    // control lane, and the behaviour this entry fixes) cannot.
    const text = await send(
      "Runtime.evaluate",
      { expression: "document.body.innerText", returnByValue: true },
      session,
    );
    const sentences = String(text?.result?.result?.value ?? "")
      .split(/[.\n]/).map((s: string) => s.trim()).filter((s: string) => s.length >= 30);
    sentences.sort((a: string, b: string) => b.length - a.length);
    return {
      dataURL: `data:image/png;base64,${base64}`,
      width: 1280,
      height: 800,
      pixelPhrase: sentences[0] ?? "",
    };
  } finally {
    try { ws.close(); } catch { /* closed */ }
    try { chrome.proc.kill("SIGKILL"); } catch { /* gone */ }
    try { await chrome.proc.status; } catch { /* reaped */ }
    try { await Deno.remove(profile, { recursive: true }); } catch { /* gone */ }
  }
}

/** The capture tool's REAL post-fix return shape, wired through the REAL
 * protocol — nothing about the seam under test is stubbed. */
function toolsetFor(shot: { dataURL: string; width: number; height: number }, acceptsImages: boolean) {
  const captureTools = {
    capture_screenshot: tool({
      description: "Capture a PNG screenshot of the current browser tab.",
      inputSchema: z.object({ tabId: z.number().int().optional() }),
      execute: () => ({
        ok: true,
        screenshotId: "shot_evidence_1",
        url: TARGET,
        width: shot.width,
        height: shot.height,
        bytes: Math.floor(shot.dataURL.length * 3 / 4),
        screenshot: shot.dataURL,
      }),
    }),
  };
  let refs = 0;
  return createLazyProviderToolset({
    readSources: () =>
      executableBrowserToolRecords(captureTools, {
        version: "runtime-v1",
        sourceGeneration: "vision-evidence:1",
        scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
        capabilities: ["browser.capture"],
      }),
    contextReader: () => ({
      runId: "vision-evidence",
      taskId: "vision-evidence",
      runGeneration: "1",
      agentId: "hub",
      origin: "",
      documentId: "hub-doc",
    }),
    selectionAuthority: new ToolSelectionAuthority({
      newRef: () => `sel_${(++refs).toString(16).padStart(36, "0")}`,
    }),
    acceptsImageToolResults: acceptsImages,
  });
}

async function ask(shot: Awaited<ReturnType<typeof capturePng>>, acceptsImages: boolean) {
  const google = createGoogleGenerativeAI({ apiKey: KEY });
  const lazy = toolsetFor(shot, acceptsImages);
  const out = await generateText({
    model: google(MODEL_ID),
    tools: lazy.tools,
    stopWhen: stepCountIs(6),
    system:
      "You control a browser through a tool protocol. First call search_tools to find a tool, " +
      "then call execute_tool with the exact selectionRef it returned. Answer from what you actually " +
      "observe. If you cannot see an image, say so plainly instead of guessing.",
    prompt:
      "Take a screenshot of the current tab and tell me what you see. Quote the page's main heading exactly.",
  });
  return out.text.trim();
}

/** Does the answer reproduce the page's own words? Order-independent word
 * containment, so a model that paraphrases around the sentence still counts
 * and a model that never saw the pixels still cannot. */
function reproduces(answer: string, phrase: string) {
  const words = phrase.toLowerCase().split(/\W+/).filter((w) => w.length > 3).slice(0, 8);
  if (words.length < 3) return false;
  const haystack = answer.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

const shot = await capturePng();
console.log(`captured ${TARGET}: ${shot.width}x${shot.height}, ${Math.floor(shot.dataURL.length * 3 / 4)} PNG bytes`);
console.log(`pixel-only phrase on the page: "${shot.pixelPhrase}"`);

const withImage = await ask(shot, true);
console.log(`\n--- gemini ${MODEL_ID}, image tool result ENABLED (the fix) ---\n${withImage}\n`);
const withoutImage = await ask(shot, false);
console.log(`--- gemini ${MODEL_ID}, image tool result DISABLED (the control: today's behaviour) ---\n${withoutImage}\n`);

// The heading proves the acceptance sentence; the body phrase proves the model
// read PIXELS rather than reasoning from the URL it was handed.
const namesHeading = withImage.includes(EXPECT);
const sees = reproduces(withImage, shot.pixelPhrase);
const blind = !reproduces(withoutImage, shot.pixelPhrase);
console.log(`vision lane names "${EXPECT}": ${namesHeading}`);
console.log(`vision lane reproduces the on-page text: ${sees}`);
console.log(`control lane cannot reproduce it: ${blind}`);
const pass = namesHeading && sees && blind;
console.log(pass ? "PASS" : "FAIL");
Deno.exit(pass ? 0 : 1);
