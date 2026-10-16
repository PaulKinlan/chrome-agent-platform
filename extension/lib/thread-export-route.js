// The single-thread / single-artifact export boundary. Only the service worker
// supplies the credential readers; the caller supplies an id, never HTML or a
// vault access token. Nothing containing a raw secret crosses the response.
import { renderThreadToHtml } from "./thread-export-html.js";
import { collectProfileSecrets, redactExportValue, redactExportText } from "./thread-export-redact.js";

const EXPORT_MIME = "text/html";
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const OWNER_PAGES = new Set(["/ntp/ntp.html", "/artifact/artifact.html", "/artifacts/index.html"]);

export function exportSenderAllowed(context, extensionId, kind) {
  const sender = context?.sender;
  if (context?.principal !== "extension" || sender?.id !== extensionId || typeof sender.url !== "string") return false;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== "chrome-extension:" || url.host !== extensionId || !OWNER_PAGES.has(url.pathname)) return false;
    return kind !== "thread" || url.pathname === "/ntp/ntp.html";
  } catch {
    return false;
  }
}

export function exportHtmlFilename(title, kind = "thread") {
  const base = String(title ?? "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/^[ .-]+|[ .-]+$/g, "")
    .slice(0, 80)
    .replace(/[ .-]+$/g, "") || kind;
  const stem = base.replace(/\.html?$/i, "").replace(/[ .-]+$/g, "") || kind;
  return `${stem}.html`;
}

// Slice-1 exactValueRedact deliberately ignores literals shorter than four
// characters. Refuse exports containing an active credential too short for
// that guarantee rather than allowing it through as ordinary prose.
function hasShortConfiguredSecret(value, key = "", seen = new WeakSet()) {
  if (typeof value === "string") {
    return /(api[_-]?key|token|secret|password|pwd|passphrase|authorization|auth|bearer|cookie|session|sig|signature)/i.test(key) &&
      value.trim().length > 0 && value.trim().length < 4;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([name, nested]) => hasShortConfiguredSecret(nested, Array.isArray(value) ? key : name, seen));
}

function idAllowed(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);
}

function residualSecret(html, secrets) {
  const lower = html.toLowerCase();
  return secrets.some((secret) => {
    if (typeof secret !== "string" || secret.length < 4) return false;
    const variants = new Set([secret, secret.normalize("NFKC")]);
    try { variants.add(encodeURIComponent(secret)); } catch { /* not encodable */ }
    try { variants.add(JSON.stringify(secret).slice(1, -1)); } catch { /* not serializable */ }
    return [...variants].some((variant) => variant.length >= 4 && lower.includes(variant.toLowerCase()));
  });
}

/** Injected dependencies keep privileged raw reads in the SW composition root. */
export function createThreadExportRoute({ extensionId, getThreadView, getArtifact, getProviderConfig, getCredentialStores, listVaultKeys, readVaultSecret, render = renderThreadToHtml }) {
  return async function exportHtml(request = {}, context) {
    const kind = request?.kind;
    if ((kind !== "thread" && kind !== "artifact") || !exportSenderAllowed(context, extensionId, kind)) {
      return { ok: false, error: "export_not_authorized" };
    }
    if (!idAllowed(request.id) || (kind === "artifact" && !idAllowed(request.origin ?? "master"))) {
      return { ok: false, error: "export_invalid_target" };
    }

    try {
      // Never accept caller-supplied content, secrets, HMACs, or access tokens.
      const data = kind === "thread"
        ? await getThreadView(request.id)
        : await getArtifact(request.origin ?? "master", request.id);
      if (!data?.ok || (kind === "thread" ? !data.thread : !data.asset)) {
        return { ok: false, error: "export_not_found" };
      }
      const providerConfig = await getProviderConfig();
      const stores = await getCredentialStores();
      if (hasShortConfiguredSecret(providerConfig) || hasShortConfiguredSecret(stores)) {
        throw new Error("configured credential too short for exact redaction");
      }
      const vaultKeys = await listVaultKeys();
      if (!Array.isArray(vaultKeys)) throw new Error("vault inventory unavailable");
      const vaultSecrets = [];
      for (const keyId of vaultKeys) {
        // readVaultSecret is a SW-only closure with the SW-minted access token.
        const value = await readVaultSecret(keyId);
        if (typeof value !== "string" || value.trim().length < 4) throw new Error("vault value unavailable for exact redaction");
        vaultSecrets.push(value);
      }
      const knownSecrets = collectProfileSecrets({
        providerConfig,
        mcpServers: [stores?.globalMcpServers, stores?.namedAgents],
        vaultSecrets,
      });
      const record = kind === "thread" ? data.thread : data.asset;
      if (kind === "thread" && (record.hasMore || record.viewDegraded || record.repairFailed || record.truncatedLogs)) {
        throw new Error("thread projection incomplete");
      }
      const artifacts = kind === "artifact" ? [record] : [];
      if (kind === "thread") {
        const refs = [
          ...(Array.isArray(record.artifacts) ? record.artifacts : []),
          ...(Array.isArray(record.messages) ? record.messages
            .filter((row) => row?.role === "artifact" && row.artifact)
            .map((row) => row.artifact) : []),
        ];
        if (refs.length > 100) throw new Error("too many artifacts for one export");
        const seen = new Set();
        for (const ref of refs) {
          if (!ref || typeof ref !== "object") continue;
          if (idAllowed(ref.id)) {
            const origin = ref.origin ?? "master";
            if (!idAllowed(origin)) throw new Error("invalid artifact origin");
            const key = `${origin}\u0000${ref.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const found = await getArtifact(origin, ref.id);
            if (!found?.ok || !found.asset || typeof found.asset.content !== "string") {
              throw new Error("referenced artifact body unavailable");
            }
            artifacts.push(found.asset);
          } else if (typeof ref.content === "string") {
            artifacts.push(ref); // historical inline artifact, already in the authoritative thread
          } else {
            throw new Error("referenced artifact has no body");
          }
        }
      }
      // REDACT DATA, not generated markup. The pure renderer has a second
      // redaction pass, but must never be the first time a secret is removed.
      const sanitized = redactExportValue(record, { knownSecrets });
      const safeArtifacts = redactExportValue(artifacts, { knownSecrets });
      if (JSON.stringify({ sanitized, safeArtifacts }).includes('"[depth-exceeded]"')) {
        throw new Error("nested export data incomplete");
      }
      const title = redactExportText(kind === "thread"
        ? record.name ?? record.title ?? "Task"
        : record.name ?? record.title ?? "Artifact", { knownSecrets });
      const view = kind === "thread"
        ? { ...sanitized, messages: sanitized.messages?.filter((row) => row?.role !== "artifact" && row?.role !== "images") }
        : { messages: [] };
      const html = render(view, { title, knownSecrets, artifacts: safeArtifacts });
      // If a future renderer interpolates an unredacted field, refuse the
      // export completely. No partial file and no secret-bearing error text.
      if (residualSecret(html, knownSecrets) || /<script\b/i.test(html) ||
          new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
        return { ok: false, error: "export_redaction_incomplete" };
      }
      return { ok: true, html, filename: exportHtmlFilename(title, kind), mimeType: EXPORT_MIME };
    } catch {
      return { ok: false, error: "export_unavailable" };
    }
  };
}
