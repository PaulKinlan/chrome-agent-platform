// extension/background/routes/fs-grants.js — the persistent local-folder
// grant routes (CAP-FB-20260823-PERSISTENT-FS-ACCESS-01), extracted from the
// inline service-worker handlers so they are unit-drivable, plus the model's
// ONLY write path (CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01).
//
// Authority model:
//   - Every `fs-grant.*` route below is restricted to the OWNER surfaces
//     (`owner-options` = Settings, `extension` = the hub / thread documents).
//     A page, a content script, or the MODEL principal is refused and the
//     refusal is audited. The model's read-only file tools (list_folders /
//     list_files / find_files / read_file / grep_files in lib/browser-tools.js)
//     call the fs-grants library directly inside the worker and never need
//     these routes.
//   - `fs-grant.write-file-approved` is the single exception: it accepts ONLY
//     the model principal (bound by the run's approval dispatcher), fails
//     closed on every boundary — grant, mode, path, size, binary — BEFORE it
//     stages anything, stages the exact on-disk-vs-proposed diff for the
//     owner's approval card (the same card an artifact edit shows), binds the
//     approval digest to the exact new content, re-verifies the on-disk bytes
//     after Approve, and only then writes. Deny leaves the bytes untouched.
//     The raw `fs-grant.write-file` is never reachable by the model.

import {
  listFsGrants,
  getFsGrant,
  deleteFsGrant,
  queryFsGrantStatus,
  serializeFsGrantSummary,
  listFsGrantEntries,
  readFsGrantFile,
  writeFsGrantFile,
  scanFsGrantManifest,
  searchFsGrantFiles,
  grepFsGrant,
  cleanRelativePath,
  computeSha256,
  MAX_FS_PATH_DEPTH,
  MAX_FS_TEXT_DECODE_BYTES,
  MAX_FS_WRITE_BYTES,
} from "../../lib/fs-grants.js";
import { STAGED_APPROVAL_DETAIL_BOUNDS } from "../../lib/owner-approval.js";

const OWNER_SURFACES = new Set(["owner-options", "extension"]);
const MAX_GRANT_ID_CHARS = 200;

/**
 * @param {{
 *   securityEvent: (kind: string, message: string) => void,
 *   requireOwnerApproval: (context: any, action: string, target: string, payload: any, detail?: any, stagedDetail?: any) => Promise<any>,
 *   canonicalOperationTarget: (kind: string, parts: Record<string, unknown>) => string,
 *   payloadFields: (entries: Array<[string, unknown]>) => any,
 *   lineDiffSummary: (oldText: string, newText: string) => { added: number, removed: number },
 * }} deps
 */
