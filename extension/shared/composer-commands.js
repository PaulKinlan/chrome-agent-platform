// shared/composer-commands.js — the composer slash-command registry + data loaders.
// DOM-free and dependency-injected so each Chrome-backed picker is unit-testable.

import { skillMatchesUrl } from "./match-patterns.js";

export const COMMAND_NAMESPACES = Object.freeze([
  { id: "skill", label: "skill", description: "invoke a skill", kind: "skill" },
  {
    id: "command",
    label: "command",
    description: "invoke an imported command",
    kind: "command",
  },
  {
    id: "agent",
    label: "agent",
    description: "direct the message to an agent",
    kind: "agent",
    direct: true,
  },
  {
    id: "tabs",
    label: "tabs",
    description: "attach an open tab",
    kind: "tab",
    direct: true,
  },
  {
    id: "artifacts",
    label: "artifacts",
    description: "attach an artifact",
    kind: "artifact",
    direct: true,
  },
  {
    id: "bookmarks",
    label: "bookmarks",
    description: "attach a bookmarked page",
    kind: "bookmark",
    direct: true,
  },
  {
    id: "history",
    label: "history",
    description: "attach a page from browsing history",
    kind: "history",
    direct: true,
  },
  {
    id: "files",
    label: "files",
    description: "attach a file from a granted folder",
    kind: "files",
    localFiles: true,
  },
  {
    id: "folder",
    label: "folder",
    description: "attach a granted folder",
    kind: "folder",
    localFiles: true,
  },
  {
    id: "remember",
    label: "remember",
    description: "write something to memory",
    kind: "free",
  },
  {
    id: "summarise",
    label: "summarise",
    description: "summarise the attached tab or selection on-device",
    kind: "direct",
    direct: true,
  },
  {
    id: "translate",
    label: "translate",
    description: "translate the attached tab or selection on-device",
    kind: "free",
  },
]);

// Shared 18px currentColor stroke icons for the composer + attach menu
// (CAP-FB-20260830-ICONOGRAPHY-GAPS-01 / chrome-agent-platform-wp6u).
export const ATTACH_MENU_ICONS = Object.freeze({
  file:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  "record-audio":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  "capture-camera":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  "record-screen":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  "grab-screenshot":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  "add-tab":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>',
  "choose-agent":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
});

const clean = (value, max = 512) => String(value ?? "").slice(0, max);
const hit = (query, ...values) =>
  !query || values.some((value) => clean(value).toLowerCase().includes(query));

async function hasPermission(chromeApi, permission) {
  try {
    return !!(await chromeApi?.permissions?.contains?.({ permissions: [permission] }));
  } catch {
    return false;
  }
}

function unavailablePermissionItem(permission) {
  const label = permission === "bookmarks" ? "Bookmarks" : "History";
  return [{
    id: `capability:${permission}`,
    label: `${label} unavailable`,
    description: `Grant ${label} in Settings, then retry /${permission}`,
    kind: "capability",
    capability: permission,
  }];
}

/**
 * List/search one command namespace through the actual backing API.
 * @param {string} ns
 * @param {string} arg
 * @param {{ runtimeSend?: ((type: string, payload?: Record<string, unknown>) => Promise<any>) | null, chromeApi?: any }} deps
 * @returns {Promise<any[]>}
 */
