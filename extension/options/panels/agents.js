// extension/options/panels/agents.js — Agents & Site Agents panel module (chrome-agent-platform-8v5l.1).

import { formatCadenceMinutes } from "../../lib/next-run-label.js";
import { ensureAcpNativePermission } from "../../lib/acp-native.js";
import { projectUnifiedAgents } from "../../lib/agent-projection.js";
import { skillAsTemplate } from "../../lib/agent-templates.js";
import {
  agentScheduleMarker,
  backgroundAgentsForDisplay,
} from "../../shared/agent-display.js";
import {
  providerSelectionPresentation,
  renderInternalProviderStatus,
} from "../../lib/provider-visibility.js";
import { runOwnerApprovedMutation } from "../../lib/owner-approved-mutation.js";
import {
  SITE_AGENT_COPY,
  enrollOutcomeState,
  siteAgentSetupMessage,
} from "../../shared/site-agent-copy.js";
import { confirmActionDialog, deleteAgentDialog, escapeHtml } from "../../shared/components-core.js";
import { createPanelContext, escapeAttr, withUnmount, bindPanelCtx } from "../panel-context.js";
import { PROVIDERS, providerCatalogue, blockSessionOnlyCredentialSave } from "./providers.js";

const rootState = new WeakMap();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("agents");

function getState(ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const key = panelCtx.root ?? panelCtx;
  let st = rootState.get(key);
  if (!st) {
    st = {
      enrollWired: false,
      multiAgentWired: false,
      acpWired: false,
      siteToolConsentWired: false,
      siteToolConsentRequestSeq: 0,
      siteToolConsentView: {
        loading: true,
        error: "",
        status: "Loading site tool permissions…",
        sites: [],
        audit: null,
        cursor: null,
        busyKey: "",
        toolErrors: {},
      },
      webmcpDiagWired: false,
      agentsHeavyListsHydrated: false,
    };
    rootState.set(key, st);
    panelCtx.registerCleanup(() => {
      rootState.delete(key);
    });
  }
  return st;
}

function notifySiteDataChanged() {
  const c = ensureCtx();
  try { c.callbacks?.onEnrolledSitesChanged?.(); } catch { /* ignore */ }
  try { c.callbacks?.onSiteDataChanged?.(); } catch { /* ignore */ }
}

