// lib/skill-identity-migration.js — idempotent startup migration from legacy
// `recipe:` persisted identities to `skill:` (chrome-agent-platform-e5oe):
//   1. `cap:scheduledTasks` keys (`recipe:<id>` → `skill:<id>`) + `chrome.alarms`
//      names + `cap:scheduledInflight` locks.
//   2. `cap:hooks` subscription field (`recipeId` → `skillId`).
//   3. OPFS background-agent memory directories (`memory/background/recipe-<id>`
//      → `memory/background/skill-<id>`) and private workspaces
//      (`agent-workspaces/background-recipe-<id>` → `agent-workspaces/background-skill-<id>`)
//      using copy → verify → delete (fail-closed on any verification failure).

import { kvGet, kvRemove, kvSet } from "./kv.js";
import { migrateHookSubscriptions } from "./hooks.js";
import { usageLedgerInspector } from "./memory.js";

export const SKILL_IDENTITY_MIGRATION_KEY = "cap:migration:skillIdentityV1";
export const SKILL_IDENTITY_MIGRATION_VERSION = 1;

const TASK_KEY = "cap:scheduledTasks";
const INFLIGHT_KEY = "cap:scheduledInflight";

function alarmsApi() {
  try {
    return typeof chrome !== "undefined" && chrome.alarms ? chrome.alarms : null;
  } catch {
    return null;
  }
}

let migrationMutex = Promise.resolve();
function withMigrationLock(fn) {
  const run = migrationMutex.then(fn, fn);
  migrationMutex = run.then(() => {}, () => {});
  return run;
}

async function listDirEntries(dir) {
  const out = [];
  if (typeof dir?.entries === "function") {
    for await (const [name, handle] of dir.entries()) {
      out.push([name, handle]);
    }
  } else if (typeof dir?.values === "function") {
    for await (const handle of dir.values()) {
      if (handle && typeof handle.name === "string") {
        out.push([handle.name, handle]);
      }
    }
  }
  return out;
}

function isEnvelope(parsed) {
  return Boolean(
    parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof parsed.__v === "number" && Number.isFinite(parsed.__v) &&
      "__value" in parsed,
  );
}

function mergeJournalText(sourceText, targetText) {
  try {
    const srcParsed = JSON.parse(sourceText);
    const tgtParsed = JSON.parse(targetText);
    const srcEnv = isEnvelope(srcParsed);
    const tgtEnv = isEnvelope(tgtParsed);
    const srcArr = srcEnv ? srcParsed.__value : srcParsed;
    const tgtArr = tgtEnv ? tgtParsed.__value : tgtParsed;
    if (!Array.isArray(srcArr) || !Array.isArray(tgtArr)) return targetText;
    const seen = new Set();
    const merged = [];
    for (const row of [...srcArr, ...tgtArr]) {
      const key = JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
    merged.sort((a, b) => (Number(a?.ts ?? a?.at ?? 0) - Number(b?.ts ?? b?.at ?? 0)));
    if (srcEnv || tgtEnv) {
      const v = Math.max(srcEnv ? srcParsed.__v : 0, tgtEnv ? tgtParsed.__v : 0) + 1;
      return JSON.stringify({ __v: v, __value: merged });
    }
    return JSON.stringify(merged);
  } catch {
    return targetText;
  }
}

function mergeGenText(sourceText, targetText) {
  try {
    const src = JSON.parse(sourceText);
    const tgt = JSON.parse(targetText);
    const gen = Math.max(Number(src?.gen ?? 0), Number(tgt?.gen ?? 0));
    if (Number.isSafeInteger(gen) && gen >= 0) {
      return JSON.stringify({ gen });
    }
  } catch {
    // Keep target if corrupt/unparseable so we do not clobber authority.
  }
  return targetText;
}

function mergeTombsText(sourceText, targetText) {
  try {
    const src = JSON.parse(sourceText);
    const tgt = JSON.parse(targetText);
    const map = { ...(src?.map ?? {}) };
    for (const [k, v] of Object.entries(tgt?.map ?? {})) {
      map[k] = Math.max(Number(map[k] ?? 0), Number(v ?? 0));
    }
    const floor = Math.max(Number(src?.floor ?? 0), Number(tgt?.floor ?? 0));
    return JSON.stringify({ map, floor });
  } catch {
    return targetText;
  }
}

async function openSubdirOptional(root, segments) {
  let cur = root;
  for (const seg of segments) {
    try {
      cur = await cur.getDirectoryHandle(seg);
    } catch {
      return null;
    }
  }
  return cur;
}

async function copyAndRecordTree(sourceDir, targetDir, prefix, expectedFiles) {
  const entries = await listDirEntries(sourceDir);
  for (const [name, handle] of entries) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    const kind = handle?.kind ?? (typeof handle?.getDirectoryHandle === "function" ? "directory" : "file");
    if (kind === "directory") {
      const nextTarget = await targetDir.getDirectoryHandle(name, { create: true });
      await copyAndRecordTree(handle, nextTarget, relPath, expectedFiles);
      continue;
    }
    const srcFile = await handle.getFile();
    const srcText = await srcFile.text();
    let existingTargetText = null;
    try {
      const existingFh = await targetDir.getFileHandle(name);
      existingTargetText = await (await existingFh.getFile()).text();
    } catch {
      existingTargetText = null;
    }

    let textToWrite = srcText;
    let needsWrite = true;
    if (existingTargetText !== null) {
      if (existingTargetText === srcText) {
        textToWrite = srcText;
        needsWrite = false;
      } else if (name === "journal.json" || name === "journal-archive.json") {
        textToWrite = mergeJournalText(srcText, existingTargetText);
        needsWrite = textToWrite !== existingTargetText;
      } else if (name === "__gen.json") {
        textToWrite = mergeGenText(srcText, existingTargetText);
        needsWrite = textToWrite !== existingTargetText;
      } else if (name === "__tombs.json") {
        textToWrite = mergeTombsText(srcText, existingTargetText);
        needsWrite = textToWrite !== existingTargetText;
      } else {
        // Target already has a newer key file written under skill:<id>; keep it.
        textToWrite = existingTargetText;
        needsWrite = false;
      }
    }

    if (needsWrite) {
      const targetFh = await targetDir.getFileHandle(name, { create: true });
      const writable = await targetFh.createWritable();
      await writable.write(textToWrite);
      await writable.close();
    }
    expectedFiles.set(relPath, textToWrite);
  }
}

