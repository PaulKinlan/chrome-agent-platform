// The Chrome journey must send its first SW wake from the unpacked extension's
// NTP page, not an error document under a component extension's ID. Never log
// an observed URL: a redirected page could carry private data in its query.
export function assertJourneyNtpPrincipal(observation: unknown, extensionId: string): void {
  const record = observation && typeof observation === "object"
    ? observation as Record<string, unknown>
    : {};
  let page: URL | null = null;
  if (typeof record.href === "string") {
    try { page = new URL(record.href); } catch { /* no valid page principal */ }
  }
  const extensionPage = page?.protocol === "chrome-extension:" &&
    page.host === extensionId && page.pathname === "/ntp/ntp.html";
  const canSend = record.sendMessageType === "function";
  if (!extensionPage || !canSend) {
    throw new Error(
      `journey NTP principal unavailable before worker restart: ` +
        `expectedExtensionPage=${extensionPage} runtimeSendMessage=${canSend}`,
    );
  }
}