async function renderEnroll(ctx) {
  const st = getState(ctx);
  const input = $("#enroll-origin");
  const btn = $("#enroll-btn");
  if (!btn || st.enrollWired) return;
  st.enrollWired = true;
  btn.addEventListener("click", async () => {
    const raw = input.value.trim();
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch {
      saveFlash("Enter a valid origin, e.g. https://github.com");
      return;
    }
    if (!/^https?:$/.test(new URL(origin).protocol)) {
      saveFlash("Only http/https origins can be enrolled.");
      return;
    }
    const matches = [`${origin}/*`];
    // OPTIONAL + JIT model: the enroll click IS the user gesture — request
    // the scripting permission + the site's origin here.
    let granted;
    try {
      granted = (await chrome.permissions.request({
        permissions: ["scripting"],
        origins: matches,
      })) === true;
    } catch {
      saveFlash(siteAgentSetupMessage("permission-error", origin));
      return;
    }
    if (!granted) {
      saveFlash(siteAgentSetupMessage("permission-denied", origin));
      return;
    }
    const res = await send({
      type: "agent.enroll-origin",
      origin,
      ownerGesture: true,
    }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    input.value = "";
    const state = enrollOutcomeState(res);
    // The SW owns the persisted lifecycle record (cap:webmcpStatus — bounded +
    // redacted registration/injection errors, survive reopen); the flash is the
    // transient confirmation + the diagnostics section renders the SW record.
    saveFlash(state === "failed"
      ? siteAgentSetupMessage("failed-now", origin)
      : siteAgentSetupMessage(state, origin));
    notifySiteDataChanged();
    renderEnrolledSites();
    renderSiteToolConsents({ cursor: null });
    renderWebmcpStatus();
  });
}

// ── Discovered open tabs (proactive one-click enrollment without typing) ──
async function renderDiscoveredOpenTabs(ctx) {
  const container = $("#discovered-tabs");
  if (!container) return;
  const enrolledOrigins = new Set(await boundedSend("agent.list").catch(() => []));
  const listing = await boundedSend("agent.discoverable-tabs", { toolsOnly: true }).catch(() => ({ ok: false }));
  container.replaceChildren();
  if (!listing?.ok || !Array.isArray(listing.tabs) || !listing.tabs.length) {
    container.style.display = "none";
    return;
  }
  const unenrolled = listing.tabs.filter((t) => !enrolledOrigins.has(t.origin));
  if (!unenrolled.length) {
    container.style.display = "none";
    return;
  }
  container.style.display = "block";
  const header = document.createElement("div");
  header.className = "muted small";
  header.style.marginBottom = "8px";
  header.style.fontWeight = "600";
  header.textContent = "Discovered open pages — click to add as Site Agent:";
  container.appendChild(header);

  for (const t of unenrolled.slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "origin-row";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.marginBottom = "6px";

    const info = document.createElement("div");
    info.style.overflow = "hidden";
    info.style.textOverflow = "ellipsis";
    info.style.whiteSpace = "nowrap";
    info.style.marginRight = "8px";

    const titleSpan = document.createElement("span");
    titleSpan.style.fontWeight = "600";
    titleSpan.textContent = t.title || t.origin;
    const urlSpan = document.createElement("span");
    urlSpan.className = "muted small";
    urlSpan.style.marginLeft = "8px";
    urlSpan.textContent = t.origin;
    info.appendChild(titleSpan);
    info.appendChild(urlSpan);
    row.appendChild(info);

    const enrollBtn = document.createElement("button");
    enrollBtn.type = "button";
    enrollBtn.className = "btn small primary";
    enrollBtn.textContent = "Add Site Agent";
    enrollBtn.setAttribute("aria-label", `Add Site Agent for ${t.origin}`);
    enrollBtn.addEventListener("click", async () => {
      // Verify the install grant (scripting + host are granted at install);
      // there is no runtime request left to make. Fail closed on error.
      let granted = false;
      try {
        granted = (await chrome.permissions.contains({
          permissions: ["scripting"],
          origins: [`${t.origin}/*`],
        })) === true;
      } catch {
        saveFlash(siteAgentSetupMessage("permission-error", t.origin));
        return;
      }
      if (!granted) {
        saveFlash(siteAgentSetupMessage("permission-denied", t.origin));
        return;
      }
      const res = await send({
        type: "agent.enroll-origin",
        origin: t.origin,
        ownerGesture: true,
        tabId: t.id,
      }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      const state = enrollOutcomeState(res, { selectedTab: true });
      saveFlash(siteAgentSetupMessage(state, t.origin));
      notifySiteDataChanged();
      renderEnrolledSites();
      renderSiteToolConsents({ cursor: null });
      renderWebmcpStatus();
      renderDiscoveredOpenTabs();
    });
    row.appendChild(enrollBtn);
    container.appendChild(row);
  }
}

// ── Enrolled sites (the removal action lives HERE — the agent lifecycle, not the
//    Data & memory section — item 58) ──
async function renderEnrolledSites(ctx) {
  const el = $("#enrolled-sites");
  if (!el) return;
  await renderDiscoveredOpenTabs();
  const origins = await boundedSend("agent.list").catch(() => []);
  el.replaceChildren();
  for (const origin of (origins ?? [])) {
    const row = document.createElement("div");
    row.className = "origin-row";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = origin; // textContent — never interpolate an origin
    row.appendChild(label);

    // Disenroll = AUTHORITATIVE revocation: unregister the content scripts,
    // remove the host permission, tombstone the enrollment, and clear OPFS (the
    // agent.delete route).
    const disenroll = document.createElement("button");
    disenroll.type = "button";
    disenroll.className = "btn small ghost disenroll-origin";
    disenroll.textContent = "Remove Site Agent";
    disenroll.setAttribute("aria-label", `Remove Site Agent for ${origin}`);
    disenroll.addEventListener("click", async () => {
      const res = await send({ type: "agent.delete", origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok) {
        saveFlash(`Site Agent removed for ${origin}.`);
      } else {
        saveFlash(`Couldn't fully remove the Site Agent for ${origin}. Try again.`);
      }
      renderEnrolledSites();
      notifySiteDataChanged();
      renderSiteToolConsents({ cursor: null });
      renderWebmcpStatus();
    });
    row.appendChild(disenroll);

    el.appendChild(row);
  }
}

// ── Exact Site Agent tool consent + redacted durable audit ──────────────
function publishSiteToolConsentView() {
  const st = getState();
  const manager = $("#webmcp-consent-manager");
  if (manager) manager.data = { ...st.siteToolConsentView };
}

export async function renderSiteToolConsents({ cursor, status = "" } = {}, ctx) {
  const st = getState(ctx);
  const resolvedCursor = cursor === undefined ? st.siteToolConsentView.cursor : cursor;
  const manager = $("#webmcp-consent-manager");
  if (!manager) return;
  if (!st.siteToolConsentWired) {
    st.siteToolConsentWired = true;
    manager.addEventListener("tool-consent", async (event) => {
      const siteIndex = Number(event.detail?.siteIndex);
      const toolIndex = Number(event.detail?.toolIndex);
      const site = st.siteToolConsentView.sites?.[siteIndex];
      const tool = site?.tools?.[toolIndex];
      const state = event.detail?.state === "ask" ? "ask" : "allowed";
      if (!site || !tool || st.siteToolConsentView.busyKey) return;
      st.siteToolConsentView = {
        ...st.siteToolConsentView,
        busyKey: `tool:${siteIndex}:${toolIndex}`,
        error: "",
        status: state === "ask" ? `Disabling automatic use of ${tool.name}…` : `Allowing ${tool.name}…`,
      };
      publishSiteToolConsentView();
      const result = await boundedSend("webmcp.consent.tool.set", {
        origin: site.origin,
        name: tool.name,
        state,
      }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      if (result?.ok !== true) {
        st.siteToolConsentView = {
          ...st.siteToolConsentView,
          busyKey: "",
          error: result?.error ?? "The tool permission could not be saved.",
          status: "",
          toolErrors: { ...st.siteToolConsentView.toolErrors, [`${siteIndex}:${toolIndex}`]: "Could not save. Try again." },
        };
        publishSiteToolConsentView();
        return;
      }
      await renderSiteToolConsents({
        cursor: null,
        status: state === "ask"
          ? `${tool.name} will ask on its next model use.`
          : `${tool.name} is allowed automatically.`,
      });
    });
    manager.addEventListener("site-reset", async (event) => {
      const siteIndex = Number(event.detail?.siteIndex);
      const site = st.siteToolConsentView.sites?.[siteIndex];
      const mode = event.detail?.mode === "automatic" ? "automatic" : "all";
      if (!site || st.siteToolConsentView.busyKey) return;
      st.siteToolConsentView = {
        ...st.siteToolConsentView,
        busyKey: `site:${siteIndex}:${mode}`,
        error: "",
        status: mode === "automatic" ? `Disabling automatic use for ${site.origin}…` : `Resetting decisions for ${site.origin}…`,
      };
      publishSiteToolConsentView();
      const result = await boundedSend("webmcp.consent.site.reset", { origin: site.origin, mode })
        .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      if (result?.ok !== true) {
        st.siteToolConsentView = { ...st.siteToolConsentView, busyKey: "", error: result?.error ?? "The site permissions could not be reset.", status: "" };
        publishSiteToolConsentView();
        return;
      }
      await renderSiteToolConsents({ cursor: null, status: mode === "automatic" ? `Automatic use is disabled for ${site.origin}.` : `All decisions were reset for ${site.origin}.` });
    });
    manager.addEventListener("site-policy", async (event) => {
      const siteIndex = Number(event.detail?.siteIndex);
      const site = st.siteToolConsentView.sites?.[siteIndex];
      const policy = event.detail?.policy === "deny" ? "deny" : "allow";
      if (!site || st.siteToolConsentView.busyKey) return;
      st.siteToolConsentView = { ...st.siteToolConsentView, busyKey: `site:${siteIndex}:policy`, error: "", status: `${policy === "deny" ? "Turning off" : "Turning on"} tools for ${site.origin}…` };
      publishSiteToolConsentView();
      const result = await boundedSend("tools.policy.set", { origin: site.origin, policy })
        .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      if (result?.ok !== true) {
        st.siteToolConsentView = { ...st.siteToolConsentView, busyKey: "", error: result?.error ?? "The site tool switch could not be saved.", status: "" };
        publishSiteToolConsentView();
        return;
      }
      await renderSiteToolConsents({ cursor: null, status: `Site tools are ${policy === "deny" ? "off" : "on"} for ${site.origin}.` });
    });
    manager.addEventListener("audit-page", (event) => {
      renderSiteToolConsents({ cursor: event.detail?.cursor ?? null, status: "Audit page loaded." });
    });
    manager.addEventListener("refresh", () => renderSiteToolConsents({ cursor: null }));
  }
  const requestSeq = ++st.siteToolConsentRequestSeq;
  st.siteToolConsentView = { ...st.siteToolConsentView, loading: true, error: "", status: status || "Loading site tool permissions…", cursor: resolvedCursor };
  publishSiteToolConsentView();
  const [snapshot, audit] = await Promise.all([
    boundedSend("webmcp.consent.snapshot").catch((error) => ({ ok: false, error: String(error?.message ?? error) })),
    boundedSend("webmcp.audit.list", { cursor: resolvedCursor, limit: 20 }).catch((error) => ({ ok: false, error: String(error?.message ?? error) })),
  ]);
  if (requestSeq !== st.siteToolConsentRequestSeq) return;
  if (snapshot?.ok !== true || audit?.ok !== true) {
    const auditError = String(audit?.error ?? "");
    const error = auditError === "site_tool_audit_corrupt"
      ? "Consent history is damaged and site tools are blocked. Try again. If this persists, Factory reset under Data & memory clears all extension data and restores a clean profile."
      : snapshot?.error ?? audit?.error ?? "Site tool permissions could not be loaded.";
    st.siteToolConsentView = {
      ...st.siteToolConsentView,
      loading: false,
      busyKey: "",
      error,
      status: "",
      sites: snapshot?.ok === true && Array.isArray(snapshot.sites) ? snapshot.sites : st.siteToolConsentView.sites,
      audit: audit?.ok === true ? audit : st.siteToolConsentView.audit,
    };
    publishSiteToolConsentView();
    return;
  }
  st.siteToolConsentView = {
    loading: false,
    error: "",
    status: status || "Site tool permissions loaded.",
    sites: Array.isArray(snapshot.sites) ? snapshot.sites : [],
    audit,
    cursor: resolvedCursor,
    busyKey: "",
    toolErrors: {},
  };
  publishSiteToolConsentView();
}

// ── WebMCP discovery status + diagnostics toggle (Paul 2026-08-18) ──
async function renderWebmcpStatus(ctx) {
  const st = getState(ctx);
  const body = $("#webmcp-status-body");
  const toggle = $("#webmcp-diagnostics");
  if (!body || !toggle) return;

  if (!st.webmcpDiagWired) {
    st.webmcpDiagWired = true;
    toggle.addEventListener("toggle", async (e) => {
      const checked = e.detail.checked === true;
      await send({ type: "webmcp.diagnostics.set", enabled: checked })
        .catch(() => {});
      saveFlash(checked ? "WebMCP service-worker diagnostics enabled." : "WebMCP service-worker diagnostics disabled.");
    });
  }
  let diag = { enabled: false };
  try { diag = await boundedSend("webmcp.diagnostics.get"); } catch { /* SW not ready */ }
  toggle.checked = diag?.enabled === true;

  const status = await send({ type: "webmcp.status" })
    .catch(() => null);
  body.replaceChildren();
  const s = status?.status;
  if (!s) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = SITE_AGENT_COPY.diagnosticsEmpty;
    body.appendChild(p);
    return;
  }
  const row = document.createElement("div");
  row.className = "webmcp-row";
  // The record separates the SW-ATTESTED script lifecycle (registration /
  // injection) from the PAGE-REPORTED tool counts — render both, labeled.
  const lines = [
    `Origin: ${s.origin}`,
    `Script status (attested): ${s.scriptStatus}${s.scriptStatusAt ? " · " + new Date(s.scriptStatusAt).toLocaleString() : ""}`,
  ];
  // The persisted scriptError is rendered ONCE (the "Error:" line below).
  if (s.injection && (s.injection.targets ?? 0) > 0) {
    lines.push(
      `Injection: ${s.injection.ready?.length ?? 0}/${s.injection.targets} tab(s) ready` +
        ((s.injection.partial?.length ?? 0) > 0 ? ` · ${s.injection.partial.length} partial` : "") +
        ((s.injection.failed?.length ?? 0) > 0 ? ` · ${s.injection.failed.length} failed` : ""),
    );
  }
  if (s.lastReport) {
    const r = s.lastReport;
    lines.push(
      `Page report: ${r.toolCount ?? 0} tools (${r.declaredCount ?? 0} declared, ${r.inferredCount ?? 0} inferred) · ${new Date(r.at).toLocaleString()}`,
    );
  } else {
    lines.push("Page report: none yet");
  }
  for (const line of lines) {
    const p = document.createElement("div");
    p.className = "webmcp-line";
    p.textContent = line; // textContent — the origin/status are untrusted data
    row.appendChild(p);
  }
  if (Array.isArray(s.lastReport?.toolNames) && s.lastReport.toolNames.length) {
    const names = document.createElement("div");
    names.className = "webmcp-tools muted";
    names.textContent = s.lastReport.toolNames.join(", ");
    row.appendChild(names);
  }
  if (s.scriptError) {
    const err = document.createElement("div");
    err.className = "webmcp-line error";
    err.textContent = "Error: " + s.scriptError;
    row.appendChild(err);
  }
  body.appendChild(row);

  // Site playbook note (CAP-FB-20260830-SITE-PLAYBOOKS-01): the owner's
  // per-origin instruction ("On this site, always …"), composed into the
  // skills boundary layer for runs whose active tab is this origin. Bounded
  // to 2,000 chars; stored under the origin key.
  const origin = String(s.origin ?? "");
  if (origin) {
    const NOTE_MAX = 2000;
    const field = document.createElement("div");
    field.className = "webmcp-site-note";
    const label = document.createElement("label");
    const noteId = `site-note-${origin.replace(/[^a-z0-9]+/gi, "-")}`;
    label.setAttribute("for", noteId);
    label.textContent = "Site instructions (" + origin + ")";
    const textarea = document.createElement("textarea");
    textarea.id = noteId;
    textarea.rows = 3;
    textarea.maxLength = NOTE_MAX;
    textarea.placeholder = "On this site, always …";
    try {
      const cur = await send({ type: "site-skills.get", origin });
      textarea.value = String(cur?.notes ?? "");
    } catch { /* SW not ready */ }
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save site instructions";
    on(saveBtn, "click", async () => {
      try {
        await send({ type: "site-skills.set", origin, notes: textarea.value });
        saveFlash("Site instructions saved.");
      } catch {
        saveFlash("Could not save site instructions.");
      }
    });
    field.appendChild(label);
    field.appendChild(textarea);
    field.appendChild(saveBtn);
    body.appendChild(field);
  }
}

// ── Agents ──
async function renderAgents() {
  const st = getState(arguments[0]);
  const s = await storage.get("cap:multiAgent");
  const toggle = $("#multi-agent");
  if (toggle) {
    const on = s?.["cap:multiAgent"] !== false;
    toggle.checked = on;
    if (!st.multiAgentWired) {
      st.multiAgentWired = true;
      toggle.addEventListener("toggle", async (e) => {
        const checked = e.detail.checked;
        await storage.set({ "cap:multiAgent": checked });
        // Rebuild the running orchestrator so the fan-out / solo switch takes effect
        // immediately (the worker reads cap:multiAgent at orchestration time).
        try {
          await send({ type: "invalidate-agent" });
        } catch {
          /* worker may not be running yet — the setting still persists */
        }
        saveFlash("Agent mode saved.");
      });
    }
  }

  // Interactive and scheduled agents share one management list. The data
  // models remain separate; this function only joins their presentation.
  await renderUnifiedAgentSettings();

  // ACP external harness settings (endpoint, token, cwd, permissions mode, transport)
  await renderAcpSettings();
}
// async function initProviderServerTools() — lives in providers.js (cap-beads-wuvg boundary marker)

async function renderAcpSettings() {
  const st = getState(arguments[0]);
  const endpointEl = $("#acp-endpoint");
  const tokenEl = $("#acp-token");
  const cwdEl = $("#acp-cwd");
  const permEl = $("#acp-permissions");
  const transportEl = $("#acp-transport");
  const statusEl = $("#acp-status");
  const testBtn = $("#acp-test-btn");
  if (!endpointEl) return;

  const s = await storage.get(["acp.endpoint", "acp.token", "acp.cwd", "acp.permissions", "acp.transport"]);
  endpointEl.value = s?.["acp.endpoint"] || "";
  tokenEl.value = s?.["acp.token"] || "";
  cwdEl.value = s?.["acp.cwd"] || "";
  permEl.value = s?.["acp.permissions"] || "ask";
  transportEl.value = s?.["acp.transport"] || "";

  if (st.acpWired) return;
  st.acpWired = true;

  endpointEl.addEventListener("change", async () => {
    const val = endpointEl.value.trim();
    if (val) await storage.set({ "acp.endpoint": val });
    else await storage.remove(["acp.endpoint"]);
    saveFlash("ACP endpoint saved.");
  });

  tokenEl.addEventListener("change", async () => {
    const val = tokenEl.value.trim();
    if (val) await storage.set({ "acp.token": val });
    else await storage.remove(["acp.token"]);
    saveFlash("ACP token saved.");
  });

  cwdEl.addEventListener("change", async () => {
    const val = cwdEl.value.trim();
    if (val) await storage.set({ "acp.cwd": val });
    else await storage.remove(["acp.cwd"]);
    saveFlash("ACP working directory saved.");
  });

  permEl.addEventListener("change", async () => {
    await storage.set({ "acp.permissions": permEl.value });
    saveFlash("ACP permission mode saved.");
  });

  transportEl.addEventListener("change", async () => {
    const val = transportEl.value;
    // OPTIONAL + JIT model (chrome-agent-platform-o65r): the shipped manifest lists
    // nativeMessaging in optional_permissions, so selecting the Native host transport
    // IS the moment of need — request it here rather than failing the leg later.
    if (val === "native") {
      const grant = await ensureAcpNativePermission();
      if (!grant.granted) {
        // Not granted: keep the previous transport (a saved "native" the runtime
        // can never use would silently downgrade every turn to the bridge).
        transportEl.value = s?.["acp.transport"] || "";
        saveFlash(grant.error);
        return;
      }
    }
    if (val) await storage.set({ "acp.transport": val });
    else await storage.remove(["acp.transport"]);
    saveFlash("ACP transport mode saved.");
  });

  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      if (statusEl) {
        statusEl.textContent = "Connecting…";
        statusEl.style.color = "";
      }
      // A click is the reliable user-activation gesture for the JIT nativeMessaging
      // grant (chrome-agent-platform-o65r): a select's change event is not always
      // treated as one. Only when the operator's transport preference names the
      // native host — a bridge-only test must never prompt for a permission it
      // does not need.
      if ((transportEl.value || s?.["acp.transport"]) === "native") {
        const grant = await ensureAcpNativePermission();
        if (!grant.granted && statusEl) {
          statusEl.textContent = grant.error;
          statusEl.style.color = "var(--danger, #b3261e)";
          return;
        }
      }
      try {
        const ep = endpointEl.value.trim() || "http://127.0.0.1:3210/health";
        const healthUrl = ep.replace(/^ws(s)?:/i, "http$1:").replace(/\/acp(\?.*)?$/i, "/health");
        const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = await resp.json();
          if (statusEl) {
            statusEl.textContent = `Connected: ${data.harness ?? "bridge active"}`;
            statusEl.style.color = "var(--success, #1b873f)";
          }
        } else if (statusEl) {
          statusEl.textContent = `HTTP ${resp.status}`;
          statusEl.style.color = "var(--danger, #b3261e)";
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = `Offline (${err?.message ?? err})`;
          statusEl.style.color = "var(--danger, #b3261e)";
        }
      }
    });
  }
}