async function verifyCopiedTree(targetDir, expectedFiles, { sourceDirName, targetDirName, verifyFileContent }) {
  for (const [relPath, expectedText] of expectedFiles.entries()) {
    const parts = relPath.split("/");
    let cur = targetDir;
    for (const seg of parts.slice(0, -1)) {
      cur = await cur.getDirectoryHandle(seg);
    }
    const fh = await cur.getFileHandle(parts[parts.length - 1]);
    const file = await fh.getFile();
    const actualText = await file.text();
    const valid = typeof verifyFileContent === "function"
      ? await verifyFileContent({
        relPath,
        expectedText,
        actualText,
        sourceDirName,
        targetDirName,
      })
      : actualText === expectedText;
    if (!valid) {
      throw new Error(
        `OPFS skill-identity migration verification failed for ${sourceDirName}/${relPath} -> ${targetDirName}/${relPath}`,
      );
    }
  }
}

async function migrateOpfsParentDir(root, parentSegments, legacyPrefixRe, buildTargetDecoded, { verifyFileContent = null } = {}) {
  const parentDir = await openSubdirOptional(root, parentSegments);
  if (!parentDir) return { migrated: 0, errors: [] };
  const entries = await listDirEntries(parentDir);
  let migrated = 0;
  const errors = [];
  for (const [rawDirName, sourceDirHandle] of entries) {
    const kind = sourceDirHandle?.kind ?? (typeof sourceDirHandle?.getDirectoryHandle === "function" ? "directory" : "file");
    if (kind !== "directory") continue;
    let decodedName = rawDirName;
    try {
      decodedName = decodeURIComponent(rawDirName);
    } catch {
      decodedName = rawDirName;
    }
    const m = legacyPrefixRe.exec(decodedName);
    if (!m) continue;
    const targetDecoded = buildTargetDecoded(m);
    const targetDirName = rawDirName !== decodedName ? encodeURIComponent(targetDecoded) : targetDecoded;
    try {
      const targetDirHandle = await parentDir.getDirectoryHandle(targetDirName, { create: true });
      const expectedFiles = new Map();
      await copyAndRecordTree(sourceDirHandle, targetDirHandle, "", expectedFiles);
      await verifyCopiedTree(targetDirHandle, expectedFiles, {
        sourceDirName: rawDirName,
        targetDirName,
        verifyFileContent,
      });
      await parentDir.removeEntry(rawDirName, { recursive: true });
      migrated += 1;
    } catch (err) {
      errors.push(String(err?.message ?? err));
    }
  }
  return { migrated, errors };
}

