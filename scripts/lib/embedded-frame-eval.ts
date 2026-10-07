// CDP's frameId survives a same-frame navigation; its Runtime execution-context
// id DOES NOT. Track only live default contexts on the page's own CDP session,
// verify the target document inside that context, and retry only a CDP rejection
// proving the requested context did not exist BEFORE evaluation began.
// The owner Settings principal comes from this REAL embedded document; never
// substitute a parent-frame RPC or a synthetic sender.
export interface EmbeddedCdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  on(method: string, handler: (params: any, sessionId?: string) => void): () => void;
}

const STALE_CONTEXT = /^Runtime\.evaluate: Cannot find context with specified id(?:\s|$)/;

export function isMissingCdpContext(error: unknown): boolean {
  return STALE_CONTEXT.test(String(error instanceof Error ? error.message : error));
}

export function trackEmbeddedFrameContexts(cdp: EmbeddedCdp, sessionId: string) {
  const contexts = new Map<string, number[]>();
  const waiters = new Set<() => void>();
  const wake = () => { for (const notify of waiters) notify(); };
  const stopCreated = cdp.on("Runtime.executionContextCreated", (event, session) => {
    const frameId = event?.context?.auxData?.frameId;
    const contextId = event?.context?.id;
    if (session !== sessionId || event?.context?.auxData?.isDefault !== true ||
        typeof frameId !== "string" || !Number.isInteger(contextId)) return;
    const entries = contexts.get(frameId) ?? [];
    contexts.set(frameId, [...entries.filter((id) => id !== contextId), contextId]);
    wake();
  });
  const stopDestroyed = cdp.on("Runtime.executionContextDestroyed", (event, session) => {
    if (session !== sessionId || !Number.isInteger(event?.executionContextId)) return;
    for (const [frame, entries] of contexts) {
      contexts.set(frame, entries.filter((id) => id !== event.executionContextId));
    }
    wake();
  });
  const stopCleared = cdp.on("Runtime.executionContextsCleared", (_event, session) => {
    if (session !== sessionId) return;
    contexts.clear();
    wake();
  });
  const discard = (id: number) => {
    for (const [frame, entries] of contexts) contexts.set(frame, entries.filter((entry) => entry !== id));
    wake();
  };
  const nextChange = (ms: number): Promise<void> => new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); waiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, Math.min(ms, 120));
    waiters.add(finish);
  });
  const close = () => { stopCreated(); stopDestroyed(); stopCleared(); waiters.clear(); contexts.clear(); };

  async function evaluate(options: {
    extensionId: string;
    path: string;
    expression: string;
    timeoutMs?: number;
  }): Promise<{ result: any; frameId: string; staleRetries: number }> {
    const { extensionId, path, expression, timeoutMs = 12_000 } = options;
    if (!extensionId || !path.startsWith("/") || timeoutMs <= 0) throw new Error("embedded frame target must be explicit");
    const expectedUrl = `chrome-extension://${extensionId}${path}`;
    const deadline = Date.now() + timeoutMs;
    let staleRetries = 0;
    let lastFrameId: string | null = null;
    while (Date.now() < deadline) {
      const tree = (await cdp.send("Page.getFrameTree", {}, sessionId))?.result?.frameTree;
      const frame = tree?.childFrames?.find((child: any) => child?.frame?.url === expectedUrl)?.frame;
      if (!frame?.id) { await nextChange(deadline - Date.now()); continue; }
      lastFrameId = frame.id;
      const candidates = contexts.get(frame.id);
      const contextId = candidates?.at(-1);
      if (typeof contextId !== "number" || !Number.isInteger(contextId)) {
        await nextChange(deadline - Date.now());
        continue;
      }
      // The event may be for an about:blank realm replaced while the pooled
      // iframe navigates. Inspect THIS context's document before any mutation.
      let ready: any;
      try {
        ready = await cdp.send("Runtime.evaluate", {
          expression: "({url:document.URL,ready:document.readyState})", contextId,
          returnByValue: true, awaitPromise: true,
        }, sessionId);
      } catch (error) {
        if (!isMissingCdpContext(error)) throw error;
        discard(contextId);
        staleRetries++;
        await nextChange(deadline - Date.now());
        continue;
      }
      if (ready?.result?.exceptionDetails) throw new Error("embedded Settings readiness evaluation threw");
      const state = ready?.result?.result?.value;
      if (state?.url !== expectedUrl || (state.ready !== "interactive" && state.ready !== "complete")) {
        await nextChange(deadline - Date.now());
        continue;
      }
      try {
        const result = await cdp.send("Runtime.evaluate", {
          expression, contextId, returnByValue: true, awaitPromise: true,
        }, sessionId);
        if (result?.result?.exceptionDetails) throw new Error("embedded Settings owner operation threw");
        return { result, frameId: frame.id, staleRetries };
      } catch (error) {
        // Only "Cannot find context" proves the mutation did NOT start.
        // Do NOT retry "execution context destroyed" or generic timeouts:
        // they could have occurred after the owner operation was dispatched.
        if (!isMissingCdpContext(error)) throw error;
        discard(contextId);
        staleRetries++;
        await nextChange(deadline - Date.now());
      }
    }
    throw new Error(`embedded Settings live context was unavailable before ${timeoutMs}ms (frame=${lastFrameId ? "seen" : "absent"}, staleRetries=${staleRetries})`);
  }
  return { evaluate, close };
}