function agentProviderRowHtml(a, cur, globalCfg) {
  const selection = providerSelectionPresentation(cur, PROVIDERS);
  // An internal legacy override remains stored/runnable. Keep the public select
  // empty and its dependent controls inert until the owner chooses a listed
  // replacement; rendering alone never rewrites the override.
  const provider = selection.selectValue;
  const preset = PROVIDERS.find((p) => p.id === provider);
  const models = preset ? providerCatalogue(preset) : [];
  const needsBaseURL = provider === "openai-compatible";
  // Prefill the OpenAI-compatible base URL from the GLOBAL config when the
  // global provider is also openai-compatible (no stale preset empty string).
  const baseURLDefault = needsBaseURL
    ? (cur.baseURL ?? (globalCfg?.provider === "openai-compatible" ? globalCfg.baseURL : ""))
    : "";
  const providersAttr = escapeAttr(JSON.stringify(PROVIDERS.map((p) => ({ id: p.id, name: p.name, icon: "terminal" }))));
  const internalDisabled = selection.hiddenInternal ? "disabled" : "";
  return `
    <div class="agent-row-summary">
      <div class="agent-row-copy">
        <div class="agent-row-title"><strong title="${escapeAttr(a.name)}">${escapeHtml(a.name)}</strong><span class="agent-mode-badge">${escapeHtml(agentScheduleMarker({ ...a, kind: "named" }))}</span></div>
        <span class="muted">${escapeHtml(a.role || "Interactive agent")}</span>
      </div>
    </div>
    <provider-select class="ag-provider" providers="${providersAttr}" value="${escapeAttr(provider)}" label="Provider" placeholder="${selection.hiddenInternal ? "Choose a listed provider" : "Use the global provider"}"></provider-select>
    <model-picker class="ag-model" models="${escapeAttr(JSON.stringify(models))}" value="${escapeAttr(selection.hiddenInternal ? "" : (cur.model ?? ""))}" label="Model id" placeholder="${models.length ? "Search or type a model id…" : "model id"}" ${provider ? "" : "disabled"}></model-picker>
    <label class="field ag-base-url" ${needsBaseURL ? "" : "hidden"}><span class="field-label">Base URL</span><input class="agent-provider-base-url" type="text" placeholder="https://your-endpoint/v1" value="${escapeAttr(baseURLDefault)}"></label>
    <label class="field"><span class="field-label">API key (write-only)</span><input class="agent-provider-key" type="password" placeholder="${selection.hiddenInternal ? "Not used by the active internal provider" : cur.hasApiKey ? "(kept — blank keeps it)" : "…"}" autocomplete="off" title="${selection.hiddenInternal ? "Choose a listed provider before entering a key" : cur.hasApiKey ? "A saved key is kept when this field is left blank" : "API key"}" ${internalDisabled}></label>
    <p class="hint agent-provider-internal-status" hidden></p>
    <div class="ag-actions">
      <button class="btn small set-agent-provider" type="button" ${internalDisabled}>Save provider</button>
      ${!selection.hiddenInternal && cur.provider && cur.hasApiKey ? `<button class="btn small ghost clear-agent-key" type="button" aria-label="Clear the stored API key for ${escapeAttr(a.name)}">Clear key</button>` : ""}
      <button class="btn small ghost edit-named-agent" type="button">Edit persona &amp; schedule</button>
      <button class="btn small ghost delete-named-agent" type="button" style="color:var(--danger,#b3261e);border-color:var(--border);" aria-label="Delete ${escapeAttr(a.name)}">Delete</button>
    </div>
  `;
}