/**
 * Idempotently migrate legacy `recipe:` persisted identities to `skill:`:
 *  - `cap:scheduledTasks` keys (`recipe:<id>` → `skill:<id>`) + `chrome.alarms`
 *  - `cap:scheduledInflight` keys (`recipe:<id>` → `skill:<id>`)
 *  - `cap:hooks` subscriptions (`recipeId` → `skillId`)
 *  - OPFS `memory/background/recipe-<id>` → `memory/background/skill-<id>`
 *  - OPFS `agent-workspaces/background-recipe-<id>` → `agent-workspaces/background-skill-<id>`
 *
 * Fails closed: if an alarm creation, KV write, or OPFS copy/verification fails,
 * the legacy source stays intact and the completion marker is not persisted.
 */
export async function migrateSkillIdentities({
  withLock = null,
  isTaskActive = null,
  verifyFileContent = null,
} = {}) {
  return withMigrationLock(async () => {
    const errors = [];
    let deferred = false;
    let tasksMigrated = 0;
    let alarmsMigrated = 0;
    let hooksMigrated = 0;
    let memoryDirsMigrated = 0;
    let workspaceDirsMigrated = 0;

    let schedLock = withLock;
    if (typeof schedLock !== "function") {
      try {
        const schedMod = await import("./scheduler.js");
        if (typeof schedMod.withSchedulerLock === "function") {
          schedLock = schedMod.withSchedulerLock;
        }
      } catch {
        schedLock = null;
      }
    }
    const runLocked = typeof schedLock === "function" ? schedLock : (fn) => fn();

    // 1. Migrate `cap:scheduledTasks`, `chrome.alarms`, and `cap:scheduledInflight`.
    await runLocked(async () => {
      let store;
      try {
        store = await kvGet([TASK_KEY, INFLIGHT_KEY]);
      } catch (err) {
        errors.push(`kvGet failed: ${String(err?.message ?? err)}`);
        return;
      }
      const tasks = { ...(store[TASK_KEY] ?? {}) };
      const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
      const alarms = alarmsApi();
      let allAlarms = [];
      if (alarms && typeof alarms.getAll === "function") {
        try {
          allAlarms = await alarms.getAll();
        } catch (err) {
          errors.push(`alarms.getAll failed: ${String(err?.message ?? err)}`);
          return;
        }
      }
      const alarmByName = new Map(
        (Array.isArray(allAlarms) ? allAlarms : [])
          .filter((a) => a && typeof a.name === "string")
          .map((a) => [a.name, a]),
      );

      let tasksChanged = false;
      const alarmsToClear = new Set();
      const now = Date.now();

      for (const key of Object.keys(tasks)) {
        const m = /^recipe:(.+)$/.exec(key);
        if (!m) continue;
        if (typeof isTaskActive === "function" && isTaskActive(key)) {
          deferred = true;
          continue;
        }
        const skillId = m[1];
        const newKey = `skill:${skillId}`;
        const legacyTask = tasks[key];
        const existingTarget = tasks[newKey];
        let targetTask;
        if (existingTarget && typeof existingTarget === "object") {
          targetTask = existingTarget;
        } else {
          const nextOwner = legacyTask?.owner && typeof legacyTask.owner === "object"
            ? {
              ...legacyTask.owner,
              ...(legacyTask.owner.agentRole === key ? { agentRole: newKey } : {}),
              ...(legacyTask.owner.agentSurfaceRef === key ? { agentSurfaceRef: newKey } : {}),
            }
            : legacyTask?.owner;
          targetTask = {
            ...(legacyTask && typeof legacyTask === "object" ? legacyTask : {}),
            name: newKey,
            ...(nextOwner ? { owner: nextOwner } : {}),
          };
        }

        const runnable = Boolean(
          targetTask &&
            !targetTask.quarantined &&
            !targetTask.storageBlocked &&
            !targetTask.paused &&
            !targetTask.cancelling,
        );
        if (runnable && alarms && typeof alarms.create === "function") {
          let targetArmed = alarmByName.has(newKey);
          if (!targetArmed && typeof alarms.get === "function") {
            try {
              targetArmed = (await alarms.get(newKey)) != null;
            } catch {
              targetArmed = false;
            }
          }
          let legacyAlarm = alarmByName.get(key) ?? null;
          if (!legacyAlarm && typeof alarms.get === "function") {
            try {
              legacyAlarm = (await alarms.get(key)) ?? null;
            } catch {
              legacyAlarm = null;
            }
          }
          if (!targetArmed) {
            const rawWhen = typeof legacyAlarm?.scheduledTime === "number" && Number.isFinite(legacyAlarm.scheduledTime)
              ? legacyAlarm.scheduledTime
              : (typeof targetTask.at === "number" && Number.isFinite(targetTask.at) ? targetTask.at : now + 1000);
            const when = targetTask.periodInMinutes
              ? Math.max(rawWhen, now + 1000)
              : (rawWhen > now ? rawWhen : now + 1000);
            const periodInMinutes = legacyAlarm?.periodInMinutes ?? targetTask.periodInMinutes;
            const info = { when };
            if (periodInMinutes) info.periodInMinutes = periodInMinutes;
            try {
              await alarms.create(newKey, info);
              alarmByName.set(newKey, { name: newKey, scheduledTime: when, ...(periodInMinutes ? { periodInMinutes } : {}) });
              alarmsMigrated += 1;
            } catch (err) {
              errors.push(`failed to arm ${newKey} before clearing ${key}: ${String(err?.message ?? err)}`);
              continue;
            }
          }
        }

        tasks[newKey] = targetTask;
        delete tasks[key];
        tasksChanged = true;
        tasksMigrated += 1;
        alarmsToClear.add(key);
      }

      // Also catch any stray `recipe:<id>` alarm in Chrome whose task was already
      // re-keyed on an interrupted earlier pass.
      for (const [alarmName, legacyAlarm] of alarmByName.entries()) {
        const m = /^recipe:(.+)$/.exec(alarmName);
        if (!m || alarmsToClear.has(alarmName)) continue;
        if (typeof isTaskActive === "function" && isTaskActive(alarmName)) {
          deferred = true;
          continue;
        }
        if (tasks[alarmName]) continue; // failed to migrate above; keep legacy alarm intact
        const newKey = `skill:${m[1]}`;
        const targetTask = tasks[newKey];
        const runnable = Boolean(
          targetTask &&
            !targetTask.quarantined &&
            !targetTask.storageBlocked &&
            !targetTask.paused &&
            !targetTask.cancelling,
        );
        if (runnable && alarms && typeof alarms.create === "function" && !alarmByName.has(newKey)) {
          const rawWhen = typeof legacyAlarm?.scheduledTime === "number" && Number.isFinite(legacyAlarm.scheduledTime)
            ? legacyAlarm.scheduledTime
            : (typeof targetTask.at === "number" && Number.isFinite(targetTask.at) ? targetTask.at : now + 1000);
          const when = targetTask.periodInMinutes
            ? Math.max(rawWhen, now + 1000)
            : (rawWhen > now ? rawWhen : now + 1000);
          const periodInMinutes = legacyAlarm?.periodInMinutes ?? targetTask.periodInMinutes;
          const info = { when };
          if (periodInMinutes) info.periodInMinutes = periodInMinutes;
          try {
            await alarms.create(newKey, info);
            alarmByName.set(newKey, { name: newKey, scheduledTime: when, ...(periodInMinutes ? { periodInMinutes } : {}) });
            alarmsMigrated += 1;
          } catch (err) {
            errors.push(`failed to arm ${newKey} for stray ${alarmName}: ${String(err?.message ?? err)}`);
            continue;
          }
        }
        alarmsToClear.add(alarmName);
      }

      if (tasksChanged) {
        try {
          await kvSet({ [TASK_KEY]: tasks });
        } catch (err) {
          errors.push(`failed to persist migrated ${TASK_KEY}: ${String(err?.message ?? err)}`);
          return;
        }
      }

      if (alarms && alarmsToClear.size > 0) {
        for (const legacyAlarmName of alarmsToClear) {
          if (typeof alarms.clear === "function") {
            try {
              await alarms.clear(legacyAlarmName);
            } catch (err) {
              errors.push(`failed to clear legacy alarm ${legacyAlarmName}: ${String(err?.message ?? err)}`);
              continue;
            }
          }
          if (typeof alarms.get === "function") {
            try {
              const remaining = await alarms.get(legacyAlarmName);
              if (remaining != null) {
                errors.push(`legacy alarm ${legacyAlarmName} remained armed after clear`);
              }
            } catch (err) {
              errors.push(`failed to confirm legacy alarm ${legacyAlarmName} absence: ${String(err?.message ?? err)}`);
            }
          }
        }
      }

      let inflightChanged = false;
      for (const infKey of Object.keys(inflight)) {
        const m = /^recipe:(.+)$/.exec(infKey);
        if (!m) continue;
        if (typeof isTaskActive === "function" && isTaskActive(infKey)) {
          deferred = true;
          continue;
        }
        const newInfKey = `skill:${m[1]}`;
        if (!inflight[newInfKey]) {
          inflight[newInfKey] = inflight[infKey];
        }
        delete inflight[infKey];
        inflightChanged = true;
      }
      if (inflightChanged) {
        try {
          await kvSet({ [INFLIGHT_KEY]: inflight });
        } catch (err) {
          errors.push(`failed to persist migrated ${INFLIGHT_KEY}: ${String(err?.message ?? err)}`);
        }
      }
    });

    // 2. Migrate `cap:hooks` subscriptions (`recipeId` → `skillId`).
    try {
      const hookResult = await migrateHookSubscriptions();
      hooksMigrated += hookResult?.migrated ?? 0;
    } catch (err) {
      errors.push(`failed to migrate hook subscriptions: ${String(err?.message ?? err)}`);
    }

    // 3. Migrate OPFS `memory/background/recipe-<id>` → `memory/background/skill-<id>`
    //    and `agent-workspaces/background-recipe-<id>` → `agent-workspaces/background-skill-<id>`.
    if (typeof globalThis.navigator?.storage?.getDirectory === "function") {
      try {
        const root = await globalThis.navigator.storage.getDirectory();
        const memRes = await migrateOpfsParentDir(
          root,
          ["memory", "background"],
          /^recipe-(.+)$/,
          (m) => `skill-${m[1]}`,
          { verifyFileContent },
        );
        memoryDirsMigrated += memRes.migrated;
        errors.push(...memRes.errors);
        if (memRes.migrated > 0) {
          usageLedgerInspector.reset();
        }

        const wsRes = await migrateOpfsParentDir(
          root,
          ["agent-workspaces"],
          /^background-recipe-(.+)$/,
          (m) => `background-skill-${m[1]}`,
          { verifyFileContent },
        );
        workspaceDirsMigrated += wsRes.migrated;
        errors.push(...wsRes.errors);
      } catch (err) {
        errors.push(`OPFS migration failed: ${String(err?.message ?? err)}`);
      }
    }

    const workDone =
      tasksMigrated > 0 ||
      alarmsMigrated > 0 ||
      hooksMigrated > 0 ||
      memoryDirsMigrated > 0 ||
      workspaceDirsMigrated > 0;

    if (errors.length === 0 && !deferred) {
      try {
        const existingMarker = (await kvGet(SKILL_IDENTITY_MIGRATION_KEY))?.[SKILL_IDENTITY_MIGRATION_KEY];
        if (!existingMarker || existingMarker.version !== SKILL_IDENTITY_MIGRATION_VERSION || workDone) {
          await kvSet({
            [SKILL_IDENTITY_MIGRATION_KEY]: {
              version: SKILL_IDENTITY_MIGRATION_VERSION,
              completedAt: Date.now(),
            },
          });
        }
      } catch {
        // Best-effort marker write: if KV is read-only or unavailable in a stub,
        // the idempotent migration itself succeeded.
      }
      return {
        ok: true,
        tasksMigrated,
        alarmsMigrated,
        hooksMigrated,
        memoryDirsMigrated,
        workspaceDirsMigrated,
        errors: [],
      };
    }

    if (errors.length > 0) {
      try {
        await kvRemove(SKILL_IDENTITY_MIGRATION_KEY);
      } catch {
        // Best-effort marker removal on failure.
      }
    }

    return {
      ok: errors.length === 0,
      deferred,
      tasksMigrated,
      alarmsMigrated,
      hooksMigrated,
      memoryDirsMigrated,
      workspaceDirsMigrated,
      errors,
    };
  });
}