export function createFsGrantRoutes({
  securityEvent,
  requireOwnerApproval,
  canonicalOperationTarget,
  payloadFields,
  lineDiffSummary,
}) {
  const audit = (kind, message) => {
    try { securityEvent?.(kind, message); } catch { /* auditing never breaks a refusal */ }
  };
  const ownerOnly = (context, route) => {
    if (OWNER_SURFACES.has(context?.principal)) return null;
    audit("blocked-action", `fs-grant ${route} denied for principal ${context?.principal ?? "unknown"}`);
    return { ok: false, error: `fs-grant.${route} is restricted to extension surfaces` };
  };

  return Object.freeze({
    // ── Persistent File System Access Grants (CAP-FB-20260823-PERSISTENT-FS-ACCESS-01) ──
    async "fs-grant.list"(m, context) {
      const refused = ownerOnly(context, "list");
      if (refused) return refused;
      const rawGrants = await listFsGrants({ scope: m?.scope });
      const summaries = await Promise.all(
        rawGrants.map(async (g) => {
          const status = await queryFsGrantStatus(g);
          return serializeFsGrantSummary(g, status);
        }),
      );
      return { ok: true, grants: summaries };
    },

    async "fs-grant.get"({ grantId }, context) {
      if (!OWNER_SURFACES.has(context?.principal)) {
        return { ok: false, error: "fs-grant.get is restricted to extension surfaces" };
      }
      const grant = await getFsGrant(grantId);
      if (!grant) return { ok: false, error: "grant_not_found" };
      const status = await queryFsGrantStatus(grant);
      return { ok: true, grant: serializeFsGrantSummary(grant, status) };
    },

    async "fs-grant.remove"({ grantId }, context) {
      const refused = ownerOnly(context, "remove");
      if (refused) return refused;
      const result = await deleteFsGrant(grantId);
      return { ok: true, ...result };
    },

    async "fs-grant.list-entries"({ grantId, relativePath, limit }, context) {
      const refused = ownerOnly(context, "list-entries");
      if (refused) return refused;
      const result = await listFsGrantEntries(grantId, { relativePath, limit });
      return result;
    },

    async "fs-grant.search"({ query, limit }, context) {
      const refused = ownerOnly(context, "search");
      if (refused) return refused;
      return await searchFsGrantFiles(query, { limit });
    },

    async "fs-grant.read-file"({ grantId, relativePath, asText, maxBytes }, context) {
      const refused = ownerOnly(context, "read-file");
      if (refused) return refused;
      const result = await readFsGrantFile(grantId, { relativePath, asText, maxBytes });
      return result;
    },

    // The RAW write: the owner surfaces only (Settings' own file editing). The
    // model principal is refused here — its write path is the approved route
    // below, which pays the diff card. Never widen this gate.
    async "fs-grant.write-file"({ grantId, relativePath, content, asBinary }, context) {
      const refused = ownerOnly(context, "write-file");
      if (refused) return refused;
      const result = await writeFsGrantFile(grantId, { relativePath, content, asBinary });
      return result;
    },

    async "fs-grant.scan"({ grantId, maxEntries, maxDepth }, context) {
      const refused = ownerOnly(context, "scan");
      if (refused) return refused;
      const result = await scanFsGrantManifest(grantId, { maxEntries, maxDepth });
      return result;
    },

    async "fs-grant.grep"({ grantId, query, relativePath, regex, ignoreCase, maxMatches }, context) {
      const refused = ownerOnly(context, "grep");
      if (refused) return refused;
      return await grepFsGrant(grantId, { query, relativePath, regex, ignoreCase, maxMatches });
    },

    // ── The model's write path (CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01) ──
    // write_file (lib/browser-tools.js) → the run's bound approval dispatcher
    // → HERE with principal:"model". Order matters: every boundary is checked
    // and fails closed BEFORE the owner is asked anything, so a card is only
    // ever shown for a write that can actually happen.
    async "fs-grant.write-file-approved"({ grantId, relativePath, content }, context) {
      if (context?.principal !== "model") {
        audit("blocked-action", `fs-grant write-file-approved denied for principal ${context?.principal ?? "unknown"}`);
        return { ok: false, error: "fs-grant.write-file-approved is restricted to the model's approval path" };
      }
      const id = typeof grantId === "string" ? grantId.trim().slice(0, MAX_GRANT_ID_CHARS) : "";
      if (!id) return { ok: false, error: "grant_not_found" };
      if (typeof content !== "string") return { ok: false, error: "invalid_content", message: "content must be a UTF-8 string" };

      // 1. The path: relative, no traversal, a file name, bounded depth.
      let segments = [];
      try {
        segments = cleanRelativePath(relativePath);
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
      if (segments.length === 0) return { ok: false, error: "invalid_file_path", message: "A file name is required" };
      if (segments.length > MAX_FS_PATH_DEPTH) return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_FS_PATH_DEPTH };
      const path = segments.join("/");

      // 2. The size: the store's own write bound, then the card's diff bound
      //    (a diff the owner cannot read in full is not an approvable diff).
      const newBytes = new TextEncoder().encode(content);
      if (newBytes.byteLength > MAX_FS_WRITE_BYTES) {
        return { ok: false, error: "fs_file_too_large", size: newBytes.byteLength, maxBytes: MAX_FS_WRITE_BYTES };
      }
      if (content.length > STAGED_APPROVAL_DETAIL_BOUNDS.maxContentChars) {
        return { ok: false, error: "fs_diff_too_large", size: content.length, maxChars: STAGED_APPROVAL_DETAIL_BOUNDS.maxContentChars };
      }

      // 3. The grant: exists, is a read/write grant, and the browser still
      //    grants it (the same order writeFsGrantFile checks, surfaced early
      //    so nothing is staged for a write that cannot land).
      const grant = await getFsGrant(id);
      if (!grant) return { ok: false, error: "grant_not_found" };
      if (grant.mode !== "readwrite") {
        return { ok: false, error: "fs_write_permission_denied", message: "Grant mode is read-only. Write operations require a read/write grant." };
      }
      const status = await queryFsGrantStatus(grant);
      if (status !== "granted") return { ok: false, error: "fs_permission_lapsed", status, grantId: id };

      // 4. The bytes on disk: the "before" side of the card. A missing file is
      //    a creation (empty before); a binary or oversized file is refused —
      //    the card would otherwise show a misleading diff.
      //    readFsGrantFile(asText:true) applies the store's own binary sniff
      //    (NUL / control bytes / invalid UTF-8 → fs_file_not_text) and always
      //    returns the complete before-text; THIS route's card bound then
      //    refuses a file over MAX_FS_TEXT_DECODE_BYTES, because a diff the
      //    owner cannot read in full is not an approvable diff.
      const readBefore = async () => {
        const res = await readFsGrantFile(id, { relativePath: path, asText: true });
        if (res?.ok === true) {
          if (res.size > MAX_FS_TEXT_DECODE_BYTES || typeof res.content !== "string") {
            return { error: "fs_file_too_large", size: res.size, maxBytes: MAX_FS_TEXT_DECODE_BYTES };
          }
          return { text: res.content, sha256: res.sha256, exists: true };
        }
        if (res?.error === "file_not_found") return { text: "", sha256: "", exists: false };
        const out = { error: typeof res?.error === "string" ? res.error : "read_bytes_failed" };
        if (typeof res?.size === "number") out.size = res.size;
        if (typeof res?.maxBytes === "number") out.maxBytes = res.maxBytes;
        return out;
      };
      const before = await readBefore();
      if (before.error) {
        const out = { ok: false, error: before.error, path };
        if (typeof before.size === "number") out.size = before.size;
        if (typeof before.maxBytes === "number") out.maxBytes = before.maxBytes;
        return out;
      }
      if (before.text.length > STAGED_APPROVAL_DETAIL_BOUNDS.maxContentChars) {
        return { ok: false, error: "fs_diff_too_large", path, size: before.text.length, maxChars: STAGED_APPROVAL_DETAIL_BOUNDS.maxContentChars };
      }

      // 5. The approval: target = this grant + this path; payload digest-bound
      //    to the EXACT new content (its sha256 + byte length — the canonical
      //    payload never carries the body itself) and to the before-state.
      const newSha = await computeSha256(newBytes.buffer);
      const target = canonicalOperationTarget("fs", { grantId: id, path });
      if (!target) return { ok: false, error: "fs_write_not_approvable" };
      let payload;
      try {
        payload = payloadFields([
          ["grantId", id],
          ["path", path],
          ["sha256", newSha],
          ["bytes", String(newBytes.byteLength)],
          ["before", before.sha256],
        ]);
      } catch {
        return { ok: false, error: "fs_write_not_approvable" };
      }
      const summary = lineDiffSummary(before.text, content);
      const stagedDetail = {
        kind: "fs.write",
        name: path,
        oldContent: before.text,
        newContent: content,
        added: summary.added,
        removed: summary.removed,
        oldLabel: `${path} (on disk)`,
        newLabel: `${path} (proposed)`,
      };
      const gate = await requireOwnerApproval(context, "fs.write", target, payload, undefined, stagedDetail);
      if (!gate || gate.ok !== true) return gate ?? { ok: false, error: "This operation requires owner approval." };

      // 6. Approved: the disk must still be what the owner saw. A file that
      //    changed while the card was pending is refused — the approved diff
      //    no longer describes the write.
      const recheck = await readBefore();
      if (recheck.error || recheck.exists !== before.exists || recheck.sha256 !== before.sha256) {
        return { ok: false, error: "fs_file_changed", path };
      }
      const written = await writeFsGrantFile(id, { relativePath: path, content });
      if (written?.ok !== true) return written ?? { ok: false, error: "write_failed" };
      return {
        ok: true,
        written: true,
        grantId: id,
        path,
        name: written.name,
        size: written.size,
        sha256: written.sha256,
        added: summary.added,
        removed: summary.removed,
      };
    },
  });
}