// A per-agent provider change is a destructive named-agent mutation. The SW
// deliberately returns a pending capability on the first exact call. This modal
// is the explicit owner decision between that call and its one exact retry —
// dismissal/cancel can only deny, never approve.
function confirmAgentProviderMutation(agentName, description, trigger) {
  return confirmActionDialog({
    title: "Approve provider change?",
    body: `${description} for ${agentName}? This changes which model service the agent may use.`,
    note: "Only Approve once saves this exact change.",
    confirmLabel: "Approve once",
    requireGenuineGesture: true,
    returnFocusTo: trigger ?? null,
  });
}

async function runAgentProviderMutation({ message, agentName, description, trigger }) {
  return await runOwnerApprovedMutation({
    message,
    action: "named-agent.set-provider",
    sendMessage: (value) => send(value),
    requestConfirmation: () => confirmAgentProviderMutation(agentName, description, trigger),
  });
}

function openNamedAgentEditor(agent) {
  ensureCtx().callbacks?.editNamedAgent?.(agent);
}

async function renderAgentProviders(list, projectedAgents, globalCfg) {
  for (const projected of projectedAgents) {
    const a = projected.namedAgent;
    if (!a) continue;
    const row = document.createElement("div");
    row.className = "agent-settings-row agent-provider-row";
    // The stored override is REDACTED (no key) — the provider + model are shown,
    // the key is entered (and only ever written, never read back).
    const cur = a.provider ?? {};
    const storedSelection = providerSelectionPresentation(cur, PROVIDERS);
    row.innerHTML = agentProviderRowHtml(a, cur, globalCfg);
    const internalStatus = row.querySelector(".agent-provider-internal-status");
    renderInternalProviderStatus(internalStatus, storedSelection);
    const agentCredentialInput = row.querySelector(".agent-provider-key");
    const setAgentProvider = row.querySelector(".set-agent-provider");
    on(row.querySelector(".edit-named-agent"), "click", () => openNamedAgentEditor(a));

    // Provider change → swap the model catalogue + base-URL field to the
    // selected provider (the row stays a labeled grid; only the dependent
    // cells change). A hidden legacy override cannot be erased by pressing an
    // otherwise-no-op Save: choose a public provider first.
    on(row.querySelector(".ag-provider"), "change", (e) => {
      const provider = e.detail?.value ?? e.target.value ?? "";
      const preset = PROVIDERS.find((p) => p.id === provider);
      const models = preset ? providerCatalogue(preset) : [];
      const hiddenLegacyUnchanged = storedSelection.hiddenInternal && !provider;
      renderInternalProviderStatus(
        internalStatus,
        hiddenLegacyUnchanged ? storedSelection : { hiddenInternal: false },
      );
      if (agentCredentialInput) agentCredentialInput.disabled = hiddenLegacyUnchanged;
      if (setAgentProvider) setAgentProvider.disabled = hiddenLegacyUnchanged;
      const picker = row.querySelector(".ag-model");
      if (picker) {
        picker.models = models;
        picker.value = ""; // never carry one provider's model id to another
        picker.setAttribute("placeholder", models.length ? "Search or type a model id…" : "model id");
        if (provider) picker.removeAttribute("disabled"); else picker.setAttribute("disabled", "");
      }
      const baseURLField = row.querySelector(".ag-base-url");
      if (baseURLField) {
        const needs = provider === "openai-compatible";
        baseURLField.hidden = !needs;
        const input = baseURLField.querySelector(".agent-provider-base-url");
        if (needs && input && !input.value) {
          input.value = globalCfg?.provider === "openai-compatible" ? (globalCfg.baseURL ?? "") : "";
        }
      }
    });

    // The owner-gesture EXPLICIT key clear for a per-agent override (the only
    // removal path — a blank Save preserves; the final review's MEDIUM).
    on(row.querySelector(".clear-agent-key"), "click", async (event) => {
      const trigger = event.currentTarget;
      trigger.disabled = true;
      const provider = row.querySelector(".ag-provider")?.value ?? "";
      const preset = PROVIDERS.find((p) => p.id === provider);
      const r = await runAgentProviderMutation({
        message: {
          type: "named-agent.set-provider",
          id: a.id,
          config: { provider, baseURL: provider === "openai-compatible" ? (row.querySelector(".agent-provider-base-url")?.value.trim() ?? "") : (preset?.baseURL ?? ""), model: row.querySelector(".ag-model")?.value?.trim() ?? "", apiKey: "" },
        },
        agentName: a.name,
        description: "Clear the stored API key",
        trigger,
      });
      if (r.ok) {
        saveFlash(`${a.name}: API key cleared.`);
        await renderUnifiedAgentSettings();
      } else {
        trigger.disabled = false;
        trigger.focus();
        saveFlash(`Key not cleared: ${r.error ?? "unknown error"}`);
      }
    });
    on(row.querySelector(".delete-named-agent"), "click", async () => {
      const confirmed = await deleteAgentDialog({ name: a.name, kind: "named" });
      if (!confirmed) return;
      const res = await send({ type: "named-agent.delete", id: a.id })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok !== false) {
        saveFlash(`Deleted ${a.name}.`);
      } else {
        saveFlash(`Could not delete ${a.name}: ${res?.error ?? "failed"}.`);
      }
      await renderUnifiedAgentSettings();
    });
    on(setAgentProvider, "click", async (event) => {
      const trigger = event.currentTarget;
      const provider = row.querySelector(".ag-provider")?.value ?? "";
      const model = row.querySelector(".ag-model")?.value?.trim() ?? "";
      const apiKey = agentCredentialInput.value;
      if (blockSessionOnlyCredentialSave(agentCredentialInput)) return;
      trigger.disabled = true;
      const customBaseURL = row.querySelector(".agent-provider-base-url")?.value.trim() ?? "";
      let config = null;
      if (provider) {
        const preset = PROVIDERS.find((p) => p.id === provider);
        config = {
          provider,
          baseURL: provider === "openai-compatible" ? customBaseURL : (preset?.baseURL ?? ""),
          model,
          apiKey: apiKey || (cur.provider === provider ? undefined : ""),
        };
      }
      const r = await runAgentProviderMutation({
        message: { type: "named-agent.set-provider", id: a.id, config },
        agentName: a.name,
        description: config == null ? "Use the global provider" : `Save ${provider} as the provider`,
        trigger,
      });
      if (r.ok) {
        saveFlash(`${a.name}: provider updated.`);
        await renderUnifiedAgentSettings();
      } else {
        trigger.disabled = false;
        trigger.focus();
        saveFlash(`Provider not saved: ${r.error ?? "unknown error"}`);
      }
    });
    if (projected.backgroundAgent) backgroundAgentRow(projected.backgroundAgent, row);
    list.appendChild(row);
  }
}