export async function loadComposerCommandItems(
  ns,
  arg = "",
  { runtimeSend = null, chromeApi = globalThis.chrome } = {},
) {
  const query = clean(arg, 512).toLowerCase();
  switch (ns) {
    case "skill": {
      const res = runtimeSend
        ? await runtimeSend("skill.list").catch(() => ({}))
        : {};
      // Origin-bound skills (CAP-FB-20260830-SITE-PLAYBOOKS-01): a skill
      // declaring `origins` is OFFERED only when the active tab matches.
      // This is the soft UX surface — the hard boundary is prompt composition.
      let activeUrl = "";
      try {
        const tabs = await chromeApi?.tabs?.query?.({ active: true, currentWindow: true }) ?? [];
        activeUrl = String(tabs?.[0]?.url ?? "");
      } catch { activeUrl = ""; }
      return (res.skills || [])
        .filter((item) => hit(query, item.name, item.id))
        .filter((item) => !Array.isArray(item.origins) || item.origins.length === 0 || skillMatchesUrl(item, activeUrl))
        .map((item) => ({
          // Collision-proof reference (CAP-FB-20260831-SKILL-LIST-SYNC-01 r2):
          // the reference is built from the source-qualified refId so an
          // imported skill whose id collides with a built-in skill id is
          // inserted as /skill:imported:<id> and resolves to the imported row
          // — never to a built-in BACKGROUND skill.
          id: `skill:${item.refId ?? item.id}`,
          label: clean(item.name || item.id, 256),
          description: clean(item.description, 512),
          kind: "skill",
        }));
    }
    case "cmd":
    case "command": {
      const res = runtimeSend
        ? await runtimeSend("command.list").catch(() => ({}))
        : {};
      const commands = Array.isArray(res?.commands) ? res.commands : [];
      return commands
        .filter((item) =>
          hit(
            query,
            item.name,
            item.id,
            item.description,
            item.argumentHint,
            item.plugin,
          )
        )
        .map((item) => {
          const hint = item.argumentHint ? ` [${item.argumentHint}]` : "";
          const plugin = item.plugin ? ` (${item.plugin})` : "";
          const description = `${item.description || "Imported command"}${hint}${plugin}`;
          const insertText = item.prompt ? item.prompt : `/${item.name} `;
          return {
            id: `command:${item.id}`,
            commandId: item.id,
            label: `/${item.name}`,
            description,
            kind: "command",
            argumentHint: item.argumentHint || "",
            prompt: item.prompt || "",
            plugin: item.plugin || null,
            insertText,
          };
        });
    }
    case "agent":
      return [];
    case "files": {
      const res = runtimeSend
        ? await runtimeSend("fs-grant.search", { query: arg, limit: 50 }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
        : { ok: false, error: "extension runtime unavailable" };
      const rows = [];
      for (const issue of (res.permissionIssues || [])) {
        rows.push({
          id: `files-settings:${issue.grantId}`,
          label: clean(issue.name || "Granted folder", 256),
          description: issue.status === "prompt" ? "needs access again — open Settings" : "access denied — forget and add again in Settings",
          recovery: issue.status === "prompt"
            ? `Open Settings → Local folders and choose Re-grant access for ${issue.name}.`
            : `Open Settings → Local folders, forget ${issue.name}, then add it again.`,
          kind: "files-action",
        });
      }
      for (const file of (res.files || [])) {
        rows.push({
          id: `files:${file.grantId}:${file.relativePath}`,
          label: clean(file.name, 256),
          description: clean(`${file.folderName} / ${file.relativePath}`, 512),
          kind: "local-file",
          ...file,
        });
      }
      if (!rows.length) {
        rows.push({
          id: "files-settings",
          label: res.ok === false ? "Local files unavailable" : "No matching files",
          description: res.ok === false ? `${clean(res.error || "search failed")} — open Settings` : "Grant a folder or change the search — Settings → Local folders",
          recovery: "Open Settings → Local folders and choose Add folder.",
          kind: "files-action",
        });
      }
      return rows.slice(0, 50);
    }
    case "folder": {
      const res = runtimeSend
        ? await runtimeSend("fs-grant.list", {}).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
        : { ok: false, error: "extension runtime unavailable" };
      const rows = [];
      for (const grant of (res.grants || [])) {
        if (grant.kind !== "directory") continue;
        if (!hit(query, grant.name)) continue;
        if (grant.status === "granted") {
          rows.push({
            id: `folder:${grant.grantId}`,
            label: clean(grant.name || "Granted folder", 256),
            description: "granted local folder — attach as a reference",
            kind: "local-folder",
            grantId: clean(grant.grantId, 128),
            folderName: clean(grant.name || "folder", 256),
          });
        } else {
          rows.push({
            id: `folder-settings:${grant.grantId}`,
            label: clean(grant.name || "Granted folder", 256),
            description: grant.status === "prompt" ? "needs access again — open Settings" : "access denied — forget and add again in Settings",
            recovery: grant.status === "prompt"
              ? `Open Settings → Local folders and choose Re-grant access for ${grant.name}.`
              : `Open Settings → Local folders, forget ${grant.name}, then add it again.`,
            kind: "files-action",
          });
        }
      }
      const directoryGrants = (res.grants || []).filter((g) => g.kind === "directory");
      if (!rows.length) {
        rows.push({
          id: "folder-settings",
          label: res.ok === false ? "Local folders unavailable" : (directoryGrants.length ? "No matching folders" : "No granted folders"),
          description: res.ok === false ? `${clean(res.error || "fs-grant.list failed")} — open Settings` : (directoryGrants.length ? "Change the search — Settings → Local folders" : "Grant a folder — Settings → Local folders"),
          recovery: "Open Settings → Local folders and choose Add folder.",
          kind: "files-action",
        });
      }
      return rows.slice(0, 50);
    }
    case "tabs": {
      const tabs = await chromeApi?.tabs?.query?.({}) ?? [];
      return tabs
        .filter((tab) => hit(query, tab.title, tab.url))
        .slice(0, 200)
        .map((tab) => ({
          id: `tabs:${tab.id}`,
          label: clean(tab.title || tab.url || "(untitled)", 256),
          description: clean(tab.url, 512),
          kind: "tab",
          attachment: {
            name: clean(tab.title || tab.url || "tab", 256),
            url: clean(tab.url, 2048),
            type: "tab",
            size: 0,
            kind: "tab",
            tabId: tab.id,
            windowId: tab.windowId,
          },
        }));
    }
    case "artifacts": {
      const res = runtimeSend
        ? await runtimeSend("asset.list", { origin: "all" }).catch(() => ({}))
        : {};
      return (res.assets || [])
        .filter((artifact) =>
          hit(query, artifact.name, artifact.id, artifact.type)
        )
        .slice(0, 200)
        .map((artifact) => ({
          id: `artifact:${artifact.id}`,
          label: clean(artifact.name || artifact.id || "artifact", 256),
          description: clean(artifact.type || "artifact", 128),
          kind: "artifact",
          artifactId: clean(artifact.id, 256),
          artifactOrigin: clean(artifact.origin || "master", 2048),
        }));
    }
    case "bookmarks": {
      if (!(await hasPermission(chromeApi, "bookmarks"))) {
        return unavailablePermissionItem("bookmarks");
      }
      const bookmarks = query
        ? await chromeApi?.bookmarks?.search?.(arg) ?? []
        : await chromeApi?.bookmarks?.getRecent?.(100) ?? [];
      return bookmarks
        .filter((bookmark) =>
          bookmark?.url && hit(query, bookmark.title, bookmark.url)
        )
        .slice(0, 100)
        .map((bookmark) => ({
          id: `bookmarks:${bookmark.id}`,
          label: clean(bookmark.title || bookmark.url, 256),
          description: clean(bookmark.url, 512),
          kind: "bookmark",
          insertText: `Bookmark: ${clean(bookmark.url, 2048)}`,
          attachment: {
            name: clean(bookmark.title || bookmark.url, 256),
            url: clean(bookmark.url, 2048),
            type: "text/uri-list",
            size: 0,
            kind: "bookmark",
            bookmarkId: clean(bookmark.id, 64),
          },
        }));
    }
    case "history": {
      if (!(await hasPermission(chromeApi, "history"))) {
        return unavailablePermissionItem("history");
      }
      const history = await chromeApi?.history?.search?.({
        text: arg,
        startTime: 0,
        maxResults: 100,
      }) ?? [];
      return history
        .filter((entry) => entry?.url && hit(query, entry.title, entry.url))
        .slice(0, 100)
        .map((entry, index) => ({
          id: `history:${index}`,
          label: clean(entry.title || entry.url, 256),
          description: clean(entry.url, 512),
          kind: "history",
          insertText: `History: ${clean(entry.url, 2048)}`,
          attachment: {
            name: clean(entry.title || entry.url, 256),
            url: clean(entry.url, 2048),
            type: "text/uri-list",
            size: 0,
            kind: "history",
            lastVisitTime: entry.lastVisitTime ?? null,
          },
        }));
    }
    case "summarise": {
      return [
        {
          id: "summarise",
          label: "Summarise",
          description: "Summarise the attached tab or selection on-device (private, zero API key)",
          kind: "command",
          insertText: "/summarise",
          prompt: "Summarise this on-device",
        },
      ];
    }
    case "translate": {
      const lang = query || arg || "es";
      return [
        {
          id: "translate",
          label: `Translate to ${lang}`,
          description: `Translate the attached tab or selection to ${lang} on-device (private, zero API key)`,
          kind: "command",
          insertText: `/translate ${lang}`.trim(),
          prompt: `Translate this to ${lang} on-device`,
        },
      ];
    }
    default:
      return [];
  }
}

function utf8DataUrl(type, content) {
  if (type === "image") return clean(content, 8 * 1024 * 1024);
  const bytes = new TextEncoder().encode(String(content ?? ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const mime = type === "html"
    ? "text/html"
    : type === "json"
    ? "application/json"
    : "text/plain";
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Turn a picked row into the text reference + pending attachment sent to the agent.
 * @param {any} item
 * @param {{ runtimeSend?: ((type: string, payload?: Record<string, unknown>) => Promise<any>) | null }} deps
 * @returns {Promise<{ text: string, attachment: any } | null>}
 */
export async function resolveComposerCommandSelection(
  item,
  { runtimeSend = null } = {},
) {
  if (!item) return null;
  if (item.kind === "command") {
    return {
      text: item.insertText || item.prompt || `/${item.id}`,
      attachment: null,
    };
  }
  if (item.kind !== "artifact") {
    return {
      text: item.insertText || `/${item.id}`,
      attachment: item.attachment ?? null,
    };
  }
  const res = runtimeSend
    ? await runtimeSend("asset.get", {
      origin: item.artifactOrigin || "master",
      id: item.artifactId,
    }).catch(() => ({}))
    : {};
  const artifact = res?.ok ? res.asset : null;
  if (!artifact) throw new Error("artifact not found");
  const artifactType = artifact.type || "data";
  const mime = artifactType === "html"
    ? "text/html"
    : artifactType === "json"
    ? "application/json"
    : artifactType === "image"
    ? "image/png"
    : "text/plain";
  return {
    text: `/artifact:${artifact.id || item.artifactId}`,
    attachment: {
      name: clean(artifact.name || item.label || "artifact", 256),
      type: mime,
      size: artifact.size ?? 0,
      kind: "artifact",
      dataURL: utf8DataUrl(artifactType, artifact.content),
      content: artifact.content,
      artifactId: artifact.id || item.artifactId,
      artifactOrigin: artifact.origin || item.artifactOrigin || "master",
      artifactType,
    },
  };
}