// ── Background agents (scheduled skills) ──
function backgroundAgentRow(a, hostRow = null, ctx) {
  const row = hostRow ?? document.createElement("div");
  row.classList.add("agent-settings-row", "background-agent-row");

  const name = document.createElement("span");
  name.className = "perm-name";
  name.textContent = hostRow ? "Scheduled automation" : a.name;

  const state = document.createElement("span");
  state.className = "agent-mode-badge";
  state.textContent = agentScheduleMarker({ ...a, kind: "background" });

  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = a.description || "Scheduled agent";

  const toggle = document.createElement("switch-toggle");
  toggle.setAttribute("label", `${a.enabled ? "Disable" : "Enable"} ${a.name}`);
  toggle.checked = Boolean(a.enabled);

  on(toggle, "toggle", async (e) => {
    const enabled = e.detail.checked;
    // ENABLE time: notifications are granted at install — VERIFY only (a
    // runtime request no longer exists). Best-effort: if the install grant is
    // somehow absent the run-time path skips the notification silently.
    if (enabled) {
      try {
        await chrome.permissions?.contains?.({ permissions: ["notifications"] });
      } catch { /* unverifiable — the run-time path skips */ }
    }
    const out = await send({ type: "background-agent.set", id: a.id, enabled })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    saveFlash(
      out?.ok
        ? `${a.name} ${enabled ? "enabled." : "disabled."}`
        : `Could not update ${a.name}: ${out?.error ?? "failed"}.`,
    );
    renderBackgroundAgents();
  });

  // Item 56: duplicate a background agent into an EDITABLE copy (the built-in
  // template stays pristine; the copy's prompt can be edited).
  const duplicate = document.createElement("button");
  duplicate.type = "button";
  duplicate.className = "btn small ghost";
  duplicate.textContent = "Duplicate";
  duplicate.setAttribute("aria-label", `Duplicate ${a.name} into an editable copy`);
  on(duplicate, "click", async () => {
    const out = await send({ type: "background-agent.duplicate", id: a.id })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    saveFlash(out?.ok ? `Duplicated ${a.name} — edit the copy below.` : `Could not duplicate: ${out?.error ?? "failed"}.`);
    renderBackgroundAgents();
  });

  const actions = document.createElement("span");
  actions.className = "agent-actions";
  actions.append(duplicate);

  // A CUSTOM copy is editable: an Edit button opens a prompt editor (the
  // system prompt / constraints). A custom copy can also be deleted.
  if (a.custom) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn small ghost";
    edit.textContent = "Edit prompt";
    edit.setAttribute("aria-label", `Edit ${a.name}'s prompt`);
    on(edit, "click", () => editSkillPrompt(a));
    actions.append(edit);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small ghost";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete ${a.name}`);
    on(del, "click", async () => {
      const out = await send({ type: "background-agent.delete", id: a.id })
        .catch(() => ({ ok: false }));
      if (out?.ok === true) {
        saveFlash(`Deleted ${a.name}.`);
        renderBackgroundAgents();
      } else {
        saveFlash(`Could not delete ${a.name}: ${out?.error ?? "failed"}.`);
      }
    });
    actions.append(del);
  }

  if (hostRow) {
    const controls = document.createElement("div");
    controls.className = "background-agent-controls";
    controls.append(name, state, hint, toggle, actions);
    row.append(controls);
  } else {
    row.append(name, state, hint, toggle, actions);
  }
  return row;
}

// Edit a skill's system prompt: a dialog with the current prompt in a textarea
// + Save. The user-edited value is set via .value / textContent, never innerHTML.
function editSkillPrompt(skill, ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", `${skill.name} — system prompt`);

  const textarea = document.createElement("textarea");
  textarea.rows = 8;
  textarea.className = "skill-edit-textarea";
  textarea.value = skill.prompt ?? "";
  textarea.setAttribute("aria-label", `System prompt for ${skill.name}`);

  const actions = document.createElement("div");
  actions.className = "skill-edit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn small ghost";
  cancel.textContent = "Cancel";
  on(cancel, "click", () => dialog.close());
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn small";
  save.textContent = "Save";
  on(save, "click", async () => {
    const out = await send({ type: "background-agent.update", id: skill.id, prompt: textarea.value })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    saveFlash(out?.ok ? `Updated ${skill.name}.` : `Could not update: ${out?.error ?? "failed"}.`);
    dialog.close();
    renderBackgroundAgents();
  });
  actions.append(cancel, save);

  dialog.append(textarea, actions);
  (panelCtx.root ?? byId("agents"))?.append(dialog);
  panelCtx.onUnmount(() => { try { dialog.remove(); } catch { /* dialog already removed */ } });
  on(dialog, "close", () => dialog.remove(), { once: true });
  dialog.show();
  textarea.focus();
}

// Settings offers the SAME scheduled catalogue as the hub's create flow,
// through the SAME component (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01):
// the disabled background skills render as <agent-template-card>s inside an
// <agent-template-gallery> filtered to Scheduled. Choosing a card selects it;
// "Add" enables exactly ONE skill through background-agent.set, and it then
// appears in every agent list.
function renderBackgroundAgentPicker(agents, ctx) {
  const host = $("#background-agent-add");
  if (!host) return;
  host.replaceChildren();
  if (!agents.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const disclosure = document.createElement("details");
  disclosure.className = "starter-templates-disclosure";
  const summary = document.createElement("summary");
  summary.setAttribute("data-i18n", "options_browse_starter_templates");
  summary.textContent = "Browse starter templates…";

  const copy = document.createElement("div");
  copy.className = "background-agent-add-copy";
  const title = document.createElement("h3");
  title.id = "background-agent-add-title";
  title.textContent = "Add a scheduled agent";
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "Choose a built-in scheduled template, then add it to your agents.";
  copy.append(title, hint);

  const gallery = document.createElement("agent-template-gallery");
  gallery.id = "background-agent-gallery";
  gallery.setAttribute("filters", "scheduled");
  gallery.setAttribute("filter", "scheduled");
  gallery.templates = agents.map(skillAsTemplate).filter(Boolean);

  const controls = document.createElement("div");
  controls.className = "background-agent-add-controls";
  const chosen = document.createElement("span");
  chosen.className = "muted background-agent-add-chosen";
  chosen.setAttribute("role", "status");
  chosen.setAttribute("aria-live", "polite");
  chosen.textContent = "Nothing chosen yet.";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn primary";
  add.textContent = "Add";
  add.disabled = true;
  let selectedId = "";
  on(gallery, "use", (event) => {
    selectedId = String(event.detail?.id ?? "");
    const agent = agents.find((candidate) => candidate.id === selectedId);
    add.disabled = !agent;
    const cadenceText = formatCadenceMinutes(agent?.schedule?.periodInMinutes);
    chosen.textContent = agent ? `${agent.name} — runs ${cadenceText || `every ${agent.schedule?.periodInMinutes ?? "?"} min`} once added.` : "Nothing chosen yet.";
    add.textContent = agent ? `Add ${agent.name}` : "Add";
  });
  on(add, "click", async () => {
    const agent = agents.find((candidate) => candidate.id === selectedId);
    if (!selectedId || !agent) return;
    add.disabled = true;
    const out = await send({ type: "background-agent.set", id: selectedId, enabled: true })
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    saveFlash(out?.ok ? `${agent.name} added.` : `Could not add ${agent.name}: ${out?.error ?? "failed"}.`);
    await renderUnifiedAgentSettings();
  });
  controls.append(chosen, add);
  disclosure.append(summary, copy, gallery, controls);
  host.setAttribute("role", "group");
  host.setAttribute("aria-labelledby", title.id);
  host.append(disclosure);
}

async function renderUnifiedAgentSettings(ctx) {
  const list = $("#unified-agent-list");
  if (!list) return;
  const [namedRes, backgroundRes, globalCfg] = await Promise.all([
    boundedSend("named-agent.list").catch(() => ({ agents: [] })),
    boundedSend("background-agent.list").catch(() => ({ agents: [] })),
    boundedSend("provider.get").catch(() => null),
  ]);
  const named = Array.isArray(namedRes?.agents) ? namedRes.agents : [];
  const background = backgroundAgentsForDisplay(backgroundRes?.agents);
  const existingBackground = background.filter((agent) => agent.enabled === true);
  const unified = projectUnifiedAgents(named, existingBackground);
  renderBackgroundAgentPicker(background.filter((agent) => agent.enabled !== true));

  list.replaceChildren();
  if (!unified.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No agents yet.";
    list.appendChild(empty);
    return;
  }
  await renderAgentProviders(list, unified.filter((agent) => agent.namedAgent), globalCfg);
  for (const projected of unified) {
    if (!projected.namedAgent) list.appendChild(backgroundAgentRow(projected.backgroundAgent, null));
  }
}

async function renderBackgroundAgents(ctx) {
  await renderUnifiedAgentSettings(ctx);
}

export async function hydrateAgentsHeavyLists(ctx) {
  const st = getState(ctx);
  if (st.agentsHeavyListsHydrated) return;
  st.agentsHeavyListsHydrated = true;
  await renderEnrolledSites().catch(() => {});
  await renderSiteToolConsents({ cursor: null }).catch(() => {});
  await renderWebmcpStatus().catch(() => {});
}

export function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  const run = (async () => {
    await renderAgents();
    await renderEnroll();
    await hydrateAgentsHeavyLists();
  })();
  return withUnmount(run, makeUnmount(panelCtx));
}

